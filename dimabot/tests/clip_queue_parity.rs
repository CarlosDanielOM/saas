#![cfg(feature = "clip-queue-runtime")]
//! Source-parity checks for `src/handlers/clip_queue.handler.ts`.
//!
//! The suite drives the native handler with an in-memory Redis double, a
//! recording Pub/Sub source, socket sink, studio publisher, downloader, timer,
//! clock, telemetry sink and logger. Cases live in
//! `tests/fixtures/clip_queue_cases.json`; each case seeds queue state, runs an
//! ordered step list, and compares a deterministic summary with its `expect`
//! block.
//!
//! Nothing here contacts Redis, Mongo, sockets, the filesystem or `yt-dlp`, and
//! no test writes a file: the downloader double only records its arguments.
//!
//! Provenance: the live TypeScript source
//! `dimabot/src/handlers/clip_queue.handler.ts` (333 lines) is the reference;
//! this suite asserts the queue, lease, timer, cleanup, delivery and failure
//! branches read from that file.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use dima_rust::clip_queue_handler::{
    ClipDownloadOutcome, ClipDownloader, ClipFuture, ClipLog, ClipQueueAdapters, ClipQueueConfig,
    ClipQueueError, ClipQueueHandler, ClipQueueStore, ClipRequestCallback, ClipRequestData,
    ClipRequestSource, ClipSocketSink, ClipTelemetry, ClipTimer, ClipTimerHandle, ClipClock,
    StudioClipPublisher, StudioClipPublication, clip_processing_key,
    clip_queue_data_key, clip_request_topic, clip_timeout_setting_key, clips_queue_key,
};
use dima_rust::utils::{
    logger::Level,
    lossless_json::{JsonValue, parse_json},
};
use serde_json::{Value, json};

const CHANNEL: &str = "ch";
const DOWNLOAD_DIR: &str = "/tmp/dima-rust-clip-parity";

// ---------------------------------------------------------------------------
// Redis double
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StoreState {
    zsets: BTreeMap<String, BTreeMap<String, f64>>,
    strings: BTreeMap<String, String>,
    ttls: BTreeMap<String, i64>,
}

#[derive(Default)]
struct MemoryStore {
    state: Mutex<StoreState>,
    ops: Mutex<Vec<String>>,
}

impl MemoryStore {
    fn record(&self, op: String) {
        self.ops
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(op);
    }

    fn ops(&self) -> Vec<String> {
        self.ops
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn seed_zset(&self, key: &str, member: &str, score: f64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .zsets
            .entry(key.to_owned())
            .or_default()
            .insert(member.to_owned(), score);
    }

    fn seed_string(&self, key: &str, value: &str) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .strings
            .insert(key.to_owned(), value.to_owned());
    }

