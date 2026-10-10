//! Rain and flood layer. The traffic model only needs flood depth per link over
//! time; depth does not depend on traffic, so the flood model runs first and its
//! output is scheduled into the simulation as capacity/speed/closure changes.
//!
//! - Level 1 `hotspots`: reported flood points pond when rain exceeds a threshold and
//!   recede at a fixed rate.
//! - Level 2 `bucket`: each catchment is a bucket with runoff coefficient C, drainage
//!   capacity Q and storage S; excess water ponds on its lowest links.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::bundle::{BCatchment, City};
use crate::ids::LinkId;
use crate::params::Params;
use crate::units::TimeMs;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FloodModel {
    None,
    #[default]
    Hotspots,
    Bucket,
}

/// Piecewise-constant rain intensity: each value holds until the next point;
/// the last one holds for one hour.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RainProfile {
    pub points: Vec<(TimeMs, f64)>,
}

impl RainProfile {
    pub fn new(mut points: Vec<(TimeMs, f64)>) -> Result<Self, String> {
        if points.iter().any(|p| !(p.1 >= 0.0)) {
            return Err("rain intensity must be >= 0".into());
        }
        points.sort_by_key(|p| p.0);
        Ok(Self { points })
    }

    pub fn intensity(&self, t: TimeMs) -> f64 {
        let i = self.points.partition_point(|p| p.0 <= t);
        if i == 0 {
            return 0.0;
        }
        let (t0, v) = self.points[i - 1];
        if i == self.points.len() && t >= t0 + 3_600_000 {
            return 0.0;
        }
        v
    }

    pub fn end(&self) -> TimeMs {
        self.points.last().map_or(0, |p| p.0 + 3_600_000)
    }

    pub fn is_empty(&self) -> bool {
        self.points.iter().all(|p| p.1 <= 0.0)
    }
}

/// Network-wide effect of rain without flooding: (speed factor, capacity factor).
pub fn rain_factors(intensity: f64, p: &Params) -> (f64, f64) {
    let r = (intensity / p.get("rain.heavy_mm_h")).clamp(0.0, 1.0);
    (
        1.0 - r * (1.0 - p.get("rain.speed_factor_heavy")),
        1.0 - r * (1.0 - p.get("rain.capacity_factor_heavy")),
    )
}

