//! "Seen" for notifications that are not journaled (`claimEventsubMessage`).
//!
//! A journaled notification is seen once its event is in `domain_events`: the unique `eventKey`
//! (source, message id, type) is the durable answer, kept for the event's retention (90 days, a
//! day for polls, predictions, hype trains, ad breaks and goals), which outlasts the 24-hour
//! retry window. Every other type is claimed in Dragonfly:
//!
//! - key `twitch:eventsub:message:{message id}` (Rust's logical database), value the claim time
//!   (ISO), `SET NX EX`;
//! - lifetime `TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS` (600 s), extended, when longer, to the time the
//!   message could still pass the timestamp check (a message dated in the future stays valid for
//!   up to twice the maximum age). With the reference's defaults the two are equal; a replay
//!   after the key expired is then refused by the timestamp check (403), so a non-journaled
//!   message is processed at most once whatever the replay;
//! - the family is *rebuilt* at the cutover: the TypeScript bot's keys are in database 0, and a
//!   message Twitch delivered to it and redelivers to Rust within ten minutes would be handled
//!   twice (only possible for a delivery TypeScript failed to answer).
//!
//! The claim runs after the answer is written (the reference claims first): the answer is 204
//! either way, so it does not depend on the claim, and a process killed between a claim and its
//! answer could otherwise drop Twitch's redelivery as a duplicate. When Dragonfly fails, the
//! notification is processed anyway (the reference's choice: a duplicate is better than a loss).

use dima_store::dragonfly::{Dragonfly, SetOptions, SetOutcome};
use std::time::Duration;

/// The claim's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    /// First delivery of this id: process it.
    First,
    /// Seen before: acknowledge only.
    Seen,
    /// Dragonfly failed or timed out: processed anyway.
    Unknown,
}

/// The key of a message id.
pub fn key(prefix: &str, message_id: &str) -> String {
    format!("{prefix}twitch:eventsub:message:{message_id}")
}

/// How long the claim lives: the configured lifetime, or longer when the message stays valid
/// longer (`timestamp_ms + max_age - now`, rounded up).
pub fn lifetime_seconds(configured: u64, timestamp_ms: i64, max_age_ms: f64, now_ms: i64) -> u64 {
    let valid_for_ms = timestamp_ms as f64 + max_age_ms - now_ms as f64;
    let valid_for = if valid_for_ms.is_finite() && valid_for_ms > 0.0 {
        (valid_for_ms / 1000.0).ceil() as u64
    } else {
        0
    };
    configured.max(valid_for)
}

/// `SET key <now ISO> NX EX seconds`.
pub async fn claim(
    dragonfly: &Dragonfly,
    key: &str,
    now_iso: &str,
    seconds: u64,
    deadline: Duration,
) -> Claim {
    let set = dragonfly.set(key, now_iso.as_bytes(), SetOptions::if_missing_ex(seconds));
    match tokio::time::timeout(deadline, set).await {
        Ok(Ok(SetOutcome::Written)) => Claim::First,
        Ok(Ok(_)) => Claim::Seen,
        Ok(Err(_)) | Err(_) => Claim::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_claim_outlives_the_timestamp_window() {
        let now = 1_794_475_800_123;
        // Two seconds old: valid for 598 s more; the configured 600 s wins.
        assert_eq!(lifetime_seconds(600, now - 2_000, 600_000.0, now), 600);
        // Nine minutes ahead: valid for 19 minutes.
        assert_eq!(lifetime_seconds(600, now + 540_000, 600_000.0, now), 1140);
        // A shorter configured lifetime is extended to the window.
        assert_eq!(lifetime_seconds(300, now, 600_000.0, now), 600);
    }

    #[test]
    fn keys() {
        assert_eq!(key("", "abc"), "twitch:eventsub:message:abc");
        assert_eq!(key("t:", "abc"), "t:twitch:eventsub:message:abc");
    }
}
