//! Charging an answer: `trackUsage` of `utils/ai/openrouter/ai.ts` (lines 617–692).
//!
//! # What the reference does
//!
//! For every provider round that returned `usage` (the round's `usage` object, and a channel):
//!
//! 1. `HINCRBY {channel}:chatbot:usage` `total_tokens`, `prompt_tokens`, `completion_tokens`
//!    (each `|| 0`), then `EXPIRE` it until "the next month" (`30 - day of month` days minus
//!    the time of day, at least an hour). An error is logged and the rest skipped.
//! 2. When the streamer has a Polar customer: `ingestPolarSHEvent` in `batch` mode with the
//!    cost `upstream_inference_prompt_cost + upstream_inference_completions_cost` (each `|| 0`),
//!    the legacy `reason`, the model and the usage, and the receipt context `{requestId,
//!    parentRequestId, source: source ?? "chat", provider: "openrouter", resourceType:
//!    "llm_generation"}`. With `awaitIngest` (pets, the desktop, standalone text with a usage
//!    id) the event's external id is the request id, the call is awaited and a failure throws
//!    "AI usage recording unavailable"; otherwise (the AI chat, `$(ai)`, miyuloot) the call is
//!    **not awaited**: the answer is returned while the event may not be queued yet, and the
//!    external id is a fresh `aiu_<uuid>` drawn inside the ingest.
//!
//! Without a customer nothing is sent to Polar and nothing is debited locally: such a channel
//! is never charged (kept).
//!
//! # What this module does, and why
//!
//! The same event (same metadata, same cost, same credits: `Math.ceil(costCents * 1000)`, built
//! by `dima_billing::polar::build_usage_event`), with three changes that close the reference's
//! ways of losing a charge:
//!
//! - **The event is queued before the answer goes out.** Without `awaitIngest` the event is
//!   queued (`IngestMode::Cache`: `RPUSH` to `twitch:{channel}:ai:polarshevent`, then the local
//!   debit with its hold and the receipt) and awaited; the flush to Polar then runs detached, as
//!   the reference's unawaited `batch` did, and a busy or failed flush leaves the event queued
//!   for the next one (every later usage of the channel and the cron's quiet-queue flush drain
//!   it). The reference could post the answer and die before its event was queued.
//! - **Charging is not cancelled with its caller.** It runs on the service's task tracker; a
//!   caller dropped at the message's deadline cannot stop it between the `RPUSH` and the local
//!   debit.
//! - **The event comes first, the statistics second.** The token counters (an internal cache,
//!   *rebuilt* at cutover) are written after the event is queued, so their failure or slowness
//!   cannot delay or lose the money.
//!
//! The external id is still `aiu_<uuid>`, drawn when the event is built (before it is queued:
//! a resend of the queued bytes keeps it, so Polar deduplicates a resend), or the request id
//! with `awaitIngest`.

use super::service::{AiService, StreamerData};
use dima_billing::polar::{IngestMode, IngestOutcome, LlmUsage, UsageEventInput};
use dima_billing::usage::{AiUsageContextInput, ResourceType};
use serde_json::Value;
use std::sync::Arc;

/// `policy` of `trackUsage`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UsagePolicy {
    /// `source` of the receipt (`"chat"` when `None`).
    pub source: Option<String>,
    /// `awaitIngest`: the external id is the request id, the whole ingest (queue and flush) is
    /// awaited, and its failure fails the call.
    pub await_ingest: bool,
}

/// One round's usage to charge.
#[derive(Clone, Debug)]
pub struct UsageCharge {
    /// The channel.
    pub channel_id: String,
    /// Who pays.
    pub streamer: StreamerData,
    /// The provider's `usage` object.
    pub usage: Value,
    /// The model the round used.
    pub model: String,
    /// The legacy reason (`harness_end`, `harness_tools`, `miyuloot_insult`, ...).
    pub reason: String,
    /// `requestId` (the round's id).
    pub request_id: String,
    /// `parentRequestId` (the session).
    pub parent_request_id: String,
    /// The policy.
    pub policy: UsagePolicy,
}

/// What [`AiService::track_usage`] did.
#[derive(Clone, Debug, PartialEq)]
pub enum UsageOutcome {
    /// No usage or no channel: nothing to do.
    Skipped,
    /// The streamer has no Polar customer: counted in the statistics only (never charged, as
    /// in the reference).
    NoCustomer,
    /// The event is queued (or, with `awaitIngest`, accepted), the local debit applied.
    Charged {
        /// The event's external id.
        external_id: String,
        /// Its credits.
        credits: f64,
    },
    /// The event could not be queued (logged): the reference's unawaited ingest failed the same
    /// way, silently. Only without `awaitIngest`.
    Lost {
        /// Why.
        message: String,
    },
}

