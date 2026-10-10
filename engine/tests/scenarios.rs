//! Engine/scenario integration tests on a small synthetic city bundle.

use std::sync::{Arc, OnceLock};

use hanoi_engine::scenario::{Engine, RunOutput, Scenario};
use hanoi_engine::Bundle;
use serde_json::{json, Value};

const N: usize = 7;
const STEP_DEG: f64 = 0.003; // ≈ 310–330 m
const LON0: f64 = 105.83;
const LAT0: f64 = 21.02;
const MAIN_ROW: usize = 3;
const MAIN_COL: usize = 3;

fn node_id(r: usize, c: usize) -> usize {
    r * N + c
}

/// 7×7 grid; row 3 and column 3 are primary roads crossing at a signal, the rest
/// residential. Every node has a zone. Directed links in both directions.
fn bundle_json() -> Value {
    let mut nodes = Vec::new();
    for r in 0..N {
        for c in 0..N {
            nodes.push(json!({
                "lon": LON0 + c as f64 * STEP_DEG,
                "lat": LAT0 + r as f64 * STEP_DEG,
                "signal": r == MAIN_ROW && c == MAIN_COL,
            }));
        }
    }
    let mut links = Vec::new();
    let mut add = |a: usize, b: usize, class: &str, len: f64, name: String| {
        for (f, t) in [(a, b), (b, a)] {
            links.push(
                json!({"from": f, "to": t, "length_m": len, "road_class": class,
                              "lanes": if class == "primary" {2.0} else {1.0}, "name": name}),
            );
        }
    };
    for r in 0..N {
        for c in 0..N {
            if c + 1 < N {
                let class = if r == MAIN_ROW {
                    "primary"
                } else {
                    "residential"
                };
                add(
                    node_id(r, c),
                    node_id(r, c + 1),
                    class,
                    325.0,
                    format!("Row {r}"),
                );
            }
            if r + 1 < N {
                let class = if c == MAIN_COL {
                    "primary"
                } else {
                    "residential"
                };
                add(
                    node_id(r, c),
                    node_id(r + 1, c),
                    class,
                    335.0,
                    format!("Col {c}"),
                );
            }
        }
    }
    let zones: Vec<Value> = (0..N * N)
        .map(|i| {
            let (r, c) = (i / N, i % N);
            json!({"lon": LON0 + c as f64 * STEP_DEG, "lat": LAT0 + r as f64 * STEP_DEG,
                   "node": i, "population": 6000.0,
                   "poi": {"work": if r == N - 1 { 20.0 } else { 1.0 }, "school": 1.0}})
        })
        .collect();
    // Hotspot: the main row's links next to the crossing.
    let hot: Vec<usize> = links
        .iter()
        .enumerate()
        .filter(|(_, l)| {
            let (f, t) = (
                l["from"].as_u64().unwrap() as usize,
                l["to"].as_u64().unwrap() as usize,
            );
            l["road_class"] == "primary"
                && (f == node_id(MAIN_ROW, MAIN_COL) || t == node_id(MAIN_ROW, MAIN_COL))
        })
        .map(|(i, _)| i)
        .collect();
    let all: Vec<usize> = (0..links.len()).collect();
    json!({
        "version": 1, "name": "toy-grid",
        "bbox": [LON0, LAT0, LON0 + (N - 1) as f64 * STEP_DEG, LAT0 + (N - 1) as f64 * STEP_DEG],
        "nodes": nodes, "links": links,
        "entries": [{"node": node_id(MAIN_ROW, 0), "road_class": "primary"}],
        "zones": zones,
        "hotspots": [{"id": "h1", "label": "crossing", "kind": "street", "links": hot}],
        "catchments": [{"id": "c1", "area_m2": 4.0e6, "links": all, "low_links": hot}],
    })
}

fn engine() -> &'static Engine {
    static E: OnceLock<Engine> = OnceLock::new();
    E.get_or_init(|| {
        let b = Bundle::from_json(&bundle_json().to_string()).unwrap();
        Engine::new(Arc::new(b), None, Some(4), &mut |_, _| {}).unwrap()
    })
}

fn run(sc: Value) -> RunOutput {
    let sc = Scenario::from_json(&sc.to_string()).unwrap();
    engine().run(&sc, &mut |_, _| {}).unwrap()
}

fn total_count(o: &RunOutput, link: usize) -> u32 {
    let nb = o.window.n_bins;
    o.link_count[link * nb..(link + 1) * nb].iter().sum()
}

fn busiest_link(o: &RunOutput) -> usize {
    (0..o.n_links).max_by_key(|&l| total_count(o, l)).unwrap()
}

fn assert_conserved(o: &RunOutput) {
    let s = &o.summary;
    assert_eq!(
        s.arrived + s.aborted + s.unfinished,
        s.trips_simulated,
        "{s:?}"
    );
}

