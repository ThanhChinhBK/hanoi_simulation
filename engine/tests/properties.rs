//! Property tests on random grid networks with random demand.

mod common;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use common::*;
use hanoi_engine::routing::{free_flow_ms, shortest_route};
use hanoi_engine::*;
use proptest::prelude::*;

#[derive(Debug, Clone)]
struct Case {
    n: usize,
    /// (length, speed, capacity PCU/h, storage PCU) per directed link, cycled.
    link_params: Vec<(f64, f64, f64, f64)>,
    /// (origin link idx, dest link idx, depart s, is motorbike)
    trips: Vec<(usize, usize, i64, bool)>,
    stuck_s: i64,
}

fn case() -> impl Strategy<Value = Case> {
    (2usize..5, 1i64..120).prop_flat_map(|(n, stuck_s)| {
        let link_params = prop::collection::vec(
            (20.0f64..300.0, 3.0f64..20.0, 300.0f64..3600.0, 0.5f64..6.0),
            1..16,
        );
        let trips = prop::collection::vec(
            (0usize..1000, 0usize..1000, 0i64..300, any::<bool>()),
            1..120,
        );
        (Just(n), link_params, trips, Just(stuck_s)).prop_map(|(n, link_params, trips, stuck_s)| {
            Case {
                n,
                link_params,
                trips,
                stuck_s,
            }
        })
    })
}

/// n×n grid, bidirectional links. Storage is set explicitly (often tiny) to force spillback.
fn build(c: &Case) -> (Arc<Network>, Arc<Demand>, SimConfig) {
    let mut b = NetworkBuilder::new();
    let id = |x: usize, y: usize| NodeId((y * c.n + x) as u32);
    for y in 0..c.n {
        for x in 0..c.n {
            b.add_node(x as f64, y as f64);
        }
    }
    let mut k = 0;
    let mut add = |b: &mut NetworkBuilder, from, to| {
        let (len, sp, cap, st) = c.link_params[k % c.link_params.len()];
        k += 1;
        b.add_link(spec(from, to, len, sp, cap, Some(st)));
    };
    for y in 0..c.n {
        for x in 0..c.n {
            if x + 1 < c.n {
                add(&mut b, id(x, y), id(x + 1, y));
                add(&mut b, id(x + 1, y), id(x, y));
            }
            if y + 1 < c.n {
                add(&mut b, id(x, y), id(x, y + 1));
                add(&mut b, id(x, y + 1), id(x, y));
            }
        }
    }
    let net = Arc::new(b.build().unwrap());
    let nl = net.links().len();
    let trips = c
        .trips
        .iter()
        .map(|&(o, d, dep, moto)| {
            let (o, d) = (LinkId((o % nl) as u32), LinkId((d % nl) as u32));
            let route = shortest_route(&net, o, d, |l| free_flow_ms(&net, l, 50.0))
                .expect("grid is connected");
            Trip {
                vehicle_type: if moto { MOTO } else { CAR },
                depart_ms: secs(dep),
                route,
            }
        })
        .collect();
    let cfg = SimConfig {
        stuck_threshold_ms: secs(c.stuck_s),
        ..SimConfig::default()
    };
    (net, demand(trips), cfg)
}

fn log_hash(sim: &Sim) -> u64 {
    let mut h = DefaultHasher::new();
    sim.log().hash(&mut h);
    h.finish()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 200, ..ProptestConfig::default() })]

    /// Conservation and state consistency after every event; FIFO, storage and
    /// free-flow bounds from the log; every vehicle arrives (liveness via the breaker).
    #[test]
    fn invariants_hold_and_everyone_arrives(c in case()) {
        let (net, dem, cfg) = build(&c);
        let n = dem.trips.len();
        let mut sim = Sim::new(net, dem, cfg).unwrap();
        run_checked(&mut sim);
        check_log(&sim);
        prop_assert_eq!(sim.counts().arrived, n);
        prop_assert_eq!(sim.counts().on_links + sim.counts().waiting, 0);
    }

    /// Same input → identical event log.
    #[test]
    fn deterministic(c in case()) {
        let (net, dem, cfg) = build(&c);
        let mut a = Sim::new(net.clone(), dem.clone(), cfg.clone()).unwrap();
        let mut b = Sim::new(net, dem, cfg).unwrap();
        a.run();
        b.run();
        prop_assert_eq!(log_hash(&a), log_hash(&b));
        prop_assert_eq!(a.log(), b.log());
    }

    /// Little's law per link, L = λ·W: the time-average number of vehicles on the link
    /// (sampled from engine state every second) equals throughput × mean time on link
    /// (from the log). The window starts and ends empty, so only sampling error remains.
    #[test]
    fn littles_law_per_link(c in case()) {
        let (net, dem, cfg) = build(&c);
        let nl = net.links().len();
        let mut sim = Sim::new(net, dem, cfg).unwrap();
        let dt = 1_000;
        let mut area = vec![0i64; nl];
        let mut t = 0;
        while !sim.is_finished() {
            sim.run_until(t);
            for (l, a) in area.iter_mut().enumerate() {
                *a += sim.link_occupancy(LinkId(l as u32)) as i64 * dt;
            }
            t += dt;
        }
        let mut time_on = vec![0i64; nl];
        let mut entries = vec![0i64; nl];
        for e in sim.log() {
            match *e {
                SimEvent::LinkEnter { t, link, .. } => { time_on[link.idx()] -= t; entries[link.idx()] += 1; }
                SimEvent::LinkLeave { t, link, .. } => time_on[link.idx()] += t,
                _ => {}
            }
        }
        for l in 0..nl {
            // Each visit can be mis-measured by at most one sample interval.
            let tol = entries[l] * dt;
            prop_assert!((area[l] - time_on[l]).abs() <= tol,
                "link {}: sampled {} vs log {} (entries {})", l, area[l], time_on[l], entries[l]);
        }
    }
}
