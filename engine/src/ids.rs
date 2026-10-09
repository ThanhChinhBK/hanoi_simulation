//! Typed integer IDs. All entities live in `Vec`s and are referenced by index.

use serde::{Deserialize, Serialize};

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub u32);

        impl $name {
            #[inline]
            pub fn idx(self) -> usize {
                self.0 as usize
            }
        }
    };
}

id_type!(
    /// Index into `Network::nodes`.
    NodeId
);
id_type!(
    /// Index into `Network::links`.
    LinkId
);
id_type!(
    /// One vehicle per trip in step 1; equals the index into `Demand::trips`.
    VehicleId
);
id_type!(
    /// Index into `Demand::vehicle_types`.
    VehicleTypeId
);
