//! Integer units. Simulation state uses integers so results are bit-for-bit reproducible.

/// Simulation time in milliseconds since midnight.
pub type TimeMs = i64;

/// Road space / vehicle size in thousandths of a passenger car unit (PCU).
pub type MilliPcu = i64;

pub const MS_PER_S: i64 = 1_000;
pub const US_PER_MS: i64 = 1_000;

/// Length of road occupied by one PCU in a jam (m). Standard MATSim value.
pub const PCU_LENGTH_M: f64 = 7.5;

/// Seconds → milliseconds.
pub const fn secs(s: i64) -> TimeMs {
    s * MS_PER_S
}

/// PCU (float) → milli-PCU, rounded to nearest.
pub fn milli_pcu(pcu: f64) -> MilliPcu {
    (pcu * 1000.0).round() as MilliPcu
}
