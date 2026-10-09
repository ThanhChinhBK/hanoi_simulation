//! Event-driven queue simulation.
//!
//! Each link is a FIFO queue. A vehicle may leave a link when
//! (1) its free-flow time on the link has elapsed,
//! (2) it is at the head of the queue,
//! (3) the link's flow-capacity "token" allows another exit, and
//! (4) the next link has storage space (or the gridlock breaker fires).
//! A full downstream link holds vehicles upstream → spillback.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, VecDeque};
use std::sync::Arc;

use crate::demand::Demand;
use crate::events::SimEvent;
use crate::ids::{LinkId, NodeId, VehicleId};
use crate::network::Network;
use crate::units::{milli_pcu, MilliPcu, TimeMs, US_PER_MS};

#[derive(Clone, Debug, PartialEq)]
pub struct SimConfig {
    /// Fraction f of the population simulated; capacities and storage are scaled by f.
    pub sample_fraction: f64,
    /// A head vehicle blocked by a full downstream link for this long is pushed through.
    pub stuck_threshold_ms: TimeMs,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            sample_fraction: 1.0,
            stuck_threshold_ms: 60_000,
        }
    }
}

/// Independent sources of capacity/speed modification. Factors multiply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FactorSource {
    Signal = 0,
    Incident = 1,
    Rain = 2,
    Flood = 3,
}
const N_SOURCES: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct SimError(pub String);

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "simulation error: {}", self.0)
    }
}
impl std::error::Error for SimError {}

/// Vehicle counts by state. Conservation: departed = waiting + on_links + arrived.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub not_departed: usize,
    pub departed: usize,
    pub waiting: usize,
    pub on_links: usize,
    pub arrived: usize,
    pub stuck_pushes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VehStatus {
    NotDeparted,
    Waiting,
    OnLink,
    Arrived,
}

#[derive(Clone, Debug)]
struct VehicleState {
    route_pos: usize,
    earliest_exit: TimeMs,
    pcu: MilliPcu,
    max_speed: f64,
    status: VehStatus,
}

#[derive(Clone, Debug)]
struct LinkState {
    queue: VecDeque<VehicleId>,
    /// Departing vehicles waiting to enter this (origin) link.
    waiting: VecDeque<VehicleId>,
    used: MilliPcu,
    storage: MilliPcu,
    /// Sampled base flow capacity, milli-PCU per second.
    base_cap: f64,
    cap_factors: [f64; N_SOURCES],
    speed_factors: [f64; N_SOURCES],
    closed: bool,
    /// Earliest time (µs) the next vehicle may exit (flow-capacity token).
    next_exit_us: i64,
    blocked_since: Option<TimeMs>,
}

impl LinkState {
    fn cap(&self) -> f64 {
        self.cap_factors.iter().fold(self.base_cap, |a, f| a * f)
    }
    fn speed_factor(&self) -> f64 {
        self.speed_factors.iter().product()
    }
    fn has_space(&self) -> bool {
        self.used < self.storage
    }
}

#[derive(Clone, Debug, Default)]
struct NodeState {
    /// Time of the live NodeUpdate event; older queued updates are stale.
    pending: Option<TimeMs>,
    /// Smooth-weighted-round-robin counters, one per in-link (fair merging).
    swrr: Vec<i64>,
}

#[derive(Clone, Copy, Debug)]
enum Action {
    Departure(VehicleId),
    NodeUpdate(NodeId),
    SetCapFactor {
        link: LinkId,
        source: FactorSource,
        factor: f64,
    },
    SetSpeedFactor {
        link: LinkId,
        source: FactorSource,
        factor: f64,
    },
    SetClosed {
        link: LinkId,
        closed: bool,
    },
}

#[derive(Debug)]
struct Scheduled {
    t: TimeMs,
    seq: u64,
    action: Action,
}
impl PartialEq for Scheduled {
    fn eq(&self, o: &Self) -> bool {
        (self.t, self.seq) == (o.t, o.seq)
    }
}
impl Eq for Scheduled {}
impl PartialOrd for Scheduled {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Scheduled {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.t, self.seq).cmp(&(o.t, o.seq))
    }
}

pub struct Sim {
    net: Arc<Network>,
    demand: Arc<Demand>,
    cfg: SimConfig,
    links: Vec<LinkState>,
    nodes: Vec<NodeState>,
    vehicles: Vec<VehicleState>,
    heap: BinaryHeap<Reverse<Scheduled>>,
    seq: u64,
    now: TimeMs,
    log: Vec<SimEvent>,
    counts: Counts,
}

