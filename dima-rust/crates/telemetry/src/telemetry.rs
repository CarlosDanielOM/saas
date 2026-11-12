//! The [`Telemetry`] handle: configuration, metrics, spans, logs, and the background tasks.

use crate::aggregate::{
    FinishedSpan, LogRow, MAX_LOGS, MAX_SPANS, Metrics, Rejected, Rows, SpanRow, Taken,
};
use crate::label::{self, Channel, MetricKey};
use crate::logger::{
    ConsoleMessage, ConsoleTarget, Level, LogOptions, Receivers, Sinks, cache_entry,
};
use crate::otlp::{self, PosthogConfig};
use crate::process::{Probe, ProcessSampler};
use crate::redact::Redactor;
use crate::span::Span;
use crate::trace::{self, SavedTrace, SpanId, SpanIds, TraceContext, TraceId};
use crate::worker::{Worker, WorkerCell};
use dima_core::{Clock, Random, SecretString, Shutdown, SystemClock, SystemRandom};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks, Script};
use serde::Serialize;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// The inbox the analytics service drains.
pub const TELEMETRY_INBOX: &str = "observability:v1:inbox";
/// Batches the inbox could not hold.
pub const TELEMETRY_OVERFLOW: &str = "observability:v1:overflow";
/// Bound on one inbox flush, connection included (the reference's 1.8 s).
pub const FLUSH_DEADLINE: Duration = Duration::from_millis(1800);
/// Bound on opening the telemetry connection (the reference's 1 s).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// Bound on one batch of cache log writes.
pub const CACHE_WRITE_DEADLINE: Duration = Duration::from_secs(2);
/// After a failed connection, how long nothing tries again (entries are dropped meanwhile).
pub const RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
/// Cache writes sent per pipeline.
pub const CACHE_BATCH: usize = 64;
/// Default bound of each log queue.
pub const DEFAULT_LOG_QUEUE: usize = 1024;
/// Default bound on bytes held by queued log entries.
pub const DEFAULT_LOG_BUDGET: usize = 1024 * 1024;
/// The exporter's cadence.
pub const FLUSH_INTERVAL_MS: i64 = 10_000;
/// Offset of each flush after a bucket boundary.
pub const FLUSH_OFFSET_MS: i64 = 1_000;
/// Most workers sampled per process.
pub const MAX_WORKERS: usize = 128;

/// The reference's enqueue script: newest batch first, at most 100 batches, the excess counted in
/// the overflow key, one hour of expiry. No loop: bounded by construction.
pub static ENQUEUE: Script = Script::new("ENQUEUE", include_str!("lua/enqueue.lua"));

/// How a process reports. Built by the binary from its configuration; nothing here reads the
/// environment.
#[derive(Clone, Debug)]
pub struct TelemetryConfig {
    /// `api`, `bot`, `cron`, or a small service's name (the analytics `service` column).
    pub service: String,
    /// The process label on the admin page (`index` for the three main binaries).
    pub process: String,
    /// Whether metrics, spans and telemetry logs are exported (the reference: `DRAGONFLY_HOST` is
    /// set and `OBSERVABILITY_DISABLED` is not `true`). Off: observations are ignored.
    pub export: bool,
    /// Where cache log entries and the inbox live. `None`: cache entries are dropped and counted
    /// and nothing is exported.
    pub dragonfly: Option<DragonflyConfig>,
    /// `SECRET_KEY`, which signs and verifies the trace header between our services.
    pub secret_key: Option<SecretString>,
    /// Probability that a new trace is sampled.
    pub sample_rate: f64,
    /// Entries below this level are discarded at the call site.
    pub min_level: Level,
    /// Where console lines go.
    pub console: ConsoleTarget,
    /// Log export to PostHog (API and bot).
    pub posthog: Option<PosthogConfig>,
    /// The inbox key.
    pub inbox_key: String,
    /// The overflow counter key.
    pub overflow_key: String,
    /// Outbound providers that are not instrumented (the reference skips PostHog and analytics).
    pub http_exclude: Vec<String>,
    /// Bound of each log queue.
    pub log_queue: usize,
    /// Bound on bytes held by queued log entries.
    pub log_budget: usize,
    /// The wall clock.
    pub clock: Arc<dyn Clock>,
}

