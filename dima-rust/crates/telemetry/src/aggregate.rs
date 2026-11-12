//! In-memory aggregation with the reference's bounds, and the inbox payload format.
//!
//! **Metrics** are counted per series (kind, name, channel, outcome) and 10-second bucket. Series
//! live in a few shards, each behind its own mutex; a thread always uses the same shard, so in
//! practice a lock is uncontended. A flush swaps each shard's map for an empty one under the lock
//! and does everything else outside it, so recording waits at most for that swap; the price is
//! that the first observation of a series after a flush allocates its key again (once per series
//! per 10 seconds). At most [`MAX_SERIES`] series exist at once (the reference's 2000 keys),
//! counting those a running flush still holds; beyond that new series are dropped and counted. A series holds two bucket slots: the exporter flushes one second after each
//! 10-second boundary, so between two flushes at most two buckets receive data.
//!
//! **Spans** (at most 300 per flush) and **telemetry logs** (at most 100) are kept as rows.
//!
//! **Payloads** are the reference's version-1 envelope, split into batches of 100 metrics, 50
//! spans and 25 logs; a batch over 256,000 bytes is dropped and counted.

use crate::label::{self, CHANNEL_MAX, Channel, KIND_MAX, Label, MetricKey, NAME_MAX, OUTCOME_MAX};
use crate::trace::{SpanId, TraceId};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

/// The histogram upper bounds in milliseconds (`LATENCY_BOUNDS`).
pub const LATENCY_BOUNDS: [f64; 16] = [
    1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 30000.0,
    60000.0, 300000.0, 1e12,
];
/// Most series held at once (the reference's 2000 metric keys per flush).
pub const MAX_SERIES: usize = 2000;
/// Most spans per flush.
pub const MAX_SPANS: usize = 300;
/// Most telemetry logs per flush.
pub const MAX_LOGS: usize = 100;
/// Metrics per payload.
pub const BATCH_METRICS: usize = 100;
/// Spans per payload.
pub const BATCH_SPANS: usize = 50;
/// Logs per payload.
pub const BATCH_LOGS: usize = 25;
/// Largest payload in bytes.
pub const MAX_PAYLOAD_BYTES: usize = 256_000;
/// The bucket width in milliseconds.
pub const BUCKET_MS: u64 = 10_000;
/// The consumer's numeric ceiling (`number(v)`: at most 1e15).
pub const MAX_NUMBER: f64 = 1e15;
/// The consumer's count ceiling per row.
pub const MAX_COUNT: u64 = 100_000_000;

const SHARDS: usize = 8;

#[derive(Clone, Copy, Default)]
struct Slot {
    at: u64,
    count: u64,
    sum: f64,
    max: f64,
    histogram: [u32; 16],
}

impl Slot {
    fn add(&mut self, value: f64) -> bool {
        let sum = self.sum + value.max(0.0);
        if self.count >= MAX_COUNT || !sum.is_finite() || sum > MAX_NUMBER {
            return false;
        }
        self.count += 1;
        self.sum = sum;
        self.max = self.max.max(value);
        let bucket = LATENCY_BOUNDS
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(LATENCY_BOUNDS.len() - 1);
        self.histogram[bucket] += 1;
        true
    }

    fn merge(&mut self, other: &Slot) {
        self.count += other.count;
        self.sum += other.sum;
        self.max = self.max.max(other.max);
        for (mine, theirs) in self.histogram.iter_mut().zip(other.histogram.iter()) {
            *mine += theirs;
        }
    }
}

#[derive(Default)]
struct Series {
    slots: [Slot; 2],
}

#[derive(Default)]
struct Shard {
    map: HashMap<Box<[u8]>, Series>,
}

/// Why an observation was not counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejected {
    /// The value is not finite.
    Invalid,
    /// A bound was hit; the observation is lost and counted.
    Dropped,
}

