//! The harness of the store-backed tests: the local MongoDB and Dragonfly from `tools/test-env`,
//! a throwaway `dima_test_actions_<random>` database dropped even when a test fails, Dragonfly
//! logical database 11 with a unique key prefix removed afterwards, a Twitch mock on
//! `dima_http::testing::MockServer` (the app token and `POST /helix/chat/messages`), and the
//! runtime the engine's stack contract needs. Without the stores a test skips with a notice,
//! unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anyhow::{Context as _, Result, bail};
use bson::{Document, doc, oid::ObjectId};
use dima_actions::delivery::ChatDelivery;
use dima_actions::host::{HostDeps, StorageConfig, channel, media, moderation};
use dima_actions::timers::TimerQueue;
use dima_commands::runtime::KeyPrefix;
use dima_commands::runtime::lookup::{CommandCache, CommandCacheConfig};
use dima_core::crypto::CredentialCipher;
use dima_core::{Clock, ManualClock, Random, SecretString, SeededRandom, Shutdown, SystemRandom};
use dima_engine::eval::Engine;
use dima_engine::registry::Registry;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use dima_twitch::events::RecordingEvents;
use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CLIENT_ID: &str = "test-client-id";
pub const CLIENT_SECRET: &str = "test-client-secret-value";
pub const TEST_SECRET_KEY: &str = "dima-actions-test-key";
/// The logical database the tests write (charter: 11, and 8 as a second).
pub const DATABASE: u8 = 11;
/// 2026-11-12T09:30:00.123Z.
pub const NOW_MS: i64 = 1_794_475_800_123;
/// The stack of every thread a test evaluates on.
pub const TEST_STACK: usize = 4 * 1024 * 1024;

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|value| value == "1")
}

fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

pub fn random_suffix() -> String {
    let mut bytes = [0_u8; 6];
    let _ = SystemRandom.fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Runs `future` on a multi-threaded runtime whose threads (and the one that waits) are
/// registered with the engine's stack contract.
pub fn run<F>(future: F) -> F::Output
where
    F: Future + Send,
    F::Output: Send,
{
    dima_engine::stack::run_on_thread(TEST_STACK, || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_stack_size(TEST_STACK)
            .on_thread_start(|| dima_engine::stack::register_thread(TEST_STACK))
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    })
    .expect("a test thread")
}

pub async fn connect_dragonfly(database: u8) -> Result<Option<Dragonfly>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let (host, port) = address
        .rsplit_once(':')
        .context("DIMA_TEST_DRAGONFLY is host:port")?;
    let config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{database}")),
        "dima-actions-tests",
    );
    match Dragonfly::connect(config, Hooks::default()).await {
        Ok(dragonfly) => Ok(Some(dragonfly)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

pub async fn connect_mongo(database: &str) -> Result<Option<MongoStore>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    match MongoStore::connect(&config, None).await {
        Ok(store) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// Deletes every key under `prefix`.
pub async fn clean_prefix(dragonfly: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(500));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            let key = String::from_utf8(key)?;
            dragonfly.del(&[&key]).await?;
        }
    }
    Ok(())
}

/// The stores of one test.
#[derive(Clone)]
pub struct Stores {
    pub mongo: MongoStore,
    pub dragonfly: Dragonfly,
    pub prefix: String,
    pub database: String,
}