impl TelemetryConfig {
    /// Defaults for a process: export on, no store, the reference's sampling, every level,
    /// stdout, no PostHog.
    pub fn new(service: &str, process: &str) -> Self {
        Self {
            service: service.to_owned(),
            process: process.to_owned(),
            export: true,
            dragonfly: None,
            secret_key: None,
            sample_rate: trace::DEFAULT_SAMPLE_RATE,
            min_level: Level::Trace,
            console: ConsoleTarget::Stdout,
            posthog: None,
            inbox_key: TELEMETRY_INBOX.to_owned(),
            overflow_key: TELEMETRY_OVERFLOW.to_owned(),
            http_exclude: vec!["posthog".to_owned(), "analytics".to_owned()],
            log_queue: DEFAULT_LOG_QUEUE,
            log_budget: DEFAULT_LOG_BUDGET,
            clock: Arc::new(SystemClock),
        }
    }

    /// The reference's switches from the raw environment values: export when `DRAGONFLY_HOST`
    /// is non-empty and `OBSERVABILITY_DISABLED` is not exactly `true`; the store at
    /// `redis://DRAGONFLY_HOST:DRAGONFLY_PORT`; `SECRET_KEY` for trace signatures.
    pub fn with_env_values(
        mut self,
        observability_disabled: Option<&str>,
        dragonfly_host: Option<&str>,
        dragonfly_port: Option<&str>,
        secret_key: Option<&str>,
    ) -> Self {
        let host = dragonfly_host.filter(|host| !host.is_empty());
        self.export = observability_disabled != Some("true") && host.is_some();
        self.dragonfly = host
            .map(|host| DragonflyConfig::from_env_values(Some(host), dragonfly_port, "telemetry"));
        self.secret_key = secret_key
            .filter(|key| !key.is_empty())
            .map(|key| SecretString::new(key.to_owned()));
        self
    }
}

/// Why a handle could not be built.
#[derive(Debug, thiserror::Error)]
pub enum TelemetryError {
    /// The PostHog exporter could not be built.
    #[error(transparent)]
    Posthog(#[from] otlp::ExportError),
}

/// Counters for health pages and tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Stats {
    /// Metric observations, spans, telemetry logs and payloads lost by the pipeline.
    pub pipeline_dropped: u64,
    /// Console lines lost.
    pub console_dropped: u64,
    /// Cache log entries lost (queue full, budget spent, store unavailable or failed).
    pub cache_dropped: u64,
    /// PostHog records lost.
    pub posthog_dropped: u64,
    /// Metric series held now.
    pub series: usize,
    /// Payloads written to the inbox.
    pub payloads_sent: u64,
    /// Cache log entries written.
    pub cache_written: u64,
    /// Log calls whose data's `Serialize` failed or panicked (logged as `[unserializable]`).
    pub unserializable: u64,
    /// Log platforms and channel ids that were not valid identifiers and were replaced by
    /// [`crate::logger::INVALID_IDENTIFIER`] (not a loss: the entry is still written).
    pub log_metadata_replaced: u64,
}

impl Stats {
    /// Everything this process failed to report: the admin page's `telemetry_dropped`.
    pub fn total_dropped(&self) -> u64 {
        self.pipeline_dropped
            + self.console_dropped
            + self.cache_dropped
            + self.posthog_dropped
            + self.unserializable
    }
}

/// Rows taken by [`Telemetry::take_snapshot`].
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    /// Metric rows, one per series and bucket.
    pub metrics: Vec<crate::aggregate::MetricRow>,
    /// Span rows.
    pub spans: Vec<SpanRow>,
    /// Telemetry log rows.
    pub logs: Vec<LogRow>,
}

impl Snapshot {
    /// The rows of one metric name.
    pub fn metric(&self, name: &str) -> Vec<&crate::aggregate::MetricRow> {
        self.metrics.iter().filter(|row| row.name == name).collect()
    }
}

/// The shared Dragonfly connection of the telemetry pipeline: opened on first use with a short
/// timeout, never instrumented (telemetry does not observe itself), dropped after a failure and
/// not retried for [`RECONNECT_BACKOFF`].
pub(crate) struct Store {
    config: Option<DragonflyConfig>,
    state: tokio::sync::Mutex<StoreState>,
}

#[derive(Default)]
struct StoreState {
    handle: Option<Dragonfly>,
    failed_at: Option<Instant>,
}

impl Store {
    fn new(config: Option<DragonflyConfig>) -> Self {
        let config = config.map(|mut config| {
            config.connect_timeout = CONNECT_TIMEOUT;
            config.response_timeout = FLUSH_DEADLINE;
            config.reconnect_retries = 1;
            config
        });
        Self {
            config,
            state: tokio::sync::Mutex::new(StoreState::default()),
        }
    }

