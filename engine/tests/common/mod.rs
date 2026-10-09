#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use hanoi_engine::*;

pub const CAR: VehicleTypeId = VehicleTypeId(0);
pub const MOTO: VehicleTypeId = VehicleTypeId(1);

/// Link shorthand: length m, speed m/s, capacity PCU/h, optional storage PCU.
pub fn spec(
    from: NodeId,
    to: NodeId,
    len: f64,
    speed: f64,
    cap_h: f64,
    storage: Option<f64>,
) -> LinkSpec {
    LinkSpec {
        from,
        to,
        length_m: len,
        free_speed_mps: speed,
        lanes: 1.0,
        flow_capacity_pcu_per_h: cap_h,
        storage_pcu: storage,
    }
}

/// A straight chain of links: node0 -> node1 -> ... ; returns (network, link ids).
pub fn chain(links: &[(f64, f64, f64, Option<f64>)]) -> (Arc<Network>, Vec<LinkId>) {
    let mut b = NetworkBuilder::new();
    let mut prev = b.add_node(0.0, 0.0);
    let mut ids = Vec::new();
    for (i, &(len, speed, cap, st)) in links.iter().enumerate() {
        let next = b.add_node((i + 1) as f64, 0.0);
        ids.push(b.add_link(spec(prev, next, len, speed, cap, st)));
        prev = next;
    }
    (Arc::new(b.build().unwrap()), ids)
}

pub fn vehicle_types() -> Vec<VehicleType> {
    vec![VehicleType::car(), VehicleType::motorbike()]
}

pub fn trips(n: usize, vt: VehicleTypeId, depart_ms: TimeMs, route: &[LinkId]) -> Vec<Trip> {
    (0..n)
        .map(|_| Trip {
            vehicle_type: vt,
            depart_ms,
            route: route.to_vec(),
        })
        .collect()
}

pub fn demand(trips: Vec<Trip>) -> Arc<Demand> {
    Arc::new(Demand {
        vehicle_types: vehicle_types(),
        trips,
    })
}

/// Run to completion, checking internal invariants after every event.
pub fn run_checked(sim: &mut Sim) {
    let mut steps = 0u64;
    while sim.step() {
        steps += 1;
        assert!(steps < 50_000_000, "runaway simulation");
        if let Err(e) = sim.check_invariants() {
            panic!("invariant violated at t={}: {e}", sim.now());
        }
    }
}

pub fn times_of(log: &[SimEvent], pred: impl Fn(&SimEvent) -> bool) -> Vec<TimeMs> {
    log.iter().filter(|e| pred(e)).map(|e| e.time()).collect()
}

pub fn leaves(log: &[SimEvent], link: LinkId) -> Vec<TimeMs> {
    times_of(
        log,
        |e| matches!(e, SimEvent::LinkLeave { link: l, .. } if *l == link),
    )
}

pub fn enters(log: &[SimEvent], link: LinkId) -> Vec<TimeMs> {
    times_of(
        log,
        |e| matches!(e, SimEvent::LinkEnter { link: l, .. } if *l == link),
    )
}

pub fn arrivals(log: &[SimEvent]) -> Vec<TimeMs> {
    times_of(log, |e| matches!(e, SimEvent::Arrive { .. }))
}

pub fn max_occupancy(log: &[SimEvent], link: LinkId) -> usize {
    let (mut occ, mut max) = (0i64, 0i64);
    for e in log {
        match e {
            SimEvent::LinkEnter { link: l, .. } if *l == link => occ += 1,
            SimEvent::LinkLeave { link: l, .. } if *l == link => occ -= 1,
            _ => {}
        }
        max = max.max(occ);
    }
    max as usize
}

/// Replays the output log and checks model invariants independently of engine state:
/// - time is non-decreasing
/// - per-link FIFO (leave order == enter order)
/// - storage: a non-forced entry only happens when used < storage
/// - nobody leaves a link faster than free flow (except their origin link)
/// - every vehicle departs once and arrives at most once
pub fn check_log(sim: &Sim) {
    let log = sim.log();
    let n_links = sim.network().links().len();
    let mut queues: Vec<std::collections::VecDeque<(VehicleId, TimeMs, bool)>> =
        vec![Default::default(); n_links];
    let mut used: Vec<MilliPcu> = vec![0; n_links];
    let mut departed = HashSet::new();
    let mut arrived = HashSet::new();
    let mut forced_next: Option<(VehicleId, LinkId)> = None;
    let mut last_t = TimeMs::MIN;
    let mut departing: HashMap<VehicleId, LinkId> = HashMap::new();

    for e in log {
        assert!(e.time() >= last_t, "time went backwards at {e:?}");
        last_t = e.time();
        match *e {
            SimEvent::Depart { vehicle, link, .. } => {
                assert!(departed.insert(vehicle), "double departure {vehicle:?}");
                departing.insert(vehicle, link);
            }
            SimEvent::Stuck {
                vehicle, next_link, ..
            } => forced_next = Some((vehicle, next_link)),
            SimEvent::LinkEnter { t, vehicle, link } => {
                let forced = forced_next.take() == Some((vehicle, link));
                if !forced {
                    assert!(
                        used[link.idx()] < sim.link_storage(link),
                        "storage exceeded on {link:?} at t={t}"
                    );
                }
                let is_origin = departing.get(&vehicle) == Some(&link);
                if is_origin {
                    departing.remove(&vehicle);
                }
                used[link.idx()] += sim.vehicle_pcu(vehicle);
                queues[link.idx()].push_back((vehicle, t, is_origin));
            }
            SimEvent::LinkLeave { t, vehicle, link } => {
                let (v, t_in, is_origin) = queues[link.idx()]
                    .pop_front()
                    .expect("leave from empty link");
                assert_eq!(v, vehicle, "FIFO violated on {link:?}");
                if !is_origin {
                    assert!(
                        t - t_in >= sim.free_flow_ms(link, vehicle),
                        "{vehicle:?} faster than free flow on {link:?}"
                    );
                }
                used[link.idx()] -= sim.vehicle_pcu(vehicle);
            }
            SimEvent::Arrive { vehicle, .. } => {
                assert!(arrived.insert(vehicle), "double arrival {vehicle:?}");
            }
            SimEvent::Abort { vehicle, .. } => {
                assert!(arrived.insert(vehicle), "aborted after arrival {vehicle:?}");
            }
        }
    }
}
