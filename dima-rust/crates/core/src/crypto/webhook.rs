//! Inbound webhook signatures: Twitch EventSub and Polar (standardwebhooks 1.0.0).
//!
//! Header values are taken as text the way Node presents them (each header byte one character,
//! latin1); the HTTP layer converts them once at the edge.

use super::digest::{constant_time_eq, hmac_sha256, hmac_sha256_parts};
use super::encoding::encode_base64;
use crate::secret::SecretBytes;

/// The `Twitch-Eventsub-Message-Signature` value for a message: `sha256=` followed by the hex
/// HMAC-SHA256, keyed with the UTF-8 bytes of `TWITCH_EVENTSUB_SECRET` (an empty secret is
/// used as an empty key, as the reference does), over message id, timestamp and raw body
/// concatenated. Node encodes the two header strings as UTF-8 before hashing; so does this.
pub fn eventsub_signature(
    secret: &SecretBytes,
    message_id: &str,
    timestamp: &str,
    body: &[u8],
) -> String {
    let mac = hmac_sha256_parts(secret, &[message_id.as_bytes(), timestamp.as_bytes(), body]);
    format!("sha256={}", mac.hex())
}

/// `verifyMessage(hmac, signature)` in `bot/eventsub.twitch.ts`: constant-time equality with the
/// expected signature. Any length difference is `false`.
///
/// Fixed: the reference compares JavaScript string lengths, then calls `timingSafeEqual` on the
/// UTF-8 bytes, which throws when a non-ASCII header has the right number of characters; under
/// Express 4 that rejection is unhandled and exits the bot process. Here it is `false` (403).
pub fn verify_eventsub_signature(
    secret: &SecretBytes,
    message_id: &str,
    timestamp: &str,
    body: &[u8],
    signature: &str,
) -> bool {
    let expected = eventsub_signature(secret, message_id, timestamp, body);
    constant_time_eq(signature.as_bytes(), expected.as_bytes())
}

/// The standardwebhooks timestamp tolerance, in seconds.
pub const WEBHOOK_TOLERANCE_SECS: f64 = 300.0;

/// Why a standardwebhooks delivery was rejected. Messages are the package's; every variant is a
/// `WebhookVerificationError` there (403 at the Polar route).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    /// `webhook-id`, `webhook-timestamp` or `webhook-signature` is missing or empty.
    #[error("Missing required headers")]
    MissingHeaders,
    /// `webhook-timestamp` does not start with an integer (`parseInt(x, 10)` is NaN).
    #[error("Invalid Signature Headers")]
    InvalidTimestamp,
    /// More than 300 seconds old.
    #[error("Message timestamp too old")]
    TooOld,
    /// More than 300 seconds in the future.
    #[error("Message timestamp too new")]
    TooNew,
    /// No `v1,<signature>` entry matches.
    #[error("No matching signature found")]
    NoMatchingSignature,
}

/// The `webhook-*` header values of one delivery (`None` when absent).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WebhookHeaders<'a> {
    /// `webhook-id`.
    pub id: Option<&'a str>,
    /// `webhook-timestamp` (seconds, as text).
    pub timestamp: Option<&'a str>,
    /// `webhook-signature`: space-separated `v1,<base64>` entries.
    pub signature: Option<&'a str>,
}

/// A standardwebhooks verifier configured as `@polar-sh/sdk` 0.42.5 `validateEvent` configures
/// it: `new Webhook(base64(utf8(secret)))`, so the HMAC key is the raw UTF-8 bytes of
/// `POLARSH_WEBHOOK_SECRET` (no `whsec_` decoding). `Debug` hides the key.
#[derive(Clone, Debug)]
pub struct PolarWebhook {
    key: SecretBytes,
}

impl PolarWebhook {
    /// The verifier for `POLARSH_WEBHOOK_SECRET`; `None` when it is empty (the route then answers
    /// 500 `POLARSH_WEBHOOK_SECRET not configured` before verifying).
    pub fn new(secret: &str) -> Option<Self> {
        (!secret.is_empty()).then(|| Self {
            key: SecretBytes::from_text(secret),
        })
    }

    /// `webhook.sign(id, timestamp, payload)`: `v1,` and the padded base64 HMAC-SHA256 of
    /// `${id}.${timestamp}.${payload}`, where the body is read as UTF-8 (invalid bytes become
    /// U+FFFD, as `buffer.toString()` does) and the whole text is encoded as UTF-8 again.
    pub fn sign(&self, id: &str, timestamp_secs: i64, payload: &[u8]) -> String {
        let body = String::from_utf8_lossy(payload);
        let signed = format!("{id}.{timestamp_secs}.{body}");
        format!(
            "v1,{}",
            encode_base64(&hmac_sha256(&self.key, signed.as_bytes()).0)
        )
    }

