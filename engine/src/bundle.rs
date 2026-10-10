//! City bundle (produced by `pipeline/`) and the `City` model built from it:
//! bundle + parameters + structural edits → network, zones, signals.
//!
//! Link ids are stable across edits: removed roads stay in the network but are
//! permanently closed and unroutable; new roads are appended.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ids::{LinkId, NodeId};
use crate::network::{LinkSpec, Network, NetworkBuilder};
use crate::params::Params;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BNode {
    pub lon: f64,
    pub lat: f64,
    #[serde(default)]
    pub elev_m: f64,
    #[serde(default)]
    pub signal: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BLink {
    pub from: u32,
    pub to: u32,
    pub length_m: f64,
    pub road_class: String,
    #[serde(default)]
    pub lanes: Option<f64>,
    #[serde(default)]
    pub maxspeed_kmh: Option<f64>,
    #[serde(default)]
    pub oneway: bool,
    #[serde(default)]
    pub bridge: bool,
    #[serde(default)]
    pub tunnel: bool,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BZone {
    pub lon: f64,
    pub lat: f64,
    pub node: u32,
    pub population: f64,
    #[serde(default)]
    pub poi: BTreeMap<String, f64>,
    /// Street nodes where the zone's trips start and end: `[node, population, poi
    /// weight]`. Origins are drawn by population, destinations by POI weight (mixed
    /// with population). Empty = all trips use `node`.
    #[serde(default)]
    pub access: Vec<(u32, f64, f64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BEntry {
    pub node: u32,
    pub road_class: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BHotspot {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub links: Vec<u32>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub confidence: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BCatchment {
    pub id: String,
    pub area_m2: f64,
    pub links: Vec<u32>,
    pub low_links: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bundle {
    pub version: u32,
    pub name: String,
    pub bbox: [f64; 4],
    pub nodes: Vec<BNode>,
    pub links: Vec<BLink>,
    #[serde(default)]
    pub entries: Vec<BEntry>,
    #[serde(default)]
    pub zones: Vec<BZone>,
    #[serde(default)]
    pub hotspots: Vec<BHotspot>,
    #[serde(default)]
    pub catchments: Vec<BCatchment>,
}

impl Bundle {
    pub fn from_json(s: &str) -> Result<Self, String> {
        let b: Bundle = serde_json::from_str(s).map_err(|e| format!("bundle: {e}"))?;
        b.validate()?;
        Ok(b)
    }

    fn validate(&self) -> Result<(), String> {
        let n = self.nodes.len() as u32;
        let m = self.links.len() as u32;
        for (i, l) in self.links.iter().enumerate() {
            if l.from >= n || l.to >= n {
                return Err(format!("bundle link {i}: unknown node"));
            }
        }
        for (i, z) in self.zones.iter().enumerate() {
            if z.node >= n || z.access.iter().any(|a| a.0 >= n) {
                return Err(format!("bundle zone {i}: unknown node"));
            }
            if z.access.iter().any(|a| !(a.1 >= 0.0 && a.2 >= 0.0)) {
                return Err(format!("bundle zone {i}: negative access weight"));
            }
        }
        for h in &self.hotspots {
            if h.links.iter().any(|&l| l >= m) {
                return Err(format!("hotspot {}: unknown link", h.id));
            }
        }
        for c in &self.catchments {
            if c.links.iter().chain(&c.low_links).any(|&l| l >= m) {
                return Err(format!("catchment {}: unknown link", c.id));
            }
        }
        Ok(())
    }
}

/// Changes to the city itself (need replanning).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StructuralEdit {
    /// New road between two existing nodes (straight line).
    AddRoad {
        from_node: u32,
        to_node: u32,
        road_class: String,
        #[serde(default)]
        lanes: Option<f64>,
        #[serde(default)]
        oneway: bool,
        #[serde(default)]
        name: Option<String>,
    },
    RemoveRoad {
        links: Vec<u32>,
    },
    ModifyRoad {
        link: u32,
        #[serde(default)]
        lanes: Option<f64>,
        #[serde(default)]
        maxspeed_kmh: Option<f64>,
        #[serde(default)]
        road_class: Option<String>,
    },
    /// New housing: residents added to the nearest zone (or a new zone).
    Housing {
        /// [lat, lon]
        at: [f64; 2],
        population: f64,
    },
    /// New jobs (offices, a mall…): destination attraction at a location.
    Jobs {
        at: [f64; 2],
        jobs: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct LinkMeta {
    pub road_class: String,
    pub bridge: bool,
    pub tunnel: bool,
    pub removed: bool,
    pub added: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    pub node: NodeId,
    pub x: f64,
    pub y: f64,
    pub population: f64,
    pub poi: BTreeMap<String, f64>,
    /// Jobs added by users (converted with `attraction.jobs_per_poi`).
    pub extra_jobs: f64,
    /// `(node, population weight, attraction weight)`; see [`BZone::access`].
    pub access: Vec<(NodeId, f64, f64)>,
}

/// Bundle + parameters + edits, ready to simulate.
#[derive(Clone, Debug)]
pub struct City {
    pub bundle: Arc<Bundle>,
    pub net: Arc<Network>,
    pub meta: Vec<LinkMeta>,
    pub zones: Vec<Zone>,
    pub signal: Vec<bool>,
    /// Link a trip starting at this node begins on (trips start at a link's end): the
    /// highest-capacity in-link, standing in for all the zone's access streets.
    pub origin_link: Vec<Option<LinkId>>,
    pub lon0: f64,
    pub lat0: f64,
}

const M_PER_DEG_LAT: f64 = 110_540.0;
const M_PER_DEG_LON_EQ: f64 = 111_320.0;

impl City {
    pub fn build(bundle: Arc<Bundle>, params: &Params, edits: &[StructuralEdit]) -> Result<City, String> {
        let lon0 = (bundle.bbox[0] + bundle.bbox[2]) / 2.0;
        let lat0 = (bundle.bbox[1] + bundle.bbox[3]) / 2.0;
        let proj = |lon: f64, lat: f64| {
            (
                (lon - lon0) * M_PER_DEG_LON_EQ * lat0.to_radians().cos(),
                (lat - lat0) * M_PER_DEG_LAT,
            )
        };

        let mut links: Vec<BLink> = bundle.links.clone();
        let mut meta: Vec<LinkMeta> = links
            .iter()
            .map(|l| LinkMeta {
                road_class: l.road_class.clone(),
                bridge: l.bridge,
                tunnel: l.tunnel,
                removed: false,
                added: false,
            })
            .collect();
        let mut zones: Vec<Zone> = bundle
            .zones
            .iter()
            .map(|z| {
                let (x, y) = proj(z.lon, z.lat);
                Zone {
                    node: NodeId(z.node),
                    x,
                    y,
                    population: z.population,
                    poi: z.poi.clone(),
                    extra_jobs: 0.0,
                    access: z.access.iter().map(|&(n, a, b)| (NodeId(n), a, b)).collect(),
                }
            })
            .collect();
        let xy: Vec<(f64, f64)> = bundle.nodes.iter().map(|n| proj(n.lon, n.lat)).collect();
        let n_nodes = bundle.nodes.len() as u32;
        let check_link = |l: u32, n: usize| {
            if (l as usize) < n {
                Ok(())
            } else {
                Err(format!("edit refers to unknown link {l}"))
            }
        };

        for e in edits {
            match e {
                StructuralEdit::AddRoad {
                    from_node,
                    to_node,
                    road_class,
                    lanes,
                    oneway,
                    name,
                } => {
                    if *from_node >= n_nodes || *to_node >= n_nodes || from_node == to_node {
                        return Err("add_road: invalid nodes".into());
                    }
                    let (a, b) = (xy[*from_node as usize], xy[*to_node as usize]);
                    let len = (a.0 - b.0).hypot(a.1 - b.1).max(1.0);
                    let dirs: &[(u32, u32)] = if *oneway {
                        &[(*from_node, *to_node)]
                    } else {
                        &[(*from_node, *to_node), (*to_node, *from_node)]
                    };
                    for &(f, t) in dirs {
                        links.push(BLink {
                            from: f,
                            to: t,
                            length_m: len,
                            road_class: road_class.clone(),
                            lanes: *lanes,
                            maxspeed_kmh: None,
                            oneway: *oneway,
                            bridge: false,
                            tunnel: false,
                            name: name.clone().unwrap_or_else(|| "New road".into()),
                        });
                        meta.push(LinkMeta {
                            road_class: road_class.clone(),
                            bridge: false,
                            tunnel: false,
                            removed: false,
                            added: true,
                        });
                    }
                }
                StructuralEdit::RemoveRoad { links: ids } => {
                    for &l in ids {
                        check_link(l, links.len())?;
                        meta[l as usize].removed = true;
                    }
                }
                StructuralEdit::ModifyRoad {
                    link,
                    lanes,
                    maxspeed_kmh,
                    road_class,
                } => {
                    check_link(*link, links.len())?;
                    let bl = &mut links[*link as usize];
                    if let Some(v) = lanes {
                        if !(*v > 0.0) {
                            return Err("modify_road: lanes must be > 0".into());
                        }
                        bl.lanes = Some(*v);
                    }
                    if let Some(v) = maxspeed_kmh {
                        if !(*v > 0.0) {
                            return Err("modify_road: maxspeed must be > 0".into());
                        }
                        bl.maxspeed_kmh = Some(*v);
                    }
                    if let Some(c) = road_class {
                        bl.road_class = c.clone();
                        meta[*link as usize].road_class = c.clone();
                    }
                }
                StructuralEdit::Housing { at, population } => {
                    let (x, y) = proj(at[1], at[0]);
                    let z = nearest_zone_or_new(&mut zones, &xy, x, y);
                    zones[z].population += population;
                    add_access(&mut zones[z], nearest_node(&xy, x, y), *population, 0.0);
                }
                StructuralEdit::Jobs { at, jobs } => {
                    let (x, y) = proj(at[1], at[0]);
                    let z = nearest_zone_or_new(&mut zones, &xy, x, y);
                    zones[z].extra_jobs += jobs;
                    let w = jobs / params.get("attraction.jobs_per_poi");
                    add_access(&mut zones[z], nearest_node(&xy, x, y), 0.0, w);
                }
            }
        }
        let scale = params.get("population.scale");
        for z in &mut zones {
            z.population *= scale;
        }

        let mut b = NetworkBuilder::new();
        for &(x, y) in &xy {
            b.add_node(x, y);
        }
        for l in &links {
            let class = l.road_class.as_str();
            let lanes = l
                .lanes
                .filter(|v| *v > 0.0)
                .unwrap_or_else(|| params.class_value("default_lanes", class));
            let mut v_kmh = params.class_value("free_speed_kmh", class);
            if let Some(m) = l.maxspeed_kmh.filter(|v| *v > 0.0) {
                v_kmh = v_kmh.min(m);
            }
            let cap = lanes * params.class_value("capacity_per_lane", class);
            b.add_link(LinkSpec {
                from: NodeId(l.from),
                to: NodeId(l.to),
                length_m: l.length_m.max(1.0),
                free_speed_mps: v_kmh / 3.6,
                lanes,
                flow_capacity_pcu_per_h: cap,
                storage_pcu: None,
            });
        }
        let net = b.build().map_err(|e| e.to_string())?;

        let signal = infer_signals(&bundle, &net, &meta, params);
        let origin_link = net
            .nodes()
            .iter()
            .map(|n| {
                n.in_links
                    .iter()
                    .copied()
                    .filter(|l| !meta[l.idx()].removed)
                    .max_by(|a, b| {
                        let (ca, cb) = (net.link(*a).flow_capacity_pcu_per_h, net.link(*b).flow_capacity_pcu_per_h);
                        ca.total_cmp(&cb).then(b.cmp(a))
                    })
            })
            .collect();

        Ok(City {
            bundle,
            net: Arc::new(net),
            meta,
            zones,
            signal,
            origin_link,
            lon0,
            lat0,
        })
    }

    pub fn project(&self, lon: f64, lat: f64) -> (f64, f64) {
        (
            (lon - self.lon0) * M_PER_DEG_LON_EQ * self.lat0.to_radians().cos(),
            (lat - self.lat0) * M_PER_DEG_LAT,
        )
    }

    /// Nearest node that can start/end trips (has a usable in-link).
    pub fn nearest_node(&self, x: f64, y: f64) -> Option<NodeId> {
        self.net
            .nodes()
            .iter()
            .filter(|n| self.origin_link[n.id.idx()].is_some())
            .min_by(|a, b| {
                let da = (a.x - x).hypot(a.y - y);
                let db = (b.x - x).hypot(b.y - y);
                da.total_cmp(&db).then(a.id.cmp(&b.id))
            })
            .map(|n| n.id)
    }

    pub fn is_removed(&self, l: LinkId) -> bool {
        self.meta[l.idx()].removed
    }
}

fn nearest_zone_or_new(zones: &mut Vec<Zone>, xy: &[(f64, f64)], x: f64, y: f64) -> usize {
    let best = zones
        .iter()
        .enumerate()
        .map(|(i, z)| (i, (z.x - x).hypot(z.y - y)))
        .min_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((i, d)) = best {
        if d <= 300.0 {
            return i;
        }
    }
    zones.push(Zone {
        node: nearest_node(xy, x, y),
        x,
        y,
        population: 0.0,
        poi: BTreeMap::new(),
        extra_jobs: 0.0,
        access: Vec::new(),
    });
    zones.len() - 1
}

fn nearest_node(xy: &[(f64, f64)], x: f64, y: f64) -> NodeId {
    let i = xy
        .iter()
        .enumerate()
        .min_by(|a, b| {
            let da = (a.1 .0 - x).hypot(a.1 .1 - y);
            let db = (b.1 .0 - x).hypot(b.1 .1 - y);
            da.total_cmp(&db)
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    NodeId(i as u32)
}

/// Add weight at a street node of a zone. A zone without access entries used only
/// its centre node, so that is kept with the existing population/attraction.
fn add_access(z: &mut Zone, node: NodeId, pop: f64, attr: f64) {
    if z.access.is_empty() {
        let poi: f64 = z.poi.values().sum::<f64>() + 1e-9;
        z.access.push((z.node, z.population.max(0.0) - pop.max(0.0) + 1e-9, poi));
    }
    match z.access.iter_mut().find(|a| a.0 == node) {
        Some(a) => {
            a.1 += pop;
            a.2 += attr;
        }
        None => z.access.push((node, pop, attr)),
    }
}

const MAJOR: [&str; 4] = ["trunk", "primary", "secondary", "motorway"];

fn infer_signals(bundle: &Bundle, net: &Network, meta: &[LinkMeta], params: &Params) -> Vec<bool> {
    let infer = params.get("signal.infer_major_crossings") > 0.5;
    net.nodes()
        .iter()
        .map(|n| {
            let tagged = bundle.nodes.get(n.id.idx()).is_some_and(|b| b.signal);
            if tagged || !infer {
                return tagged && n.in_links.len() >= 2;
            }
            // Major crossing: in-links from >= 3 distinct major-road directions.
            let majors = n
                .in_links
                .iter()
                .filter(|l| {
                    let c = meta[l.idx()].road_class.trim_end_matches("_link");
                    MAJOR.contains(&c) && !meta[l.idx()].bridge
                })
                .count();
            majors >= 3
        })
        .collect()
}
