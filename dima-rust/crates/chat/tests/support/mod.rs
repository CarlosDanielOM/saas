//! Shared harness of the ingress tests: the local stores from `tools/test-env` (a throwaway
//! `dima_test_chat_<random>` MongoDB database dropped even when a test fails; Dragonfly logical
//! database 11 with a unique key prefix, cleaned up), an ingress served on a loopback port, a
//! raw HTTP/1.1 client that sends recorded bytes exactly, and a recording handler. Without the
//! stores a test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code)]

use anyhow::{Context, Result, anyhow, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_actions::metrics::{BotMetrics, MetricsConfig};
use dima_chat::ingress::{
    EventsubHandler, FaultHook, HandlerError, Ingress, IngressConfig, IngressDeps, Notification,
    Revocation, RevocationOutcome,
};
use dima_core::{Clock, ManualClock, SecretString, Shutdown};
use dima_events::config::EventsConfig;
use dima_events::producers::{Journal, Owners};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig};
use dima_store::mongo::{MongoConfig, MongoStore};
use dima_stream::raid_subscriptions::RaidSubscriptions;
use dima_telemetry::Telemetry;
use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

/// The Dragonfly logical database of these tests.
pub const DRAGONFLY_DB: u8 = 11;

/// The recording's secret (a test value, as in `tests/reference/record_ingress.mts`).
pub const SECRET: &str = "dima-test-eventsub-secret-01";

/// `DIMA_TEST_REQUIRE_STORES=1`.
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

/// A MongoDB handle on a fresh database, pointing at `uri` (the real server or a proxy).
pub async fn connect(uri: &str, database: &str) -> Result<MongoStore> {
    let mut config = MongoConfig::new(uri.to_owned());
    config.database = Some(database.to_owned());
    config.server_selection_timeout = Some(Duration::from_secs(3));
    Ok(MongoStore::connect(&config, None).await?)
}

/// The local stores of one test.
pub struct Stores {
    /// The test's database.
    pub mongo: MongoStore,
    /// Its name.
    pub database: String,
    /// `DIMA_TEST_MONGO_URI`.
    pub uri: String,
    /// Dragonfly, database 11.
    pub dragonfly: Dragonfly,
    /// The key prefix of this test.
    pub prefix: String,
}

/// Runs `test` with fresh stores and removes what it wrote afterwards, whatever the outcome.
pub async fn with_stores<F, Fut>(name: &str, test: F) -> Result<()>
where
    F: FnOnce(Arc<Stores>) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")")
            .map(|_: Option<()>| ());
    };
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")")
            .map(|_: Option<()>| ());
    };
    let database = format!("dima_test_chat_{}", ObjectId::new().to_hex());
    let mongo = connect(&uri, &database).await?;
    if let Err(error) = mongo.ping().await {
        return missing(&format!("the local MongoDB cannot be reached: {error}"))
            .map(|_: Option<()>| ());
    }
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("DIMA_TEST_DRAGONFLY is host:port"))?;
    let mut config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{DRAGONFLY_DB}")),
        "dima-chat-tests",
    );
    config.response_timeout = Duration::from_secs(5);
    let dragonfly = match Dragonfly::connect(config, Default::default()).await {
        Ok(client) => client,
        Err(error) => {
            return missing(&format!("the local Dragonfly cannot be reached: {error}"))
                .map(|_: Option<()>| ());
        }
    };
    let prefix = format!("dima:test:chat:{name}:{}:", ObjectId::new().to_hex());
    let stores = Arc::new(Stores {
        mongo,
        database,
        uri,
        dragonfly,
        prefix,
    });
    let outcome = AssertUnwindSafe(test(stores.clone())).catch_unwind().await;
    let dropped = stores.mongo.database().drop().await;
    let cleaned = clean_keys(&stores.dragonfly, &stores.prefix).await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    outcome?;
    dropped?;
    cleaned
}

/// Deletes every key under `prefix` (bounded scan).
pub async fn clean_keys(client: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = client.scan(&format!("{prefix}*"), Some(1000));
    let mut keys = Vec::new();
    for _ in 0..10_000 {
        match scan.next_page().await? {
            Some(page) => keys.extend(page),
            None => break,
        }
    }
    for key in keys {
        if let Ok(key) = String::from_utf8(key) {
            client.del(&[key.as_str()]).await?;
        }
    }
    Ok(())
}

