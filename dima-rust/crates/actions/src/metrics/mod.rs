//! The bot's runtime metrics in Dragonfly (`metrics:bot:*`): counters the hot paths bump in
//! memory, a snapshot flushed every `BOT_METRICS_INTERVAL_MS` (30 s), and the per-minute
//! recorders of the AI memory, thread routing and stream memory work. Package
//! **P4-BOT-INGRESS**.
//!
//! TypeScript it ports (baseline `0c71108e`): `utils/observability/bot_runtime_metrics.ts`
//! (516 lines). The bot, the API and the cron all load it (the cron's stream-memory worker calls
//! the recorders), so it lives here, in the crate all three binaries link (lead's decision).
//!
//! | Reference export | Here |
//! |---|---|
//! | `startBotRuntimeMetricsLoop` | [`BotMetrics::start_loop`] (the bot only) |
//! | `observeEventsubNotification` | [`BotMetrics::observe_eventsub_notification`] |
//! | `startEventsubHandlerMetric` / `endEventsubHandlerMetric` | [`BotMetrics::start_eventsub_handler`], [`EventsubHandlerTracker::end`] |
//! | `startMessageHandlerMetric` / `endMessageHandlerMetric` | [`BotMetrics::start_message_handler`], [`MessageHandlerTracker::end`] |
//! | `observeEmbeddingQueue`, `recordEmbeddingEnqueued`, `recordEmbeddingBatchResult` | same names, snake case |
//! | `recordRedisOpsEstimate`, `recordOpenRouterEmbeddingRequest`, `recordOpenRouterEmbeddingError` | same names, snake case |
//! | `recordSemanticMemoryMetric`, `recordThreadRoutingMetric`, `recordStreamMemoryJobMetric`, `recordStreamMemoryActionMetric` | [`BotMetrics::record_semantic_memory`], [`BotMetrics::record_thread_routing`], [`BotMetrics::record_stream_memory_job`], [`BotMetrics::record_stream_memory_action`] |
//! | the `SIGTERM`/`SIGINT` flush | [`BotMetrics::flush`], called by the binary's shutdown |
//!
//! # Keys (prefix `BOT_METRICS_PREFIX`, default `metrics:bot`; Rust writes them in its own logical
//! database, so they are *rebuilt* at the cutover)
//!
//! | Key | Type | Value | Lifetime |
//! |---|---|---|---|
//! | `{p}:runtime:latest` | string | the snapshot as JSON | `BOT_METRICS_TTL_SECONDS` (172,800 s) |
//! | `{p}:runtime:history` | list | snapshots, newest first, at most `BOT_METRICS_HISTORY_LIMIT` (5,760) | same |
//! | `{p}:runtime:cumulative` | hash | the 15 window counters summed (`HINCRBY`), `updatedAt` (ISO), `maxInflightEventsubHandlers`, `maxInflightMessageHandlers`, `maxEmbeddingQueueSize` (decimal text) | same |
//! | `{p}:runtime:cumulative:eventsubByType` | hash | notifications per EventSub type | same |
//! | `{p}:eventsub:minute:{yyyyMMddHHmm}` | hash | `total` and one field per type | same |
//! | `{p}:runtime:minute:{yyyyMMddHHmm}` | hash | `messageHandlersStarted`, `messageHandlersCompleted`, `embeddingEnqueued`, `embeddingProcessed`, `redisOpsEstimated` | same |
//! | `{p}:{semantic\|threading\|stream_memory:job\|stream_memory:action}:minute:{bucket}`, `…:channel:{id}:minute:{bucket}`, `…:cumulative` | hash | integer counters; `cumulative` also `updatedAt` | 86,400 s |
//!
//! The minute bucket is the flush's (or the recording's) UTC minute. Nothing in the repository
//! reads these keys (the admin site does not); they are for an operator's console.
//!
//! # Bounds
//!
//! - Per-type counters use the fixed list in [`types`]: a type outside it is counted as
//!   `other`, so no delivery can add a field, a series or a key. The reference keys them by
//!   whatever type string arrives.
//! - Hash fields made from a caller's text (`pass:{pass}`, `job:{type}`, `source:{s}`,
//!   `status:{s}`, `action:{a}`) keep that text when it is 1 to 64 characters of
//!   `[A-Za-z0-9_.:-]` and become `other` otherwise. The callers pass fixed vocabularies.
//! - A per-channel key is written only for a channel id of 1 to 80 characters of
//!   `[A-Za-z0-9_-]` (the telemetry rule); otherwise only the global keys are written and the
//!   skip is counted ([`BotMetrics::skipped_channel_keys`]). The keys are per channel and minute
//!   and expire after a day, as in the reference.
//! - Every Dragonfly call is one pipeline with the client's response deadline (5 s). A failure is
//!   logged and counted ([`BotMetrics::write_errors`]); the window it would have written is lost,
//!   as in the reference (its counters are reset before the writes).
//!
//! # Differences from the reference, on purpose
//!
//! - The snapshot's `process.node` holds this program's name and version; `memory.rssBytes` is
//!   the resident size from `/proc/self/status`; the V8 heap figures (`heapTotalBytes`,
//!   `heapUsedBytes`, `externalBytes`, `arrayBuffersBytes`) and `runtime.activeHandles` /
//!   `activeRequests` are `null` (they do not exist here; the reference already writes `null`
//!   for the last two when Node lacks them). `eventLoop` is the runtime's scheduler delay
//!   ([`delay`]).
//! - A setting that is not a number falls back to its default (the reference turns
//!   `Math.max(n, NaN)` into `NaN`, which fails every write or fires the timer every
//!   millisecond); fractional limits and lifetimes are rounded down.
//! - The writes of one flush or one recording go in one pipeline instead of 20 to 40 round
//!   trips; the resulting keys, fields and lifetimes are the same.
//! - A tracker dropped without `end` (its task was cancelled or panicked) ends as failed, so the
//!   in-flight gauges cannot drift.