    /// `webhook.verify(payload, headers)` at `now_ms`, up to (not including) its final
    /// `JSON.parse(payload)`: on success the caller parses the body, and a body that is not JSON
    /// is then an ordinary error (500 at the Polar route), not a verification failure.
    pub fn verify(
        &self,
        payload: &[u8],
        headers: WebhookHeaders<'_>,
        now_ms: i64,
    ) -> Result<(), WebhookError> {
        fn present(value: Option<&str>) -> Option<&str> {
            value.filter(|text| !text.is_empty())
        }
        let (Some(id), Some(timestamp), Some(signatures)) = (
            present(headers.id),
            present(headers.timestamp),
            present(headers.signature),
        ) else {
            return Err(WebhookError::MissingHeaders);
        };
        let timestamp = dima_text::parse_int(timestamp, dima_text::Radix::Decimal);
        if timestamp.is_nan() {
            return Err(WebhookError::InvalidTimestamp);
        }
        #[allow(clippy::cast_precision_loss)]
        let now = now_ms.div_euclid(1000) as f64;
        if now - timestamp > WEBHOOK_TOLERANCE_SECS {
            return Err(WebhookError::TooOld);
        }
        if timestamp > now + WEBHOOK_TOLERANCE_SECS {
            return Err(WebhookError::TooNew);
        }
        // Within the tolerance the timestamp is an integer near `now`; this is exact.
        #[allow(clippy::cast_possible_truncation)]
        let expected = self.sign(id, timestamp as i64, payload);
        let expected = expected.split(',').nth(1).unwrap_or_default();
        for entry in signatures.split(' ') {
            let mut fields = entry.split(',');
            if fields.next() != Some("v1") {
                continue;
            }
            // A missing signature after the comma encodes as empty bytes, which never match.
            let signature = fields.next().unwrap_or_default();
            if constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
                return Ok(());
            }
        }
        Err(WebhookError::NoMatchingSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eventsub_round_trip() {
        let secret = SecretBytes::from_text("s3cret");
        let signature = eventsub_signature(&secret, "id", "2026-11-11T00:00:00Z", b"{}");
        assert!(signature.starts_with("sha256="));
        assert_eq!(signature.len(), 71);
        assert!(verify_eventsub_signature(
            &secret,
            "id",
            "2026-11-11T00:00:00Z",
            b"{}",
            &signature
        ));
        assert!(!verify_eventsub_signature(
            &secret,
            "id",
            "2026-11-11T00:00:01Z",
            b"{}",
            &signature
        ));
        let wide = format!("{}é", signature.get(..70).unwrap());
        assert!(!verify_eventsub_signature(
            &secret,
            "id",
            "2026-11-11T00:00:00Z",
            b"{}",
            &wide
        ));
    }

    #[test]
    fn polar_rejections() {
        let hook = PolarWebhook::new("polar-secret").unwrap();
        let now = 1_700_000_000_000;
        let good = hook.sign("msg_1", 1_700_000_000, b"{\"a\":1}");
        let headers = |ts, sig| WebhookHeaders {
            id: Some("msg_1"),
            timestamp: Some(ts),
            signature: Some(sig),
        };
        assert_eq!(
            hook.verify(b"{\"a\":1}", headers("1700000000", &good), now),
            Ok(())
        );
        let list = format!("v2,x v1,bad {good}");
        assert_eq!(
            hook.verify(b"{\"a\":1}", headers("1700000000", &list), now),
            Ok(())
        );
        assert_eq!(
            hook.verify(b"{\"a\":1}", headers("1699999699", &good), now),
            Err(WebhookError::TooOld)
        );
        assert_eq!(
            hook.verify(b"{\"a\":1}", headers("1700000301", &good), now),
            Err(WebhookError::TooNew)
        );
        assert_eq!(
            hook.verify(b"{\"a\":1}", headers("soon", &good), now),
            Err(WebhookError::InvalidTimestamp)
        );
        assert_eq!(
            hook.verify(b"{\"a\":2}", headers("1700000000", &good), now),
            Err(WebhookError::NoMatchingSignature)
        );
        assert_eq!(
            hook.verify(b"{}", WebhookHeaders::default(), now),
            Err(WebhookError::MissingHeaders)
        );
        assert!(PolarWebhook::new("").is_none());
        assert_eq!(
            format!("{hook:?}"),
            "PolarWebhook { key: SecretBytes(<redacted>) }"
        );
    }
}
