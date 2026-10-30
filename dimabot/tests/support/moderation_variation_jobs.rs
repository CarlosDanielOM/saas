//! Task-owned native fixtures for the variation-job source replay.
//! The parent must provision a fresh private Mongo with enableTestCommands=1.
use dima_rust::utils::{
    js_string::JsString,
    moderation::{
        variation_jobs::{Clock, VariationJobsService},
        variations_provider::MuseVariationsProvider,
    },
};
use mongodb::{
    Client, Database,
    bson::{Bson, DateTime, Document, doc},
    event::{EventHandler, command::CommandEvent},
    options::ClientOptions,
};
use redis::AsyncCommands;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub const SOURCE_EPOCH: i64 = 1_767_312_000_000; // 2026-01-02, source fixture clock.
// Far ahead of real Mongo's TTL monitor; every source date receives this shift.
pub const EPOCH: i64 = 4_102_444_800_000; // 2100-01-01.
pub const SHIFT: i64 = EPOCH - SOURCE_EPOCH;
pub const CACHE: &str = "moderation_variation_caches";
pub const JOBS: &str = "moderation_variation_jobs";

pub fn string(value: &Value) -> String {
    let units = value["utf16"]
        .as_array()
        .expect("tagged string")
        .iter()
        .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
        .collect::<Vec<_>>();
    String::from_utf16(&units).expect("BSON string boundary cannot hold isolated surrogates")
}
pub fn decode(value: &Value) -> Bson {
    match value["kind"].as_str().unwrap() {
        "undefined" | "hole" => Bson::Undefined,
        "null" => Bson::Null,
        "boolean" => Bson::Boolean(value["value"].as_bool().unwrap()),
        "string" => Bson::String(string(value)),
        "number" => Bson::Double(f64::from_bits(
            u64::from_str_radix(value["bits"].as_str().unwrap(), 16).unwrap(),
        )),
        "date" => Bson::DateTime(DateTime::from_millis(
            number(&decode(&value["milliseconds"])) as i64 + SHIFT,
        )),
        "array" => Bson::Array(
            value["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(decode)
                .collect(),
        ),
        "object" => {
            let mut out = Document::new();
            for pair in value["entries"].as_array().unwrap() {
                let units = pair[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>();
                out.insert(String::from_utf16(&units).unwrap(), decode(&pair[1]));
            }
            Bson::Document(out)
        }
        tag => panic!("unsupported source tag {tag}"),
    }
}
pub fn number(value: &Bson) -> f64 {
    match value {
        Bson::Double(n) => *n,
        Bson::Int32(n) => f64::from(*n),
        Bson::Int64(n) => *n as f64,
        _ => panic!("not a number: {value:?}"),
    }
}
pub fn strings(value: &Bson) -> Vec<JsString> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect()
}
pub fn documents(value: &Bson) -> Vec<Document> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_document().unwrap().clone())
        .collect()
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn pinned_reference() -> Value {
    let path =
        std::env::var("DIMA_VARIATION_JOBS_REFERENCE").expect("independent source-reference path");
    let pin = std::env::var("DIMA_VARIATION_JOBS_REFERENCE_SHA256")
        .expect("independent source-reference checksum");
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(digest(&bytes), pin);
    let reference: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reference["schema"], 1);
    assert_eq!(reference["provenance"]["caseCount"], 38);
    let source_root = std::env::var("DIMA_VARIATION_JOBS_SOURCE_ROOT")
        .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").into());
    let root = std::path::Path::new(&source_root);
    assert_eq!(
        reference["provenance"]["sourceSha256"],
        digest(&std::fs::read(root.join("src/utils/moderation/variation_jobs.ts")).unwrap())
    );
    assert_eq!(
        reference["provenance"]["readerSha256"],
        digest(
            &std::fs::read(root.join("tests/fixtures/moderation_variation_jobs_reference.cjs"))
                .unwrap()
        )
    );
    assert_eq!(
        reference["provenance"]["loaderSha256"],
        digest(
            &std::fs::read(root.join("tests/fixtures/moderation_variations_source.cjs")).unwrap()
        )
    );
    assert_eq!(reference["provenance"]["node"], "24.22.1");
    assert_eq!(reference["provenance"]["typescript"], "5.9.3");
    for (source, pin) in reference["provenance"]["pins"].as_object().unwrap() {
        assert_eq!(
            pin.as_str().unwrap(),
            digest(&std::fs::read(root.join(source)).unwrap()),
            "stale source pin {source}"
        );
    }
    assert_eq!(reference["cases"].as_array().unwrap().len(), 38);
    reference
}