/// Pregnolato et al. (2017) depth–disruption curve: max safe car speed (km/h) at
/// water depth `w_mm`. 86.9 km/h at 0 mm, ~0 at ~300 mm.
pub fn pregnolato_kmh(w_mm: f64) -> f64 {
    let w = w_mm.clamp(0.0, 300.0);
    (0.0009 * w * w - 0.5529 * w + 86.9448).max(0.0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloodEffect {
    pub speed_factor: f64,
    pub capacity_factor: f64,
    pub closed: bool,
}

/// Effect of depth on a link with free speed `free_kmh`.
/// Speed: capped by the Pregnolato safe speed, floored at a walking-a-bike speed. Capacity: falls linearly to the stall factor at the motorbike stall depth.
pub fn depth_effect(depth_cm: f64, free_kmh: f64, p: &Params) -> FloodEffect {
    if depth_cm <= 0.0 {
        return FloodEffect {
            speed_factor: 1.0,
            capacity_factor: 1.0,
            closed: false,
        };
    }
    // Pregnolato gives the maximum safe speed in water, so slow roads are only
    // affected once it drops below their free speed.
    let floor = (p.get("flood.min_speed_kmh") / free_kmh).min(1.0);
    let speed = (pregnolato_kmh(depth_cm * 10.0) / free_kmh).clamp(floor, 1.0);
    let stall = p.get("flood.motorbike_stall_depth_cm");
    let stall_cap = p.get("flood.stall_capacity_factor");
    let cap = if depth_cm >= stall {
        stall_cap
    } else {
        1.0 - (1.0 - stall_cap) * depth_cm / stall
    };
    FloodEffect {
        speed_factor: speed,
        capacity_factor: cap,
        closed: depth_cm >= p.get("flood.closure_depth_cm"),
    }
}

/// Depth (cm, rounded to whole cm) per flooded link at each step.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FloodSeries {
    pub start_ms: TimeMs,
    pub step_ms: TimeMs,
    pub n_steps: usize,
    pub depth_cm: BTreeMap<u32, Vec<f32>>,
}

impl FloodSeries {
    pub fn depth_at(&self, l: LinkId, step: usize) -> f32 {
        self.depth_cm.get(&l.0).map_or(0.0, |d| d[step])
    }
}

pub fn simulate(
    city: &City,
    p: &Params,
    rain: &RainProfile,
    model: FloodModel,
    start_ms: TimeMs,
    end_ms: TimeMs,
) -> FloodSeries {
    let step_ms = (p.get("flood.step_min") * 60_000.0) as TimeMs;
    let n_steps = ((end_ms - start_ms) / step_ms).max(1) as usize;
    let dt_h = step_ms as f64 / 3_600_000.0;
    let mut depth: BTreeMap<u32, Vec<f32>> = BTreeMap::new();
    let usable = |l: u32| !city.meta[l as usize].removed && !city.meta[l as usize].bridge;
    let mut set = |l: u32, step: usize, d: f64| {
        if d >= 0.5 && usable(l) {
            let v = depth.entry(l).or_insert_with(|| vec![0.0; n_steps]);
            v[step] = v[step].max(d.round() as f32);
        }
    };
    let max_d = p.get("flood.max_depth_cm");
    let hotspots = &city.bundle.hotspots;

    match model {
        FloodModel::None => {}
        FloodModel::Hotspots => {
            let (thr, thr_u) = (
                p.get("flood.hotspot_threshold_mm_h"),
                p.get("flood.underpass_threshold_mm_h"),
            );
            let (rise, rec) = (
                p.get("flood.rise_cm_per_mm"),
                p.get("flood.recession_cm_per_h"),
            );
            let mut d = vec![0.0f64; hotspots.len()];
            for s in 0..n_steps {
                let i = rain.intensity(start_ms + s as TimeMs * step_ms);
                for (h, hs) in hotspots.iter().enumerate() {
                    let t = if hs.kind == "underpass" { thr_u } else { thr };
                    d[h] = if i > t {
                        (d[h] + rise * (i - t) * dt_h).min(max_d)
                    } else {
                        (d[h] - rec * dt_h).max(0.0)
                    };
                    for &l in &hs.links {
                        set(l, s, d[h]);
                    }
                }
            }
        }
        FloodModel::Bucket => {
            let b = BucketParams::new(p);
            let share = p.get("flood.ponding_share");
            let hs_factor = p.get("flood.hotspot_depth_factor");
            let mut hotspot_link = vec![false; city.meta.len()];
            for h in hotspots {
                for &l in &h.links {
                    hotspot_link[l as usize] = true;
                }
            }
            let cs = &city.bundle.catchments;
            let weights = low_link_weights(city, p.get("flood.low_link_share"));
            let mut st = BucketState::new(cs.len());
            for s in 0..n_steps {
                let i = rain.intensity(start_ms + s as TimeMs * step_ms);
                st.step(cs, &b, i, dt_h);
                for (k, cm) in cs.iter().enumerate() {
                    let base_cm = (st.ponded[k] / share / 10.0).min(max_d);
                    if base_cm < 0.5 {
                        continue;
                    }
                    for &(l, w) in &weights[k] {
                        set(l, s, (base_cm * w).min(max_d));
                    }
                    for &l in &cm.links {
                        if hotspot_link[l as usize] {
                            set(l, s, (base_cm * hs_factor).min(max_d));
                        }
                    }
                }
            }
        }
    }
    FloodSeries {
        start_ms,
        step_ms,
        n_steps,
        depth_cm: depth,
    }
}

/// Bucket-model parameters resolved once per run.
pub struct BucketParams {
    c_default: f64,
    c_scale: f64,
    q: f64,
    s_depr: f64,
    lake_mm: f64,
    spill_thr: f64,
    spill_rate: f64,
}

impl BucketParams {
    pub fn new(p: &Params) -> Self {
        BucketParams {
            c_default: p.get("flood.runoff_coefficient"),
            c_scale: p.get("flood.runoff_scale"),
            q: p.get("flood.drainage_mm_h"),
            s_depr: p.get("flood.depression_storage_mm"),
            lake_mm: p.get("flood.lake_usable_depth_mm"),
            spill_thr: p.get("flood.spill_threshold_mm"),
            spill_rate: p.get("flood.spill_rate_per_h"),
        }
    }

    /// Share of rain on the catchment that reaches streets or lakes: land runoff plus
    /// all rain falling on open water.
    pub fn inflow_share(&self, c: &BCatchment) -> f64 {
        let land = (c.runoff_coefficient.unwrap_or(self.c_default) * self.c_scale).clamp(0.0, 1.0);
        land * (1.0 - c.water_share) + c.water_share
    }

    /// Storage (mm over the catchment) filled before streets pond.
    pub fn storage_mm(&self, c: &BCatchment) -> f64 {
        self.s_depr + c.water_share * self.lake_mm
    }
}

/// Water state per catchment, mm over the catchment area.
#[derive(Clone, Debug, PartialEq)]
pub struct BucketState {
    pub stored: Vec<f64>,
    pub ponded: Vec<f64>,
    /// Cumulative volumes (m³) for the water balance.
    pub rain_m3: f64,
    pub drained_m3: f64,
}

impl BucketState {
    pub fn new(n: usize) -> Self {
        BucketState {
            stored: vec![0.0; n],
            ponded: vec![0.0; n],
            rain_m3: 0.0,
            drained_m3: 0.0,
        }
    }

    pub fn volume_m3(&self, cs: &[BCatchment]) -> f64 {
        cs.iter()
            .enumerate()
            .map(|(k, c)| (self.stored[k] + self.ponded[k]) / 1000.0 * c.area_m2)
            .sum()
    }

    /// One step: rain in, drainage out, storage first, then ponding; afterwards
    /// excess ponded water overflows to the lower neighbour (volumes conserved).
    pub fn step(&mut self, cs: &[BCatchment], b: &BucketParams, rain_mm_h: f64, dt_h: f64) {
        for (k, c) in cs.iter().enumerate() {
            let inflow = b.inflow_share(c) * rain_mm_h * dt_h;
            let s_max = b.storage_mm(c);
            self.rain_m3 += inflow / 1000.0 * c.area_m2;
            let to_store = inflow.min((s_max - self.stored[k]).max(0.0));
            self.stored[k] += to_store;
            self.ponded[k] += inflow - to_store;
            // Drains take ponded street water first, then empty storage.
            let mut cap = b.q * dt_h;
            let dp = cap.min(self.ponded[k]);
            self.ponded[k] -= dp;
            cap -= dp;
            let ds = cap.min(self.stored[k]);
            self.stored[k] -= ds;
            self.drained_m3 += (dp + ds) / 1000.0 * c.area_m2;
        }
        if b.spill_rate > 0.0 {
            let frac = 1.0 - (-b.spill_rate * dt_h).exp();
            let mut moved = vec![0.0f64; cs.len()];
            for (k, c) in cs.iter().enumerate() {
                if let Some(j) = c.spill_to {
                    let excess = self.ponded[k] - b.spill_thr;
                    if excess > 0.0 && j as usize != k {
                        let v = excess * frac * c.area_m2;
                        moved[k] -= v;
                        moved[j as usize] += v;
                    }
                }
            }
            for (k, c) in cs.iter().enumerate() {
                self.ponded[k] += moved[k] / c.area_m2;
            }
        }
    }
}

/// Ponded water is deepest on the lowest links of each catchment: tunnels first, then
/// links furthest below the surrounding ground (DEM lowness; elevation in old bundles).
/// Weights fall linearly with rank from 2 to 0 (mean 1).
fn low_link_weights(city: &City, low_share: f64) -> Vec<Vec<(u32, f64)>> {
    let b = &city.bundle;
    let ends = |l: u32| {
        let bl = &b.links[l as usize];
        (&b.nodes[bl.from as usize], &b.nodes[bl.to as usize])
    };
    let low = |l: u32| {
        let (u, v) = ends(l);
        match (u.low_m, v.low_m) {
            (Some(a), Some(c)) => a.max(c),
            _ => -(u.elev_m + v.elev_m) / 2.0,
        }
    };
    b.catchments
        .iter()
        .map(|cm| {
            let mut ls = cm.low_links.clone();
            ls.sort_by(|&a, &c| {
                let key = |l: u32| !city.meta[l as usize].tunnel;
                key(a)
                    .cmp(&key(c))
                    .then(low(c).total_cmp(&low(a)))
                    .then(a.cmp(&c))
            });
            let keep = ((ls.len() as f64 * low_share).ceil() as usize).max(1);
            let tunnels = ls.iter().filter(|&&l| city.meta[l as usize].tunnel).count();
            ls.truncate(keep.max(tunnels));
            let n = ls.len() as f64;
            ls.iter()
                .enumerate()
                .map(|(k, &l)| {
                    let w = if n > 1.0 {
                        2.0 * (1.0 - (k as f64 + 0.5) / n)
                    } else {
                        1.0
                    };
                    (l, w)
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pregnolato_endpoints() {
        assert!((pregnolato_kmh(0.0) - 86.9448).abs() < 1e-9);
        assert!(pregnolato_kmh(300.0) < 3.0);
        assert!(pregnolato_kmh(100.0) < pregnolato_kmh(50.0));
    }

    #[test]
    fn depth_effect_monotone() {
        let p = Params::default();
        let mut last = depth_effect(0.0, 40.0, &p);
        assert_eq!(last.speed_factor, 1.0);
        for d in 1..80 {
            let e = depth_effect(d as f64, 40.0, &p);
            assert!(e.speed_factor <= last.speed_factor + 1e-12);
            assert!(e.capacity_factor <= last.capacity_factor + 1e-12);
            assert!(e.speed_factor > 0.0);
            last = e;
        }
        assert!(depth_effect(50.0, 40.0, &p).closed);
        assert!(!depth_effect(20.0, 40.0, &p).closed);
    }

    #[test]
    fn rain_profile_steps() {
        let r = RainProfile::new(vec![(1000, 20.0), (0, 5.0)]).unwrap();
        assert_eq!(r.intensity(-1), 0.0);
        assert_eq!(r.intensity(0), 5.0);
        assert_eq!(r.intensity(1000), 20.0);
        assert_eq!(r.intensity(1000 + 3_600_000), 0.0);
    }

    fn catchment(c: Option<f64>, water: f64, spill_to: Option<u32>) -> BCatchment {
        BCatchment {
            id: "c".into(),
            area_m2: 1e6,
            links: vec![],
            low_links: vec![],
            runoff_coefficient: c,
            water_share: water,
            ground_elev_m: None,
            spill_to,
        }
    }

    #[test]
    fn bucket_water_balance_with_spill() {
        let p = Params::default();
        let b = BucketParams::new(&p);
        let cs = vec![
            catchment(Some(0.9), 0.0, Some(1)),
            catchment(Some(0.5), 0.2, Some(2)),
            catchment(None, 0.05, None),
        ];
        let mut st = BucketState::new(cs.len());
        for s in 0..60 {
            let rain = if s < 24 { 90.0 } else { 0.0 };
            st.step(&cs, &b, rain, 5.0 / 60.0);
            let bal = st.rain_m3 - st.drained_m3 - st.volume_m3(&cs);
            assert!(bal.abs() < 1e-6, "step {s}: imbalance {bal}");
            assert!(st.ponded.iter().chain(&st.stored).all(|&v| v >= -1e-12));
        }
        assert!(st.rain_m3 > 0.0 && st.drained_m3 > 0.0);
    }

    #[test]
    fn bucket_land_cover_and_lakes() {
        let p = Params::default();
        let b = BucketParams::new(&p);
        let paved = catchment(Some(0.9), 0.0, None);
        let green = catchment(Some(0.3), 0.0, None);
        let lake = catchment(Some(0.9), 0.4, None);
        assert!(b.inflow_share(&paved) > b.inflow_share(&green));
        assert_eq!(b.inflow_share(&catchment(None, 0.0, None)), p.get("flood.runoff_coefficient"));
        assert!(b.storage_mm(&lake) > b.storage_mm(&paved));
        let cs = vec![paved, green, lake];
        let mut st = BucketState::new(3);
        for _ in 0..12 {
            st.step(&cs, &b, 80.0, 5.0 / 60.0);
        }
        assert!(st.ponded[0] > st.ponded[1]);
        assert!(st.ponded[0] > st.ponded[2]);
    }

    #[test]
    fn bucket_spill_moves_water_downhill_only() {
        let mut p = Params::default();
        p.set("flood.drainage_mm_h", 0.0).unwrap();
        let b = BucketParams::new(&p);
        let cs = vec![catchment(Some(1.0), 0.0, Some(1)), catchment(Some(1.0), 0.0, None)];
        let mut st = BucketState::new(2);
        st.stored = vec![b.storage_mm(&cs[0]), b.storage_mm(&cs[1])];
        st.ponded = vec![100.0, 0.0];
        st.step(&cs, &b, 0.0, 1.0);
        assert!(st.ponded[0] < 100.0 && st.ponded[1] > 0.0);
        assert!((st.ponded[0] + st.ponded[1] - 100.0).abs() < 1e-9);
        assert!(st.ponded[0] >= b.spill_thr);
        let mut none = Params::default();
        none.set("flood.spill_rate_per_h", 0.0).unwrap();
        let mut st2 = BucketState::new(2);
        st2.ponded = vec![100.0, 0.0];
        st2.step(&cs, &BucketParams::new(&none), 0.0, 1.0);
        assert_eq!(st2.ponded[1], 0.0);
    }
}
