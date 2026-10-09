//! Travel demand: vehicle types and trips with fixed routes (step 1: hand-made demand).

use serde::{Deserialize, Serialize};

use crate::ids::{LinkId, VehicleTypeId};
use crate::units::TimeMs;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VehicleType {
    pub name: String,
    /// Passenger car units; motorbike ≈ 0.25–0.3 (parameter).
    pub pcu: f64,
    pub max_speed_mps: f64,
}

impl VehicleType {
    pub fn car() -> Self {
        Self {
            name: "car".into(),
            pcu: 1.0,
            max_speed_mps: 50.0,
        }
    }
    pub fn motorbike() -> Self {
        Self {
            name: "motorbike".into(),
            pcu: 0.25,
            max_speed_mps: 50.0,
        }
    }
}

/// A single trip. It starts at the END of `route[0]` and ends at the END of
/// `route.last()` (MATSim convention).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trip {
    pub vehicle_type: VehicleTypeId,
    pub depart_ms: TimeMs,
    pub route: Vec<LinkId>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Demand {
    pub vehicle_types: Vec<VehicleType>,
    pub trips: Vec<Trip>,
}