/// Keys under `prefix`, sorted.
pub async fn keys(client: &Dragonfly, prefix: &str) -> Result<Vec<String>> {
    let mut scan = client.scan(&format!("{prefix}*"), Some(1000));
    let mut keys = Vec::new();
    for _ in 0..10_000 {
        match scan.next_page().await? {
            Some(page) => keys.extend(page.into_iter().filter_map(|k| String::from_utf8(k).ok())),
            None => break,
        }
    }
    keys.sort();
    keys.dedup();
    Ok(keys)
}

/// What the handler was given.
#[derive(Default)]
pub struct Recorded {
    /// Notifications, in the order they arrived.
    pub notifications: Mutex<Vec<Notification>>,
    /// Revocations.
    pub revocations: Mutex<Vec<Revocation>>,
}

/// A handler that records its calls; revocations answer as the reference's handler would
/// (`Invalid` without `id`, `type` or `version`, `Done` otherwise).
#[derive(Clone, Default)]
pub struct RecordingHandler {
    /// The calls.
    pub recorded: Arc<Recorded>,
    /// A delay before each notification is recorded (a slow handler).
    pub delay: Option<Duration>,
}

impl RecordingHandler {
    /// The notifications so far.
    pub fn notifications(&self) -> Vec<Notification> {
        self.recorded
            .notifications
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The revocations so far.
    pub fn revocations(&self) -> Vec<Revocation> {
        self.recorded
            .revocations
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl EventsubHandler for RecordingHandler {
    fn handle(&self, notification: Notification) -> BoxFuture<'static, Result<(), HandlerError>> {
        let recorded = self.recorded.clone();
        let delay = self.delay;
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            recorded
                .notifications
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(notification);
            Ok(())
        })
    }

    fn revoke(&self, revocation: Revocation) -> BoxFuture<'static, RevocationOutcome> {
        let recorded = self.recorded.clone();
        Box::pin(async move {
            let complete = ["id", "type", "version"]
                .iter()
                .all(|field| revocation.subscription.at(field).truthy());
            recorded
                .revocations
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(revocation);
            if complete {
                RevocationOutcome::Done
            } else {
                RevocationOutcome::Invalid("Invalid subscription data".to_owned())
            }
        })
    }
}

/// Ensures the indexes of `domain_events` on `indexed` (as the binaries do at start-up) and
/// builds a journal that writes through `mongo` (the same database, or a proxy in front of it).
pub async fn journal(
    indexed: &MongoStore,
    mongo: &MongoStore,
    clock: Arc<dyn Clock>,
    store_deadline: Duration,
) -> Result<Journal> {
    let info = &dima_model::domain_events::INFO;
    let Some(policy) = dima_model::startup_policy(info) else {
        bail!("domain_events is not initialised at start-up");
    };
    let report = dima_model::ensure_indexes(indexed, info, policy, Duration::from_secs(30)).await;
    if report.failures().next().is_some() {
        bail!("index creation failed: {report}");
    }
    let events = EventsConfig { store_deadline };
    Ok(Journal::new(mongo.clone(), clock, &events, &report)?.with_owners(Owners::Lookup))
}

/// An ingress over the test's stores, with its telemetry off.
pub struct Harness {
    /// The ingress.
    pub ingress: Ingress,
    /// What the handler was given.
    pub handler: RecordingHandler,
    /// The clock.
    pub clock: ManualClock,
    /// The metrics.
    pub metrics: BotMetrics,
}

/// The configuration of the tests: the recording's secret, the test's key prefix, and
/// generous deadlines for a busy machine.
pub fn config(prefix: &str) -> IngressConfig {
    let mut config = IngressConfig::with_secret(SecretString::new(SECRET.to_owned()));
    config.key_prefix = prefix.to_owned();
    config.durable_deadline = Duration::from_secs(20);
    config.dedupe_deadline = Duration::from_secs(10);
    config.dead_letter_deadline = Duration::from_secs(10);
    config.admission_wait = Duration::from_secs(10);
    config
}