impl Sim {
    pub fn new(net: Arc<Network>, demand: Arc<Demand>, cfg: SimConfig) -> Result<Self, SimError> {
        let f = cfg.sample_fraction;
        if !(f > 0.0 && f <= 1.0) {
            return Err(SimError("sample_fraction must be in (0, 1]".into()));
        }
        if cfg.stuck_threshold_ms <= 0 {
            return Err(SimError("stuck_threshold_ms must be > 0".into()));
        }
        for (i, vt) in demand.vehicle_types.iter().enumerate() {
            if !(vt.pcu > 0.0) || !(vt.max_speed_mps > 0.0) {
                return Err(SimError(format!(
                    "vehicle type {i}: pcu and max speed must be > 0"
                )));
            }
        }
        let mut vehicles = Vec::with_capacity(demand.trips.len());
        for (i, trip) in demand.trips.iter().enumerate() {
            let err = |m: &str| SimError(format!("trip {i}: {m}"));
            let vt = demand
                .vehicle_types
                .get(trip.vehicle_type.idx())
                .ok_or_else(|| err("unknown vehicle type"))?;
            if trip.route.is_empty() {
                return Err(err("empty route"));
            }
            if trip.route.iter().any(|l| l.idx() >= net.links().len()) {
                return Err(err("unknown link in route"));
            }
            if trip
                .route
                .windows(2)
                .any(|w| net.link(w[0]).to != net.link(w[1]).from)
            {
                return Err(err("route is not contiguous"));
            }
            vehicles.push(VehicleState {
                route_pos: 0,
                earliest_exit: 0,
                pcu: milli_pcu(vt.pcu),
                max_speed: vt.max_speed_mps,
                status: VehStatus::NotDeparted,
            });
        }

        let links = net
            .links()
            .iter()
            .map(|l| LinkState {
                queue: VecDeque::new(),
                waiting: VecDeque::new(),
                used: 0,
                storage: milli_pcu(l.storage_pcu * f),
                base_cap: l.flow_capacity_pcu_per_s() * f * 1000.0,
                cap_factors: [1.0; N_SOURCES],
                speed_factors: [1.0; N_SOURCES],
                closed: false,
                next_exit_us: i64::MIN,
                blocked_since: None,
            })
            .collect();
        let nodes = net
            .nodes()
            .iter()
            .map(|n| NodeState {
                pending: None,
                swrr: vec![0; n.in_links.len()],
            })
            .collect();

        let mut sim = Sim {
            counts: Counts {
                not_departed: demand.trips.len(),
                ..Counts::default()
            },
            net,
            demand: demand.clone(),
            cfg,
            links,
            nodes,
            vehicles,
            heap: BinaryHeap::new(),
            seq: 0,
            now: TimeMs::MIN,
            log: Vec::new(),
        };
        for (i, trip) in demand.trips.iter().enumerate() {
            sim.push(trip.depart_ms, Action::Departure(VehicleId(i as u32)));
        }
        Ok(sim)
    }

    // ---------------------------------------------------------------- public API

    pub fn now(&self) -> TimeMs {
        self.now
    }
    pub fn log(&self) -> &[SimEvent] {
        &self.log
    }
    pub fn counts(&self) -> Counts {
        self.counts
    }
    pub fn network(&self) -> &Network {
        &self.net
    }
    pub fn is_finished(&self) -> bool {
        self.heap.is_empty()
    }
    pub fn link_occupancy(&self, l: LinkId) -> usize {
        self.links[l.idx()].queue.len()
    }
    pub fn link_used_storage(&self, l: LinkId) -> MilliPcu {
        self.links[l.idx()].used
    }
    pub fn link_storage(&self, l: LinkId) -> MilliPcu {
        self.links[l.idx()].storage
    }
    pub fn vehicle_pcu(&self, v: VehicleId) -> MilliPcu {
        self.vehicles[v.idx()].pcu
    }
    /// Free-flow time of `v` on `l` under the link's current speed factors.
    pub fn free_flow_ms(&self, l: LinkId, v: VehicleId) -> TimeMs {
        let link = self.net.link(l);
        let speed = link.free_speed_mps.min(self.vehicles[v.idx()].max_speed)
            * self.links[l.idx()].speed_factor();
        (link.length_m * 1000.0 / speed).ceil() as TimeMs
    }

