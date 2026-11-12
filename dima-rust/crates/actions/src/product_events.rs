//! Product events sent to PostHog (`/batch/`): which channels exist, commands and TTS run, AI
//! usage and AI operations. Package **P4-BOT-INGRESS**.
//!
//! TypeScript it ports (baseline `0c71108e`): `utils/posthog_events.ts` (177 lines:
//! `identifyStreamer`, `trackCommand`, `trackTts`, `trackAiUsageRecorded`, `trackAiOperation`,
//! `shutdownPosthog`), which every process loads (the API and the cron record AI usage), so it
//! lives in the crate all three binaries link. posthog-node 5.49.1 is replaced by this module's
//! own queue; the wire format is the one recorded from it (`tests/product_events_recorded.rs`).
//!
//! # Never on the caller's path
//!
//! A `track_*` call builds the event and puts it in a queue under a lock, nothing else. A task
//! ([`ProductEvents::start`]) sends batches: at most [`ProductEventsConfig::max_batch`] (100)
//! events, when [`ProductEventsConfig::flush_at`] (20) are waiting or every
//! [`ProductEventsConfig::flush_interval`] (1 s), each request bounded by 10 s with three retries 3 s
//! apart (posthog-node's `requestTimeout`, `fetchRetryCount`, `fetchRetryDelay`). The queue holds
//! at most [`ProductEventsConfig::max_queue`] (1,000, posthog-node's `maxQueueSize`): when full
//! the oldest event is dropped and counted. A batch that still fails after its retries is dropped
//! and counted. [`ProductEvents::shutdown`] sends what is queued within its deadline.
//!
//! # What is sent (the reference's properties exactly)
//!
//! - `$identify` for a channel (`distinct_id` the channel id, `$set.channel_name`), once per
//!   process and name (at most [`ProductEventsConfig::max_identified`] names remembered, then the
//!   memory starts over: an identify sent again is harmless).
//! - `command_executed`: channel id and name, the command, `success`/`error`, the chatter's id
//!   and login (the channel's when absent), the command's **arguments** as typed in chat, the
//!   error message.
//! - `tts_executed`: channel id and name, source, TTS type, character count, the **message text**
//!   that was spoken, status, mode, provider, the chatter's id and login, the error message.
//! - `ai_usage_recorded`: the usage context (ids, kind, category, operation, source, provider,
//!   model, channel, quantity, unit, resource), credits, reason, cost and token counts.
//! - `ai_operation`: request id, channel, category, operation, source, lifecycle, providers,
//!   fallback reason, error code, resource, latency.
//!
//! No token, secret or e-mail address is part of any event. Chat text is: the arguments of a
//! command and the text of a TTS message, exactly as the reference sends them (an open question
//! for the owner in the package report: nothing in the repository reads them back).
//!
//! # Differences from posthog-node
//!
//! - `$lib` is `dima-bot` with this crate's version (posthog-node wrote its own name).
//! - The queue and batching are this module's; the request (gzip JSON, `api_key`, `batch`,
//!   `sent_at`, each event's `uuid` v7, `timestamp`, `distinct_id`, `$is_server`,
//!   `$geoip_disable`) is posthog-node's.

use dima_billing::usage::AiUsageContext;
use dima_core::{Clock, Random};
use dima_http::{HttpClient, Provider, RetryPolicy};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// posthog-node's `/batch/` path.
pub const BATCH_PATH: &str = "/batch/";

/// The configuration (the reference's client options and posthog-node's defaults).
#[derive(Clone, Debug)]
pub struct ProductEventsConfig {
    /// `host` (the rig and the tests point it at a mock).
    pub base_url: String,
    /// The project key (the reference's public client key, sent as `api_key`).
    pub api_key: String,
    /// `flushInterval`: 1 s.
    pub flush_interval: Duration,
    /// `flushAt`: 20 events.
    pub flush_at: usize,
    /// `maxBatchSize`: 100 events.
    pub max_batch: usize,
    /// `maxQueueSize`: 1,000 events.
    pub max_queue: usize,
    /// `requestTimeout`: 10 s.
    pub request_timeout: Duration,
    /// `fetchRetryCount` delays: three retries, 3 s apart.
    pub retry_delays: Vec<Duration>,
    /// Channel names remembered for `identifyStreamer`.
    pub max_identified: usize,
}