mod delay;
pub mod types;

pub use delay::{DelayStats, MAX_SAMPLES, RESOLUTION};
pub use types::{EVENTSUB_TYPES, OTHER_TYPE, UNKNOWN_TYPE, eventsub_type_name};

use delay::DelaySamples;
use dima_core::env::EnvVar;
use dima_core::env::read::{max_number_or, string_or};
use dima_core::{Clock, Shutdown};
use dima_store::dragonfly::Dragonfly;
use dima_telemetry::{LogOptions, Telemetry};
use serde_json::{Map, Value, json};
use std::io::Read as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Duration;
use tokio::task::JoinHandle;

/// The variables this module reads (through the binary).
pub const ENV: &[EnvVar] = &[
    EnvVar::new(
        "BOT_METRICS_HISTORY_LIMIT",
        "snapshots kept in metrics:bot:runtime:history (at least 120)",
    )
    .with_default("5760"),
    EnvVar::new(
        "BOT_METRICS_INTERVAL_MS",
        "how often the bot flushes its runtime snapshot (at least 5000)",
    )
    .with_default("30000"),
    EnvVar::new("BOT_METRICS_PREFIX", "prefix of the bot metrics keys").with_default("metrics:bot"),
    EnvVar::new(
        "BOT_METRICS_TTL_SECONDS",
        "lifetime of the runtime metrics keys (at least 3600)",
    )
    .with_default("172800"),
];

/// `SEMANTIC_METRICS_TTL_SECONDS`: the recorders' keys live a day.
pub const RECORDER_TTL_SECONDS: u64 = 24 * 60 * 60;

/// The configuration (`HISTORY_LIMIT`, `SNAPSHOT_INTERVAL_MS`, `KEY_PREFIX`,
/// `METRICS_TTL_SECONDS`).
#[derive(Clone, Debug, PartialEq)]
pub struct MetricsConfig {
    /// `Math.max(120, Number(BOT_METRICS_HISTORY_LIMIT || 5760))`.
    pub history_limit: u64,
    /// `Math.max(5000, Number(BOT_METRICS_INTERVAL_MS || 30000))`, in milliseconds as configured
    /// (the snapshot's `window.durationMs`).
    pub interval_ms: f64,
    /// `String(BOT_METRICS_PREFIX || 'metrics:bot')`.
    pub prefix: String,
    /// `Math.max(3600, Number(BOT_METRICS_TTL_SECONDS || 172800))`.
    pub ttl_seconds: u64,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self::from_env_values(None, None, None, None)
    }
}

fn finite_or(value: f64, default: f64) -> f64 {
    if value.is_finite() { value } else { default }
}

impl MetricsConfig {
    /// From the raw variables (`None` when unset).
    pub fn from_env_values(
        history_limit: Option<&str>,
        interval_ms: Option<&str>,
        prefix: Option<&str>,
        ttl_seconds: Option<&str>,
    ) -> Self {
        let history = finite_or(max_number_or(history_limit, 120.0, 5760.0), 5760.0);
        let interval = finite_or(max_number_or(interval_ms, 5000.0, 30000.0), 30000.0);
        let ttl = finite_or(max_number_or(ttl_seconds, 3600.0, 172_800.0), 172_800.0);
        Self {
            history_limit: history.floor() as u64,
            interval_ms: interval.min(2_147_483_647.0),
            prefix: string_or(prefix, "metrics:bot").to_owned(),
            ttl_seconds: ttl.floor() as u64,
        }
    }

    /// The flush interval.
    pub fn interval(&self) -> Duration {
        Duration::from_millis(self.interval_ms.floor() as u64)
    }

    fn key(&self, rest: &str) -> String {
        format!("{}:{rest}", self.prefix)
    }
}

/// The window counters (`WindowCounters`), in the reference's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
enum Counter {
    EventsubNotifications,
    EventsubNotificationBytes,
    EventsubHandled,
    EventsubHandleErrors,
    MessageHandlerStarted,
    MessageHandlerCompleted,
    MessageHandlerErrors,
    EmbeddingEnqueued,
    EmbeddingBatchesSuccess,
    EmbeddingBatchesFailed,
    EmbeddingMessagesProcessed,
    RedisOpsEstimated,
    OpenrouterEmbeddingRequests,
    OpenrouterEmbeddingErrors,
    OpenrouterEmbeddingInputChars,
}