/// The metric store.
pub(crate) struct Metrics {
    shards: Box<[Mutex<Shard>]>,
    /// Per shard, how many series the last flush took: the next map is allocated with that
    /// capacity before the lock is taken, so refilling does not regrow it under the lock.
    capacity: Box<[AtomicUsize]>,
    series: AtomicUsize,
    /// The longest time a flush held one shard's lock, in nanoseconds (tests).
    #[cfg(test)]
    longest_hold_ns: std::sync::atomic::AtomicU64,
}

thread_local! {
    static SHARD: usize = next_shard();
}

fn next_shard() -> usize {
    use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};
    let hash = BuildHasherDefault::<DefaultHasher>::default().hash_one(std::thread::current().id());
    usize::try_from(hash % SHARDS as u64).unwrap_or_default()
}

/// One metric row of a payload (the reference's `Metric`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MetricRow {
    /// The bucket start, epoch milliseconds.
    pub at: u64,
    /// The kind.
    pub kind: String,
    /// The name.
    pub name: String,
    /// The channel, or empty.
    pub channel: String,
    /// The outcome.
    pub outcome: String,
    /// Observations.
    pub count: u64,
    /// Sum of the non-negative values.
    pub sum: f64,
    /// Largest value.
    pub max: f64,
    /// Counts per [`LATENCY_BOUNDS`] bucket.
    pub histogram: [u32; 16],
}

impl Metrics {
    pub(crate) fn new() -> Self {
        Self {
            shards: (0..SHARDS).map(|_| Mutex::new(Shard::default())).collect(),
            capacity: (0..SHARDS).map(|_| AtomicUsize::new(0)).collect(),
            series: AtomicUsize::new(0),
            #[cfg(test)]
            longest_hold_ns: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Adds one observation. Allocation-free when the series exists.
    pub(crate) fn record(&self, at: u64, key: &MetricKey, value: f64) -> Result<(), Rejected> {
        if !value.is_finite() {
            return Err(Rejected::Invalid);
        }
        // The consumer rejects any number above 1e15: drop it here rather than poison a batch.
        if value > MAX_NUMBER {
            return Err(Rejected::Dropped);
        }
        let bucket = at / BUCKET_MS * BUCKET_MS;
        let index = SHARD.with(|index| *index);
        let mut shard = self.shards[index]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let series = match shard.map.get_mut(key.bytes()) {
            Some(series) => series,
            None => {
                // Reserve a series slot first, so the global bound holds under concurrency.
                let reserved =
                    self.series
                        .try_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                            (count < MAX_SERIES).then_some(count + 1)
                        });
                if reserved.is_err() {
                    return Err(Rejected::Dropped);
                }
                shard.map.entry(Box::from(key.bytes())).or_default()
            }
        };
        let slot = if series.slots[0].count > 0 && series.slots[0].at == bucket {
            &mut series.slots[0]
        } else if series.slots[1].count > 0 && series.slots[1].at == bucket {
            &mut series.slots[1]
        } else if series.slots[0].count == 0 {
            series.slots[0].at = bucket;
            &mut series.slots[0]
        } else if series.slots[1].count == 0 {
            series.slots[1].at = bucket;
            &mut series.slots[1]
        } else {
            // A third bucket before a flush: the exporter is stuck. Lose it, visibly.
            return Err(Rejected::Dropped);
        };
        if slot.add(value) {
            Ok(())
        } else {
            Err(Rejected::Dropped)
        }
    }

