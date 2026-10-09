//! Toy networks with hand-computed answers. Times in ms.

mod common;
use common::*;
use hanoi_engine::*;

fn sim(net: &std::sync::Arc<Network>, trips: Vec<Trip>, cfg: SimConfig) -> Sim {
    Sim::new(net.clone(), demand(trips), cfg).unwrap()
}

/// T1: one vehicle, free flow. Starts at end of A, travels B (500 m @ 10 m/s).
#[test]
fn t1_single_link_free_flow() {
    let (net, l) = chain(&[(100.0, 10.0, 3600.0, None), (500.0, 10.0, 3600.0, None)]);
    let mut s = sim(&net, trips(1, CAR, 0, &l), SimConfig::default());
    run_checked(&mut s);
    check_log(&s);
    assert_eq!(arrivals(s.log()), vec![secs(50)]);
}

/// T2: single bottleneck (deterministic queue). 10 cars, B capacity 0.5 PCU/s, ff 10 s.
/// A releases one car every 0.1 s; B exits at 10 + 2k s; C adds 10 s.
#[test]
fn t2_single_bottleneck() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 1_800.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mut s = sim(&net, trips(10, CAR, 0, &l), SimConfig::default());
    run_checked(&mut s);
    check_log(&s);
    let expect_b: Vec<TimeMs> = (0..10).map(|k| secs(10 + 2 * k)).collect();
    assert_eq!(leaves(s.log(), l[1]), expect_b);
    let expect_arr: Vec<TimeMs> = (0..10).map(|k| secs(20 + 2 * k)).collect();
    assert_eq!(arrivals(s.log()), expect_arr);
}

/// T3: spillback chain A -> B -> C -> D. C is the bottleneck (0.5/s), B and C hold 2 PCU.
/// Hand-traced: B fills, then A is blocked and its outflow drops to C's rate.
#[test]
fn t3_spillback_chain() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (10.0, 10.0, 36_000.0, Some(2.0)),
        (10.0, 10.0, 1_800.0, Some(2.0)),
        (10.0, 10.0, 36_000.0, None),
    ]);
    let mut s = sim(&net, trips(10, CAR, 0, &l), SimConfig::default());
    run_checked(&mut s);
    check_log(&s);
    let expect_a = vec![
        0, 100, 1_000, 1_100, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000,
    ];
    assert_eq!(leaves(s.log(), l[0]), expect_a, "A outflow");
    let expect_arr: Vec<TimeMs> = (0..10).map(|k| secs(3 + 2 * k)).collect();
    assert_eq!(arrivals(s.log()), expect_arr);
    assert_eq!(max_occupancy(s.log(), l[1]), 2);
    assert_eq!(max_occupancy(s.log(), l[2]), 2);
    assert_eq!(s.counts().stuck_pushes, 0);
}

/// T4: merge fairness. In-links with capacity 1/s and 2/s compete for a downstream
/// bottleneck (one slot every 2 s). Shares must be 1:2.
#[test]
fn t4_merge_fairness() {
    let mut b = NetworkBuilder::new();
    let (s1, s2, m, x, y, z) = (
        b.add_node(-1.0, 1.0),
        b.add_node(-1.0, -1.0),
        b.add_node(0.0, 0.0),
        b.add_node(1.0, 0.0),
        b.add_node(2.0, 0.0),
        b.add_node(3.0, 0.0),
    );
    let a1 = b.add_link(spec(s1, m, 1000.0, 10.0, 3_600.0, None));
    let a2 = b.add_link(spec(s2, m, 1000.0, 10.0, 7_200.0, None));
    let bl = b.add_link(spec(m, x, 10.0, 10.0, 36_000.0, Some(1.0)));
    let cl = b.add_link(spec(x, y, 10.0, 10.0, 1_800.0, Some(1.0)));
    let dl = b.add_link(spec(y, z, 10.0, 10.0, 36_000.0, None));
    let net = std::sync::Arc::new(b.build().unwrap());
    let mut t = trips(60, CAR, 0, &[a1, bl, cl, dl]);
    t.extend(trips(60, CAR, 0, &[a2, bl, cl, dl]));
    let mut s = sim(&net, t, SimConfig::default());
    run_checked(&mut s);
    check_log(&s);
    let order: Vec<LinkId> = s
        .log()
        .iter()
        .filter_map(|e| match e {
            SimEvent::LinkLeave { link, .. } if *link == a1 || *link == a2 => Some(*link),
            _ => None,
        })
        .take(60)
        .collect();
    let n1 = order.iter().filter(|&&l| l == a1).count() as i64;
    let n2 = order.iter().filter(|&&l| l == a2).count() as i64;
    assert!(
        (n1 - 20).abs() <= 1 && (n2 - 40).abs() <= 1,
        "shares a1={n1} a2={n2}"
    );
}