#[derive(Default)]
pub struct TestClock(pub AtomicI64);
impl TestClock {
    pub fn new() -> Self {
        Self(AtomicI64::new(EPOCH))
    }
    pub fn set(&self, value: i64) {
        self.0.store(value, Ordering::SeqCst);
    }
}
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Clone, Debug)]
pub struct Call {
    pub method: String,
    pub args: Vec<Bson>,
}
pub type Calls = Arc<Mutex<Vec<Call>>>;
#[derive(Clone)]
pub enum Action {
    Fault {
        command: String,
        code: i32,
    },
    Insert {
        collection: String,
        document: Document,
    },
    Update {
        collection: String,
        filter: Document,
        update: Document,
    },
    Advance(i64),
}
#[derive(Clone)]
pub struct Hook {
    pub method: String,
    pub occurrence: usize,
    pub actions: Vec<Action>,
}
enum Control {
    Run(Vec<Action>, mpsc::SyncSender<()>),
    Cleanup(Vec<String>, mpsc::SyncSender<()>),
}

fn wire_call(command: &str, d: &Document) -> Option<Call> {
    let collection = d.get_str(command).ok()?;
    let model = match collection {
        CACHE => "Cache",
        JOBS => "Jobs",
        "users" => "Users",
        _ => return None,
    };
    let (method, args) = match command {
        "find" => {
            let filter = d.get_document("filter").unwrap().clone();
            if model == "Jobs" {
                ("findById", vec![filter.get("_id").unwrap().clone()])
            } else {
                if model == "Users" {
                    assert_value(
                        &Bson::Document(d.get_document("projection").unwrap().clone()),
                        &Bson::Document(doc! {"plan_tier":1}),
                        "owner plan projection",
                    );
                }
                (
                    if model == "Users" { "findOne" } else { "find" },
                    vec![filter.into()],
                )
            }
        }
        "insert" => ("create", vec![d.get_array("documents").unwrap()[0].clone()]),
        "findAndModify" => {
            let mut options = doc! {"new":d.get_bool("new").unwrap_or(false)};
            if let Ok(sort) = d.get_document("sort") {
                options.insert("sort", sort.clone());
            }
            (
                "findOneAndUpdate",
                vec![
                    d.get_document("query").unwrap().clone().into(),
                    d.get_document("update").unwrap().clone().into(),
                    options.into(),
                ],
            )
        }
        "update" => {
            let update = d.get_array("updates").unwrap()[0].as_document().unwrap();
            let mut args = vec![
                update.get_document("q").unwrap().clone().into(),
                update.get_document("u").unwrap().clone().into(),
            ];
            if update.get_bool("upsert").unwrap_or(false) {
                args.push(doc! {"upsert":true}.into());
            }
            (
                if update.get_bool("multi").unwrap_or(false) {
                    "updateMany"
                } else {
                    "updateOne"
                },
                args,
            )
        }
        _ => return None,
    };
    Some(Call {
        method: format!("{model}.{method}"),
        args,
    })
}

