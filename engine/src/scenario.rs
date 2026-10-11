//! Scenarios and the engine facade shared by the CLI, Python and WASM targets.
//!
//! Two kinds of scenario:
//! - **sudden** (rain, incidents, closures, signals, big events): a single run that
//!   starts from the baseline routes; drivers reroute en route when they meet (or, if
//!   informed, hear about) a disruption.
//! - **structural** (roads, housing, jobs, demand/network parameters): the city is
//!   rebuilt, demand regenerated, and routes re-equilibrated with a few iterations of
//!   replanning before the final run.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::bundle::{Bundle, City, StructuralEdit};
use crate::demand::{Demand, Trip};
use crate::demandgen::{self, event_trips, hours, vehicle_types, Plan, TripKind};
use crate::flood::{
    self, depth_effect, rain_factors, FloodModel, FloodSeries, RainField, RainProfile,
};
use crate::ids::{LinkId, NodeId};
use crate::params::Params;
use crate::replan::{decode_routes, encode_routes, plans_hash, route_plans, route_valid, Routes};
use crate::rng::Rng;
use crate::signals::{default_plan, signal_factors, GreenSplit, SignalPlan};
use crate::sim::{FactorSource, RerouteConfig, Sim, SimConfig};
use crate::stats::{StatsConfig, Trace};
use crate::traveltime::TravelTimes;
use crate::units::TimeMs;

pub type Progress<'a> = &'a mut dyn FnMut(&str, f64);

