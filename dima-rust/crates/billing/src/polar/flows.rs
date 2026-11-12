//! Sending AI usage and credit grants to Polar: `ingestPolarSHEvent`, `grantPolarAiCredits` and
//! `ingestPolarNamedEvents` of `dimabot/src/utils/polarsh.ts`.
//!
//! **Modes.** `immediate` sends the one event and projects it once Polar stored it. `batch` and
//! `cache` queue the event first (an interrupted send never loses it), project it, then `batch`
//! flushes the channel's whole queue while it holds the channel lock; `cache` leaves the flush to
//! the next `batch` call. Only one process flushes a channel at a time; a caller that cannot take
//! the lock within 2.5 s queues and returns. A flush removes exactly what it sent (`LTRIM`), so
//! events queued meanwhile survive; an incomplete answer leaves the queue as it is, and the next
//! flush resends it all (Polar drops duplicates by `external_id`).
//!
//! Timings are the reference's: lock `PX 8000`, a retry every 350 ms for at most 2,500 ms.
//!
//! Keys: `twitch:{channel}:ai:polarshevent` (list) is **drained** at cutover (it holds unsent
//! usage, which is money: the TypeScript processes flush it before they stop); the queued value is
//! Rust's own JSON of the event, and the reference's legacy single-string format is not read
//! (intended: only Rust writes this key family after cutover). `locks:polar-ingest:{channel}` is
//! rebuilt (it expires).
//!
//! Quirk kept: an event whose metadata the Polar SDK refuses (a `null` value, which a `NaN` cost
//! becomes) stays queued and makes every later flush of that channel fail until it is removed by
//! hand; the reference behaves the same way.

use super::{
    GrantInput, GrantRefused, UsageEventInput, build_grant_event, build_usage_event,
    check_named_events,
};
use super::{IngestEvent, PolarClient, PolarError};
use crate::Observer;
use crate::plans::credits_cache::CreditsCache;
use crate::usage::AiUsageContext;
use dima_core::Random;
use dima_model::Private;
use dima_store::dragonfly::{Dragonfly, SetCondition, SetExpiry, SetOptions, SetOutcome};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::time::Duration;

/// `INGEST_LOCK_TTL_MS`.
pub const INGEST_LOCK_TTL_MS: u64 = 8000;
/// `INGEST_LOCK_MAX_WAIT_MS`.
pub const INGEST_LOCK_MAX_WAIT: Duration = Duration::from_millis(2500);
/// `INGEST_LOCK_RETRY_MS`.
pub const INGEST_LOCK_RETRY: Duration = Duration::from_millis(350);

/// `mode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IngestMode {
    /// Send now.
    Immediate,
    /// Queue, then flush the channel's queue (the default).
    #[default]
    Batch,
    /// Queue only.
    Cache,
}

/// One accepted usage, for the receipt ledger (`buildQueuedAiUsageReceipt` input).
#[derive(Clone, Copy, Debug)]
pub struct AcceptedUsage<'a> {
    /// Twitch channel id.
    pub channel_id: &'a str,
    /// Polar customer id.
    pub customer_id: &'a Private<String>,
    /// The usage context.
    pub context: &'a AiUsageContext,
    /// Credits (negative for a grant).
    pub credits: f64,
}

/// Where accepted usage goes besides Polar: the receipt queue (`enqueueAiUsageReceipt`, the second
/// half of this crate) and analytics (`trackAiUsageRecorded`). Failures are logged by the caller
/// and never undo an accepted ingest.
pub trait UsageSink: Send + Sync {
    /// Queues a receipt.
    fn enqueue_receipt<'a>(&'a self, usage: AcceptedUsage<'a>)
    -> BoxFuture<'a, Result<(), String>>;
    /// Records the analytics event (best effort).
    fn track(&self, usage: AcceptedUsage<'_>, metadata: &Map<String, Value>);
}

/// What `ingestPolarSHEvent` and `grantPolarAiCredits` answer (`{error, message}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IngestOutcome {
    /// Accepted (sent, or queued for the next flush).
    Done {
        /// `"queued (flush in progress)"` when the lock was busy.
        message: Option<&'static str>,
    },
    /// `{error: true, message}` with the reference's message (Polar errors without their body):
    /// Polar did not apply it (refused before sending, or answered that it refused it).
    Failed {
        /// The message.
        message: String,
    },
    /// `{error: true, message}` in the reference too, but Polar may have applied it: the
    /// request was sent and no usable answer came (a lost reply, a 5xx, a success answer that
    /// cannot be read). Retry only with the same external id, which Polar deduplicates; never
    /// with a new one (item 7 of P2-BILLING-01b).
    OutcomeUnknown {
        /// The message.
        message: String,
    },
}