impl Stores {
    /// `prefix + key`.
    pub fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

/// Runs `test` with fresh stores, then drops the database and the keys, whatever the outcome.
pub async fn with_stores<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(Stores) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let suffix = random_suffix();
    let database = format!("dima_test_actions_{suffix}");
    let Some(mongo) = connect_mongo(&database).await? else {
        return Ok(());
    };
    let Some(dragonfly) = connect_dragonfly(DATABASE).await? else {
        return Ok(());
    };
    let prefix = format!("dta{suffix}:");
    let stores = Stores {
        mongo: mongo.clone(),
        dragonfly: dragonfly.clone(),
        prefix: prefix.clone(),
        database,
    };
    let outcome = AssertUnwindSafe(test(stores)).catch_unwind().await;
    let dropped = mongo.database().drop().await;
    let cleaned = clean_prefix(&dragonfly, &prefix).await;
    match outcome {
        Ok(result) => {
            dropped.context("dropping the test database")?;
            cleaned.context("cleaning the test keys")?;
            result
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// One chat post the mock received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    pub channel: String,
    pub text: String,
    pub reply_to: Option<String>,
}

/// How the mock answers `POST /helix/chat/messages`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    /// `200 {data: [{message_id: "msg-<n>", is_sent: true}]}`.
    Sent,
    /// `200 {data: [{message_id, is_sent: false}]}`.
    Held,
    /// `403 {error: "Forbidden", message: "denied"}`.
    Denied,
}

/// The Twitch mock: an app token, and chat posts recorded in order.
#[derive(Clone)]
pub struct TwitchMock {
    pub server: Arc<MockServer>,
    pub reply: Arc<Mutex<Reply>>,
}

impl TwitchMock {
    pub async fn start() -> Result<Self> {
        let server = MockServer::start().await?;
        let reply = Arc::new(Mutex::new(Reply::Sent));
        let answer = Arc::clone(&reply);
        let posted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        server.fallback(move |request: &RecordedRequest| {
            if request.path() == "/oauth2/token" {
                return MockResponse::json(
                    200,
                    r#"{"access_token":"app-token-1","expires_in":5011271,"token_type":"bearer"}"#,
                );
            }
            if request.path() == "/helix/chat/messages" && request.method == "POST" {
                let n = posted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return match *answer.lock().expect("reply") {
                    Reply::Sent => MockResponse::json(
                        200,
                        &json!({"data": [{"message_id": format!("msg-{n}"), "is_sent": true}]})
                            .to_string(),
                    ),
                    Reply::Held => MockResponse::json(
                        200,
                        &json!({"data": [{"message_id": format!("msg-{n}"), "is_sent": false, "drop_reason": {"code": "automod", "message": "held"}}]})
                            .to_string(),
                    ),
                    Reply::Denied => MockResponse::json(
                        403,
                        r#"{"error":"Forbidden","status":403,"message":"denied"}"#,
                    ),
                };
            }
            MockResponse::json(404, r#"{"error":"Not Found","status":404,"message":"unexpected"}"#)
        });
        Ok(Self {
            server: Arc::new(server),
            reply,
        })
    }

    pub fn set_reply(&self, reply: Reply) {
        *self.reply.lock().expect("reply") = reply;
    }

    /// Every chat post so far, in order.
    pub fn posts(&self) -> Vec<Post> {
        self.server
            .requests()
            .into_iter()
            .filter(|request| request.path() == "/helix/chat/messages")
            .map(|request| {
                let body: Value = serde_json::from_slice(&request.body).expect("JSON body");
                Post {
                    channel: body["broadcaster_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    text: body["message"].as_str().unwrap_or_default().to_owned(),
                    reply_to: body["reply_parent_message_id"].as_str().map(str::to_owned),
                }
            })
            .collect()
    }

    /// Requests other than the token and chat posts (none is expected).
    pub fn unexpected(&self) -> Vec<String> {
        self.server
            .requests()
            .into_iter()
            .filter(|request| !matches!(request.path(), "/oauth2/token" | "/helix/chat/messages"))
            .map(|request| format!("{} {}", request.method, request.target))
            .collect()
    }
}

/// One process: its own handles (own in-memory state) on the shared stores and mock.
pub struct Process {
    pub deps: Arc<HostDeps>,
    pub delivery: Arc<ChatDelivery>,
    pub clock: ManualClock,
    pub shutdown: Shutdown,
}

pub fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_SECRET_KEY).expect("test key")
}

/// A process whose command language draws from `random` (the infrastructure draws from the
/// system's generator, so it does not move the command language's sequence).
pub fn process(stores: &Stores, twitch: &TwitchMock, random: Arc<dyn Random>) -> Result<Process> {
    process_with(
        stores,
        twitch,
        random,
        Engine::new(Registry::standard(), Default::default()),
    )
}

pub fn process_with(
    stores: &Stores,
    twitch: &TwitchMock,
    random: Arc<dyn Random>,
    engine: Engine,
) -> Result<Process> {
    let clock = ManualClock::new(NOW_MS);
    let clock_dyn: Arc<dyn Clock> = Arc::new(clock.clone());
    let shutdown = Shutdown::new();
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = KeySpace::prefixed(stores.prefix.clone());
    let helix = twitch
        .server
        .provider(dima_twitch::helix_provider(CLIENT_ID))?;
    let oauth = twitch.server.provider(dima_twitch::oauth_provider())?;
    let http = HttpClient::builder()
        .shutdown(shutdown.clone())
        .clock(Arc::clone(&clock_dyn))
        .build()?;
    let exchange_http =
        dima_twitch::exchange_client(HttpClient::builder().clock(Arc::clone(&clock_dyn)))?;
    let twitch_client = Twitch::new(
        config,
        TwitchDeps {
            http,
            exchange_http,
            helix,
            oauth,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock: Arc::clone(&clock_dyn),
            random: Arc::new(SystemRandom),
            events: Arc::new(RecordingEvents::default()),
            shutdown: shutdown.clone(),
        },
    );
    let keys = KeyPrefix::new(stores.prefix.clone());
    let commands = CommandCache::new(
        dima_commands::runtime::Stores {
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            keys: keys.clone(),
        },
        Arc::clone(&clock_dyn),
        Arc::new(SystemRandom),
        CommandCacheConfig::default(),
    );
    let deps = Arc::new(HostDeps {
        mongo: stores.mongo.clone(),
        dragonfly: stores.dragonfly.clone(),
        keys,
        twitch: twitch_client,
        commands,
        clock: clock_dyn,
        random,
        telemetry: None,
        storage: StorageConfig::default(),
        timers: TimerQueue::new(),
        moderation: moderation::Deps::default(),
        channel: channel::Deps::default(),
        media: media::Deps {
            backend: Arc::new(NoBackend),
            clips: Arc::new(NoBackend),
        },
        ai: dima_actions::host::ai::Deps::default(),
    });
    let delivery = ChatDelivery::new(Arc::clone(&deps), Arc::new(engine));
    Ok(Process {
        deps,
        delivery,
        clock,
        shutdown,
    })
}

/// A seeded generator for the command language.
pub fn seeded(seed: u64) -> Arc<dyn Random> {
    Arc::new(SeededRandom::new(seed))
}

/// The media group's request surface, never called (the group is not ported).
pub struct NoBackend;

impl dima_twitch::functions::chats::speech::BackendApi for NoBackend {
    fn request(
        &self,
        _request: dima_twitch::functions::chats::speech::BackendRequest,
    ) -> dima_http::guard::BoxFuture<
        '_,
        Result<
            dima_twitch::functions::chats::speech::BackendReply,
            dima_twitch::functions::chats::speech::BackendError,
        >,
    > {
        Box::pin(async { Err(dima_twitch::functions::chats::speech::BackendError) })
    }
}

impl dima_twitch::functions::clips::ClipPublisher for NoBackend {
    fn publish<'a>(
        &'a self,
        _channel: &'a str,
        _data: &'a dima_twitch::functions::clips::ClipRequestData,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), dima_twitch::functions::clips::ClipPublishError>>
    {
        Box::pin(async { Err(dima_twitch::functions::clips::ClipPublishError) })
    }
}

/// A user with one Twitch account, as sign-up stores it, on `plan`.
pub fn user_document(id: &str, name: &str, plan: &str) -> Document {
    doc! {
        "_id": ObjectId::new(),
        "name": name,
        "email": format!("{name}@example.invalid"),
        "accounts": [{
            "_id": ObjectId::new(),
            "type": "twitch",
            "id": id,
            "name": name,
            "email": format!("{name}@example.invalid"),
            "actived": true,
            "chat_enabled": true,
            "has_permissions": true,
            "up_to_date_permissions": true,
        }],
        "plan_tier": plan,
        "plan_tier_until": bson::Bson::Null,
        "polar_sh_customer_id": bson::Bson::Null,
        "token_balance": 0,
        "created_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
        "updated_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
        "__v": 0,
    }
}

pub async fn insert_user(stores: &Stores, id: &str, name: &str, plan: &str) -> Result<()> {
    stores
        .mongo
        .documents("users")
        .insert_one(user_document(id, name, plan))
        .await?;
    Ok(())
}

/// A command as the dashboard stores it (enough fields for the lookup and the run).
pub fn command_document(channel: &str, cmd: &str, message: &str) -> Document {
    doc! {
        "_id": ObjectId::new(),
        "name": cmd,
        "cmd": cmd,
        "func": "custom",
        "message": message,
        "type": "command",
        "platform": "twitch",
        "reserved": false,
        "cooldown": 0,
        "count": 0,
        "userLevelName": "everyone",
        "userLevel": 0,
        "enabled": true,
        "channel": "streamer",
        "channelID": channel,
        "__v": 0,
    }
}

pub async fn insert_command(stores: &Stores, document: Document) -> Result<()> {
    stores
        .mongo
        .documents("commands")
        .insert_one(document)
        .await?;
    Ok(())
}

/// Waits until `check` holds (every 10 ms, at most 30 s, so a busy machine cannot fail it).
pub async fn eventually<F, Fut>(what: &str, mut check: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if check().await? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("timed out waiting until {what}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// `dima_core::SeededRandom` that a test reseeds between cases (the recorders reseed the
/// reference's sequence the same way).
#[derive(Debug)]
pub struct Reseedable(Mutex<SeededRandom>);

impl Reseedable {
    pub fn new(seed: u64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(SeededRandom::new(seed))))
    }

    pub fn reseed(&self, seed: u64) {
        *self.0.lock().expect("random") = SeededRandom::new(seed);
    }
}

impl Random for Reseedable {
    fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
        self.0.lock().expect("random").fill(buf)
    }
}

/// Every key under `prefix` matching `pattern` (the part after the prefix), unprefixed, sorted.
pub async fn keys_matching(stores: &Stores, pattern: &str) -> Result<Vec<String>> {
    let mut found = Vec::new();
    let mut scan = stores
        .dragonfly
        .scan(&format!("{}{pattern}", stores.prefix), Some(500));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            let key = String::from_utf8(key)?;
            if let Some(bare) = key.strip_prefix(&stores.prefix) {
                found.push(bare.to_owned());
            }
        }
    }
    found.sort();
    found.dedup();
    Ok(found)
}

/// JSON with object keys sorted, recursively (the recorders' `sorted`).
pub fn sorted(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| dima_text::cmp_utf16(&a.0, &b.0));
            Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        other => other,
    }
}

/// `sha256(JSON.stringify(value))`.
pub fn hash(value: &Value) -> String {
    dima_core::crypto::sha256(dima_text::to_js_json(value)).hex()
}
