//! Output events: an append-only log of what happened. Tests, metrics and the map
//! animation are all derived from this log.

use serde::{Deserialize, Serialize};

use crate::ids::{LinkId, VehicleId};
use crate::units::TimeMs;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimEvent {
    /// Vehicle wants to start; it waits until its origin link has space.
    Depart {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
    },
    LinkEnter {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
    },
    LinkLeave {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
    },
    Arrive {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
    },
    /// Gridlock breaker pushed the vehicle from `link` into the full `next_link`,
    /// ignoring storage. Always immediately followed by LinkLeave + LinkEnter.
    Stuck {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
        next_link: LinkId,
    },
    /// Vehicle removed: no route to its destination (e.g. all paths closed).
    Abort {
        t: TimeMs,
        vehicle: VehicleId,
        link: LinkId,
    },
}

impl SimEvent {
    pub fn time(&self) -> TimeMs {
        match *self {
            SimEvent::Depart { t, .. }
            | SimEvent::LinkEnter { t, .. }
            | SimEvent::LinkLeave { t, .. }
            | SimEvent::Arrive { t, .. }
            | SimEvent::Stuck { t, .. }
            | SimEvent::Abort { t, .. } => t,
        }
    }
}
