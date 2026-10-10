//! Local-access traffic estimate on small streets (ngõ, residential streets).
//!
//! The simulation runs a sample (e.g. 5%) of trips, so a typical alley with ~35
//! residents gets fewer than one simulated vehicle. This module estimates the
//! *expected* full-population volume on the small streets instead: every home's
//! morning trips are loaded onto the fastest free-flow path between the home and the
//! nearest main-street node (outbound), and every destination's trips onto the path
//! from the main network to it (inbound). Short-tour returns go the other way.
//! It is a static, deterministic estimate (no queues, no congestion), for display.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::bundle::City;
use crate::demandgen::{attraction, zone_access};
use crate::ids::{LinkId, NodeId};
use crate::params::Params;
use crate::units::TimeMs;

/// Road classes counted as local streets; any node touching another class is "main network".
pub const MINOR_CLASSES: [&str; 4] = ["service", "residential", "living_street", "unclassified"];

fn is_minor(class: &str) -> bool {
    MINOR_CLASSES.contains(&class.trim_end_matches("_link"))
}

/// Expected vehicles entering each link over the morning window, full population
/// scale, from local access only. Zero on main roads.
pub fn local_access_volume(city: &City, p: &Params) -> Vec<f32> {
    let net = &city.net;
    let n_links = net.links().len();
    let n_nodes = net.nodes().len();
    let usable = |l: LinkId| !city.is_removed(l);
    let mut main = vec![false; n_nodes];
    for (i, m) in city.meta.iter().enumerate() {
        let l = net.link(LinkId(i as u32));
        if !m.removed && !is_minor(&m.road_class) {
            main[l.from.idx()] = true;
            main[l.to.idx()] = true;
        }
    }
    let cost = |l: LinkId| -> TimeMs {
        let k = net.link(l);
        ((k.length_m * 1000.0 / k.free_speed_mps).ceil() as TimeMs).max(1)
    };
    // Multi-source searches from all main-network nodes: `out_next[v]` is the first
    // link of v's fastest path *to* the main network, `in_via[v]` the last link of the
    // fastest path *from* it.
    let search = |forward: bool| -> Vec<Option<LinkId>> {
        let mut dist = vec![TimeMs::MAX; n_nodes];
        let mut via = vec![None; n_nodes];
        let mut heap = BinaryHeap::new();
        for (i, &m) in main.iter().enumerate() {
            if m {
                dist[i] = 0;
                heap.push(Reverse((0, NodeId(i as u32))));
            }
        }
        while let Some(Reverse((d, u))) = heap.pop() {
            if d > dist[u.idx()] {
                continue;
            }
            let node = net.node(u);
            let links = if forward {
                &node.out_links
            } else {
                &node.in_links
            };
            for &l in links {
                if !usable(l) {
                    continue;
                }
                let v = if forward {
                    net.link(l).to
                } else {
                    net.link(l).from
                };
                let nd = d + cost(l);
                if nd < dist[v.idx()] {
                    dist[v.idx()] = nd;
                    via[v.idx()] = Some(l);
                    heap.push(Reverse((nd, v)));
                }
            }
        }
        via
    };
    let out_next = search(false);
    let in_via = search(true);

    // Expected trips leaving (out) and arriving (inn) at each node.
    let ret = p.get("trip_rate.return_share");
    let per_person =
        p.get("trip_rate.per_person_day") * p.get("trip_rate.am_window_share") / (1.0 + ret);
    let veh_per_trip = p.get("mode_share.motorbike") / p.get("occupancy.motorbike")
        + p.get("mode_share.car") / p.get("occupancy.car");
    let access = zone_access(city, p);
    let attr = attraction(city, p);
    let attr_total: f64 = attr
        .iter()
        .zip(&access)
        .filter(|(_, a)| !a.nodes.is_empty())
        .map(|(w, _)| w)
        .sum();
    let mut home = vec![0.0f64; n_nodes];
    let mut dest = vec![0.0f64; n_nodes];
    let mut total = 0.0;
    for (z, acc) in city.zones.iter().zip(&access) {
        let trips = z.population.max(0.0) * per_person * veh_per_trip;
        total += trips;
        let mut prev = 0.0;
        for (k, &n) in acc.nodes.iter().enumerate() {
            home[n.idx()] += trips * (acc.origin_cum[k] - prev);
            prev = acc.origin_cum[k];
        }
    }
    if attr_total > 0.0 {
        for (acc, &w) in access.iter().zip(&attr) {
            let mut prev = 0.0;
            for (k, &n) in acc.nodes.iter().enumerate() {
                let total_w = *acc.dest_cum.last().unwrap_or(&1.0);
                dest[n.idx()] += total * w / attr_total * (acc.dest_cum[k] - prev) / total_w;
                prev = acc.dest_cum[k];
            }
        }
    }

    let mut vol = vec![0.0f64; n_links];
    for v in 0..n_nodes {
        let (h, d) = (home[v], dest[v]);
        if h <= 0.0 && d <= 0.0 {
            continue;
        }
        let (out, inn) = (h + d * ret, d + h * ret);
        let mut cur = NodeId(v as u32);
        while !main[cur.idx()] {
            let Some(l) = out_next[cur.idx()] else { break };
            vol[l.idx()] += out;
            cur = net.link(l).to;
        }
        let mut cur = NodeId(v as u32);
        while !main[cur.idx()] {
            let Some(l) = in_via[cur.idx()] else { break };
            vol[l.idx()] += inn;
            cur = net.link(l).from;
        }
    }
    vol.into_iter().map(|x| x as f32).collect()
}