    pub(crate) async fn get(&self) -> Option<Dragonfly> {
        let config = self.config.as_ref()?;
        let mut state = self.state.lock().await;
        if let Some(handle) = &state.handle {
            return Some(handle.clone());
        }
        if state
            .failed_at
            .is_some_and(|at| at.elapsed() < RECONNECT_BACKOFF)
        {
            return None;
        }
        let connect = Dragonfly::connect(config.clone(), Hooks::default());
        match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Ok(Ok(handle)) => {
                state.handle = Some(handle.clone());
                state.failed_at = None;
                Some(handle)
            }
            _ => {
                state.failed_at = Some(Instant::now());
                None
            }
        }
    }

    pub(crate) async fn failed(&self) {
        let mut state = self.state.lock().await;
        state.handle = None;
        state.failed_at = Some(Instant::now());
    }
}

pub(crate) struct Shared {
    pub(crate) service: String,
    pub(crate) process: String,
    pub(crate) instance: String,
    pub(crate) export: bool,
    pub(crate) sample_rate: f64,
    pub(crate) secret: Option<SecretString>,
    pub(crate) min_level: Level,
    pub(crate) clock: Arc<dyn Clock>,
    /// The wall clock as the probe task last read it (every 20 ms), 0 when it is not running.
    /// It picks the 10-second bucket of an observation without a clock read per call.
    pub(crate) coarse_ms: AtomicU64,
    pub(crate) metrics: Metrics,
    pub(crate) spans: Rows<SpanRow>,
    pub(crate) logs: Rows<LogRow>,
    pub(crate) dropped: AtomicU64,
    pub(crate) payloads_sent: AtomicU64,
    pub(crate) cache_written: AtomicU64,
    pub(crate) unserializable: AtomicU64,
    pub(crate) sinks: Sinks,
    pub(crate) receivers: Mutex<Option<Receivers>>,
    pub(crate) posthog: Mutex<Option<otlp::Exporter>>,
    pub(crate) workers: Mutex<Vec<Arc<WorkerCell>>>,
    pub(crate) store: Store,
    pub(crate) redactor: Redactor,
    pub(crate) http_exclude: Vec<String>,
    pub(crate) probe: Probe,
    pub(crate) inbox_key: String,
    pub(crate) overflow_key: String,
    pub(crate) flushing: tokio::sync::Mutex<()>,
    pub(crate) process_sampler: Mutex<ProcessSampler>,
    pub(crate) names: ProcessNames,
}

/// The process's runtime metric names, built once.
pub(crate) struct ProcessNames {
    pub(crate) rss: String,
    pub(crate) cpu: String,
    pub(crate) lag: String,
    pub(crate) dropped: String,
    pub(crate) uptime: String,
}

/// The handle every part of a process reports through. Cheap to clone.
#[derive(Clone)]
pub struct Telemetry(pub(crate) Arc<Shared>);

impl std::fmt::Debug for Telemetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telemetry")
            .field("service", &self.0.service)
            .field("process", &self.0.process)
            .field("export", &self.0.export)
            .finish()
    }
}

fn uuid() -> String {
    SystemRandom.uuid_v4().unwrap_or_else(|_| {
        let (a, b) = (trace::rng::next(), trace::rng::next());
        let hex = format!("{a:016x}{b:016x}");
        let part = |range: std::ops::Range<usize>| hex.get(range).unwrap_or_default().to_owned();
        format!(
            "{}-{}-4{}-a{}-{}",
            part(0..8),
            part(8..12),
            part(13..16),
            part(17..20),
            part(20..32)
        )
    })
}

impl Telemetry {
    /// Builds the handle. Nothing connects and no task starts until [`Telemetry::start`].
    pub fn new(config: TelemetryConfig) -> Result<Self, TelemetryError> {
        let posthog = config
            .posthog
            .as_ref()
            .map(otlp::Exporter::new)
            .transpose()?;
        Ok(Self::build(config, posthog))
    }

