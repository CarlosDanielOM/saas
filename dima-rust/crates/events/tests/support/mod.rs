//! Shared harness of the live tests: the local stores from `tools/test-env`, throwaway MongoDB
//! databases (`dima_test_events_<random>`) dropped even when a test fails, Dragonfly logical
//! databases 6 and 7 with unique key prefixes, and the recorded fixtures. Without the stores a
//! test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code)]

use anyhow::{Context, Result, anyhow, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_events::value::{Object, Value};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use serde_json::Value as Json;
use std::future::Future;
use std::panic::AssertUnwindSafe;

/// The read-only production copy.
pub const REAL_DATABASE: &str = "domdimabot";

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

fn mongo_uri() -> Result<Option<String>> {
    match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(uri) => Ok(Some(uri)),
        Err(_) => missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")"),
    }
}

async fn connect(uri: String, database: String) -> Result<Option<MongoStore>> {
    let mut config = MongoConfig::new(uri);
    config.database = Some(database);
    config.server_selection_timeout = Some(std::time::Duration::from_secs(5));
    let store = MongoStore::connect(&config, None).await?;
    match store.ping().await {
        Ok(()) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// A store on the read-only production copy.
pub async fn real_store() -> Result<Option<MongoStore>> {
    let Some(uri) = mongo_uri()? else {
        return Ok(None);
    };
    let Some(store) = connect(uri, REAL_DATABASE.to_owned()).await? else {
        return Ok(None);
    };
    let names = store.client().list_database_names().await?;
    if !names.iter().any(|name| name == REAL_DATABASE) {
        return missing(&format!("the local {REAL_DATABASE} copy is not present"));
    }
    Ok(Some(store))
}

/// Runs `test` against a fresh `dima_test_events_<random>` database and drops it afterwards,
/// whatever the outcome.
pub async fn with_store<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Some(uri) = mongo_uri()? else {
        return Ok(());
    };
    let name = format!("dima_test_events_{}", ObjectId::new().to_hex());
    let Some(store) = connect(uri, name).await? else {
        return Ok(());
    };
    let database = store.database().clone();
    let outcome = AssertUnwindSafe(test(store)).catch_unwind().await;
    database.drop().await?;
    match outcome {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Ensures the indexes of `info` (as the binaries do at startup) and returns the report.
pub async fn indexes(
    store: &MongoStore,
    info: &dima_model::CollectionInfo,
) -> Result<dima_model::IndexReport> {
    let Some(policy) = dima_model::startup_policy(info) else {
        bail!("{} is not initialised at start-up", info.name);
    };
    let report =
        dima_model::ensure_indexes(store, info, policy, std::time::Duration::from_secs(30)).await;
    if report.failures().next().is_some() {
        bail!("index creation failed: {report}");
    }
    Ok(report)
}

/// The recorded fixture.
pub fn recorded() -> Result<Json> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/recorded.json");
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    Ok(serde_json::from_str(&text)?)
}

/// A recorded value (tagged JSON, see `tests/reference/record.mts`) as a [`Value`].
pub fn decode(json: &Json) -> Value {
    if let Json::Object(map) = json
        && map.len() == 1
    {
        if let Some(date) = map.get("$date") {
            return Value::Date(date.as_f64().unwrap_or(f64::NAN));
        }
        if map.contains_key("$undefined") {
            return Value::Undefined;
        }
        if let Some(Json::String(number)) = map.get("$number") {
            return Value::Number(match number.as_str() {
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => f64::NAN,
            });
        }
        if let Some(Json::String(id)) = map.get("$oid")
            && let Ok(id) = ObjectId::parse_str(id)
        {
            return Value::ObjectId(id);
        }
    }
    match json {
        Json::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), decode(v)))
                .collect::<Object>(),
        ),
        Json::Array(items) => Value::Array(items.iter().map(decode).collect()),
        other => Value::from_json(other),
    }
}

/// The object of a recorded value.
pub fn decode_object(json: &Json) -> Result<Object> {
    match decode(json) {
        Value::Object(object) => Ok(object),
        other => Err(anyhow!("expected an object, got {other:?}")),
    }
}

