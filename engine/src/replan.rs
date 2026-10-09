//! Routing of planned trips, iterative replanning, and compact route storage.

use std::collections::BTreeMap;

use crate::bundle::City;
use crate::demandgen::Plan;
use crate::ids::LinkId;
use crate::routing::{astar, tree};
use crate::traveltime::TravelTimes;
use crate::units::TimeMs;

/// Trips departing from the same node within this window share one shortest-path tree.
pub const ROUTE_BIN_MS: TimeMs = 15 * 60_000;
/// Groups smaller than this are routed point-to-point with A* instead of a full tree.
const TREE_MIN_GROUP: usize = 4;

pub type Routes = Vec<Option<Vec<LinkId>>>;

/// Expected time to drive `route` (after its origin link) departing at `t0`.
pub fn route_cost(city: &City, tt: &TravelTimes, route: &[LinkId], t0: TimeMs) -> Option<TimeMs> {
    let mut t = t0;
    for &l in route.iter().skip(1) {
        if city.is_removed(l) {
            return None;
        }
        t += (tt.get(l, t).ceil() as TimeMs).max(1);
    }
    Some(t - t0)
}

/// (Re)route the plans in `which` using expected travel times `tt`. Removed links are
/// never used. A route is `[origin link, path...]`; None if the destination is unreachable.
///
/// `switch_gain`: an existing (valid) route is kept unless the new one is expected to
/// be faster by more than this share — an indifference band that damps oscillation
/// between iterations (0 = always take the current best).
pub fn route_plans(
    city: &City,
    plans: &[Plan],
    which: &[usize],
    tt: &TravelTimes,
    routes: &mut Routes,
    switch_gain: f64,
) {
    let set = |i: usize, new: Option<Vec<LinkId>>, routes: &mut Routes| {
        if switch_gain > 0.0 {
            if let (Some(old), Some(nr)) = (&routes[i], &new) {
                let p = &plans[i];
                if route_valid(city, p, old) {
                    let co = route_cost(city, tt, old, p.depart_ms);
                    let cn = route_cost(city, tt, nr, p.depart_ms);
                    if let (Some(co), Some(cn)) = (co, cn) {
                        if cn as f64 >= co as f64 * (1.0 - switch_gain) {
                            return;
                        }
                    }
                }
            }
        }
        routes[i] = new;
    };
    let cost = |l: LinkId, t: TimeMs| -> Option<TimeMs> {
        if city.is_removed(l) {
            None
        } else {
            Some((tt.get(l, t).ceil() as TimeMs).max(1))
        }
    };
    let mut groups: BTreeMap<(u32, TimeMs), Vec<usize>> = BTreeMap::new();
    for &i in which {
        let p = &plans[i];
        groups
            .entry((p.origin.0, p.depart_ms.div_euclid(ROUTE_BIN_MS)))
            .or_default()
            .push(i);
    }
    for ((_, _), idx) in groups {
        let p0 = plans[idx[0]];
        let Some(first) = city.origin_link[p0.origin.idx()] else {
            for i in idx {
                routes[i] = None;
            }
            continue;
        };
        let make = |path: Option<Vec<LinkId>>| -> Option<Vec<LinkId>> {
            let path = path.filter(|p| !p.is_empty())?;
            let mut r = Vec::with_capacity(path.len() + 1);
            r.push(first);
            r.extend(path);
            Some(r)
        };
        if idx.len() >= TREE_MIN_GROUP {
            let t0 = idx.iter().map(|&i| plans[i].depart_ms).min().unwrap_or(0);
            let tr = tree(&city.net, p0.origin, t0, cost);
            for i in idx {
                set(i, make(tr.path_to(&city.net, plans[i].dest)), routes);
            }
        } else {
            for i in idx {
                let p = &plans[i];
                set(i, make(astar(&city.net, p.origin, p.dest, p.depart_ms, cost)), routes);
            }
        }
    }
}

/// Is a stored route still valid in this city (links exist, contiguous, not removed,
/// starts at the plan origin and ends at its destination)?
pub fn route_valid(city: &City, plan: &Plan, route: &[LinkId]) -> bool {
    let net = &city.net;
    let n = net.links().len();
    route.len() >= 2
        && route.iter().all(|l| l.idx() < n && !city.is_removed(*l))
        && net.link(route[0]).to == plan.origin
        && net.link(*route.last().unwrap()).to == plan.dest
        && route.windows(2).all(|w| net.link(w[0]).to == net.link(w[1]).from)
}

/// FNV-1a hash of the plans, to check that stored routes belong to this demand.
pub fn plans_hash(plans: &[Plan], n_links: usize) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |x: u64| {
        for b in x.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    };
    eat(n_links as u64);
    eat(plans.len() as u64);
    for p in plans {
        eat(p.origin.0 as u64);
        eat(p.dest.0 as u64);
        eat(p.depart_ms as u64);
        eat(p.vtype.0 as u64);
        eat(p.kind as u64);
    }
    h
}

const MAGIC: &[u8; 4] = b"HSR1";

/// Compact binary routes: first link id (u32) then, for each next link, its index
/// among the out-links of the previous link's end node (u8). ~1 byte per link.
pub fn encode_routes(city: &City, hash: u64, routes: &Routes) -> Vec<u8> {
    let net = &city.net;
    let mut out = Vec::with_capacity(16 + routes.len() * 40);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&hash.to_le_bytes());
    out.extend_from_slice(&(routes.len() as u32).to_le_bytes());
    for r in routes {
        match r {
            None => out.extend_from_slice(&u32::MAX.to_le_bytes()),
            Some(r) => {
                out.extend_from_slice(&r[0].0.to_le_bytes());
                out.extend_from_slice(&((r.len() - 1) as u16).to_le_bytes());
                for w in r.windows(2) {
                    let outs = &net.node(net.link(w[0]).to).out_links;
                    let k = outs.iter().position(|&l| l == w[1]).expect("contiguous route");
                    out.push(u8::try_from(k).expect("out-degree < 256"));
                }
            }
        }
    }
    out
}

pub fn decode_routes(city: &City, bytes: &[u8]) -> Result<(u64, Routes), String> {
    let net = &city.net;
    let err = || "corrupt routes file".to_string();
    if bytes.len() < 16 || &bytes[..4] != MAGIC {
        return Err("not a routes file".into());
    }
    let mut pos = 4;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let s = bytes.get(pos..pos + n).ok_or_else(err)?;
        pos += n;
        Ok(s)
    };
    let hash = u64::from_le_bytes(take(8)?.try_into().unwrap());
    let n = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
    let mut routes = Vec::with_capacity(n);
    for _ in 0..n {
        let first = u32::from_le_bytes(take(4)?.try_into().unwrap());
        if first == u32::MAX {
            routes.push(None);
            continue;
        }
        if first as usize >= net.links().len() {
            return Err(err());
        }
        let len = u16::from_le_bytes(take(2)?.try_into().unwrap()) as usize;
        let mut r = Vec::with_capacity(len + 1);
        r.push(LinkId(first));
        for &k in take(len)? {
            let outs = &net.node(net.link(*r.last().unwrap()).to).out_links;
            r.push(*outs.get(k as usize).ok_or_else(err)?);
        }
        routes.push(Some(r));
    }
    Ok((hash, routes))
}
