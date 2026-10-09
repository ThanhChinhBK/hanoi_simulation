//! Small deterministic RNG (SplitMix64). Identical across native, Python and WASM
//! builds, independent of crate versions. Streams are derived from (seed, keys) so
//! that changing one zone does not reshuffle random numbers everywhere else.

#[derive(Clone, Debug)]
pub struct Rng(u64);

fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(mix(seed.wrapping_add(0x9e37_79b9_7f4a_7c15)))
    }

    /// Independent stream for a (seed, a, b) triple.
    pub fn stream(seed: u64, a: u64, b: u64) -> Self {
        Rng::new(mix(seed ^ mix(a.wrapping_add(0x51_7cc1_b727_220a) ^ mix(b))))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        mix(self.0)
    }

    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    pub fn normal(&mut self) -> f64 {
        let u1 = self.f64().max(1e-300);
        let u2 = self.f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    /// floor(x) plus one with probability frac(x).
    pub fn round_stochastic(&mut self, x: f64) -> usize {
        let f = x.floor();
        f as usize + usize::from(self.f64() < x - f)
    }

    /// Index into a cumulative weight array (last element = total > 0).
    pub fn pick_cumulative(&mut self, cum: &[f64]) -> usize {
        let total = *cum.last().expect("non-empty");
        let r = self.f64() * total;
        cum.partition_point(|&c| c <= r).min(cum.len() - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_uniformish() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        let xs: Vec<f64> = (0..10_000).map(|_| a.f64()).collect();
        let ys: Vec<f64> = (0..10_000).map(|_| b.f64()).collect();
        assert_eq!(xs, ys);
        let mean = xs.iter().sum::<f64>() / xs.len() as f64;
        assert!((mean - 0.5).abs() < 0.02);
        assert!(xs.iter().all(|&x| (0.0..1.0).contains(&x)));
    }

    #[test]
    fn pick_cumulative_respects_zero_weights() {
        let mut r = Rng::new(1);
        let cum = [0.0, 1.0, 1.0, 3.0];
        for _ in 0..1000 {
            let i = r.pick_cumulative(&cum);
            assert!(i == 1 || i == 3);
        }
    }
}
