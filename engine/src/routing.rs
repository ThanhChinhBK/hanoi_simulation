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

/// Result of a time-dependent one-to-all search from a node.
pub struct Tree {
    pub start: NodeId,
    /// Arrival time at each node (TimeMs::MAX = unreachable).
    pub arrival: Vec<TimeMs>,
    pub via: Vec<Option<LinkId>>,
}

impl Tree {
    /// Links from the tree root to `n` (empty if `n` is the root); None if unreachable.
    pub fn path_to(&self, net: &Network, n: NodeId) -> Option<Vec<LinkId>> {
        if self.arrival[n.idx()] == TimeMs::MAX {
            return None;
        }
        let mut rev = Vec::new();
        let mut cur = n;
        while cur != self.start {
            let l = self.via[cur.idx()]?;
            rev.push(l);
            cur = net.link(l).from;
        }
        rev.reverse();
        Some(rev)
    }
}

/// Time-dependent Dijkstra from `start` departing at `t0`. `cost(link, t_enter)` returns
/// the traversal time, or None if the link is unusable. Assumes FIFO costs.
pub fn tree(
    net: &Network,
    start: NodeId,
    t0: TimeMs,
    cost: impl Fn(LinkId, TimeMs) -> Option<TimeMs>,
) -> Tree {
    let n = net.nodes().len();
    let mut arrival = vec![TimeMs::MAX; n];
    let mut via: Vec<Option<LinkId>> = vec![None; n];
    let mut heap = BinaryHeap::new();
    arrival[start.idx()] = t0;
    heap.push(Reverse((t0, start)));
    while let Some(Reverse((t, u))) = heap.pop() {
        if t > arrival[u.idx()] {
            continue;
        }
        for &l in &net.node(u).out_links {
            let Some(c) = cost(l, t) else { continue };
            let v = net.link(l).to;
            let nt = t + c;
            if nt < arrival[v.idx()] {
                arrival[v.idx()] = nt;
                via[v.idx()] = Some(l);
                heap.push(Reverse((nt, v)));
            }
        }
    }
    Tree {
        start,
        arrival,
        via,
    }
}

/// Time-dependent A* from node `from` (at `t0`) to node `to`. The heuristic is
/// straight-line distance at the network's top free speed, so costs must be >=
/// free-flow time for optimality. Returns the list of links (empty if from == to).
pub fn astar(
    net: &Network,
    from: NodeId,
    to: NodeId,
    t0: TimeMs,
    cost: impl Fn(LinkId, TimeMs) -> Option<TimeMs>,
) -> Option<Vec<LinkId>> {
    if from == to {
        return Some(Vec::new());
    }
    let vmax = net.max_free_speed_mps();
    let h = |n: NodeId| (net.node_dist_m(n, to) * 1000.0 / vmax) as TimeMs;
    SCRATCH.with(|sc| {
        let mut sc = sc.borrow_mut();
        sc.reset(net.nodes().len());
        let mut heap = BinaryHeap::new();
        sc.set(from, t0, None);
        heap.push(Reverse((t0 + h(from), t0, from)));
        while let Some(Reverse((_, t, u))) = heap.pop() {
            if t > sc.g(u) {
                continue;
            }
            if u == to {
                let mut rev = Vec::new();
                let mut cur = to;
                while let Some(l) = sc.via[cur.idx()] {
                    rev.push(l);
                    cur = net.link(l).from;
                }
                rev.reverse();
                return Some(rev);
            }
            for &l in &net.node(u).out_links {
                let Some(c) = cost(l, t) else { continue };
                let v = net.link(l).to;
                let nt = t + c;
                if nt < sc.g(v) {
                    sc.set(v, nt, Some(l));
                    heap.push(Reverse((nt + h(v), nt, v)));
                }
            }
        }
        None
    })
}

/// Per-thread A* state, reused across searches: an entry is valid only if its stamp
/// equals the current search's generation (avoids clearing O(nodes) per search).
#[derive(Default)]
struct Scratch {
    gen: u32,
    stamp: Vec<u32>,
    g: Vec<TimeMs>,
    via: Vec<Option<LinkId>>,
}

impl Scratch {
    fn reset(&mut self, n: usize) {
        if self.stamp.len() != n || self.gen == u32::MAX {
            *self = Scratch {
                gen: 0,
                stamp: vec![0; n],
                g: vec![0; n],
                via: vec![None; n],
            };
        }
        self.gen += 1;
    }
    fn g(&self, n: NodeId) -> TimeMs {
        if self.stamp[n.idx()] == self.gen {
            self.g[n.idx()]
        } else {
            TimeMs::MAX
        }
    }
    fn set(&mut self, n: NodeId, g: TimeMs, via: Option<LinkId>) {
        self.stamp[n.idx()] = self.gen;
        self.g[n.idx()] = g;
        self.via[n.idx()] = via;
    }
}

thread_local! {
    static SCRATCH: std::cell::RefCell<Scratch> = std::cell::RefCell::new(Scratch::default());
}