/// `awaitIngest` was set and the ingest failed: "AI usage recording unavailable".
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("AI usage recording unavailable")]
pub struct RecordingUnavailable;

/// `(usage.cost_details?.upstream_inference_prompt_cost || 0) +
/// (usage.cost_details?.upstream_inference_completions_cost || 0)`, in dollars.
///
/// Intended difference: a cost that is not a JSON number counts 0 (JavaScript would add text
/// to a number); OpenRouter sends numbers.
pub fn upstream_cost(usage: &Value) -> f64 {
    let part = |name: &str| {
        usage
            .get("cost_details")
            .and_then(|details| details.get(name))
            .and_then(Value::as_f64)
            .filter(|x| *x != 0.0 && !x.is_nan())
            .unwrap_or(0.0)
    };
    part("upstream_inference_prompt_cost") + part("upstream_inference_completions_cost")
}

fn token(usage: &Value, name: &str) -> Option<f64> {
    usage.get(name).and_then(Value::as_f64)
}

/// The Polar event input `trackUsage` passes to `ingestPolarSHEvent`.
pub fn usage_event_input(charge: &UsageCharge, customer_id: &str) -> UsageEventInput {
    UsageEventInput {
        customer_id: customer_id.to_owned().into(),
        channel_id: Some(charge.channel_id.clone()),
        external_id: charge
            .policy
            .await_ingest
            .then(|| charge.request_id.clone()),
        cost: upstream_cost(&charge.usage),
        reason: charge.reason.clone(),
        llm: Some(LlmUsage {
            model: charge.model.clone(),
            prompt_tokens: token(&charge.usage, "prompt_tokens"),
            completion_tokens: token(&charge.usage, "completion_tokens"),
            total_tokens: token(&charge.usage, "total_tokens"),
        }),
        tts_cost: None,
        characters: None,
        usage: Some(AiUsageContextInput {
            request_id: Some(charge.request_id.clone()),
            parent_request_id: Some(charge.parent_request_id.clone()),
            source: Some(
                charge
                    .policy
                    .source
                    .clone()
                    .unwrap_or_else(|| "chat".to_owned()),
            ),
            provider: Some("openrouter".to_owned()),
            resource_type: Some(ResourceType::LlmGeneration),
            ..AiUsageContextInput::default()
        }),
    }
}

/// `generateTimeLeftToNextMonthInSeconds()`, in UTC (the containers run in UTC): `30 - day`
/// days, minus the hours, minutes and seconds of the day, minus the **milliseconds counted as
/// seconds** (the reference's slip, kept: it only shortens a statistics key's life by up to 999
/// seconds), at least an hour.
pub fn seconds_to_next_month(now_ms: i64) -> i64 {
    let fields = dima_text::utc_fields(now_ms);
    let (day, hours, minutes, seconds, millis) = match fields {
        Some(f) => (
            i64::from(f.day),
            i64::from(f.hour),
            i64::from(f.minute),
            i64::from(f.second),
            i64::from(f.millisecond),
        ),
        None => return 3600,
    };
    let left = (30 - day) * 24 * 3600 - hours * 3600 - minutes * 60 - seconds - millis;
    left.max(3600)
}

impl AiService {
    /// `trackUsage(...)`: charges one round (see the module docs). Runs detached: dropping the
    /// returned future does not stop the charge.
    pub async fn track_usage(
        self: &Arc<Self>,
        charge: UsageCharge,
    ) -> Result<UsageOutcome, RecordingUnavailable> {
        if charge.channel_id.is_empty() || !dima_text::js_truthy(&charge.usage) {
            return Ok(UsageOutcome::Skipped);
        }
        let service = Arc::clone(self);
        let handle = self
            .tasks
            .spawn(async move { service.charge_detached(charge).await });
        match handle.await {
            Ok(outcome) => outcome,
            // Only a panic inside the charge (never expected); its event state is whatever the
            // billing crate left, which a resend repairs.
            Err(_) => Err(RecordingUnavailable),
        }
    }

    async fn charge_detached(
        self: Arc<Self>,
        charge: UsageCharge,
    ) -> Result<UsageOutcome, RecordingUnavailable> {
        let outcome = match charge.streamer.customer_id() {
            None => Ok(UsageOutcome::NoCustomer),
            Some(customer) => self.queue_charge(&charge, customer).await,
        };
        self.count_tokens(&charge).await;
        outcome
    }