/// Builds an ingress over `mongo` (the test's database, or the same database through a proxy).
pub async fn harness(
    stores: &Stores,
    mongo: &MongoStore,
    config: IngressConfig,
    now_ms: i64,
    handler: RecordingHandler,
    faults: Option<FaultHook>,
) -> Result<Harness> {
    let clock = ManualClock::new(now_ms);
    let shared: Arc<dyn Clock> = Arc::new(clock.clone());
    let journal = journal(
        &stores.mongo,
        mongo,
        shared.clone(),
        Duration::from_secs(10),
    )
    .await?;
    let metrics = BotMetrics::new(
        MetricsConfig::from_env_values(
            None,
            None,
            Some(&format!("{}metrics:bot", stores.prefix)),
            None,
        ),
        stores.dragonfly.clone(),
        shared.clone(),
        None,
    );
    let deps = IngressDeps {
        journal,
        raids: RaidSubscriptions::new(mongo.clone(), shared.clone()),
        dragonfly: stores.dragonfly.clone(),
        metrics: metrics.clone(),
        telemetry: Telemetry::disabled(),
        clock: shared,
        handler: Arc::new(handler.clone()),
    };
    let ingress = match faults {
        Some(hook) => Ingress::with_fault_hook(config, deps, hook),
        None => Ingress::new(config, deps),
    };
    Ok(Harness {
        ingress,
        handler,
        clock,
        metrics,
    })
}

/// A running server.
pub struct Server {
    /// `127.0.0.1:<port>`.
    pub address: std::net::SocketAddr,
    /// Stops it.
    pub shutdown: Shutdown,
    /// The server task.
    pub task: tokio::task::JoinHandle<std::io::Result<()>>,
}

/// Serves the ingress on a loopback port, the way the binary does.
pub async fn serve(ingress: &Ingress) -> Result<Server> {
    let listener = dima_web::bind_to("127.0.0.1:0".parse()?)?;
    let address = listener.local_addr()?;
    let app = ingress.app().map_err(|error| anyhow!("{error:?}"))?;
    let telemetry = Telemetry::disabled();
    let service = telemetry.traced_service(app.observe(telemetry.web_observer()));
    let shutdown = Shutdown::new();
    let task = tokio::spawn(dima_web::serve(
        listener,
        service,
        shutdown.cancellation_token(),
        ingress.serve_options(),
    ));
    Ok(Server {
        address,
        shutdown,
        task,
    })
}

/// A request as bytes.
#[derive(Clone, Debug)]
pub struct RawRequest {
    /// The method.
    pub method: String,
    /// The path.
    pub path: String,
    /// Header lines, bytes as sent (latin1 on the wire).
    pub headers: Vec<(String, Vec<u8>)>,
    /// The body.
    pub body: Vec<u8>,
}

/// An answer as received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawResponse {
    /// The status.
    pub status: u16,
    /// Header lines, names lower-cased.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: Vec<u8>,
}

impl RawResponse {
    /// The first value of a header.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

fn head(request: &RawRequest, address: std::net::SocketAddr) -> Vec<u8> {
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: {address}\r\n",
        request.method, request.path
    )
    .into_bytes();
    for (name, value) in &request.headers {
        head.extend_from_slice(name.as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(value);
        head.extend_from_slice(b"\r\n");
    }
    head.extend_from_slice(
        format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            request.body.len()
        )
        .as_bytes(),
    );
    head
}

fn parse(raw: &[u8]) -> Result<RawResponse> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("no complete head in {} bytes", raw.len()))?;
    let head = String::from_utf8_lossy(raw.get(..split).unwrap_or_default()).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .context("status line")?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    Ok(RawResponse {
        status,
        headers,
        body: raw.get(split + 4..).unwrap_or_default().to_vec(),
    })
}

/// Sends `request` on its own connection and reads the answer until the server closes.
/// `answer_before_body`: send only the head first and read the answer (an oversized body
/// is refused from its declared length; sending it would race the server's close).
pub async fn send(
    address: std::net::SocketAddr,
    request: &RawRequest,
    answer_before_body: bool,
) -> Result<RawResponse> {
    let mut stream = TcpStream::connect(address).await?;
    stream.write_all(&head(request, address)).await?;
    if !answer_before_body {
        stream.write_all(&request.body).await?;
    }
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), stream.read_to_end(&mut raw))
        .await
        .context("no answer within 30 s")??;
    parse(&raw)
}