impl ProductEventsConfig {
    /// The reference's endpoint, key and options.
    pub fn reference() -> Self {
        Self {
            base_url: dima_telemetry::otlp::POSTHOG_BASE_URL.to_owned(),
            api_key: dima_telemetry::otlp::POSTHOG_PROJECT_KEY.to_owned(),
            flush_interval: Duration::from_secs(1),
            flush_at: 20,
            max_batch: 100,
            max_queue: 1000,
            request_timeout: Duration::from_secs(10),
            retry_delays: vec![Duration::from_secs(3); 3],
            max_identified: 100_000,
        }
    }
}

/// `trackCommand(params)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandEvent {
    /// `channelID`.
    pub channel_id: String,
    /// `channelName`.
    pub channel_name: String,
    /// `command`.
    pub command: String,
    /// `status`: `success` or `error`.
    pub status: &'static str,
    /// `userID` (the channel's id when empty).
    pub user_id: String,
    /// `username` (the channel's name when empty).
    pub username: String,
    /// `arguments`.
    pub arguments: Option<String>,
    /// `errorMessage`.
    pub error_message: Option<String>,
}

/// `trackTts(params)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TtsEvent {
    /// `channelID`.
    pub channel_id: String,
    /// `channelName`.
    pub channel_name: String,
    /// `source`: `chat-command` or `ast`.
    pub source: &'static str,
    /// `ttsType`.
    pub tts_type: String,
    /// `characters`.
    pub characters: f64,
    /// `message`.
    pub message: String,
    /// `status`: `success` or `error`.
    pub status: &'static str,
    /// `mode`.
    pub mode: Option<String>,
    /// `provider`.
    pub provider: Option<String>,
    /// `userID` (the channel's id when empty).
    pub user_id: String,
    /// `username` (the channel's name when empty).
    pub username: String,
    /// `errorMessage`.
    pub error_message: Option<String>,
}

/// `trackAiUsageRecorded(params)`.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageRecordedEvent {
    /// `context`.
    pub context: AiUsageContext,
    /// `credits`.
    pub credits: f64,
    /// `reason`.
    pub reason: String,
    /// `polarCostAmount`.
    pub polar_cost_amount: Option<f64>,
    /// `inputTokens`.
    pub input_tokens: Option<f64>,
    /// `outputTokens`.
    pub output_tokens: Option<f64>,
    /// `totalTokens`.
    pub total_tokens: Option<f64>,
}

/// `trackAiOperation(params)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AiOperationEvent {
    /// `requestId`.
    pub request_id: String,
    /// `channelID`.
    pub channel_id: String,
    /// `category`.
    pub category: String,
    /// `operation`.
    pub operation: String,
    /// `source`.
    pub source: String,
    /// `lifecycle`: `queued`, `completed` or `failed`.
    pub lifecycle: &'static str,
    /// `requestedProvider`.
    pub requested_provider: Option<String>,
    /// `actualProvider`.
    pub actual_provider: Option<String>,
    /// `fallbackReason`.
    pub fallback_reason: Option<String>,
    /// `errorCode`.
    pub error_code: Option<String>,
    /// `resourceType`.
    pub resource_type: Option<String>,
    /// `resourceId`.
    pub resource_id: Option<String>,
    /// `latencyMs`.
    pub latency_ms: Option<f64>,
}

/// Counts since start.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProductEventsStats {
    /// Events waiting.
    pub queued: u64,
    /// Events PostHog accepted.
    pub sent: u64,
    /// Events dropped because the queue was full (the oldest).
    pub dropped_full: u64,
    /// Events dropped with a batch that failed after its retries.
    pub dropped_failed: u64,
}

/// One queued event: its JSON, ready but for `$lib` (added when built).
type Queued = Value;

struct Inner {
    config: ProductEventsConfig,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    queue: Mutex<VecDeque<Queued>>,
    wake: Notify,
    identified: Mutex<HashMap<String, String>>,
    sent: AtomicU64,
    dropped_full: AtomicU64,
    dropped_failed: AtomicU64,
}

/// The product events client (cheap to clone).
#[derive(Clone)]
pub struct ProductEvents {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ProductEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProductEvents")
            .field("base_url", &self.inner.config.base_url)
            .field("stats", &self.stats())
            .finish_non_exhaustive()
    }
}

