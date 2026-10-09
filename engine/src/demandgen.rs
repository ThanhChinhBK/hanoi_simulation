//! Synthetic travel demand from open data: residents per zone produce trips, POIs
//! (plus population, for mixed-use areas) attract them through a gravity model, and
//! entry points add traffic from outside the study area. All numbers are parameters.

use serde::{Deserialize, Serialize};

use crate::bundle::City;
use crate::demand::VehicleType;
use crate::ids::{NodeId, VehicleTypeId};
use crate::params::Params;
use crate::rng::Rng;
use crate::units::TimeMs;

pub const MOTORBIKE: VehicleTypeId = VehicleTypeId(0);
pub const CAR: VehicleTypeId = VehicleTypeId(1);
pub const BUS: VehicleTypeId = VehicleTypeId(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TripKind {
    Local,
    Through,
    Event,
}

/// A trip before routing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Plan {
    pub origin: NodeId,
    pub dest: NodeId,
    pub depart_ms: TimeMs,
    pub vtype: VehicleTypeId,
    pub kind: TripKind,
}

pub fn vehicle_types(p: &Params) -> Vec<VehicleType> {
    vec![
        VehicleType {
            name: "motorbike".into(),
            pcu: p.get("pcu.motorbike"),
            max_speed_mps: p.get("vmax_kmh.motorbike") / 3.6,
        },
        VehicleType {
            name: "car".into(),
            pcu: p.get("pcu.car"),
            max_speed_mps: p.get("vmax_kmh.car") / 3.6,
        },
        VehicleType {
            name: "bus".into(),
            pcu: p.get("pcu.bus"),
            max_speed_mps: p.get("vmax_kmh.car") / 3.6,
        },
    ]
}

pub fn hours(h: f64) -> TimeMs {
    (h * 3_600_000.0).round() as TimeMs
}

fn departure(rng: &mut Rng, p: &Params) -> TimeMs {
    let (peak, sd) = (p.get("departure.peak_h"), p.get("departure.sd_h"));
    let (start, end) = (p.get("departure.start_h"), p.get("departure.end_h"));
    for _ in 0..100 {
        let h = peak + sd * rng.normal();
        if h >= start && h < end {
            return (hours(h) / 1000) * 1000;
        }
    }
    (hours(start + rng.f64() * (end - start)) / 1000) * 1000
}

/// Destination attractiveness per zone.
pub fn attraction(city: &City, p: &Params) -> Vec<f64> {
    let jobs_per = p.get("attraction.jobs_per_poi");
    let poi: Vec<f64> = city
        .zones
        .iter()
        .map(|z| {
            z.poi
                .iter()
                .map(|(k, v)| {
                    p.param(&format!("attraction.{k}")).map_or(0.0, |q| q.value) * v
                })
                .sum::<f64>()
                + z.extra_jobs / jobs_per
        })
        .collect();
    let pop: Vec<f64> = city.zones.iter().map(|z| z.population).collect();
    let (sp, sq) = (poi.iter().sum::<f64>(), pop.iter().sum::<f64>());
    let m = p.get("attraction.population_mix");
    poi.iter()
        .zip(&pop)
        .map(|(&a, &b)| {
            let a = if sp > 0.0 { a / sp } else { 0.0 };
            let b = if sq > 0.0 { b / sq } else { 0.0 };
            (1.0 - m) * a + m * b
        })
        .collect()
}

/// (vehicle type, vehicle trips per person trip) for each simulated mode.
fn mode_rates(p: &Params) -> [(VehicleTypeId, f64); 3] {
    [
        (MOTORBIKE, p.get("mode_share.motorbike") / p.get("occupancy.motorbike")),
        (CAR, p.get("mode_share.car") / p.get("occupancy.car")),
        (BUS, p.get("mode_share.bus") / p.get("occupancy.bus")),
    ]
}

/// Zones whose node can start and end trips.
fn usable_zone(city: &City, z: usize) -> bool {
    city.origin_link[city.zones[z].node.idx()].is_some()
}

pub fn generate(city: &City, p: &Params, seed: u64) -> Vec<Plan> {
    let f = p.get("sample_fraction");
    let beta = p.get("gravity.beta_per_km") / 1000.0;
    let per_person = p.get("trip_rate.per_person_day") * p.get("trip_rate.am_window_share");
    let attr = attraction(city, p);
    let rates = mode_rates(p);
    let zones = &city.zones;
    let mut plans = Vec::new();
    let mut cum = vec![0.0; zones.len()];

    for (i, zi) in zones.iter().enumerate() {
        if !usable_zone(city, i) || zi.population <= 0.0 {
            continue;
        }
        let mut acc = 0.0;
        for (j, zj) in zones.iter().enumerate() {
            if zj.node != zi.node && usable_zone(city, j) {
                acc += attr[j] * (-beta * (zi.x - zj.x).hypot(zi.y - zj.y)).exp();
            }
            cum[j] = acc;
        }
        if acc <= 0.0 {
            continue;
        }
        let mut rng = Rng::stream(seed, 1, i as u64);
        for &(vt, rate) in &rates {
            let n = rng.round_stochastic(zi.population * per_person * rate * f);
            for _ in 0..n {
                let j = rng.pick_cumulative(&cum);
                plans.push(Plan {
                    origin: zi.node,
                    dest: zones[j].node,
                    depart_ms: departure(&mut rng, p),
                    vtype: vt,
                    kind: TripKind::Local,
                });
            }
        }
    }
    plans.extend(through_traffic(city, p, seed, &attr));
    plans
}