const COUNTERS: [(Counter, &str); 15] = [
    (Counter::EventsubNotifications, "eventsubNotifications"),
    (
        Counter::EventsubNotificationBytes,
        "eventsubNotificationBytes",
    ),
    (Counter::EventsubHandled, "eventsubHandled"),
    (Counter::EventsubHandleErrors, "eventsubHandleErrors"),
    (Counter::MessageHandlerStarted, "messageHandlerStarted"),
    (Counter::MessageHandlerCompleted, "messageHandlerCompleted"),
    (Counter::MessageHandlerErrors, "messageHandlerErrors"),
    (Counter::EmbeddingEnqueued, "embeddingEnqueued"),
    (Counter::EmbeddingBatchesSuccess, "embeddingBatchesSuccess"),
    (Counter::EmbeddingBatchesFailed, "embeddingBatchesFailed"),
    (
        Counter::EmbeddingMessagesProcessed,
        "embeddingMessagesProcessed",
    ),
    (Counter::RedisOpsEstimated, "redisOpsEstimated"),
    (
        Counter::OpenrouterEmbeddingRequests,
        "openrouterEmbeddingRequests",
    ),
    (
        Counter::OpenrouterEmbeddingErrors,
        "openrouterEmbeddingErrors",
    ),
    (
        Counter::OpenrouterEmbeddingInputChars,
        "openrouterEmbeddingInputChars",
    ),
];

#[derive(Debug)]
struct Inner {
    config: MetricsConfig,
    dragonfly: Dragonfly,
    clock: Arc<dyn Clock>,
    telemetry: Option<Telemetry>,
    created_ms: i64,
    started_ms: AtomicI64,
    loop_started: AtomicBool,
    window: [AtomicU64; 15],
    window_types: [AtomicU64; types::SLOTS],
    cumulative_types: [AtomicU64; types::SLOTS],
    max_inflight_eventsub: AtomicU64,
    max_inflight_message: AtomicU64,
    max_embedding_queue: AtomicU64,
    inflight_eventsub: AtomicU64,
    inflight_message: AtomicU64,
    embedding_queue: AtomicU64,
    embedding_processing: AtomicBool,
    delay: DelaySamples,
    write_errors: AtomicU64,
    skipped_channel_keys: AtomicU64,
}

/// The bot's runtime metrics (cheap to clone: one shared state).
#[derive(Clone, Debug)]
pub struct BotMetrics {
    inner: Arc<Inner>,
}

/// `EventsubHandlerTracker`: one inline EventSub handler in flight.
#[derive(Debug)]
#[must_use = "end the tracker when the handler finishes"]
pub struct EventsubHandlerTracker {
    metrics: BotMetrics,
    kind: &'static str,
    started_ms: i64,
    ended: bool,
}

/// `MessageHandlerTracker`: one chat message handler in flight.
#[derive(Debug)]
#[must_use = "end the tracker when the handler finishes"]
pub struct MessageHandlerTracker {
    metrics: BotMetrics,
    started_ms: i64,
    ended: bool,
}

/// `recordSemanticMemoryMetric(input)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SemanticMemoryMetric {
    /// `channelID`.
    pub channel_id: String,
    /// `requested`.
    pub requested: Option<f64>,
    /// `retrieved`.
    pub retrieved: Option<f64>,
    /// `latencyMs`.
    pub latency_ms: Option<f64>,
    /// `avgScore` (stored as thousandths).
    pub avg_score: Option<f64>,
    /// `failed`.
    pub failed: bool,
    /// `pass` (`none` when empty).
    pub pass: Option<String>,
}

/// `recordThreadRoutingMetric(input)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ThreadRoutingMetric {
    /// `channelID`.
    pub channel_id: String,
    /// `candidateCount`.
    pub candidate_count: Option<f64>,
    /// `selectedScore` (stored as thousandths).
    pub selected_score: Option<f64>,
    /// `promptTurnsUsed`.
    pub prompt_turns_used: Option<f64>,
    /// `latencyMs`.
    pub latency_ms: Option<f64>,
    /// `userEvictions`.
    pub user_evictions: Option<f64>,
    /// `channelEvictions`.
    pub channel_evictions: Option<f64>,
    /// `failed`.
    pub failed: bool,
    /// `created`.
    pub created: bool,
    /// `reused`.
    pub reused: bool,
}

/// `recordStreamMemoryJobMetric(input)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StreamMemoryJobMetric {
    /// `channelID`.
    pub channel_id: String,
    /// `latencyMs`.
    pub latency_ms: Option<f64>,
    /// `failed`.
    pub failed: bool,
    /// `status` (`noop` when empty).
    pub status: Option<String>,
    /// `jobType` (`unknown` when empty).
    pub job_type: Option<String>,
    /// `source` (`stream_offline` when empty).
    pub source: Option<String>,
}

/// `recordStreamMemoryActionMetric(input)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StreamMemoryActionMetric {
    /// `channelID`.
    pub channel_id: String,
    /// `action` (`unknown` when empty).
    pub action: Option<String>,
    /// `source` (`stream_offline` when empty).
    pub source: Option<String>,
    /// `count` (nothing is written unless it rounds above 0).
    pub count: Option<f64>,
}

/// `Math.max(0, Math.round(x || 0))`; what is not finite counts 0.
fn whole(value: Option<f64>) -> i64 {
    match value {
        Some(x) if x.is_finite() && x > 0.0 => (x + 0.5).floor().min(9.0e15) as i64,
        _ => 0,
    }
}

/// `Math.max(0, Math.round((x || 0) * 1000))`.
fn thousandths(value: Option<f64>) -> i64 {
    whole(value.map(|x| x * 1000.0))
}

