//! Bounded metadata-only telemetry with the existing Redis inbox protocol.
//! Callers must supply source-owned labels; free-form messages are never exported.
//! Tokio task-local context is scoped to a future; explicitly scope spawned tasks.
use redis::{AsyncConnectionConfig, Client};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};

pub const TELEMETRY_INBOX: &str = "observability:v1:inbox";
pub const LATENCY_BOUNDS: [f64; 16] = [
    1., 5., 10., 25., 50., 100., 250., 500., 1000., 2500., 5000., 10000., 30000., 60000., 300000.,
    1e12,
];
const ENQUEUE: &str = "local n=redis.call('LPUSH',KEYS[1],ARGV[1]); local dropped=math.max(0,n-100); redis.call('LTRIM',KEYS[1],0,99); if dropped>0 then redis.call('INCRBY',KEYS[2],dropped) end; redis.call('EXPIRE',KEYS[1],3600); return dropped";
const FIELDS: [&str; 9] = [
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn clean(s: &str, max: usize) -> String {
    s.encode_utf16()
        .take(max)
        .map(|c| {
            if c <= 127 && ((c as u8).is_ascii_alphanumeric() || b"_.:/ -".contains(&(c as u8))) {
                c as u8 as char
            } else {
                '_'
            }
        })
        .collect()
}
fn channel(s: &str) -> String {
    if !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        s.into()
    } else {
        String::new()
    }
}
fn hex_id(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn random_hex<const N: usize>() -> String {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).expect("telemetry entropy unavailable");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(N * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}
fn trace_id() -> String {
    random_hex::<16>()
}
fn span_id() -> String {
    random_hex::<8>()
}
fn sample() -> bool {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("telemetry entropy unavailable");
    u64::from_be_bytes(bytes) < (u64::MAX / 100)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub sampled: bool,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}
tokio::task_local! { static CONTEXT: Arc<Mutex<TraceContext>>; }
pub fn telemetry_context() -> Option<TraceContext> {
    CONTEXT
        .try_with(|c| c.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .ok()
}
pub async fn with_telemetry_context<T>(
    context: TraceContext,
    future: impl Future<Output = T>,
) -> T {
    CONTEXT.scope(Arc::new(Mutex::new(context)), future).await
}
pub async fn restore_context<T>(
    saved: Option<TraceContext>,
    channel_id: &str,
    future: impl Future<Output = T>,
) -> T {
    let context = saved
        .filter(|c| hex_id(&c.trace_id, 32) && hex_id(&c.span_id, 16))
        .map(|c| TraceContext {
            channel: channel(channel_id),
            outcome: None,
            ..c
        })
        .unwrap_or_else(|| TraceContext {
            trace_id: trace_id(),
            span_id: span_id(),
            sampled: sample(),
            channel: channel(channel_id),
            outcome: None,
        });
    with_telemetry_context(context, future).await
}
pub fn bind_channel(value: &str) {
    let _ =
        CONTEXT.try_with(|c| c.lock().unwrap_or_else(|e| e.into_inner()).channel = channel(value));
}
pub fn trace_outcome(value: &str) {
    let _ = CONTEXT
        .try_with(|c| c.lock().unwrap_or_else(|e| e.into_inner()).outcome = Some(clean(value, 30)));
}

#[derive(Debug, Clone, Serialize)]
pub struct Metric {
    pub at: i64,
    pub kind: String,
    pub name: String,
    pub channel: String,
    pub outcome: String,
    pub count: u64,
    pub sum: f64,
    pub max: f64,
    pub histogram: [u64; 16],
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanRow {
    #[serde(flatten)]
    pub context: TraceContext,
    pub parent_id: Option<String>,
    pub at: i64,
    pub duration: f64,
    pub kind: String,
    pub name: String,
    pub outcome: String,
    pub partial: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub at: i64,
    pub level: String,
    pub name: String,
    pub channel: String,
    pub trace_id: Option<String>,
    pub fields: Map<String, Value>,
}
type MetricKey = (i64, String, String, String, String);
#[derive(Default)]
struct State {
    metrics: BTreeMap<MetricKey, Metric>,
    spans: Vec<SpanRow>,
    logs: Vec<LogRow>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub metrics: Vec<Metric>,
    pub spans: Vec<SpanRow>,
    pub logs: Vec<LogRow>,
    pub dropped: u64,
}
struct Inner {
    client: Client,
    service: String,
    instance: String,
    enabled: bool,
    active: AtomicBool,
    state: Mutex<State>,
    dropped: AtomicU64,
    flushing: AsyncMutex<()>,
}
#[derive(Clone)]
pub struct Telemetry(Arc<Inner>);
impl Telemetry {
    pub fn new(client: Client, service: impl Into<String>, enabled: bool) -> Self {
        Self(Arc::new(Inner {
            client,
            service: service.into(),
            instance: uuid::Uuid::new_v4().to_string(),
            enabled,
            active: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            dropped: AtomicU64::new(0),
            flushing: AsyncMutex::new(()),
        }))
    }
    pub fn dropped(&self) -> u64 {
        self.0.dropped.load(Ordering::Relaxed)
    }
    fn lose(&self, n: u64) {
        let _ = self
            .0
            .dropped
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                Some(v.saturating_add(n))
            });
    }
    pub fn start(&self) -> Option<TelemetryTask> {
        if !self.0.enabled || self.0.active.swap(true, Ordering::AcqRel) {
            return None;
        }
        let telemetry = self.clone();
        let stop = Arc::new(Notify::new());
        let stopping = stop.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(10),
                Duration::from_secs(10),
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { _ = stopping.notified() => break, _ = interval.tick() => telemetry.flush().await }
            }
        });
        Some(TelemetryTask {
            telemetry: self.clone(),
            stop,
            task: Some(task),
        })
    }
    pub fn observe(
        &self,
        kind: &str,
        name: &str,
        value: f64,
        outcome: &str,
        channel_id: Option<&str>,
        at: i64,
    ) {
        if !self.0.active.load(Ordering::Acquire) || !value.is_finite() {
            return;
        }
        let ch = channel_id
            .map(str::to_owned)
            .or_else(|| telemetry_context().map(|c| c.channel))
            .unwrap_or_default();
        let key = (
            at.div_euclid(10000) * 10000,
            clean(kind, 30),
            clean(name, 100),
            channel(&ch),
            clean(outcome, 30),
        );
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.metrics.len() >= 2000 && !state.metrics.contains_key(&key) {
            self.lose(1);
            return;
        }
        let row = state.metrics.entry(key.clone()).or_insert_with(|| Metric {
            at: key.0,
            kind: key.1,
            name: key.2,
            channel: key.3,
            outcome: key.4,
            count: 0,
            sum: 0.,
            max: 0.,
            histogram: [0; 16],
        });
        let sum = row.sum + value.max(0.);
        if row.count == u64::MAX {
            self.lose(1);
            return;
        }
        row.count += 1;
        row.sum = sum;
        row.max = row.max.max(value);
        let bucket = LATENCY_BOUNDS
            .iter()
            .position(|b| value <= *b)
            .unwrap_or(15);
        row.histogram[bucket] += 1;
    }
    pub fn observe_lifecycle(&self, name: &str, channel: Option<&str>, now: i64) {
        self.observe("lifecycle", name, 0., "ok", channel, now);
    }
    pub fn pending_metrics(&self) -> Vec<Value> {
        self.snapshot()
            .metrics
            .into_iter()
            .map(|m| serde_json::to_value(m).expect("finite metric"))
            .collect()
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            metrics: state.metrics.values().cloned().collect(),
            spans: state.spans.clone(),
            logs: state.logs.clone(),
            dropped: self.dropped(),
        }
    }
    pub fn begin_span(&self, kind: &str, name: &str, channel_id: Option<&str>) -> Span {
        let parent = telemetry_context();
        let context = TraceContext {
            trace_id: parent
                .as_ref()
                .map(|p| p.trace_id.clone())
                .unwrap_or_else(trace_id),
            span_id: span_id(),
            sampled: parent.as_ref().map(|p| p.sampled).unwrap_or_else(sample),
            channel: channel(
                channel_id
                    .or_else(|| parent.as_ref().map(|p| p.channel.as_str()))
                    .unwrap_or(""),
            ),
            outcome: None,
        };
        Span {
            telemetry: self.clone(),
            context: Arc::new(Mutex::new(context)),
            parent_id: parent.map(|p| p.span_id),
            kind: kind.into(),
            name: name.into(),
            started: Instant::now(),
            at: now_ms(),
            ended: AtomicBool::new(false),
        }
    }
    /// Executes a future in a child span. `Err` records an error and `Ok` records
    /// success. Callers whose successful value itself signals failure should
    /// explicitly use `begin_span` and choose the outcome before ending it.
    pub async fn traced_result<T, E>(
        &self,
        kind: &str,
        name: &str,
        channel_id: Option<&str>,
        future: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        let span = self.begin_span(kind, name, channel_id);
        span.run(async {
            let result = future.await;
            span.end(if result.is_err() { "error" } else { "ok" }, None);
            result
        })
        .await
    }
    /// Traces a JSON-returning future using the TypeScript `value?.error`
    /// convention. Rust panics are not converted to TypeScript exceptions.
    pub async fn traced_value(
        &self,
        kind: &str,
        name: &str,
        channel_id: Option<&str>,
        future: impl Future<Output = Value>,
    ) -> Value {
        let span = self.begin_span(kind, name, channel_id);
        span.run(async {
            let value = future.await;
            let failed = value
                .get("error")
                .is_some_and(crate::utils::logger::js_truthy);
            span.end(if failed { "error" } else { "ok" }, None);
            value
        })
        .await
    }
    pub fn record_log(&self, level: &str, data: &Value, channel_id: Option<&str>, at: i64) {
        if !self.0.active.load(Ordering::Acquire) || !["warn", "error", "fatal"].contains(&level) {
            return;
        }
        let mut fields = Map::new();
        for key in FIELDS {
            match data.get(key) {
                Some(Value::String(s)) => {
                    fields.insert(key.into(), Value::String(clean(s, 80)));
                }
                Some(v @ (Value::Bool(_) | Value::Number(_))) => {
                    fields.insert(key.into(), v.clone());
                }
                _ => {}
            }
        }
        let name = data
            .get("function")
            .filter(|v| crate::utils::logger::js_truthy(v))
            .or_else(|| {
                data.get("operation")
                    .filter(|v| crate::utils::logger::js_truthy(v))
            })
            .map(crate::utils::logger::metadata_name)
            .unwrap_or_else(|| "application".into());
        let context = telemetry_context();
        let ch = channel_id
            .or_else(|| context.as_ref().map(|c| c.channel.as_str()))
            .unwrap_or("");
        self.push_log(LogRow {
            at,
            level: level.into(),
            name,
            channel: channel(ch),
            trace_id: context.map(|c| c.trace_id),
            fields,
        });
    }
    fn push_log(&self, row: LogRow) {
        if !self.0.active.load(Ordering::Acquire) {
            return;
        }
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.logs.len() >= 100 {
            self.lose(1);
        } else {
            state.logs.push(row);
        }
    }
    pub async fn flush(&self) {
        let Ok(_guard) = self.0.flushing.try_lock() else {
            return;
        };
        if !self.0.active.load(Ordering::Acquire) {
            return;
        }
        let state = std::mem::take(&mut *self.0.state.lock().unwrap_or_else(|e| e.into_inner()));
        let rows: Vec<_> = state.metrics.into_values().collect();
        let lost = rows
            .iter()
            .fold(0_u64, |n, m| n.saturating_add(m.count))
            .saturating_add(state.spans.len() as u64)
            .saturating_add(state.logs.len() as u64);
        // Cancellation after the buffer swap is loss too, including shutdown aborts.
        let mut loss_guard = FlushLoss {
            telemetry: self,
            count: lost,
            armed: true,
        };
        let batches = 1
            .max(rows.len().div_ceil(100))
            .max(state.spans.len().div_ceil(50))
            .max(state.logs.len().div_ceil(25));
        let sent = tokio::time::timeout(Duration::from_millis(1800), async {
            let config = AsyncConnectionConfig::new().set_connection_timeout(Some(Duration::from_secs(1))).set_response_timeout(Some(Duration::from_millis(1800)));
            let mut conn = self.0.client.get_multiplexed_async_connection_with_config(&config).await?;
            for i in 0..batches { let m = &rows[(i * 100).min(rows.len())..((i + 1) * 100).min(rows.len())]; let s = &state.spans[(i * 50).min(state.spans.len())..((i + 1) * 50).min(state.spans.len())]; let l = &state.logs[(i * 25).min(state.logs.len())..((i + 1) * 25).min(state.logs.len())];
                let payload = json!({"version":1,"id":uuid::Uuid::new_v4().to_string(),"service":self.0.service,"instance":self.0.instance,"at":now_ms(),"metrics":m,"spans":s,"logs":l}).to_string();
                if payload.len() > 256000 { self.lose(1); continue; }
                let _: i64 = redis::cmd("EVAL").arg(ENQUEUE).arg(2).arg(TELEMETRY_INBOX).arg("observability:v1:overflow").arg(payload).query_async(&mut conn).await?;
            } Ok::<(), redis::RedisError>(())
        }).await;
        if matches!(sent, Ok(Ok(()))) {
            loss_guard.armed = false;
        }
    }
}
struct FlushLoss<'a> {
    telemetry: &'a Telemetry,
    count: u64,
    armed: bool,
}
impl Drop for FlushLoss<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.telemetry.lose(self.count);
        }
    }
}
pub struct Span {
    telemetry: Telemetry,
    context: Arc<Mutex<TraceContext>>,
    parent_id: Option<String>,
    kind: String,
    name: String,
    started: Instant,
    at: i64,
    ended: AtomicBool,
}
impl Span {
    pub fn context(&self) -> TraceContext {
        self.context
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> T {
        CONTEXT.scope(self.context.clone(), future).await
    }
    pub fn end(&self, outcome: &str, final_name: Option<&str>) {
        if self.ended.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut context = self.context();
        let outcome = context
            .outcome
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| outcome.to_owned());
        let duration = self.started.elapsed().as_secs_f64() * 1000.;
        let name = final_name.filter(|s| !s.is_empty()).unwrap_or(&self.name);
        self.telemetry.observe(
            &self.kind,
            name,
            duration,
            &outcome,
            Some(&context.channel),
            self.at,
        );
        if !self.telemetry.0.active.load(Ordering::Acquire)
            || !(context.sampled || duration >= 1000. || outcome == "error")
        {
            return;
        }
        let mut state = self
            .telemetry
            .0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.spans.len() >= 300 {
            self.telemetry.lose(1);
            return;
        }
        context.outcome = None;
        state.spans.push(SpanRow {
            partial: !context.sampled,
            context,
            parent_id: self.parent_id.clone(),
            at: self.at,
            duration,
            kind: clean(&self.kind, 30),
            name: clean(name, 100),
            outcome: clean(&outcome, 30),
        });
    }
}
pub struct TelemetryTask {
    telemetry: Telemetry,
    stop: Arc<Notify>,
    task: Option<JoinHandle<()>>,
}
impl TelemetryTask {
    pub async fn shutdown(&mut self) {
        self.stop.notify_waiters();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        self.telemetry.flush().await;
        self.telemetry.0.active.store(false, Ordering::Release);
    }
}
impl Drop for TelemetryTask {
    fn drop(&mut self) {
        self.stop.notify_waiters();
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.telemetry.0.active.store(false, Ordering::Release);
    }
}
#[cfg(feature = "logger")]
impl crate::utils::logger::MetadataSink for Telemetry {
    fn record(
        &self,
        record: crate::utils::logger::MetadataRecord,
    ) -> crate::utils::logger::SinkFuture<'_> {
        Box::pin(async move {
            if !record.level.high_priority() {
                return Ok(());
            }
            let context = telemetry_context();
            let mut fields = Map::new();
            for key in FIELDS {
                match record.fields.get(key) {
                    Some(Value::String(s)) => {
                        fields.insert(key.into(), Value::String(clean(s, 80)));
                    }
                    Some(v @ (Value::Bool(_) | Value::Number(_))) => {
                        fields.insert(key.into(), v.clone());
                    }
                    _ => {}
                }
            }
            let trace = record.trace_id.filter(|v| hex_id(v, 32)).or_else(|| {
                context
                    .as_ref()
                    .map(|c| c.trace_id.clone())
                    .filter(|v| hex_id(v, 32))
            });
            self.push_log(LogRow {
                at: record.at,
                level: record.level.as_str().into(),
                name: clean(&record.name, 100),
                channel: if record.channel_explicit || !record.channel.is_empty() {
                    channel(&record.channel)
                } else {
                    context
                        .as_ref()
                        .map(|c| channel(&c.channel))
                        .unwrap_or_default()
                },
                trace_id: trace,
                fields,
            });
            Ok(())
        })
    }
}