    /// Takes every counted bucket, merged across shards. Each shard's lock is held only to swap
    /// its map for an empty one allocated beforehand: copying, merging and freeing happen outside it,
    /// so a recording thread never waits for more than that swap. The taken series stay counted
    /// against [`MAX_SERIES`] until they are merged and freed, so the bound on resident series
    /// holds while a flush runs.
    pub(crate) fn take(&self) -> Vec<MetricRow> {
        let mut taken = Vec::with_capacity(SHARDS);
        for (shard, capacity) in self.shards.iter().zip(self.capacity.iter()) {
            let mut map = HashMap::with_capacity(capacity.load(Ordering::Relaxed));
            let mut guard = shard.lock().unwrap_or_else(PoisonError::into_inner);
            #[cfg(test)]
            let held = std::time::Instant::now();
            std::mem::swap(&mut guard.map, &mut map);
            drop(guard);
            #[cfg(test)]
            self.held(held);
            capacity.store(map.len(), Ordering::Relaxed);
            taken.push(map);
        }
        let held: usize = taken.iter().map(HashMap::len).sum();
        let mut merged: HashMap<(Box<[u8]>, u64), Slot> = HashMap::new();
        for map in taken {
            for (key, series) in map {
                // The key moves into the merged row; it is copied only for a second bucket.
                let [first, second] = series.slots;
                if second.count > 0 {
                    merged
                        .entry((key.clone(), second.at))
                        .or_default()
                        .merge(&second);
                }
                if first.count > 0 {
                    merged.entry((key, first.at)).or_default().merge(&first);
                }
            }
        }
        self.series.fetch_sub(held, Ordering::Relaxed);
        let mut rows: Vec<MetricRow> = merged
            .into_iter()
            .map(|((key, at), slot)| {
                let (kind, name, channel, outcome) = label::split_key(&key);
                MetricRow {
                    at,
                    kind: kind.to_owned(),
                    name: name.to_owned(),
                    channel: channel.to_owned(),
                    outcome: outcome.to_owned(),
                    count: slot.count,
                    sum: slot.sum,
                    max: slot.max,
                    histogram: slot.histogram,
                }
            })
            .collect();
        rows.sort_by(|a, b| (a.at, &a.kind, &a.name).cmp(&(b.at, &b.kind, &b.name)));
        rows
    }

    #[cfg(test)]
    fn held(&self, since: std::time::Instant) {
        let nanos = u64::try_from(since.elapsed().as_nanos()).unwrap_or(u64::MAX);
        self.longest_hold_ns.fetch_max(nanos, Ordering::Relaxed);
    }

    /// Series currently held.
    pub(crate) fn series(&self) -> usize {
        self.series.load(Ordering::Relaxed)
    }
}

/// One span row of a payload (the reference's `Span`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SpanRow {
    /// 32 hex characters.
    #[serde(rename = "traceId")]
    pub trace_id: String,
    /// 16 hex characters.
    #[serde(rename = "spanId")]
    pub span_id: String,
    /// Whether the trace was sampled.
    pub sampled: bool,
    /// The channel, or empty.
    pub channel: String,
    /// The parent span, or null.
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    /// Start, epoch milliseconds.
    pub at: u64,
    /// Milliseconds.
    pub duration: f64,
    /// The kind.
    pub kind: String,
    /// The name.
    pub name: String,
    /// The final outcome.
    pub outcome: String,
    /// `!sampled`: kept only because it was slow or failed.
    pub partial: bool,
}

/// What a finished span contributes when it is kept.
pub(crate) struct FinishedSpan<'a> {
    pub(crate) trace_id: TraceId,
    pub(crate) span_id: SpanId,
    pub(crate) parent: Option<SpanId>,
    pub(crate) sampled: bool,
    pub(crate) channel: Channel,
    /// The start, when known; otherwise computed from the end only if the span is kept.
    pub(crate) at: Option<u64>,
    pub(crate) duration_ms: f64,
    pub(crate) kind: &'a str,
    pub(crate) name: &'a str,
    pub(crate) outcome: &'a str,
}

impl SpanRow {
    pub(crate) fn from_finished(span: &FinishedSpan<'_>, at: u64) -> Self {
        Self {
            trace_id: span.trace_id.hex().as_str().to_owned(),
            span_id: span.span_id.hex().as_str().to_owned(),
            sampled: span.sampled,
            channel: span.channel.as_str().to_owned(),
            parent_id: span.parent.map(|id| id.hex().as_str().to_owned()),
            at,
            duration: span.duration_ms.clamp(0.0, MAX_NUMBER),
            kind: Label::<KIND_MAX>::clean(span.kind).as_str().to_owned(),
            name: Label::<NAME_MAX>::clean(span.name).as_str().to_owned(),
            outcome: Label::<OUTCOME_MAX>::clean(span.outcome)
                .as_str()
                .to_owned(),
            partial: !span.sampled,
        }
    }
}

