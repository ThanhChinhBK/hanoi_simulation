//! En-route rerouting, aborts and closure nesting on a diamond network.
//!
//! ```text
//!            c
//!          ↗   ↘
//!  s → a  ——X——→ b → t
//! ```
//! Main route s→a, X (a→b), b→t; detour a→c→b.

mod common;
use common::*;
use hanoi_engine::*;
use std::sync::Arc;

struct Diamond {
    net: Arc<Network>,
    sa: LinkId,
    x: LinkId,
    ac: LinkId,
    cb: LinkId,
    bt: LinkId,
}

fn diamond() -> Diamond {
    let mut b = NetworkBuilder::new();
    let s = b.add_node(0.0, 0.0);
    let a = b.add_node(100.0, 0.0);
    let bb = b.add_node(300.0, 0.0);
    let c = b.add_node(200.0, 100.0);
    let t = b.add_node(400.0, 0.0);
    let sa = b.add_link(spec(s, a, 100.0, 10.0, 3600.0, None));
    let x = b.add_link(spec(a, bb, 200.0, 10.0, 3600.0, None));
    let ac = b.add_link(spec(a, c, 150.0, 10.0, 3600.0, None));
    let cb = b.add_link(spec(c, bb, 150.0, 10.0, 3600.0, None));
    let bt = b.add_link(spec(bb, t, 100.0, 10.0, 3600.0, None));
    Diamond {
        net: Arc::new(b.build().unwrap()),
        sa,
        x,
        ac,
        cb,
        bt,
    }
}

fn reroute_cfg(n: usize, informed: bool) -> RerouteConfig {
    RerouteConfig {
        informed: vec![informed; n],
        max_reroutes: 3,
        disruption_threshold: 0.5,
        expected: None,
        closure_visibility_m: 0.0,
    }
}

fn conserved(s: &Sim) {
    let c = s.counts();
    assert_eq!(c.departed, c.waiting + c.on_links + c.arrived + c.aborted);
}

#[test]
fn closed_link_is_detoured_on_arrival() {
    let d = diamond();
    let mut s = Sim::new(d.net.clone(), demand(trips(5, CAR, 1_000, &[d.sa, d.x, d.bt])), SimConfig::default()).unwrap();
    s.set_rerouting(reroute_cfg(5, false)).unwrap();
    s.schedule_closure(0, d.x, true).unwrap();
    run_checked(&mut s);
    check_log(&s);
    conserved(&s);
    assert_eq!(s.counts().arrived, 5);
    assert_eq!(s.counts().reroutes, 5);
    assert!(enters(s.log(), d.x).is_empty());
    assert_eq!(enters(s.log(), d.ac).len(), 5);
    for v in 0..5 {
        assert_eq!(s.vehicle_route(VehicleId(v)), &[d.sa, d.ac, d.cb, d.bt]);
    }
    // Detour: 15 + 15 + 10 s instead of 20 + 10 s, departing at 1 s.
    assert_eq!(arrivals(s.log())[0], secs(41));
}

#[test]
fn no_alternative_aborts_trip() {
    let d = diamond();
    let mut s = Sim::new(d.net.clone(), demand(trips(3, CAR, 0, &[d.sa, d.x, d.bt])), SimConfig::default()).unwrap();
    s.set_rerouting(reroute_cfg(3, false)).unwrap();
    s.schedule_closure(0, d.x, true).unwrap();
    s.schedule_closure(0, d.cb, true).unwrap();
    run_checked(&mut s);
    check_log(&s);
    conserved(&s);
    assert_eq!(s.counts().aborted, 3);
    assert_eq!(s.counts().arrived, 0);
}

#[test]
fn without_rerouting_vehicles_wait_for_closure_to_end() {
    let d = diamond();
    let mut s = Sim::new(d.net.clone(), demand(trips(1, CAR, 0, &[d.sa, d.x, d.bt])), SimConfig::default()).unwrap();
    s.schedule_closure(0, d.x, true).unwrap();
    s.schedule_closure(secs(100), d.x, false).unwrap();
    run_checked(&mut s);
    check_log(&s);
    assert_eq!(arrivals(s.log()), vec![secs(130)]);
    assert_eq!(s.counts().stuck_pushes, 0, "waiting for a closure is not gridlock");
}

#[test]
fn closures_nest() {
    let d = diamond();
    let mut s = Sim::new(d.net.clone(), demand(trips(1, CAR, 0, &[d.sa, d.x, d.bt])), SimConfig::default()).unwrap();
    // Two overlapping closures: [0, 100 s) and [50 s, 200 s) → closed until 200 s.
    s.schedule_closure(0, d.x, true).unwrap();
    s.schedule_closure(secs(50), d.x, true).unwrap();
    s.schedule_closure(secs(100), d.x, false).unwrap();
    s.schedule_closure(secs(200), d.x, false).unwrap();
    run_checked(&mut s);
    assert_eq!(arrivals(s.log()), vec![secs(230)]);
}

