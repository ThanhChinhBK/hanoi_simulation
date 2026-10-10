//! Parameter registry. Every model number that is not read from data lives here with
//! its unit, source, confidence and a description, so the UI can show provenance and
//! users can override it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// What changing the parameter affects. Changing `Network` or `Demand` parameters
/// requires replanning (a structural scenario); the others apply within a single run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Network,
    Signals,
    Demand,
    Simulation,
    Behaviour,
    Rain,
    Flood,
}

impl Category {
    pub fn is_structural(self) -> bool {
        matches!(self, Category::Network | Category::Demand)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Param {
    pub key: String,
    pub value: f64,
    pub default: f64,
    pub unit: String,
    pub min: f64,
    pub max: f64,
    pub category: Category,
    pub source: String,
    pub confidence: Confidence,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Params {
    params: BTreeMap<String, Param>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParamError(pub String);
impl std::fmt::Display for ParamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "parameter error: {}", self.0)
    }
}
impl std::error::Error for ParamError {}

pub const ROAD_CLASSES: [&str; 9] = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "service",
];

const ASSUME: &str = "assumption";

impl Params {
    pub fn get(&self, key: &str) -> f64 {
        match self.params.get(key) {
            Some(p) => p.value,
            None => panic!("unknown parameter {key}"),
        }
    }
    pub fn param(&self, key: &str) -> Option<&Param> {
        self.params.get(key)
    }
    pub fn iter(&self) -> impl Iterator<Item = &Param> {
        self.params.values()
    }

    pub fn set(&mut self, key: &str, value: f64) -> Result<(), ParamError> {
        let p = self
            .params
            .get_mut(key)
            .ok_or_else(|| ParamError(format!("unknown parameter '{key}'")))?;
        if !(value >= p.min && value <= p.max) {
            return Err(ParamError(format!(
                "{key} = {value} outside [{}, {}]",
                p.min, p.max
            )));
        }
        p.value = value;
        Ok(())
    }

    pub fn with_overrides(mut self, o: &BTreeMap<String, f64>) -> Result<Self, ParamError> {
        for (k, &v) in o {
            self.set(k, v)?;
        }
        Ok(self)
    }

    /// Overrides that change network or demand (→ replanning needed).
    pub fn structural_changes(&self) -> Vec<&str> {
        self.params
            .values()
            .filter(|p| p.category.is_structural() && p.value != p.default)
            .map(|p| p.key.as_str())
            .collect()
    }

    /// Network/demand parameters whose value differs from `base`.
    pub fn structural_diff(&self, base: &Params) -> Vec<&str> {
        self.params
            .values()
            .filter(|p| {
                p.category.is_structural() && base.param(&p.key).map(|b| b.value) != Some(p.value)
            })
            .map(|p| p.key.as_str())
            .collect()
    }

