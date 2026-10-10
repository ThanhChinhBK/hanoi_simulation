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
                .map(|(k, v)| p.param(&format!("attraction.{k}")).map_or(0.0, |q| q.value) * v)
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
        (
            MOTORBIKE,
            p.get("mode_share.motorbike") / p.get("occupancy.motorbike"),
        ),
        (CAR, p.get("mode_share.car") / p.get("occupancy.car")),
        (BUS, p.get("mode_share.bus") / p.get("occupancy.bus")),
    ]
}

/// Street nodes of a zone where trips can start/end, with cumulative weights for
/// drawing origins (population) and destinations (attraction mixed with population).
pub(crate) struct Access {
    pub(crate) nodes: Vec<NodeId>,
    pub(crate) origin_cum: Vec<f64>,
    pub(crate) dest_cum: Vec<f64>,
}

impl Access {
    fn usable(&self) -> bool {
        !self.nodes.is_empty()
    }
    fn origin(&self, rng: &mut Rng) -> NodeId {
        self.nodes[rng.pick_cumulative(&self.origin_cum)]
    }
    fn dest(&self, rng: &mut Rng) -> NodeId {
        self.nodes[rng.pick_cumulative(&self.dest_cum)]
    }
}

pub(crate) fn zone_access(city: &City, p: &Params) -> Vec<Access> {
    let m = p.get("attraction.population_mix");
    city.zones
        .iter()
        .map(|z| {
            let ok = |n: NodeId| city.origin_link[n.idx()].is_some();
            let mut entries: Vec<(NodeId, f64, f64)> =
                z.access.iter().copied().filter(|a| ok(a.0)).collect();
            if entries.is_empty() && ok(z.node) {
                entries.push((z.node, 1.0, 1.0));
            }
            let (sp, sa) = entries
                .iter()
                .fold((0.0, 0.0), |s, e| (s.0 + e.1, s.1 + e.2));
            let norm = |v: f64, t: f64, n: usize| if t > 0.0 { v / t } else { 1.0 / n as f64 };
            let n = entries.len();
            let (mut a, mut b) = (0.0, 0.0);
            let mut origin_cum = Vec::with_capacity(n);
            let mut dest_cum = Vec::with_capacity(n);
            for e in &entries {
                a += norm(e.1, sp, n);
                b += (1.0 - m) * norm(e.2, sa, n) + m * norm(e.1, sp, n);
                origin_cum.push(a);
                dest_cum.push(b);
            }
            Access {
                nodes: entries.iter().map(|e| e.0).collect(),
                origin_cum,
                dest_cum,
            }
        })
        .collect()
}

/// Draw a destination node in zone `j` different from `origin` (few retries).
fn dest_node(acc: &Access, origin: NodeId, rng: &mut Rng) -> Option<NodeId> {
    for _ in 0..4 {
        let d = acc.dest(rng);
        if d != origin {
            return Some(d);
        }
    }
    None
}

pub fn generate(city: &City, p: &Params, seed: u64) -> Vec<Plan> {
    let f = p.get("sample_fraction");
    let beta = p.get("gravity.beta_per_km") / 1000.0;
    let ret_share = p.get("trip_rate.return_share");
    let dwell_ms = p.get("trip_rate.return_dwell_min") * 60_000.0;
    let window_end = hours(p.get("departure.end_h") + 1.0);
    let per_person =
        p.get("trip_rate.per_person_day") * p.get("trip_rate.am_window_share") / (1.0 + ret_share);
    let attr = attraction(city, p);
    let rates = mode_rates(p);
    let zones = &city.zones;
    let access = zone_access(city, p);
    let mut plans = Vec::new();
    let mut cum = vec![0.0; zones.len()];

    for (i, zi) in zones.iter().enumerate() {
        if !access[i].usable() || zi.population <= 0.0 {
            continue;
        }
        let mut acc = 0.0;
        for (j, zj) in zones.iter().enumerate() {
            if j != i && access[j].usable() {
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
                let origin = access[i].origin(&mut rng);
                let Some(dest) = dest_node(&access[j], origin, &mut rng) else {
                    continue;
                };
                let depart_ms = departure(&mut rng, p);
                plans.push(Plan {
                    origin,
                    dest,
                    depart_ms,
                    vtype: vt,
                    kind: TripKind::Local,
                });
                if rng.f64() < ret_share {
                    let back = depart_ms + ((dwell_ms * (0.5 + rng.f64())) as TimeMs / 1000) * 1000;
                    if back < window_end {
                        plans.push(Plan {
                            origin: dest,
                            dest: origin,
                            depart_ms: back,
                            vtype: vt,
                            kind: TripKind::Local,
                        });
                    }
                }
            }
        }
    }
    plans.extend(through_traffic(city, p, seed, &attr, &access));
    plans
}

fn through_traffic(
    city: &City,
    p: &Params,
    seed: u64,
    attr: &[f64],
    access: &[Access],
) -> Vec<Plan> {
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
            let v = p
                .param(&format!("through.vehicles_per_h.{c}"))
                .map_or(0.0, |q| q.value);
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
                if access[j].usable() {
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
                match dest_node(&access[rng.pick_cumulative(&zone_cum)], node, &mut rng) {
                    Some(d) => d,
                    None => continue,
                }
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
    let access = zone_access(city, p);
    let mut acc = 0.0;
    let cum: Vec<f64> = city
        .zones
        .iter()
        .enumerate()
        .map(|(j, z)| {
            if access[j].usable() {
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
            let j = rng.pick_cumulative(&cum);
            let z = &city.zones[j];
            let origin = access[j].origin(&mut rng);
            if origin == dest {
                continue;
            }
            let arrive = arrive_from + ((arrive_to - arrive_from) as f64 * rng.f64()) as TimeMs;
            // Rough travel-time guess: 1.3 × straight distance at 15 km/h.
            let est = ((z.x - d.x).hypot(z.y - d.y) * 1.3 / (15.0 / 3.6) * 1000.0) as TimeMs;
            plans.push(Plan {
                origin,
                dest,
                depart_ms: ((arrive - est).max(0) / 1000) * 1000,
                vtype: vt,
                kind: TripKind::Event,
            });
        }
    }
    plans
}
