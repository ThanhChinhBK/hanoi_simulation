//! Static road network. Immutable once built; edits (new/removed roads) produce a new
//! `Network` via `NetworkBuilder`, so run state never points into a changing structure.

use serde::{Deserialize, Serialize};

use crate::ids::{LinkId, NodeId};
use crate::units::PCU_LENGTH_M;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeSpec {
    pub x: f64,
    pub y: f64,
}

/// Input description of a directed link.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkSpec {
    pub from: NodeId,
    pub to: NodeId,
    pub length_m: f64,
    pub free_speed_mps: f64,
    pub lanes: f64,
    /// Max outflow in PCU per hour (full population, before sampling).
    pub flow_capacity_pcu_per_h: f64,
    /// Jam storage in PCU. `None` → `length × lanes / 7.5`, raised to at least
    /// `capacity × free-flow time` so a link can carry its capacity at free flow.
    #[serde(default)]
    pub storage_pcu: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: NodeId,
    pub x: f64,
    pub y: f64,
    /// Sorted by `LinkId`, so iteration order is deterministic.
    pub in_links: Vec<LinkId>,
    pub out_links: Vec<LinkId>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub id: LinkId,
    pub from: NodeId,
    pub to: NodeId,
    pub length_m: f64,
    pub free_speed_mps: f64,
    pub lanes: f64,
    pub flow_capacity_pcu_per_h: f64,
    /// Resolved jam storage in PCU (full population, before sampling).
    pub storage_pcu: f64,
}

impl Link {
    pub fn flow_capacity_pcu_per_s(&self) -> f64 {
        self.flow_capacity_pcu_per_h / 3600.0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Network {
    nodes: Vec<Node>,
    links: Vec<Link>,
    max_free_speed_mps: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NetworkError(pub String);

impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid network: {}", self.0)
    }
}
impl std::error::Error for NetworkError {}

impl Network {
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }
    pub fn links(&self) -> &[Link] {
        &self.links
    }
    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.idx()]
    }
    pub fn link(&self, id: LinkId) -> &Link {
        &self.links[id.idx()]
    }
    /// Highest free speed of any link (for admissible A* heuristics).
    pub fn max_free_speed_mps(&self) -> f64 {
        self.max_free_speed_mps
    }
    /// Straight-line distance between two nodes (node coordinates are metres).
    pub fn node_dist_m(&self, a: NodeId, b: NodeId) -> f64 {
        let (p, q) = (self.node(a), self.node(b));
        (p.x - q.x).hypot(p.y - q.y)
    }
}

#[derive(Default, Clone, Debug)]
pub struct NetworkBuilder {
    nodes: Vec<NodeSpec>,
    links: Vec<LinkSpec>,
}

impl NetworkBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, x: f64, y: f64) -> NodeId {
        self.nodes.push(NodeSpec { x, y });
        NodeId((self.nodes.len() - 1) as u32)
    }

    pub fn add_link(&mut self, spec: LinkSpec) -> LinkId {
        self.links.push(spec);
        LinkId((self.links.len() - 1) as u32)
    }

    pub fn build(self) -> Result<Network, NetworkError> {
        let n_nodes = self.nodes.len();
        let mut nodes: Vec<Node> = self
            .nodes
            .iter()
            .enumerate()
            .map(|(i, s)| Node {
                id: NodeId(i as u32),
                x: s.x,
                y: s.y,
                in_links: Vec::new(),
                out_links: Vec::new(),
            })
            .collect();

        let mut links = Vec::with_capacity(self.links.len());
        for (i, s) in self.links.into_iter().enumerate() {
            let id = LinkId(i as u32);
            let err = |m: &str| NetworkError(format!("link {i}: {m}"));
            if s.from.idx() >= n_nodes || s.to.idx() >= n_nodes {
                return Err(err("unknown node"));
            }
            if !(s.length_m > 0.0) || !(s.free_speed_mps > 0.0) || !(s.lanes > 0.0) {
                return Err(err("length, free speed and lanes must be > 0"));
            }
            if !(s.flow_capacity_pcu_per_h >= 0.0) {
                return Err(err("flow capacity must be >= 0"));
            }
            let storage_pcu = match s.storage_pcu {
                Some(v) if v > 0.0 => v,
                Some(_) => return Err(err("storage must be > 0")),
                None => {
                    let jam = s.length_m * s.lanes / PCU_LENGTH_M;
                    let ff_s = s.length_m / s.free_speed_mps;
                    jam.max(s.flow_capacity_pcu_per_h / 3600.0 * ff_s)
                }
            };
            nodes[s.from.idx()].out_links.push(id);
            nodes[s.to.idx()].in_links.push(id);
            links.push(Link {
                id,
                from: s.from,
                to: s.to,
                length_m: s.length_m,
                free_speed_mps: s.free_speed_mps,
                lanes: s.lanes,
                flow_capacity_pcu_per_h: s.flow_capacity_pcu_per_h,
                storage_pcu,
            });
        }
        let max_free_speed_mps = links
            .iter()
            .map(|l: &Link| l.free_speed_mps)
            .fold(1.0, f64::max);
        Ok(Network {
            nodes,
            links,
            max_free_speed_mps,
        })
    }
}