    fn seed_ttl(&self, key: &str, ttl: i64) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ttls
            .insert(key.to_owned(), ttl);
    }

    fn contains(&self, key: &str) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.strings.contains_key(key) || state.zsets.contains_key(key)
    }

    fn string(&self, key: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .strings
            .get(key)
            .cloned()
    }

    fn sorted_set(&self, key: &str) -> Vec<(String, f64)> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ordered(state.zsets.get(key))
    }

    fn data_keys(&self, channel: &str) -> Vec<String> {
        let prefix = format!("twitch:{channel}:clips:queue:data:");
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut keys: Vec<_> = state
            .strings
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    fn all_keys(&self) -> Vec<String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut keys: Vec<_> = state
            .strings
            .keys()
            .chain(state.zsets.keys())
            .cloned()
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

fn ordered(set: Option<&BTreeMap<String, f64>>) -> Vec<(String, f64)> {
    let mut items: Vec<_> = set
        .map(|set| {
            set.iter()
                .map(|(member, score)| (member.clone(), *score))
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    items
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut p, mut t) = (0, 0);
    let mut star = None;
    let mut mark = 0;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            mark = t;
        } else if let Some(start) = star {
            p = start + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

impl ClipQueueStore for MemoryStore {
    fn zcard<'a>(&'a self, key: &'a str) -> ClipFuture<'a, Result<u64, ClipQueueError>> {
        self.record(format!("zcard {key}"));
        let count = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .zsets
            .get(key)
            .map_or(0, |set| set.len() as u64);
        Box::pin(async move { Ok(count) })
    }

    fn exists<'a>(&'a self, key: &'a str) -> ClipFuture<'a, Result<bool, ClipQueueError>> {
        self.record(format!("exists {key}"));
        let exists = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .strings
            .contains_key(key);
        Box::pin(async move { Ok(exists) })
    }

    fn zrank<'a>(
        &'a self,
        key: &'a str,
        member: &'a str,
    ) -> ClipFuture<'a, Result<Option<u64>, ClipQueueError>> {
        self.record(format!("zrank {key} {member}"));
        let rank = ordered(
            self.state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .zsets
                .get(key),
        )
        .iter()
        .position(|(candidate, _)| candidate == member)
        .map(|rank| rank as u64);
        Box::pin(async move { Ok(rank) })
    }

    fn zadd<'a>(
        &'a self,
        key: &'a str,
        score: f64,
        member: &'a str,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        self.record(format!("zadd {key} {score} {member}"));
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .zsets
            .entry(key.to_owned())
            .or_default()
            .insert(member.to_owned(), score);
        Box::pin(async move { Ok(()) })
    }

    fn set<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        self.record(format!("set {key} {value}"));
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .strings
            .insert(key.to_owned(), value.to_owned());
        Box::pin(async move { Ok(()) })
    }

    fn get<'a>(&'a self, key: &'a str) -> ClipFuture<'a, Result<Option<String>, ClipQueueError>> {
        self.record(format!("get {key}"));
        let value = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .strings
            .get(key)
            .cloned();
        Box::pin(async move { Ok(value) })
    }

    fn zpopmin<'a>(
        &'a self,
        key: &'a str,
    ) -> ClipFuture<'a, Result<Option<(String, f64)>, ClipQueueError>> {
        self.record(format!("zpopmin {key}"));
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let first = ordered(state.zsets.get(key)).into_iter().next();
        if let Some((member, _)) = &first {
            if let Some(set) = state.zsets.get_mut(key) {
                set.remove(member);
            }
        }
        Box::pin(async move { Ok(first) })
    }

    fn zrem<'a>(
        &'a self,
        key: &'a str,
        member: &'a str,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        self.record(format!("zrem {key} {member}"));
        if let Some(set) = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .zsets
            .get_mut(key)
        {
            set.remove(member);
        }
        Box::pin(async move { Ok(()) })
    }

    fn del<'a>(&'a self, key: &'a str) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        self.record(format!("del {key}"));
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.strings.remove(key);
        state.zsets.remove(key);
        state.ttls.remove(key);
        Box::pin(async move { Ok(()) })
    }

    fn keys<'a>(
        &'a self,
        pattern: &'a str,
    ) -> ClipFuture<'a, Result<Vec<String>, ClipQueueError>> {
        self.record(format!("keys {pattern}"));
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut keys: Vec<_> = state
            .strings
            .keys()
            .chain(state.zsets.keys())
            .filter(|key| glob_match(pattern, key))
            .cloned()
            .collect();
        keys.sort();
        keys.dedup();
        Box::pin(async move { Ok(keys) })
    }

    fn ttl<'a>(&'a self, key: &'a str) -> ClipFuture<'a, Result<i64, ClipQueueError>> {
        self.record(format!("ttl {key}"));
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.strings.contains_key(key) && !state.zsets.contains_key(key) {
            return Box::pin(async move { Ok(-2) });
        }
        let ttl = state.ttls.get(key).copied().unwrap_or(-1);
        Box::pin(async move { Ok(ttl) })
    }
}

// ---------------------------------------------------------------------------
// Recording adapters
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeRequests {
    channels: Mutex<BTreeMap<String, ClipRequestCallback>>,
    calls: Mutex<Vec<String>>,
    fail_next: AtomicBool,
}

impl FakeRequests {
    fn fail_next(&self) {
        self.fail_next.store(true, Ordering::SeqCst);
    }

    fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    async fn deliver(&self, channel: &str, payload: &Value) {
        let handler = self
            .channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(channel)
            .cloned()
            .unwrap_or_else(|| panic!("channel {channel} is not subscribed"));
        let text = serde_json::to_string(payload).expect("serializable payload");
        let fields = parse_json(&text).expect("valid payload JSON");
        let request = ClipRequestData::from_json(fields).expect("valid clip request");
        handler(request).await;
    }
}