/// T5: diverge with head-of-line blocking + closure semantics.
/// v0 wants closed B, v1 wants open C, both queue on A. v1 waits behind v0 until B reopens.
#[test]
fn t5_diverge_head_of_line_blocking() {
    let mut b = NetworkBuilder::new();
    let (o, m, x, y) = (
        b.add_node(0.0, 0.0),
        b.add_node(1.0, 0.0),
        b.add_node(2.0, 1.0),
        b.add_node(2.0, -1.0),
    );
    let a = b.add_link(spec(o, m, 100.0, 10.0, 36_000.0, None));
    let bl = b.add_link(spec(m, x, 100.0, 10.0, 36_000.0, None));
    let cl = b.add_link(spec(m, y, 100.0, 10.0, 36_000.0, None));
    let net = std::sync::Arc::new(b.build().unwrap());
    let mut t = trips(1, CAR, 0, &[a, bl]);
    t.extend(trips(1, CAR, 0, &[a, cl]));
    let mut s = sim(&net, t, SimConfig::default());
    s.schedule_closure(0, bl, true).unwrap();
    s.schedule_closure(secs(30), bl, false).unwrap();
    run_checked(&mut s);
    check_log(&s);
    assert_eq!(enters(s.log(), bl), vec![secs(30)]);
    assert_eq!(enters(s.log(), cl), vec![secs(30) + 100]);
    assert_eq!(
        s.counts().stuck_pushes,
        0,
        "closures must not trigger the gridlock breaker"
    );
}

/// T6: signal as capacity scaling. Green share 0.4 on 1 PCU/s → one car per 2.5 s.
#[test]
fn t6_signal_green_share() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 3_600.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mut s = sim(&net, trips(10, CAR, 0, &l), SimConfig::default());
    s.schedule_capacity_factor(0, l[1], FactorSource::Signal, 0.4)
        .unwrap();
    run_checked(&mut s);
    check_log(&s);
    let out = leaves(s.log(), l[1]);
    assert_eq!(out[0], secs(10));
    assert!(out.windows(2).all(|w| w[1] - w[0] == 2_500), "{out:?}");
}

/// T7a: incident halves capacity between 20 s and 40 s.
#[test]
fn t7_incident_window() {
    let (net, l) = chain(&[
        (1000.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 3_600.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mut s = sim(&net, trips(100, CAR, 0, &l), SimConfig::default());
    s.schedule_capacity_factor(secs(20), l[1], FactorSource::Incident, 0.5)
        .unwrap();
    s.schedule_capacity_factor(secs(40), l[1], FactorSource::Incident, 1.0)
        .unwrap();
    run_checked(&mut s);
    check_log(&s);
    let out = leaves(s.log(), l[1]);
    let count = |a: i64, b: i64| out.iter().filter(|&&t| t >= secs(a) && t < secs(b)).count();
    assert_eq!(count(10, 20), 10);
    assert_eq!(count(20, 40), 10);
    assert_eq!(count(40, 50), 10);
}

/// T7b: a closure stops entries but vehicles already on the link can leave.
#[test]
fn t7_closure_lets_vehicles_leave() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mut t = trips(1, CAR, 0, &l);
    t.extend(trips(1, CAR, secs(5), &l));
    let mut s = sim(&net, t, SimConfig::default());
    s.schedule_closure(secs(3), l[1], true).unwrap();
    s.run_until(secs(60));
    // v0 entered B at 0 (before closure) and arrives; v1 is held on A.
    assert_eq!(arrivals(s.log()), vec![secs(20)]);
    assert_eq!(s.link_occupancy(l[0]), 1);
    s.schedule_closure(secs(60), l[1], false).unwrap();
    run_checked(&mut s);
    check_log(&s);
    assert_eq!(arrivals(s.log()), vec![secs(20), secs(80)]);
}

/// T8: circular gridlock. A ring of 4 one-car links, each full, every head wants the
/// next (full) ring link, then exits the ring. Nothing moves until the breaker fires at
/// the threshold; after that the ring drains with no further pushes.
#[test]
fn t8_gridlock_breaker() {
    let mut b = NetworkBuilder::new();
    let n: Vec<NodeId> = (0..4).map(|i| b.add_node(i as f64, 0.0)).collect();
    let out: Vec<NodeId> = (0..4).map(|i| b.add_node(i as f64, 1.0)).collect();
    let ring: Vec<LinkId> = (0..4)
        .map(|i| b.add_link(spec(n[i], n[(i + 1) % 4], 10.0, 10.0, 3_600.0, Some(1.0))))
        .collect();
    let exit: Vec<LinkId> = (0..4)
        .map(|i| b.add_link(spec(n[i], out[i], 10.0, 10.0, 3_600.0, None)))
        .collect();
    let net = std::sync::Arc::new(b.build().unwrap());
    let t: Vec<Trip> = (0..4)
        .map(|i| Trip {
            vehicle_type: CAR,
            depart_ms: 0,
            route: vec![ring[i], ring[(i + 1) % 4], exit[(i + 2) % 4]],
        })
        .collect();
    let cfg = SimConfig {
        stuck_threshold_ms: secs(10),
        ..SimConfig::default()
    };
    let mut s = sim(&net, t, cfg);
    s.run_until(secs(10) - 1);
    assert_eq!(s.counts().on_links, 4);
    assert!(
        ring.iter().all(|&l| leaves(s.log(), l).is_empty()),
        "deadlocked before threshold"
    );
    run_checked(&mut s);
    check_log(&s);
    assert_eq!(s.counts().arrived, 4);
    let stuck: Vec<(TimeMs, VehicleId)> = s
        .log()
        .iter()
        .filter_map(|e| match *e {
            SimEvent::Stuck { t, vehicle, .. } => Some((t, vehicle)),
            _ => None,
        })
        .collect();
    assert!(!stuck.is_empty() && stuck.len() <= 4, "{stuck:?}");
    assert!(stuck.iter().all(|&(t, _)| t == secs(10)), "{stuck:?}");
    // Whoever was not pushed moved normally into the space the pushes freed.
    assert!(
        stuck.len() < 4,
        "at least one vehicle should move without a push"
    );
}

/// T9: PCU. Link B holds 1 PCU and C is closed. Rule: a vehicle may enter while
/// used < storage. 4 motorbikes (0.25) fit, the 5th does not; only 1 car fits.
#[test]
fn t9_pcu_storage() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (10.0, 10.0, 36_000.0, Some(1.0)),
        (100.0, 10.0, 36_000.0, None),
    ]);
    for (vt, n, fits) in [(MOTO, 6, 4), (CAR, 3, 1)] {
        let mut s = sim(&net, trips(n, vt, 0, &l), SimConfig::default());
        s.schedule_closure(0, l[2], true).unwrap();
        s.run_until(secs(30));
        s.check_invariants().unwrap();
        assert_eq!(s.link_occupancy(l[1]), fits, "{vt:?}");
        check_log(&s);
    }
}