    /// Multiply the capacity of `link` by `factor` (from `source`) starting at `at`.
    pub fn schedule_capacity_factor(
        &mut self,
        at: TimeMs,
        link: LinkId,
        source: FactorSource,
        factor: f64,
    ) -> Result<(), SimError> {
        self.check_schedule(at, link)?;
        if !(factor >= 0.0) {
            return Err(SimError("capacity factor must be >= 0".into()));
        }
        self.push(
            at,
            Action::SetCapFactor {
                link,
                source,
                factor,
            },
        );
        Ok(())
    }

    /// Multiply free speed of `link` by `factor` for vehicles entering from `at`.
    pub fn schedule_speed_factor(
        &mut self,
        at: TimeMs,
        link: LinkId,
        source: FactorSource,
        factor: f64,
    ) -> Result<(), SimError> {
        self.check_schedule(at, link)?;
        if !(factor > 0.0) {
            return Err(SimError(
                "speed factor must be > 0 (use capacity 0 to stop flow)".into(),
            ));
        }
        self.push(
            at,
            Action::SetSpeedFactor {
                link,
                source,
                factor,
            },
        );
        Ok(())
    }

    /// Closed links accept no new vehicles; vehicles already on them may leave.
    pub fn schedule_closure(
        &mut self,
        at: TimeMs,
        link: LinkId,
        closed: bool,
    ) -> Result<(), SimError> {
        self.check_schedule(at, link)?;
        self.push(at, Action::SetClosed { link, closed });
        Ok(())
    }

    /// Process the next internal event. Returns false when nothing is left.
    pub fn step(&mut self) -> bool {
        let Some(Reverse(ev)) = self.heap.pop() else {
            return false;
        };
        debug_assert!(ev.t >= self.now);
        self.now = ev.t;
        match ev.action {
            Action::Departure(v) => self.on_departure(v),
            Action::NodeUpdate(n) => {
                if self.nodes[n.idx()].pending == Some(ev.t) {
                    self.nodes[n.idx()].pending = None;
                    self.node_update(n);
                }
            }
            Action::SetCapFactor {
                link,
                source,
                factor,
            } => {
                self.links[link.idx()].cap_factors[source as usize] = factor;
                self.wake_both_ends(link);
            }
            Action::SetSpeedFactor {
                link,
                source,
                factor,
            } => {
                self.links[link.idx()].speed_factors[source as usize] = factor;
            }
            Action::SetClosed { link, closed } => {
                self.links[link.idx()].closed = closed;
                self.wake_both_ends(link);
            }
        }
        true
    }

    pub fn run(&mut self) {
        while self.step() {}
    }

    /// Process all events with time <= `t`.
    pub fn run_until(&mut self, t: TimeMs) {
        while self.heap.peek().is_some_and(|Reverse(e)| e.t <= t) {
            self.step();
        }
        self.now = self.now.max(t);
    }