impl IngestOutcome {
    /// `{error}` of the reference's answer.
    pub fn is_error(&self) -> bool {
        !matches!(self, Self::Done { .. })
    }
}

fn failed(message: impl Into<String>) -> IngestOutcome {
    IngestOutcome::Failed {
        message: message.into(),
    }
}

/// The outcome of a Polar call that failed: unknown when Polar may have applied it.
fn polar_failure(error: &PolarError) -> IngestOutcome {
    let message = polar_message(error);
    if error.outcome_unknown() {
        IngestOutcome::OutcomeUnknown { message }
    } else {
        IngestOutcome::Failed { message }
    }
}

/// Why `ingestPolarNamedEvents` failed (the reference threw with these messages).
#[derive(Debug, thiserror::Error)]
pub enum NamedIngestError {
    /// Refused before anything was sent.
    #[error("{0}")]
    Refused(&'static str),
    /// Polar stored fewer events than were sent; resend them with the same external ids.
    #[error("PolarSH ingest incomplete ({} inserted, {} duplicates of {expected})", dima_text::number_to_string(*inserted), dima_text::number_to_string(*duplicates))]
    Incomplete {
        /// `inserted`.
        inserted: f64,
        /// `duplicates`.
        duplicates: f64,
        /// Events sent.
        expected: usize,
    },
    /// Polar failed.
    #[error(transparent)]
    Polar(#[from] PolarError),
}

impl NamedIngestError {
    /// Polar may have stored some or all of the events.
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Refused(_) => false,
            Self::Incomplete { .. } => true,
            Self::Polar(error) => error.outcome_unknown(),
        }
    }
}

/// The ingest flows.
#[derive(Clone, Copy)]
pub struct Ingest<'a> {
    /// Polar.
    pub polar: &'a PolarClient,
    /// Dragonfly (queue and lock).
    pub dragonfly: &'a Dragonfly,
    /// The local credit projection.
    pub credits: &'a CreditsCache,
    /// Receipts and analytics.
    pub sink: &'a dyn UsageSink,
    /// Ids and lock values.
    pub random: &'a dyn Random,
    /// Errors the flows recover from.
    pub observer: &'a dyn Observer,
}

impl std::fmt::Debug for Ingest<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ingest")
    }
}

fn queue_key(channel: &str) -> String {
    format!("twitch:{channel}:ai:polarshevent")
}

fn queued_text(event: &IngestEvent) -> String {
    let mut map = Map::new();
    map.insert("name".into(), Value::from(event.name.as_str()));
    map.insert(
        "customerId".into(),
        Value::from(event.customer_id.expose().as_str()),
    );
    map.insert("externalId".into(), Value::from(event.external_id.as_str()));
    map.insert("metadata".into(), Value::Object(event.metadata.clone()));
    dima_text::to_js_json(&Value::Object(map))
}

