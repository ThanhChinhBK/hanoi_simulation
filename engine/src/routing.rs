//! Shortest paths (Dijkstra) with deterministic tie-breaking.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::ids::{LinkId, NodeId};
use crate::network::Network;
use crate::units::TimeMs;

/// Free-flow travel time of a link in ms (rounded up).
pub fn free_flow_ms(net: &Network, link: LinkId, max_speed_mps: f64) -> TimeMs {
    let l = net.link(link);
    (l.length_m * 1000.0 / l.free_speed_mps.min(max_speed_mps)).ceil() as TimeMs
}

/// Route from the end of `origin` to the end of `dest`, as a list of links starting
/// with `origin` and ending with `dest`. Cost = `cost(link)` (must be >= 0).
/// Ties are broken by node id, so results are deterministic.
pub fn shortest_route(
    net: &Network,
    origin: LinkId,
    dest: LinkId,
    cost: impl Fn(LinkId) -> TimeMs,
) -> Option<Vec<LinkId>> {
    if origin == dest {
        return Some(vec![origin]);
    }
    let start = net.link(origin).to;
    let n = net.nodes().len();
    let mut dist = vec![TimeMs::MAX; n];
    let mut via: Vec<Option<LinkId>> = vec![None; n];
    let mut heap = BinaryHeap::new();
    dist[start.idx()] = 0;
    heap.push(Reverse((0, start)));
    let target = net.link(dest).from;
    while let Some(Reverse((d, u))) = heap.pop() {
        if d > dist[u.idx()] {
            continue;
        }
        if u == target {
            break;
        }
        for &l in &net.node(u).out_links {
            let v: NodeId = net.link(l).to;
            let nd = d + cost(l);
            if nd < dist[v.idx()] {
                dist[v.idx()] = nd;
                via[v.idx()] = Some(l);
                heap.push(Reverse((nd, v)));
            }
        }
    }
    if dist[target.idx()] == TimeMs::MAX {
        return None;
    }
    let mut rev = vec![dest];
    let mut cur = target;
    while cur != start {
        let l = via[cur.idx()]?;
        rev.push(l);
        cur = net.link(l).from;
    }
    rev.push(origin);
    rev.reverse();
    Some(rev)
}