pub struct Fixture {
    pub db: Database,
    pub redis: redis::aio::ConnectionManager,
    pub namespace: String,
    pub clock: Arc<TestClock>,
    pub calls: Calls,
    hooks: Arc<Mutex<Vec<Hook>>>,
    counts: Arc<Mutex<BTreeMap<String, usize>>>,
    control: mpsc::Sender<Control>,
    worker: Option<thread::JoinHandle<()>>,
    keys: Mutex<Vec<String>>,
}
impl Fixture {
    pub async fn new() -> Self {
        assert_eq!(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap(),
            "dimabot-migration"
        );
        let uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
        let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").unwrap();
        assert_eq!(uri, "mongodb://keyword-mongo:27017");
        assert_eq!(redis_url, "redis://keyword-redis:6379/");
        let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
        assert!(
            namespace.starts_with("keyword-fixture-")
                && namespace.ends_with(':')
                && (24..=50).contains(&namespace.len())
                && namespace
                    .trim_end_matches(':')
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        );
        // Explicit acknowledgement that failCommand is scoped to a fresh private server.
        assert_eq!(
            std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
            namespace
        );
        let name = format!("{}_vj", namespace.trim_end_matches(':').replace('-', "_"));
        let app = format!("{}vj", namespace);
        let clock = Arc::new(TestClock::new());
        let calls = Calls::default();
        let hooks = Arc::new(Mutex::new(Vec::<Hook>::new()));
        let counts = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));
        let (tx, rx) = mpsc::channel::<Control>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(0);
        let control_clock = clock.clone();
        let control_name = name.clone();
        let control_namespace = namespace.clone();
        let control_uri = uri.clone();
        let control_app = app.clone();
        let control_redis = redis_url.clone();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let (client, mut redis) = runtime.block_on(async {
                let mut options = ClientOptions::parse(&control_uri).await.unwrap();
                options.direct_connection = Some(true);
                options.retry_reads = Some(false);
                options.retry_writes = Some(false);
                let client = Client::with_options(options).unwrap();
                let redis =
                    redis::aio::ConnectionManager::new(redis::Client::open(control_redis).unwrap())
                        .await
                        .unwrap();
                (client, redis)
            });
            ready_tx.send(()).unwrap();
            while let Ok(message) = rx.recv() {
                match message {
                    Control::Run(actions, done) => {
                        runtime.block_on(async {
                            for action in actions { match action {
                                Action::Advance(ms) => control_clock.set(ms),
                                Action::Fault { command, code } => { client.database("admin").run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":[command],"errorCode":code,"appName":&control_app}}).await.expect("private Mongo requires enableTestCommands=1"); },
                                Action::Insert { collection, document } => { client.database(&control_name).collection::<Document>(&collection).insert_one(document).await.unwrap(); },
                                Action::Update { collection, filter, update } => { client.database(&control_name).collection::<Document>(&collection).update_one(filter, update).await.unwrap(); },
                            } }
                        });
                        done.send(()).unwrap();
                    }
                    Control::Cleanup(keys, done) => {
                        runtime.block_on(async {
                            let db = client.database(&control_name);
                            let marker = db
                                .collection::<Document>("_variation_jobs_owner")
                                .find_one(doc! {"_id":"owner"})
                                .await
                                .unwrap()
                                .expect("fixture ownership marker");
                            assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
                            assert_eq!(marker.get_str("namespace").unwrap(), control_namespace);
                            client
                                .database("admin")
                                .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
                                .await
                                .unwrap();
                            for key in keys {
                                assert!(
                                    key.starts_with(&format!("moderation:{control_namespace}"))
                                );
                                let _: usize = redis.del(key).await.unwrap();
                            }
                            db.drop().await.unwrap();
                        });
                        done.send(()).unwrap();
                        break;
                    }
                }
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut options = ClientOptions::parse(uri).await.unwrap();
        options.direct_connection = Some(true);
        options.retry_reads = Some(false);
        options.retry_writes = Some(false);
        options.app_name = Some(app);
        let recorder = calls.clone();
        let active_hooks = hooks.clone();
        let seen = counts.clone();
        let command_control = tx.clone();
        options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
            if let CommandEvent::Started(event) = event
                && let Some(call) = wire_call(&event.command_name, &event.command)
            {
                let occurrence = {
                    let mut seen = seen.lock().unwrap();
                    let n = seen.entry(call.method.clone()).or_default();
                    *n += 1;
                    *n
                };
                let actions = {
                    let mut hooks = active_hooks.lock().unwrap();
                    hooks
                        .iter()
                        .position(|h| h.method == call.method && h.occurrence == occurrence)
                        .map(|index| hooks.remove(index).actions)
                };
                recorder.lock().unwrap().push(call);
                if let Some(actions) = actions {
                    let (done, ack) = mpsc::sync_channel(0);
                    command_control.send(Control::Run(actions, done)).unwrap();
                    ack.recv_timeout(Duration::from_secs(10)).unwrap();
                }
            }
        }));
        let client = Client::with_options(options).unwrap();
        let db = client.database(&name);
        assert!(
            db.list_collection_names().await.unwrap().is_empty(),
            "unique empty task database required"
        );
        db.collection::<Document>("_variation_jobs_owner")
            .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","namespace":&namespace})
            .await
            .unwrap();
        let redis = redis::aio::ConnectionManager::new(redis::Client::open(redis_url).unwrap())
            .await
            .unwrap();
        Self {
            db,
            redis,
            namespace,
            clock,
            calls,
            hooks,
            counts,
            control: tx,
            worker: Some(worker),
            keys: Mutex::new(Vec::new()),
        }
    }
    pub async fn reset(&self) {
        assert!(
            self.hooks.lock().unwrap().is_empty(),
            "all planned operation hooks must execute"
        );
        for name in [CACHE, JOBS, "users"] {
            self.db
                .collection::<Document>(name)
                .delete_many(doc! {})
                .await
                .unwrap();
        }
        self.calls.lock().unwrap().clear();
        self.counts.lock().unwrap().clear();
        self.clock.set(EPOCH);
    }
    pub async fn channel(&self, suffix: &str) -> JsString {
        let channel = format!("{}{suffix}", self.namespace);
        let mut redis = self.redis.clone();
        for key in [
            format!("moderation:{channel}:variation-words"),
            format!("moderation:{channel}:variation-jobs"),
        ] {
            assert!(
                !redis.exists::<_, bool>(&key).await.unwrap(),
                "unique task key required"
            );
            self.keys.lock().unwrap().push(key);
        }
        channel.into()
    }
    pub fn hook(&self, method: &str, occurrence: usize, actions: Vec<Action>) {
        self.hooks.lock().unwrap().push(Hook {
            method: method.into(),
            occurrence,
            actions,
        });
    }
    pub fn clear_recording(&self) {
        self.calls.lock().unwrap().clear();
        self.counts.lock().unwrap().clear();
    }
    pub fn service(&self, endpoint: impl Into<String>) -> VariationJobsService {
        VariationJobsService::new(
            self.db.clone(),
            self.redis.clone(),
            MuseVariationsProvider::new(
                reqwest::Client::new(),
                endpoint,
                Some("fixture-key".into()),
            ),
        )
        .with_clock(self.clock.clone())
    }
    pub fn assert_hooks_consumed(&self) {
        assert!(self.hooks.lock().unwrap().is_empty());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let (done, ack) = mpsc::sync_channel(0);
        // Cleanup happens on a separate runtime even during unwinding; the parent
        // still owns container cleanup if a process abort prevents Rust Drop.
        let keys = self.keys.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if self.control.send(Control::Cleanup(keys, done)).is_ok() {
            let result = ack.recv_timeout(Duration::from_secs(20));
            if !thread::panicking() {
                result.unwrap();
            }
        }
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

#[derive(Clone)]
pub struct Reply {
    pub http_error: bool,
    pub invalid: bool,
    pub advance: i64,
    pub model: Value,
    pub usage: Value,
    pub delay_ms: u64,
}
impl Default for Reply {
    fn default() -> Self {
        Self {
            http_error: false,
            invalid: false,
            advance: 0,
            model: Value::String("fixture-model".into()),
            usage: serde_json::json!({"prompt_tokens":3,"completion_tokens":4,"cost":0.25}),
            delay_ms: 0,
        }
    }
}
pub struct Provider {
    pub endpoint: String,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    pub requests: Arc<Mutex<Vec<Value>>>,
}
impl Provider {
    pub fn start(replies: Vec<Reply>, calls: Calls, clock: Arc<TestClock>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/completions", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            for reply in replies {
                let mut socket = loop {
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(1))
                        }
                        Err(error) => panic!("loopback accept: {error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {}
                    }
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                if reader.read_exact(&mut bytes).is_err() {
                    return;
                }
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                calls.lock().unwrap().push(Call {
                    method: "Fetch".into(),
                    args: vec![Bson::String(body.to_string())],
                });
                recorded.lock().unwrap().push(body.clone());
                clock.0.fetch_add(reply.advance, Ordering::SeqCst);
                if reply.delay_ms > 0 {
                    thread::sleep(Duration::from_millis(reply.delay_ms));
                }
                let content: Value =
                    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                let output = if reply.invalid {
                    serde_json::json!({})
                } else {
                    serde_json::json!({"entries":content["terms"].as_array().unwrap().iter().map(|term| serde_json::json!({"term":term,"spellings":[]})).collect::<Vec<_>>()})
                };
                let response = serde_json::json!({"model":reply.model,"usage":reply.usage,"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
                let status = if reply.http_error {
                    "503 Service Unavailable"
                } else {
                    "200 OK"
                };
                // A timed-out client deliberately disconnects before this write.
                let _ = write!(
                    socket,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                );
            }
        });
        Self {
            endpoint,
            stop,
            worker: Some(worker),
            requests,
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

/// Compare JSON-number semantics across BSON int32/int64/double encodings.
/// Object member order is irrelevant; array/Map insertion order is significant.
pub fn assert_value(actual: &Bson, expected: &Bson, context: &str) {
    match (actual, expected) {
        (
            Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_),
            Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_),
        ) => assert_eq!(number(actual), number(expected), "{context}"),
        (Bson::Document(a), Bson::Document(e)) => {
            assert_eq!(a.len(), e.len(), "{context}: {a:?} != {e:?}");
            for (key, value) in e {
                assert_value(
                    a.get(key)
                        .unwrap_or_else(|| panic!("{context}: missing {key}")),
                    value,
                    context,
                );
            }
        }
        (Bson::Array(a), Bson::Array(e)) => {
            assert_eq!(a.len(), e.len(), "{context}");
            for (a, e) in a.iter().zip(e) {
                assert_value(a, e, context);
            }
        }
        _ => assert_eq!(actual, expected, "{context}"),
    }
}