    /// Internal consistency checks (used by tests after every step).
    pub fn check_invariants(&self) -> Result<(), String> {
        let c = self.counts;
        let waiting: usize = self.links.iter().map(|l| l.waiting.len()).sum();
        let on_links: usize = self.links.iter().map(|l| l.queue.len()).sum();
        if waiting != c.waiting || on_links != c.on_links {
            return Err(format!(
                "count mismatch: {c:?} vs waiting={waiting} on_links={on_links}"
            ));
        }
        if c.departed != c.waiting + c.on_links + c.arrived {
            return Err(format!("conservation violated: {c:?}"));
        }
        if c.not_departed + c.departed != self.vehicles.len() {
            return Err(format!("vehicle total mismatch: {c:?}"));
        }
        for (i, l) in self.links.iter().enumerate() {
            let sum: MilliPcu = l.queue.iter().map(|v| self.vehicles[v.idx()].pcu).sum();
            if sum != l.used {
                return Err(format!("link {i}: used {} != sum of pcu {}", l.used, sum));
            }
            for v in &l.queue {
                let vs = &self.vehicles[v.idx()];
                let trip = &self.demand.trips[v.idx()];
                if vs.status != VehStatus::OnLink || trip.route[vs.route_pos].idx() != i {
                    return Err(format!("link {i}: vehicle {} in wrong state", v.0));
                }
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- internals

    fn check_schedule(&self, at: TimeMs, link: LinkId) -> Result<(), SimError> {
        if at < self.now {
            return Err(SimError(format!(
                "cannot schedule in the past ({at} < {})",
                self.now
            )));
        }
        if link.idx() >= self.links.len() {
            return Err(SimError(format!("unknown link {}", link.0)));
        }
        Ok(())
    }

    fn push(&mut self, t: TimeMs, action: Action) {
        self.heap.push(Reverse(Scheduled {
            t,
            seq: self.seq,
            action,
        }));
        self.seq += 1;
    }

    /// Ensure node `n` is updated at time `t` (or earlier).
    fn schedule_node(&mut self, n: NodeId, t: TimeMs) {
        let ns = &mut self.nodes[n.idx()];
        if matches!(ns.pending, Some(p) if p <= t) {
            return;
        }
        ns.pending = Some(t);
        self.push(t, Action::NodeUpdate(n));
    }

    fn wake_both_ends(&mut self, l: LinkId) {
        let link = self.net.link(l);
        let (from, to) = (link.from, link.to);
        self.schedule_node(to, self.now);
        self.schedule_node(from, self.now);
        self.admit_waiting(l);
    }

    fn route_link(&self, v: VehicleId, pos: usize) -> LinkId {
        self.demand.trips[v.idx()].route[pos]
    }

    fn is_last_link(&self, v: VehicleId) -> bool {
        self.vehicles[v.idx()].route_pos + 1 == self.demand.trips[v.idx()].route.len()
    }

    fn on_departure(&mut self, v: VehicleId) {
        let l = self.route_link(v, 0);
        self.vehicles[v.idx()].status = VehStatus::Waiting;
        self.counts.not_departed -= 1;
        self.counts.departed += 1;
        self.counts.waiting += 1;
        self.links[l.idx()].waiting.push_back(v);
        self.log.push(SimEvent::Depart {
            t: self.now,
            vehicle: v,
            link: l,
        });
        self.admit_waiting(l);
    }

    /// Move departing vehicles onto their origin link while it has space.
    /// They start at the END of the link (can leave immediately).
    fn admit_waiting(&mut self, l: LinkId) {
        while let Some(&v) = self.links[l.idx()].waiting.front() {
            if !self.links[l.idx()].has_space() {
                break;
            }
            self.links[l.idx()].waiting.pop_front();
            self.counts.waiting -= 1;
            self.enter_link(v, l, self.now);
        }
    }

    fn enter_link(&mut self, v: VehicleId, l: LinkId, earliest_exit: TimeMs) {
        let pcu = self.vehicles[v.idx()].pcu;
        let ls = &mut self.links[l.idx()];
        let was_empty = ls.queue.is_empty();
        ls.queue.push_back(v);
        ls.used += pcu;
        let vs = &mut self.vehicles[v.idx()];
        vs.earliest_exit = earliest_exit;
        vs.status = VehStatus::OnLink;
        self.counts.on_links += 1;
        self.log.push(SimEvent::LinkEnter {
            t: self.now,
            vehicle: v,
            link: l,
        });
        if was_empty {
            let to = self.net.link(l).to;
            self.schedule_node(to, earliest_exit);
        }
    }

    /// Remove the head of `l`; returns the vehicle.
    fn pop_head(&mut self, l: LinkId) -> VehicleId {
        let ls = &mut self.links[l.idx()];
        let v = ls.queue.pop_front().expect("pop_head on empty link");
        ls.used -= self.vehicles[v.idx()].pcu;
        ls.blocked_since = None;
        self.counts.on_links -= 1;
        self.log.push(SimEvent::LinkLeave {
            t: self.now,
            vehicle: v,
            link: l,
        });
        v
    }

    fn on_space_freed(&mut self, l: LinkId) {
        self.admit_waiting(l);
        let from = self.net.link(l).from;
        self.schedule_node(from, self.now);
    }

    /// Vehicles at the end of their route leave without using flow capacity.
    fn process_arrivals(&mut self, l: LinkId) {
        while let Some(&v) = self.links[l.idx()].queue.front() {
            if !self.is_last_link(v) || self.vehicles[v.idx()].earliest_exit > self.now {
                break;
            }
            self.pop_head(l);
            self.vehicles[v.idx()].status = VehStatus::Arrived;
            self.counts.arrived += 1;
            self.log.push(SimEvent::Arrive {
                t: self.now,
                vehicle: v,
                link: l,
            });
            self.on_space_freed(l);
        }
    }

    fn head_can_exit(&self, l: LinkId) -> bool {
        let ls = &self.links[l.idx()];
        let Some(&v) = ls.queue.front() else {
            return false;
        };
        !self.is_last_link(v)
            && self.vehicles[v.idx()].earliest_exit <= self.now
            && ls.cap() > 0.0
            && ls.next_exit_us <= self.now * US_PER_MS
    }

    /// Try to move the head of `l` onto its next link. Returns true if moved.
    fn try_move_head(&mut self, l: LinkId) -> bool {
        let v = *self.links[l.idx()].queue.front().expect("head");
        let next = self.route_link(v, self.vehicles[v.idx()].route_pos + 1);
        if self.links[next.idx()].closed {
            // Waiting for a closure is not gridlock; rerouting handles it (step 5).
            self.links[l.idx()].blocked_since = None;
            return false;
        }
        let forced = if self.links[next.idx()].has_space() {
            false
        } else {
            let since = *self.links[l.idx()].blocked_since.get_or_insert(self.now);
            if self.now - since < self.cfg.stuck_threshold_ms {
                return false;
            }
            true
        };

        if forced {
            self.counts.stuck_pushes += 1;
            self.log.push(SimEvent::Stuck {
                t: self.now,
                vehicle: v,
                link: l,
                next_link: next,
            });
        }
        let pcu = self.vehicles[v.idx()].pcu;
        let ls = &mut self.links[l.idx()];
        let headway_us = ((pcu as f64) * 1e6 / ls.cap()).ceil().max(1.0) as i64;
        ls.next_exit_us = ls.next_exit_us.max(self.now * US_PER_MS) + headway_us;
        self.pop_head(l);
        self.vehicles[v.idx()].route_pos += 1;
        let earliest = self.now + self.free_flow_ms(next, v);
        self.enter_link(v, next, earliest);
        self.on_space_freed(l);
        true
    }

    /// Fair merge: smooth weighted round-robin over candidates, weight = capacity.
    fn swrr_pick(&mut self, n: NodeId, cands: &[usize], in_links: &[LinkId]) -> usize {
        if cands.len() == 1 {
            return 0;
        }
        let weights: Vec<i64> = cands
            .iter()
            .map(|&c| (self.links[in_links[c].idx()].cap().round() as i64).max(1))
            .collect();
        let total: i64 = weights.iter().sum();
        let sw = &mut self.nodes[n.idx()].swrr;
        let mut best = 0;
        for (k, &c) in cands.iter().enumerate() {
            sw[c] += weights[k];
            if sw[c] > sw[cands[best]] {
                best = k;
            }
        }
        sw[cands[best]] -= total;
        best
    }

    fn node_update(&mut self, n: NodeId) {
        let net = Arc::clone(&self.net);
        let in_links = &net.node(n).in_links;
        for &l in in_links {
            self.process_arrivals(l);
        }
        let mut cands: Vec<usize> = (0..in_links.len())
            .filter(|&i| self.head_can_exit(in_links[i]))
            .collect();
        while !cands.is_empty() {
            let k = self.swrr_pick(n, &cands, in_links);
            let l = in_links[cands.remove(k)];
            if self.try_move_head(l) {
                self.process_arrivals(l);
            }
        }
        for &l in in_links {
            if let Some(t) = self.next_wake(l) {
                self.schedule_node(n, t);
            }
        }
    }

    /// When does the head of `l` next need attention at its downstream node?
    fn next_wake(&self, l: LinkId) -> Option<TimeMs> {
        let ls = &self.links[l.idx()];
        let &v = ls.queue.front()?;
        let vs = &self.vehicles[v.idx()];
        if self.is_last_link(v) {
            return (vs.earliest_exit > self.now).then_some(vs.earliest_exit);
        }
        if !(ls.cap() > 0.0) {
            return None; // woken by the capacity change
        }
        let token_ms = ls.next_exit_us.div_euclid(US_PER_MS)
            + i64::from(ls.next_exit_us.rem_euclid(US_PER_MS) != 0);
        let ready = vs.earliest_exit.max(token_ms);
        if ready > self.now {
            return Some(ready);
        }
        // Ready but blocked downstream: wake for the gridlock breaker (if not a closure).
        let next = self.route_link(v, vs.route_pos + 1);
        if self.links[next.idx()].closed {
            return None;
        }
        ls.blocked_since.map(|s| s + self.cfg.stuck_threshold_ms)
    }
}
