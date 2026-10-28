//! The journal's concrete observability dependency: task-local trace context,
//! bounded lifecycle metrics and the existing inbox protocol. This is a narrow
//! adapter, not a port of unrelated HTTP/process telemetry instrumentation.

use redis::{AsyncConnectionConfig, Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};

const ENQUEUE: &str = "local n=redis.call('LPUSH',KEYS[1],ARGV[1]); local dropped=math.max(0,n-100); redis.call('LTRIM',KEYS[1],0,99); if dropped>0 then redis.call('INCRBY',KEYS[2],dropped) end; redis.call('EXPIRE',KEYS[1],3600); return dropped";
const BOUNDS: [f64; 16] = [
    1., 5., 10., 25., 50., 100., 250., 500., 1000., 2500., 5000., 10000., 30000., 60000., 300000.,
    1e12,
];
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
tokio::task_local! {static CONTEXT:TraceContext;}
pub fn telemetry_context() -> Option<TraceContext> {
    CONTEXT.try_with(Clone::clone).ok()
}
pub async fn with_telemetry_context<T>(
    context: TraceContext,
    future: impl std::future::Future<Output = T>,
) -> T {
    CONTEXT.scope(context, future).await
}
#[derive(Debug, Clone, Serialize)]
struct Metric {
    at: i64,
    kind: String,
    name: String,
    channel: String,
    outcome: String,
    count: u64,
    sum: f64,
    max: f64,
    histogram: [u64; 16],
}
type MetricKey = (i64, String, String, String, String);

struct Inner {
    client: Client,
    service: String,
    instance: String,
    enabled: bool,
    active: AtomicBool,
    rows: Mutex<BTreeMap<MetricKey, Metric>>,
    dropped: AtomicU64,
    flushing: AsyncMutex<()>,
}
#[derive(Clone)]
pub struct JournalTelemetry(Arc<Inner>);
impl JournalTelemetry {
    pub fn new(client: Client, service: impl Into<String>, enabled: bool) -> Self {
        Self(Arc::new(Inner {
            client,
            service: service.into(),
            instance: uuid::Uuid::new_v4().to_string(),
            enabled,
            active: AtomicBool::new(false),
            rows: Mutex::new(BTreeMap::new()),
            dropped: AtomicU64::new(0),
            flushing: AsyncMutex::new(()),
        }))
    }
    pub fn dropped(&self) -> u64 {
        self.0.dropped.load(Ordering::Relaxed)
    }
    pub fn start(&self) -> Option<JournalTelemetryTask> {
        if !self.0.enabled || self.0.active.swap(true, Ordering::AcqRel) {
            return None;
        };
        let telemetry = self.clone();
        let stop = Arc::new(Notify::new());
        let stopping = stop.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(10),
                Duration::from_secs(10),
            );
            loop {
                tokio::select! {_=stopping.notified()=>break,_=interval.tick()=>telemetry.flush().await}
            }
        });
        Some(JournalTelemetryTask {
            telemetry: self.clone(),
            stop,
            task: Some(task),
        })
    }
    pub fn observe_lifecycle(&self, name: &str, channel: Option<&str>, now: i64) {
        if !self.0.active.load(Ordering::Acquire) {
            return;
        };
        let channel = channel
            .map(str::to_owned)
            .or_else(|| telemetry_context().map(|context| context.channel))
            .unwrap_or_default();
        let channel = if !channel.is_empty()
            && channel.len() <= 80
            && channel
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            channel
        } else {
            String::new()
        };
        let key = (
            now.div_euclid(10000) * 10000,
            "lifecycle".to_owned(),
            name.to_owned(),
            channel.clone(),
            "ok".to_owned(),
        );
        let mut rows = self.0.rows.lock().unwrap_or_else(|e| e.into_inner());
        if rows.len() >= 2000 && !rows.contains_key(&key) {
            self.0.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let row = rows.entry(key.clone()).or_insert_with(|| Metric {
            at: key.0,
            kind: key.1,
            name: key.2,
            channel,
            outcome: key.4,
            count: 0,
            sum: 0.,
            max: 0.,
            histogram: BOUNDS.map(|_| 0),
        });
        row.count += 1;
        row.histogram[0] += 1;
    }
    pub async fn flush(&self) {
        let Ok(_guard) = self.0.flushing.try_lock() else {
            return;
        };
        if !self.0.active.load(Ordering::Acquire) {
            return;
        };
        let rows: Vec<_> =
            std::mem::take(&mut *self.0.rows.lock().unwrap_or_else(|e| e.into_inner()))
                .into_values()
                .collect();
        let lost: u64 = rows.iter().map(|row| row.count).sum();
        let sent=tokio::time::timeout(Duration::from_millis(1800),async{
            let config=AsyncConnectionConfig::new().set_connection_timeout(Some(Duration::from_secs(1))).set_response_timeout(Some(Duration::from_millis(1800)));
            let mut connection=self.0.client.get_multiplexed_async_connection_with_config(&config).await?;
            for chunk in rows.chunks(100){let payload=json!({"version":1,"id":uuid::Uuid::new_v4().to_string(),"service":self.0.service,"instance":self.0.instance,"at":mongodb::bson::DateTime::now().timestamp_millis(),"metrics":chunk,"spans":[],"logs":[]}).to_string();
                if payload.len()>256000{self.0.dropped.fetch_add(1,Ordering::Relaxed);continue};
                let _:i64=redis::cmd("EVAL").arg(ENQUEUE).arg(2).arg("observability:v1:inbox").arg("observability:v1:overflow").arg(payload).query_async(&mut connection).await?;
            }Ok::<(),redis::RedisError>(())
        }).await;
        if !matches!(sent, Ok(Ok(()))) {
            self.0.dropped.fetch_add(lost, Ordering::Relaxed);
        }
    }
    pub fn pending_metrics(&self) -> Vec<Value> {
        self.0
            .rows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|row| serde_json::to_value(row).expect("finite lifecycle row"))
            .collect()
    }
}
pub struct JournalTelemetryTask {
    telemetry: JournalTelemetry,
    stop: Arc<Notify>,
    task: Option<JoinHandle<()>>,
}
impl JournalTelemetryTask {
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
impl Drop for JournalTelemetryTask {
    fn drop(&mut self) {
        self.stop.notify_waiters();
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.telemetry.0.active.store(false, Ordering::Release);
    }
}
