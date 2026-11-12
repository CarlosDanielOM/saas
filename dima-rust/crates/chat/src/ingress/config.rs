//! The ingress's typed configuration: the reference's three variables and secret, read once by
//! the binary, plus the bounds this port adds (each with the reason for its value).

use dima_core::env::read::{math_max, max_number_or, number_or};
use dima_core::env::{EnvError, EnvVar};
use dima_core::{SecretBytes, SecretString};
use dima_web::ServeOptions;
use std::fmt;
use std::time::Duration;

/// `EVENTSUB_PORT`: the reference listens here, and the Compose file publishes it.
pub const EVENTSUB_PORT: u16 = 3333;

/// The path Twitch delivers to (`app.post('/eventsub')`).
pub const EVENTSUB_PATH: &str = "/eventsub";

/// body-parser's default limit (`express.raw` with no `limit`): `100kb`, 102,400 bytes. Twitch
/// documents no maximum; its notifications are a few kilobytes (a chat message with every
/// fragment is under 10 KB), so this is the reference's bound and well above anything sent.
pub const BODY_LIMIT: usize = 100 * 1024;

/// The variables the ingress reads (through the binary).
pub const ENV: &[EnvVar] = &[
    EnvVar::new(
        "TWITCH_EVENTSUB_SECRET",
        "HMAC key of the EventSub webhook (also the secret of the subscriptions created)",
    )
    .secret(),
    EnvVar::new(
        "TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS",
        "how long a non-journaled notification's message id is remembered (at least 300)",
    )
    .with_default("600"),
    EnvVar::new(
        "TWITCH_EVENTSUB_MESSAGE_MAX_AGE_MS",
        "how old (or how far ahead) a delivery's timestamp may be (at least 60000)",
    )
    .with_default("600000"),
    EnvVar::new(
        "TWITCH_EVENTSUB_RETRY_MAX_AGE_MS",
        "how old a retried, journaled notification may be (at least the max age)",
    )
    .with_default("86400000"),
];

/// Everything the ingress needs to know.
#[derive(Clone)]
pub struct IngressConfig {
    /// `TWITCH_EVENTSUB_SECRET`, as the HMAC key (its UTF-8 bytes).
    pub secret: SecretBytes,
    /// `EVENTSUB_MESSAGE_DEDUPE_TTL_SECONDS`: `Math.max(300, Number(x || 600))`. A key lives at
    /// least as long as its message could still pass the timestamp check (see
    /// `super::dedupe`).
    pub dedupe_ttl_seconds: u64,
    /// `EVENTSUB_MESSAGE_MAX_AGE_MS`: `Math.max(60_000, Number(x || 600_000))`, Twitch's ten
    /// minutes by default, in both directions.
    pub max_age_ms: f64,
    /// `EVENTSUB_RETRY_MAX_AGE_MS`: `Math.max(maxAge, Number(x || 86_400_000))`: how old a signed
    /// retry of a journaled type may be.
    pub retry_max_age_ms: f64,
    /// Prepended to every Dragonfly key the ingress writes (empty in production; tests isolate
    /// themselves with it).
    pub key_prefix: String,
    /// The body limit ([`BODY_LIMIT`]).
    pub body_limit: usize,
    /// The longest accepted `Twitch-Eventsub-Message-Id` (Twitch sends a UUID, 36 bytes).
    pub max_message_id_bytes: usize,
    /// The longest accepted `Twitch-Eventsub-Message-Timestamp` (RFC 3339 with nanoseconds is 30
    /// bytes).
    pub max_timestamp_bytes: usize,
    /// The longest accepted `Twitch-Eventsub-Message-Retry` and `-Type` values.
    pub max_short_header_bytes: usize,
    /// Requests handled at once, from the request head to the answer (bodies being read
    /// included, so at most this many bodies are in memory). Twitch's deliveries take a few
    /// milliseconds each; 512 at once is far above what tens of thousands of channels send.
    pub max_in_flight: usize,
    /// How long a request waits for a place before it is answered 503 (Twitch retries it).
    pub admission_wait: Duration,
    /// Time allowed for the body after the request head. Twitch sends a few kilobytes at once.
    pub body_deadline: Duration,
    /// Time allowed for the work before a journaled notification is answered: the raid filter,
    /// the owner lookup and the journal write. Twitch counts a delivery as failed after a few
    /// seconds and redelivers it; a write that completes after this is found by the
    /// redelivery (the unique event key), so nothing is lost or doubled.
    pub durable_deadline: Duration,
    /// Time allowed for the message-id claim of a non-journaled notification (after the answer).
    pub dedupe_deadline: Duration,
    /// Time allowed for writing a dead-letter record (before the answer).
    pub dead_letter_deadline: Duration,
    /// Dead-letter records kept (newest first).
    pub dead_letter_max: usize,
    /// Bytes of a dead-lettered body kept in its record (cut on a character boundary).
    pub dead_letter_body_bytes: usize,
    /// How long the dead-letter list lives after its last record (30 days).
    pub dead_letter_ttl_seconds: u64,
    /// How long to wait for the answer to be written before processing anyway (the exchange's
    /// end is normally microseconds away; this only covers a connection that never reports it).
    pub answer_wait: Duration,
}

impl fmt::Debug for IngressConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IngressConfig")
            .field("secret", &"<redacted>")
            .field("dedupe_ttl_seconds", &self.dedupe_ttl_seconds)
            .field("max_age_ms", &self.max_age_ms)
            .field("retry_max_age_ms", &self.retry_max_age_ms)
            .field("key_prefix", &self.key_prefix)
            .field("body_limit", &self.body_limit)
            .field("max_in_flight", &self.max_in_flight)
            .finish_non_exhaustive()
    }
}