/// T10: sampling. f = 0.1 with 1/10 of the vehicles reproduces the bottleneck delays.
#[test]
fn t10_sampling_scales_capacity() {
    let (net, l) = chain(&[
        (10_000.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 1_800.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mean_arrival = |n: usize, f: f64| {
        let mut s = sim(
            &net,
            trips(n, CAR, 0, &l),
            SimConfig {
                sample_fraction: f,
                ..SimConfig::default()
            },
        );
        run_checked(&mut s);
        check_log(&s);
        let a = arrivals(s.log());
        assert_eq!(a.len(), n);
        a.iter().sum::<i64>() as f64 / n as f64
    };
    let full = mean_arrival(1000, 1.0);
    let sampled = mean_arrival(100, 0.1);
    assert!(
        (full - sampled).abs() / full < 0.02,
        "full={full} sampled={sampled}"
    );
}

/// Motorbikes leave 4x as often as cars through the same bottleneck (PCU in flow capacity).
#[test]
fn motorbikes_use_quarter_capacity() {
    let (net, l) = chain(&[
        (100.0, 10.0, 36_000.0, None),
        (100.0, 10.0, 3_600.0, None),
        (100.0, 10.0, 36_000.0, None),
    ]);
    let mut s = sim(&net, trips(8, MOTO, 0, &l), SimConfig::default());
    run_checked(&mut s);
    let out = leaves(s.log(), l[1]);
    assert!(out.windows(2).all(|w| w[1] - w[0] == 250), "{out:?}");
}

#[test]
fn invalid_route_is_rejected() {
    let (net, l) = chain(&[(100.0, 10.0, 3600.0, None), (100.0, 10.0, 3600.0, None)]);
    let bad = vec![Trip {
        vehicle_type: CAR,
        depart_ms: 0,
        route: vec![l[1], l[0]],
    }];
    assert!(Sim::new(net, demand(bad), SimConfig::default()).is_err());
}

/// T11: a chain of very short links holding less than one vehicle each (common in
/// OSM after sampling) must still carry its flow capacity without queue build-up.
#[test]
fn t11_short_link_chain_keeps_capacity() {
    let mut links = vec![(100.0, 10.0, 36_000.0, None)];
    links.extend(std::iter::repeat_n((5.0, 10.0, 1_800.0, Some(0.5)), 20));
    let (net, l) = chain(&links);
    // 100 cars at 0.4 veh/s against a capacity of 0.5 veh/s.
    let ts: Vec<Trip> = (0..100)
        .flat_map(|k| trips(1, CAR, k * 2_500, &l))
        .collect();
    let mut s = sim(&net, ts, SimConfig::default());
    run_checked(&mut s);
    check_log(&s);
    let arr = arrivals(s.log());
    let last = *arr.last().unwrap();
    println!("last arrival {last} ms, stuck pushes {}", s.counts().stuck_pushes);
    assert!(last < secs(300), "last arrival {last}");
    assert_eq!(s.counts().stuck_pushes, 0);
}
