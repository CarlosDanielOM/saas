//! Bounded, best-effort native cron telemetry. No child text, environment values,
//! arguments, database statements, or raw transport errors leave this module.
//!
//! The core owns newline framing (including the 1,024-byte discard boundary)
//! and must abort **and await** each sampler before releasing its child. Frame
//! validation also applies the line limit defensively. Export failures discard
//! the swapped buffer; they never propagate into worker lifecycle decisions.

use super::registry::{ProtocolKind, WorkerSpec};
use redis::{AsyncConnectionConfig, Client, ConnectionAddr};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, btree_map::Entry},
    env,
    net::{Ipv4Addr, Ipv6Addr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, sync::watch, task::JoinHandle};

pub const TELEMETRY_INBOX: &str = "observability:v1:inbox";
pub const LATENCY_BOUNDS: [f64; 16] = [
    1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 30000.0,
    60000.0, 300000.0, 1e12,
];
const MAX_NUMBER: f64 = 1e15;
const MAX_COUNT: u64 = 100_000_000;
const MAX_METRICS: usize = 2000;
const MAX_LOGS: usize = 100;
const FRAME_LIMIT: usize = 1024;
const PROC_LIMIT: usize = 16384;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const FLUSH_TIMEOUT: Duration = Duration::from_millis(1800);
const SAMPLE_INTERVAL: Duration = Duration::from_secs(10);
const ENQUEUE: &str = "local n=redis.call('LPUSH',KEYS[1],ARGV[1]); local dropped=math.max(0,n-100); redis.call('LTRIM',KEYS[1],0,99); if dropped>0 then redis.call('INCRBY',KEYS[2],dropped) end; redis.call('EXPIRE',KEYS[1],3600); return dropped";
const RAID_PHASES: &[&str] = &[
    "claimMs",
    "followQueriesMs",
    "followWriteMs",
    "period7Ms",
    "period30Ms",
    "reciprocityMs",
    "publishMs",
    "releaseMs",
];
const BASELINE_PHASES: &[&str] = &[
    "queueMs",
    "claimMs",
    "ledgerMs",
    "streamsMs",
    "attacksMs",
    "publishMs",
    "rescheduleMs",
];
const BATCH_FIELDS: &[&str] = &["event", "events", "durationMs", "success"];
const NATIVE_BATCH_FIELDS: &[&str] = &["event", "events", "durationMs", "success", "phases"];
const NATIVE_HEALTH_FIELDS: &[&str] = &[
    "event",
    "success",
    "dueChannels",
    "oldestDueAgeMs",
    "lastSuccessAgeMs",
];
const STREAM_HEALTH_FIELDS: &[&str] = &[
    "event",
    "success",
    "hasPending",
    "oldestPendingAgeMs",
    "checkpointSeq",
    "activeBatchEvents",
    "lastSuccessAgeMs",
];

#[derive(Clone)]
pub struct Telemetry(Arc<Inner>);

struct Inner {
    endpoint: Option<(String, u16)>,
    instance: String,
    state: Mutex<State>,
    flushing: tokio::sync::Mutex<()>,
    dropped: AtomicU64,
}

#[derive(Default)]
struct State {
    metrics: BTreeMap<MetricKey, Metric>,
    logs: Vec<Value>,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct MetricKey {
    at: u64,
    kind: String,
    name: String,
    outcome: String,
}

#[derive(Serialize)]
struct Metric {
    at: u64,
    kind: String,
    name: String,
    channel: &'static str,
    outcome: String,
    count: u64,
    sum: f64,
    max: f64,
    histogram: [u64; 16],
}

impl Telemetry {
    /// Reads only the existing host/port and exact `OBSERVABILITY_DISABLED=true`
    /// switch. No dotenv loading, connection, or background task occurs here.
    pub fn from_env() -> Self {
        let endpoint = endpoint_from_values(
            env::var("OBSERVABILITY_DISABLED").ok().as_deref(),
            env::var("DRAGONFLY_HOST").ok().as_deref(),
            env::var("DRAGONFLY_PORT").ok().as_deref(),
        );
        Self::new(endpoint)
    }

    fn new(endpoint: Option<(String, u16)>) -> Self {
        Self(Arc::new(Inner {
            endpoint,
            instance: uuid::Uuid::new_v4().to_string(),
            state: Mutex::new(State::default()),
            flushing: tokio::sync::Mutex::new(()),
            dropped: AtomicU64::new(0),
        }))
    }

    pub fn is_enabled(&self) -> bool {
        self.0.endpoint.is_some()
    }

    pub fn dropped(&self) -> u64 {
        self.0.dropped.load(Ordering::Relaxed)
    }

    fn lose(&self, count: u64) {
        let _ = self
            .0
            .dropped
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |old| {
                Some(old.saturating_add(count))
            });
    }

    /// Callers must supply fixed, source-owned labels, never child text. Channel
    /// and trace identity are deliberately absent for native supervisor metrics.
    pub fn observe(&self, kind: &str, name: &str, value: f64, outcome: &str) {
        self.observe_at(kind, name, value, outcome, now_ms());
    }