impl ClipRequestSource for FakeRequests {
    fn subscribe<'a>(
        &'a self,
        channel: &'a str,
        handler: ClipRequestCallback,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(channel.to_owned());
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Box::pin(async {
                Err(ClipQueueError::new(
                    "subscribeToChannel",
                    "synthetic subscription failure",
                ))
            });
        }
        self.channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(channel.to_owned(), handler);
        Box::pin(async { Ok(()) })
    }
}

struct ScheduledTimer {
    delay_ms: u64,
    _callback: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct FakeTimer {
    scheduled: Mutex<Vec<ScheduledTimer>>,
    aborted: Arc<Mutex<Vec<u64>>>,
    next: AtomicU64,
}

impl FakeTimer {
    fn delays_ms(&self) -> Vec<u64> {
        self.scheduled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|timer| timer.delay_ms)
            .collect()
    }

    fn aborted(&self) -> Vec<u64> {
        self.aborted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl ClipTimer for FakeTimer {
    fn schedule(
        &self,
        delay: std::time::Duration,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> ClipTimerHandle {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.scheduled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(ScheduledTimer {
                delay_ms: delay.as_millis() as u64,
                _callback: callback,
            });
        let aborted = Arc::clone(&self.aborted);
        ClipTimerHandle::new(Arc::new(move || {
            aborted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(id);
        }))
    }
}

#[derive(Default)]
struct FakeTelemetry {
    waits: Mutex<Vec<f64>>,
    spans: Mutex<Vec<&'static str>>,
}

impl ClipTelemetry for FakeTelemetry {
    fn queue_wait(&self, _channel: &str, wait_ms: f64, _at_ms: i64) {
        self.waits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(wait_ms);
    }

    fn trace_download<'a>(
        &'a self,
        _channel: &'a str,
        run: ClipFuture<'a, ClipDownloadOutcome>,
    ) -> ClipFuture<'a, ClipDownloadOutcome> {
        Box::pin(async move {
            let outcome = run.await;
            self.spans
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(if outcome.is_failure() { "error" } else { "ok" });
            outcome
        })
    }
}

#[derive(Default)]
struct FakeLog {
    entries: Mutex<Vec<(String, String)>>,
}

impl FakeLog {
    fn payloads(&self) -> Vec<Value> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(_, payload)| serde_json::from_str(payload).expect("valid log payload"))
            .collect()
    }
}

impl ClipLog for FakeLog {
    fn log<'a>(
        &'a self,
        level: Level,
        payload: JsonValue,
        _channel: Option<&'a str>,
    ) -> ClipFuture<'a, ()> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((level.as_str().to_owned(), payload.to_json_string()));
        Box::pin(async {})
    }
}

struct FakeSink {
    sockets: usize,
    fail: bool,
    emits: Mutex<Vec<(String, Value)>>,
}

impl ClipSocketSink for FakeSink {
    fn emit_play_clip<'a>(
        &'a self,
        channel: &'a str,
        payload: &'a JsonValue,
    ) -> ClipFuture<'a, Result<usize, ClipQueueError>> {
        if self.fail {
            return Box::pin(async {
                Err(ClipQueueError::new("play-clip", "synthetic emit failure"))
            });
        }
        let payload: Value =
            serde_json::from_str(&payload.to_json_string()).expect("serializable payload");
        self.emits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((channel.to_owned(), payload));
        let sockets = self.sockets;
        Box::pin(async move { Ok(sockets) })
    }
}

#[derive(Clone)]
struct RecordedPublication {
    channel: String,
    media: Value,
    file: String,
    mime: String,
}

#[derive(Default)]
struct FakePublisher {
    publications: Mutex<Vec<RecordedPublication>>,
}

impl StudioClipPublisher for FakePublisher {
    fn publish<'a>(
        &'a self,
        channel: &'a str,
        publication: &'a StudioClipPublication,
    ) -> ClipFuture<'a, ()> {
        self.publications
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(RecordedPublication {
                channel: channel.to_owned(),
                media: serde_json::from_str(&publication.media.to_json_string())
                    .expect("serializable media"),
                file: publication.file.clone(),
                mime: publication.mime.clone(),
            });
        Box::pin(async {})
    }
}