#[test]
fn baseline_is_plausible() {
    let b = engine().baseline();
    let s = &b.summary;
    assert!(s.trips_simulated > 100, "{s:?}");
    assert_eq!(s.unfinished, 0);
    assert_eq!(s.iterations, 4);
    assert!(s.mean_trip_min > 1.0 && s.mean_trip_min < 120.0, "{s:?}");
    assert_conserved(b);
    assert!(!b.traces.is_empty());
}

#[test]
fn baseline_is_deterministic_and_routes_roundtrip() {
    let bundle = Arc::new(Bundle::from_json(&bundle_json().to_string()).unwrap());
    let e1 = Engine::new(bundle.clone(), None, Some(4), &mut |_, _| {}).unwrap();
    assert_eq!(
        e1.baseline(),
        engine().baseline(),
        "same seed → identical baseline"
    );
    let bin = e1.baseline_routes();
    let e2 = Engine::new(bundle, Some(&bin), Some(0), &mut |_, _| {}).unwrap();
    assert_eq!(e2.baseline().link_count, e1.baseline().link_count);
    assert_eq!(e2.baseline().summary.warnings, Vec::<String>::new());
}

#[test]
fn empty_scenario_equals_baseline() {
    let o = run(json!({"events": []}));
    let b = engine().baseline();
    assert_eq!(o.link_count, b.link_count);
    assert_eq!(o.summary.total_delay_veh_h, b.summary.total_delay_veh_h);
    assert_eq!(o.summary.mode, "sudden");
}

#[test]
fn closure_keeps_vehicles_off_the_link() {
    let b = engine().baseline();
    let l = busiest_link(b);
    let o = run(json!({"events": [{"type": "closure", "links": [l]}]}));
    assert_eq!(total_count(&o, l), 0);
    assert!(o.summary.reroutes > 0);
    assert_conserved(&o);
}

#[test]
fn incident_on_busy_link_adds_delay() {
    let b = engine().baseline();
    let l = busiest_link(b);
    let o = run(
        json!({"events": [{"type": "incident", "link": l, "from": "06:30",
                                   "to": "08:30", "capacity_factor": 0.1}]}),
    );
    assert!(o.summary.total_delay_veh_h > b.summary.total_delay_veh_h);
    assert_conserved(&o);
}

#[test]
fn storm_floods_hotspot_and_changes_behaviour() {
    let b = engine().baseline();
    let o = run(
        json!({"events": [{"type": "rain", "flood_model": "hotspots", "profile": [
        {"at": "06:00", "mm_per_hour": 20}, {"at": "06:30", "mm_per_hour": 90},
        {"at": "08:00", "mm_per_hour": 10}]}]}),
    );
    let s = &o.summary;
    assert!(s.flooded_links_max > 0);
    assert!(s.trips_cancelled > 0 && s.trips_delayed > 0, "{s:?}");
    assert!(o
        .flood
        .depth_cm
        .values()
        .any(|v| v.iter().any(|&d| d > 10.0)));
    assert!(o.rain_mm_h.iter().any(|&r| r >= 90.0));
    assert!(s.mean_trip_min > b.summary.mean_trip_min);
    assert_conserved(&o);

    let bucket = run(
        json!({"events": [{"type": "rain", "flood_model": "bucket", "profile": [
        {"at": "06:00", "mm_per_hour": 100}, {"at": "07:30", "mm_per_hour": 0}]}]}),
    );
    assert!(bucket.summary.flooded_links_max > 0);
}

#[test]
fn signal_retiming_changes_flows() {
    let b = engine().baseline();
    let node = MAIN_ROW * N + MAIN_COL;
    let o = run(
        json!({"events": [{"type": "signal", "node": node, "cycle_s": 90,
        "green_split": {"north_south": 0.2, "east_west": 0.8}}]}),
    );
    assert_ne!(o.link_count, b.link_count);
    assert_conserved(&o);
}

#[test]
fn big_event_adds_trips() {
    let o = run(
        json!({"events": [{"type": "event", "destination": [LAT0 + 0.009, LON0 + 0.009],
        "extra_trips": 20000, "arrive_between": ["07:30", "08:30"]}]}),
    );
    assert!(o.summary.event_trips > 100, "{:?}", o.summary);
    assert!(o.summary.trips_planned > engine().baseline().summary.trips_planned);
    assert_conserved(&o);
}

#[test]
fn removing_a_road_is_structural() {
    let b = engine().baseline();
    let l = busiest_link(b);
    let o = run(json!({"events": [{"type": "remove_road", "links": [l]}]}));
    assert_eq!(o.summary.mode, "structural");
    assert_eq!(o.removed_links, vec![l as u32]);
    assert_eq!(total_count(&o, l), 0);
    assert!(o.summary.iterations > 0);
    assert_conserved(&o);
}

#[test]
fn adding_a_road_and_housing() {
    let b = engine().baseline();
    let o = run(json!({"events": [
        {"type": "add_road", "from_node": 0, "to_node": N * N - 1, "road_class": "primary", "lanes": 2},
        {"type": "housing", "at": [LAT0, LON0 + 0.004], "population": 30000}]}));
    assert_eq!(o.added_links.len(), 2);
    assert_eq!(o.n_links, b.n_links + 2);
    assert!(o.summary.trips_planned > b.summary.trips_planned);
    assert_conserved(&o);
}