    fn observe_at(&self, kind: &str, name: &str, value: f64, outcome: &str, at: u64) {
        if !self.is_enabled() || !value.is_finite() {
            return;
        }
        // The TS observer accepts any finite input; the consumer additionally
        // caps sums/maxima. Drop an unrepresentable observation rather than
        // poison its whole batch (notably an enormous raid duration).
        if value > MAX_NUMBER {
            self.lose(1);
            return;
        }
        let key = MetricKey {
            at: at / 10_000 * 10_000,
            kind: clean(kind, 30),
            name: clean(name, 100),
            outcome: clean(outcome, 30),
        };
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let at_capacity = state.metrics.len() >= MAX_METRICS;
        let metric = match state.metrics.entry(key) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                if at_capacity {
                    self.lose(1);
                    return;
                }
                let key = entry.key();
                let metric = Metric {
                    at: key.at,
                    kind: key.kind.clone(),
                    name: key.name.clone(),
                    channel: "",
                    outcome: key.outcome.clone(),
                    count: 0,
                    sum: 0.0,
                    max: 0.0,
                    histogram: [0; 16],
                };
                entry.insert(metric)
            }
        };
        let sum = metric.sum + value.max(0.0);
        if metric.count >= MAX_COUNT || !sum.is_finite() || sum > MAX_NUMBER {
            self.lose(1);
            return;
        }
        metric.count += 1;
        metric.sum = sum;
        metric.max = metric.max.max(value);
        let bucket = LATENCY_BOUNDS
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(15);
        metric.histogram[bucket] += 1;
    }

    /// Mirrors the TS supervisor's fixed error metric and metadata-only log.
    /// `prefix` and `step` must be source-owned; OS codes are strictly bounded.
    pub fn record_worker_error(&self, prefix: &str, step: &str, code: &str) {
        self.observe("worker", &format!("{prefix}.errors"), 1.0, "error");
        if !self.is_enabled() {
            return;
        }
        let code = if !code.is_empty()
            && code.len() <= 40
            && code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            code
        } else {
            "NATIVE_WORKER_PROCESS"
        };
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.logs.len() >= MAX_LOGS {
            self.lose(1);
            return;
        }
        state.logs.push(json!({
            "at": now_ms(), "level": "error", "name": clean(prefix, 100),
            "channel": "", "traceId": null,
            "fields": { "function": clean(prefix, 80), "step": clean(step, 80), "code": code },
        }));
    }

    /// A line includes the registered protocol prefix, without its newline.
    /// Returns only a fully validated object, even when export is disabled, for
    /// the core's explicitly opted-in fixture/debug metadata events.
    pub fn accept_frame(&self, spec: &WorkerSpec, line: &[u8]) -> Option<Value> {
        if line.len() > FRAME_LIMIT {
            return None;
        }
        let body = line.strip_prefix(spec.protocol.as_bytes())?;
        let frame: Value = serde_json::from_slice(body).ok()?;
        let row = frame.as_object()?;
        let event = row.get("event")?.as_str()?;
        let phases = match &spec.protocol_kind {
            ProtocolKind::Raid => Some(RAID_PHASES),
            ProtocolKind::Baseline => Some(BASELINE_PHASES),
            _ => None,
        };
        if event == "health" {
            match &spec.protocol_kind {
                ProtocolKind::Stream => self.stream_health(spec.metric_prefix, row)?,
                ProtocolKind::Raid | ProtocolKind::Baseline => {
                    self.native_health(spec.metric_prefix, row)?
                }
                ProtocolKind::BatchOnly => return None,
            }
        } else if event == "batch" {
            if !only_fields(
                row,
                if phases.is_some() {
                    NATIVE_BATCH_FIELDS
                } else {
                    BATCH_FIELDS
                },
            ) {
                return None;
            }
            if let Some(allowed) = phases
                && let Some(value) = row.get("phases")
            {
                let phase_row = value.as_object()?;
                if !only_fields(phase_row, allowed) || !phase_row.values().all(metadata_number) {
                    return None;
                }
            }
            let events = row.get("events")?.as_f64()?;
            let duration = row.get("durationMs")?.as_f64()?;
            let success = row.get("success")?.as_bool()?;
            if !events.is_finite()
                || events.fract() != 0.0
                || events < 0.0
                || events > spec.max_events as f64
                || !duration.is_finite()
                || duration < 0.0
                || duration > spec.max_duration_ms
                || (!success && events != 0.0)
            {
                return None;
            }
            let outcome = if !success {
                "error"
            } else if events > 0.0 {
                "ok"
            } else {
                "idle"
            };
            self.observe(
                "worker",
                &format!("{}.{}", spec.metric_prefix, spec.batch_metric),
                events,
                outcome,
            );
            self.observe(
                "queue_run",
                &format!("{}.project_batch", spec.metric_prefix),
                duration,
                outcome,
            );
            if let (Some(allowed), Some(phase_row)) =
                (phases, row.get("phases").and_then(Value::as_object))
            {
                for phase in allowed {
                    if let Some(duration) = phase_row.get(*phase).and_then(Value::as_f64) {
                        self.observe(
                            "queue_run",
                            &format!("{}.phase.{phase}", spec.metric_prefix),
                            duration,
                            outcome,
                        );
                    }
                }
            }
        } else {
            return None;
        }
        Some(frame)
    }

    fn stream_health(&self, prefix: &str, row: &Map<String, Value>) -> Option<()> {
        if !only_fields(row, STREAM_HEALTH_FIELDS) {
            return None;
        }
        let success = row.get("success")?.as_bool()?;
        for field in [
            "oldestPendingAgeMs",
            "checkpointSeq",
            "activeBatchEvents",
            "lastSuccessAgeMs",
        ] {
            if row.get(field).is_some_and(|value| !metadata_number(value)) {
                return None;
            }
        }
        for field in ["checkpointSeq", "activeBatchEvents"] {
            if row.get(field).is_some_and(|value| !safe_integer(value)) {
                return None;
            }
        }
        if success {
            let pending = row.get("hasPending")?.as_bool()?;
            if !pending && row.contains_key("oldestPendingAgeMs") {
                return None;
            }
        } else if [
            "hasPending",
            "oldestPendingAgeMs",
            "checkpointSeq",
            "activeBatchEvents",
        ]
        .iter()
        .any(|field| row.contains_key(*field))
        {
            return None;
        }
        self.health_status(prefix, success);
        if let Some(pending) = row.get("hasPending").and_then(Value::as_bool) {
            self.observe(
                "worker",
                &format!("{prefix}.pending_work"),
                if pending { 1.0 } else { 0.0 },
                "ok",
            );
        }
        self.health_gauges(
            prefix,
            row,
            &[
                ("oldestPendingAgeMs", "oldest_pending_age_ms"),
                ("checkpointSeq", "checkpoint_seq"),
                ("activeBatchEvents", "active_batch_events"),
                ("lastSuccessAgeMs", "last_success_age_ms"),
            ],
        );
        Some(())
    }

    fn native_health(&self, prefix: &str, row: &Map<String, Value>) -> Option<()> {
        if !only_fields(row, NATIVE_HEALTH_FIELDS) {
            return None;
        }
        let success = row.get("success")?.as_bool()?;
        for field in ["dueChannels", "oldestDueAgeMs", "lastSuccessAgeMs"] {
            if nonnull(row, field).is_some_and(|value| !metadata_number(value)) {
                return None;
            }
        }
        if nonnull(row, "dueChannels").is_some_and(|value| !safe_integer(value)) {
            return None;
        }
        if !success
            && (nonnull(row, "dueChannels").is_some() || nonnull(row, "oldestDueAgeMs").is_some())
        {
            return None;
        }
        if row.get("dueChannels").and_then(Value::as_f64) == Some(0.0)
            && nonnull(row, "oldestDueAgeMs").is_some()
        {
            return None;
        }
        self.health_status(prefix, success);
        self.health_gauges(
            prefix,
            row,
            &[
                ("dueChannels", "backlog_channels"),
                ("oldestDueAgeMs", "oldest_due_age_ms"),
                ("lastSuccessAgeMs", "last_success_age_ms"),
            ],
        );
        Some(())
    }

    fn health_status(&self, prefix: &str, success: bool) {
        self.observe(
            "worker",
            &format!("{prefix}.health_query"),
            if success { 1.0 } else { 0.0 },
            "ok",
        );
        if !success {
            self.observe("worker", &format!("{prefix}.health_errors"), 1.0, "error");
        }
    }

    fn health_gauges(&self, prefix: &str, row: &Map<String, Value>, fields: &[(&str, &str)]) {
        for (field, metric) in fields {
            if let Some(value) = row
                .get(*field)
                .filter(|value| metadata_number(value))
                .and_then(Value::as_f64)
            {
                self.observe("worker", &format!("{prefix}.{metric}"), value, "ok");
            }
        }
    }

    /// Best effort, at most 1.8 seconds total, including the separately bounded
    /// one-second connect. A concurrent flush returns immediately. Never retries
    /// or requeues failed data and never exposes a Redis/environment error.
    pub async fn flush(&self) {
        if !self.is_enabled() {
            return;
        }
        let Ok(_guard) = self.0.flushing.try_lock() else {
            return;
        };
        let state = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *state)
        };
        let rows: Vec<Metric> = state.metrics.into_values().collect();
        let lost = rows.iter().fold(state.logs.len() as u64, |sum, row| {
            sum.saturating_add(row.count)
        });
        let result = tokio::time::timeout(FLUSH_TIMEOUT, self.send_rows(&rows, &state.logs)).await;
        if !matches!(result, Ok(Ok(()))) {
            self.lose(lost);
        }
    }

    async fn send_rows(&self, rows: &[Metric], logs: &[Value]) -> Result<(), ()> {
        let (host, port) = self.0.endpoint.as_ref().ok_or(())?;
        let client = Client::open(ConnectionAddr::Tcp(host.clone(), *port)).map_err(|_| ())?;
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(CONNECT_TIMEOUT))
            .set_response_timeout(Some(FLUSH_TIMEOUT));
        // A fresh dedicated socket each flush has no reconnect/offline queue.
        // Dropping it on timeout also drops the driver's owned task/socket.
        let mut connection = tokio::time::timeout(
            CONNECT_TIMEOUT,
            client.get_multiplexed_async_connection_with_config(&config),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        for (rows, logs) in batch_slices(rows, logs) {
            let payload = batch_payload(&self.0.instance, rows, logs)?;
            if payload.len() > 256000 {
                self.lose(1);
                continue;
            }
            let _: i64 = redis::cmd("EVAL")
                .arg(ENQUEUE)
                .arg(2)
                .arg(TELEMETRY_INBOX)
                .arg("observability:v1:overflow")
                .arg(payload)
                .query_async(&mut connection)
                .await
                .map_err(|_| ())?;
        }
        Ok(())
    }
}