/// The detour branches off *upstream* of the incident (at s), so only informed
/// drivers can still take it; uninformed ones discover the slow link at a, where
/// there is no alternative left.
///
/// ```text
///  o → s → a ——X——→ b → t
///        ↘          ↗
///          c ——————
/// ```
#[test]
fn informed_driver_avoids_incident_before_reaching_it() {
    let mut b = NetworkBuilder::new();
    let o = b.add_node(-100.0, 0.0);
    let s0 = b.add_node(0.0, 0.0);
    let a = b.add_node(100.0, 0.0);
    let bb = b.add_node(300.0, 0.0);
    let c = b.add_node(150.0, -200.0);
    let t = b.add_node(400.0, 0.0);
    let os = b.add_link(spec(o, s0, 100.0, 10.0, 3600.0, None));
    let sa = b.add_link(spec(s0, a, 100.0, 10.0, 3600.0, None));
    let x = b.add_link(spec(a, bb, 200.0, 10.0, 3600.0, None));
    let sc = b.add_link(spec(s0, c, 250.0, 10.0, 3600.0, None));
    let cb = b.add_link(spec(c, bb, 250.0, 10.0, 3600.0, None));
    let bt = b.add_link(spec(bb, t, 100.0, 10.0, 3600.0, None));
    let net = Arc::new(b.build().unwrap());
    let route = [os, sa, x, bt];
    let run = |informed: bool| {
        let mut s = Sim::new(net.clone(), demand(trips(1, CAR, secs(1), &route)), SimConfig::default()).unwrap();
        s.set_rerouting(reroute_cfg(1, informed)).unwrap();
        // X slows to 10% speed (200 s instead of 20 s) before the trip starts.
        s.schedule_speed_factor(0, x, FactorSource::Incident, 0.1).unwrap();
        run_checked(&mut s);
        check_log(&s);
        (s.vehicle_route(VehicleId(0)).to_vec(), arrivals(s.log())[0])
    };
    let (r_inf, t_inf) = run(true);
    assert_eq!(r_inf, vec![os, sc, cb, bt]);
    assert_eq!(t_inf, secs(1 + 25 + 25 + 10));
    let (r_un, t_un) = run(false);
    assert_eq!(r_un, vec![os, sa, x, bt]);
    assert_eq!(t_un, secs(1 + 10 + 200 + 10));
}

#[test]
fn rerouting_is_deterministic() {
    let d = diamond();
    let mk = || {
        let ts: Vec<Trip> = (0..50).flat_map(|k| trips(1, MOTO, k * 400, &[d.sa, d.x, d.bt])).collect();
        let mut s = Sim::new(d.net.clone(), demand(ts), SimConfig::default()).unwrap();
        s.set_rerouting(reroute_cfg(50, true)).unwrap();
        s.schedule_closure(secs(5), d.x, true).unwrap();
        s.schedule_closure(secs(12), d.x, false).unwrap();
        s.run();
        s.log().to_vec()
    };
    assert_eq!(mk(), mk());
}

/// A closure right after a junction with no other exit traps drivers who only see
/// the next link; with signposting (visibility) they detour one junction earlier.
///
/// ```text
///  s → a → m ——Y(closed)——→ b → t      (m has no other exit)
///       ↘                  ↗
///         c ——————————————
/// ```
#[test]
fn signposted_closure_avoids_trap() {
    let mut b = NetworkBuilder::new();
    let s0 = b.add_node(-100.0, 0.0);
    let a = b.add_node(0.0, 0.0);
    let m = b.add_node(50.0, 0.0);
    let bb = b.add_node(300.0, 0.0);
    let c = b.add_node(150.0, -150.0);
    let t = b.add_node(400.0, 0.0);
    let sa = b.add_link(spec(s0, a, 100.0, 10.0, 3600.0, None));
    let am = b.add_link(spec(a, m, 50.0, 10.0, 3600.0, None));
    let y = b.add_link(spec(m, bb, 250.0, 10.0, 3600.0, None));
    let ac = b.add_link(spec(a, c, 220.0, 10.0, 3600.0, None));
    let cb = b.add_link(spec(c, bb, 220.0, 10.0, 3600.0, None));
    let bt = b.add_link(spec(bb, t, 100.0, 10.0, 3600.0, None));
    let net = Arc::new(b.build().unwrap());
    let run = |vis: f64| {
        let mut s = Sim::new(net.clone(), demand(trips(4, CAR, 0, &[sa, am, y, bt])), SimConfig::default()).unwrap();
        s.set_rerouting(RerouteConfig { closure_visibility_m: vis, ..reroute_cfg(4, false) }).unwrap();
        s.schedule_closure(0, y, true).unwrap();
        run_checked(&mut s);
        check_log(&s);
        conserved(&s);
        (s.counts(), s.vehicle_route(VehicleId(0)).to_vec())
    };
    let (c0, _) = run(0.0);
    assert_eq!(c0.aborted, 4, "trapped at m");
    let (c1, r1) = run(300.0);
    assert_eq!(c1.aborted, 0);
    assert_eq!(c1.arrived, 4);
    assert_eq!(r1, vec![sa, ac, cb, bt]);
}
