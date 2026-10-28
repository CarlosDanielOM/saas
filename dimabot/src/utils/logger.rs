//! Opt-in, explicitly constructed logging with independently bounded sinks.
//!
//! Nothing connects, reads environment, installs exporters, or starts tasks.
//! `log` confirms each selected sink's outcome; it never means queue acceptance.
//! There is deliberately no background queue or batching. Concurrent cache work
//! has item/byte admission limits, including a reserve for warning and above.
//! Rust JSON values exclude JavaScript cycles, BigInt, functions and undefined.
//! Payload errors are explicit rather than silently changing user data.
//!
//! Dropping a log future cancels its owned sink futures. A Redis timeout cannot
//! retract a command already sent: its server-side outcome can be unknown.
//! Shutdown closes admission and cancels sink futures, then waits up to its
//! deadline; its report exposes caller futures that have not yet been polled.

use futures_util::FutureExt;
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    future::Future,
    io::{self, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, watch};

#[cfg(feature = "logger-otel")]
pub mod otel;
#[cfg(feature = "logger-redis")]
pub mod redis;

pub const CACHE_TTL_SECONDS: u64 = 604_800;
pub type SinkFuture<'a> = Pin<Box<dyn Future<Output = Result<(), SinkError>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}
impl Level {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Fatal => "fatal",
        }
    }
    pub const fn high_priority(self) -> bool {
        matches!(self, Self::Warn | Self::Error | Self::Fatal)
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    Cache,
    Console,
    #[default]
    Both,
}
#[derive(Clone, Debug, Default)]
pub struct TraceContext {
    pub trace_id: Option<String>,
    pub channel: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct LogOptions {
    pub destination: Destination,
    pub platform: Option<String>,
    pub channel_id: Option<String>,
    pub context: Option<TraceContext>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    pub data: Value,
    pub timestamp: String,
    pub level: Level,
    pub platform: String,
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}
#[derive(Clone, Debug)]
pub struct CacheRecord {
    pub key: String,
    pub json: Arc<str>,
    pub ttl_seconds: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleStream {
    Stdout,
    Stderr,
}
#[derive(Clone, Debug)]
pub struct ConsoleRecord {
    pub stream: ConsoleStream,
    pub json: Arc<str>,
}
#[derive(Clone, Debug, Serialize)]
pub struct MetadataRecord {
    /// Whether the caller supplied a channel, including an empty or invalid one.
    #[serde(skip)]
    pub channel_explicit: bool,
    pub at: i64,
    pub level: Level,
    pub name: String,
    pub channel: String,
    #[serde(rename = "traceId")]
    pub trace_id: Option<String>,
    pub fields: Map<String, Value>,
}
#[derive(Clone, Debug)]
pub struct OtelRecord {
    pub level: Level,
    /// Bounded JSON, preserving JSON types when decoded by an adapter.
    pub body_json: Arc<str>,
    pub destination: Destination,
    pub platform: String,
    pub channel_id: Option<String>,
    pub trace_id: Option<String>,
}
/// Static errors only: sink implementations must not attach credentials/data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkError {
    Unavailable,
    Rejected,
    Io,
    Timeout,
}
impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "log sink unavailable",
            Self::Rejected => "log sink rejected record",
            Self::Io => "log sink I/O failed",
            Self::Timeout => "log sink deadline exceeded",
        })
    }
}
impl std::error::Error for SinkError {}
pub trait CacheSink: Send + Sync {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_>;
}
pub trait ConsoleSink: Send + Sync {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_>;
}
pub trait MetadataSink: Send + Sync {
    fn record(&self, record: MetadataRecord) -> SinkFuture<'_>;
}
pub trait OtelSink: Send + Sync {
    fn emit(&self, record: OtelRecord) -> SinkFuture<'_>;
}
#[derive(Clone, Default)]
pub struct SinkHandles {
    pub cache: Option<Arc<dyn CacheSink>>,
    pub console: Option<Arc<dyn ConsoleSink>>,
    pub metadata: Option<Arc<dyn MetadataSink>>,
    pub otel: Option<Arc<dyn OtelSink>>,
}
/// Console writes are explicit, synchronous and bounded by the payload limit.
/// OS stdout/stderr may block; an async deadline cannot interrupt an OS write.
/// Supply a nonblocking adapter when hard console latency limits are required.
pub struct StdConsole;
impl ConsoleSink for StdConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let result = match record.stream {
                ConsoleStream::Stdout => writeln!(io::stdout().lock(), "{}", record.json),
                ConsoleStream::Stderr => writeln!(io::stderr().lock(), "{}", record.json),
            };
            result.map_err(|_| SinkError::Io)
        })
    }
}
/// Bounded in-memory metadata sink for an explicit telemetry consumer.
/// `drain` transfers records to that consumer; no transport is installed.
pub struct MetadataCollector {
    capacity: usize,
    records: Mutex<Vec<MetadataRecord>>,
    dropped: AtomicU64,
}
impl MetadataCollector {
    pub fn new(capacity: usize) -> Result<Self, ConfigError> {
        if capacity == 0 || capacity > 10_000 {
            return Err(ConfigError);
        }
        Ok(Self {
            capacity,
            records: Mutex::new(Vec::new()),
            dropped: AtomicU64::new(0),
        })
    }
    pub fn drain(&self) -> Vec<MetadataRecord> {
        std::mem::take(&mut *self.records.lock().unwrap_or_else(|e| e.into_inner()))
    }
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}
impl MetadataSink for MetadataCollector {
    fn record(&self, record: MetadataRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
            if records.len() >= self.capacity {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return Err(SinkError::Rejected);
            }
            records.push(record);
            Ok(())
        })
    }
}
pub trait Clock: Send + Sync {
    fn now_millis(&self) -> i64;
}
pub trait IdSource: Send + Sync {
    fn next_id(&self) -> String;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_millis(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(value) => value.as_millis().min(i64::MAX as u128) as i64,
            Err(value) => -(value.duration().as_millis().min(i64::MAX as u128) as i64),
        }
    }
}
pub struct UuidSource;
impl IdSource for UuidSource {
    fn next_id(&self) -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }
}
#[derive(Clone, Debug)]
pub struct LoggerConfig {
    pub min_level: Level,
    /// One in N low-priority calls, deterministically, starting with the first.
    pub sample_every: u64,
    pub max_payload_bytes: usize,
    pub max_depth: usize,
    pub max_pending_calls: usize,
    pub reserved_high_calls: usize,
    pub max_pending_cache_items: usize,
    pub max_pending_cache_bytes: usize,
    pub reserved_high_items: usize,
    pub reserved_high_bytes: usize,
    pub sink_timeout: Duration,
}
impl Default for LoggerConfig {
    fn default() -> Self {
        Self {
            min_level: Level::Trace,
            sample_every: 1,
            max_payload_bytes: 64 * 1024,
            max_depth: 32,
            max_pending_calls: 128,
            reserved_high_calls: 16,
            max_pending_cache_items: 128,
            max_pending_cache_bytes: 8 * 1024 * 1024,
            reserved_high_items: 16,
            reserved_high_bytes: 1024 * 1024,
            sink_timeout: Duration::from_secs(2),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigError;
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid logger limits")
    }
}
impl std::error::Error for ConfigError {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkStatus {
    Skipped,
    Succeeded,
    Failed(SinkError),
    TimedOut,
    Dropped,
    Closed,
    Panicked,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Emitted,
    Filtered,
    SampledOut,
    InvalidPayload,
    Dropped,
    Closed,
    Panicked,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogReport {
    pub disposition: Disposition,
    pub cache: SinkStatus,
    pub console: SinkStatus,
    pub metadata: SinkStatus,
    pub otel: SinkStatus,
}
impl LogReport {
    fn empty(disposition: Disposition) -> Self {
        Self {
            disposition,
            cache: SinkStatus::Skipped,
            console: SinkStatus::Skipped,
            metadata: SinkStatus::Skipped,
            otel: SinkStatus::Skipped,
        }
    }
    pub fn success(&self) -> bool {
        matches!(
            self.disposition,
            Disposition::Emitted | Disposition::Filtered | Disposition::SampledOut
        ) && [self.cache, self.console, self.metadata, self.otel]
            .iter()
            .all(|s| matches!(s, SinkStatus::Skipped | SinkStatus::Succeeded))
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoggerStats {
    pub filtered: u64,
    pub sampled_out: u64,
    pub invalid_payload: u64,
    pub dropped_calls: u64,
    pub cache_admitted: u64,
    pub cache_dropped: u64,
    pub cache_failed: u64,
    pub cache_timed_out: u64,
    pub cache_succeeded: u64,
    pub active_calls: usize,
    pub pending_cache_items: usize,
    pub pending_cache_bytes: usize,
    pub closed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LifecycleReport {
    pub drained: bool,
    pub pending_calls: usize,
}
struct Shared {
    stats: Mutex<LoggerStats>,
    changed: Notify,
    cancel: watch::Sender<bool>,
}
impl Shared {
    fn stats(&self) -> MutexGuard<'_, LoggerStats> {
        self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }
}
#[derive(Clone)]
pub struct Logger {
    config: LoggerConfig,
    sinks: SinkHandles,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
    sequence: Arc<AtomicU64>,
    shared: Arc<Shared>,
}
struct CallGuard(Arc<Shared>);
impl Drop for CallGuard {
    fn drop(&mut self) {
        self.0.stats().active_calls -= 1;
        self.0.changed.notify_waiters();
    }
}
struct CacheGuard {
    shared: Arc<Shared>,
    bytes: usize,
}
impl Drop for CacheGuard {
    fn drop(&mut self) {
        let mut stats = self.shared.stats();
        stats.pending_cache_items -= 1;
        stats.pending_cache_bytes -= self.bytes;
        drop(stats);
        self.shared.changed.notify_waiters();
    }
}
impl Logger {
    pub fn new(
        config: LoggerConfig,
        sinks: SinkHandles,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
    ) -> Result<Self, ConfigError> {
        if config.sample_every == 0
            || config.max_payload_bytes == 0
            || config.max_payload_bytes > 16 * 1024 * 1024
            || config.max_pending_calls == 0
            || config.reserved_high_calls > config.max_pending_calls
            || config.max_depth == 0
            || config.max_depth > 64
            || config.max_pending_cache_items == 0
            || config.max_pending_cache_bytes == 0
            || config.reserved_high_items > config.max_pending_cache_items
            || config.reserved_high_bytes > config.max_pending_cache_bytes
            || config.sink_timeout.is_zero()
        {
            return Err(ConfigError);
        }
        let (cancel, _) = watch::channel(false);
        Ok(Self {
            config,
            sinks,
            clock,
            ids,
            sequence: Arc::new(AtomicU64::new(0)),
            shared: Arc::new(Shared {
                stats: Mutex::new(LoggerStats::default()),
                changed: Notify::new(),
                cancel,
            }),
        })
    }
    pub fn stats(&self) -> LoggerStats {
        *self.shared.stats()
    }
    pub fn log(
        &self,
        level: Level,
        data: Value,
        options: LogOptions,
    ) -> impl Future<Output = LogReport> + '_ {
        // Construct the owner before returning the future, so even a never-
        // polled or early-filtered eager call safely disposes extreme nesting.
        let payload = OwnedPayload {
            value: Some(data),
            max_depth: self.config.max_depth,
            max_bytes: self.config.max_payload_bytes,
        };
        async move { self.log_lazy(level, options, move || payload.take()).await }
    }
    pub async fn log_lazy<F>(&self, level: Level, options: LogOptions, payload: F) -> LogReport
    where
        F: FnOnce() -> Value,
    {
        {
            let mut stats = self.shared.stats();
            if stats.closed {
                return LogReport::empty(Disposition::Closed);
            }
            if level < self.config.min_level {
                stats.filtered += 1;
                return LogReport::empty(Disposition::Filtered);
            }
            if !level.high_priority()
                && !self
                    .sequence
                    .fetch_add(1, Ordering::Relaxed)
                    .is_multiple_of(self.config.sample_every)
            {
                stats.sampled_out += 1;
                return LogReport::empty(Disposition::SampledOut);
            }
            let call_limit = if level.high_priority() {
                self.config.max_pending_calls
            } else {
                self.config.max_pending_calls - self.config.reserved_high_calls
            };
            if stats.active_calls >= call_limit {
                stats.dropped_calls += 1;
                return LogReport::empty(Disposition::Dropped);
            }
            stats.active_calls += 1;
        }
        let _call = CallGuard(self.shared.clone());
        let prepared = catch_unwind(AssertUnwindSafe(|| {
            let data = payload();
            let mut remaining = self.config.max_payload_bytes;
            if validate_value(&data, 0, self.config.max_depth, &mut remaining).is_none() {
                drop_value_iterative(data);
                return None;
            }
            let at = self.clock.now_millis();
            // JavaScript Date's supported interval, avoiding calendar overflow.
            if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&at) {
                return None;
            }
            let platform = options
                .platform
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("twitch");
            if platform.len() > 256 || options.channel_id.as_ref().is_some_and(|s| s.len() > 256) {
                return None;
            }
            let body_json: Arc<str> = encode(&data, self.config.max_payload_bytes)?.into();
            let metadata = metadata_record(at, level, &data, &options);
            let entry = LogEntry {
                data,
                timestamp: format_timestamp(at),
                level,
                platform: platform.into(),
                channel_id: options.channel_id.clone(),
            };
            let json: Arc<str> = encode(&entry, self.config.max_payload_bytes)?.into();
            let id = self.ids.next_id();
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return None;
            }
            let channel = entry
                .channel_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("global");
            let key = format!(
                "logger:{}:{channel}:{}:{at}-{id}",
                entry.platform,
                level.as_str()
            );
            let otel = OtelRecord {
                level,
                body_json,
                destination: options.destination,
                platform: entry.platform,
                channel_id: entry.channel_id,
                trace_id: metadata.trace_id.clone(),
            };
            Some((
                CacheRecord {
                    key,
                    json: json.clone(),
                    ttl_seconds: CACHE_TTL_SECONDS,
                },
                ConsoleRecord {
                    stream: if level.high_priority() {
                        ConsoleStream::Stderr
                    } else {
                        ConsoleStream::Stdout
                    },
                    json,
                },
                metadata,
                otel,
            ))
        }));
        let (cache, console, metadata, otel) = match prepared {
            Ok(Some(records)) => records,
            Ok(None) => {
                self.shared.stats().invalid_payload += 1;
                return LogReport::empty(Disposition::InvalidPayload);
            }
            Err(_) => return LogReport::empty(Disposition::Panicked),
        };
        let cache_enabled = matches!(options.destination, Destination::Cache | Destination::Both);
        let console_enabled = matches!(
            options.destination,
            Destination::Console | Destination::Both
        );
        let cache_future = async {
            if !cache_enabled {
                return SinkStatus::Skipped;
            }
            let Some(sink) = &self.sinks.cache else {
                return SinkStatus::Failed(SinkError::Unavailable);
            };
            let Some(_permit) = self.admit_cache(level, cache.key.len() + cache.json.len()) else {
                return SinkStatus::Dropped;
            };
            let result = self.run_sink(|| sink.store(cache)).await;
            let mut stats = self.shared.stats();
            match result {
                SinkStatus::Succeeded => stats.cache_succeeded += 1,
                SinkStatus::TimedOut => stats.cache_timed_out += 1,
                _ => stats.cache_failed += 1,
            }
            result
        };
        let console_future = async {
            if !console_enabled {
                return SinkStatus::Skipped;
            }
            match &self.sinks.console {
                Some(sink) => self.run_sink(|| sink.write(console)).await,
                None => SinkStatus::Failed(SinkError::Unavailable),
            }
        };
        let metadata_future = async {
            if !level.high_priority() {
                return SinkStatus::Skipped;
            }
            match &self.sinks.metadata {
                Some(sink) => self.run_sink(|| sink.record(metadata)).await,
                None => SinkStatus::Skipped,
            }
        };
        let otel_future = async {
            match &self.sinks.otel {
                Some(sink) => self.run_sink(|| sink.emit(otel)).await,
                None => SinkStatus::Skipped,
            }
        };
        let (cache, console, metadata, otel) =
            tokio::join!(cache_future, console_future, metadata_future, otel_future);
        LogReport {
            disposition: Disposition::Emitted,
            cache,
            console,
            metadata,
            otel,
        }
    }
    fn admit_cache(&self, level: Level, bytes: usize) -> Option<CacheGuard> {
        let mut stats = self.shared.stats();
        let (items_limit, bytes_limit) = if level.high_priority() {
            (
                self.config.max_pending_cache_items,
                self.config.max_pending_cache_bytes,
            )
        } else {
            (
                self.config.max_pending_cache_items - self.config.reserved_high_items,
                self.config.max_pending_cache_bytes - self.config.reserved_high_bytes,
            )
        };
        if stats.closed
            || stats.pending_cache_items >= items_limit
            || bytes > bytes_limit.saturating_sub(stats.pending_cache_bytes)
        {
            stats.cache_dropped += 1;
            return None;
        }
        stats.pending_cache_items += 1;
        stats.pending_cache_bytes += bytes;
        stats.cache_admitted += 1;
        Some(CacheGuard {
            shared: self.shared.clone(),
            bytes,
        })
    }
    async fn run_sink<'a, F>(&'a self, sink: F) -> SinkStatus
    where
        F: FnOnce() -> SinkFuture<'a>,
    {
        let mut cancel = self.shared.cancel.subscribe();
        if *cancel.borrow() {
            return SinkStatus::Closed;
        }
        // Enclose both future construction and polling in the unwind boundary.
        let future = AssertUnwindSafe(async { sink().await }).catch_unwind();
        tokio::select! {
            biased;
            _ = cancel.changed() => SinkStatus::Closed,
            result = tokio::time::timeout(self.config.sink_timeout, future) => match result {
                Err(_) => SinkStatus::TimedOut,
                Ok(Err(_)) => SinkStatus::Panicked,
                Ok(Ok(Err(SinkError::Timeout))) => SinkStatus::TimedOut,
                Ok(Ok(Err(error))) => SinkStatus::Failed(error),
                Ok(Ok(Ok(()))) => SinkStatus::Succeeded,
            }
        }
    }
    /// Waits for the current calls. Concurrent producers can extend the wait.
    pub async fn flush(&self, timeout: Duration) -> LifecycleReport {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let changed = self.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let pending_calls = self.shared.stats().active_calls;
            if pending_calls == 0 {
                return LifecycleReport {
                    drained: true,
                    pending_calls: 0,
                };
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                let pending_calls = self.shared.stats().active_calls;
                return LifecycleReport {
                    drained: pending_calls == 0,
                    pending_calls,
                };
            }
        }
    }
    /// Idempotently closes admission and cancels in-flight sink futures.
    /// This owns no tasks; unpolled caller futures are exposed in the report.
    pub async fn shutdown(&self, timeout: Duration) -> LifecycleReport {
        self.shared.stats().closed = true;
        self.shared.cancel.send_replace(true);
        self.flush(timeout).await
    }
}

