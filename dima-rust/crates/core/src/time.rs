//! Wall-clock time as JavaScript sees it (`Date.now()`), injectable for tests.
//!
//! This is only the *current time*. Timers, intervals, sleeps and timeouts use `tokio::time`
//! (`sleep`, `interval`, `timeout`), so tests drive them with tokio's paused clock
//! (`#[tokio::test(start_paused = true)]`, `tokio::time::advance`). The two clocks are
//! independent: advancing tokio's clock does not move a [`ManualClock`], and the reverse.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A source of the current time in epoch milliseconds.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Milliseconds since the Unix epoch, like `Date.now()` (negative before 1970).
    fn now_ms(&self) -> i64;

    /// Whole seconds since the epoch, like `Math.floor(Date.now() / 1000)`.
    fn now_secs(&self) -> i64 {
        self.now_ms().div_euclid(1000)
    }
}

/// The operating system's wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
            // Before the epoch: Date.now() is negative and floors toward minus infinity.
            Err(before) => {
                let before = before.duration();
                let ms = i64::try_from(before.as_millis()).unwrap_or(i64::MAX);
                let partial = before.as_nanos() % 1_000_000 != 0;
                -ms - i64::from(partial)
            }
        }
    }
}

/// A clock that moves only when told to. Clones share the same time.
#[derive(Clone, Debug, Default)]
pub struct ManualClock(Arc<AtomicI64>);

impl ManualClock {
    /// A clock showing `now_ms`.
    pub fn new(now_ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(now_ms)))
    }

    /// Sets the current time.
    pub fn set(&self, now_ms: i64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }

    /// Moves the clock forward (or back, with a negative value).
    pub fn advance(&self, delta_ms: i64) {
        self.0.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_is_shared_between_clones() {
        let clock = ManualClock::new(1_700_000_000_999);
        let other = clock.clone();
        assert_eq!(other.now_secs(), 1_700_000_000);
        clock.advance(1);
        assert_eq!(other.now_ms(), 1_700_000_001_000);
        clock.set(-1);
        assert_eq!(other.now_secs(), -1);
    }

    #[test]
    fn system_clock_is_after_2026() {
        assert!(SystemClock.now_ms() > 1_767_225_600_000);
    }
}