#[derive(Default)]
struct FakeDownloader {
    fail: AtomicBool,
    deletes: Mutex<Vec<String>>,
    downloads: Mutex<Vec<String>>,
}

impl ClipDownloader for FakeDownloader {
    fn delete_old_clip<'a>(&'a self, file_path: &'a Path) -> ClipFuture<'a, Result<(), String>> {
        self.deletes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(file_name(file_path));
        Box::pin(async { Ok(()) })
    }

    fn download_clip<'a>(
        &'a self,
        url: &'a str,
        file_path: &'a Path,
    ) -> ClipFuture<'a, ClipDownloadOutcome> {
        self.downloads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(url.to_owned());
        let fail = self.fail.load(Ordering::SeqCst);
        let file_path = file_path.to_path_buf();
        Box::pin(async move {
            if fail {
                ClipDownloadOutcome::Failure {
                    message: "synthetic download failure".to_owned(),
                }
            } else {
                ClipDownloadOutcome::Success { file_path }
            }
        })
    }
}

struct FixedClock(i64);

impl ClipClock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    store: Arc<MemoryStore>,
    requests: Arc<FakeRequests>,
    sink: Arc<FakeSink>,
    publisher: Arc<FakePublisher>,
    downloader: Arc<FakeDownloader>,
    telemetry: Arc<FakeTelemetry>,
    log: Arc<FakeLog>,
    timer: Arc<FakeTimer>,
    handler: Arc<ClipQueueHandler>,
}

fn setting<'a>(case: &'a Value, key: &str) -> Option<&'a Value> {
    case.get(key).filter(|value| !value.is_null())
}