/// `x ?? null`.
fn or_null(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

fn number(value: f64) -> Value {
    dima_text::js_number_value(value)
}

fn number_or_null(value: Option<f64>) -> Value {
    value.map_or(Value::Null, number)
}

/// `a || b` for text.
fn or_else(value: &str, fallback: &str) -> String {
    if value.is_empty() { fallback } else { value }.to_owned()
}

impl ProductEvents {
    /// A client with nothing sent yet; [`ProductEvents::start`] sends.
    pub fn new(
        config: ProductEventsConfig,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                clock,
                random,
                queue: Mutex::new(VecDeque::new()),
                wake: Notify::new(),
                identified: Mutex::new(HashMap::new()),
                sent: AtomicU64::new(0),
                dropped_full: AtomicU64::new(0),
                dropped_failed: AtomicU64::new(0),
            }),
        }
    }

    /// The PostHog provider as the binary declares it in its registry (the rig redirects it to
    /// its mock): `requestTimeout` 10 s, three retries 3 s apart on network errors and 429/5xx.
    pub fn provider(config: &ProductEventsConfig) -> dima_http::ProviderBuilder {
        Provider::builder("posthog", &config.base_url)
            .timeout(config.request_timeout)
            .max_bytes(64 * 1024)
            .retry(RetryPolicy::fetch_with_retry(&config.retry_delays))
    }

    /// Starts the sending task over `http` and `provider` ([`ProductEvents::provider`]) until
    /// `stop`; then sends what is queued, at most `final_deadline`.
    pub fn start(
        &self,
        http: HttpClient,
        provider: Provider,
        stop: dima_core::Shutdown,
        final_deadline: Duration,
    ) -> JoinHandle<()> {
        let events = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = stop.wait() => break,
                    () = events.inner.wake.notified() => {}
                    () = tokio::time::sleep(events.inner.config.flush_interval) => {}
                }
                events.send_queued(&http, &provider).await;
            }
            let _ =
                tokio::time::timeout(final_deadline, events.send_queued(&http, &provider)).await;
        })
    }

    /// Counts since start.
    pub fn stats(&self) -> ProductEventsStats {
        ProductEventsStats {
            queued: self.lock_queue().len() as u64,
            sent: self.inner.sent.load(Ordering::Relaxed),
            dropped_full: self.inner.dropped_full.load(Ordering::Relaxed),
            dropped_failed: self.inner.dropped_failed.load(Ordering::Relaxed),
        }
    }

    fn lock_queue(&self) -> std::sync::MutexGuard<'_, VecDeque<Queued>> {
        self.inner
            .queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// A UUID v7 (48-bit milliseconds, then random bits), as posthog-node gives each event.
    fn uuid_v7(&self, now_ms: i64) -> String {
        let mut bytes = [0_u8; 16];
        let millis = u64::try_from(now_ms).unwrap_or_default().to_be_bytes();
        bytes[..6].copy_from_slice(&millis[2..]);
        let mut random = [0_u8; 10];
        // A failing system random source leaves zeros: the id stays unique enough for PostHog's
        // de-duplication together with the timestamp, and the event is still sent.
        let _ = self.inner.random.fill(&mut random);
        bytes[6..].copy_from_slice(&random);
        bytes[6] = (bytes[6] & 0x0f) | 0x70;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = dima_core::crypto::encoding::encode_hex(&bytes);
        let part = |range: std::ops::Range<usize>| hex.get(range).unwrap_or_default().to_owned();
        format!(
            "{}-{}-{}-{}-{}",
            part(0..8),
            part(8..12),
            part(12..16),
            part(16..20),
            part(20..32)
        )
    }

    fn enqueue(&self, event: &str, distinct_id: &str, mut properties: Map<String, Value>) {
        properties.insert("$lib".to_owned(), Value::from("dima-bot"));
        properties.insert(
            "$lib_version".to_owned(),
            Value::from(env!("CARGO_PKG_VERSION")),
        );
        properties.insert("$is_server".to_owned(), Value::Bool(true));
        properties.insert("$geoip_disable".to_owned(), Value::Bool(true));
        let now = self.inner.clock.now_ms();
        let queued = json!({
            "event": event,
            "properties": Value::Object(properties),
            "timestamp": dima_text::to_iso_string(now).unwrap_or_default(),
            "uuid": self.uuid_v7(now),
            "distinct_id": distinct_id,
        });
        let length = {
            let mut queue = self.lock_queue();
            if queue.len() >= self.inner.config.max_queue.max(1) {
                queue.pop_front();
                self.inner.dropped_full.fetch_add(1, Ordering::Relaxed);
            }
            queue.push_back(queued);
            queue.len()
        };
        if length >= self.inner.config.flush_at.max(1) {
            self.inner.wake.notify_one();
        }
    }

    /// `identifyStreamer(channelID, channelName)`: once per process and name.
    pub fn identify_streamer(&self, channel_id: &str, channel_name: &str) {
        if channel_id.is_empty() || channel_name.is_empty() {
            return;
        }
        {
            let mut identified = self
                .inner
                .identified
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if identified.get(channel_id).map(String::as_str) == Some(channel_name) {
                return;
            }
            if identified.len() >= self.inner.config.max_identified.max(1)
                && !identified.contains_key(channel_id)
            {
                identified.clear();
            }
            identified.insert(channel_id.to_owned(), channel_name.to_owned());
        }
        let mut properties = Map::new();
        properties.insert("$set".to_owned(), json!({ "channel_name": channel_name }));
        properties.insert("$set_once".to_owned(), json!({}));
        self.enqueue("$identify", channel_id, properties);
    }

    /// `trackCommand(params)`: `command_executed`.
    pub fn track_command(&self, event: &CommandEvent) {
        let properties = json!({
            "channel_id": event.channel_id,
            "channel_name": event.channel_name,
            "command": event.command,
            "status": event.status,
            "user_id": or_else(&event.user_id, &event.channel_id),
            "username": or_else(&event.username, &event.channel_name),
            "arguments": or_null(event.arguments.as_deref()),
            "error_message": or_null(event.error_message.as_deref()),
        });
        if let Value::Object(properties) = properties {
            self.enqueue("command_executed", &event.channel_id, properties);
        }
    }

    /// `trackTts(params)`: `tts_executed`.
    pub fn track_tts(&self, event: &TtsEvent) {
        let properties = json!({
            "channel_id": event.channel_id,
            "channel_name": event.channel_name,
            "source": event.source,
            "tts_type": event.tts_type,
            "characters": number(event.characters),
            "message": event.message,
            "status": event.status,
            "mode": or_null(event.mode.as_deref()),
            "provider": or_null(event.provider.as_deref()),
            "user_id": or_else(&event.user_id, &event.channel_id),
            "username": or_else(&event.username, &event.channel_name),
            "error_message": or_null(event.error_message.as_deref()),
        });
        if let Value::Object(properties) = properties {
            self.enqueue("tts_executed", &event.channel_id, properties);
        }
    }

    /// `trackAiUsageRecorded(params)`: `ai_usage_recorded`, distinct per channel (or
    /// `billing:{requestId}` without one).
    pub fn track_ai_usage_recorded(&self, event: &AiUsageRecordedEvent) {
        let context = &event.context;
        let distinct = context
            .channel_id
            .clone()
            .filter(|channel| !channel.is_empty())
            .unwrap_or_else(|| format!("billing:{}", context.request_id));
        let properties = json!({
            "$insert_id": context.entry_id,
            "schema_version": context.schema_version,
            "pricing_version": context.pricing_version,
            "entry_id": context.entry_id,
            "request_id": context.request_id,
            "parent_request_id": or_null(context.parent_request_id.as_deref()),
            "entry_kind": context.entry_kind.as_str(),
            "category": context.category.as_str(),
            "operation": context.operation,
            "source": context.source,
            "provider": context.provider,
            "model": or_null(context.model.as_deref()),
            "channel_id": or_null(context.channel_id.as_deref()),
            "credits": number(event.credits),
            "reason": event.reason,
            "polar_cost_amount": number_or_null(event.polar_cost_amount),
            "quantity": number_or_null(context.quantity),
            "unit": context.unit.map_or(Value::Null, |unit| Value::from(unit.as_str())),
            "resource_type": context.resource_type.map_or(Value::Null, |kind| Value::from(kind.as_str())),
            "resource_id": or_null(context.resource_id.as_deref()),
            "input_tokens": number_or_null(event.input_tokens),
            "output_tokens": number_or_null(event.output_tokens),
            "total_tokens": number_or_null(event.total_tokens),
        });
        if let Value::Object(properties) = properties {
            self.enqueue("ai_usage_recorded", &distinct, properties);
        }
    }

    /// `trackAiOperation(params)`: `ai_operation`.
    pub fn track_ai_operation(&self, event: &AiOperationEvent) {
        let properties = json!({
            "$insert_id": format!("{}:{}:{}", event.request_id, event.operation, event.lifecycle),
            "schema_version": dima_billing::usage::AI_USAGE_SCHEMA_VERSION,
            "request_id": event.request_id,
            "channel_id": event.channel_id,
            "category": event.category,
            "operation": event.operation,
            "source": event.source,
            "lifecycle": event.lifecycle,
            "requested_provider": or_null(event.requested_provider.as_deref()),
            "actual_provider": or_null(event.actual_provider.as_deref()),
            "fallback_reason": or_null(event.fallback_reason.as_deref()),
            "error_code": or_null(event.error_code.as_deref()),
            "resource_type": or_null(event.resource_type.as_deref()),
            "resource_id": or_null(event.resource_id.as_deref()),
            "latency_ms": number_or_null(event.latency_ms),
        });
        if let Value::Object(properties) = properties {
            self.enqueue("ai_operation", &event.channel_id, properties);
        }
    }

    /// Sends the queue in batches until it is empty (or a batch fails).
    async fn send_queued(&self, http: &HttpClient, provider: &Provider) {
        loop {
            let batch: Vec<Queued> = {
                let mut queue = self.lock_queue();
                let take = queue.len().min(self.inner.config.max_batch.max(1));
                queue.drain(..take).collect()
            };
            if batch.is_empty() {
                return;
            }
            let count = batch.len() as u64;
            if self.send(http, provider, batch).await {
                self.inner.sent.fetch_add(count, Ordering::Relaxed);
            } else {
                self.inner
                    .dropped_failed
                    .fetch_add(count, Ordering::Relaxed);
                return;
            }
        }
    }

    async fn send(&self, http: &HttpClient, provider: &Provider, batch: Vec<Queued>) -> bool {
        let body = json!({
            "api_key": self.inner.config.api_key,
            "batch": batch,
            "sent_at": dima_text::to_iso_string(self.inner.clock.now_ms()).unwrap_or_default(),
        })
        .to_string();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        if gzip.write_all(body.as_bytes()).is_err() {
            return false;
        }
        let Ok(compressed) = gzip.finish() else {
            return false;
        };
        let response = http
            .post(provider, BATCH_PATH)
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .body(compressed)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let _ = response.bytes().await;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::{ManualClock, SeededRandom};

    fn events(max_queue: usize) -> ProductEvents {
        let mut config = ProductEventsConfig::reference();
        config.max_queue = max_queue;
        ProductEvents::new(
            config,
            Arc::new(ManualClock::new(1_794_475_800_123)),
            Arc::new(SeededRandom::new(7)),
        )
    }

    #[test]
    fn a_full_queue_drops_the_oldest_and_counts() {
        let events = events(3);
        for n in 0..5 {
            events.identify_streamer(&n.to_string(), "name");
        }
        let stats = events.stats();
        assert_eq!((stats.queued, stats.dropped_full), (3, 2));
        let first = events.lock_queue().front().cloned().unwrap_or_default();
        assert_eq!(first["distinct_id"], "2");
    }

    #[test]
    fn identify_is_sent_once_per_name() {
        let events = events(100);
        events.identify_streamer("1", "a");
        events.identify_streamer("1", "a");
        events.identify_streamer("1", "b");
        events.identify_streamer("", "c");
        events.identify_streamer("2", "");
        assert_eq!(events.stats().queued, 2);
    }

    #[test]
    fn uuids_are_version_7_with_the_time_first() {
        let events = events(1);
        let id = events.uuid_v7(1_794_475_800_123);
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().nth(14), Some('7'));
        assert!(matches!(id.chars().nth(19), Some('8' | '9' | 'a' | 'b')));
        // 1794475800123 = 0x01a1_cf17_b63b
        assert!(id.starts_with("01a1cf17-b63b-7"), "{id}");
    }
}
