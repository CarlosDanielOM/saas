//! Explicitly owned bot metrics. Construction does not connect or spawn.
use std::{collections::BTreeMap, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicI64, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}, io::Read};
use redis::{aio::ConnectionManager, RedisResult};
use serde::Serialize;
use serde_json::json;
use tokio::{sync::oneshot, task::JoinHandle};

pub const SEMANTIC_TTL: u64 = 86_400;
#[derive(Clone, Debug)]
pub struct Config { pub prefix: String, pub history_limit: usize, pub interval: Duration, pub ttl_seconds: u64 }
impl Default for Config { fn default() -> Self { Self { prefix: "metrics:bot".into(), history_limit: 5760, interval: Duration::from_secs(30), ttl_seconds: 172800 } } }
impl Config {
    /// Environment access is explicit; invalid numbers fall back to defaults.
    pub fn from_env() -> Self {
        let mut c = Self::default();
        if let Ok(v) = std::env::var("BOT_METRICS_PREFIX") { if !v.is_empty() { c.prefix = v; } }
        if let Ok(v) = std::env::var("BOT_METRICS_HISTORY_LIMIT") { if let Ok(n) = v.parse::<usize>() { c.history_limit = n.max(120); } }
        if let Ok(v) = std::env::var("BOT_METRICS_INTERVAL_MS") { if let Ok(n) = v.parse::<u64>() { c.interval = Duration::from_millis(n.max(5000)); } }
        if let Ok(v) = std::env::var("BOT_METRICS_TTL_SECONDS") { if let Ok(n) = v.parse::<u64>() { c.ttl_seconds = n.max(3600); } }
        c
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Counters { pub eventsub_notifications: i64, pub eventsub_notification_bytes: f64, pub eventsub_handled: i64, pub eventsub_handle_errors: i64, pub message_handler_started: i64, pub message_handler_completed: i64, pub message_handler_errors: i64, pub embedding_enqueued: i64, pub embedding_batches_success: i64, pub embedding_batches_failed: i64, pub embedding_messages_processed: f64, pub redis_ops_estimated: f64, pub openrouter_embedding_requests: i64, pub openrouter_embedding_errors: i64, pub openrouter_embedding_input_chars: f64 }
#[derive(Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
struct Totals { max_inflight_eventsub_handlers: i64, max_inflight_message_handlers: i64, max_embedding_queue_size: f64, eventsub_by_type: BTreeMap<String,i64> }
#[derive(Default)]
struct State { window: Counters, types: Vec<(String,i64)>, totals: Totals, eventsub: i64, message: i64, queue: f64, processing: bool }
#[derive(Clone)]
pub struct BotRuntimeMetrics { conn: ConnectionManager, config: Config, state: Arc<Mutex<State>>, started_ms: Arc<AtomicI64>, delay: Arc<Mutex<DelayHistogram>>, active: Arc<AtomicBool> }
fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64 }
// Gregorian UTC date conversion, no timezone or platform I/O.
fn date(ms: i64) -> (String,String) {
    let days = ms.div_euclid(86_400_000); let rem = ms.rem_euclid(86_400_000);
    let z = days + 719468; let era = z.div_euclid(146097); let doe = z-era*146097;
    let yoe = (doe-doe/1460+doe/36524-doe/146096)/365; let mut y = yoe+era*400;
    let doy = doe-(365*yoe+yoe/4-yoe/100); let mp = (5*doy+2)/153;
    let d = doy-(153*mp+2)/5+1; let m = mp+if mp<10 {3} else {-9}; y += i64::from(m<=2);
    let h=rem/3_600_000; let min=rem/60_000%60; let sec=rem/1000%60; let milli=rem%1000;
    (format!("{y:04}{m:02}{d:02}{h:02}{min:02}"),format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{sec:02}.{milli:03}Z"))
}

/// Fixed 1 ms buckets, 1000 ms overflow; bounded regardless of runtime length.
/// This measures timer scheduling lateness, not Node's libuv event-loop histogram.
#[derive(Clone)]
pub struct DelayHistogram { bins: [u64; 1001], count:u64, sum_ms:f64, sum_sq:f64, min_ms:f64, max_ms:f64 }
impl Default for DelayHistogram { fn default()->Self { Self {bins:[0;1001],count:0,sum_ms:0.0,sum_sq:0.0,min_ms:f64::INFINITY,max_ms:0.0} } }
impl DelayHistogram {
    pub fn record(&mut self, delay:Duration) { let ms=delay.as_secs_f64()*1000.0; let bin=(ms.floor() as usize).min(1000); self.bins[bin]=self.bins[bin].saturating_add(1); self.count=self.count.saturating_add(1); self.sum_ms+=ms; self.sum_sq+=ms*ms; self.min_ms=self.min_ms.min(ms); self.max_ms=self.max_ms.max(ms); }
    pub fn summary(&self)->serde_json::Value { if self.count==0 {return serde_json::Value::Null;} let mean=self.sum_ms/self.count as f64; let percentile=|p:u64| {let target=(self.count.saturating_mul(p).saturating_add(99))/100; let mut seen=0_u64; for (i,n) in self.bins.iter().enumerate() {seen=seen.saturating_add(*n); if seen>=target {return i as u64;} } 1000}; json!({"samples":self.count,"minMs":self.min_ms,"maxMs":self.max_ms,"meanMs":mean,"stddevMs":(self.sum_sq/self.count as f64-mean*mean).max(0.0).sqrt(),"p50Ms":percentile(50),"p95Ms":percentile(95),"p99Ms":percentile(99),"bucketWidthMs":1,"overflowMs":1000}) }
}
#[derive(Default)]
struct ProcessMeasurement { rss_bytes:Option<u64>, uptime_seconds:Option<f64> }
/// Bounded procfs reads follow cron_supervisor::telemetry's 16 KiB limit and PID checks.
fn bounded_proc(path:&str)->Option<String> { let file=std::fs::File::open(path).ok()?; let mut b=Vec::new(); file.take(16385).read_to_end(&mut b).ok()?; if b.len()>16384 {return None;} String::from_utf8(b).ok() }
fn process_from_proc(status:&str, stat:&str, uptime:&str, pid:u32, ticks:u64)->ProcessMeasurement {
    let mut result=ProcessMeasurement::default();
    if status.len()<=16384 && status.lines().find_map(|l|l.strip_prefix("Pid:")).map(str::trim)==Some(pid.to_string().as_str()) {
        result.rss_bytes=status.lines().find_map(|l|l.strip_prefix("VmRSS:")).and_then(|l| { let mut f=l.split_whitespace(); let n=f.next()?.parse::<u64>().ok()?; if f.next()? != "kB" || f.next().is_some() {return None;} n.checked_mul(1024).filter(|v|*v<=9_007_199_254_740_991) });
    }
    if ticks>0 && stat.len()<=16384 { if let (Some(open),Some(close))=(stat.find(" ("),stat.rfind(") ")) { if close>open && stat[..open]==pid.to_string() { let fields:Vec<_>=stat[close+2..].split_whitespace().collect(); if fields.first().is_some_and(|s|s.len()==1 && s.as_bytes()[0].is_ascii_alphabetic() && !matches!(*s,"Z"|"X"|"x")) { if let (Some(start),Some(up))=(fields.get(19).and_then(|s|s.parse::<u64>().ok()),uptime.split_whitespace().next().and_then(|s|s.parse::<f64>().ok())) { let age=up-start as f64/ticks as f64; if age.is_finite() && age>=0.0 {result.uptime_seconds=Some(age);} } } } } }
    result
}
fn read_process()->ProcessMeasurement {
    #[cfg(target_os="linux")]
    { let ticks=unsafe { libc::sysconf(libc::_SC_CLK_TCK) }; let pid=std::process::id(); return process_from_proc(&bounded_proc("/proc/self/status").unwrap_or_default(),&bounded_proc("/proc/self/stat").unwrap_or_default(),&bounded_proc("/proc/uptime").unwrap_or_default(),pid,if ticks>0 {ticks as u64} else {0}); }
    #[cfg(not(target_os="linux"))] { ProcessMeasurement::default() }
}

fn normalized(s: &str, default: &str) -> String { if s.is_empty() { default.into() } else { s.into() } }
fn js_nonnegative(n: f64) -> f64 { if n.is_nan() { 0.0 } else { n.max(0.0) } }
fn nonnegative(n: f64) -> i64 { if n.is_nan() { 0 } else { (n + 0.5).floor().max(0.0) as i64 } }
impl BotRuntimeMetrics {
    pub fn new(conn: ConnectionManager, config: Config) -> Self { Self { conn, config, state: Arc::new(Mutex::new(State::default())), started_ms: Arc::new(AtomicI64::new(now_ms())), delay: Arc::new(Mutex::new(DelayHistogram::default())), active: Arc::new(AtomicBool::new(false)) } }
    fn change(&self, f: impl FnOnce(&mut State)) { f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner())); }
    pub fn observe_eventsub_notification(&self, kind: &str, bytes: f64) { self.change(|s| { let kind=normalized(kind,"unknown"); s.window.eventsub_notifications+=1; s.window.eventsub_notification_bytes+=js_nonnegative(bytes); if let Some((_,n))=s.types.iter_mut().find(|(k,_)|k==&kind) {*n+=1;} else {s.types.push((kind.clone(),1));} *s.totals.eventsub_by_type.entry(kind).or_default()+=1; }); }
    pub fn start_eventsub_handler(&self) { self.change(|s| { s.eventsub+=1; s.totals.max_inflight_eventsub_handlers=s.totals.max_inflight_eventsub_handlers.max(s.eventsub); }); }
    pub fn end_eventsub_handler(&self, failed: bool) { self.change(|s| { s.eventsub=(s.eventsub-1).max(0); s.window.eventsub_handled+=1; if failed {s.window.eventsub_handle_errors+=1;} }); }
    pub fn start_message_handler(&self) { self.change(|s| { s.message+=1; s.window.message_handler_started+=1; s.totals.max_inflight_message_handlers=s.totals.max_inflight_message_handlers.max(s.message); }); }
    pub fn end_message_handler(&self, failed: bool) { self.change(|s| { s.message=(s.message-1).max(0); s.window.message_handler_completed+=1; if failed {s.window.message_handler_errors+=1;} }); }
    pub fn observe_embedding_queue(&self, size: f64, processing: bool) { self.change(|s| { s.queue=js_nonnegative(size); s.processing=processing; s.totals.max_embedding_queue_size=s.totals.max_embedding_queue_size.max(s.queue); }); }
    pub fn record_embedding_enqueued(&self, size: f64) { self.change(|s| { s.window.embedding_enqueued+=1; s.queue=js_nonnegative(size); s.totals.max_embedding_queue_size=s.totals.max_embedding_queue_size.max(s.queue); }); }
    pub fn record_embedding_batch_result(&self, size: f64, success: bool) { self.change(|s| if success {s.window.embedding_batches_success+=1; s.window.embedding_messages_processed+=js_nonnegative(size);} else {s.window.embedding_batches_failed+=1;}); }
    pub fn record_redis_ops_estimate(&self, n: f64) { self.change(|s| s.window.redis_ops_estimated+=if n.is_nan() {0.0} else {(n+0.5).floor().max(0.0)}); }
    pub fn record_openrouter_embedding_request(&self, chars: f64) { self.change(|s| {s.window.openrouter_embedding_requests+=1; s.window.openrouter_embedding_input_chars+=js_nonnegative(chars);}); }
    pub fn record_openrouter_embedding_error(&self) { self.change(|s| s.window.openrouter_embedding_errors+=1); }
    /// Snapshot and reset happens before Redis writes, as in the source. Failed writes lose that window.
    pub async fn flush(&self) -> RedisResult<()> { self.flush_at(now_ms()).await }
    pub async fn flush_at(&self, now: i64) -> RedisResult<()> {
        let (window,types,totals,eventsub,message,queue,processing) = { let mut s=self.state.lock().unwrap_or_else(|e| e.into_inner()); (std::mem::take(&mut s.window),std::mem::take(&mut s.types),s.totals.clone(),s.eventsub,s.message,s.queue,s.processing) };
        let (bucket,timestamp)=date(now); let (_,started_at)=date(self.started_ms.load(Ordering::Acquire));
        let proc = read_process();
        let delay = std::mem::take(&mut *self.delay.lock().unwrap_or_else(|e| e.into_inner())).summary();
        // Node heap, event loop and active handle/request introspection remain unavailable.
        let snapshot=json!({"timestamp":timestamp,"process":{"pid":std::process::id(),"node":null,"uptimeSeconds":proc.uptime_seconds.map(|n| (n + 0.5).floor() as u64),"startedAt":started_at,"elapsedMs":now-self.started_ms.load(Ordering::Acquire)},"memory":{"rssBytes":proc.rss_bytes,"heapTotalBytes":null,"heapUsedBytes":null,"externalBytes":null,"arrayBuffersBytes":null},"runtime":{"inflightEventsubHandlers":eventsub,"inflightMessageHandlers":message,"activeHandles":null,"activeRequests":null,"embeddingQueueSize":queue,"embeddingProcessing":processing},"tokioSchedulingDelay":delay,"eventLoop":{"minMs":null,"maxMs":null,"meanMs":null,"stddevMs":null,"p50Ms":null,"p95Ms":null,"p99Ms":null},"window": {"durationMs":self.config.interval.as_millis() as u64, "eventsubNotifications":window.eventsub_notifications,"eventsubNotificationBytes":window.eventsub_notification_bytes,"eventsubHandled":window.eventsub_handled,"eventsubHandleErrors":window.eventsub_handle_errors,"messageHandlerStarted":window.message_handler_started,"messageHandlerCompleted":window.message_handler_completed,"messageHandlerErrors":window.message_handler_errors,"embeddingEnqueued":window.embedding_enqueued,"embeddingBatchesSuccess":window.embedding_batches_success,"embeddingBatchesFailed":window.embedding_batches_failed,"embeddingMessagesProcessed":window.embedding_messages_processed,"redisOpsEstimated":window.redis_ops_estimated,"openrouterEmbeddingRequests":window.openrouter_embedding_requests,"openrouterEmbeddingErrors":window.openrouter_embedding_errors,"openrouterEmbeddingInputChars":window.openrouter_embedding_input_chars,"eventsubByType":types.iter().cloned().collect::<BTreeMap<_,_>>()},"totals":totals});
        let p=&self.config.prefix; let latest=format!("{p}:runtime:latest"); let history=format!("{p}:runtime:history"); let cumulative=format!("{p}:runtime:cumulative"); let by_type=format!("{cumulative}:eventsubByType"); let minute=format!("{p}:eventsub:minute:{bucket}"); let meta=format!("{p}:runtime:minute:{bucket}"); let mut c=self.conn.clone(); let serialized=snapshot.to_string();
        redis::cmd("SET").arg(latest).arg(&serialized).arg("EX").arg(self.config.ttl_seconds).query_async::<()>(&mut c).await?;
        redis::cmd("LPUSH").arg(&history).arg(serialized).query_async::<i64>(&mut c).await?;
        redis::cmd("LTRIM").arg(&history).arg(0).arg(self.config.history_limit.saturating_sub(1)).query_async::<()>(&mut c).await?; expire(&mut c,&history,self.config.ttl_seconds).await?;
        // Counter order matches Object.keys(windowCounters), including Redis rejection of fractions.
        let fields=[("eventsubNotifications",window.eventsub_notifications.to_string()),("eventsubNotificationBytes",window.eventsub_notification_bytes.to_string()),("eventsubHandled",window.eventsub_handled.to_string()),("eventsubHandleErrors",window.eventsub_handle_errors.to_string()),("messageHandlerStarted",window.message_handler_started.to_string()),("messageHandlerCompleted",window.message_handler_completed.to_string()),("messageHandlerErrors",window.message_handler_errors.to_string()),("embeddingEnqueued",window.embedding_enqueued.to_string()),("embeddingBatchesSuccess",window.embedding_batches_success.to_string()),("embeddingBatchesFailed",window.embedding_batches_failed.to_string()),("embeddingMessagesProcessed",window.embedding_messages_processed.to_string()),("redisOpsEstimated",window.redis_ops_estimated.to_string()),("openrouterEmbeddingRequests",window.openrouter_embedding_requests.to_string()),("openrouterEmbeddingErrors",window.openrouter_embedding_errors.to_string()),("openrouterEmbeddingInputChars",window.openrouter_embedding_input_chars.to_string())];
        for (k,v) in fields { redis::cmd("HINCRBY").arg(&cumulative).arg(k).arg(v).query_async::<i64>(&mut c).await?; }
        for (k,v) in &types { hincr(&mut c,&by_type,k,*v).await?; }
        redis::cmd("HSET").arg(&cumulative).arg("updatedAt").arg(&timestamp).arg("maxInflightEventsubHandlers").arg(totals.max_inflight_eventsub_handlers).arg("maxInflightMessageHandlers").arg(totals.max_inflight_message_handlers).arg("maxEmbeddingQueueSize").arg(totals.max_embedding_queue_size).query_async::<i64>(&mut c).await?;
        expire(&mut c,&cumulative,self.config.ttl_seconds).await?; expire(&mut c,&by_type,self.config.ttl_seconds).await?;
        hincr(&mut c,&minute,"total",window.eventsub_notifications).await?;
        for (k,v) in [("messageHandlersStarted",window.message_handler_started),("messageHandlersCompleted",window.message_handler_completed),("embeddingEnqueued",window.embedding_enqueued),("embeddingProcessed",window.embedding_messages_processed as i64),("redisOpsEstimated",window.redis_ops_estimated as i64)] { hincr(&mut c,&meta,k,v).await?; }
        for (k,v) in &types { hincr(&mut c,&minute,k,*v).await?; } expire(&mut c,&minute,self.config.ttl_seconds).await?; expire(&mut c,&meta,self.config.ttl_seconds).await?; Ok(())
    }
    /// Starts one owned loop. Call once per application owner; shutdown performs a final flush.
    pub fn start(&self) -> Option<MetricsTask> { if self.config.interval.is_zero() || self.active.swap(true,Ordering::AcqRel) { return None; } self.started_ms.store(now_ms(),Ordering::Release); let delay=self.delay.clone(); let sampler=tokio::spawn(async move { let period=Duration::from_millis(20); let mut deadline=tokio::time::Instant::now()+period; loop { tokio::time::sleep_until(deadline).await; let now=tokio::time::Instant::now(); delay.lock().unwrap_or_else(|e| e.into_inner()).record(now.saturating_duration_since(deadline)); deadline=now+period; } }); let (tx,mut rx)=oneshot::channel(); let metrics=self.clone(); let task=tokio::spawn(async move { let mut interval=tokio::time::interval_at(tokio::time::Instant::now()+metrics.config.interval,metrics.config.interval); interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip); loop { tokio::select! { _ = &mut rx => break, _ = interval.tick() => { let _=metrics.flush().await; } } } }); Some(MetricsTask { stop:Some(tx), task:Some(task), sampler:Some(sampler), metrics:self.clone(), owned:true }) }
    async fn semantic_fields(&self, family:&str, channel:&str, fields:Vec<(String,i64)>, now:i64) -> RedisResult<()> { let (bucket,iso)=date(now); let p=&self.config.prefix; let keys=[format!("{p}:{family}:minute:{bucket}"),format!("{p}:{family}:channel:{channel}:minute:{bucket}"),format!("{p}:{family}:cumulative")]; let mut c=self.conn.clone(); for key in &keys { for (field,value) in &fields {hincr(&mut c,key,field,*value).await?;} } redis::cmd("HSET").arg(&keys[2]).arg("updatedAt").arg(iso).query_async::<i64>(&mut c).await?; for key in &keys {expire(&mut c,key,SEMANTIC_TTL).await?;} Ok(()) }
    pub async fn semantic_memory(&self, m:&SemanticMemory, now:i64) -> RedisResult<()> { let mut f=vec![("requests".into(),1),("requestedTotal".into(),nonnegative(m.requested)),("retrievedTotal".into(),nonnegative(m.retrieved)),("latencyMsTotal".into(),nonnegative(m.latency_ms)),("avgScoreMilliTotal".into(),nonnegative(m.avg_score*1000.0))]; if m.failed {f.push(("errors".into(),1));} f.push((format!("pass:{}",normalized(&m.pass,"none")),1)); self.semantic_fields("semantic",&m.channel_id,f,now).await }
    pub async fn stream_memory_job(&self, m:&StreamMemoryJob, now:i64) -> RedisResult<()> { let mut f=vec![("requests".into(),1),(format!("job:{}",normalized(&m.job_type,"unknown")),1),(format!("source:{}",normalized(&m.source,"stream_offline")),1),(format!("status:{}",normalized(&m.status,"noop")),1),("latencyMsTotal".into(),nonnegative(m.latency_ms))]; if m.failed {f.push(("errors".into(),1));} self.semantic_fields("stream_memory:job",&m.channel_id,f,now).await }
    pub async fn stream_memory_action(&self, m:&StreamMemoryAction, now:i64) -> RedisResult<()> { let n=nonnegative(m.count); if n==0 {return Ok(());} self.semantic_fields("stream_memory:action",&m.channel_id,vec![("count".into(),n),(format!("action:{}",normalized(&m.action,"unknown")),n),(format!("source:{}",normalized(&m.source,"stream_offline")),n)],now).await }
    /// Contract tl1-c2: team1 owns the only threading Redis writer.
    #[cfg(feature="ai-threading")]
    pub async fn thread_routing(&self, metric:&crate::utils::ai_threading::thread_router::ThreadRoutingMetric) -> Result<(),crate::utils::ai_threading::thread_store::ThreadStoreError> { let mut conn=self.conn.clone(); crate::utils::ai_threading::thread_router::record_thread_routing_metric(&mut conn,&self.config.prefix,metric).await }
}
async fn hincr(c:&mut ConnectionManager,key:&str,field:&str,n:i64)->RedisResult<()> { redis::cmd("HINCRBY").arg(key).arg(field).arg(n).query_async::<i64>(c).await.map(|_|()) }
async fn expire(c:&mut ConnectionManager,key:&str,ttl:u64)->RedisResult<()> { redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<bool>(c).await.map(|_|()) }
#[derive(Default)] pub struct SemanticMemory { pub channel_id:String,pub requested:f64,pub retrieved:f64,pub latency_ms:f64,pub avg_score:f64,pub failed:bool,pub pass:String }
#[derive(Default)] pub struct StreamMemoryJob { pub channel_id:String,pub latency_ms:f64,pub failed:bool,pub status:String,pub job_type:String,pub source:String }
#[derive(Default)] pub struct StreamMemoryAction { pub channel_id:String,pub action:String,pub source:String,pub count:f64 }
pub struct MetricsTask { stop:Option<oneshot::Sender<()>>, task:Option<JoinHandle<()>>, sampler:Option<JoinHandle<()>>, metrics:BotRuntimeMetrics, owned:bool }
impl MetricsTask { pub async fn shutdown(&mut self) -> RedisResult<()> {
    if let Some(stop)=self.stop.take() { let _=stop.send(()); }
    if let Some(sampler)=self.sampler.as_mut() { sampler.abort(); let _=sampler.await; } self.sampler=None;
    if let Some(task)=self.task.as_mut() { let _=task.await; } self.task=None;
    if self.owned { let result=self.metrics.flush().await; self.metrics.active.store(false,Ordering::Release); self.owned=false; result?; } Ok(())
} }
impl Drop for MetricsTask { fn drop(&mut self) { if let Some(task)=self.task.take() { task.abort(); } if let Some(sampler)=self.sampler.take() { sampler.abort(); } if self.owned { self.metrics.active.store(false,Ordering::Release); } } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_proc_and_delay_measurements() {
        let stat="42 (name with ) paren) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1250 0";
        let p=process_from_proc("Pid: 42\nVmRSS: 123 kB\n",stat,"20.25 0",42,100);
        assert_eq!(p.rss_bytes,Some(125952)); assert_eq!(p.uptime_seconds,Some(7.75));
        assert_eq!(process_from_proc("Pid: 43\nVmRSS: 123 kB\n",stat,"20 0",42,100).rss_bytes,None);
        assert_eq!(process_from_proc("Pid: 42\nVmRSS: 1 MB\n",stat,"20 0",42,100).rss_bytes,None);
        let mut h=DelayHistogram::default(); assert!(h.summary().is_null());
        h.record(Duration::from_micros(250)); h.record(Duration::from_millis(10)); h.record(Duration::from_secs(5));
        let s=h.summary(); assert_eq!(s["samples"],3); assert_eq!(s["p50Ms"],10); assert_eq!(s["p99Ms"],1000); assert_eq!(s["maxMs"],5000.0);
        let fresh=std::mem::take(&mut h); assert_eq!(fresh.summary()["samples"],3); assert!(h.summary().is_null());
    }
    #[cfg(target_os="linux")]
    #[test]
    fn actual_linux_process_measurement() { let p=read_process(); assert!(p.rss_bytes.unwrap()>0); assert!(p.uptime_seconds.unwrap()>=0.0); }
}