fn string_setting(case: &Value, key: &str) -> Option<String> {
    setting(case, key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn bool_setting(case: &Value, key: &str) -> bool {
    setting(case, key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn harness(case: &Value, channel: &str, download_dir: &Path) -> Harness {
    let store = Arc::new(MemoryStore::default());
    if let Some(queue) = case.get("queue").and_then(Value::as_array) {
        for entry in queue {
            let clip_id = entry
                .get("clip_id")
                .and_then(Value::as_str)
                .expect("queue entry clip_id");
            let score = entry
                .get("score")
                .and_then(Value::as_f64)
                .expect("queue entry score");
            store.seed_zset(&clips_queue_key(channel), clip_id, score);
        }
    }
    if bool_setting(case, "processing") {
        store.seed_string(&clip_processing_key(channel), "true");
    }
    if let Some(data) = case.get("data").and_then(Value::as_object) {
        for (clip_id, value) in data {
            let raw = match value {
                Value::String(raw) => raw.clone(),
                other => other.to_string(),
            };
            store.seed_string(&clip_queue_data_key(channel, clip_id), &raw);
        }
    }
    if let Some(setting_value) = string_setting(case, "timeout_setting") {
        store.seed_string(&clip_timeout_setting_key(channel), &setting_value);
    }
    if let Some(strings) = case.get("strings").and_then(Value::as_object) {
        for (key, value) in strings {
            let value = value.as_str().unwrap_or_default();
            store.seed_string(key, value);
        }
    }
    if let Some(ttls) = case.get("ttl").and_then(Value::as_object) {
        for (key, value) in ttls {
            if !store.contains(key) {
                store.seed_string(key, "");
            }
            store.seed_ttl(key, value.as_i64().expect("integer ttl"));
        }
    }
    let requests = Arc::new(FakeRequests::default());
    if bool_setting(case, "fail_next_subscribe") {
        requests.fail_next();
    }
    let sink = Arc::new(FakeSink {
        sockets: setting(case, "sockets")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize,
        fail: bool_setting(case, "emit_error"),
        emits: Mutex::new(Vec::new()),
    });
    let downloader = Arc::new(FakeDownloader::default());
    if case.get("download").and_then(Value::as_str) == Some("failure") {
        downloader.fail.store(true, Ordering::SeqCst);
    }
    let publisher = Arc::new(FakePublisher::default());
    let telemetry = Arc::new(FakeTelemetry::default());
    let log = Arc::new(FakeLog::default());
    let timer = Arc::new(FakeTimer::default());
    let clock: Arc<dyn ClipClock> = Arc::new(FixedClock(
        setting(case, "now_ms")
            .and_then(Value::as_i64)
            .unwrap_or(1_000_000),
    ));
    let store_trait: Arc<dyn ClipQueueStore> = store.clone();
    let initialized = case.get("store_initialized").and_then(Value::as_bool) != Some(false);
    let handler = Arc::new(ClipQueueHandler::with_adapters(
        ClipQueueAdapters {
            store: if initialized { Some(store_trait) } else { None },
            requests: requests.clone(),
            sockets: Some(sink.clone()),
            publisher: publisher.clone(),
            downloader: downloader.clone(),
            telemetry: telemetry.clone(),
            log: log.clone(),
            timer: timer.clone(),
            clock,
        },
        ClipQueueConfig::new(download_dir),
    ));
    Harness {
        store,
        requests,
        sink,
        publisher,
        downloader,
        telemetry,
        log,
        timer,
        handler,
    }
}

async fn run_steps(harness: &Harness, case: &Value, channel: &str) -> Vec<String> {
    let mut results = Vec::new();
    for step in case
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        match step.as_str().unwrap_or_default() {
            "subscribe" => {
                let result = harness.handler.clone().subscribe_to_channel(channel).await;
                results.push(match result {
                    Ok(()) => "ok".to_owned(),
                    Err(error) => format!("error: {error}"),
                });
            }
            "deliver" => {
                let event = case.get("event").expect("event for deliver");
                harness.requests.deliver(channel, event).await;
            }
            "deliver_twice" => {
                let event = case.get("event").expect("event for deliver");
                harness.requests.deliver(channel, event).await;
                harness.requests.deliver(channel, event).await;
            }
            "process_next" => {
                harness.handler.clone().process_next_clip(channel).await;
            }
            "clip_ended" => {
                let ended = string_setting(case, "clip_ended_id");
                harness
                    .handler
                    .clone()
                    .handle_clip_ended(channel, ended.as_deref())
                    .await;
            }
            "cleanup_old_queue_data" => {
                harness.handler.cleanup_old_queue_data(channel).await;
            }
            "startup_cleanup" => {
                harness.handler.startup_cleanup().await;
            }
            "on_timeout" => {
                let clip_id = string_setting(case, "timeout_clip_id")
                    .unwrap_or_else(|| "A".to_owned());
                let seconds = setting(case, "timeout_seconds")
                    .and_then(Value::as_f64)
                    .unwrap_or(125.0);
                harness
                    .handler
                    .clone()
                    .on_clip_timeout(channel, &clip_id, seconds)
                    .await;
            }
            other => panic!("unknown step {other}"),
        }
    }
    results
}

fn summary(harness: &Harness, channel: &str, subscribe_results: &[String]) -> Value {
    let queue: serde_json::Map<String, Value> = harness
        .store
        .sorted_set(&clips_queue_key(channel))
        .into_iter()
        .map(|(member, score)| (member, json!(score)))
        .collect();
    let waits: Vec<Value> = harness
        .telemetry
        .waits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|wait| {
            if wait.is_finite() {
                json!(*wait)
            } else {
                Value::Null
            }
        })
        .collect();
    let span_outcomes: Vec<String> = harness
        .telemetry
        .spans
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|outcome| (*outcome).to_owned())
        .collect();
    let publications: Vec<Value> = harness
        .publisher
        .publications
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|publication| {
            json!({
                "channel": publication.channel.as_str(),
                "media": &publication.media,
                "file": publication.file.as_str(),
                "mime": publication.mime.as_str(),
            })
        })
        .collect();
    let emits: Vec<Value> = harness
        .sink
        .emits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|(channel, payload)| json!({ "channel": channel.as_str(), "payload": payload }))
        .collect();
    let logs: Vec<Value> = harness
        .log
        .payloads()
        .into_iter()
        .map(|payload| {
            json!({
                "function": payload.get("function").cloned().unwrap_or(Value::Null),
                "message": payload.get("message").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let log_functions: Vec<String> = logs
        .iter()
        .map(|log| {
            log.get("function")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    let downloads: Vec<String> = harness
        .downloader
        .downloads
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let deleted_paths: Vec<String> = harness
        .downloader
        .deletes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let ops = harness.store.ops();
    let zadd_calls = ops.iter().filter(|op| op.starts_with("zadd ")).count();
    json!({
        "queue": queue,
        "processing": harness.store.string(&clip_processing_key(channel)).is_some(),
        "data_keys": harness.store.data_keys(channel),
        "wildcard_processing": harness.store.contains("twitch:*:clip:processing"),
        "timeout_setting": harness.store.string(&clip_timeout_setting_key(channel)),
        "downloads": downloads,
        "download_count": downloads.len(),
        "deleted_paths": deleted_paths,
        "publishes": publications,
        "publish_count": publications.len(),
        "emits": emits,
        "emit_count": emits.len(),
        "timer_delays_ms": harness.timer.delays_ms(),
        "timer_aborts": harness.timer.aborted().len(),
        "waits": waits,
        "span_outcomes": span_outcomes,
        "logs": logs,
        "log_functions": log_functions,
        "subscribe_calls": harness.requests.calls(),
        "subscribe_results": subscribe_results,
        "zadd_calls": zadd_calls,
        "ops": ops,
        "all_keys": harness.store.all_keys(),
        "channel": channel,
        "request_topic": clip_request_topic(channel),
    })
}

fn is_subsequence(expected: &[String], actual: &[String]) -> bool {
    let mut actual = actual.iter();
    expected
        .iter()
        .all(|wanted| actual.any(|candidate| candidate == wanted))
}

#[tokio::test]
async fn source_cases_match_the_typescript_handler() {
    let raw = include_str!("fixtures/clip_queue_cases.json");
    let cases: Value = serde_json::from_str(raw).expect("valid cases JSON");
    let cases = cases
        .get("cases")
        .and_then(Value::as_array)
        .expect("cases array");
    assert!(!cases.is_empty(), "no parity cases");
    let download_dir = PathBuf::from(DOWNLOAD_DIR);
    for case in cases {
        let name = case
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unnamed");
        let channel = string_setting(case, "channel").unwrap_or_else(|| CHANNEL.to_owned());
        let harness = harness(case, &channel, &download_dir);
        let subscribe_results = run_steps(&harness, case, &channel).await;
        let actual = summary(&harness, &channel, &subscribe_results);
        let ops: Vec<String> = actual
            .get("ops")
            .and_then(Value::as_array)
            .expect("ops")
            .iter()
            .map(|value| value.as_str().unwrap_or_default().to_owned())
            .collect();
        let expect = case.get("expect").expect("expect block");
        if let Some(expected) = expect.get("ops_contains").and_then(Value::as_array) {
            for op in expected {
                let op = op.as_str().expect("op string");
                assert!(
                    ops.iter().any(|candidate| candidate == op),
                    "{name}: missing operation {op:?} in {ops:?}"
                );
            }
        }
        if let Some(expected) = expect.get("ops_order").and_then(Value::as_array) {
            let expected: Vec<String> = expected
                .iter()
                .map(|value| value.as_str().expect("op string").to_owned())
                .collect();
            assert!(
                is_subsequence(&expected, &ops),
                "{name}: operations {expected:?} are not an ordered subsequence of {ops:?}"
            );
        }
        for (key, expected) in expect.as_object().expect("expect object") {
            if key == "ops_contains" || key == "ops_order" {
                continue;
            }
            assert_eq!(
                actual.get(key),
                Some(expected),
                "{name}: mismatch for {key}\nactual: {actual:#}"
            );
        }
    }
}

#[test]
fn glob_matching_supports_source_key_patterns() {
    assert!(glob_match(
        "twitch:ch:clips:queue:data:*",
        "twitch:ch:clips:queue:data:A"
    ));
    assert!(glob_match(
        "twitch:*:clips:queue:data:*",
        "twitch:ch:clips:queue:data:A"
    ));
    assert!(!glob_match(
        "twitch:ch:clips:queue:data:*",
        "twitch:other:clips:queue:data:A"
    ));
    assert!(glob_match("*", "anything"));
    assert!(glob_match("a*b*c", "aXXbYYc"));
    assert!(!glob_match("a*b*c", "aXXbYY"));
}