fn finite_or(value: f64, default: f64) -> f64 {
    if value.is_finite() { value } else { default }
}

impl IngressConfig {
    /// From the raw variables (`None` when unset). An empty or missing secret is the
    /// reference's start-up error (`TWITCH_EVENTSUB_SECRET is not set`).
    pub fn from_env_values(
        secret: Option<&str>,
        dedupe_ttl_seconds: Option<&str>,
        max_age_ms: Option<&str>,
        retry_max_age_ms: Option<&str>,
    ) -> Result<Self, EnvError> {
        let secret = match secret {
            Some(secret) if !secret.is_empty() => SecretString::new(secret.to_owned()),
            _ => {
                return Err(EnvError::Missing {
                    name: "TWITCH_EVENTSUB_SECRET".to_owned(),
                });
            }
        };
        let ttl = finite_or(max_number_or(dedupe_ttl_seconds, 300.0, 600.0), 600.0);
        let max_age = finite_or(max_number_or(max_age_ms, 60_000.0, 600_000.0), 600_000.0);
        let retry_max_age = finite_or(
            math_max(max_age, number_or(retry_max_age_ms, 86_400_000.0)),
            86_400_000.0_f64.max(max_age),
        );
        Ok(Self::with_secret(secret)
            .with_dedupe_ttl(ttl.ceil().min(u64::MAX as f64) as u64)
            .with_max_age(max_age, retry_max_age))
    }

    /// The reference's defaults with `secret`.
    pub fn with_secret(secret: SecretString) -> Self {
        Self {
            secret: secret.to_bytes(),
            dedupe_ttl_seconds: 600,
            max_age_ms: 600_000.0,
            retry_max_age_ms: 86_400_000.0,
            key_prefix: String::new(),
            body_limit: BODY_LIMIT,
            max_message_id_bytes: 128,
            max_timestamp_bytes: 64,
            max_short_header_bytes: 64,
            max_in_flight: 512,
            admission_wait: Duration::from_secs(1),
            body_deadline: Duration::from_secs(10),
            durable_deadline: Duration::from_secs(4),
            dedupe_deadline: Duration::from_secs(2),
            dead_letter_deadline: Duration::from_secs(1),
            dead_letter_max: 1000,
            dead_letter_body_bytes: 8 * 1024,
            dead_letter_ttl_seconds: 30 * 24 * 60 * 60,
            answer_wait: Duration::from_secs(5),
        }
    }

    fn with_dedupe_ttl(mut self, seconds: u64) -> Self {
        self.dedupe_ttl_seconds = seconds;
        self
    }

    fn with_max_age(mut self, max_age_ms: f64, retry_max_age_ms: f64) -> Self {
        self.max_age_ms = max_age_ms;
        self.retry_max_age_ms = retry_max_age_ms;
        self
    }

    /// How the server on [`EVENTSUB_PORT`] should run: Node's keep-alive (Twitch reuses its
    /// connections), short head and request deadlines (Twitch sends a few kilobytes at once, so
    /// a slow sender is not Twitch), and 2,048 connections at most. The reference used Node's
    /// defaults (60 s, 300 s, no connection cap).
    pub fn serve_options(&self) -> ServeOptions {
        ServeOptions {
            header_read_timeout: Duration::from_secs(10),
            request_timeout: self.body_deadline + Duration::from_secs(5),
            keep_alive_timeout: Duration::from_secs(5),
            max_connections: 2048,
            max_streams: 1,
            drain_timeout: Duration::from_secs(10),
            write_stall_timeout: Duration::from_secs(10),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variables_parse_like_the_reference() {
        let config = IngressConfig::from_env_values(Some("s3cret-value"), None, None, None)
            .unwrap_or_else(|_| IngressConfig::with_secret(SecretString::new(String::new())));
        assert_eq!(config.dedupe_ttl_seconds, 600);
        assert_eq!(config.max_age_ms, 600_000.0);
        assert_eq!(config.retry_max_age_ms, 86_400_000.0);
        let config = IngressConfig::from_env_values(Some("x"), Some("10"), Some("1000"), Some("5"))
            .unwrap_or_else(|_| IngressConfig::with_secret(SecretString::new(String::new())));
        assert_eq!(config.dedupe_ttl_seconds, 300);
        assert_eq!(config.max_age_ms, 60_000.0);
        assert_eq!(config.retry_max_age_ms, 60_000.0);
        let config = IngressConfig::from_env_values(
            Some("x"),
            Some("not a number"),
            Some("0"),
            Some("0x10"),
        )
        .unwrap_or_else(|_| IngressConfig::with_secret(SecretString::new(String::new())));
        // `Number('not a number')` is NaN: the default instead of the reference's NaN.
        assert_eq!(config.dedupe_ttl_seconds, 600);
        // `Number('0' || 600000)`: '0' is truthy text, so 0, then the minimum.
        assert_eq!(config.max_age_ms, 60_000.0);
        assert_eq!(config.retry_max_age_ms, 60_000.0);
    }

    #[test]
    fn the_secret_is_required() {
        assert!(matches!(
            IngressConfig::from_env_values(None, None, None, None),
            Err(EnvError::Missing { .. })
        ));
        assert!(IngressConfig::from_env_values(Some(""), None, None, None).is_err());
    }

    #[test]
    fn the_secret_never_prints() {
        let config = IngressConfig::with_secret(SecretString::new("do-not-print-me".to_owned()));
        assert!(!format!("{config:?}").contains("do-not-print-me"));
    }
}
