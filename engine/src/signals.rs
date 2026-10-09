//! Fixed-time signals as capacity factors: each approach gets its green share of
//! the cycle (minus lost time). Approaches are grouped into two phases by direction
//! (north–south vs east–west), which is enough for comparative what-if questions.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::bundle::City;
use crate::ids::{LinkId, NodeId};
use crate::params::Params;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GreenSplit {
    pub north_south: f64,
    pub east_west: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignalPlan {
    pub cycle_s: f64,
    pub green_split: GreenSplit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    NorthSouth,
    EastWest,
}

/// Phase of an approach (in-link) by its overall direction of travel.
pub fn approach_phase(city: &City, l: LinkId) -> Phase {
    let link = city.net.link(l);
    let (a, b) = (city.net.node(link.from), city.net.node(link.to));
    if (b.y - a.y).abs() >= (b.x - a.x).abs() {
        Phase::NorthSouth
    } else {
        Phase::EastWest
    }
}

/// Default plan: green split proportional to approach capacity, within [0.3, 0.7].
pub fn default_plan(city: &City, params: &Params, n: NodeId) -> SignalPlan {
    let (mut ns, mut ew) = (0.0, 0.0);
    for &l in &city.net.node(n).in_links {
        if city.is_removed(l) {
            continue;
        }
        let cap = city.net.link(l).flow_capacity_pcu_per_h;
        match approach_phase(city, l) {
            Phase::NorthSouth => ns += cap,
            Phase::EastWest => ew += cap,
        }
    }
    let share = if ns + ew > 0.0 { (ns / (ns + ew)).clamp(0.3, 0.7) } else { 0.5 };
    SignalPlan {
        cycle_s: params.get("signal.cycle_s"),
        green_split: GreenSplit {
            north_south: share,
            east_west: 1.0 - share,
        },
    }
}

/// Capacity factor per approach link of every signalised node.
pub fn signal_factors(
    city: &City,
    params: &Params,
    overrides: &BTreeMap<NodeId, SignalPlan>,
) -> Result<Vec<(LinkId, f64)>, String> {
    let lost = params.get("signal.lost_time_s");
    let mut out = Vec::new();
    for n in city.net.nodes() {
        let plan = match overrides.get(&n.id) {
            Some(p) => *p,
            None if city.signal[n.id.idx()] => default_plan(city, params, n.id),
            None => continue,
        };
        if !(plan.cycle_s > lost) {
            return Err(format!("signal at node {}: cycle must exceed lost time", n.id.0));
        }
        let g = plan.green_split;
        let total = g.north_south + g.east_west;
        if !(g.north_south >= 0.0 && g.east_west >= 0.0 && total > 0.0) {
            return Err(format!("signal at node {}: invalid green split", n.id.0));
        }
        let phases: Vec<Phase> = n.in_links.iter().map(|&l| approach_phase(city, l)).collect();
        let both = phases.contains(&Phase::NorthSouth) && phases.contains(&Phase::EastWest);
        let eff = (plan.cycle_s - lost) / plan.cycle_s;
        for (&l, ph) in n.in_links.iter().zip(phases) {
            let share = if !both {
                1.0
            } else if ph == Phase::NorthSouth {
                g.north_south / total
            } else {
                g.east_west / total
            };
            out.push((l, (share * eff).max(0.0)));
        }
    }
    Ok(out)
}