// Callers construct their own Values. The logger bounds inspection/encoding;
// rejection must also avoid serde_json Value's recursive destructor on trees
// that exceed that depth. Valid bounded Values retain their normal destructor.
struct OwnedPayload {
    value: Option<Value>,
    max_depth: usize,
    max_bytes: usize,
}
impl OwnedPayload {
    fn take(mut self) -> Value {
        self.value.take().expect("owned logger payload")
    }
}
impl Drop for OwnedPayload {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            let mut remaining = self.max_bytes;
            if validate_value(&value, 0, self.max_depth, &mut remaining).is_some() {
                drop(value);
            } else {
                drop_value_iterative(value);
            }
        }
    }
}
fn drop_value_iterative(value: Value) {
    enum Children {
        Array(std::vec::IntoIter<Value>),
        Object(serde_json::map::IntoIter),
    }
    impl Children {
        fn next(&mut self) -> Option<Value> {
            match self {
                Self::Array(values) => values.next(),
                Self::Object(values) => values.next().map(|(_, value)| value),
            }
        }
    }
    // Iterator frames keep auxiliary memory proportional to depth rather than
    // breadth. Exhaust each frame before its destructor can see child Values.
    let mut stack: Vec<Children> = Vec::new();
    let mut next = Some(value);
    loop {
        if let Some(value) = next.take() {
            match value {
                Value::Array(values) => stack.push(Children::Array(values.into_iter())),
                Value::Object(values) => stack.push(Children::Object(values.into_iter())),
                _ => {}
            }
        }
        loop {
            let Some(frame) = stack.last_mut() else {
                return;
            };
            if let Some(value) = frame.next() {
                next = Some(value);
                break;
            }
            stack.pop();
        }
    }
}

