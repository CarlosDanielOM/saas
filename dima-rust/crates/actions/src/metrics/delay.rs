//! The scheduler delay figures of the runtime snapshot (`eventLoop` in the reference, which
//! reads Node's `monitorEventLoopDelay` with a 20 ms resolution).
//!
//! Tokio has no event loop to measure; the nearest figure is how late a timer task is woken. A
//! probe sleeps [`RESOLUTION`] at a time and records the whole interval between two wakes, as
//! Node's histogram does (about 20 ms when idle), which grows when the runtime's workers are
//! busy. Samples are kept for one snapshot window, at most
//! [`MAX_SAMPLES`] of them (a 30 s window at 20 ms needs 1,500); beyond that the newest replace
//! the oldest.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// How often the probe wakes (`monitorEventLoopDelay({ resolution: 20 })`).
pub const RESOLUTION: Duration = Duration::from_millis(20);

/// Most samples kept per window.
pub const MAX_SAMPLES: usize = 8_192;

/// The window's samples, in milliseconds.
#[derive(Debug, Default)]
pub(crate) struct DelaySamples {
    samples: Mutex<VecDeque<f64>>,
}

/// The `eventLoop` object of the snapshot, in milliseconds with three decimals.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DelayStats {
    /// `minMs`.
    pub min_ms: f64,
    /// `maxMs`.
    pub max_ms: f64,
    /// `meanMs`.
    pub mean_ms: f64,
    /// `stddevMs`.
    pub stddev_ms: f64,
    /// `p50Ms`.
    pub p50_ms: f64,
    /// `p95Ms`.
    pub p95_ms: f64,
    /// `p99Ms`.
    pub p99_ms: f64,
}

/// `Number(x.toFixed(3))` for the non-negative figures here; `0` for what is not finite
/// (`toMillis`).
pub(crate) fn three_decimals(ms: f64) -> f64 {
    if ms.is_finite() {
        (ms * 1000.0).round() / 1000.0
    } else {
        0.0
    }
}

impl DelaySamples {
    pub(crate) fn record(&self, late: Duration) {
        let mut samples = self.samples.lock().unwrap_or_else(PoisonError::into_inner);
        if samples.len() >= MAX_SAMPLES {
            samples.pop_front();
        }
        samples.push_back(late.as_secs_f64() * 1000.0);
    }

    /// The window's figures, and a fresh window (`histogram.reset()`).
    pub(crate) fn take(&self) -> DelayStats {
        let samples =
            std::mem::take(&mut *self.samples.lock().unwrap_or_else(PoisonError::into_inner));
        stats(samples.into())
    }
}

fn stats(mut samples: Vec<f64>) -> DelayStats {
    if samples.is_empty() {
        return DelayStats::default();
    }
    samples.sort_by(f64::total_cmp);
    let count = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / count;
    let variance = samples.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / count;
    // The smallest sample with at least `p`% of the samples at or below it (HdrHistogram's
    // `getValueAtPercentile`, without its bucketing).
    let percentile = |p: f64| {
        let rank = ((p / 100.0) * count).ceil().max(1.0) as usize;
        samples
            .get(rank.saturating_sub(1))
            .copied()
            .unwrap_or_default()
    };
    DelayStats {
        min_ms: three_decimals(samples.first().copied().unwrap_or_default()),
        max_ms: three_decimals(samples.last().copied().unwrap_or_default()),
        mean_ms: three_decimals(mean),
        stddev_ms: three_decimals(variance.sqrt()),
        p50_ms: three_decimals(percentile(50.0)),
        p95_ms: three_decimals(percentile(95.0)),
        p99_ms: three_decimals(percentile(99.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figures_of_a_window() {
        let window = DelaySamples::default();
        for ms in [1, 2, 3, 4, 100] {
            window.record(Duration::from_millis(ms));
        }
        let stats = window.take();
        assert_eq!(stats.min_ms, 1.0);
        assert_eq!(stats.max_ms, 100.0);
        assert_eq!(stats.mean_ms, 22.0);
        assert_eq!(stats.p50_ms, 3.0);
        assert_eq!(stats.p99_ms, 100.0);
        assert_eq!(window.take(), DelayStats::default());
    }

    #[test]
    fn the_window_is_bounded() {
        let window = DelaySamples::default();
        for _ in 0..MAX_SAMPLES + 10 {
            window.record(Duration::from_micros(1500));
        }
        assert_eq!(
            window.samples.lock().map(|s| s.len()).unwrap_or(0),
            MAX_SAMPLES
        );
        assert_eq!(window.take().p95_ms, 1.5);
    }
}