    fn build(config: TelemetryConfig, posthog: Option<otlp::Exporter>) -> Self {
        let export = config.export && config.dragonfly.is_some();
        let (sinks, receivers) = Sinks::new(
            config.console.clone(),
            config.dragonfly.is_some(),
            config.posthog.is_some(),
            config.log_queue,
            config.log_budget,
        );
        let process = label::Label::<60>::clean(&config.process)
            .as_str()
            .to_owned();
        let names = ProcessNames {
            rss: format!("{process}.rss_bytes"),
            cpu: format!("{process}.cpu_cores"),
            lag: format!("{process}.event_loop_p99_ms"),
            dropped: format!("{process}.telemetry_dropped"),
            uptime: format!("{process}.uptime_s"),
        };
        Self(Arc::new(Shared {
            service: label::Label::<50>::clean(&config.service)
                .as_str()
                .to_owned(),
            process,
            instance: uuid(),
            export,
            sample_rate: config.sample_rate.clamp(0.0, 1.0),
            secret: config.secret_key,
            min_level: config.min_level,
            clock: config.clock,
            coarse_ms: AtomicU64::new(0),
            metrics: Metrics::new(),
            spans: Rows::new(MAX_SPANS),
            logs: Rows::new(MAX_LOGS),
            dropped: AtomicU64::new(0),
            payloads_sent: AtomicU64::new(0),
            cache_written: AtomicU64::new(0),
            unserializable: AtomicU64::new(0),
            sinks,
            receivers: Mutex::new(Some(receivers)),
            posthog: Mutex::new(posthog),
            workers: Mutex::new(Vec::new()),
            store: Store::new(config.dragonfly),
            redactor: Redactor::new(),
            http_exclude: config.http_exclude,
            probe: Probe::new(),
            inbox_key: config.inbox_key,
            overflow_key: config.overflow_key,
            flushing: tokio::sync::Mutex::new(()),
            process_sampler: Mutex::new(ProcessSampler::new()),
            names,
        }))
    }

    /// A handle that reports nothing anywhere (tools, tests of other crates).
    pub fn disabled() -> Self {
        let mut config = TelemetryConfig::new("disabled", "index");
        config.export = false;
        config.console = ConsoleTarget::Off;
        config.min_level = Level::Fatal;
        config.posthog = None;
        Self::build(config, None)
    }

    /// The analytics `service`.
    pub fn service(&self) -> &str {
        &self.0.service
    }

    /// The process label.
    pub fn process(&self) -> &str {
        &self.0.process
    }

    /// This process's instance id.
    pub fn instance(&self) -> &str {
        &self.0.instance
    }

    /// Whether the pipeline exports.
    pub fn exporting(&self) -> bool {
        self.0.export
    }

    /// The sampling rate for new traces.
    pub fn sample_rate(&self) -> f64 {
        self.0.sample_rate
    }

    /// The trace-signing key.
    pub(crate) fn secret(&self) -> Option<&SecretString> {
        self.0.secret.as_ref()
    }

    pub(crate) fn now_ms(&self) -> u64 {
        u64::try_from(self.0.clock.now_ms()).unwrap_or_default()
    }

    /// The time that picks an observation's bucket: the probe's last reading when it runs (at
    /// most 20 ms old: an observation that close after a boundary lands in the previous bucket),
    /// otherwise the clock.
    pub(crate) fn bucket_ms(&self) -> u64 {
        match self.0.coarse_ms.load(Ordering::Relaxed) {
            0 => self.now_ms(),
            coarse => coarse,
        }
    }

    pub(crate) fn lose(&self, count: u64) {
        if count > 0 {
            self.0.dropped.fetch_add(count, Ordering::Relaxed);
        }
    }

    // ---------- metrics ----------

    /// One observation with outcome `ok` in the current channel (`observe(kind, name, value)`).
    pub fn observe(&self, kind: &str, name: &str, value: f64) {
        if self.0.export {
            self.record(kind, name, value, "ok", trace::current_channel());
        }
    }

    /// One observation with an outcome and, when given, a channel (otherwise the current one).
    pub fn observe_with(
        &self,
        kind: &str,
        name: &str,
        value: f64,
        outcome: &str,
        channel: Option<&str>,
    ) {
        if self.0.export {
            let channel = channel.map_or_else(trace::current_channel, label::channel);
            self.record(kind, name, value, outcome, channel);
        }
    }

    /// A count of one event (`observe(kind, name, 0)`).
    pub fn count(&self, kind: &str, name: &str) {
        self.observe(kind, name, 0.0);
    }

    pub(crate) fn record(
        &self,
        kind: &str,
        name: &str,
        value: f64,
        outcome: &str,
        channel: Channel,
    ) {
        let key = MetricKey::new(kind, name, &channel, outcome);
        if self.0.metrics.record(self.bucket_ms(), &key, value) == Err(Rejected::Dropped) {
            self.lose(1);
        }
    }

    // ---------- spans ----------

