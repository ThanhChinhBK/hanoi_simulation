//! Streaming aggregates collected during a run: link travel times per time bin,
//! network delay over time, departures/arrivals, and sampled vehicle traces.

use serde::{Deserialize, Serialize};

use crate::ids::{LinkId, VehicleId, VehicleTypeId};
use crate::network::Network;
use crate::traveltime::TravelTimes;
use crate::units::TimeMs;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatsConfig {
    pub start_ms: TimeMs,
    pub bin_ms: TimeMs,
    pub n_bins: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub cfg: StatsConfig,
    /// Link-major `[link * n_bins + bin]`, binned by link ENTRY time. Origin links
    /// (where trips start at the link end) are excluded.
    pub link_tt_sum_ms: Vec<f64>,
    pub link_count: Vec<u32>,
    /// Sum of (travel time − free-flow time) in seconds, binned by event time;
    /// includes waiting to enter the network.
    pub delay_s: Vec<f64>,
    pub departures: Vec<u32>,
    pub arrivals: Vec<u32>,
}

/// Path of one sampled vehicle: (link, entry time) pairs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    pub vehicle: VehicleId,
    pub vehicle_type: VehicleTypeId,
    pub links: Vec<(LinkId, TimeMs)>,
    pub end_ms: Option<TimeMs>,
}

impl Stats {
    pub fn new(cfg: StatsConfig, n_links: usize) -> Self {
        assert!(cfg.n_bins > 0 && cfg.bin_ms > 0);
        let n = cfg.n_bins;
        Self {
            link_tt_sum_ms: vec![0.0; n_links * n],
            link_count: vec![0; n_links * n],
            delay_s: vec![0.0; n],
            departures: vec![0; n],
            arrivals: vec![0; n],
            cfg,
        }
    }

    pub fn bin(&self, t: TimeMs) -> usize {
        let b = (t - self.cfg.start_ms).div_euclid(self.cfg.bin_ms);
        b.clamp(0, self.cfg.n_bins as i64 - 1) as usize
    }

    pub(crate) fn add_link(&mut self, l: LinkId, entered: TimeMs, tt_ms: f64) {
        let i = l.idx() * self.cfg.n_bins + self.bin(entered);
        self.link_tt_sum_ms[i] += tt_ms;
        self.link_count[i] += 1;
    }
    pub(crate) fn add_delay(&mut self, t: TimeMs, ms: f64) {
        let b = self.bin(t);
        self.delay_s[b] += ms / 1000.0;
    }
    pub(crate) fn add_departure(&mut self, t: TimeMs) {
        let b = self.bin(t);
        self.departures[b] += 1;
    }
    pub(crate) fn add_arrival(&mut self, t: TimeMs) {
        let b = self.bin(t);
        self.arrivals[b] += 1;
    }

    /// Mean travel time per link and bin (ms); NaN where nobody entered.
    pub fn mean_tt(&self) -> Vec<f32> {
        self.link_tt_sum_ms
            .iter()
            .zip(&self.link_count)
            .map(|(&s, &c)| {
                if c > 0 {
                    (s / c as f64) as f32
                } else {
                    f32::NAN
                }
            })
            .collect()
    }

    /// Travel-time table for routing. Bins without observations fall back to the
    /// nearest earlier observed bin's value if it was congested, else free flow.
    pub fn travel_times(&self, net: &Network) -> TravelTimes {
        let c = &self.cfg;
        let mut tt = TravelTimes::free_flow(net, c.start_ms, c.bin_ms, c.n_bins);
        let mean = self.mean_tt();
        for l in 0..net.links().len() {
            let mut last = f32::NAN;
            for b in 0..c.n_bins {
                let m = mean[l * c.n_bins + b];
                let v = if m.is_nan() { last } else { m };
                if !v.is_nan() {
                    tt.set(LinkId(l as u32), b, v);
                }
                // Carry a congested value forward only into the next empty bin, so a
                // link that became jammed and then empty is not penalised forever.
                last = if m.is_nan() { f32::NAN } else { m };
            }
        }
        tt
    }
}