/// A caller's text as part of a hash field: itself when it is 1 to 64 characters of
/// `[A-Za-z0-9_.:-]`, otherwise `other`.
fn field_part(text: &str) -> &str {
    if !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    {
        text
    } else {
        OTHER_TYPE
    }
}

/// `text || default`.
fn or_default<'a>(text: Option<&'a str>, default: &'a str) -> &'a str {
    text.filter(|t| !t.is_empty()).unwrap_or(default)
}

/// A channel id that may be part of a key (the telemetry rule `^[a-zA-Z0-9_-]{1,80}$`).
fn key_channel(channel: &str) -> Option<&str> {
    (!channel.is_empty()
        && channel.len() <= 80
        && channel
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')))
    .then_some(channel)
}

/// `formatMinuteBucket(date)`: `yyyyMMddHHmm` in UTC.
pub fn minute_bucket(now_ms: i64) -> String {
    dima_text::to_iso_string(now_ms)
        .map(|iso| iso.chars().take(16).filter(char::is_ascii_digit).collect())
        .unwrap_or_default()
}

fn iso(now_ms: i64) -> String {
    dima_text::to_iso_string(now_ms).unwrap_or_default()
}

/// `VmRSS` of this process, in bytes.
fn resident_bytes() -> Option<u64> {
    let file = std::fs::File::open("/proc/self/status").ok()?;
    let mut text = String::new();
    file.take(64 * 1024).read_to_string(&mut text).ok()?;
    dima_telemetry::process::parse_rss(&text)
}

impl BotMetrics {
    /// Metrics that write through `dragonfly`, logging failures through `telemetry` when given.
    pub fn new(
        config: MetricsConfig,
        dragonfly: Dragonfly,
        clock: Arc<dyn Clock>,
        telemetry: Option<Telemetry>,
    ) -> Self {
        let now = clock.now_ms();
        Self {
            inner: Arc::new(Inner {
                config,
                dragonfly,
                clock,
                telemetry,
                created_ms: now,
                started_ms: AtomicI64::new(now),
                loop_started: AtomicBool::new(false),
                window: std::array::from_fn(|_| AtomicU64::new(0)),
                window_types: std::array::from_fn(|_| AtomicU64::new(0)),
                cumulative_types: std::array::from_fn(|_| AtomicU64::new(0)),
                max_inflight_eventsub: AtomicU64::new(0),
                max_inflight_message: AtomicU64::new(0),
                max_embedding_queue: AtomicU64::new(0),
                inflight_eventsub: AtomicU64::new(0),
                inflight_message: AtomicU64::new(0),
                embedding_queue: AtomicU64::new(0),
                embedding_processing: AtomicBool::new(false),
                delay: DelaySamples::default(),
                write_errors: AtomicU64::new(0),
                skipped_channel_keys: AtomicU64::new(0),
            }),
        }
    }

    /// The configuration.
    pub fn config(&self) -> &MetricsConfig {
        &self.inner.config
    }

    fn add(&self, counter: Counter, amount: u64) {
        self.inner.window[counter as usize].fetch_add(amount, Ordering::Relaxed);
    }

    /// `observeEventsubNotification(type, payloadBytes)`.
    pub fn observe_eventsub_notification(&self, kind: &str, payload_bytes: u64) {
        self.add(Counter::EventsubNotifications, 1);
        self.add(Counter::EventsubNotificationBytes, payload_bytes);
        let slot = types::slot(eventsub_type_name(kind));
        self.inner.window_types[slot].fetch_add(1, Ordering::Relaxed);
        self.inner.cumulative_types[slot].fetch_add(1, Ordering::Relaxed);
    }

    /// `startEventsubHandlerMetric(type)`.
    pub fn start_eventsub_handler(&self, kind: &str) -> EventsubHandlerTracker {
        let now = self.inner.inflight_eventsub.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner
            .max_inflight_eventsub
            .fetch_max(now, Ordering::Relaxed);
        EventsubHandlerTracker {
            metrics: self.clone(),
            kind: eventsub_type_name(kind),
            started_ms: self.inner.clock.now_ms(),
            ended: false,
        }
    }

    fn end_eventsub_handler(&self, failed: bool) {
        decrement(&self.inner.inflight_eventsub);
        self.add(Counter::EventsubHandled, 1);
        if failed {
            self.add(Counter::EventsubHandleErrors, 1);
        }
    }

    /// `startMessageHandlerMetric()`.
    pub fn start_message_handler(&self) -> MessageHandlerTracker {
        let now = self.inner.inflight_message.fetch_add(1, Ordering::Relaxed) + 1;
        self.add(Counter::MessageHandlerStarted, 1);
        self.inner
            .max_inflight_message
            .fetch_max(now, Ordering::Relaxed);
        MessageHandlerTracker {
            metrics: self.clone(),
            started_ms: self.inner.clock.now_ms(),
            ended: false,
        }
    }

    fn end_message_handler(&self, failed: bool) {
        decrement(&self.inner.inflight_message);
        self.add(Counter::MessageHandlerCompleted, 1);
        if failed {
            self.add(Counter::MessageHandlerErrors, 1);
        }
    }

    /// `observeEmbeddingQueue(queueSize, isProcessing)`.
    pub fn observe_embedding_queue(&self, queue_size: u64, processing: bool) {
        self.inner
            .embedding_queue
            .store(queue_size, Ordering::Relaxed);
        self.inner
            .embedding_processing
            .store(processing, Ordering::Relaxed);
        self.inner
            .max_embedding_queue
            .fetch_max(queue_size, Ordering::Relaxed);
    }

    /// `recordEmbeddingEnqueued(queueSize)`.
    pub fn record_embedding_enqueued(&self, queue_size: u64) {
        self.add(Counter::EmbeddingEnqueued, 1);
        let processing = self.inner.embedding_processing.load(Ordering::Relaxed);
        self.observe_embedding_queue(queue_size, processing);
    }

    /// `recordEmbeddingBatchResult(batchSize, success)`.
    pub fn record_embedding_batch_result(&self, batch_size: u64, success: bool) {
        if success {
            self.add(Counter::EmbeddingBatchesSuccess, 1);
            self.add(Counter::EmbeddingMessagesProcessed, batch_size);
        } else {
            self.add(Counter::EmbeddingBatchesFailed, 1);
        }
    }

    /// `recordRedisOpsEstimate(count)`.
    pub fn record_redis_ops_estimate(&self, count: f64) {
        self.add(Counter::RedisOpsEstimated, whole(Some(count)) as u64);
    }

    /// `recordOpenRouterEmbeddingRequest(inputChars)`.
    pub fn record_openrouter_embedding_request(&self, input_chars: u64) {
        self.add(Counter::OpenrouterEmbeddingRequests, 1);
        self.add(Counter::OpenrouterEmbeddingInputChars, input_chars);
    }

    /// `recordOpenRouterEmbeddingError()`.
    pub fn record_openrouter_embedding_error(&self) {
        self.add(Counter::OpenrouterEmbeddingErrors, 1);
    }

    /// Writes that failed (flushes and recordings), since start.
    pub fn write_errors(&self) -> u64 {
        self.inner.write_errors.load(Ordering::Relaxed)
    }

    /// Per-channel keys not written because the channel id could not be part of a key.
    pub fn skipped_channel_keys(&self) -> u64 {
        self.inner.skipped_channel_keys.load(Ordering::Relaxed)
    }

    /// Inline EventSub handlers in flight.
    pub fn inflight_eventsub_handlers(&self) -> u64 {
        self.inner.inflight_eventsub.load(Ordering::Relaxed)
    }

    /// Chat message handlers in flight.
    pub fn inflight_message_handlers(&self) -> u64 {
        self.inner.inflight_message.load(Ordering::Relaxed)
    }

    fn failed(&self, function: &str, error: &dyn std::fmt::Display, channel: Option<&str>) {
        self.inner.write_errors.fetch_add(1, Ordering::Relaxed);
        if let Some(telemetry) = &self.inner.telemetry {
            let mut data = json!({ "function": function, "error": error.to_string() });
            if let (Some(channel), Value::Object(map)) = (channel, &mut data) {
                map.insert("channelID".to_owned(), Value::from(channel));
            }
            telemetry.error(&data, LogOptions::console());
        }
    }

    /// The three keys of a recorder: the minute's, the channel's minute's (when the id may be
    /// part of a key) and the cumulative one.
    fn recorder_keys(&self, family: &str, channel: &str, bucket: &str) -> Vec<String> {
        let config = &self.inner.config;
        let mut keys = vec![config.key(&format!("{family}:minute:{bucket}"))];
        match key_channel(channel) {
            Some(channel) => {
                keys.push(config.key(&format!("{family}:channel:{channel}:minute:{bucket}")));
            }
            None => {
                self.inner
                    .skipped_channel_keys
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
        keys.push(config.key(&format!("{family}:cumulative")));
        keys
    }

    /// Runs the increments of one recorder on each of its keys, then `updatedAt` and the
    /// lifetimes, in one pipeline.
    async fn record(
        &self,
        function: &'static str,
        family: &str,
        channel: &str,
        fields: &[(String, i64)],
    ) {
        let now = self.inner.clock.now_ms();
        let keys = self.recorder_keys(family, channel, &minute_bucket(now));
        let mut pipeline = redis::pipe();
        for key in &keys {
            for (field, amount) in fields {
                pipeline
                    .cmd("HINCRBY")
                    .arg(key)
                    .arg(field)
                    .arg(amount)
                    .ignore();
            }
        }
        if let Some(cumulative) = keys.last() {
            pipeline
                .cmd("HSET")
                .arg(cumulative)
                .arg("updatedAt")
                .arg(iso(now))
                .ignore();
        }
        for key in &keys {
            pipeline
                .cmd("EXPIRE")
                .arg(key)
                .arg(RECORDER_TTL_SECONDS)
                .ignore();
        }
        if let Err(error) = self.inner.dragonfly.query_pipeline::<()>(&pipeline).await {
            self.failed(function, &error, Some(channel));
        }
    }

    /// `recordSemanticMemoryMetric(input)`.
    pub async fn record_semantic_memory(&self, input: &SemanticMemoryMetric) {
        let mut fields = vec![
            ("requests".to_owned(), 1),
            ("requestedTotal".to_owned(), whole(input.requested)),
            ("retrievedTotal".to_owned(), whole(input.retrieved)),
            ("latencyMsTotal".to_owned(), whole(input.latency_ms)),
            (
                "avgScoreMilliTotal".to_owned(),
                thousandths(input.avg_score),
            ),
        ];
        if input.failed {
            fields.push(("errors".to_owned(), 1));
        }
        let pass = field_part(or_default(input.pass.as_deref(), "none"));
        fields.push((format!("pass:{pass}"), 1));
        self.record(
            "recordSemanticMemoryMetric",
            "semantic",
            &input.channel_id,
            &fields,
        )
        .await;
    }

    /// `recordThreadRoutingMetric(input)`.
    pub async fn record_thread_routing(&self, input: &ThreadRoutingMetric) {
        let mut fields = vec![
            ("requests".to_owned(), 1),
            (
                "candidateCountTotal".to_owned(),
                whole(input.candidate_count),
            ),
            (
                "selectedScoreMilliTotal".to_owned(),
                thousandths(input.selected_score),
            ),
            (
                "promptTurnsTotal".to_owned(),
                whole(input.prompt_turns_used),
            ),
            ("latencyMsTotal".to_owned(), whole(input.latency_ms)),
            ("userEvictions".to_owned(), whole(input.user_evictions)),
            (
                "channelEvictions".to_owned(),
                whole(input.channel_evictions),
            ),
        ];
        if input.created {
            fields.push(("created".to_owned(), 1));
        }
        if input.reused {
            fields.push(("reused".to_owned(), 1));
        }
        if input.failed {
            fields.push(("errors".to_owned(), 1));
        }
        self.record(
            "recordThreadRoutingMetric",
            "threading",
            &input.channel_id,
            &fields,
        )
        .await;
    }

    /// `recordStreamMemoryJobMetric(input)`.
    pub async fn record_stream_memory_job(&self, input: &StreamMemoryJobMetric) {
        let job = field_part(or_default(input.job_type.as_deref(), "unknown"));
        let source = field_part(or_default(input.source.as_deref(), "stream_offline"));
        let status = field_part(or_default(input.status.as_deref(), "noop"));
        let mut fields = vec![
            ("requests".to_owned(), 1),
            (format!("job:{job}"), 1),
            (format!("source:{source}"), 1),
            (format!("status:{status}"), 1),
            ("latencyMsTotal".to_owned(), whole(input.latency_ms)),
        ];
        if input.failed {
            fields.push(("errors".to_owned(), 1));
        }
        self.record(
            "recordStreamMemoryJobMetric",
            "stream_memory:job",
            &input.channel_id,
            &fields,
        )
        .await;
    }

    /// `recordStreamMemoryActionMetric(input)`: nothing when the count is not positive.
    pub async fn record_stream_memory_action(&self, input: &StreamMemoryActionMetric) {
        let count = whole(input.count);
        if count <= 0 {
            return;
        }
        let action = field_part(or_default(input.action.as_deref(), "unknown"));
        let source = field_part(or_default(input.source.as_deref(), "stream_offline"));
        let fields = vec![
            ("count".to_owned(), count),
            (format!("action:{action}"), count),
            (format!("source:{source}"), count),
        ];
        self.record(
            "recordStreamMemoryActionMetric",
            "stream_memory:action",
            &input.channel_id,
            &fields,
        )
        .await;
    }

    /// The snapshot `flushRuntimeSnapshot` writes, and the window it closed (the counters and
    /// per-type counts are reset, as the reference does before writing).
    fn take_snapshot(&self) -> (Value, Counts, Counts) {
        let inner = &self.inner;
        let now = inner.clock.now_ms();
        let started = inner.started_ms.load(Ordering::Relaxed);
        let window: Counts = COUNTERS
            .iter()
            .map(|(counter, name)| {
                (
                    *name,
                    inner.window[*counter as usize].swap(0, Ordering::Relaxed),
                )
            })
            .collect();
        let window_types: Counts = (0..types::SLOTS)
            .filter_map(|slot| {
                let count = inner.window_types[slot].swap(0, Ordering::Relaxed);
                (count > 0).then(|| (types::name_of(slot), count))
            })
            .collect();
        let cumulative_types: Map<String, Value> = (0..types::SLOTS)
            .filter_map(|slot| {
                let count = inner.cumulative_types[slot].load(Ordering::Relaxed);
                (count > 0).then(|| (types::name_of(slot).to_owned(), Value::from(count)))
            })
            .collect();
        let delay = inner.delay.take();
        let mut window_object = Map::new();
        window_object.insert(
            "durationMs".to_owned(),
            dima_text::js_number_value(inner.config.interval_ms),
        );
        for (name, value) in &window {
            window_object.insert((*name).to_owned(), Value::from(*value));
        }
        window_object.insert(
            "eventsubByType".to_owned(),
            Value::Object(
                window_types
                    .iter()
                    .map(|(name, count)| ((*name).to_owned(), Value::from(*count)))
                    .collect(),
            ),
        );
        let uptime_ms = now.saturating_sub(inner.created_ms).max(0);
        let snapshot = json!({
            "timestamp": iso(now),
            "process": {
                "pid": std::process::id(),
                "node": concat!("dima-bot/", env!("CARGO_PKG_VERSION")),
                "uptimeSeconds": (uptime_ms as f64 / 1000.0).round() as i64,
                "startedAt": iso(started),
                "elapsedMs": now.saturating_sub(started),
            },
            "memory": {
                "rssBytes": resident_bytes(),
                "heapTotalBytes": null,
                "heapUsedBytes": null,
                "externalBytes": null,
                "arrayBuffersBytes": null,
            },
            "runtime": {
                "inflightEventsubHandlers": inner.inflight_eventsub.load(Ordering::Relaxed),
                "inflightMessageHandlers": inner.inflight_message.load(Ordering::Relaxed),
                "activeHandles": null,
                "activeRequests": null,
                "embeddingQueueSize": inner.embedding_queue.load(Ordering::Relaxed),
                "embeddingProcessing": inner.embedding_processing.load(Ordering::Relaxed),
            },
            "eventLoop": {
                "minMs": dima_text::js_number_value(delay.min_ms),
                "maxMs": dima_text::js_number_value(delay.max_ms),
                "meanMs": dima_text::js_number_value(delay.mean_ms),
                "stddevMs": dima_text::js_number_value(delay.stddev_ms),
                "p50Ms": dima_text::js_number_value(delay.p50_ms),
                "p95Ms": dima_text::js_number_value(delay.p95_ms),
                "p99Ms": dima_text::js_number_value(delay.p99_ms),
            },
            "window": Value::Object(window_object),
            "totals": {
                "maxInflightEventsubHandlers": inner.max_inflight_eventsub.load(Ordering::Relaxed),
                "maxInflightMessageHandlers": inner.max_inflight_message.load(Ordering::Relaxed),
                "maxEmbeddingQueueSize": inner.max_embedding_queue.load(Ordering::Relaxed),
                "eventsubByType": Value::Object(cumulative_types),
            },
        });
        (snapshot, window, window_types)
    }

    /// `flushRuntimeSnapshot()`: closes the window and writes the snapshot, the history, the
    /// cumulative hashes and the minute hashes (see the module documentation). A failure is
    /// logged and counted; the window is lost, as in the reference.
    pub async fn flush(&self) {
        let inner = &self.inner;
        let config = &inner.config;
        let (snapshot, window, window_types) = self.take_snapshot();
        let serialized = snapshot.to_string();
        let now_iso = snapshot
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let latest = config.key("runtime:latest");
        let history = config.key("runtime:history");
        let cumulative = config.key("runtime:cumulative");
        let cumulative_types = config.key("runtime:cumulative:eventsubByType");
        let bucket = minute_bucket(inner.clock.now_ms());
        let minute = config.key(&format!("eventsub:minute:{bucket}"));
        let minute_meta = config.key(&format!("runtime:minute:{bucket}"));
        let ttl = config.ttl_seconds;
        let count = |name: &str| {
            window
                .iter()
                .find(|(n, _)| *n == name)
                .map_or(0, |(_, value)| *value)
        };

        let mut pipe = redis::pipe();
        pipe.cmd("SET")
            .arg(&latest)
            .arg(&serialized)
            .arg("EX")
            .arg(ttl)
            .ignore();
        pipe.cmd("LPUSH").arg(&history).arg(&serialized).ignore();
        pipe.cmd("LTRIM")
            .arg(&history)
            .arg(0)
            .arg(config.history_limit.saturating_sub(1))
            .ignore();
        pipe.cmd("EXPIRE").arg(&history).arg(ttl).ignore();
        for (name, value) in &window {
            pipe.cmd("HINCRBY")
                .arg(&cumulative)
                .arg(*name)
                .arg(*value)
                .ignore();
        }
        for (name, value) in &window_types {
            pipe.cmd("HINCRBY")
                .arg(&cumulative_types)
                .arg(*name)
                .arg(*value)
                .ignore();
        }
        pipe.cmd("HSET")
            .arg(&cumulative)
            .arg("updatedAt")
            .arg(&now_iso)
            .arg("maxInflightEventsubHandlers")
            .arg(
                inner
                    .max_inflight_eventsub
                    .load(Ordering::Relaxed)
                    .to_string(),
            )
            .arg("maxInflightMessageHandlers")
            .arg(
                inner
                    .max_inflight_message
                    .load(Ordering::Relaxed)
                    .to_string(),
            )
            .arg("maxEmbeddingQueueSize")
            .arg(
                inner
                    .max_embedding_queue
                    .load(Ordering::Relaxed)
                    .to_string(),
            )
            .ignore();
        pipe.cmd("EXPIRE").arg(&cumulative).arg(ttl).ignore();
        pipe.cmd("EXPIRE").arg(&cumulative_types).arg(ttl).ignore();
        pipe.cmd("HINCRBY")
            .arg(&minute)
            .arg("total")
            .arg(count("eventsubNotifications"))
            .ignore();
        for (field, counter) in [
            ("messageHandlersStarted", "messageHandlerStarted"),
            ("messageHandlersCompleted", "messageHandlerCompleted"),
            ("embeddingEnqueued", "embeddingEnqueued"),
            ("embeddingProcessed", "embeddingMessagesProcessed"),
            ("redisOpsEstimated", "redisOpsEstimated"),
        ] {
            pipe.cmd("HINCRBY")
                .arg(&minute_meta)
                .arg(field)
                .arg(count(counter))
                .ignore();
        }
        for (name, value) in &window_types {
            pipe.cmd("HINCRBY")
                .arg(&minute)
                .arg(*name)
                .arg(*value)
                .ignore();
        }
        pipe.cmd("EXPIRE").arg(&minute).arg(ttl).ignore();
        pipe.cmd("EXPIRE").arg(&minute_meta).arg(ttl).ignore();
        if let Err(error) = inner.dragonfly.query_pipeline::<()>(&pipe).await {
            self.failed("flushRuntimeSnapshot", &error, None);
        }
    }

    /// `startBotRuntimeMetricsLoop()`: flushes every [`MetricsConfig::interval`] and samples the
    /// scheduler delay, until `shutdown`. A second call does nothing (`None`). The final flush at
    /// shutdown is the binary's ([`BotMetrics::flush`] in its ordered shutdown), not this
    /// loop's.
    pub fn start_loop(&self, shutdown: &Shutdown) -> Option<JoinHandle<()>> {
        if self.inner.loop_started.swap(true, Ordering::AcqRel) {
            return None;
        }
        self.inner
            .started_ms
            .store(self.inner.clock.now_ms(), Ordering::Relaxed);
        let metrics = self.clone();
        let stop = shutdown.clone();
        Some(tokio::spawn(async move {
            let mut flush = tokio::time::interval(metrics.inner.config.interval());
            flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // `setInterval` first fires one interval after it is set.
            flush.reset();
            // Node's histogram records the whole interval between two wakes of its 20 ms
            // timer (about 20 ms when idle), so this does too.
            let mut last = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    () = stop.wait() => return,
                    _ = flush.tick() => metrics.flush().await,
                    () = tokio::time::sleep_until(last + RESOLUTION) => {
                        let now = tokio::time::Instant::now();
                        metrics.inner.delay.record(now.saturating_duration_since(last));
                        last = now;
                    }
                }
            }
        }))
    }
}

/// Named counts closed with a window.
type Counts = Vec<(&'static str, u64)>;

fn decrement(counter: &AtomicU64) {
    // `Math.max(0, n - 1)`.
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
        Some(n.saturating_sub(1))
    });
}

