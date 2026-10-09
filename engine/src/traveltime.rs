//! Link travel-time tables: expected time to traverse a link when entering it at time t.
//! Built from simulation statistics (previous iteration) and used by routing.

use crate::ids::LinkId;
use crate::network::Network;
use crate::units::TimeMs;

#[derive(Clone, Debug, PartialEq)]
pub struct TravelTimes {
    pub start_ms: TimeMs,
    pub bin_ms: TimeMs,
    pub n_bins: usize,
    /// Free-flow time per link (ms), the lower bound for every bin.
    pub free_flow: Vec<f32>,
    /// Link-major: `tt[link * n_bins + bin]`, ms.
    pub tt: Vec<f32>,
}

impl TravelTimes {
    pub fn free_flow(net: &Network, start_ms: TimeMs, bin_ms: TimeMs, n_bins: usize) -> Self {
        let ff: Vec<f32> = net
            .links()
            .iter()
            .map(|l| (l.length_m * 1000.0 / l.free_speed_mps) as f32)
            .collect();
        let tt = ff
            .iter()
            .flat_map(|&f| std::iter::repeat_n(f, n_bins))
            .collect();
        Self {
            start_ms,
            bin_ms,
            n_bins,
            free_flow: ff,
            tt,
        }
    }

    pub fn bin(&self, t: TimeMs) -> usize {
        if t <= self.start_ms {
            0
        } else {
            (((t - self.start_ms) / self.bin_ms) as usize).min(self.n_bins - 1)
        }
    }

    #[inline]
    pub fn get(&self, l: LinkId, t: TimeMs) -> f32 {
        self.tt[l.idx() * self.n_bins + self.bin(t)]
    }

    pub fn set(&mut self, l: LinkId, bin: usize, ms: f32) {
        let i = l.idx() * self.n_bins + bin;
        self.tt[i] = ms.max(self.free_flow[l.idx()]);
    }

    /// The same table for an edited network: added links get free-flow times and
    /// changed links keep their measured delay on top of their new free-flow time.
    pub fn adapted_to(&self, net: &Network) -> TravelTimes {
        let mut out = TravelTimes::free_flow(net, self.start_ms, self.bin_ms, self.n_bins);
        let n_old = self.free_flow.len();
        for l in 0..net.links().len().min(n_old) {
            for b in 0..self.n_bins {
                let delay = self.tt[l * self.n_bins + b] - self.free_flow[l];
                out.tt[l * self.n_bins + b] += delay.max(0.0);
            }
        }
        out
    }

    /// Blend towards `other` (method of successive averages style): self = (1-w)·self + w·other.
    pub fn blend(&mut self, other: &TravelTimes, w: f32) {
        assert_eq!(self.tt.len(), other.tt.len());
        for (a, b) in self.tt.iter_mut().zip(&other.tt) {
            *a = (1.0 - w) * *a + w * *b;
        }
    }
}