/// Waits until the ingress has no processing task left (bounded).
pub async fn settle(ingress: &Ingress) -> Result<()> {
    for _ in 0..3000 {
        if ingress.tasks_in_flight() == 0 {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    bail!("processing tasks still running after 15 s")
}

/// A recorded canonical Extended JSON document.
pub fn document(json: &serde_json::Value) -> Result<Document> {
    match Bson::try_from(json.clone()).map_err(|e| anyhow!("extended JSON: {e}"))? {
        Bson::Document(document) => Ok(document),
        other => Err(anyhow!("expected a document, got {other:?}")),
    }
}

/// Exact BSON equality: same types, same key order.
pub fn assert_same(expected: &Bson, actual: &Bson, path: &str) -> Result<()> {
    match (expected, actual) {
        (Bson::Document(a), Bson::Document(b)) => {
            let keys_a: Vec<&String> = a.keys().collect();
            let keys_b: Vec<&String> = b.keys().collect();
            if keys_a != keys_b {
                bail!("{path}: keys differ\n  expected {keys_a:?}\n  actual   {keys_b:?}");
            }
            for (key, value) in a {
                let other = b.get(key).ok_or_else(|| anyhow!("{path}.{key} missing"))?;
                assert_same(value, other, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        (Bson::Array(a), Bson::Array(b)) => {
            if a.len() != b.len() {
                bail!("{path}: {} items expected, {} found", a.len(), b.len());
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                assert_same(x, y, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        (Bson::Double(a), Bson::Double(b)) if a.to_bits() == b.to_bits() => Ok(()),
        (a, b) if std::mem::discriminant(a) == std::mem::discriminant(b) && a == b => Ok(()),
        (a, b) => bail!("{path}: expected {a:?}, found {b:?}"),
    }
}

/// The documents of `collection`, sorted by `_id`.
pub async fn documents(mongo: &MongoStore, collection: &str) -> Result<Vec<Document>> {
    use futures_util::TryStreamExt as _;
    let cursor = mongo
        .database()
        .collection::<Document>(collection)
        .find(bson::doc! {})
        .sort(bson::doc! { "_id": 1 })
        .await?;
    Ok(cursor.try_collect().await?)
}

/// `sha256=` + HMAC of a delivery with the test secret.
pub fn sign(message_id: &str, timestamp: &str, body: &[u8]) -> String {
    let secret = SecretString::new(SECRET.to_owned()).to_bytes();
    dima_core::crypto::webhook::eventsub_signature(&secret, message_id, timestamp, body)
}

/// A signed notification request.
pub fn signed(
    message_type: &str,
    message_id: &str,
    timestamp: &str,
    retry: &str,
    body: &[u8],
) -> RawRequest {
    RawRequest {
        method: "POST".to_owned(),
        path: "/eventsub".to_owned(),
        headers: vec![
            ("Content-Type".to_owned(), b"application/json".to_vec()),
            (
                "Twitch-Eventsub-Message-Id".to_owned(),
                message_id.as_bytes().to_vec(),
            ),
            (
                "Twitch-Eventsub-Message-Retry".to_owned(),
                retry.as_bytes().to_vec(),
            ),
            (
                "Twitch-Eventsub-Message-Type".to_owned(),
                message_type.as_bytes().to_vec(),
            ),
            (
                "Twitch-Eventsub-Message-Signature".to_owned(),
                sign(message_id, timestamp, body).into_bytes(),
            ),
            (
                "Twitch-Eventsub-Message-Timestamp".to_owned(),
                timestamp.as_bytes().to_vec(),
            ),
        ],
        body: body.to_vec(),
    }
}

/// Twitch's timestamp for `ms` (RFC 3339 with nanoseconds).
pub fn twitch_time(ms: i64) -> String {
    dima_text::to_iso_string(ms)
        .unwrap_or_default()
        .replace('Z', "456789Z")
}