fn queued_event(text: &[u8]) -> Option<IngestEvent> {
    let value: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(text)).ok()?;
    let object = value.as_object()?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(IngestEvent {
        name: text("name")?,
        customer_id: Private::new(text("customerId")?),
        external_id: text("externalId")?,
        metadata: object
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

fn polar_message(error: &PolarError) -> String {
    error.to_string()
}

impl Ingest<'_> {
    async fn project(&self, event: &IngestEvent, context: &AiUsageContext, channel: Option<&str>) {
        let credits = crate::js::number(event.metadata.get("credits"));
        if let Err(error) = self
            .credits
            .record_ai_credit_usage(channel.unwrap_or(""), credits, Some(&event.external_id))
            .await
        {
            self.observer.error(
                "recordAiCreditUsage",
                &format!("local credit projection failed: {error}"),
            );
        }
        let usage = AcceptedUsage {
            channel_id: channel.unwrap_or(""),
            customer_id: &event.customer_id,
            context,
            credits,
        };
        if channel.is_some_and(|c| !c.is_empty())
            && let Err(error) = self.sink.enqueue_receipt(usage).await
        {
            self.observer.error("projectAcceptedUsage", &error);
        }
        self.sink.track(usage, &event.metadata);
    }

    async fn acquire(&self, key: &str) -> Result<Option<String>, String> {
        let value = self.random.uuid_v4().map_err(|e| e.to_string())?;
        let started = tokio::time::Instant::now();
        loop {
            let options = SetOptions {
                condition: SetCondition::IfMissing,
                expiry: SetExpiry::Millis(INGEST_LOCK_TTL_MS),
                get: false,
            };
            match self
                .dragonfly
                .set(key, value.as_bytes(), options)
                .await
                .map_err(|e| e.to_string())?
            {
                SetOutcome::Written => return Ok(Some(value)),
                _ => {
                    tokio::time::sleep(INGEST_LOCK_RETRY).await;
                    if started.elapsed() >= INGEST_LOCK_MAX_WAIT {
                        return Ok(None);
                    }
                }
            }
        }
    }

    async fn release(&self, key: &str, value: &str) {
        // The reference's GET then DEL (not atomic): the lock expires on its own anyway.
        if let Ok(Some(current)) = self.dragonfly.get_text(key).await
            && current == value
        {
            let _ = self.dragonfly.del(&[key]).await;
        }
    }

    /// `ingestPolarSHEvent(options)`.
    pub async fn ingest_usage(&self, input: &UsageEventInput, mode: IngestMode) -> IngestOutcome {
        if input.customer_id.expose().is_empty() {
            return failed("customerId is required");
        }
        let channel = input.channel_id.as_deref().filter(|c| !c.is_empty());
        if mode != IngestMode::Immediate && channel.is_none() {
            return failed("channelID is required for batch/cache modes");
        }
        let (event, context) = match build_usage_event(input, self.random) {
            Ok(built) => built,
            Err(error) => return failed(error.to_string()),
        };
        if mode == IngestMode::Immediate {
            return match self.polar.ingest_events(std::slice::from_ref(&event)).await {
                Ok(result) if result.is_complete(1) => {
                    self.project(&event, &context, channel).await;
                    IngestOutcome::Done { message: None }
                }
                Ok(_) => failed("PolarSH ingest incomplete"),
                Err(error) => polar_failure(&error),
            };
        }
        let Some(channel) = channel else {
            return failed("channelID is required for batch/cache modes");
        };
        let queue = queue_key(channel);
        let lock_key = format!("locks:polar-ingest:{channel}");
        let text = queued_text(&event);
        let lock = match self.acquire(&lock_key).await {
            Ok(lock) => lock,
            Err(message) => return failed(message),
        };
        let Some(lock) = lock else {
            if let Err(error) = self.dragonfly.rpush(&queue, &[text.as_bytes()]).await {
                self.observer.error(
                    "ingestPolarSHEvent",
                    &format!("Failed to queue AI event while flush in progress: {error}"),
                );
                return failed("Failed to queue AI event");
            }
            self.project(&event, &context, Some(channel)).await;
            return IngestOutcome::Done {
                message: Some("queued (flush in progress)"),
            };
        };
        let outcome = self
            .queue_and_flush(&queue, &text, &event, &context, channel, mode)
            .await;
        self.release(&lock_key, &lock).await;
        outcome
    }

    async fn queue_and_flush(
        &self,
        queue: &str,
        text: &str,
        event: &IngestEvent,
        context: &AiUsageContext,
        channel: &str,
        mode: IngestMode,
    ) -> IngestOutcome {
        if let Err(error) = self.dragonfly.rpush(queue, &[text.as_bytes()]).await {
            return failed(error.to_string());
        }
        self.project(event, context, Some(channel)).await;
        if mode == IngestMode::Cache {
            return IngestOutcome::Done { message: None };
        }
        let pending: Vec<Vec<u8>> = match self
            .dragonfly
            .query(redis::cmd("LRANGE").arg(queue).arg(0).arg(-1))
            .await
        {
            Ok(pending) => pending,
            Err(error) => return failed(error.to_string()),
        };
        if pending.is_empty() {
            return IngestOutcome::Done { message: None };
        }
        let events: Vec<IngestEvent> = pending.iter().filter_map(|raw| queued_event(raw)).collect();
        if events.is_empty() {
            return match self.dragonfly.del(&[queue]).await {
                Ok(_) => IngestOutcome::Done { message: None },
                Err(error) => failed(error.to_string()),
            };
        }
        match self.polar.ingest_events(&events).await {
            Ok(result) if result.is_complete(events.len()) => {}
            Ok(_) => {
                self.observer.error(
                    "ingestPolarSHEvent",
                    &format!("PolarSH ingest incomplete ({} expected)", events.len()),
                );
                return failed("PolarSH ingest incomplete");
            }
            Err(error) => {
                self.observer
                    .error("ingestPolarSHEvent", &polar_message(&error));
                return polar_failure(&error);
            }
        }
        // Remove exactly the events sent; events queued during the ingest survive.
        let start = i64::try_from(pending.len()).unwrap_or(i64::MAX);
        match self
            .dragonfly
            .query::<()>(redis::cmd("LTRIM").arg(queue).arg(start).arg(-1))
            .await
        {
            Ok(()) => IngestOutcome::Done { message: None },
            Err(error) => failed(error.to_string()),
        }
    }

    /// `grantPolarAiCredits(options)`. The grant's identity is the caller's
    /// [`super::OperationId`]: calling again with the same input after a lost reply
    /// ([`IngestOutcome::OutcomeUnknown`]), or after a restart, repeats the same grant, which
    /// Polar deduplicates by `external_id`.
    pub async fn grant_ai_credits(&self, input: &GrantInput) -> IngestOutcome {
        let (event, context, credits) = match build_grant_event(input) {
            Ok(built) => built,
            Err(refused @ (GrantRefused::MissingCustomer | GrantRefused::NotPositive)) => {
                return failed(refused.to_string());
            }
        };
        match self.polar.ingest_events(std::slice::from_ref(&event)).await {
            Ok(result) if result.is_complete(1) => {}
            Ok(_) => return failed("PolarSH grant credits ingest incomplete"),
            Err(error) => {
                self.observer
                    .error("grantPolarAiCredits", &polar_message(&error));
                return polar_failure(&error);
            }
        }
        let channel = input.channel_id.as_deref().filter(|c| !c.is_empty());
        let usage = AcceptedUsage {
            channel_id: channel.unwrap_or(""),
            customer_id: &input.customer_id,
            context: &context,
            credits: -credits,
        };
        self.sink.track(usage, &event.metadata);
        if channel.is_some()
            && let Err(error) = self.sink.enqueue_receipt(usage).await
        {
            self.observer.error("grantPolarAiCredits.receipt", &error);
        }
        IngestOutcome::Done { message: None }
    }

    /// `ingestPolarNamedEvents(events)`: `(inserted, duplicates)`.
    pub async fn ingest_named_events(
        &self,
        events: &[IngestEvent],
    ) -> Result<(f64, f64), NamedIngestError> {
        if events.is_empty() {
            return Ok((0.0, 0.0));
        }
        check_named_events(events).map_err(NamedIngestError::Refused)?;
        let result = self.polar.ingest_events(events).await?;
        if !result.is_complete(events.len()) {
            return Err(NamedIngestError::Incomplete {
                inserted: result.inserted,
                duplicates: result.duplicates,
                expected: events.len(),
            });
        }
        Ok((result.inserted, result.duplicates))
    }
}