    async fn queue_charge(
        self: &Arc<Self>,
        charge: &UsageCharge,
        customer: &str,
    ) -> Result<UsageOutcome, RecordingUnavailable> {
        let mut input = usage_event_input(charge, customer);
        // The id is drawn here (as the ingest would) so the outcome can name it; it travels in
        // the queued bytes and is the same on every resend.
        if input.external_id.is_none() {
            match self.deps.random.uuid_v4() {
                Ok(id) => input.external_id = Some(format!("aiu_{id}")),
                Err(_) => {
                    self.log_charge_failure(charge, "no randomness for the usage id");
                    return if charge.policy.await_ingest {
                        Err(RecordingUnavailable)
                    } else {
                        Ok(UsageOutcome::Lost {
                            message: "no randomness for the usage id".into(),
                        })
                    };
                }
            }
        }
        let external_id = input.external_id.clone().unwrap_or_default();
        let credits = dima_billing::polar::build_usage_event(&input, self.deps.random.as_ref())
            .map(|(event, _)| dima_billing::js::number(event.metadata.get("credits")))
            .unwrap_or(f64::NAN);
        let mode = if charge.policy.await_ingest {
            IngestMode::Batch
        } else {
            IngestMode::Cache
        };
        let ingested = tokio::time::timeout(
            self.deps.config.usage_deadline,
            self.ingest().ingest_usage(&input, mode),
        )
        .await;
        let outcome = match ingested {
            Ok(outcome) => outcome,
            Err(_) => IngestOutcome::OutcomeUnknown {
                message: "usage ingest timed out".into(),
            },
        };
        if charge.policy.await_ingest {
            return match outcome {
                IngestOutcome::Done { .. } => Ok(UsageOutcome::Charged {
                    external_id,
                    credits,
                }),
                _ => {
                    self.log_charge_failure(charge, "usage ingest failed");
                    Err(RecordingUnavailable)
                }
            };
        }
        match outcome {
            IngestOutcome::Done { .. } => {
                self.flush_detached(&charge.channel_id);
                Ok(UsageOutcome::Charged {
                    external_id,
                    credits,
                })
            }
            IngestOutcome::Failed { message } | IngestOutcome::OutcomeUnknown { message } => {
                self.log_charge_failure(charge, &message);
                Ok(UsageOutcome::Lost { message })
            }
        }
    }

    /// The reference's `batch` flush, after the event is queued: detached, best effort (the
    /// event stays queued when the flush is busy or fails).
    fn flush_detached(self: &Arc<Self>, channel_id: &str) {
        let service = Arc::clone(self);
        let channel = channel_id.to_owned();
        self.tasks.spawn(async move {
            let report = service.ingest().flush(&channel).await;
            let _ = report;
        });
    }

    fn log_charge_failure(&self, charge: &UsageCharge, message: &str) {
        self.log_error(
            &serde_json::json!({
                "function": "trackUsage",
                "error": "AI usage could not be queued",
                "detail": message,
                "model": charge.model,
                "reason": charge.reason,
                "requestId": charge.request_id,
            }),
            &charge.channel_id,
        );
    }

    /// The token counters of `{channel}:chatbot:usage` (step 1 of the reference), one command
    /// at a time as the reference sends them; the first error is logged and ends the update.
    async fn count_tokens(&self, charge: &UsageCharge) {
        let key = self.key(format_args!("{}:chatbot:usage", charge.channel_id));
        let deadline = self.deps.config.store_deadline;
        let ttl = seconds_to_next_month(self.deps.clock.now_ms());
        let mut commands = Vec::with_capacity(4);
        for field in ["total_tokens", "prompt_tokens", "completion_tokens"] {
            // `usageData[field] || 0`: HINCRBY takes an integer; anything else is the
            // reference's Redis error (logged, the rest skipped).
            let increment = match charge.usage.get(field) {
                None | Some(Value::Null) => Some(0),
                Some(value) => match value.as_f64() {
                    Some(x) if x.is_nan() || x == 0.0 => Some(0),
                    Some(x) if x.fract() == 0.0 && x.abs() < 9.0e15 => Some(x as i64),
                    _ => None,
                },
            };
            let Some(increment) = increment else {
                self.log_counter_failure(&charge.channel_id, "token count is not an integer");
                return;
            };
            let mut cmd = redis::cmd("HINCRBY");
            cmd.arg(&key).arg(field).arg(increment);
            commands.push(cmd);
        }
        let mut expire = redis::cmd("EXPIRE");
        expire.arg(&key).arg(ttl);
        commands.push(expire);
        for cmd in commands {
            let sent =
                tokio::time::timeout(deadline, self.deps.dragonfly.query_value(&cmd)).await;
            if !matches!(sent, Ok(Ok(_))) {
                self.log_counter_failure(&charge.channel_id, "Cache error tracking AI usage");
                return;
            }
        }
    }

    fn log_counter_failure(&self, channel_id: &str, message: &str) {
        self.log_error(
            &serde_json::json!({
                "function": "trackUsage",
                "error": "Cache error tracking AI usage",
                "err": message,
            }),
            channel_id,
        );
    }
}