/// One telemetry log row (the reference's `TelemetryLog`): metadata only.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LogRow {
    /// Epoch milliseconds.
    pub at: u64,
    /// `warn`, `error` or `fatal`.
    pub level: &'static str,
    /// `function`, else `operation`, else `application` (cleaned).
    pub name: String,
    /// The channel, or empty.
    pub channel: String,
    /// The current trace, or null.
    #[serde(rename = "traceId")]
    pub trace_id: Option<String>,
    /// Allow-listed metadata fields.
    pub fields: Map<String, Value>,
}

/// The reference's explicit metadata allow-list: free-text messages and errors often contain user
/// data, so nothing else leaves the process.
pub const LOG_FIELDS: [&str; 9] = [
    "function",
    "step",
    "status",
    "code",
    "errorCode",
    "operation",
    "provider",
    "attempt",
    "durationMs",
];

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn name_of(value: &Value) -> String {
    match value {
        Value::String(text) => Label::<NAME_MAX>::clean(text).as_str().to_owned(),
        Value::Number(number) => Label::<NAME_MAX>::clean(&number.to_string())
            .as_str()
            .to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Array(_) => "application".to_owned(),
        Value::Object(_) => "_object Object_".to_owned(),
        Value::Null => String::new(),
    }
}

impl LogRow {
    pub(crate) fn from_data(
        at: u64,
        level: &'static str,
        data: &Value,
        channel: Channel,
        trace_id: Option<TraceId>,
    ) -> Self {
        let mut fields = Map::new();
        for key in LOG_FIELDS {
            match data.get(key) {
                Some(value @ (Value::Bool(_) | Value::Number(_))) => {
                    fields.insert(key.to_owned(), value.clone());
                }
                Some(Value::String(text)) => {
                    let text = Label::<80>::clean(text);
                    fields.insert(key.to_owned(), Value::String(text.as_str().to_owned()));
                }
                _ => {}
            }
        }
        let name = data
            .get("function")
            .filter(|value| truthy(value))
            .or_else(|| data.get("operation").filter(|value| truthy(value)))
            .map(name_of)
            .unwrap_or_else(|| "application".to_owned());
        Self {
            at,
            level,
            name,
            channel: channel.as_str().to_owned(),
            trace_id: trace_id.map(|id| id.hex().as_str().to_owned()),
            fields,
        }
    }
}

/// Bounded row buffers for spans and telemetry logs.
pub(crate) struct Rows<T> {
    rows: Mutex<Vec<T>>,
    max: usize,
}

impl<T> Rows<T> {
    pub(crate) fn new(max: usize) -> Self {
        Self {
            rows: Mutex::new(Vec::new()),
            max,
        }
    }

    /// Adds a row, or returns false when the buffer is full.
    pub(crate) fn push(&self, row: T) -> bool {
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        if rows.len() >= self.max {
            return false;
        }
        rows.push(row);
        true
    }