/// RESP2 forwarding proxy to the exact guarded private Redis alias. It drops
/// the first applied EVALSHA response, producing a genuinely uncertain result.
pub struct RedisResponseLoss {
    pub url: String,
    pub script_count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl RedisResponseLoss {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let script_count = Arc::new(AtomicUsize::new(0));
        let counted = script_count.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (mut downstream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("private RESP accept: {error}"),
                };
                downstream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .unwrap();
                let mut upstream = std::net::TcpStream::connect("keyword-redis:6379").unwrap();
                upstream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut down_reader = BufReader::new(downstream.try_clone().unwrap());
                let mut up_reader = BufReader::new(upstream.try_clone().unwrap());
                loop {
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    let mut request = Vec::new();
                    match resp_frame(&mut down_reader, &mut request) {
                        Ok(()) => {}
                        Err(error)
                            if request.is_empty()
                                && matches!(
                                    error.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                        {
                            continue;
                        }
                        Err(_) => break,
                    }
                    let script = request
                        .windows(b"EVALSHA".len())
                        .any(|window| window.eq_ignore_ascii_case(b"EVALSHA"))
                        || request
                            .windows(b"EVAL".len())
                            .any(|window| window.eq_ignore_ascii_case(b"EVAL"));
                    upstream.write_all(&request).unwrap();
                    let mut response = Vec::new();
                    resp_frame(&mut up_reader, &mut response).unwrap();
                    if script {
                        let index = counted.fetch_add(1, Ordering::SeqCst);
                        if index == 0 {
                            assert_ne!(
                                response.first(),
                                Some(&b'-'),
                                "uncertainty fixture must drop a successful applied script response"
                            );
                            break;
                        }
                    }
                    if downstream.write_all(&response).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            url,
            script_count,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for RedisResponseLoss {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn resp_frame(reader: &mut impl BufRead, output: &mut Vec<u8>) -> std::io::Result<()> {
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.is_empty() {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
    }
    if !line.ends_with(b"\r\n") {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    let kind = line[0];
    let count = if kind == b'$' || kind == b'*' {
        std::str::from_utf8(&line[1..line.len() - 2])
            .unwrap()
            .parse::<i64>()
            .unwrap()
    } else {
        0
    };
    output.extend_from_slice(&line);
    if kind == b'$' && count >= 0 {
        let mut data = vec![0; count as usize + 2];
        reader.read_exact(&mut data)?;
        output.extend_from_slice(&data);
    } else if kind == b'*' && count >= 0 {
        for _ in 0..count {
            resp_frame(reader, output)?;
        }
    } else if !matches!(kind, b'+' | b'-' | b':' | b'$' | b'*') {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    Ok(())
}