// ------------------------------------------------------------------ scenario format

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RainPoint {
    pub at: String,
    pub mm_per_hour: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DynamicEvent {
    /// Rain over the whole city, or (with `area`) over a polygon of [lat, lon]
    /// points. Several rain events may overlap; the heaviest rain applies.
    Rain {
        profile: Vec<RainPoint>,
        #[serde(default)]
        flood_model: FloodModel,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<Vec<[f64; 2]>>,
    },
    /// Random traffic accidents: `per_hour` lane-blocking crashes on main roads
    /// (more in rain, see `accidents.rain_multiplier`), each cutting the link's
    /// capacity to `capacity_factor` for `duration_min`.
    Accidents {
        per_hour: f64,
        #[serde(default = "default_accident_duration")]
        duration_min: f64,
        #[serde(default = "default_accident_capacity")]
        capacity_factor: f64,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    Incident {
        link: u32,
        from: String,
        to: String,
        capacity_factor: f64,
    },
    Signal {
        node: u32,
        cycle_s: f64,
        green_split: GreenSplit,
    },
    Closure {
        links: Vec<u32>,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    Event {
        /// [lat, lon]
        destination: [f64; 2],
        extra_trips: f64,
        arrive_between: [String; 2],
    },
}

fn default_accident_duration() -> f64 {
    45.0
}
fn default_accident_capacity() -> f64 {
    0.4
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ScenarioEvent {
    Dynamic(DynamicEvent),
    Structural(StructuralEdit),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Scenario {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub events: Vec<ScenarioEvent>,
    #[serde(default)]
    pub parameter_overrides: BTreeMap<String, f64>,
}

impl Scenario {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| format!("scenario: {e}"))
    }
    fn edits(&self) -> Vec<StructuralEdit> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ScenarioEvent::Structural(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }
    fn dynamic(&self) -> impl Iterator<Item = &DynamicEvent> {
        self.events.iter().filter_map(|e| match e {
            ScenarioEvent::Dynamic(d) => Some(d),
            _ => None,
        })
    }
}

/// "HH:MM" or "HH:MM:SS" → ms since midnight.
pub fn parse_time(s: &str) -> Result<TimeMs, String> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    let num = |x: &str| x.parse::<i64>().map_err(|_| format!("bad time '{s}'"));
    let (h, m, sec) = match parts.as_slice() {
        [h, m] => (num(h)?, num(m)?, 0),
        [h, m, sec] => (num(h)?, num(m)?, num(sec)?),
        _ => return Err(format!("bad time '{s}' (expected HH:MM)")),
    };
    if !(0..48).contains(&h) || !(0..60).contains(&m) || !(0..60).contains(&sec) {
        return Err(format!("bad time '{s}'"));
    }
    Ok(((h * 60 + m) * 60 + sec) * 1000)
}

// ------------------------------------------------------------------ outputs

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub mode: String,
    pub sample_fraction: f64,
    pub trips_planned: usize,
    pub trips_simulated: usize,
    pub trips_cancelled: usize,
    pub trips_delayed: usize,
    pub trips_unroutable: usize,
    pub event_trips: usize,
    pub arrived: usize,
    pub aborted: usize,
    pub unfinished: usize,
    pub stuck_pushes: usize,
    pub reroutes: usize,
    /// Scaled to the full population (÷ sample fraction).
    pub total_delay_veh_h: f64,
    pub mean_trip_min: f64,
    pub iterations: usize,
    /// Mean trip time (min) after each replanning iteration.
    pub convergence_mean_trip_min: Vec<f64>,
    pub flooded_links_max: usize,
    #[serde(default)]
    pub accidents: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AddedLink {
    pub id: u32,
    pub from: u32,
    pub to: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunOutput {
    pub summary: Summary,
    /// What to compare this run with: "baseline" (sudden scenarios), or "control"
    /// (structural scenarios: the baseline re-run through the same replanning
    /// iterations with no changes, so the iteration noise cancels out).
    pub reference: String,
    pub window: StatsConfig,
    pub n_links: usize,
    /// Mean travel time per link and bin (ms), link-major; -1 where no vehicle entered.
    pub link_tt_ms: Vec<f32>,
    /// Vehicles entering each link per bin (sampled; divide by sample fraction).
    pub link_count: Vec<u32>,
    pub free_flow_ms: Vec<f32>,
    /// Network delay per bin, vehicle-hours, full-population scale.
    pub delay_veh_h: Vec<f64>,
    /// Vehicles on the road at the end of each bin, full-population scale.
    pub en_route: Vec<f64>,
    pub rain_mm_h: Vec<f64>,
    pub flood: FloodSeries,
    pub traces: Vec<Trace>,
    /// Expected local-access vehicles per link over the window, full population
    /// (estimate for small streets the sample misses; see `access.rs`). Empty in
    /// intermediate replanning iterations.
    #[serde(default)]
    pub access_volume: Vec<f32>,
    /// Share of all departures in each bin (time profile for `access_volume`).
    #[serde(default)]
    pub departure_share: Vec<f32>,
    pub added_links: Vec<AddedLink>,
    pub removed_links: Vec<u32>,
    /// Accidents generated by an `accidents` event.
    #[serde(default)]
    pub accidents: Vec<Accident>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Accident {
    pub link: u32,
    pub from_ms: TimeMs,
    pub to_ms: TimeMs,
    pub capacity_factor: f64,
}

// ------------------------------------------------------------------ engine

struct BaseState {
    plans: Vec<Plan>,
    routes: Routes,
    tt: Arc<TravelTimes>,
    output: RunOutput,
}

pub struct Engine {
    bundle: Arc<Bundle>,
    params: Params,
    base_city: City,
    base: BaseState,
    seed: u64,
    control: std::sync::OnceLock<RunOutput>,
}

/// Compiled dynamic events for one run.
#[derive(Default)]
struct Dynamic {
    signals: BTreeMap<NodeId, SignalPlan>,
    incidents: Vec<(LinkId, TimeMs, TimeMs, f64)>,
    closures: Vec<(LinkId, TimeMs, Option<TimeMs>)>,
    rain: RainField,
    flood_model: FloodModel,
    events: Vec<(NodeId, f64, TimeMs, TimeMs)>,
    accidents: Option<AccidentSpec>,
}

#[derive(Clone, Copy, Debug)]
struct AccidentSpec {
    per_hour: f64,
    duration_ms: TimeMs,
    capacity_factor: f64,
    from: Option<TimeMs>,
    to: Option<TimeMs>,
}

pub const DEFAULT_SEED: u64 = 42;
const STATS_BIN_MS: TimeMs = 10 * 60_000;
const MAX_TRACES: usize = 8000;

pub fn stats_window(p: &Params) -> StatsConfig {
    let start = hours(p.get("departure.start_h") - 0.5);
    let end = hours(p.get("departure.end_h") + 3.0);
    StatsConfig {
        start_ms: start,
        bin_ms: STATS_BIN_MS,
        n_bins: ((end - start) / STATS_BIN_MS) as usize,
    }
}

impl Engine {
    /// Load a bundle and its baseline. `routes` are the precomputed baseline routes
    /// (from `hanoi-sim baseline`); without them (or if they do not match), routes
    /// are built with `iterations` rounds of replanning.
    pub fn new(
        bundle: Arc<Bundle>,
        routes: Option<&[u8]>,
        iterations: Option<usize>,
        progress: Progress,
    ) -> Result<Self, String> {
        Self::with_params(bundle, Params::default(), routes, iterations, progress)
    }

    /// Like [`Engine::new`] with non-default baseline parameters (calibration).
    /// Scenario overrides are applied on top of these.
    pub fn with_params(
        bundle: Arc<Bundle>,
        params: Params,
        routes: Option<&[u8]>,
        iterations: Option<usize>,
        progress: Progress,
    ) -> Result<Self, String> {
        let seed = DEFAULT_SEED;
        let city = City::build(bundle.clone(), &params, &[])?;
        let plans = demandgen::generate(&city, &params, seed);
        let hash = plans_hash(&plans, city.net.links().len());
        let mut warnings = Vec::new();
        let window = stats_window(&params);
        let ff = TravelTimes::free_flow(&city.net, window.start_ms, window.bin_ms, window.n_bins);

        let stored = match routes.map(|b| decode_routes(&city, b)) {
            Some(Ok((h, r))) if h == hash && r.len() == plans.len() => Some(r),
            Some(Ok(_)) => {
                warnings.push(
                    "baseline routes do not match this bundle/engine version; recomputed".into(),
                );
                None
            }
            Some(Err(e)) => {
                warnings.push(format!("baseline routes unreadable ({e}); recomputed"));
                None
            }
            None => None,
        };
        let (routes, tt0, convergence) = match stored {
            Some(r) => (r, ff, Vec::new()),
            None => {
                let mut r: Routes = vec![None; plans.len()];
                progress("routing", 0.0);
                let all: Vec<usize> = (0..plans.len()).collect();
                route_plans(&city, &plans, &all, &ff, &mut r, 0.0);
                let it = iterations.unwrap_or(params.get("replan.iterations") as usize);
                let (tt, conv) = replan(
                    &city,
                    &params,
                    &plans,
                    &mut r,
                    ff,
                    (it, it, 0.0),
                    seed,
                    progress,
                );
                (r, tt, conv)
            }
        };
        let empty = Dynamic::default();
        let tt0 = Arc::new(tt0);
        let (mut output, tt) = execute(
            &city, &params, &plans, &routes, &empty, seed, tt0, true, progress,
        )?;
        output.summary.mode = "baseline".into();
        output.summary.iterations = convergence.len();
        output.summary.convergence_mean_trip_min = convergence;
        output.summary.warnings.extend(warnings);
        Ok(Engine {
            bundle,
            params,
            base_city: city,
            base: BaseState {
                plans,
                routes,
                tt: Arc::new(tt),
                output,
            },
            seed,
            control: std::sync::OnceLock::new(),
        })
    }

    pub fn baseline(&self) -> &RunOutput {
        &self.base.output
    }

    pub fn baseline_routes(&self) -> Vec<u8> {
        let hash = plans_hash(&self.base.plans, self.base_city.net.links().len());
        encode_routes(&self.base_city, hash, &self.base.routes)
    }

    pub fn params(&self) -> &Params {
        &self.params
    }

    pub fn bundle(&self) -> &Bundle {
        &self.bundle
    }

    /// Default fixed-time plan of every signalised junction in the base network.
    pub fn signal_plans(&self) -> Vec<(u32, SignalPlan)> {
        let c = &self.base_city;
        c.net
            .nodes()
            .iter()
            .filter(|n| c.signal[n.id.idx()])
            .map(|n| (n.id.0, default_plan(c, &self.params, n.id)))
            .collect()
    }

    /// Reference for structural scenarios (computed once, then cached).
    pub fn control(&self, progress: Progress) -> Result<&RunOutput, String> {
        if let Some(c) = self.control.get() {
            return Ok(c);
        }
        let mut out = self.run_inner(&Scenario::default(), true, progress)?;
        out.summary.mode = "control".into();
        out.reference = "baseline".into();
        let _ = self.control.set(out);
        Ok(self.control.get().expect("set"))
    }

    pub fn control_ready(&self) -> bool {
        self.control.get().is_some()
    }

    /// The output a run should be compared with (see [`RunOutput::reference`]).
    pub fn reference_for(&self, out: &RunOutput, progress: Progress) -> Result<&RunOutput, String> {
        if out.reference == "control" {
            self.control(progress)
        } else {
            Ok(self.baseline())
        }
    }

    pub fn run(&self, sc: &Scenario, progress: Progress) -> Result<RunOutput, String> {
        self.run_inner(sc, false, progress)
    }

    fn run_inner(
        &self,
        sc: &Scenario,
        force_structural: bool,
        progress: Progress,
    ) -> Result<RunOutput, String> {
        let params = self
            .params
            .clone()
            .with_overrides(&sc.parameter_overrides)
            .map_err(|e| e.to_string())?;
        let edits = sc.edits();
        let seed = sc.seed.unwrap_or(self.seed);
        let changed = !params.structural_diff(&self.params).is_empty();
        let structural = force_structural || !edits.is_empty() || changed || seed != self.seed;
        let city = if edits.is_empty() && !changed {
            self.base_city.clone()
        } else {
            City::build(self.bundle.clone(), &params, &edits)?
        };
        let dynamic = compile_dynamic(&city, sc)?;
        let mut plans = demandgen::generate(&city, &params, seed);
        for (k, &(node, persons, a, b)) in dynamic.events.iter().enumerate() {
            plans.extend(event_trips(
                &city, &params, seed, k as u64, node, persons, a, b,
            ));
        }

        // Reuse baseline routes for identical trips; route the rest on baseline times.
        // Identical trips (same key) are matched in order, so an unchanged plan list
        // maps one-to-one onto the baseline.
        let mut lookup: HashMap<(NodeId, NodeId, TimeMs, u32), VecDeque<usize>> = HashMap::new();
        for (i, p) in self.base.plans.iter().enumerate() {
            lookup
                .entry((p.origin, p.dest, p.depart_ms, p.vtype.0))
                .or_default()
                .push_back(i);
        }
        let mut routes: Routes = vec![None; plans.len()];
        let mut todo = Vec::new();
        for (i, p) in plans.iter().enumerate() {
            let reused = lookup
                .get_mut(&(p.origin, p.dest, p.depart_ms, p.vtype.0))
                .and_then(|q| q.pop_front())
                .and_then(|j| self.base.routes[j].as_ref())
                .filter(|r| route_valid(&city, p, r));
            match reused {
                Some(r) => routes[i] = Some(r.clone()),
                None => todo.push(i),
            }
        }
        progress("routing", 0.0);
        let window = stats_window(&params);
        let base_tt = if window != stats_window(&self.params) {
            Arc::new(TravelTimes::free_flow(
                &city.net,
                window.start_ms,
                window.bin_ms,
                window.n_bins,
            ))
        } else if edits.is_empty() {
            self.base.tt.clone()
        } else {
            Arc::new(self.base.tt.adapted_to(&city.net))
        };
        route_plans(&city, &plans, &todo, &base_tt, &mut routes, 0.0);

        let mut convergence = Vec::new();
        let mut expected = base_tt;
        if structural {
            let it = params.get("replan.scenario_iterations") as usize;
            let max_it = (params.get("replan.scenario_max_iterations") as usize).max(it);
            let tol = params.get("replan.convergence_tol");
            let (tt, conv) = replan(
                &city,
                &params,
                &plans,
                &mut routes,
                (*expected).clone(),
                (it, max_it, tol),
                seed,
                progress,
            );
            convergence = conv;
            if it > 0 {
                expected = Arc::new(tt);
            }
        }
        let (mut out, _) = execute(
            &city, &params, &plans, &routes, &dynamic, seed, expected, true, progress,
        )?;
        out.summary.mode = if structural { "structural" } else { "sudden" }.into();
        out.reference = if structural { "control" } else { "baseline" }.into();
        out.summary.iterations = convergence.len();
        out.summary.convergence_mean_trip_min = convergence;
        out.summary.event_trips = plans.iter().filter(|p| p.kind == TripKind::Event).count();
        Ok(out)
    }
}

fn compile_dynamic(city: &City, sc: &Scenario) -> Result<Dynamic, String> {
    let mut d = Dynamic::default();
    let n_links = city.net.links().len() as u32;
    let n_nodes = city.net.nodes().len() as u32;
    let link = |l: u32| {
        if l < n_links {
            Ok(LinkId(l))
        } else {
            Err(format!("unknown link {l}"))
        }
    };
    let mut rain_cells = Vec::new();
    let mut flood_model: Option<FloodModel> = None;
    for e in sc.dynamic() {
        match e {
            DynamicEvent::Rain {
                profile,
                flood_model: fm,
                area,
            } => {
                if flood_model.is_some_and(|m| m != *fm) {
                    return Err("all rain events must use the same flood model".into());
                }
                flood_model = Some(*fm);
                let pts = profile
                    .iter()
                    .map(|p| Ok((parse_time(&p.at)?, p.mm_per_hour)))
                    .collect::<Result<Vec<_>, String>>()?;
                let poly = match area {
                    None => None,
                    Some(pts) => {
                        if pts.len() < 3 {
                            return Err("rain area needs at least 3 points".into());
                        }
                        Some(pts.iter().map(|p| city.project(p[1], p[0])).collect())
                    }
                };
                rain_cells.push((RainProfile::new(pts)?, poly));
            }
            DynamicEvent::Accidents {
                per_hour,
                duration_min,
                capacity_factor,
                from,
                to,
            } => {
                if d.accidents.is_some() {
                    return Err("only one accidents event per scenario".into());
                }
                if !(*per_hour >= 0.0 && *per_hour <= 200.0) {
                    return Err("accidents: per_hour must be in [0, 200]".into());
                }
                if !(*duration_min > 0.0 && *duration_min <= 600.0) {
                    return Err("accidents: duration_min must be in (0, 600]".into());
                }
                if !(*capacity_factor >= 0.0 && *capacity_factor <= 1.0) {
                    return Err("accidents: capacity_factor must be in [0, 1]".into());
                }
                let a = from.as_deref().map(parse_time).transpose()?;
                let b = to.as_deref().map(parse_time).transpose()?;
                if let (Some(a), Some(b)) = (a, b) {
                    if b <= a {
                        return Err("accidents: 'to' must be after 'from'".into());
                    }
                }
                d.accidents = Some(AccidentSpec {
                    per_hour: *per_hour,
                    duration_ms: (*duration_min * 60_000.0) as TimeMs,
                    capacity_factor: *capacity_factor,
                    from: a,
                    to: b,
                });
            }
            DynamicEvent::Incident {
                link: l,
                from,
                to,
                capacity_factor,
            } => {
                if !(*capacity_factor >= 0.0 && *capacity_factor <= 1.0) {
                    return Err("incident capacity_factor must be in [0, 1]".into());
                }
                let (a, b) = (parse_time(from)?, parse_time(to)?);
                if b <= a {
                    return Err("incident: 'to' must be after 'from'".into());
                }
                d.incidents.push((link(*l)?, a, b, *capacity_factor));
            }
            DynamicEvent::Signal {
                node,
                cycle_s,
                green_split,
            } => {
                if *node >= n_nodes {
                    return Err(format!("unknown node {node}"));
                }
                d.signals.insert(
                    NodeId(*node),
                    SignalPlan {
                        cycle_s: *cycle_s,
                        green_split: *green_split,
                    },
                );
            }
            DynamicEvent::Closure { links, from, to } => {
                let a = from.as_deref().map(parse_time).transpose()?.unwrap_or(0);
                let b = to.as_deref().map(parse_time).transpose()?;
                if b.is_some_and(|b| b <= a) {
                    return Err("closure: 'to' must be after 'from'".into());
                }
                for &l in links {
                    d.closures.push((link(l)?, a, b));
                }
            }
            DynamicEvent::Event {
                destination,
                extra_trips,
                arrive_between,
            } => {
                if !(*extra_trips >= 0.0) {
                    return Err("event: extra_trips must be >= 0".into());
                }
                let (x, y) = city.project(destination[1], destination[0]);
                let node = city.nearest_node(x, y).ok_or("event: no node nearby")?;
                let (a, b) = (
                    parse_time(&arrive_between[0])?,
                    parse_time(&arrive_between[1])?,
                );
                if b < a {
                    return Err("event: arrive_between must be ordered".into());
                }
                d.events.push((node, *extra_trips, a, b));
            }
        }
    }
    if !rain_cells.is_empty() {
        d.rain = RainField::new(city, rain_cells)?;
        d.flood_model = flood_model.unwrap_or_default();
    }
    Ok(d)
}

/// Draw accidents: a Poisson process over main roads, weighted by length × capacity
/// (a proxy for vehicle-km), thinned so rain raises the local rate up to
/// `accidents.rain_multiplier` at `rain.heavy_mm_h`. No two overlap on one link.
fn draw_accidents(
    city: &City,
    p: &Params,
    spec: &AccidentSpec,
    rain: &RainField,
    seed: u64,
) -> Vec<(LinkId, TimeMs, TimeMs, f64)> {
    const MAIN: [&str; 5] = ["motorway", "trunk", "primary", "secondary", "tertiary"];
    let mut ids = Vec::new();
    let mut cum = Vec::new();
    let mut total = 0.0;
    for (i, l) in city.net.links().iter().enumerate() {
        let m = &city.meta[i];
        let class = m.road_class.trim_end_matches("_link");
        if m.removed || !MAIN.contains(&class) {
            continue;
        }
        total += l.length_m * l.flow_capacity_pcu_per_h;
        ids.push(LinkId(i as u32));
        cum.push(total);
    }
    if ids.is_empty() || spec.per_hour <= 0.0 {
        return Vec::new();
    }
    let a = spec.from.unwrap_or(hours(p.get("departure.start_h")));
    let b = spec.to.unwrap_or(hours(p.get("departure.end_h") + 1.0));
    let mult = p.get("accidents.rain_multiplier").max(1.0);
    let heavy = p.get("rain.heavy_mm_h");
    let rate_ms = spec.per_hour * mult / 3_600_000.0;
    let mut rng = Rng::stream(seed, 7, 0);
    let mut out: Vec<(LinkId, TimeMs, TimeMs, f64)> = Vec::new();
    let mut t = a as f64;
    while out.len() < 2000 {
        t += -(1.0 - rng.f64()).ln() / rate_ms;
        if t >= b as f64 {
            break;
        }
        let l = ids[rng.pick_cumulative(&cum)];
        let start = t as TimeMs;
        let r = (rain.at_link(l, start) / heavy).clamp(0.0, 1.0);
        if rng.f64() >= (1.0 + (mult - 1.0) * r) / mult {
            continue;
        }
        let end = start + spec.duration_ms;
        if out
            .iter()
            .any(|&(o, s, e, _)| o == l && s < end && start < e)
        {
            continue;
        }
        out.push((l, start, end, spec.capacity_factor));
    }
    out
}

fn sim_config(p: &Params, n_trips: usize, traces: bool) -> SimConfig {
    SimConfig {
        sample_fraction: p.get("sample_fraction"),
        storage_fraction: Some(
            p.get("sample_fraction")
                .powf(p.get("storage_scale_exponent")),
        ),
        stuck_threshold_ms: (p.get("stuck_threshold_s") * 1000.0) as TimeMs,
        record_log: false,
        stats: Some(stats_window(p)),
        trace_every: if traces {
            (n_trips / MAX_TRACES).max(1) as u32
        } else {
            0
        },
    }
}

fn build_demand(
    p: &Params,
    plans: &[Plan],
    routes: &Routes,
    active: &[bool],
    depart: &[TimeMs],
) -> (Demand, Vec<usize>) {
    let mut trips = Vec::new();
    let mut idx = Vec::new();
    for (i, (pl, r)) in plans.iter().zip(routes).enumerate() {
        if let (true, Some(r)) = (active[i], r) {
            trips.push(Trip {
                vehicle_type: pl.vtype,
                depart_ms: depart[i],
                route: r.clone(),
            });
            idx.push(i);
        }
    }
    (
        Demand {
            vehicle_types: vehicle_types(p),
            trips,
        },
        idx,
    )
}

/// Iterative replanning: simulate, measure link travel times, let `replan.share` of
/// trips switch to their best route. Returns the last measured travel times and the
/// mean trip time per iteration. `(min, max, tol)`: after `min` iterations, stop once
/// the mean trip time changes by less than `tol` (relative) between iterations.
#[allow(clippy::too_many_arguments)]
fn replan(
    city: &City,
    p: &Params,
    plans: &[Plan],
    routes: &mut Routes,
    tt0: TravelTimes,
    (min_it, iterations, tol): (usize, usize, f64),
    seed: u64,
    progress: Progress,
) -> (TravelTimes, Vec<f64>) {
    let share = p.get("replan.share");
    let w_min = p.get("replan.tt_smoothing_min");
    let mut tt = tt0;
    let mut conv = Vec::new();
    let active = vec![true; plans.len()];
    let depart: Vec<TimeMs> = plans.iter().map(|p| p.depart_ms).collect();
    let net = Arc::new((*city.net).clone());
    for it in 0..iterations {
        progress("replanning", it as f64 / iterations as f64);
        let (demand, idx) = build_demand(p, plans, routes, &active, &depart);
        let mut sim =
            Sim::new(net.clone(), Arc::new(demand), sim_config(p, 0, false)).expect("valid demand");
        setup_static(&mut sim, city, p, &BTreeMap::new()).expect("valid signals");
        sim.run();
        let arr = sim.arrival_times();
        let (mut sum, mut n) = (0.0, 0usize);
        for (k, &i) in idx.iter().enumerate() {
            if arr[k] >= 0 {
                sum += (arr[k] - plans[i].depart_ms) as f64;
                n += 1;
            }
        }
        conv.push(if n > 0 {
            sum / n as f64 / 60_000.0
        } else {
            0.0
        });
        let observed = sim.stats().expect("stats").travel_times(&city.net);
        // Method of successive averages: damps route flip-flopping between iterations.
        let w = (1.0 / (it as f64 + 1.0)).max(w_min) as f32;
        tt.blend(&observed, w);
        if it + 1 >= min_it.max(2) {
            let (a, b) = (conv[conv.len() - 2], conv[conv.len() - 1]);
            if a > 0.0 && ((b - a) / a).abs() < tol {
                break;
            }
        }
        let mut rng = Rng::stream(seed, 5, it as u64);
        let which: Vec<usize> = (0..plans.len()).filter(|_| rng.f64() < share).collect();
        route_plans(
            city,
            plans,
            &which,
            &tt,
            routes,
            p.get("replan.switch_gain"),
        );
    }
    progress("replanning", 1.0);
    (tt, conv)
}

/// Signals and removed roads (present in every run).
fn setup_static(
    sim: &mut Sim,
    city: &City,
    p: &Params,
    overrides: &BTreeMap<NodeId, SignalPlan>,
) -> Result<(), String> {
    for (l, f) in signal_factors(city, p, overrides)? {
        sim.schedule_capacity_factor(0, l, FactorSource::Signal, f)
            .map_err(|e| e.to_string())?;
    }
    for (i, m) in city.meta.iter().enumerate() {
        if m.removed {
            sim.schedule_closure(0, LinkId(i as u32), true)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Rain behaviour: trips departing in heavy rain may be cancelled or postponed.
fn rain_behaviour(
    p: &Params,
    plans: &[Plan],
    rain: &RainField,
    seed: u64,
) -> (Vec<bool>, Vec<TimeMs>, usize, usize) {
    let thr = p.get("behaviour.cancel_rain_mm_h");
    let (cancel, delay) = (
        p.get("behaviour.cancel_share"),
        p.get("behaviour.delay_share"),
    );
    let max_delay = (p.get("behaviour.max_delay_min") * 60_000.0) as TimeMs;
    let mut active = vec![true; plans.len()];
    let mut depart: Vec<TimeMs> = plans.iter().map(|p| p.depart_ms).collect();
    let (mut nc, mut nd) = (0, 0);
    if rain.is_empty() {
        return (active, depart, 0, 0);
    }
    for (i, pl) in plans.iter().enumerate() {
        if pl.kind == TripKind::Event || rain.at_node(pl.origin, pl.depart_ms) < thr {
            continue;
        }
        let mut rng = Rng::stream(seed, 6, i as u64);
        let u = rng.f64();
        if u < cancel {
            active[i] = false;
            nc += 1;
        } else if u < cancel + delay {
            // Wait until the rain drops below the threshold (5-min steps), then go.
            let mut t = pl.depart_ms;
            while rain.at_node(pl.origin, t) >= thr && t - pl.depart_ms < max_delay {
                t += 300_000;
            }
            depart[i] = (t + (rng.f64() * 600_000.0) as TimeMs).min(pl.depart_ms + max_delay);
            nd += 1;
        }
    }
    (active, depart, nc, nd)
}

#[allow(clippy::too_many_arguments)]
fn execute(
    city: &City,
    p: &Params,
    plans: &[Plan],
    routes: &Routes,
    d: &Dynamic,
    seed: u64,
    expected: Arc<TravelTimes>,
    traces: bool,
    progress: Progress,
) -> Result<(RunOutput, TravelTimes), String> {
    let window = stats_window(p);
    let f = p.get("sample_fraction");
    let (active, depart, cancelled, delayed) = rain_behaviour(p, plans, &d.rain, seed);
    let (demand, idx) = build_demand(p, plans, routes, &active, &depart);
    let n_trips = demand.trips.len();
    let informed_share = p.get("reroute.informed_share");
    let informed: Vec<bool> = idx
        .iter()
        .map(|&i| Rng::stream(seed, 4, i as u64).f64() < informed_share)
        .collect();
    let net = Arc::new((*city.net).clone());
    let mut sim = Sim::new(net, Arc::new(demand), sim_config(p, n_trips, traces))
        .map_err(|e| e.to_string())?;
    sim.set_rerouting(RerouteConfig {
        informed,
        max_reroutes: p.get("reroute.max_reroutes") as u8,
        disruption_threshold: p.get("reroute.disruption_threshold"),
        expected: Some(expected),
        closure_visibility_m: p.get("reroute.closure_visibility_m"),
    })
    .map_err(|e| e.to_string())?;
    setup_static(&mut sim, city, p, &d.signals)?;
    let err = |e: crate::sim::SimError| e.to_string();
    let accidents = d
        .accidents
        .as_ref()
        .map(|s| draw_accidents(city, p, s, &d.rain, seed))
        .unwrap_or_default();
    for &(l, a, b, fac) in d.incidents.iter().chain(&accidents) {
        sim.schedule_capacity_factor(a, l, FactorSource::Incident, fac)
            .map_err(err)?;
        sim.schedule_capacity_factor(b, l, FactorSource::Incident, 1.0)
            .map_err(err)?;
    }
    for &(l, a, b) in &d.closures {
        sim.schedule_closure(a, l, true).map_err(err)?;
        if let Some(b) = b {
            sim.schedule_closure(b, l, false).map_err(err)?;
        }
    }

    // Rain and flood.
    let end = window.start_ms + window.bin_ms * window.n_bins as TimeMs;
    let fl = flood::simulate_field(city, p, &d.rain, d.flood_model, window.start_ms, end);
    let n_links = city.net.links().len();
    if !d.rain.is_empty() {
        let mut last = vec![(1.0, 1.0); n_links];
        for s in 0..fl.n_steps {
            let t = fl.start_ms + s as TimeMs * fl.step_ms;
            for (l, last) in last.iter_mut().enumerate() {
                let link = LinkId(l as u32);
                let rf = rain_factors(d.rain.at_link(link, t), p);
                if rf != *last {
                    sim.schedule_speed_factor(t, link, FactorSource::Rain, rf.0)
                        .map_err(err)?;
                    sim.schedule_capacity_factor(t, link, FactorSource::Rain, rf.1)
                        .map_err(err)?;
                    *last = rf;
                }
            }
        }
    }
    let mut flooded_max = 0;
    for s in 0..fl.n_steps {
        flooded_max = flooded_max.max(fl.depth_cm.values().filter(|v| v[s] > 0.0).count());
    }
    for (&l, series) in &fl.depth_cm {
        let link = LinkId(l);
        let free_kmh = city.net.link(link).free_speed_mps * 3.6;
        let (mut last_d, mut closed) = (0.0f32, false);
        for (s, &dep) in series.iter().enumerate() {
            if dep == last_d {
                continue;
            }
            let t = fl.start_ms + s as TimeMs * fl.step_ms;
            let e = depth_effect(dep as f64, free_kmh, p);
            sim.schedule_speed_factor(t, link, FactorSource::Flood, e.speed_factor)
                .map_err(err)?;
            sim.schedule_capacity_factor(t, link, FactorSource::Flood, e.capacity_factor)
                .map_err(err)?;
            if e.closed != closed {
                sim.schedule_closure(t, link, e.closed).map_err(err)?;
                closed = e.closed;
            }
            last_d = dep;
        }
    }

    // Run in chunks so callers can show progress.
    let chunk = 5 * 60_000;
    let mut t = window.start_ms;
    let horizon = window.start_ms + 24 * 3_600_000;
    while !sim.is_finished() && t < horizon {
        t += chunk;
        sim.run_until(t);
        progress(
            "simulating",
            ((t - window.start_ms) as f64 / (end - window.start_ms) as f64).min(1.0),
        );
    }

    let counts = sim.counts();
    let stats = sim.stats().expect("stats").clone();
    let tt = stats.travel_times(&city.net);
    let arr = sim.arrival_times().to_vec();
    let traces_out = sim.traces().to_vec();
    let (mut sum, mut n) = (0.0, 0usize);
    for (k, &i) in idx.iter().enumerate() {
        if arr[k] >= 0 {
            sum += (arr[k] - depart[i]) as f64;
            n += 1;
        }
    }
    let mut en_route = Vec::with_capacity(window.n_bins);
    let mut acc = 0.0;
    for b in 0..window.n_bins {
        acc += stats.departures[b] as f64 - stats.arrivals[b] as f64;
        en_route.push(acc / f);
    }
    let rain_mm_h = (0..window.n_bins)
        .map(|b| {
            d.rain
                .max_intensity(window.start_ms + b as TimeMs * window.bin_ms)
        })
        .collect();
    let base_links = city.bundle.links.len();
    let summary = Summary {
        mode: String::new(),
        sample_fraction: f,
        trips_planned: plans.len(),
        trips_simulated: n_trips,
        trips_cancelled: cancelled,
        trips_delayed: delayed,
        trips_unroutable: routes.iter().filter(|r| r.is_none()).count(),
        event_trips: 0,
        arrived: counts.arrived,
        aborted: counts.aborted,
        unfinished: counts.on_links + counts.waiting + counts.not_departed,
        stuck_pushes: counts.stuck_pushes,
        reroutes: counts.reroutes,
        total_delay_veh_h: stats.delay_s.iter().sum::<f64>() / 3600.0 / f,
        mean_trip_min: if n > 0 {
            sum / n as f64 / 60_000.0
        } else {
            0.0
        },
        iterations: 0,
        convergence_mean_trip_min: Vec::new(),
        flooded_links_max: flooded_max,
        accidents: accidents.len(),
        warnings: Vec::new(),
    };
    let out = RunOutput {
        summary,
        reference: "baseline".into(),
        window: window.clone(),
        n_links,
        link_tt_ms: stats
            .mean_tt()
            .into_iter()
            .map(|v| if v.is_nan() { -1.0 } else { v })
            .collect(),
        link_count: stats.link_count.clone(),
        free_flow_ms: tt.free_flow.clone(),
        delay_veh_h: stats.delay_s.iter().map(|s| s / 3600.0 / f).collect(),
        en_route,
        rain_mm_h,
        flood: fl,
        traces: traces_out,
        access_volume: if traces {
            crate::access::local_access_volume(city, p)
        } else {
            Vec::new()
        },
        departure_share: {
            let tot: u64 = stats.departures.iter().map(|&x| x as u64).sum();
            stats
                .departures
                .iter()
                .map(|&x| if tot > 0 { x as f32 / tot as f32 } else { 0.0 })
                .collect()
        },
        added_links: city
            .meta
            .iter()
            .enumerate()
            .skip(base_links)
            .map(|(i, _)| {
                let l = city.net.link(LinkId(i as u32));
                AddedLink {
                    id: i as u32,
                    from: l.from.0,
                    to: l.to.0,
                }
            })
            .collect(),
        removed_links: city
            .meta
            .iter()
            .enumerate()
            .filter(|(_, m)| m.removed)
            .map(|(i, _)| i as u32)
            .collect(),
        accidents: accidents
            .iter()
            .map(|&(l, a, b, f)| Accident {
                link: l.0,
                from_ms: a,
                to_ms: b,
                capacity_factor: f,
            })
            .collect(),
    };
    Ok((out, tt))
}