    pub(crate) fn take(&self) -> Vec<T> {
        std::mem::take(&mut *self.rows.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// The version-1 envelope.
#[derive(Serialize)]
struct Envelope<'a> {
    version: u8,
    id: &'a str,
    service: &'a str,
    instance: &'a str,
    at: u64,
    metrics: &'a [MetricRow],
    spans: &'a [SpanRow],
    logs: &'a [LogRow],
}

/// One encoded payload and what it carries (for loss accounting).
pub(crate) struct Payload {
    pub(crate) json: String,
    /// Observations, spans and logs in it.
    pub(crate) items: u64,
}

/// Everything one flush exports.
#[derive(Default)]
pub(crate) struct Taken {
    pub(crate) metrics: Vec<MetricRow>,
    pub(crate) spans: Vec<SpanRow>,
    pub(crate) logs: Vec<LogRow>,
}

impl Taken {
    pub(crate) fn is_empty(&self) -> bool {
        self.metrics.is_empty() && self.spans.is_empty() && self.logs.is_empty()
    }

    /// Splits into payloads. Oversized batches are skipped and returned as the second value
    /// (how many batches and the items they held).
    pub(crate) fn encode(
        &self,
        service: &str,
        instance: &str,
        at: u64,
        mut id: impl FnMut() -> String,
    ) -> (Vec<Payload>, u64) {
        let batches = 1
            .max(self.metrics.len().div_ceil(BATCH_METRICS))
            .max(self.spans.len().div_ceil(BATCH_SPANS))
            .max(self.logs.len().div_ceil(BATCH_LOGS));
        let mut payloads = Vec::with_capacity(batches);
        let mut oversized = 0;
        for index in 0..batches {
            let metrics = chunk(&self.metrics, index, BATCH_METRICS);
            let spans = chunk(&self.spans, index, BATCH_SPANS);
            let logs = chunk(&self.logs, index, BATCH_LOGS);
            let items = metrics.iter().map(|row| row.count).sum::<u64>()
                + spans.len() as u64
                + logs.len() as u64;
            let id = id();
            let envelope = Envelope {
                version: 1,
                id: &id,
                service,
                instance,
                at,
                metrics,
                spans,
                logs,
            };
            match serde_json::to_string(&envelope) {
                Ok(json) if json.len() <= MAX_PAYLOAD_BYTES => {
                    payloads.push(Payload { json, items })
                }
                _ => oversized += 1,
            }
        }
        (payloads, oversized)
    }
}

fn chunk<T>(rows: &[T], index: usize, size: usize) -> &[T] {
    let start = (index * size).min(rows.len());
    let end = ((index + 1) * size).min(rows.len());
    rows.get(start..end).unwrap_or_default()
}

/// The channel label bound, re-exported for callers that validate ahead of time.
pub const CHANNEL_LIMIT: usize = CHANNEL_MAX;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::label::Channel;

    fn key(name: &str) -> MetricKey {
        MetricKey::new("command", name, &Channel::EMPTY, "ok")
    }

    #[test]
    fn aggregates_count_sum_max_and_histogram() {
        let metrics = Metrics::new();
        for value in [0.5, 3.0, 7.0, 2e6, -4.0] {
            metrics.record(20_005, &key("a"), value).ok();
        }
        let rows = metrics.take();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(
            (row.at, row.count, row.sum, row.max),
            (20_000, 5, 2_000_010.5, 2e6)
        );
        assert_eq!(row.histogram[0], 2); // 0.5 and -4
        assert_eq!(row.histogram[1], 1);
        assert_eq!(row.histogram[2], 1);
        assert_eq!(row.histogram[15], 1);
        assert_eq!(
            row.histogram.iter().map(|n| u64::from(*n)).sum::<u64>(),
            row.count
        );
    }

    #[test]
    fn rejects_values_the_consumer_would_refuse() {
        let metrics = Metrics::new();
        assert_eq!(
            metrics.record(0, &key("a"), f64::NAN),
            Err(Rejected::Invalid)
        );
        assert_eq!(metrics.record(0, &key("a"), 2e15), Err(Rejected::Dropped));
        assert!(metrics.record(0, &key("a"), 9e14).is_ok());
        assert_eq!(metrics.record(0, &key("a"), 9e14), Err(Rejected::Dropped));
    }

    #[test]
    fn series_bound_drops_and_a_flush_frees_the_series() {
        let metrics = Metrics::new();
        let mut dropped = 0;
        for index in 0..2500 {
            if metrics
                .record(0, &key(&format!("name{index}")), 10.0)
                .is_err()
            {
                dropped += 1;
            }
        }
        assert_eq!(dropped, 500);
        assert_eq!(metrics.series(), MAX_SERIES);
        assert_eq!(metrics.take().len(), MAX_SERIES);
        assert_eq!(metrics.series(), 0);
        assert!(metrics.take().is_empty());
        assert!(metrics.record(0, &key("name2400"), 1.0).is_ok());
        assert_eq!(metrics.series(), 1);
    }

    #[test]
    fn two_buckets_per_flush_then_drop() {
        let metrics = Metrics::new();
        assert!(metrics.record(1_000, &key("a"), 1.0).is_ok());
        assert!(metrics.record(11_000, &key("a"), 1.0).is_ok());
        assert_eq!(
            metrics.record(21_000, &key("a"), 1.0),
            Err(Rejected::Dropped)
        );
        let rows = metrics.take();
        assert_eq!(
            rows.iter().map(|row| row.at).collect::<Vec<_>>(),
            [0, 10_000]
        );
        assert!(metrics.record(21_000, &key("a"), 1.0).is_ok());
    }

    #[test]
    fn shards_merge_at_flush() {
        let metrics = std::sync::Arc::new(Metrics::new());
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let metrics = metrics.clone();
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        metrics.record(0, &key("shared"), 1.0).ok();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().ok();
        }
        let rows = metrics.take();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 1600);
    }

    #[test]
    fn a_flush_holds_a_shard_lock_only_for_a_swap() {
        let metrics = Metrics::new();
        let names: Vec<String> = (0..MAX_SERIES)
            .map(|index| format!("{index:0>90}"))
            .collect();
        let mut holds = Vec::new();
        for _ in 0..40 {
            // Every series lands in this thread's shard: the worst case for one lock.
            for name in &names {
                metrics.record(0, &key(name), 1.0).ok();
            }
            metrics.longest_hold_ns.store(0, Ordering::Relaxed);
            assert_eq!(metrics.take().len(), MAX_SERIES);
            holds.push(metrics.longest_hold_ns.load(Ordering::Relaxed));
        }
        holds.sort_unstable();
        let median = holds[holds.len() / 2];
        eprintln!(
            "longest shard-lock hold per flush of {MAX_SERIES} series: median {median} ns, worst {} ns",
            holds[holds.len() - 1]
        );
        // A swap is a few pointer moves; copying and merging 2000 series takes hundreds of µs.
        assert!(median < 20_000, "median hold {median} ns");
    }

    #[test]
    fn telemetry_logs_keep_only_allow_listed_metadata() {
        let data = serde_json::json!({"function":"test","code":"E_TEST","message":"private chat",
            "token":"secret","error":"password secret","attempt":2,"step":"a\nb"});
        let row = LogRow::from_data(5, "error", &data, label::channel("a"), None);
        assert_eq!(
            Value::Object(row.fields),
            serde_json::json!({"function":"test","step":"a_b","code":"E_TEST","attempt":2})
        );
        assert_eq!(row.name, "test");
        let row = LogRow::from_data(5, "warn", &serde_json::json!("text"), Channel::EMPTY, None);
        assert_eq!(row.name, "application");
        let row = LogRow::from_data(
            5,
            "warn",
            &serde_json::json!({"function":"","operation":"op"}),
            Channel::EMPTY,
            None,
        );
        assert_eq!(row.name, "op");
    }

    #[test]
    fn batches_follow_the_reference_sizes() {
        let taken = Taken {
            metrics: (0..250)
                .map(|index| MetricRow {
                    at: 0,
                    kind: "k".into(),
                    name: format!("n{index}"),
                    channel: String::new(),
                    outcome: "ok".into(),
                    count: 1,
                    sum: 1.0,
                    max: 1.0,
                    histogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                })
                .collect(),
            spans: Vec::new(),
            logs: (0..60)
                .map(|_| LogRow::from_data(0, "warn", &Value::Null, Channel::EMPTY, None))
                .collect(),
        };
        let (payloads, oversized) = taken.encode("cron", "i", 1, || "id".into());
        assert_eq!((payloads.len(), oversized), (3, 0));
        let first: Value = serde_json::from_str(&payloads[0].json).unwrap_or_default();
        assert_eq!(first["metrics"].as_array().map(Vec::len), Some(100));
        assert_eq!(first["logs"].as_array().map(Vec::len), Some(25));
        let last: Value = serde_json::from_str(&payloads[2].json).unwrap_or_default();
        assert_eq!(last["metrics"].as_array().map(Vec::len), Some(50));
        assert_eq!(last["logs"].as_array().map(Vec::len), Some(10));
        assert_eq!(payloads.iter().map(|p| p.items).sum::<u64>(), 310);
    }
}