fn batch_slices<'a>(
    rows: &'a [Metric],
    logs: &'a [Value],
) -> impl Iterator<Item = (&'a [Metric], &'a [Value])> {
    let batches = 1.max(rows.len().div_ceil(100)).max(logs.len().div_ceil(25));
    (0..batches).map(move |index| {
        (
            &rows[(index * 100).min(rows.len())..((index + 1) * 100).min(rows.len())],
            &logs[(index * 25).min(logs.len())..((index + 1) * 25).min(logs.len())],
        )
    })
}

fn batch_payload(instance: &str, rows: &[Metric], logs: &[Value]) -> Result<String, ()> {
    serde_json::to_string(&json!({
        "version": 1, "id": uuid::Uuid::new_v4().to_string(), "service": "cron",
        "instance": instance, "at": now_ms(), "metrics": rows, "spans": [], "logs": logs,
    }))
    .map_err(|_| ())
}

/// Ten-second exporter cadence, then one bounded final flush on true or closed
/// shutdown receiver. The core should stop/await samplers before signalling it.
pub async fn run_exporter(telemetry: Telemetry, mut shutdown: watch::Receiver<bool>) {
    if !telemetry.is_enabled() {
        return;
    }
    loop {
        if *shutdown.borrow_and_update() {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(SAMPLE_INTERVAL) => {
                telemetry.observe("runtime", "cron_index_rust.telemetry_dropped", telemetry.dropped().min(1_000_000_000_000_000) as f64, "ok");
                telemetry.flush().await;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow_and_update() { break; }
            }
        }
    }
    telemetry.flush().await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(1_000_000_000_000_000) as u64
}

fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .take(limit)
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || matches!(character, '_' | '.' | ':' | '/' | ' ' | '-')
            {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn only_fields(row: &Map<String, Value>, allowed: &[&str]) -> bool {
    row.keys().all(|key| allowed.contains(&key.as_str()))
}

fn metadata_number(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && (0.0..=MAX_NUMBER).contains(&number))
}

fn safe_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
    })
}

fn nonnull<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    row.get(key).filter(|value| !value.is_null())
}

fn endpoint_from_values(
    disabled: Option<&str>,
    host: Option<&str>,
    port: Option<&str>,
) -> Option<(String, u16)> {
    if disabled == Some("true") {
        return None;
    }
    let host = host?.trim();
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let host = if host.starts_with('[') {
        let inner = host.strip_prefix('[')?.strip_suffix(']')?;
        inner.parse::<Ipv6Addr>().ok()?;
        inner
    } else if host.contains(':') {
        host.parse::<Ipv6Addr>().ok()?;
        host
    } else if host.parse::<Ipv4Addr>().is_ok() {
        host
    } else {
        if !host.is_ascii()
            || host
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
            || !host
                .strip_suffix('.')
                .unwrap_or(host)
                .split('.')
                .all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
        {
            return None;
        }
        host
    };
    let port = port.filter(|value| !value.is_empty()).unwrap_or("6379");
    if !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    (port > 0).then(|| (host.to_owned(), port))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeSnapshot {
    pub start_ticks: u64,
    pub cpu_ticks: u128,
    pub rss_bytes: u64,
}

#[derive(Default)]
pub struct NativeCpuTracker {
    identity: Option<u64>,
    previous: Option<(u128, Duration)>,
    replaced: bool,
}

impl NativeCpuTracker {
    pub fn missing(&mut self) {
        self.previous = None;
    }

    /// `at` must come from one monotonic origin. First/recovered/missing-clock
    /// samples contain RSS only. A changed start tick permanently closes the
    /// identity fence; a decreasing counter establishes a fresh CPU baseline.
    pub fn sample(
        &mut self,
        snapshot: NativeSnapshot,
        at: Duration,
        ticks_per_second: Option<u64>,
    ) -> Option<(u64, Option<f64>)> {
        if self.replaced {
            return None;
        }
        let identity = *self.identity.get_or_insert(snapshot.start_ticks);
        if identity != snapshot.start_ticks {
            self.replaced = true;
            self.previous = None;
            return None;
        }
        let previous = self.previous.replace((snapshot.cpu_ticks, at));
        let cores = previous.and_then(|(ticks, previous_at)| {
            let frequency = ticks_per_second.filter(|frequency| *frequency > 0)?;
            if at <= previous_at || snapshot.cpu_ticks < ticks {
                return None;
            }
            let cores = (snapshot.cpu_ticks - ticks) as f64
                / frequency as f64
                / (at - previous_at).as_secs_f64();
            (cores.is_finite() && cores >= 0.0).then_some(cores)
        });
        Some((snapshot.rss_bytes, cores))
    }
}

fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// `/proc/stat` comm may itself contain spaces and closing parentheses.
pub fn parse_native_stat(stat: &str, pid: u32) -> Option<(u64, u128)> {
    if stat.len() > PROC_LIMIT {
        return None;
    }
    let opening = stat.find(" (")?;
    let closing = stat.rfind(") ")?;
    if opening < 1 || closing < opening || stat[..opening] != pid.to_string() {
        return None;
    }
    let fields: Vec<&str> = stat[closing + 2..].split_whitespace().collect();
    if fields.len() < 20
        || fields[0].len() != 1
        || !fields[0].as_bytes()[0].is_ascii_alphabetic()
        || matches!(fields[0], "Z" | "X" | "x")
    {
        return None;
    }
    Some((
        decimal(fields[19])?,
        u128::from(decimal(fields[11])?) + u128::from(decimal(fields[12])?),
    ))
}

pub fn parse_native_rss(status: &str, pid: u32) -> Option<u64> {
    if status.len() > PROC_LIMIT {
        return None;
    }
    let recorded_pid = status.lines().find_map(|line| line.strip_prefix("Pid:"))?;
    if recorded_pid.trim() != pid.to_string() {
        return None;
    }
    let rss = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?;
    let mut fields = rss.split_whitespace();
    let kb = decimal(fields.next()?)?;
    if fields.next()? != "kB" || fields.next().is_some() {
        return None;
    }
    kb.checked_mul(1024)
        .filter(|bytes| *bytes <= 9_007_199_254_740_991)
}

async fn bounded_proc_read(path: &str) -> Option<String> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut bytes = Vec::with_capacity(PROC_LIMIT + 1);
    file.take((PROC_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > PROC_LIMIT {
        return None;
    }
    String::from_utf8(bytes).ok()
}

async fn read_native_snapshot(pid: u32) -> Option<NativeSnapshot> {
    let path = format!("/proc/{pid}/stat");
    let before = parse_native_stat(&bounded_proc_read(&path).await?, pid)?;
    let rss_bytes = parse_native_rss(
        &bounded_proc_read(&format!("/proc/{pid}/status")).await?,
        pid,
    )?;
    let after = parse_native_stat(&bounded_proc_read(&path).await?, pid)?;
    (before.0 == after.0).then_some(NativeSnapshot {
        start_ticks: after.0,
        cpu_ticks: after.1,
        rss_bytes,
    })
}

fn clock_ticks() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: sysconf(_SC_CLK_TCK) has no pointer parameters or side effects.
        // A nonpositive/indeterminate result disables CPU, never guesses Hz.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        (ticks > 0).then_some(ticks as u64)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Samples immediately, then sleeps ten seconds after each completed read.
/// Reads never overlap. Core cancellation is abort+await, so a suspended read
/// cannot emit a late sample after the core has released the child identity.
pub fn spawn_sampler(pid: u32, prefix: &'static str, telemetry: Telemetry) -> JoinHandle<()> {
    tokio::spawn(async move {
        if !cfg!(target_os = "linux") || pid == 0 || !telemetry.is_enabled() {
            return;
        }
        let ticks = clock_ticks();
        let origin = Instant::now();
        let mut tracker = NativeCpuTracker::default();
        loop {
            if let Some(snapshot) = read_native_snapshot(pid).await {
                let Some((rss, cores)) = tracker.sample(snapshot, origin.elapsed(), ticks) else {
                    return;
                };
                telemetry.observe("runtime", &format!("{prefix}.rss_bytes"), rss as f64, "ok");
                if let Some(cores) = cores {
                    telemetry.observe("runtime", &format!("{prefix}.cpu_cores"), cores, "ok");
                }
            } else {
                tracker.missing();
            }
            tokio::time::sleep(SAMPLE_INTERVAL).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Port zero can never select a live Redis service. No environment is read
    // by any of these tests, and no production PID is sampled.
    fn telemetry() -> Telemetry {
        Telemetry::new(Some(("127.0.0.1".to_owned(), 0)))
    }

    fn spec(name: &str) -> WorkerSpec {
        let (
            name,
            protocol,
            metric_prefix,
            batch_metric,
            max_events,
            max_duration_ms,
            protocol_kind,
        ) = match name {
            "stream-activity" => (
                "stream-activity",
                "stream_activity:",
                "stream_activity_rust",
                "batch_events",
                1000,
                300000.0,
                ProtocolKind::Stream,
            ),
            "raid-analytics" => (
                "raid-analytics",
                "raid_analytics:",
                "raid_analytics_rust",
                "batch_channels",
                1,
                f64::MAX,
                ProtocolKind::Raid,
            ),
            "follow-defense-baseline" => (
                "follow-defense-baseline",
                "follow_defense_baseline:",
                "follow_defense_baseline_rust",
                "batch_channels",
                1,
                300000.0,
                ProtocolKind::Baseline,
            ),
            "roulette-completion" => (
                "roulette-completion",
                "roulette_completion:",
                "roulette_completion_rust",
                "batch_channels",
                100,
                300000.0,
                ProtocolKind::BatchOnly,
            ),
            "ai-usage-receipts" => (
                "ai-usage-receipts",
                "ai_usage_receipts:",
                "ai_usage_receipts_rust",
                "batch_receipts",
                1000,
                300000.0,
                ProtocolKind::BatchOnly,
            ),
            "raid-sessions" => (
                "raid-sessions",
                "raid_sessions:",
                "raid_sessions_rust",
                "batch_items",
                401,
                300000.0,
                ProtocolKind::BatchOnly,
            ),
            "dashboard-activity" => (
                "dashboard-activity",
                "dashboard_activity:",
                "dashboard_activity_rust",
                "batch_events",
                502,
                300000.0,
                ProtocolKind::BatchOnly,
            ),
            _ => panic!("unregistered test worker"),
        };
        WorkerSpec {
            name,
            binary: "/unused",
            args: &[],
            enabled_env: None,
            extra_env: &[],
            metric_prefix,
            protocol,
            batch_metric,
            max_events,
            max_duration_ms,
            protocol_kind,
        }
    }

    #[test]
    fn source_generated_parser_corpus_matches_without_private_partial_exports() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/native_telemetry_parity.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let telemetry = telemetry();
            let spec = spec(case["worker"].as_str().unwrap());
            let accepted = telemetry.accept_frame(&spec, case["line"].as_str().unwrap().as_bytes());
            assert_eq!(
                accepted.is_some(),
                case["accepted"].as_bool().unwrap(),
                "{}: {}",
                spec.name,
                case["label"]
            );
            let expected = case["metrics"].as_array().unwrap();
            // The ingestion ceiling is stricter than TS's generic observer:
            // enormous allowed raid durations are dropped, never serialized.
            let expected: Vec<_> = expected
                .iter()
                .filter(|row| row[2].as_f64().unwrap() <= MAX_NUMBER)
                .collect();
            let state = telemetry.0.state.lock().unwrap();
            assert_eq!(
                state.metrics.len(),
                expected.len(),
                "{}: {}",
                spec.name,
                case["label"]
            );
            assert!(state.logs.is_empty());
            for expected in expected {
                let metric = state
                    .metrics
                    .values()
                    .find(|metric| {
                        metric.kind == expected[0].as_str().unwrap()
                            && metric.name == expected[1].as_str().unwrap()
                            && metric.outcome == expected[3].as_str().unwrap()
                    })
                    .unwrap_or_else(|| {
                        panic!("missing metric for {}: {}", spec.name, case["label"])
                    });
                assert_eq!(metric.sum, expected[2].as_f64().unwrap());
                assert_eq!(metric.max, metric.sum);
                assert_eq!(metric.count, 1);
                assert_eq!(metric.channel, "");
                assert_eq!(metric.histogram.iter().sum::<u64>(), 1);
            }
            let serialized =
                serde_json::to_string(&state.metrics.values().collect::<Vec<_>>()).unwrap();
            assert!(!serialized.contains("private-child-secret"));
        }
    }

    #[test]
    fn same_bucket_health_probes_keep_unknown_gauges_absent_and_errors_separate() {
        let telemetry = telemetry();
        let spec = spec("raid-analytics");
        for line in [
            "raid_analytics:{\"event\":\"health\",\"success\":true,\"dueChannels\":6,\"oldestDueAgeMs\":90}",
            "raid_analytics:{\"event\":\"health\",\"success\":false,\"lastSuccessAgeMs\":100}",
        ] {
            assert!(telemetry.accept_frame(&spec, line.as_bytes()).is_some());
        }
        let state = telemetry.0.state.lock().unwrap();
        let queries: Vec<_> = state
            .metrics
            .values()
            .filter(|metric| metric.name.ends_with(".health_query"))
            .collect();
        assert_eq!(queries.iter().map(|metric| metric.count).sum::<u64>(), 2);
        assert_eq!(queries.iter().map(|metric| metric.sum).sum::<f64>(), 1.0);
        let backlog = state
            .metrics
            .values()
            .find(|metric| metric.name.ends_with(".backlog_channels"))
            .unwrap();
        assert_eq!((backlog.count, backlog.sum), (1, 6.0));
        assert!(state.metrics.values().all(|metric| metric.kind == "worker"));
        let error = state
            .metrics
            .values()
            .find(|metric| metric.name.ends_with(".health_errors"))
            .unwrap();
        assert_eq!(error.outcome, "error");
        assert!(state.logs.is_empty());
    }

    #[test]
    fn aggregation_obeys_ten_second_buckets_and_non_cumulative_histogram_bounds() {
        let telemetry = telemetry();
        for (index, bound) in LATENCY_BOUNDS.iter().enumerate() {
            telemetry.observe_at("worker", "native.boundary", *bound, "ok", 10001);
            let state = telemetry.0.state.lock().unwrap();
            let metric = state.metrics.values().next().unwrap();
            assert_eq!(metric.histogram[index], 1);
            assert_eq!(metric.count, index as u64 + 1);
        }
        telemetry.observe_at("worker", "native.boundary", -1.0, "ok", 19999);
        telemetry.observe_at("worker", "native.boundary", 2.0, "ok", 20000);
        let state = telemetry.0.state.lock().unwrap();
        assert_eq!(state.metrics.len(), 2);
        let first = state.metrics.values().next().unwrap();
        assert_eq!(first.at, 10000);
        assert_eq!(first.count, 17);
        assert_eq!(first.histogram[0], 2);
        assert_eq!(first.histogram.iter().sum::<u64>(), first.count);
        assert_eq!(first.max, 1e12);
        assert_eq!(first.sum, LATENCY_BOUNDS.iter().sum::<f64>());
    }

    #[test]
    fn metric_cardinality_and_numeric_overflow_are_loss_without_invalid_rows() {
        let telemetry = telemetry();
        for index in 0..2500 {
            telemetry.observe_at("worker", &format!("native.metric{index}"), 1.0, "ok", 10000);
        }
        assert_eq!(telemetry.0.state.lock().unwrap().metrics.len(), 2000);
        assert_eq!(telemetry.dropped(), 500);
        telemetry.observe_at("worker", "native.metric0", 2.0, "ok", 10000);
        assert_eq!(
            telemetry.dropped(),
            500,
            "existing keys still aggregate at capacity"
        );

        let numeric = self::telemetry();
        numeric.observe_at("worker", "native.numeric", MAX_NUMBER, "ok", 10000);
        numeric.observe_at("worker", "native.numeric", 1.0, "ok", 10000);
        numeric.observe_at("worker", "native.huge", f64::MAX, "ok", 10000);
        numeric.observe_at("worker", "native.nan", f64::NAN, "ok", 10000);
        numeric.observe_at("worker", "native.inf", f64::INFINITY, "ok", 10000);
        let mut state = numeric.0.state.lock().unwrap();
        assert_eq!(state.metrics.len(), 1);
        let metric = state.metrics.values_mut().next().unwrap();
        assert_eq!(
            (metric.count, metric.sum, metric.max),
            (1, MAX_NUMBER, MAX_NUMBER)
        );
        // Reach the count guard without producing a hundred million samples.
        metric.count = MAX_COUNT;
        metric.histogram[15] = MAX_COUNT;
        drop(state);
        numeric.observe_at("worker", "native.numeric", 0.0, "ok", 10000);
        assert_eq!(numeric.dropped(), 3);
        let state = numeric.0.state.lock().unwrap();
        let metric = state.metrics.values().next().unwrap();
        assert_eq!(metric.count, MAX_COUNT);
        assert_eq!(metric.histogram.iter().sum::<u64>(), MAX_COUNT);
    }

    #[test]
    fn logs_are_bounded_and_export_only_fixed_metadata_with_safe_codes() {
        let telemetry = telemetry();
        telemetry.record_worker_error(
            "raid_analytics_rust",
            "spawn",
            "private error: password=secret",
        );
        for _ in 0..110 {
            telemetry.record_worker_error("raid_analytics_rust", "process", "EIO");
        }
        let state = telemetry.0.state.lock().unwrap();
        assert_eq!(state.logs.len(), 100);
        assert_eq!(telemetry.dropped(), 11);
        assert_eq!(
            state.logs[0]["fields"],
            json!({
                "function": "raid_analytics_rust", "step": "spawn", "code": "NATIVE_WORKER_PROCESS",
            })
        );
        assert_eq!(state.logs[0]["channel"], "");
        assert_eq!(state.logs[0]["traceId"], Value::Null);
        let payload = serde_json::to_string(&state.logs).unwrap();
        assert!(!payload.contains("password"));
        assert!(!payload.contains("secret"));
        assert_eq!(state.logs[0]["fields"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn disable_switch_and_structured_endpoints_do_not_read_or_reinterpret_secrets() {
        assert_eq!(
            endpoint_from_values(Some("true"), Some("dragonfly"), None),
            None
        );
        assert_eq!(
            endpoint_from_values(Some("TRUE"), Some("dragonfly"), None),
            Some(("dragonfly".into(), 6379))
        );
        assert_eq!(endpoint_from_values(None, None, None), None);
        assert_eq!(endpoint_from_values(None, Some(""), None), None);
        assert_eq!(
            endpoint_from_values(None, Some("[::1]"), Some("6380")),
            Some(("::1".into(), 6380))
        );
        for host in [
            "redis://user:password@host/3",
            "user:password@host",
            "host:6379",
            "host/path",
            "host?token=secret",
            "999.1.1.1",
        ] {
            assert_eq!(endpoint_from_values(None, Some(host), None), None);
        }
        for port in ["0", "65536", "+6379", "secret", " 6379"] {
            assert_eq!(
                endpoint_from_values(None, Some("dragonfly"), Some(port)),
                None
            );
        }
        let telemetry = Telemetry::new(None);
        assert!(telemetry.accept_frame(&spec("stream-activity"), b"stream_activity:{\"event\":\"batch\",\"events\":1,\"durationMs\":2,\"success\":true}").is_some());
        telemetry.observe("worker", "test", 1.0, "ok");
        telemetry.record_worker_error("native", "spawn", "EIO");
        assert!(telemetry.0.state.lock().unwrap().metrics.is_empty());
        assert!(telemetry.0.state.lock().unwrap().logs.is_empty());
        assert_eq!(telemetry.dropped(), 0);
    }

    #[test]
    fn batch_envelopes_use_existing_limits_and_no_span_or_channel_identity() {
        let telemetry = telemetry();
        for index in 0..237 {
            telemetry.observe("worker", &format!("native.metric{index}"), 1.0, "ok");
        }
        for _ in 0..63 {
            telemetry.record_worker_error("native", "spawn", "EIO");
        }
        let state = std::mem::take(&mut *telemetry.0.state.lock().unwrap());
        let rows: Vec<_> = state.metrics.into_values().collect();
        let expected_metrics = rows.len();
        let mut metrics = 0;
        let mut logs = 0;
        for (rows, log_rows) in batch_slices(&rows, &state.logs) {
            let payload = batch_payload(&telemetry.0.instance, rows, log_rows).unwrap();
            assert!(payload.len() <= 256000);
            let payload: Value = serde_json::from_str(&payload).unwrap();
            let metric_rows = payload["metrics"].as_array().unwrap();
            let log_rows = payload["logs"].as_array().unwrap();
            metrics += metric_rows.len();
            logs += log_rows.len();
            assert!(metric_rows.len() <= 100);
            assert!(log_rows.len() <= 25);
            assert_eq!(payload["version"], 1);
            assert_eq!(payload["service"], "cron");
            assert!(uuid::Uuid::parse_str(payload["id"].as_str().unwrap()).is_ok());
            assert!(uuid::Uuid::parse_str(payload["instance"].as_str().unwrap()).is_ok());
            assert_eq!(payload["spans"], json!([]));
            assert!(log_rows.iter().all(|log| log["channel"] == ""));
        }
        assert_eq!((metrics, logs), (expected_metrics, 63));
        assert!(expected_metrics >= 238);
        assert_eq!(
            batch_slices(&[], &[]).count(),
            1,
            "empty flush preserves the heartbeat envelope"
        );
    }

    fn stat(comm: &str, user: &str, system: &str, start: &str, state: &str) -> String {
        let mut fields = ["0"; 20];
        fields[0] = state;
        fields[11] = user;
        fields[12] = system;
        fields[19] = start;
        format!("42 ({comm}) {}", fields.join(" "))
    }

    #[test]
    fn proc_parsers_preserve_comm_identity_and_reject_zombies_and_unbounded_input() {
        assert_eq!(
            parse_native_stat(&stat("rust (nested) ) name", "100", "50", "1234", "S"), 42),
            Some((1234, 150))
        );
        for state in ["Z", "X", "x", "SS", "1"] {
            assert_eq!(
                parse_native_stat(&stat("native", "1", "2", "3", state), 42),
                None
            );
        }
        for number in ["bad", "-1", "+1", "1.5", "18446744073709551616"] {
            assert_eq!(
                parse_native_stat(&stat("native", number, "2", "3", "R"), 42),
                None
            );
        }
        assert_eq!(
            parse_native_stat(&stat("native", "1", "2", "3", "S"), 99),
            None
        );
        assert_eq!(parse_native_stat("42 (broken) S 0", 42), None);
        let oversized = stat(&"x".repeat(PROC_LIMIT), "1", "2", "3", "S");
        assert_eq!(parse_native_stat(&oversized, 42), None);
        assert_eq!(
            parse_native_rss("Name:\trust\nPid:\t42\nVmRSS:\t12 kB\n", 42),
            Some(12288)
        );
        assert_eq!(parse_native_rss("Pid: 43\nVmRSS: 12 kB\n", 42), None);
        assert_eq!(parse_native_rss("Pid: 42\n", 42), None);
        assert_eq!(parse_native_rss("Pid: 42\nVmRSS: 12 MB\n", 42), None);
        assert_eq!(
            parse_native_rss("Pid: 42\nVmRSS: 9007199254740991 kB\n", 42),
            None
        );
        assert_eq!(
            parse_native_rss(
                &format!("Pid: 42\nVmRSS: 12 kB\n{}", "x".repeat(PROC_LIMIT)),
                42
            ),
            None
        );
    }

    fn snapshot(cpu_ticks: u128, start_ticks: u64) -> NativeSnapshot {
        NativeSnapshot {
            start_ticks,
            cpu_ticks,
            rss_bytes: 4096,
        }
    }

    #[test]
    fn cpu_baselines_handle_gaps_counter_reset_unknown_clock_and_pid_reuse() {
        let mut tracker = NativeCpuTracker::default();
        let at = Duration::from_secs;
        assert_eq!(
            tracker.sample(snapshot(100, 1234), at(0), Some(100)),
            Some((4096, None))
        );
        assert_eq!(
            tracker.sample(snapshot(300, 1234), at(1), Some(100)),
            Some((4096, Some(2.0)))
        );
        assert_eq!(
            tracker.sample(snapshot(10, 1234), at(2), Some(100)),
            Some((4096, None))
        );
        assert_eq!(
            tracker.sample(snapshot(60, 1234), at(3), Some(100)),
            Some((4096, Some(0.5)))
        );
        tracker.missing();
        assert_eq!(
            tracker.sample(snapshot(160, 1234), at(5), Some(100)),
            Some((4096, None))
        );
        assert_eq!(
            tracker.sample(snapshot(200, 1234), at(6), None),
            Some((4096, None))
        );
        assert_eq!(tracker.sample(snapshot(250, 9999), at(7), Some(100)), None);
        assert_eq!(tracker.sample(snapshot(300, 1234), at(8), Some(100)), None);
    }

    #[test]
    fn equal_or_backwards_sample_times_never_emit_cpu_and_zero_clock_is_unknown() {
        let mut tracker = NativeCpuTracker::default();
        for (ticks, seconds, frequency) in [
            (1, 10, Some(100)),
            (2, 10, Some(100)),
            (3, 9, Some(100)),
            (4, 11, Some(0)),
        ] {
            assert_eq!(
                tracker.sample(
                    snapshot(ticks, 1234),
                    Duration::from_secs(seconds),
                    frequency
                ),
                Some((4096, None))
            );
        }
    }

    #[tokio::test]
    async fn failed_flush_loses_swapped_rows_and_leaves_worker_control_unaffected() {
        let telemetry = telemetry();
        telemetry.observe("worker", "native.batch", 2.0, "ok");
        telemetry.observe("worker", "native.batch", 3.0, "ok");
        telemetry.record_worker_error("native", "spawn", "ENOENT");
        telemetry.flush().await;
        assert_eq!(
            telemetry.dropped(),
            4,
            "three observations plus one log are lost"
        );
        let state = telemetry.0.state.lock().unwrap();
        assert!(state.metrics.is_empty());
        assert!(state.logs.is_empty());
        drop(state);
        telemetry.observe("worker", "native.batch", 1.0, "ok");
        assert_eq!(telemetry.0.state.lock().unwrap().metrics.len(), 1);
    }

    #[tokio::test]
    async fn concurrent_flush_does_not_wait_for_a_connection_or_swap_twice() {
        let telemetry = telemetry();
        telemetry.observe("worker", "native.batch", 2.0, "ok");
        let guard = telemetry.0.flushing.lock().await;
        telemetry.flush().await;
        assert_eq!(telemetry.0.state.lock().unwrap().metrics.len(), 1);
        assert_eq!(telemetry.dropped(), 0);
        drop(guard);
    }

    #[tokio::test]
    async fn stalled_redis_handshake_is_bounded_and_drops_data_without_diagnostics() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let telemetry = Telemetry::new(Some(("127.0.0.1".into(), port)));
        telemetry.observe("worker", "native.batch", 1.0, "ok");
        let finished = tokio::time::timeout(Duration::from_secs(3), telemetry.flush()).await;
        peer.abort();
        let _ = peer.await;
        assert!(finished.is_ok());
        assert_eq!(telemetry.dropped(), 1);
        assert!(telemetry.0.state.lock().unwrap().logs.is_empty());
    }

    #[tokio::test]
    async fn already_signalled_exporter_finishes_with_one_bounded_final_flush() {
        let telemetry = telemetry();
        telemetry.observe("worker", "native.batch", 1.0, "ok");
        let (_sender, receiver) = watch::channel(true);
        run_exporter(telemetry.clone(), receiver).await;
        assert_eq!(telemetry.dropped(), 1);
        assert!(telemetry.0.state.lock().unwrap().metrics.is_empty());
    }
}