impl EventsubHandlerTracker {
    /// `endEventsubHandlerMetric(tracker, failed)`.
    pub fn end(mut self, failed: bool) {
        self.ended = true;
        self.metrics.end_eventsub_handler(failed);
    }

    /// The type it counts under.
    pub fn kind(&self) -> &'static str {
        self.kind
    }

    /// When it started (epoch milliseconds).
    pub fn started_ms(&self) -> i64 {
        self.started_ms
    }
}

impl Drop for EventsubHandlerTracker {
    fn drop(&mut self) {
        if !self.ended {
            self.metrics.end_eventsub_handler(true);
        }
    }
}

impl MessageHandlerTracker {
    /// `endMessageHandlerMetric(tracker, failed)`.
    pub fn end(mut self, failed: bool) {
        self.ended = true;
        self.metrics.end_message_handler(failed);
    }

    /// When it started (epoch milliseconds).
    pub fn started_ms(&self) -> i64 {
        self.started_ms
    }
}

impl Drop for MessageHandlerTracker {
    fn drop(&mut self) {
        if !self.ended {
            self.metrics.end_message_handler(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_parses_like_the_reference() {
        let config = MetricsConfig::default();
        assert_eq!(config.history_limit, 5760);
        assert_eq!(config.interval_ms, 30000.0);
        assert_eq!(config.prefix, "metrics:bot");
        assert_eq!(config.ttl_seconds, 172_800);
        let config = MetricsConfig::from_env_values(Some("10"), Some("1000"), Some(""), Some("60"));
        assert_eq!(config.history_limit, 120);
        assert_eq!(config.interval_ms, 5000.0);
        assert_eq!(config.prefix, "metrics:bot");
        assert_eq!(config.ttl_seconds, 3600);
        let config = MetricsConfig::from_env_values(
            Some("0x1F40"),
            Some(" 6000 "),
            Some("m:b"),
            Some("abc"),
        );
        assert_eq!(config.history_limit, 8000);
        assert_eq!(config.interval_ms, 6000.0);
        assert_eq!(config.prefix, "m:b");
        assert_eq!(config.ttl_seconds, 172_800);
    }

    #[test]
    fn numbers_round_like_math_round() {
        assert_eq!(whole(None), 0);
        assert_eq!(whole(Some(f64::NAN)), 0);
        assert_eq!(whole(Some(-3.0)), 0);
        assert_eq!(whole(Some(2.5)), 3);
        assert_eq!(whole(Some(2.49)), 2);
        assert_eq!(whole(Some(f64::INFINITY)), 0);
        assert_eq!(thousandths(Some(0.8765)), 877);
    }

    #[test]
    fn caller_text_in_fields_is_bounded() {
        assert_eq!(field_part("first"), "first");
        assert_eq!(field_part("a:b.c-d_e"), "a:b.c-d_e");
        assert_eq!(field_part(""), "other");
        assert_eq!(field_part("with space"), "other");
        assert_eq!(field_part("ü"), "other");
        assert_eq!(field_part(&"x".repeat(65)), "other");
        assert_eq!(key_channel("12345"), Some("12345"));
        assert_eq!(key_channel(""), None);
        assert_eq!(key_channel("1:2"), None);
        assert_eq!(key_channel("١٢٣"), None);
    }

    #[test]
    fn minute_buckets_are_utc() {
        // 2026-11-12T09:30:59.999Z
        assert_eq!(minute_bucket(1_794_475_859_999), "202611120930");
        assert_eq!(minute_bucket(0), "197001010000");
    }
}