/// A recorded canonical Extended JSON document.
pub fn document(json: &Json) -> Result<Document> {
    match Bson::try_from(json.clone()).map_err(|e| anyhow!("extended JSON: {e}"))? {
        Bson::Document(document) => Ok(document),
        other => Err(anyhow!("expected a document, got {other:?}")),
    }
}

/// Exact BSON equality: same types (a double is not an int32), same key order, `-0` is not `0`.
/// `ignore` names top-level keys whose values are generated (compared for type only).
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

/// A unique prefix for Dragonfly keys of one test.
pub fn key_prefix(test: &str) -> String {
    format!("dima:test:events:{test}:{}:", ObjectId::new().to_hex())
}

/// A Dragonfly handle on logical database `db` (6 or 7 only).
pub async fn dragonfly(db: u8) -> Result<Option<dima_store::dragonfly::Dragonfly>> {
    if db != 6 && db != 7 {
        bail!("tests use Dragonfly databases 6 and 7 only");
    }
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("DIMA_TEST_DRAGONFLY is host:port"))?;
    let mut config = dima_store::dragonfly::DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{db}")),
        "dima-events-tests",
    );
    config.response_timeout = std::time::Duration::from_secs(2);
    match dima_store::dragonfly::Dragonfly::connect(config, Default::default()).await {
        Ok(client) => Ok(Some(client)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

/// Deletes every key under `prefix` (bounded scan).
pub async fn clean_keys(client: &dima_store::dragonfly::Dragonfly, prefix: &str) -> Result<()> {
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

/// A TCP proxy in front of a store that can go silent, or lose one reply.
///
/// - [`Proxy::blackhole`]: it accepts and holds connections and forwards nothing in either
///   direction, as a hung server or a network partition would.
/// - [`Proxy::lose_reply_to`]: the next MongoDB request that contains every given byte string
///   reaches the server (so a write commits), and everything the server sends back on that
///   connection is discarded: the caller sees its deadline pass on a write that was applied. The
///   proxy reads requests whole (the wire protocol's 4-byte little-endian length), so a request
///   is matched as one message. Other connections, and connections opened afterwards, work.
///
/// Dropping it stops it.
pub struct Proxy {
    /// `127.0.0.1:<port>`.
    pub address: String,
    silent: tokio::sync::watch::Sender<bool>,
    trap: std::sync::Arc<Trap>,
    task: tokio::task::JoinHandle<()>,
}

/// The armed "lose the reply" request.
#[derive(Default)]
struct Trap {
    needles: std::sync::Mutex<Option<Vec<Vec<u8>>>>,
    fired: std::sync::atomic::AtomicUsize,
}

impl Trap {
    /// Whether `message` is the armed request (disarming the trap).
    fn take(&self, message: &[u8]) -> bool {
        let Ok(mut armed) = self.needles.lock() else {
            return false;
        };
        let matches = armed.as_ref().is_some_and(|needles| {
            needles.iter().all(|needle| {
                message
                    .windows(needle.len())
                    .any(|w| w == needle.as_slice())
            })
        });
        if matches {
            *armed = None;
            self.fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        matches
    }
}

async fn relay(
    inbound: tokio::net::TcpStream,
    upstream: String,
    mut watch: tokio::sync::watch::Receiver<bool>,
    trap: std::sync::Arc<Trap>,
    framed: bool,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if *watch.borrow() {
        // Hold the connection without answering.
        let _ = watch.wait_for(|silent| !*silent).await;
        return;
    }
    let Ok(outbound) = tokio::net::TcpStream::connect(upstream).await else {
        return;
    };
    let (mut client_read, mut client_write) = inbound.into_split();
    let (mut server_read, mut server_write) = outbound.into_split();
    let dropping = std::sync::atomic::AtomicBool::new(false);
    let requests = async {
        if !framed {
            let _ = tokio::io::copy(&mut client_read, &mut server_write).await;
            return;
        }
        loop {
            let mut header = [0_u8; 4];
            if client_read.read_exact(&mut header).await.is_err() {
                return;
            }
            let length = u32::from_le_bytes(header) as usize;
            if !(4..=64 * 1024 * 1024).contains(&length) {
                return;
            }
            let mut message = vec![0_u8; length];
            message[..4].copy_from_slice(&header);
            if client_read.read_exact(&mut message[4..]).await.is_err() {
                return;
            }
            if trap.take(&message) {
                dropping.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if server_write.write_all(&message).await.is_err() {
                return;
            }
        }
    };
    let replies = async {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = match server_read.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            if dropping.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }
            if client_write.write_all(&buffer[..read]).await.is_err() {
                return;
            }
        }
    };
    let went_silent = tokio::select! {
        () = requests => false,
        () = replies => false,
        silenced = async { watch.wait_for(|silent| *silent).await.is_ok() } => silenced,
    };
    if went_silent {
        // Go silent: keep both sockets open, forward nothing.
        let _ = watch.wait_for(|silent| !*silent).await;
    }
}

impl Proxy {
    /// A proxy to `upstream` (`host:port`) of any protocol (bytes are copied as they come; the
    /// reply trap is not available).
    pub async fn start(upstream: String) -> Result<Self> {
        Self::start_with(upstream, false).await
    }

    /// A proxy to a MongoDB server: requests are read whole, so [`Proxy::lose_reply_to`] works.
    pub async fn start_mongo(upstream: String) -> Result<Self> {
        Self::start_with(upstream, true).await
    }

    async fn start_with(upstream: String, framed: bool) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?.to_string();
        let (silent, watch) = tokio::sync::watch::channel(false);
        let trap = std::sync::Arc::new(Trap::default());
        let connection_trap = trap.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((inbound, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(relay(
                    inbound,
                    upstream.clone(),
                    watch.clone(),
                    connection_trap.clone(),
                    framed,
                ));
            }
        });
        Ok(Self {
            address,
            silent,
            trap,
            task,
        })
    }

    /// Stops forwarding (connections stay open and hang).
    pub fn blackhole(&self) {
        let _ = self.silent.send(true);
    }

    /// Forwards again (connections that went silent are closed; new ones work).
    pub fn restore(&self) {
        let _ = self.silent.send(false);
    }

    /// Arms the trap: the next request containing every one of `needles` is delivered and its
    /// reply (with everything after it on that connection) is lost.
    pub fn lose_reply_to(&self, needles: &[&[u8]]) {
        if let Ok(mut armed) = self.trap.needles.lock() {
            *armed = Some(needles.iter().map(|n| n.to_vec()).collect());
        }
    }

    /// How many replies the trap has lost so far.
    pub fn replies_lost(&self) -> usize {
        self.trap.fired.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Disarms the trap (when the request it was set for never came).
    pub fn disarm(&self) {
        if let Ok(mut armed) = self.trap.needles.lock() {
            *armed = None;
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A store on `database` reached through `proxy` (the test URI with its host replaced).
pub async fn store_through(proxy: &Proxy, database: &str) -> Result<Option<MongoStore>> {
    let Some(uri) = mongo_uri()? else {
        return Ok(None);
    };
    let (scheme, rest) = uri.split_once("://").ok_or_else(|| anyhow!("URI"))?;
    let (credentials, after) = match rest.split_once('@') {
        Some((credentials, after)) => (format!("{credentials}@"), after),
        None => (String::new(), rest),
    };
    let tail = after
        .find(['/', '?'])
        .map_or("", |at| after.get(at..).unwrap_or(""));
    let mut config = MongoConfig::new(format!("{scheme}://{credentials}{}{tail}", proxy.address));
    config.database = Some(database.to_owned());
    config.server_selection_timeout = Some(std::time::Duration::from_secs(2));
    config.connect_timeout = Some(std::time::Duration::from_secs(2));
    Ok(Some(MongoStore::connect(&config, None).await?))
}

/// The upstream `host:port` of the test MongoDB.
pub fn mongo_address() -> Result<Option<String>> {
    let Some(uri) = mongo_uri()? else {
        return Ok(None);
    };
    let rest = uri.split_once("://").map_or(uri.as_str(), |(_, r)| r);
    let after = rest.split_once('@').map_or(rest, |(_, a)| a);
    let end = after.find(['/', '?']).unwrap_or(after.len());
    Ok(after.get(..end).map(str::to_owned))
}