    /// Starts a span (`beginSpan(kind, name)`): a child of the current context, or a new trace.
    pub fn span<'a>(&'a self, kind: &'a str, name: &'a str) -> Span<'a> {
        Span::start(self, kind, name, None)
    }

    /// Starts a span for a channel (`beginSpan(kind, name, channel)`).
    pub fn span_for<'a>(&'a self, kind: &'a str, name: &'a str, channel: &str) -> Span<'a> {
        Span::start(self, kind, name, Some(label::channel(channel)))
    }

    /// `traced(kind, name, run)`: runs `future` in a new span that ends `error` when it returns
    /// `Err` (or when an outcome was set from inside), `ok` otherwise.
    pub async fn traced<T, E, F>(&self, kind: &str, name: &str, future: F) -> Result<T, E>
    where
        F: Future<Output = Result<T, E>>,
    {
        let mut span = self.span(kind, name);
        let result = span.run(future).await;
        span.end(if result.is_err() { "error" } else { "ok" });
        result
    }

    /// `restoreContext(saved, channel)`: a context continuing the saved trace when it is valid,
    /// otherwise a fresh one sampled at this handle's rate. Run work in it with
    /// [`TraceContext::scope`].
    pub fn restore(&self, saved: Option<&SavedTrace>, channel: &str) -> TraceContext {
        trace::restore(saved, channel, self.0.sample_rate)
    }

    /// A fresh root context (a new trace, sampled at this handle's rate).
    pub fn root(&self, channel: &str) -> TraceContext {
        trace::restore(None, channel, self.0.sample_rate)
    }

    pub(crate) fn new_ids(&self, parent: Option<SpanIds>) -> SpanIds {
        match parent {
            Some(parent) => SpanIds {
                trace_id: parent.trace_id,
                span_id: SpanId::random(),
                sampled: parent.sampled,
            },
            None => SpanIds {
                trace_id: TraceId::random(),
                span_id: SpanId::random(),
                sampled: trace::sample(self.0.sample_rate),
            },
        }
    }

    /// Ends a span: its metric, and its row when it is sampled, slow (at least one second) or
    /// failed.
    pub(crate) fn finish_span(&self, span: &FinishedSpan<'_>) {
        if !self.0.export {
            return;
        }
        self.record(
            span.kind,
            span.name,
            span.duration_ms,
            span.outcome,
            span.channel,
        );
        if span.sampled || span.duration_ms >= 1000.0 || span.outcome == "error" {
            // Only a kept span reads the precise wall clock for its start.
            let at = span.at.unwrap_or_else(|| {
                let duration = std::time::Duration::from_secs_f64(span.duration_ms / 1000.0);
                self.now_ms()
                    .saturating_sub(duration.as_millis().try_into().unwrap_or(u64::MAX))
            });
            if !self.0.spans.push(SpanRow::from_finished(span, at)) {
                self.lose(1);
            }
        }
    }

    /// A span that already happened (seams that report a duration at the end).
    pub(crate) fn completed_span(
        &self,
        kind: &str,
        name: &str,
        duration: Duration,
        outcome: &str,
        channel: Option<Channel>,
    ) {
        if !self.0.export {
            return;
        }
        let parent = trace::current();
        let ids = self.new_ids(parent.as_ref().map(TraceContext::ids));
        let duration_ms = duration.as_secs_f64() * 1000.0;
        self.finish_span(&FinishedSpan {
            trace_id: ids.trace_id,
            span_id: ids.span_id,
            parent: parent.as_ref().map(|context| context.ids().span_id),
            sampled: ids.sampled,
            channel: channel.unwrap_or_else(|| {
                parent
                    .as_ref()
                    .map_or(Channel::EMPTY, TraceContext::channel)
            }),
            at: None,
            duration_ms,
            kind,
            name,
            outcome,
        });
    }

    // ---------- logs ----------

    /// Whether a call at `level` does anything.
    pub fn enabled(&self, level: Level) -> bool {
        level >= self.0.min_level
    }

    /// Logs `data` at `level`. Below the minimum level this returns at once without serialising.
    pub fn log<T: Serialize + ?Sized>(&self, level: Level, data: &T, options: LogOptions<'_>) {
        if level < self.0.min_level {
            return;
        }
        self.emit(level, data, &options);
    }

    #[cold]
    fn emit<T: Serialize + ?Sized>(&self, level: Level, data: &T, options: &LogOptions<'_>) {
        // Bounded while it is walked; a failing or panicking `Serialize` is contained.
        let bounded = crate::bounded::to_value(data);
        if bounded.failed {
            self.0.unserializable.fetch_add(1, Ordering::Relaxed);
        }
        let mut value = bounded.value;
        let size = self.0.redactor.redact(&mut value);
        let context = trace::current();
        let trace_ids = context.as_ref().map(TraceContext::ids);
        let at = self.0.clock.now_ms();
        if level >= Level::Warn && self.0.export {
            let channel = options.channel_id.map_or_else(
                || {
                    context
                        .as_ref()
                        .map_or(Channel::EMPTY, TraceContext::channel)
                },
                label::channel,
            );
            let row = LogRow::from_data(
                u64::try_from(at).unwrap_or_default(),
                level.as_str(),
                &value,
                channel,
                trace_ids.map(|ids| ids.trace_id),
            );
            if !self.0.logs.push(row) {
                self.lose(1);
            }
        }
        match self
            .0
            .sinks
            .record(level, at, value, size, options, trace_ids)
        {
            Some(record) => {
                self.0.sinks.offer(&record);
            }
            None => {
                // The byte budget is spent: every destination loses it.
                let drops = &self.0.sinks.drops;
                if options.destination != crate::logger::Destination::Cache {
                    drops.console.fetch_add(1, Ordering::Relaxed);
                }
                if options.destination != crate::logger::Destination::Console {
                    drops.cache.fetch_add(1, Ordering::Relaxed);
                }
                if self.0.sinks.posthog.is_some() {
                    drops.posthog.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    /// `trace(data, options)`.
    pub fn trace<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Trace, data, options);
    }

    /// `debug(data, options)`.
    pub fn debug<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Debug, data, options);
    }

    /// `info(data, options)`.
    pub fn info<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Info, data, options);
    }

    /// `warn(data, options)`.
    pub fn warn<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Warn, data, options);
    }

    /// `error(data, options)`.
    pub fn error<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Error, data, options);
    }

    /// `fatal(data, options)`.
    pub fn fatal<T: Serialize + ?Sized>(&self, data: &T, options: LogOptions<'_>) {
        self.log(Level::Fatal, data, options);
    }

    /// A metadata-only telemetry log row (no console, cache or PostHog entry).
    pub(crate) fn record_metadata_log(&self, level: &'static str, data: &serde_json::Value) {
        if !self.0.export {
            return;
        }
        let context = trace::current();
        let row = LogRow::from_data(
            self.now_ms(),
            level,
            data,
            Channel::EMPTY,
            context.map(|context| context.ids().trace_id),
        );
        if !self.0.logs.push(row) {
            self.lose(1);
        }
    }

    /// A line for the console only (the reference's `console.error` reports), redacted.
    pub(crate) fn console_error(&self, text: &str) {
        let text = self.0.redactor.redact_text(text);
        let line = serde_json::json!({
            "level": "error",
            "time": crate::logger::iso_timestamp(self.0.clock.now_ms()),
            "data": text,
        });
        self.0.sinks.console_line(line.to_string());
    }

    // ---------- workers ----------

    /// The telemetry of one supervised task, reported under `prefix` (see [`crate::worker`]).
    pub fn worker(&self, prefix: &str) -> Worker {
        let cell = Arc::new(WorkerCell::new(prefix, self.now_ms()));
        let mut workers = self
            .0
            .workers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = workers.iter().find(|known| known.prefix() == cell.prefix()) {
            return Worker::new(self.clone(), existing.clone());
        }
        if workers.len() < MAX_WORKERS {
            workers.push(cell.clone());
        }
        Worker::new(self.clone(), cell)
    }

    // ---------- export ----------

    /// Counters.
    pub fn stats(&self) -> Stats {
        let drops = &self.0.sinks.drops;
        Stats {
            pipeline_dropped: self.0.dropped.load(Ordering::Relaxed),
            console_dropped: drops.console.load(Ordering::Relaxed),
            cache_dropped: drops.cache.load(Ordering::Relaxed),
            posthog_dropped: drops.posthog.load(Ordering::Relaxed),
            series: self.0.metrics.series(),
            payloads_sent: self.0.payloads_sent.load(Ordering::Relaxed),
            cache_written: self.0.cache_written.load(Ordering::Relaxed),
            unserializable: self.0.unserializable.load(Ordering::Relaxed),
            log_metadata_replaced: self.0.sinks.replaced.load(Ordering::Relaxed),
        }
    }

    /// Takes what is aggregated now without exporting it (tests and diagnostics). The taken data
    /// is not exported later.
    pub fn take_snapshot(&self) -> Snapshot {
        Snapshot {
            metrics: self.0.metrics.take(),
            spans: self.0.spans.take(),
            logs: self.0.logs.take(),
        }
    }

    /// Records the process and worker samples now (the exporter does this every 10 seconds).
    pub fn sample(&self) {
        if !self.0.export {
            return;
        }
        let mut sampler = self
            .0
            .process_sampler
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        sampler.sample(self);
    }

    /// Exports everything aggregated so far to the inbox, within [`FLUSH_DEADLINE`]. Concurrent
    /// calls return at once. A failure loses the data (counted) and never reaches the caller.
    pub async fn flush(&self) {
        if !self.0.export {
            return;
        }
        let Ok(_guard) = self.0.flushing.try_lock() else {
            return;
        };
        let taken = Taken {
            metrics: self.0.metrics.take(),
            spans: self.0.spans.take(),
            logs: self.0.logs.take(),
        };
        if taken.is_empty() {
            return;
        }
        let (payloads, oversized) =
            taken.encode(&self.0.service, &self.0.instance, self.now_ms(), uuid);
        self.lose(oversized);
        let mut sent = 0;
        let send = async {
            let dragonfly = self.0.store.get().await.ok_or(())?;
            for payload in &payloads {
                let _: i64 = ENQUEUE
                    .run(
                        &dragonfly,
                        &[self.0.inbox_key.as_str(), self.0.overflow_key.as_str()],
                        &[payload.json.as_bytes()],
                    )
                    .await
                    .map_err(|_| ())?;
                sent += 1;
            }
            Ok::<(), ()>(())
        };
        let ok = matches!(tokio::time::timeout(FLUSH_DEADLINE, send).await, Ok(Ok(())));
        self.0
            .payloads_sent
            .fetch_add(sent as u64, Ordering::Relaxed);
        if !ok {
            let lost: u64 = payloads
                .iter()
                .skip(sent)
                .map(|payload| payload.items)
                .sum();
            self.lose(lost);
            self.0.store.failed().await;
        }
    }

    /// Starts the background work: the console writer thread, the cache writer, the PostHog
    /// exporter, the runtime probe and the 10-second sampler and exporter. Requires a tokio
    /// runtime. Calling it twice starts nothing the second time.
    pub fn start(&self) -> Running {
        let stop = Shutdown::new();
        let mut tasks = Vec::new();
        let mut console = None;
        let receivers = self
            .0
            .receivers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(receivers) = receivers {
            if let Some((rx, target)) = receivers.console {
                console = std::thread::Builder::new()
                    .name("telemetry-console".to_owned())
                    .spawn(move || crate::logger::run_console(rx, target))
                    .ok();
            }
            if let Some(rx) = receivers.cache {
                tasks.push(tokio::spawn(run_cache_writer(
                    self.clone(),
                    rx,
                    stop.clone(),
                )));
            }
            let exporter = self
                .0
                .posthog
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let (Some(rx), Some(exporter)) = (receivers.posthog, exporter) {
                tasks.push(tokio::spawn(otlp::run(
                    exporter,
                    rx,
                    stop.clone(),
                    self.clone(),
                )));
            }
            if self.0.export {
                tasks.push(tokio::spawn(crate::process::run_probe(
                    self.clone(),
                    stop.clone(),
                )));
                tasks.push(tokio::spawn(run_exporter(self.clone(), stop.clone())));
            }
        }
        Running {
            telemetry: self.clone(),
            stop,
            tasks,
            console: console.is_some(),
        }
    }
}

