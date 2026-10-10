//! Mesoscopic link-queue traffic simulation (MATSim-style), event-driven.
//!
//! See `engine/README.md` for the model semantics.

// `!(x > 0.0)` is used on purpose: it also rejects NaN inputs.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod access;
pub mod bundle;
pub mod demand;
pub mod demandgen;
pub mod events;
pub mod flood;
pub mod ids;
pub mod network;
pub mod params;
pub mod replan;
pub mod rng;
pub mod routing;
pub mod scenario;
pub mod signals;
pub mod sim;
pub mod stats;
pub mod traveltime;
pub mod units;

pub use bundle::{Bundle, City, StructuralEdit};
pub use demand::{Demand, Trip, VehicleType};
pub use events::SimEvent;
pub use ids::{LinkId, NodeId, VehicleId, VehicleTypeId};
pub use network::{LinkSpec, Network, NetworkBuilder};
pub use params::Params;
pub use scenario::{Engine, RunOutput, Scenario, Summary};
pub use sim::{Counts, FactorSource, RerouteConfig, Sim, SimConfig, SimError};
pub use stats::{Stats, StatsConfig, Trace};
pub use traveltime::TravelTimes;
pub use units::{secs, MilliPcu, TimeMs};
