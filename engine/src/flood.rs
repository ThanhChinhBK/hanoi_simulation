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

use crate::bundle::City;
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
            let (rise, rec) = (p.get("flood.rise_cm_per_mm"), p.get("flood.recession_cm_per_h"));
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
            let c = p.get("flood.runoff_coefficient");
            let q = p.get("flood.drainage_mm_h");
            let s_max = p.get("flood.depression_storage_mm");
            let share = p.get("flood.ponding_share");
            let hs_factor = p.get("flood.hotspot_depth_factor");
            let mut hotspot_link = vec![false; city.meta.len()];
            for h in hotspots {
                for &l in &h.links {
                    hotspot_link[l as usize] = true;
                }
            }
            let cs = &city.bundle.catchments;
            // Ponded water is deepest on the lowest links: weights fall linearly with
            // elevation rank (tunnels first) from 2 to 0, averaging 1.
            let b = &city.bundle;
            let low_share = p.get("flood.low_link_share");
            let elev = |l: u32| {
                let bl = &b.links[l as usize];
                (b.nodes[bl.from as usize].elev_m + b.nodes[bl.to as usize].elev_m) / 2.0
            };
            let weights: Vec<Vec<(u32, f64)>> = cs
                .iter()
                .map(|cm| {
                    let mut ls = cm.low_links.clone();
                    ls.sort_by(|&a, &c| {
                        let key = |l: u32| !city.meta[l as usize].tunnel;
                        key(a).cmp(&key(c)).then(elev(a).total_cmp(&elev(c))).then(a.cmp(&c))
                    });
                    let keep = ((ls.len() as f64 * low_share).ceil() as usize).max(1);
                    let tunnels = ls.iter().filter(|&&l| city.meta[l as usize].tunnel).count();
                    ls.truncate(keep.max(tunnels));
                    let n = ls.len() as f64;
                    ls.iter()
                        .enumerate()
                        .map(|(k, &l)| (l, if n > 1.0 { 2.0 * (1.0 - (k as f64 + 0.5) / n) } else { 1.0 }))
                        .collect()
                })
                .collect();
            let (mut ponded, mut stored) = (vec![0.0f64; cs.len()], vec![0.0f64; cs.len()]);
            for s in 0..n_steps {
                let i = rain.intensity(start_ms + s as TimeMs * step_ms);
                for (k, cm) in cs.iter().enumerate() {
                    let net = (c * i - q) * dt_h; // mm over the catchment
                    if net > 0.0 {
                        let to_store = net.min(s_max - stored[k]);
                        stored[k] += to_store;
                        ponded[k] += net - to_store;
                    } else {
                        let mut spare = -net;
                        let dp = spare.min(ponded[k]);
                        ponded[k] -= dp;
                        spare -= dp;
                        stored[k] -= spare.min(stored[k]);
                    }
                    let base_cm = (ponded[k] / share / 10.0).min(max_d);
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
}