/// The background work started by [`Telemetry::start`].
pub struct Running {
    telemetry: Telemetry,
    stop: Shutdown,
    tasks: Vec<JoinHandle<()>>,
    console: bool,
}

/// What [`Running::shutdown`] managed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShutdownReport {
    /// Every task finished its final flush within the deadline.
    pub clean: bool,
    /// Counters after the final flush.
    pub stats: Stats,
}

impl Running {
    /// Final sample and flush, then drains the log queues, all within `deadline`. Tasks still
    /// running at the deadline are aborted.
    pub async fn shutdown(mut self, deadline: Duration) -> ShutdownReport {
        self.stop.trigger();
        let until = Instant::now() + deadline;
        let mut clean = true;
        for task in std::mem::take(&mut self.tasks) {
            let abort = task.abort_handle();
            if tokio::time::timeout_at(until, task).await.is_err() {
                abort.abort();
                clean = false;
            }
        }
        if self.console
            && let Some(console) = &self.telemetry.0.sinks.console
        {
            // The queue may be full: retry until the writer takes the flush marker, then wait
            // for it to reach the marker.
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut message = ConsoleMessage::Flush(tx);
            let queued = loop {
                match console.try_send(message) {
                    Ok(()) => break true,
                    Err(std::sync::mpsc::TrySendError::Full(back)) if Instant::now() < until => {
                        message = back;
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Err(_) => break false,
                }
            };
            clean &= queued && tokio::time::timeout_at(until, rx).await.is_ok();
            let _ = console.try_send(ConsoleMessage::Stop);
        }
        ShutdownReport {
            clean,
            stats: self.telemetry.stats(),
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.trigger();
    }
}

/// Milliseconds until one second after the next 10-second boundary.
fn until_next_flush(now_ms: i64) -> Duration {
    let next = (now_ms.div_euclid(FLUSH_INTERVAL_MS) + 1) * FLUSH_INTERVAL_MS + FLUSH_OFFSET_MS;
    let mut wait = next - now_ms;
    if wait > FLUSH_INTERVAL_MS {
        wait -= FLUSH_INTERVAL_MS;
    }
    Duration::from_millis(u64::try_from(wait.max(1)).unwrap_or(1))
}

async fn run_exporter(telemetry: Telemetry, stop: Shutdown) {
    loop {
        let wait = until_next_flush(telemetry.0.clock.now_ms());
        tokio::select! {
            () = stop.wait() => break,
            () = tokio::time::sleep(wait) => {
                telemetry.sample();
                telemetry.flush().await;
            }
        }
    }
    telemetry.sample();
    telemetry.flush().await;
}

async fn run_cache_writer(
    telemetry: Telemetry,
    mut rx: tokio::sync::mpsc::Receiver<Arc<crate::logger::LogRecord>>,
    stop: Shutdown,
) {
    let mut batch = Vec::with_capacity(CACHE_BATCH);
    loop {
        let stopping = tokio::select! {
            biased;
            () = stop.wait() => true,
            record = rx.recv() => match record {
                Some(record) => { batch.push(record); false }
                None => true,
            },
        };
        while batch.len() < CACHE_BATCH {
            match rx.try_recv() {
                Ok(record) => batch.push(record),
                Err(_) => break,
            }
        }
        if !batch.is_empty() {
            write_cache_batch(&telemetry, &batch).await;
            batch.clear();
            if stopping {
                continue;
            }
        } else if stopping {
            return;
        }
    }
}

async fn write_cache_batch(telemetry: &Telemetry, batch: &[Arc<crate::logger::LogRecord>]) {
    let store = &telemetry.0.store;
    let write = async {
        let dragonfly = store.get().await.ok_or(())?;
        let mut pipeline = redis::pipe();
        for record in batch {
            let suffix = u32::try_from(trace::rng::next() >> 32).unwrap_or_default();
            let (key, value) = cache_entry(record, suffix);
            pipeline
                .cmd("SET")
                .arg(key)
                .arg(value)
                .arg("EX")
                .arg(crate::logger::CACHE_TTL_SECONDS)
                .ignore();
        }
        dragonfly
            .query_pipeline::<()>(&pipeline)
            .await
            .map_err(|_| ())
    };
    match tokio::time::timeout(CACHE_WRITE_DEADLINE, write).await {
        Ok(Ok(())) => {
            telemetry
                .0
                .cache_written
                .fetch_add(batch.len() as u64, Ordering::Relaxed);
        }
        _ => {
            telemetry
                .0
                .sinks
                .drops
                .cache
                .fetch_add(batch.len() as u64, Ordering::Relaxed);
            store.failed().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_land_one_second_after_each_boundary() {
        assert_eq!(until_next_flush(0), Duration::from_millis(1000));
        assert_eq!(until_next_flush(500), Duration::from_millis(500));
        assert_eq!(until_next_flush(1000), Duration::from_millis(10_000));
        assert_eq!(until_next_flush(1001), Duration::from_millis(9_999));
        assert_eq!(until_next_flush(9_999), Duration::from_millis(1_001));
    }

    #[test]
    fn env_values_follow_the_reference_switches() {
        let config = TelemetryConfig::new("api", "index");
        let on = config
            .clone()
            .with_env_values(None, Some("dragonfly"), Some("6379"), Some("k"));
        assert!(on.export && on.dragonfly.is_some() && on.secret_key.is_some());
        let off = config
            .clone()
            .with_env_values(Some("true"), Some("dragonfly"), None, None);
        assert!(!off.export && off.dragonfly.is_some());
        let other = config
            .clone()
            .with_env_values(Some("TRUE"), Some("h"), None, Some(""));
        assert!(other.export && other.secret_key.is_none());
        let none = config.with_env_values(None, Some(""), None, None);
        assert!(!none.export && none.dragonfly.is_none());
    }
}