    /// Per-class table lookup; `*_link` roads use their parent class.
    pub fn class_value(&self, table: &str, road_class: &str) -> f64 {
        let base = road_class.strip_suffix("_link").unwrap_or(road_class);
        let key = format!("{table}.{base}");
        match self.params.get(&key) {
            Some(p) => p.value,
            None => self.get(&format!("{table}.unclassified")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        key: &str,
        value: f64,
        unit: &str,
        (min, max): (f64, f64),
        category: Category,
        (source, confidence): (&str, Confidence),
        description: &str,
    ) {
        let p = Param {
            key: key.into(),
            value,
            default: value,
            unit: unit.into(),
            min,
            max,
            category,
            source: source.into(),
            confidence,
            description: description.into(),
        };
        assert!(
            self.params.insert(key.into(), p).is_none(),
            "duplicate {key}"
        );
    }
}

impl Default for Params {
    fn default() -> Self {
        use Category::*;
        use Confidence::*;
        let mut p = Params {
            params: BTreeMap::new(),
        };
        let a_low = (ASSUME, Low);

        // ------------------------------------------------------------- network
        let classes: [(&str, f64, f64, f64); 9] = [
            // class, capacity PCU/h/lane, free speed km/h, default lanes per direction
            ("motorway", 2000.0, 80.0, 2.0),
            ("trunk", 1800.0, 60.0, 2.0),
            ("primary", 1500.0, 45.0, 2.0),
            ("secondary", 1200.0, 40.0, 2.0),
            ("tertiary", 1000.0, 35.0, 1.0),
            ("unclassified", 700.0, 25.0, 1.0),
            ("residential", 600.0, 20.0, 1.0),
            ("living_street", 300.0, 12.0, 1.0),
            // Ngõ/ngách (OSM service=alley): 2–4 m wide, motorbikes, pedestrians, stalls.
            ("service", 400.0, 12.0, 1.0),
        ];
        for (c, cap, v, lanes) in classes {
            p.add(&format!("capacity_per_lane.{c}"), cap, "PCU/h/lane", (0.0, 4000.0), Network,
                ("assumption: HCM-style saturation flow reduced for mixed urban traffic, side friction and parking", Low),
                &format!("Flow capacity per lane on {c} roads (before signals)."));
            p.add(&format!("free_speed_kmh.{c}"), v, "km/h", (5.0, 120.0), Network,
                ("assumption: typical uncongested Hanoi speeds; capped by OSM maxspeed when lower", Low),
                &format!("Free-flow speed on {c} roads."));
            p.add(
                &format!("default_lanes.{c}"),
                lanes,
                "lanes/direction",
                (1.0, 6.0),
                Network,
                ("assumption; used only where OSM has no lanes tag", Low),
                &format!("Lanes per direction on {c} roads when OSM has no lane count."),
            );
        }

        // ------------------------------------------------------------- signals
        p.add(
            "signal.cycle_s",
            120.0,
            "s",
            (30.0, 300.0),
            Signals,
            a_low,
            "Default fixed cycle length at signalised intersections.",
        );
        p.add(
            "signal.lost_time_s",
            12.0,
            "s",
            (0.0, 60.0),
            Signals,
            a_low,
            "Lost time per cycle (amber/all-red, start-up).",
        );
        p.add("signal.infer_major_crossings", 1.0, "0/1", (0.0, 1.0), Signals,
            ("assumption: OSM signal tags are incomplete in Hanoi", Low),
            "Treat crossings of two primary/secondary/trunk roads as signalised even without an OSM tag.");

        // ------------------------------------------------------------- vehicles
        p.add(
            "pcu.motorbike",
            0.25,
            "PCU",
            (0.1, 1.0),
            Demand,
            (
                "TCXDVN 104:2007 urban streets (≈0.25); TCVN 4054:2005 uses 0.3 — verify",
                Medium,
            ),
            "Passenger car units per motorbike. Ignores filtering between cars.",
        );
        p.add(
            "pcu.car",
            1.0,
            "PCU",
            (1.0, 1.0),
            Demand,
            ("definition", High),
            "Passenger car units per car (reference vehicle).",
        );
        p.add(
            "pcu.bus",
            2.5,
            "PCU",
            (1.0, 5.0),
            Demand,
            ("TCXDVN 104:2007 (≈2.5 for buses) — verify", Medium),
            "Passenger car units per bus.",
        );
        p.add(
            "vmax_kmh.motorbike",
            50.0,
            "km/h",
            (10.0, 90.0),
            Demand,
            (
                "Circular 31/2019/TT-BGTVT urban speed limits (50–60 km/h)",
                Medium,
            ),
            "Maximum speed of motorbikes.",
        );
        p.add(
            "vmax_kmh.car",
            60.0,
            "km/h",
            (10.0, 120.0),
            Demand,
            ("Circular 31/2019/TT-BGTVT urban speed limits", Medium),
            "Maximum speed of cars.",
        );

        // ------------------------------------------------------------- demand
        p.add(
            "population.scale",
            1.0,
            "×",
            (0.1, 5.0),
            Demand,
            ("user control", High),
            "Multiplies the population of every zone (growth scenarios).",
        );
        p.add("trip_rate.per_person_day", 2.0, "trips/person/day", (0.5, 6.0), Demand,
            ("JICA HAIDEP/THAIDEP report ~2.4–2.8 incl. walking (verify); lowered so the hanoi-inner AM-peak mean trip time is ~35 min — calibrated", Low),
            "Person trips per resident per day, all modes (walking/cycling are the share not assigned to a simulated mode).");
        p.add(
            "trip_rate.am_window_share",
            0.25,
            "share",
            (0.05, 0.6),
            Demand,
            a_low,
            "Share of daily trips that start in the simulated morning window.",
        );
        p.add("trip_rate.return_share", 0.3, "share", (0.0, 1.0), Demand,
            ("assumption: school drop-offs, market, breakfast and errands are common short AM tours in Hanoi", Low),
            "Share of morning trips that are short tours: the trip back home is made within the window. The total trip count is unchanged (outbound legs are scaled by 1/(1+share)); this puts inbound traffic on residential streets and ngõ.");
        p.add("trip_rate.return_dwell_min", 30.0, "min", (5.0, 180.0), Demand, a_low,
            "Mean time from leaving home to starting the return leg of a short tour (travel + stay); drawn uniformly between 0.5× and 1.5×.");
        p.add("mode_share.motorbike", 0.65, "share", (0.0, 1.0), Demand,
            ("literature: motorbike ~65–80% of trips (verify); with walking/cycling as the remainder", Low),
            "Share of person trips by motorbike (incl. motorbike taxis).");
        p.add(
            "mode_share.car",
            0.07,
            "share",
            (0.0, 1.0),
            Demand,
            ("literature ~5–10%, rising quickly — verify", Low),
            "Share of person trips by car (incl. taxis/ride-hailing).",
        );
        p.add(
            "mode_share.bus",
            0.08,
            "share",
            (0.0, 1.0),
            Demand,
            (
                "Hanoi Transport Management Centre reports ~10% public transport — verify",
                Low,
            ),
            "Share of person trips by bus. Buses are simulated as road vehicles only.",
        );
        p.add(
            "occupancy.motorbike",
            1.25,
            "persons/vehicle",
            (1.0, 3.0),
            Demand,
            a_low,
            "Average persons per motorbike trip.",
        );
        p.add(
            "occupancy.car",
            1.5,
            "persons/vehicle",
            (1.0, 7.0),
            Demand,
            a_low,
            "Average persons per car trip.",
        );
        p.add(
            "occupancy.bus",
            30.0,
            "persons/vehicle",
            (5.0, 100.0),
            Demand,
            a_low,
            "Average persons per bus vehicle trip (converts bus riders to bus vehicles).",
        );
        p.add(
            "gravity.beta_per_km",
            0.25,
            "1/km",
            (0.0, 3.0),
            Demand,
            a_low,
            "Distance decay in destination choice: weight ∝ attraction × exp(−β·distance).",
        );
        for (k, v) in [
            ("work", 1.0),
            ("school", 0.8),
            ("shop", 0.3),
            ("health", 0.3),
            ("leisure", 0.15),
        ] {
            p.add(
                &format!("attraction.{k}"),
                v,
                "weight",
                (0.0, 10.0),
                Demand,
                (
                    "assumption; OSM/Overture POIs have no size — weights are relative",
                    Low,
                ),
                &format!("Destination attractiveness per weighted '{k}' POI."),
            );
        }
        p.add(
            "attraction.population_mix",
            0.3,
            "share",
            (0.0, 1.0),
            Demand,
            (
                "assumption: Hanoi is mixed-use (shophouses); POIs under-represent jobs",
                Low,
            ),
            "Share of destination attraction proportional to population rather than POIs.",
        );
        p.add(
            "attraction.jobs_per_poi",
            20.0,
            "jobs",
            (1.0, 1000.0),
            Demand,
            a_low,
            "Jobs equivalent to one POI weight unit (used when users add jobs).",
        );
        p.add(
            "departure.peak_h",
            7.5,
            "h",
            (5.0, 11.0),
            Demand,
            a_low,
            "Peak of the departure-time distribution (truncated normal).",
        );
        p.add(
            "departure.sd_h",
            0.6,
            "h",
            (0.1, 3.0),
            Demand,
            a_low,
            "Spread of departure times.",
        );
        p.add(
            "departure.start_h",
            6.0,
            "h",
            (4.0, 10.0),
            Demand,
            a_low,
            "First departure in the simulated window.",
        );
        p.add(
            "departure.end_h",
            9.0,
            "h",
            (5.0, 12.0),
            Demand,
            a_low,
            "Last departure in the simulated window.",
        );
        for (c, v) in [
            ("motorway", 3000.0),
            ("trunk", 2000.0),
            ("primary", 900.0),
            ("secondary", 300.0),
        ] {
            p.add(
                &format!("through.vehicles_per_h.{c}"),
                v,
                "vehicles/h",
                (0.0, 10000.0),
                Demand,
                (
                    "assumption: inbound volume at city entry points by road class",
                    Low,
                ),
                &format!("Vehicles entering the study area per hour at each {c} entry point."),
            );
        }
        p.add(
            "through.transit_share",
            0.35,
            "share",
            (0.0, 1.0),
            Demand,
            a_low,
            "Share of entering vehicles that leave via another entry point (the rest stop inside).",
        );
        p.add(
            "through.car_share",
            0.35,
            "share",
            (0.0, 1.0),
            Demand,
            a_low,
            "Share of cars among entering vehicles (rest motorbikes).",
        );
        p.add(
            "sample_fraction",
            0.05,
            "share",
            (0.005, 1.0),
            Demand,
            ("modelling choice (MATSim practice: 1–25%)", High),
            "Fraction of trips simulated; capacities are scaled by the same fraction.",
        );

        // ------------------------------------------------------------- simulation
        p.add("storage_scale_exponent", 0.75, "exponent", (0.5, 1.0), Simulation,
            ("MATSim practice for small samples (storage factor ≈ f^0.75)", Medium),
            "Link storage is scaled by f^exponent (flow capacity by f). Below 1 avoids exaggerated spillback in small samples.");
        p.add("stuck_threshold_s", 60.0, "s", (5.0, 900.0), Simulation,
            ("MATSim practice (stuckTime)", Medium),
            "A vehicle blocked this long by a full downstream link is pushed through (gridlock breaker).");
        p.add(
            "replan.iterations",
            50.0,
            "iterations",
            (0.0, 200.0),
            Simulation,
            ("MATSim practice (tens of iterations)", Medium),
            "Iterations of route replanning for the baseline.",
        );
        p.add(
            "replan.scenario_iterations",
            5.0,
            "iterations",
            (0.0, 50.0),
            Simulation,
            a_low,
            "Replanning iterations in the browser for structural scenarios (new roads, housing…).",
        );
        p.add(
            "replan.scenario_max_iterations",
            15.0,
            "iterations",
            (0.0, 50.0),
            Simulation,
            a_low,
            "Upper bound on structural replanning when the network has not settled yet.",
        );
        p.add("replan.convergence_tol", 0.02, "share", (0.0, 0.5), Simulation, a_low,
            "Stop structural replanning once mean trip time changes by less than this between iterations.");
        p.add("replan.tt_smoothing_min", 0.2, "weight", (0.01, 1.0), Simulation,
            ("method of successive averages (Sheffi 1985), floored", Medium),
            "Weight of the newest iteration in the travel times used for routing (1 = no smoothing).");
        p.add(
            "replan.share",
            0.1,
            "share",
            (0.01, 1.0),
            Simulation,
            ("MATSim practice (~10% reroute per iteration)", Medium),
            "Share of trips that pick a new route each iteration.",
        );
        p.add("replan.switch_gain", 0.05, "share", (0.0, 0.5), Simulation,
            ("assumption (bounded rationality / indifference band)", Low),
            "A replanning trip only switches route if the new one is expected to be faster by more than this share. Damps oscillation between iterations.");

        // ------------------------------------------------------------- behaviour
        p.add("reroute.informed_share", 0.3, "share", (0.0, 1.0), Behaviour,
            ("assumption (navigation-app use, traffic radio)", Low),
            "Share of drivers who know about disruptions anywhere as they happen. Others discover them on arrival.");
        p.add(
            "reroute.max_reroutes",
            3.0,
            "count",
            (0.0, 20.0),
            Behaviour,
            a_low,
            "Max reroutes per trip due to slow links (closures always trigger a reroute).",
        );
        p.add(
            "reroute.closure_visibility_m",
            300.0,
            "m",
            (0.0, 5000.0),
            Behaviour,
            (
                "assumption (closures are signposted at the previous junction)",
                Low,
            ),
            "Drivers see a closed road this far ahead and detour before reaching it.",
        );
        p.add("reroute.disruption_threshold", 0.5, "factor", (0.05, 1.0), Behaviour, a_low,
            "A link counts as disrupted when incident/rain/flood capacity or speed drops below this factor.");
        p.add(
            "behaviour.cancel_rain_mm_h",
            30.0,
            "mm/h",
            (0.0, 200.0),
            Behaviour,
            a_low,
            "Rain intensity at departure time above which some trips are cancelled or delayed.",
        );
        p.add(
            "behaviour.cancel_share",
            0.1,
            "share",
            (0.0, 1.0),
            Behaviour,
            a_low,
            "Share of trips cancelled when departing in heavy rain.",
        );
        p.add(
            "behaviour.delay_share",
            0.2,
            "share",
            (0.0, 1.0),
            Behaviour,
            a_low,
            "Share of trips postponed until the rain eases (creates a post-rain surge).",
        );
        p.add(
            "behaviour.max_delay_min",
            90.0,
            "min",
            (0.0, 600.0),
            Behaviour,
            a_low,
            "Maximum postponement of a delayed trip.",
        );

        // ------------------------------------------------------------- rain
        p.add(
            "rain.heavy_mm_h",
            20.0,
            "mm/h",
            (1.0, 200.0),
            Rain,
            a_low,
            "Rain intensity at which the full network-wide rain effect applies (linear below).",
        );
        p.add(
            "rain.speed_factor_heavy",
            0.85,
            "factor",
            (0.3, 1.0),
            Rain,
            ("literature (heavy rain reduces free speed ~5–15%)", Medium),
            "Free-speed multiplier in heavy rain (without flooding).",
        );
        p.add(
            "rain.capacity_factor_heavy",
            0.85,
            "factor",
            (0.3, 1.0),
            Rain,
            ("literature (heavy rain reduces capacity ~10–20%)", Medium),
            "Capacity multiplier in heavy rain (without flooding).",
        );

        // ------------------------------------------------------------- flood
        p.add(
            "flood.step_min",
            5.0,
            "min",
            (1.0, 30.0),
            Flood,
            ("modelling choice", High),
            "Time step of the flood model.",
        );
        p.add(
            "flood.hotspot_threshold_mm_h",
            40.0,
            "mm/h",
            (0.0, 200.0),
            Flood,
            ("assumption; calibrate against 30/9/2025", Low),
            "Hotspot model: rain intensity above which reported flood points start to pond.",
        );
        p.add(
            "flood.underpass_threshold_mm_h",
            30.0,
            "mm/h",
            (0.0, 200.0),
            Flood,
            a_low,
            "Hotspot model: threshold for underpasses (fill faster).",
        );
        p.add(
            "flood.rise_cm_per_mm",
            0.6,
            "cm per mm",
            (0.0, 10.0),
            Flood,
            ("assumption; calibrate", Low),
            "Hotspot model: depth gained per mm of rain above the threshold.",
        );
        p.add(
            "flood.recession_cm_per_h",
            10.0,
            "cm/h",
            (0.5, 200.0),
            Flood,
            (
                "assumption; reports of water receding over hours — calibrate",
                Low,
            ),
            "Hotspot model: drainage rate once rain is below the threshold.",
        );
        p.add(
            "flood.max_depth_cm",
            60.0,
            "cm",
            (5.0, 200.0),
            Flood,
            a_low,
            "Maximum flood depth on a link.",
        );
        p.add(
            "flood.runoff_coefficient",
            0.85,
            "share",
            (0.1, 1.0),
            Flood,
            ("typical value for dense urban areas", Medium),
            "Bucket model: share of rain that becomes runoff (C) where the bundle has no land-cover value.",
        );
        p.add(
            "flood.runoff_scale",
            1.0,
            "×",
            (0.2, 1.5),
            Flood,
            a_low,
            "Bucket model: multiplier on each catchment's land-cover runoff coefficient (calibration knob).",
        );
        p.add(
            "flood.lake_usable_depth_mm",
            300.0,
            "mm",
            (0.0, 2000.0),
            Flood,
            ("assumption: regulating lakes keep ~0.3 m of freeboard before the storm", Low),
            "Bucket model: water-level rise lakes can absorb; storage = open-water share × this.",
        );
        p.add(
            "flood.spill_threshold_mm",
            5.0,
            "mm",
            (0.0, 200.0),
            Flood,
            a_low,
            "Bucket model: ponded water (mm over the catchment) above which it overflows to the lower neighbour.",
        );
        p.add(
            "flood.spill_rate_per_h",
            1.0,
            "1/h",
            (0.0, 20.0),
            Flood,
            a_low,
            "Bucket model: rate at which excess ponded water flows to the lower neighbouring catchment (0 = no spill).",
        );
        p.add(
            "flood.drainage_mm_h",
            14.0,
            "mm/h",
            (0.0, 200.0),
            Flood,
            (
                "calibrated on 30/9/2025: predicted flood spots at 13:00 ≈ reported count \
                 (engine-py/calibration/flood_2025_09_30.py); one event, no validation event yet",
                Low,
            ),
            "Bucket model: effective drainage capacity (Q) per catchment, as mm/h over its area.",
        );
        p.add(
            "flood.depression_storage_mm",
            30.0,
            "mm",
            (0.0, 200.0),
            Flood,
            a_low,
            "Bucket model: storage (lakes, depressions) filled before streets flood (S).",
        );
        p.add(
            "flood.ponding_share",
            0.08,
            "share",
            (0.001, 1.0),
            Flood,
            a_low,
            "Bucket model: share of the catchment area where excess water ponds (sets depth).",
        );
        p.add("flood.low_link_share", 0.25, "share", (0.0, 1.0), Flood, a_low,
            "Bucket model: share of each catchment's low-lying links (deepest in DEM depressions, then lowest) where water ponds; deepest first.");
        p.add("flood.hotspot_depth_factor", 1.5, "×", (0.0, 5.0), Flood, a_low,
            "Bucket model: reported hotspot links get this multiple of the catchment ponding depth.");
        p.add(
            "flood.motorbike_stall_depth_cm",
            25.0,
            "cm",
            (5.0, 80.0),
            Flood,
            ("assumption: exhaust height of common scooters", Low),
            "Depth at which many motorbikes stall; capacity collapses.",
        );
        p.add(
            "flood.stall_capacity_factor",
            0.3,
            "factor",
            (0.0, 1.0),
            Flood,
            a_low,
            "Capacity multiplier at/above the stall depth (stalled bikes, pushing).",
        );
        p.add(
            "flood.closure_depth_cm",
            50.0,
            "cm",
            (10.0, 200.0),
            Flood,
            a_low,
            "Depth at which a road is impassable (treated as closed).",
        );
        p.add(
            "flood.min_speed_kmh",
            5.0,
            "km/h",
            (1.0, 30.0),
            Flood,
            a_low,
            "Lowest speed on a flooded but passable link (walking a bike).",
        );
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_validate() {
        let p = Params::default();
        let mut o = BTreeMap::new();
        o.insert("reroute.informed_share".to_string(), 0.4);
        let q = p.clone().with_overrides(&o).unwrap();
        assert_eq!(q.get("reroute.informed_share"), 0.4);
        assert!(q.structural_changes().is_empty());
        o.insert("nope".into(), 1.0);
        assert!(p.clone().with_overrides(&o).is_err());
        let mut o = BTreeMap::new();
        o.insert("reroute.informed_share".to_string(), 2.0);
        assert!(p.clone().with_overrides(&o).is_err());
        let mut o = BTreeMap::new();
        o.insert("population.scale".to_string(), 1.2);
        assert_eq!(
            p.with_overrides(&o).unwrap().structural_changes(),
            vec!["population.scale"]
        );
    }

    #[test]
    fn class_lookup_uses_parent_for_links() {
        let p = Params::default();
        assert_eq!(p.class_value("capacity_per_lane", "primary_link"), 1500.0);
        assert_eq!(p.class_value("capacity_per_lane", "service"), 400.0);
        assert_eq!(p.class_value("capacity_per_lane", "busway"), 700.0);
    }
}
