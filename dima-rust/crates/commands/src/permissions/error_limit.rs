//! Rate limit for repeated permission errors in logs (reference:
//! `utils/permissions/error_rate_limit.ts`).

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

/// The default quiet period per key: five minutes.
pub const DEFAULT_PERMISSION_ERROR_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// The most keys remembered; beyond it the least recently logged key is forgotten.
pub const MAX_TRACKED_PERMISSION_ERRORS: usize = 2_000;

/// `shouldLogPermissionError`, as an owned value (the reference keeps one per process).
///
/// Keys are bounded, so malformed records across many channels cannot grow memory without
/// limit. Times come from the caller (`Clock::now_ms`).
#[derive(Debug, Default)]
pub struct PermissionErrorLimiter {
    state: Mutex<LimiterState>,
}

#[derive(Debug, Default)]
struct LimiterState {
    /// key -> (last logged at, sequence number).
    last: HashMap<String, (i64, u64)>,
    /// sequence number -> key: the order of the last log, oldest first.
    order: BTreeMap<u64, String>,
    next: u64,
}

impl PermissionErrorLimiter {
    /// An empty limiter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether an error with `key` should be logged now, with the default interval.
    pub fn should_log(&self, key: &str, now_ms: i64) -> bool {
        self.should_log_every(key, now_ms, DEFAULT_PERMISSION_ERROR_INTERVAL_MS)
    }

    /// Whether an error with `key` should be logged now: not within `interval_ms` of the last
    /// time it was. Logging refreshes the key's place, so the bounded map forgets the key logged
    /// least recently.
    pub fn should_log_every(&self, key: &str, now_ms: i64, interval_ms: i64) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = state.last.get(key).copied();
        if let Some((at, _)) = previous
            && now_ms.saturating_sub(at) < interval_ms
        {
            return false;
        }
        if previous.is_none()
            && state.last.len() >= MAX_TRACKED_PERMISSION_ERRORS
            && let Some((_, oldest)) = state.order.pop_first()
        {
            state.last.remove(&oldest);
        }
        if let Some((_, sequence)) = previous {
            state.order.remove(&sequence);
        }
        let sequence = state.next;
        state.next += 1;
        state.order.insert(sequence, key.to_owned());
        state.last.insert(key.to_owned(), (now_ms, sequence));
        true
    }

    /// How many keys are remembered.
    pub fn len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last
            .len()
    }

    /// Whether no key is remembered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // error_rate_limit.test.ts
    #[test]
    fn suppresses_repeated_errors_until_the_interval_passes() {
        let limiter = PermissionErrorLimiter::new();
        let key = "test-key";
        assert!(limiter.should_log_every(key, 1_000, 5_000));
        assert!(!limiter.should_log_every(key, 2_000, 5_000));
        assert!(limiter.should_log_every(key, 6_000, 5_000));
    }

    #[test]
    fn keys_are_bounded_and_the_least_recently_logged_is_forgotten() {
        let limiter = PermissionErrorLimiter::new();
        for index in 0..MAX_TRACKED_PERMISSION_ERRORS {
            assert!(limiter.should_log(&format!("k{index}"), 0));
        }
        // Refresh k0 so k1 becomes the oldest.
        assert!(limiter.should_log("k0", DEFAULT_PERMISSION_ERROR_INTERVAL_MS));
        assert!(limiter.should_log("new", 1));
        assert_eq!(limiter.len(), MAX_TRACKED_PERMISSION_ERRORS);
        assert!(!limiter.should_log("k0", DEFAULT_PERMISSION_ERROR_INTERVAL_MS + 1));
        assert!(limiter.should_log("k1", 2), "k1 was forgotten");
    }
}