fn validate_value(value: &Value, depth: usize, limit: usize, remaining: &mut usize) -> Option<()> {
    if depth > limit || *remaining == 0 {
        return None;
    }
    *remaining -= 1;
    match value {
        Value::String(s) => *remaining = remaining.checked_sub(s.len())?,
        Value::Array(values) => {
            for value in values {
                validate_value(value, depth + 1, limit, remaining)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                *remaining = remaining.checked_sub(key.len())?;
                validate_value(value, depth + 1, limit, remaining)?;
            }
        }
        _ => {}
    }
    Some(())
}
struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for BoundedWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("log payload limit"));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode<T: Serialize>(value: &T, limit: usize) -> Option<String> {
    let mut writer = BoundedWriter {
        bytes: Vec::with_capacity(limit.min(4096)),
        limit,
    };
    serde_json::to_writer(&mut writer, value).ok()?;
    String::from_utf8(writer.bytes).ok()
}
fn clean(value: &str, max: usize) -> String {
    value
        .encode_utf16()
        .take(max)
        .map(|c| {
            if c <= 127 && ((c as u8).is_ascii_alphanumeric() || b"_.:/ -".contains(&(c as u8))) {
                char::from(c as u8)
            } else {
                '_'
            }
        })
        .collect()
}
fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_trace(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
// Same small numeric formatting policy already used by permissions and raid
// session ports; kept local so selecting the logger cannot enable those APIs.
fn number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let rendered = format!("{value:e}");
        if let Some((mantissa, exponent)) = rendered.split_once('e') {
            return format!(
                "{mantissa}e{}{exponent}",
                if exponent.starts_with('-') { "" } else { "+" }
            );
        }
    }
    value.to_string()
}
pub(crate) fn metadata_name(value: &Value) -> String {
    match value {
        Value::String(s) => clean(s, 100),
        Value::Null => String::new(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => clean(&number_string(v.as_f64().unwrap_or(0.0)), 100),
        Value::Object(_) => "_object Object_".into(),
        // Avoid scanning/stringifying unbounded arrays; payload bounds have
        // already been checked. JS array coercion joins recursive elements.
        Value::Array(values) => {
            let mut result = String::new();
            for (index, v) in values.iter().enumerate() {
                if index != 0 {
                    result.push('_');
                }
                result.push_str(&metadata_name(v));
                if result.len() >= 100 {
                    result.truncate(100);
                    break;
                }
            }
            result
        }
    }
}
fn metadata_record(at: i64, level: Level, data: &Value, options: &LogOptions) -> MetadataRecord {
    let mut fields = Map::new();
    for key in [
        "function",
        "step",
        "status",
        "code",
        "errorCode",
        "operation",
        "provider",
        "attempt",
        "durationMs",
    ] {
        match data.get(key) {
            Some(Value::String(s)) => {
                fields.insert(key.into(), Value::String(clean(s, 80)));
            }
            Some(value @ (Value::Bool(_) | Value::Number(_))) => {
                fields.insert(key.into(), value.clone());
            }
            _ => {}
        }
    }
    let name = data
        .get("function")
        .filter(|v| js_truthy(v))
        .or_else(|| data.get("operation").filter(|v| js_truthy(v)))
        .map(metadata_name)
        .unwrap_or_else(|| "application".into());
    let context = options.context.as_ref();
    let channel = options
        .channel_id
        .as_deref()
        .or_else(|| context.and_then(|v| v.channel.as_deref()))
        .filter(|s| valid_channel(s))
        .unwrap_or("")
        .into();
    let trace_id = context
        .and_then(|v| v.trace_id.as_deref())
        .filter(|s| valid_trace(s))
        .map(str::to_owned);
    MetadataRecord {
        channel_explicit: options.channel_id.is_some(),
        at,
        level,
        name,
        channel,
        trace_id,
        fields,
    }
}
/// UTC en-US date format used by the TypeScript logger (no leading zeros).
pub fn format_timestamp(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days, with Euclidean eras for pre-epoch dates.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if year <= 0 {
        year = 1 - year;
    }
    let seconds = millis.div_euclid(1000).rem_euclid(86_400);
    let hour = seconds / 3600;
    format!(
        "{month}/{day}/{year}, {}:{:02}:{:02} {}",
        if hour % 12 == 0 { 12 } else { hour % 12 },
        seconds / 60 % 60,
        seconds % 60,
        if hour >= 12 { "PM" } else { "AM" }
    )
}

#[cfg(test)]
mod tests;