#[test]
fn population_scale_override() {
    let o = run(json!({"parameter_overrides": {"population.scale": 1.5}}));
    assert_eq!(o.summary.mode, "structural");
    assert!(o.summary.trips_planned > engine().baseline().summary.trips_planned);
}

#[test]
fn invalid_scenarios_are_rejected() {
    let e = engine();
    let bad = [
        json!({"parameter_overrides": {"no.such.param": 1}}),
        json!({"parameter_overrides": {"sample_fraction": 7}}),
        json!({"events": [{"type": "closure", "links": [999999]}]}),
        json!({"events": [{"type": "incident", "link": 0, "from": "08:00", "to": "07:00", "capacity_factor": 0.5}]}),
        json!({"events": [{"type": "rain", "profile": [{"at": "25:99", "mm_per_hour": 5}]}]}),
    ];
    for sc in bad {
        let s = Scenario::from_json(&sc.to_string());
        let r = s.and_then(|s| e.run(&s, &mut |_, _| {}));
        assert!(r.is_err(), "accepted {sc}");
    }
}

#[test]
fn shipped_scenarios_parse() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scenarios");
    let mut n = 0;
    for f in std::fs::read_dir(dir).unwrap() {
        let p = f.unwrap().path();
        if p.extension().is_some_and(|e| e == "json") {
            Scenario::from_json(&std::fs::read_to_string(&p).unwrap())
                .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            n += 1;
        }
    }
    assert!(n > 0);
}

/// Trips start and end at a zone's access nodes (homes along small streets, POIs),
/// weighted by their population / POI weight — not only at the zone's centre node.
#[test]
fn trips_use_zone_access_nodes() {
    use hanoi_engine::demandgen;
    use hanoi_engine::{City, Params};
    let mut b = bundle_json();
    // zone 0 sends all its residents from node 1 and receives all its visitors at node 7
    b["zones"][0]["access"] = json!([[1, 6000.0, 0.0], [7, 0.0, 50.0]]);
    let bundle = Arc::new(Bundle::from_json(&b.to_string()).unwrap());
    let p = Params::default();
    let city = City::build(bundle, &p, &[]).unwrap();
    let plans = demandgen::generate(&city, &p, 7);
    let count = |f: &dyn Fn(&demandgen::Plan) -> usize, n: usize| {
        plans.iter().filter(|t| f(t) == n).count()
    };
    let (o, d) = (
        |t: &demandgen::Plan| t.origin.idx(),
        |t: &demandgen::Plan| t.dest.idx(),
    );
    // zone 0's centre node is no longer an access point
    assert_eq!(count(&o, 0) + count(&d, 0), 0);
    // node 1 now carries zone 0's residents on top of its own zone's
    assert!(
        count(&o, 1) as f64 > 1.6 * count(&o, 2) as f64,
        "{} vs {}",
        count(&o, 1),
        count(&o, 2)
    );
    // node 7 (r1 c0) attracts zone 0's visitors on top of its own; node 8 (r1 c1) is its twin
    assert!(
        count(&d, 7) > count(&d, 8),
        "{} vs {}",
        count(&d, 7),
        count(&d, 8)
    );
}

/// Local-access estimate: zero on main roads, positive on the residential streets
/// that connect homes to them, and the volume grows towards the main road.
#[test]
fn local_access_estimate_on_small_streets() {
    use hanoi_engine::{City, Params};
    let bundle = Arc::new(Bundle::from_json(&bundle_json().to_string()).unwrap());
    let p = Params::default();
    let city = City::build(bundle, &p, &[]).unwrap();
    let vol = hanoi_engine::access::local_access_volume(&city, &p);
    assert_eq!(vol.len(), city.net.links().len());
    let link = |a: usize, b: usize| {
        city.net
            .links()
            .iter()
            .position(|l| l.from.idx() == a && l.to.idx() == b)
            .unwrap()
    };
    for (i, m) in city.meta.iter().enumerate() {
        if m.road_class == "primary" {
            assert_eq!(vol[i], 0.0);
        }
    }
    // row 0, columns 0→1→2→3 is the shortest way out to the main column 3 (975 m vs
    // 1005 m down to the main row): outbound volume accumulates towards the main road,
    // and the opposite direction carries the inbound trips home.
    let out: Vec<f32> = (0..3)
        .map(|c| vol[link(node_id(0, c), node_id(0, c + 1))])
        .collect();
    let inb: Vec<f32> = (0..3)
        .map(|c| vol[link(node_id(0, c + 1), node_id(0, c))])
        .collect();
    assert!(
        out[0] > 0.0 && out[1] > out[0] && out[2] > out[1],
        "{out:?}"
    );
    assert!(
        inb[0] > 0.0 && inb[1] > inb[0] && inb[2] > inb[1],
        "{inb:?}"
    );
    // and the run output carries it for the web
    assert_eq!(engine().baseline().access_volume, vol);
}
