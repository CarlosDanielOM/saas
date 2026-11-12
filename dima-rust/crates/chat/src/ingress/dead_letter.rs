//! The dead-letter record: deliveries Twitch signed that this backend can never handle.
//!
//! The reference answers them 400 or 503, and Twitch delivers them again until it gives up,
//! counting each as a failure towards revoking the subscription (`notification_failures_exceeded`),
//! which would cut the bot off from the channel. Here they are answered 204 and kept here, for an
//! operator (lead's decision on plan question 5).
//!
//! - Key `eventsub:dead-letter` (Rust's logical database, new): a list of JSON records, newest
//!   first, at most [`super::IngressConfig::dead_letter_max`] (1,000), the list expiring 30 days
//!   after its last record. `eventsub:dead-letter:count` counts every record ever written, with
//!   the same lifetime. Both are *rebuilt* at the cutover (diagnostics, nothing reads them).
//! - A record: `{at, reason, detail, messageId, messageType, subscriptionType, timestamp, retry,
//!   bodyBytes, bodySha256, body}`; `body` is the body as text, cut at
//!   [`super::IngressConfig::dead_letter_body_bytes`] (8 KiB) on a character boundary. A
//!   notification body holds what Twitch sends about a channel's event (a chat message's text
//!   included), never a token or the secret.
//! - The write is bounded ([`super::IngressConfig::dead_letter_deadline`], 1 s) and best effort:
//!   when it fails the delivery is still answered 204 (it can never be processed) and the failure
//!   is logged and counted.

use dima_core::crypto::digest::sha256;
use dima_store::dragonfly::Dragonfly;
use serde_json::json;
use std::time::Duration;

/// Why a delivery was dead-lettered (a counter name each).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeadLetterReason {
    /// The body is not JSON (the reference answers 400).
    NotJson,
    /// The body is JSON but not an object (the reference throws on `null`, otherwise 400).
    NotObject,
    /// A notification without a message id (400).
    NoMessageId,
    /// A notification or revocation without a `subscription` object (400).
    NoSubscription,
    /// A notification without an `event` (400).
    NoEvent,
    /// The journal's mapper refused it (`normalizeTwitchEventsubDomainEvent` threw: 400).
    Contract,
    /// The journal refused it for good (a contract or validation error: 503 for ever).
    Refused,
    /// The revocation handler can never complete it (503 for ever).
    RevocationInvalid,
    /// A message type this backend does not know (the reference answers 204 and logs it).
    UnknownMessageType,
}

impl DeadLetterReason {
    /// The counter name and the record's `reason`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotJson => "not_json",
            Self::NotObject => "not_object",
            Self::NoMessageId => "no_message_id",
            Self::NoSubscription => "no_subscription",
            Self::NoEvent => "no_event",
            Self::Contract => "contract",
            Self::Refused => "journal_refused",
            Self::RevocationInvalid => "revocation_invalid",
            Self::UnknownMessageType => "unknown_message_type",
        }
    }
}

/// One record.
#[derive(Clone, Debug)]
pub struct DeadLetter<'a> {
    /// Why.
    pub reason: DeadLetterReason,
    /// The error text, when there is one (cut at 500 characters).
    pub detail: &'a str,
    /// `Twitch-Eventsub-Message-Id`.
    pub message_id: &'a str,
    /// `Twitch-Eventsub-Message-Type`.
    pub message_type: &'a str,
    /// `subscription.type`, when the body had one.
    pub subscription_type: &'a str,
    /// `Twitch-Eventsub-Message-Timestamp`.
    pub timestamp: &'a str,
    /// `Twitch-Eventsub-Message-Retry`.
    pub retry: &'a str,
    /// The raw body.
    pub body: &'a [u8],
}

/// The record's JSON.
pub fn record_json(record: &DeadLetter<'_>, at_iso: &str, body_bytes: usize) -> String {
    let text = String::from_utf8_lossy(record.body);
    let kept = cut_bytes(&text, body_bytes);
    json!({
        "at": at_iso,
        "reason": record.reason.as_str(),
        "detail": dima_text::truncate_chars(record.detail, 500),
        "messageId": record.message_id,
        "messageType": record.message_type,
        "subscriptionType": dima_text::truncate_chars(record.subscription_type, 200),
        "timestamp": record.timestamp,
        "retry": record.retry,
        "bodyBytes": record.body.len(),
        "bodySha256": sha256(record.body).hex(),
        "body": kept,
    })
    .to_string()
}

/// The longest prefix of `text` of at most `max` bytes that ends on a character boundary.
fn cut_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or_default()
}

/// Where and how records are kept.
#[derive(Clone, Debug)]
pub struct DeadLetters {
    /// The list.
    pub key: String,
    /// The counter.
    pub count_key: String,
    /// Records kept.
    pub max: usize,
    /// Body bytes kept per record.
    pub body_bytes: usize,
    /// The list's lifetime after its last record.
    pub ttl_seconds: u64,
    /// The write's deadline.
    pub deadline: Duration,
}

impl DeadLetters {
    /// `LPUSH`, `LTRIM`, `EXPIRE`, `INCR`, `EXPIRE` in one pipeline. `false` when it failed.
    pub async fn write(
        &self,
        dragonfly: &Dragonfly,
        record: &DeadLetter<'_>,
        at_iso: &str,
    ) -> bool {
        let json = record_json(record, at_iso, self.body_bytes);
        let mut pipe = redis::pipe();
        pipe.cmd("LPUSH").arg(&self.key).arg(&json).ignore();
        pipe.cmd("LTRIM")
            .arg(&self.key)
            .arg(0)
            .arg(self.max.saturating_sub(1))
            .ignore();
        pipe.cmd("EXPIRE")
            .arg(&self.key)
            .arg(self.ttl_seconds)
            .ignore();
        pipe.cmd("INCR").arg(&self.count_key).ignore();
        pipe.cmd("EXPIRE")
            .arg(&self.count_key)
            .arg(self.ttl_seconds)
            .ignore();
        matches!(
            tokio::time::timeout(self.deadline, dragonfly.query_pipeline::<()>(&pipe)).await,
            Ok(Ok(()))
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_cut_on_a_character_boundary() {
        assert_eq!(cut_bytes("abc", 8), "abc");
        assert_eq!(cut_bytes("añb", 2), "a");
        assert_eq!(cut_bytes("👋🏽", 5), "👋");
        assert_eq!(cut_bytes("👋", 3), "");
    }

    #[test]
    fn a_record_holds_what_an_operator_needs() {
        let record = DeadLetter {
            reason: DeadLetterReason::NotJson,
            detail: "Unexpected token",
            message_id: "m1",
            message_type: "notification",
            subscription_type: "",
            timestamp: "2026-11-12T09:29:58.123456789Z",
            retry: "0",
            body: b"this is { not json",
        };
        let json: serde_json::Value =
            serde_json::from_str(&record_json(&record, "2026-11-12T09:30:00.123Z", 4))
                .unwrap_or_default();
        assert_eq!(json["reason"], "not_json");
        assert_eq!(json["body"], "this");
        assert_eq!(json["bodyBytes"], 18);
        assert_eq!(json["messageId"], "m1");
        assert_eq!(json["bodySha256"].as_str().map(str::len), Some(64));
    }
}
