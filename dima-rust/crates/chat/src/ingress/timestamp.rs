//! `acceptEventsubMessageTimestamp(timestamp, retryHeader, durableNotification)`.
//!
//! A delivery is accepted when its timestamp is within the maximum age of now, in either
//! direction (`Math.abs(age) <= max`). Beyond that, only a retry (`Twitch-Eventsub-Message-Retry`
//! a positive integer) of a journaled notification type may be older, up to the retry maximum:
//! the journal's unique event key makes such a late retry harmless, and accepting it keeps a
//! notification Twitch could not deliver for a while. Twitch's own guidance is ten minutes; the
//! reference's default is the same.

use dima_text::{parse_date, parse_number};

/// The decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimestampDecision {
    /// The delivery may be processed.
    pub accepted: bool,
    /// It was accepted only as an old retry of a journaled type.
    pub stale_retry: bool,
}

/// The decision for a delivery at `now_ms`.
pub fn accept(
    timestamp: &str,
    retry_header: &str,
    durable_notification: bool,
    now_ms: i64,
    max_age_ms: f64,
    retry_max_age_ms: f64,
) -> TimestampDecision {
    // `new Date(timestamp).getTime()`; not finite: refused.
    let Some(parsed) = parse_date(timestamp) else {
        return TimestampDecision {
            accepted: false,
            stale_retry: false,
        };
    };
    let age = now_ms.saturating_sub(parsed) as f64;
    if age.abs() <= max_age_ms {
        return TimestampDecision {
            accepted: true,
            stale_retry: false,
        };
    }
    // `Number(retryHeader)`: `Number('')` is 0, `' 2 '` is 2, `'0x2'` is 2.
    let retry = parse_number(retry_header);
    let accepted = durable_notification
        && retry.is_finite()
        && retry.fract() == 0.0
        && retry > 0.0
        && age > max_age_ms
        && age <= retry_max_age_ms;
    TimestampDecision {
        accepted,
        stale_retry: accepted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_475_800_123; // 2026-11-12T09:30:00.123Z
    const MAX: f64 = 600_000.0;
    const RETRY_MAX: f64 = 86_400_000.0;

    fn at(offset_ms: i64) -> String {
        let iso = dima_text::to_iso_string(NOW + offset_ms).unwrap_or_default();
        iso.replace('Z', "456789Z")
    }

    fn decide(timestamp: &str, retry: &str, durable: bool) -> (bool, bool) {
        let d = accept(timestamp, retry, durable, NOW, MAX, RETRY_MAX);
        (d.accepted, d.stale_retry)
    }

    #[test]
    fn twitch_timestamps_with_nanoseconds_parse() {
        assert_eq!(parse_date(&at(0)), Some(NOW));
        assert_eq!(decide(&at(-2_000), "0", false), (true, false));
    }

    #[test]
    fn the_window_is_ten_minutes_both_ways() {
        assert_eq!(decide(&at(-600_000), "0", false), (true, false));
        assert_eq!(decide(&at(-600_001), "0", false), (false, false));
        assert_eq!(decide(&at(600_000), "0", false), (true, false));
        assert_eq!(decide(&at(600_001), "5", true), (false, false));
    }

    #[test]
    fn old_retries_of_journaled_types_are_accepted() {
        let hour_ago = at(-3_600_000);
        assert_eq!(decide(&hour_ago, "1", true), (true, true));
        assert_eq!(decide(&hour_ago, " 2 ", true), (true, true));
        assert_eq!(decide(&hour_ago, "2.0", true), (true, true));
        assert_eq!(decide(&hour_ago, "0x2", true), (true, true));
        assert_eq!(decide(&hour_ago, "0", true), (false, false));
        assert_eq!(decide(&hour_ago, "", true), (false, false));
        assert_eq!(decide(&hour_ago, "1.5", true), (false, false));
        assert_eq!(decide(&hour_ago, "-1", true), (false, false));
        assert_eq!(decide(&hour_ago, "1", false), (false, false));
        assert_eq!(decide(&at(-86_400_000), "1", true), (true, true));
        assert_eq!(decide(&at(-86_400_001), "1", true), (false, false));
    }

    #[test]
    fn what_is_not_a_date_is_refused() {
        assert_eq!(decide("", "1", true), (false, false));
        assert_eq!(decide("yesterday", "1", true), (false, false));
        assert_eq!(decide("2026-11-12 09:30:00", "0", false), (false, false));
    }
}