fn through_traffic(city: &City, p: &Params, seed: u64, attr: &[f64]) -> Vec<Plan> {
    let f = p.get("sample_fraction");
    let beta = p.get("gravity.beta_per_km") / 1000.0;
    let window_h = p.get("departure.end_h") - p.get("departure.start_h");
    let (transit, car) = (p.get("through.transit_share"), p.get("through.car_share"));
    let entries: Vec<(NodeId, f64)> = city
        .bundle
        .entries
        .iter()
        .filter(|e| city.origin_link[e.node as usize].is_some())
        .map(|e| {
            let c = e.road_class.trim_end_matches("_link");
            let v = p.param(&format!("through.vehicles_per_h.{c}")).map_or(0.0, |q| q.value);
            (NodeId(e.node), v)
        })
        .collect();
    let net = &city.net;
    let mut plans = Vec::new();
    for (k, &(node, vph)) in entries.iter().enumerate() {
        if vph <= 0.0 {
            continue;
        }
        let mut rng = Rng::stream(seed, 2, k as u64);
        // Exits: other entries at least 2 km away, weighted by their volume.
        let mut exits = Vec::new();
        let mut acc = 0.0;
        for &(m, w) in &entries {
            if net.node_dist_m(node, m) >= 2000.0 && w > 0.0 {
                acc += w;
                exits.push((m, acc));
            }
        }
        let exit_cum: Vec<f64> = exits.iter().map(|e| e.1).collect();
        let n0 = net.node(node);
        let mut zacc = 0.0;
        let zone_cum: Vec<f64> = city
            .zones
            .iter()
            .enumerate()
            .map(|(j, z)| {
                if z.node != node && usable_zone(city, j) {
                    zacc += attr[j] * (-beta * (z.x - n0.x).hypot(z.y - n0.y)).exp();
                }
                zacc
            })
            .collect();
        let n = rng.round_stochastic(vph * window_h * f);
        for _ in 0..n {
            let vtype = if rng.f64() < car { CAR } else { MOTORBIKE };
            let dest = if !exits.is_empty() && rng.f64() < transit {
                exits[rng.pick_cumulative(&exit_cum)].0
            } else if zacc > 0.0 {
                city.zones[rng.pick_cumulative(&zone_cum)].node
            } else {
                continue;
            };
            plans.push(Plan {
                origin: node,
                dest,
                depart_ms: departure(&mut rng, p),
                vtype,
                kind: TripKind::Through,
            });
        }
    }
    plans
}

/// Extra trips to a big event (concert, match…): `persons` arrive at `dest`
/// between `arrive_from` and `arrive_to`, coming from zones by population.
#[allow(clippy::too_many_arguments)]
pub fn event_trips(
    city: &City,
    p: &Params,
    seed: u64,
    index: u64,
    dest: NodeId,
    persons: f64,
    arrive_from: TimeMs,
    arrive_to: TimeMs,
) -> Vec<Plan> {
    let f = p.get("sample_fraction");
    let beta = 0.1 / 1000.0;
    let d = city.net.node(dest);
    let mut acc = 0.0;
    let cum: Vec<f64> = city
        .zones
        .iter()
        .enumerate()
        .map(|(j, z)| {
            if z.node != dest && usable_zone(city, j) {
                acc += z.population * (-beta * (z.x - d.x).hypot(z.y - d.y)).exp();
            }
            acc
        })
        .collect();
    if acc <= 0.0 {
        return Vec::new();
    }
    let mut rng = Rng::stream(seed, 3, index);
    let mut plans = Vec::new();
    for (vt, rate) in mode_rates(p) {
        if vt == BUS {
            continue;
        }
        let n = rng.round_stochastic(persons * rate * f);
        for _ in 0..n {
            let z = &city.zones[rng.pick_cumulative(&cum)];
            let arrive = arrive_from + ((arrive_to - arrive_from) as f64 * rng.f64()) as TimeMs;
            // Rough travel-time guess: 1.3 × straight distance at 15 km/h.
            let est = ((z.x - d.x).hypot(z.y - d.y) * 1.3 / (15.0 / 3.6) * 1000.0) as TimeMs;
            plans.push(Plan {
                origin: z.node,
                dest,
                depart_ms: ((arrive - est).max(0) / 1000) * 1000,
                vtype: vt,
                kind: TripKind::Event,
            });
        }
    }
    plans
}
