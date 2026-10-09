//! Throughput check: `cargo run --release --example bench_grid -- [grid_n] [trips]`

use std::sync::Arc;
use std::time::Instant;

use hanoi_engine::routing::{free_flow_ms, shortest_route};
use hanoi_engine::*;

fn main() {
    let args: Vec<usize> = std::env::args()
        .skip(1)
        .map(|a| a.parse().unwrap())
        .collect();
    let n = *args.first().unwrap_or(&40);
    let n_trips = *args.get(1).unwrap_or(&200_000);

    let mut b = NetworkBuilder::new();
    let id = |x: usize, y: usize| NodeId((y * n + x) as u32);
    for y in 0..n {
        for x in 0..n {
            b.add_node(x as f64 * 200.0, y as f64 * 200.0);
        }
    }
    let link = |from, to| LinkSpec {
        from,
        to,
        length_m: 200.0,
        free_speed_mps: 11.0,
        lanes: 2.0,
        flow_capacity_pcu_per_h: 1800.0,
        storage_pcu: None,
    };
    for y in 0..n {
        for x in 0..n {
            if x + 1 < n {
                b.add_link(link(id(x, y), id(x + 1, y)));
                b.add_link(link(id(x + 1, y), id(x, y)));
            }
            if y + 1 < n {
                b.add_link(link(id(x, y), id(x, y + 1)));
                b.add_link(link(id(x, y + 1), id(x, y)));
            }
        }
    }
    let net = Arc::new(b.build().unwrap());
    let nl = net.links().len() as u64;

    // Deterministic pseudo-random OD pairs (SplitMix64).
    let mut state = 42u64;
    let mut rnd = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    let t0 = Instant::now();
    let trips: Vec<Trip> = (0..n_trips)
        .map(|_| {
            let o = LinkId((rnd() % nl) as u32);
            let d = LinkId((rnd() % nl) as u32);
            let moto = rnd() % 10 < 8;
            Trip {
                vehicle_type: VehicleTypeId(moto as u32),
                depart_ms: (rnd() % 3_600_000) as i64,
                route: shortest_route(&net, o, d, |l| free_flow_ms(&net, l, 50.0)).unwrap(),
            }
        })
        .collect();
    let route_s = t0.elapsed().as_secs_f64();
    let demand = Arc::new(Demand {
        vehicle_types: vec![VehicleType::car(), VehicleType::motorbike()],
        trips,
    });

    let mut sim = Sim::new(net.clone(), demand, SimConfig::default()).unwrap();
    let t1 = Instant::now();
    let mut steps = 0u64;
    while sim.step() {
        steps += 1;
    }
    let sim_s = t1.elapsed().as_secs_f64();
    let c = sim.counts();
    println!(
        "grid {n}x{n} ({nl} links), {n_trips} trips | routing {route_s:.2}s | sim {sim_s:.2}s, \
         {steps} internal events ({:.1} M/s), {} log events | arrived {} stuck {} | end t={:.0}s",
        steps as f64 / sim_s / 1e6,
        sim.log().len(),
        c.arrived,
        c.stuck_pushes,
        sim.now() as f64 / 1000.0
    );
}
