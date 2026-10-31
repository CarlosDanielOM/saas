#![cfg(feature = "twitch-headers")]
//! Source replay and concrete native fixtures for the Twitch header helpers.
//!
//! Ignored unless an owner-written source artifact, disposable keyword-mongo and
//! keyword-redis fixtures, and the fixed resource owner are provided. The
//! credentials are real: `MongoCredentialStore`, `RedisTokenCache`,
//! `CredentialCipher`, `MongoStreamerStore`, `RedisStreamerCache`,
//! `NativeCredentials`, `TwitchTokenStorage`, `TwitchStreamers` and a real
//! `TwitchOAuthClient` pointed at a private loopback recorder. No application
//! client, environment file, production address, real Twitch credential or
//! external notification is used.
//!
//! The corpus comes from `tests/fixtures/twitch_headers_reference.cjs`, which
//! evaluates the real `header.ts` and `notifications.ts` bodies and writes its
//! JSON outside the source tree. Run it with `--write DIR` once and `--check DIR`
//! afterwards; this test consumes the same artifact.

#[path = "../src/utils/test_http.rs"]
mod test_http;

use dima_rust::utils::{
    credential_crypto::CredentialCipher,
    logger::{
        CacheRecord, CacheSink, ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture,
        SinkHandles, SystemClock, UuidSource,
    },
    notifications::{DeveloperConsole, DeveloperNotifier, DeveloperSeverity},
    twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchCredentials, TwitchEndpoints, TwitchOAuthClient},
    twitch_headers::{ClientIdSource, TwitchHeaderError, TwitchHeaderState, TwitchHeaders},
    twitch_streamers::{
        DirectoryConfig, MongoStreamerStore, NativeCredentials, RedisStreamerCache, TwitchStreamers,
    },
    twitch_tokens::{
        MongoCredentialStore, OAuthExchange, RedisTokenCache, SystemTokenClock, TokenClock,
        TwitchTokenStorage,
    },
};
use futures_util::{FutureExt, future::join_all};
use mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use redis::aio::ConnectionManager;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    panic::AssertUnwindSafe,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use test_http::{CannedResponse, RecordedRequest, Recorder};

/// The artifact is hashed by `sha256sum` outside Node before the replay; this
/// constant is the frozen oracle. A stale, missing, empty or substituted file
/// fails before any case runs.
const REFERENCE_SHA256: &str = "cc6bfafa6f047314f11a47db10ac080a5e08fbbb1ff2322086e57dd806262880";
const REFERENCE_CASES: [&str; 9] = [
    "app-success",
    "app-missing",
    "bot-success",
    "bot-missing",
    "streamer-success",
    "streamer-missing",
    "streamer-no-permissions",
    "streamer-empty-token",
    "moderator-uses-bot",
];
const MONGO_FIXTURE_HOST: &str = "keyword-mongo";
const REDIS_FIXTURE_HOST: &str = "keyword-redis";
const MONGO_FIXTURE_PORT: u16 = 27017;
const REDIS_FIXTURE_PORT: u16 = 6379;
const FIXTURE_OWNER: &str = "dimabot-migration";
const MONGO_OWNER_COLLECTION: &str = "_twitch_headers_owner";

#[derive(Default)]
struct Records {
    cache: Mutex<Vec<String>>,
    console: Mutex<Vec<String>>,
}
impl CacheSink for Records {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.cache.lock().unwrap().push(record.json.to_string());
            Ok(())
        })
    }
}
impl ConsoleSink for Records {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.console.lock().unwrap().push(record.json.to_string());
            Ok(())
        })
    }
}
impl Records {
    fn entries(&self) -> Vec<Value> {
        self.cache
            .lock()
            .unwrap()
            .iter()
            .map(|line| serde_json::from_str(line).expect("cache record JSON"))
            .collect()
    }
    fn header_debug(&self) -> Vec<Value> {
        self.entries()
            .into_iter()
            .filter(|entry| {
                entry["data"]["function"].as_str() == Some("getTwitchStreamerHeaderById")
            })
            .map(|entry| entry["data"].clone())
            .collect()
    }
}

fn logger(records: &Arc<Records>) -> Arc<Logger> {
    Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(records.clone()),
                console: Some(records.clone()),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    )
}

#[derive(Default)]
struct CaptureConsole(Mutex<Vec<String>>);
impl DeveloperConsole for CaptureConsole {
    fn write_error(&self, line: &str) {
        self.0.lock().unwrap().push(line.to_owned());
    }
}
impl CaptureConsole {
    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

fn cipher() -> CredentialCipher {
    CredentialCipher::new("twitch-headers-fixture").unwrap()
}

fn envelope(secret: &str) -> Bson {
    let value = cipher().encrypt(secret).unwrap();
    Bson::Document(doc! {
        "iv": value.iv.map(Bson::String).unwrap_or(Bson::Null),
        "content": value.content.map(Bson::String).unwrap_or(Bson::Null)
    })
}

fn user(
    id: &str,
    access: Option<&str>,
    refresh: Option<&str>,
    expiry: Option<f64>,
    permissions: bool,
) -> Document {
    let account = doc! {
        "type": "twitch",
        "id": id,
        "name": format!("name-{id}"),
        "email": format!("{id}@fixture.invalid"),
        "access_token": access.map(envelope).unwrap_or(Bson::Null),
        "refresh_token": refresh.map(envelope).unwrap_or(Bson::Null),
        "access_token_expires_at": expiry.map(Bson::Double).unwrap_or(Bson::Null),
        "has_permissions": permissions,
        "up_to_date_permissions": permissions
    };
    doc! { "accounts": [account] }
}

fn now_seconds() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs().min(i64::MAX as u64) as i64,
        Err(_) => 0,
    }
}
fn future_expiry() -> f64 {
    (now_seconds() + 3600) as f64
}
fn past_expiry() -> f64 {
    (now_seconds() - 60) as f64
}

fn form_field(body: &[u8], name: &str) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    text.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| value.replace('+', " "))
    })
}

struct OAuthFixture {
    base_url: String,
    /// Keeps the loopback listener alive for the whole test. The recorder owns a
    /// channel receiver, so the mutex keeps the fixture `Sync` for `Arc`.
    _recorder: Mutex<Recorder>,
    app_client_ids: Arc<Mutex<Vec<String>>>,
    refreshes: Arc<Mutex<Vec<String>>>,
}
impl OAuthFixture {
    fn start() -> Self {
        let app_client_ids = Arc::new(Mutex::new(Vec::new()));
        let refreshes = Arc::new(Mutex::new(Vec::new()));
        let app = app_client_ids.clone();
        let refresh = refreshes.clone();
        let recorder = Recorder::start(move |request: &RecordedRequest| {
            let grant = form_field(&request.body, "grant_type").unwrap_or_default();
            if grant == "client_credentials" {
                let client_id = form_field(&request.body, "client_id").unwrap_or_default();
                app.lock().unwrap().push(client_id.clone());
                if client_id == "denied-client" {
                    return CannedResponse::json(
                        400,
                        r#"{"status":400,"message":"invalid client"}"#,
                    );
                }
                return CannedResponse::json(
                    200,
                    r#"{"access_token":"app-token","expires_in":3600,"token_type":"bearer"}"#,
                );
            }
            let token = form_field(&request.body, "refresh_token").unwrap_or_default();
            refresh.lock().unwrap().push(token.clone());
            if token.starts_with("denied") {
                return CannedResponse::json(
                    400,
                    r#"{"error":"invalid_grant","message":"Invalid refresh token"}"#,
                );
            }
            let body = json!({
                "access_token": format!("refreshed-{token}"),
                "refresh_token": format!("rotated-{token}"),
                "expires_in": 3600
            })
            .to_string();
            CannedResponse::json(200, &body)
        });
        Self {
            base_url: recorder.base_url.clone(),
            _recorder: Mutex::new(recorder),
            app_client_ids,
            refreshes,
        }
    }
    fn exchange(&self, client_id: &str) -> Arc<dyn OAuthExchange> {
        let credentials = TwitchCredentials::new(client_id, "fixture-secret").unwrap();
        let endpoints =
            TwitchEndpoints::new(&self.base_url, &self.base_url).expect("loopback endpoints");
        let client =
            TwitchOAuthClient::new(credentials, endpoints, Some(Duration::from_secs(10))).unwrap();
        Arc::new(client)
    }
    fn app_requests(&self) -> Vec<String> {
        self.app_client_ids.lock().unwrap().clone()
    }
    fn refresh_tokens(&self) -> Vec<String> {
        self.refreshes.lock().unwrap().clone()
    }
}

fn clock() -> Arc<dyn TokenClock> {
    Arc::new(SystemTokenClock::default())
}
fn storage(
    database: &Database,
    connection: &ConnectionManager,
    namespace: &str,
    exchange: &Arc<dyn OAuthExchange>,
) -> TwitchTokenStorage {
    TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(database)),
        Arc::new(RedisTokenCache::with_namespace(
            connection.clone(),
            namespace,
        )),
        exchange.clone(),
        clock(),
        cipher(),
    )
}
fn directory(
    database: &Database,
    connection: &ConnectionManager,
    namespace: &str,
    exchange: &Arc<dyn OAuthExchange>,
    logger: &Arc<Logger>,
) -> TwitchStreamers {
    TwitchStreamers::new(
        Arc::new(MongoStreamerStore::new(database)),
        Arc::new(RedisStreamerCache::with_namespace(
            connection.clone(),
            namespace,
        )),
        Arc::new(
            NativeCredentials::new(storage(database, connection, namespace, exchange)).unwrap(),
        ),
        clock(),
        DirectoryConfig::default(),
    )
    .unwrap()
    .with_logger(logger.clone())
    .unwrap()
}

fn fixture_url(name: &str, host: &str, port: u16) -> String {
    let raw = std::env::var(name).expect("explicit disposable fixture URL required");
    let url = reqwest::Url::parse(&raw).expect("valid fixture URL");
    assert_eq!(
        url.host_str(),
        Some(host),
        "fixture must use the private task alias, never a production host"
    );
    assert_eq!(url.port(), Some(port), "fixture port is fixed and private");
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "fixture credentials forbidden"
    );
    raw
}

async fn hash(connection: &mut ConnectionManager, key: &str) -> BTreeMap<String, String> {
    redis::cmd("HGETALL")
        .arg(key)
        .query_async(connection)
        .await
        .unwrap()
}
async fn value(connection: &mut ConnectionManager, key: &str) -> Option<String> {
    redis::cmd("GET")
        .arg(key)
        .query_async(connection)
        .await
        .unwrap()
}
async fn scan_owned(connection: &mut ConnectionManager, namespace: &str) -> Vec<String> {
    let mut cursor = 0u64;
    let mut keys = BTreeSet::new();
    for _ in 0..4096 {
        let (next, page): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{namespace}*"))
            .arg("COUNT")
            .arg(128)
            .query_async(connection)
            .await
            .unwrap();
        for key in page {
            assert!(
                key.starts_with(namespace),
                "scan must stay inside the owned prefix"
            );
            keys.insert(key);
        }
        assert!(keys.len() <= 8192, "fixture cleanup must remain bounded");
        cursor = next;
        if cursor == 0 {
            return keys.into_iter().collect();
        }
    }
    panic!("fixture SCAN exceeded its page bound")
}
async fn bounded<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .unwrap_or_else(|_| panic!("{what} timed out"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn source_hash(path: &str) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    sha256_hex(&bytes)
}

#[derive(Default)]
struct SwitchableClientId(Mutex<String>);
impl SwitchableClientId {
    fn new(value: &str) -> Self {
        Self(Mutex::new(value.to_owned()))
    }
    fn set(&self, value: &str) {
        *self.0.lock().unwrap() = value.to_owned();
    }
}
impl ClientIdSource for SwitchableClientId {
    fn client_id(&self) -> Option<String> {
        Some(self.0.lock().unwrap().clone())
    }
}

async fn assert_mongo_owned(database: &Database, token: &str) {
    assert_eq!(database.name(), format!("twitch_headers_fixture_{token}"));
    let marker = database
        .collection::<Document>(MONGO_OWNER_COLLECTION)
        .find_one(doc! {"_id": "owner"})
        .await
        .unwrap()
        .expect("owned fixture database marker");
    assert_eq!(marker.get_str("owner").unwrap(), FIXTURE_OWNER);
    assert_eq!(marker.get_str("token").unwrap(), token);
}

fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
    value
        .get(name)
        .unwrap_or_else(|| panic!("missing fixture field {name}"))
}
fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    field(value, name)
        .as_str()
        .unwrap_or_else(|| panic!("{name} must be a string"))
}
fn json(value: &impl Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}
fn assert_wire(actual: &impl Serialize, expected: &Value) {
    assert_eq!(&json(actual), expected);
}
fn notification_line<'a>(lines: &'a Value, severity: &str) -> &'a str {
    lines[severity][0].as_str().unwrap()
}
fn case<'a>(reference: &'a Value, id: &str) -> &'a Value {
    field(reference, "cases")
        .as_array()
        .unwrap()
        .iter()
        .find(|case| text(case, "id") == id)
        .unwrap_or_else(|| panic!("missing source case {id}"))
}

/// The source replay is one large async state machine; it runs on a dedicated
/// thread with an explicit stack so it never depends on the ambient worker
/// stack size. Cold app acquisition and concurrent streamer helpers below run
/// in spawned tasks on the runtime's normal worker stacks.
const REPLAY_STACK_BYTES: usize = 32 * 1024 * 1024;

#[test]
#[ignore = "requires an owner-written source artifact and disposable keyword-mongo/keyword-redis fixtures"]
fn source_replay_with_real_credentials_and_directory() {
    std::thread::Builder::new()
        .name("twitch-headers-replay".to_owned())
        .stack_size(REPLAY_STACK_BYTES)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("fixture runtime")
                .block_on(replay_with_real_credentials_and_directory())
        })
        .expect("fixture thread")
        .join()
        .expect("fixture thread must not panic");
}

async fn replay_with_real_credentials_and_directory() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration"),
        "explicit task-owned resource guard"
    );
    let mongo_uri = fixture_url(
        "DIMA_TEST_MONGO_URI",
        MONGO_FIXTURE_HOST,
        MONGO_FIXTURE_PORT,
    );
    let redis_url = fixture_url(
        "DIMA_TEST_REDIS_URL",
        REDIS_FIXTURE_HOST,
        REDIS_FIXTURE_PORT,
    );
    let base = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("unique fixture namespace");
    let suffix = base
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("namespace shape");
    assert!(
        (8..=32).contains(&suffix.len()) && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    );
    let namespace = format!("{base}twitch-headers:");
    let artifact_dir =
        std::env::var("DIMA_TWITCH_HEADERS_FIXTURE_DIR").expect("source artifact directory");
    let artifact_path = Path::new(&artifact_dir).join("twitch_headers_reference.json");
    let bytes = std::fs::read(&artifact_path)
        .unwrap_or_else(|error| panic!("source artifact {}: {error}", artifact_path.display()));
    assert!(!bytes.is_empty(), "source artifact must not be empty");
    // Independent oracle: the harness hashed this exact file with `sha256sum`
    // outside Node and supplied it. Recompute here so a missing, stale, empty or
    // substituted artifact fails instead of replaying itself.
    let reference_sha = sha256_hex(&bytes);
    assert_eq!(
        reference_sha, REFERENCE_SHA256,
        "source artifact is stale or tampered"
    );
    assert_eq!(
        std::env::var("DIMA_TWITCH_HEADERS_REFERENCE_SHA256")
            .expect("outer sha256 oracle must be supplied by the task script"),
        REFERENCE_SHA256,
        "outer oracle and artifact disagree"
    );
    let reference: Value = serde_json::from_slice(&bytes).expect("valid source artifact");

    // The artifact must describe this frozen source tree, not a synthetic copy.
    let hashes = field(field(&reference, "source"), "sha256");
    assert_eq!(source_hash("src/utils/header.ts"), text(hashes, "header"));
    assert_eq!(
        source_hash("src/utils/notifications.ts"),
        text(hashes, "notifications")
    );
    assert_eq!(text(field(&reference, "runtime"), "node"), "v24.22.1");
    assert_eq!(
        text(field(&reference, "runtime"), "v8"),
        "13.6.233.17-node.58"
    );
    assert_eq!(text(field(&reference, "runtime"), "typescript"), "5.9.3");
    assert_eq!(text(&reference, "botAccountId"), TWITCH_BOT_ACCOUNT_ID);
    assert_eq!(TWITCH_BOT_ACCOUNT_ID, "698614112");
    let cases = field(&reference, "cases").as_array().expect("source cases");
    assert_eq!(
        cases.len(),
        REFERENCE_CASES.len(),
        "exactly every source case"
    );
    let ids: BTreeSet<&str> = cases.iter().map(|case| text(case, "id")).collect();
    assert_eq!(ids, REFERENCE_CASES.into_iter().collect::<BTreeSet<_>>());
    for source_case in cases {
        let result = source_case
            .get("result")
            .and_then(Value::as_object)
            .expect("case result");
        assert!(!result.is_empty(), "empty case result is not replayable");
    }
    let notification_lines = field(&reference, "notificationLines");
    for severity in ["error", "warning", "info"] {
        assert!(
            !field(notification_lines, severity)
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    let mongo = mongodb::Client::with_uri_str(&mongo_uri).await.unwrap();
    let database = mongo.database(&format!("twitch_headers_fixture_{suffix}"));
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fresh owned fixture database required"
    );
    database
        .create_collection(MONGO_OWNER_COLLECTION)
        .await
        .unwrap();
    database
        .collection::<Document>(MONGO_OWNER_COLLECTION)
        .insert_one(doc! {"_id": "owner", "owner": FIXTURE_OWNER, "token": suffix})
        .await
        .unwrap();
    assert_mongo_owned(&database, suffix).await;
    let connection = ConnectionManager::new(redis::Client::open(redis_url).unwrap())
        .await
        .unwrap();
    let mut raw = connection.clone();
    assert!(
        scan_owned(&mut raw, &namespace).await.is_empty(),
        "fixture namespace must be empty"
    );
    let redis_owner_key = format!("{namespace}__owner");
    let redis_owner = format!("{FIXTURE_OWNER}:{suffix}");
    assert_eq!(value(&mut raw, &redis_owner_key).await, None);
    let _: String = redis::cmd("SET")
        .arg(&redis_owner_key)
        .arg(&redis_owner)
        .query_async(&mut raw)
        .await
        .unwrap();

    let oauth = Arc::new(OAuthFixture::start());
    let exchange = oauth.exchange("client-id");
    let records = Arc::new(Records::default());
    let console = Arc::new(CaptureConsole::default());
    let shared_logger = logger(&records);
    let tokens = Arc::new(storage(&database, &connection, &namespace, &exchange));
    let users = database.collection::<Document>("users");
    let directory_service = directory(
        &database,
        &connection,
        &namespace,
        &exchange,
        &shared_logger,
    );
    let notifier = DeveloperNotifier::with_console(console.clone());
    let headers = Arc::new(
        TwitchHeaders::new(
            "client-id",
            tokens.clone(),
            directory_service.clone(),
            shared_logger.clone(),
        )
        .unwrap()
        .with_notifier(notifier.clone()),
    );

    let result = AssertUnwindSafe(async {
        // ---- app credential: cold OAuth, cache publication, warm reuse ----
        let app_case = case(&reference, "app-success");
        let app_headers = headers.clone();
        let app_task = tokio::spawn(async move { app_headers.get_twitch_app_header().await });
        let app_header = bounded("cold app header", app_task)
            .await
            .expect("app helper must run on a normal worker stack")
            .expect("app credential");
        assert_wire(&app_header, &app_case["result"]["value"]);
        let app_calls = oauth.app_requests();
        assert_eq!(
            app_calls,
            vec!["client-id".to_owned()],
            "one client-credentials exchange"
        );
        let app_key = format!("{namespace}app:twitch:token");
        assert_eq!(
            value(&mut raw, &app_key).await.as_deref(),
            Some("app-token")
        );
        let ttl: i64 = redis::cmd("TTL")
            .arg(&app_key)
            .query_async(&mut raw)
            .await
            .unwrap();
        assert!((3580..=3600).contains(&ttl), "app token TTL: {ttl}");
        let state = headers.state();
        assert_wire(
            &state.app_header().unwrap(),
            &app_case["state"]["twitchAppHeader"],
        );
        assert_wire(
            &state.streamer_header(),
            &app_case["state"]["twitchStreamerHeader"],
        );
        let warm_header = bounded("warm app header", headers.get_twitch_app_header())
            .await
            .expect("warm app credential");
        assert_eq!(warm_header, app_header);
        assert_eq!(
            oauth.app_requests().len(),
            1,
            "warm read must not re-exchange"
        );
        assert_eq!(state.app_header().unwrap(), warm_header);

        // ---- app credential failure: exact source throw and no cache write ----
        let app_missing = case(&reference, "app-missing");
        let denied_namespace = format!("{namespace}denied:");
        let denied_exchange = oauth.exchange("denied-client");
        let denied_tokens = Arc::new(storage(
            &database,
            &connection,
            &denied_namespace,
            &denied_exchange,
        ));
        let denied = TwitchHeaders::new(
            "client-id",
            denied_tokens,
            directory_service.clone(),
            shared_logger.clone(),
        )
        .unwrap();
        match bounded("missing app header", denied.get_twitch_app_header()).await {
            Err(error) => assert_eq!(error.to_string(), text(&app_missing["result"], "threw")),
            Ok(header) => panic!("denied app credential produced {header:?}"),
        }
        assert_eq!(
            value(&mut raw, &format!("{denied_namespace}app:twitch:token")).await,
            None
        );
        assert!(
            denied.state().app_header().is_none(),
            "a failed app acquisition must not update the app state"
        );
        assert_eq!(
            oauth.app_requests(),
            vec!["client-id".to_owned(), "denied-client".to_owned()]
        );

        // ---- bot credential missing: source notification plus result ----
        let missing_bot = case(&reference, "bot-missing");
        let missing = bounded("missing bot header", headers.get_twitch_bot_header()).await;
        assert_wire(&missing, &missing_bot["result"]["value"]);
        assert_eq!(
            console.lines(),
            missing_bot["calls"]["console"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        );

        // ---- real user documents for the remaining cases ----
        for document in [
            user(
                TWITCH_BOT_ACCOUNT_ID,
                Some("bot-token"),
                Some("bot-refresh"),
                Some(future_expiry()),
                true,
            ),
            user(
                "111",
                Some("streamer-token-1234567890"),
                Some("streamer-refresh-111"),
                Some(future_expiry()),
                true,
            ),
            user(
                "222",
                Some("unused-token"),
                Some("streamer-refresh-222"),
                Some(future_expiry()),
                false,
            ),
            user("333", None, None, None, true),
            user(
                "444",
                Some("streamer-token-must-not-be-used"),
                Some("streamer-refresh-444"),
                Some(future_expiry()),
                true,
            ),
            user(
                "555",
                Some("expired-streamer-access"),
                Some("streamer-refresh-555"),
                Some(past_expiry()),
                true,
            ),
            user(
                "888",
                Some("expired-streamer-access"),
                Some("streamer-refresh-888"),
                Some(past_expiry()),
                true,
            ),
            user(
                "889",
                Some("expired-streamer-access"),
                Some("streamer-refresh-889"),
                Some(past_expiry()),
                true,
            ),
        ] {
            users.insert_one(document).await.unwrap();
        }

        // ---- bot credential present: identity token and mirror publication ----
        let bot_case = case(&reference, "bot-success");
        let bot_header = bounded("bot header", headers.get_twitch_bot_header()).await;
        assert_wire(&bot_header, &bot_case["result"]["value"]);
        let bot_account_key = format!("{namespace}accounts:twitch:{TWITCH_BOT_ACCOUNT_ID}:data");
        let bot_hash = hash(&mut raw, &bot_account_key).await;
        assert_eq!(
            bot_hash.get("access_token").map(String::as_str),
            Some("bot-token")
        );
        let bot_mirror = hash(&mut raw, &format!("{namespace}app:twitch:bot")).await;
        assert_eq!(
            bot_mirror.get("access_token").map(String::as_str),
            Some("bot-token")
        );
        assert_eq!(console.lines().len(), 1, "no new developer notification");

        // ---- streamer cases: missing, strict permission, success ----
        for id in [
            "streamer-missing",
            "streamer-no-permissions",
            "streamer-empty-token",
            "streamer-success",
        ] {
            let source_case = case(&reference, id);
            let requested = source_case["args"][0].as_str().unwrap().to_owned();
            let actual = bounded(id, headers.get_twitch_streamer_header_by_id(&requested)).await;
            assert_wire(&actual, &source_case["result"]["value"]);
            let expected_debug: Vec<Value> = source_case["calls"]["debug"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| call["data"].clone())
                .collect();
            let observed = records.header_debug();
            assert!(
                observed.len() >= expected_debug.len(),
                "{id} is missing its cache debug payload"
            );
            let tail = &observed[observed.len() - expected_debug.len()..];
            assert_eq!(tail, expected_debug.as_slice(), "{id} cache debug payloads");
        }
        assert_eq!(console.lines().len(), 1, "streamer cases never notify");
        assert!(
            !oauth
                .refresh_tokens()
                .iter()
                .any(|token| token == "streamer-refresh-222"),
            "the permission gate must short-circuit before any token work"
        );

        // Strict string semantics: a non-"true" flag denies, as in the source.
        let denied_key = format!("{namespace}accounts:twitch:222:data");
        assert_eq!(
            hash(&mut raw, &denied_key)
                .await
                .get("has_permissions")
                .map(String::as_str),
            Some("false")
        );

        // ---- moderator: always the bot identity, independent of the arguments ----
        let moderator_case = case(&reference, "moderator-uses-bot");
        let moderator = bounded(
            "moderator header",
            headers.get_twitch_moderator_header(
                moderator_case["args"][0].as_str().unwrap(),
                moderator_case["args"][1].as_str().unwrap(),
            ),
        )
        .await;
        assert_wire(&moderator, &moderator_case["result"]["value"]);
        assert_eq!(
            moderator.header().unwrap().authorization(),
            "Bearer bot-token",
            "moderator token selection uses the bot account only"
        );
        assert_eq!(console.lines().len(), 1);
        assert_eq!(moderator_case["args"][1].as_str().unwrap(), "555");
        // The requester is never the credential owner: any arguments still act as
        // the canonical bot identity 698614112.
        let repeated = bounded(
            "moderator header repeated",
            headers.get_twitch_moderator_header("999", TWITCH_BOT_ACCOUNT_ID),
        )
        .await;
        assert_eq!(
            repeated, moderator,
            "requester arguments never select a credential"
        );
        assert_eq!(
            repeated.header().unwrap().authorization(),
            "Bearer bot-token"
        );

        // ---- streamer refresh: expired access rotates through the real store ----
        let refreshed = bounded(
            "streamer refresh",
            headers.get_twitch_streamer_header_by_id("555"),
        )
        .await;
        assert!(!refreshed.error, "refresh must succeed: {refreshed:?}");
        assert_eq!(
            refreshed.header().unwrap().authorization(),
            "Bearer refreshed-streamer-refresh-555"
        );
        assert!(
            oauth
                .refresh_tokens()
                .contains(&"streamer-refresh-555".to_owned())
        );
        let rotated_key = format!("{namespace}accounts:twitch:555:data");
        let rotated = hash(&mut raw, &rotated_key).await;
        assert_eq!(
            rotated.get("access_token").map(String::as_str),
            Some("refreshed-streamer-refresh-555")
        );

        // ---- bot refresh: same real path, plus the mirror update ----
        users
            .update_one(
                doc! { "accounts.id": TWITCH_BOT_ACCOUNT_ID },
                doc! { "$set": {
                    "accounts.$.access_token": envelope("stale-bot-access"),
                    "accounts.$.refresh_token": envelope("bot-refresh-rotatable"),
                    "accounts.$.access_token_expires_at": Bson::Double(past_expiry())
                }},
            )
            .await
            .unwrap();
        let _: i64 = redis::cmd("DEL")
            .arg(&bot_account_key)
            .arg(format!("{namespace}app:twitch:bot"))
            .query_async(&mut raw)
            .await
            .unwrap();
        let refreshed_bot = bounded("bot refresh", headers.get_twitch_bot_header()).await;
        assert!(
            !refreshed_bot.error,
            "bot refresh must succeed: {refreshed_bot:?}"
        );
        assert_eq!(
            refreshed_bot.header().unwrap().authorization(),
            "Bearer refreshed-bot-refresh-rotatable"
        );
        let mirror = hash(&mut raw, &format!("{namespace}app:twitch:bot")).await;
        assert_eq!(
            mirror.get("access_token").map(String::as_str),
            Some("refreshed-bot-refresh-rotatable")
        );

        // ---- concurrency: shared flight, per-id credentials, no mixing ----
        let same_id: Vec<_> = (0..6)
            .map(|_| {
                let headers = headers.clone();
                tokio::spawn(async move { headers.get_twitch_streamer_header_by_id("888").await })
            })
            .collect();
        let same_id = bounded("same-id concurrency", join_all(same_id)).await;
        for result in same_id {
            let result = result.expect("streamer helper must run on a normal worker stack");
            assert_eq!(
                result.header().unwrap().authorization(),
                "Bearer refreshed-streamer-refresh-888"
            );
        }
        let refreshes = oauth.refresh_tokens();
        assert_eq!(
            refreshes
                .iter()
                .filter(|token| token.as_str() == "streamer-refresh-888")
                .count(),
            1,
            "one shared refresh for concurrent callers"
        );
        let (s889, s111a, bot, s111b) = bounded("cross-identity concurrency", async {
            tokio::join!(
                headers.get_twitch_streamer_header_by_id("889"),
                headers.get_twitch_streamer_header_by_id("111"),
                headers.get_twitch_bot_header(),
                headers.get_twitch_streamer_header_by_id("111"),
            )
        })
        .await;
        let authorizations = [
            s889.header().unwrap().authorization(),
            s111a.header().unwrap().authorization(),
            bot.header().unwrap().authorization(),
            s111b.header().unwrap().authorization(),
        ];
        assert_eq!(
            authorizations,
            [
                "Bearer refreshed-streamer-refresh-889",
                "Bearer streamer-token-1234567890",
                "Bearer refreshed-bot-refresh-rotatable",
                "Bearer streamer-token-1234567890"
            ]
        );

        // ---- developer notification placeholder: all three severities ----
        let levels = [
            ("error", DeveloperSeverity::Error),
            ("warning", DeveloperSeverity::Warning),
            ("info", DeveloperSeverity::Info),
        ];
        let before = console.lines().len();
        for (name, severity) in levels {
            notifier
                .notify(&format!("message for {name}"), severity)
                .await;
        }
        let expected_lines = field(&reference, "notificationLines");
        let observed = console.lines();
        let observed = &observed[before..];
        assert_eq!(observed[0], notification_line(expected_lines, "error"));
        assert_eq!(observed[1], notification_line(expected_lines, "warning"));
        assert_eq!(observed[2], notification_line(expected_lines, "info"));

        // ---- explicit CLIENT_ID snapshot: no environment/cross-call bleed ----
        let probe = std::env::var("CLIENT_ID").ok();
        if let Some(probe) = &probe {
            assert_eq!(
                probe.as_str(),
                "env-must-not-be-used",
                "fixture environment probe"
            );
        }
        let other = TwitchHeaders::new(
            "other-client",
            tokens.clone(),
            directory_service.clone(),
            shared_logger.clone(),
        )
        .unwrap()
        .with_notifier(DeveloperNotifier::with_console(console.clone()));
        let other_bot = bounded("second app identity", other.get_twitch_bot_header()).await;
        let other_streamer = bounded(
            "second app streamer identity",
            other.get_twitch_streamer_header_by_id("111"),
        )
        .await;
        let other_app = bounded("second app credential", other.get_twitch_app_header())
            .await
            .expect("app token");
        assert_eq!(other_bot.header().unwrap().client_id(), "other-client");
        assert_eq!(other_streamer.header().unwrap().client_id(), "other-client");
        assert_eq!(other_app.client_id(), "other-client");
        assert_eq!(headers.state().client_id(), "client-id");
        assert_eq!(
            headers.state().streamer_header().client_id(),
            "client-id",
            "the streamer global keeps the factory value"
        );
        if let Some(probe) = probe {
            assert_ne!(other_app.client_id(), probe.as_str());
            assert_ne!(headers.state().client_id(), probe.as_str());
        }

        // ---- source CLIENT_ID binding: module globals snapshot, bot/streamer
        // re-read the source per call. The reference records the real source
        // behavior after `process.env.CLIENT_ID` changed; the native test supplies
        // the same transition through an injected source instead of mutating the
        // process environment, so it stays concurrency-safe.
        let binding = field(&reference, "sourceClientIdBinding");
        let source_client_ids = Arc::new(SwitchableClientId::new("client-id"));
        let live = TwitchHeaders::from_source(
            source_client_ids.clone(),
            tokens.clone(),
            directory_service.clone(),
            shared_logger.clone(),
        )
        .unwrap()
        .with_notifier(DeveloperNotifier::with_console(console.clone()));
        assert_eq!(live.state().client_id(), text(binding, "moduleLoad"));
        source_client_ids.set("changed-client");
        let live_app = bounded("binding app header", live.get_twitch_app_header())
            .await
            .expect("app credential");
        let live_bot = bounded("binding bot header", live.get_twitch_bot_header()).await;
        let live_streamer = bounded(
            "binding streamer header",
            live.get_twitch_streamer_header_by_id("111"),
        )
        .await;
        assert_eq!(live_app.client_id(), text(binding, "appAfterEnvChange"));
        assert_eq!(live_app.client_id(), text(binding, "moduleLoad"));
        assert_eq!(
            live_bot.header().unwrap().client_id(),
            text(binding, "botAfterEnvChange"),
            "bot headers re-read the client id per call"
        );
        assert_eq!(
            live_streamer.header().unwrap().client_id(),
            text(binding, "streamerAfterEnvChange"),
            "streamer headers re-read the client id per call"
        );
        assert_eq!(live.state().client_id(), text(binding, "moduleLoad"));
        assert_eq!(
            live.state().streamer_header().client_id(),
            text(binding, "moduleLoad"),
            "the exported streamer global keeps the module-load snapshot"
        );

        // ---- diagnostics never carry a bearer value or credential material ----
        let secrets = [
            "app-token",
            "bot-token",
            "streamer-token-1234567890",
            "streamer-token-must-not-be-used",
            "stale-bot-access",
            "refreshed-",
            "rotated-",
        ];
        for entry in records.entries() {
            let line = entry.to_string();
            assert!(
                !line.contains("Bearer"),
                "diagnostics must not contain bearer values"
            );
            for secret in secrets {
                assert!(!line.contains(secret), "diagnostic leaked {secret}: {line}");
            }
        }
        for line in console.lines() {
            assert!(
                !line.contains("Bearer"),
                "console must not carry a bearer value"
            );
            for secret in secrets {
                assert!(!line.contains(secret), "console leaked {secret}: {line}");
            }
        }
        let debug = format!("{headers:?}");
        assert!(!debug.contains("Bearer") && !debug.contains("app-token"));
        assert!(
            records
                .cache
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.contains("tokenLength"))
        );
    })
    .catch_unwind()
    .await;

    // Cleanup is guarded by the exact owner markers written above and removes
    // only the unique task prefix and the task database.
    assert_mongo_owned(&database, suffix).await;
    assert_eq!(
        value(&mut raw, &redis_owner_key).await.as_deref(),
        Some(redis_owner.as_str()),
        "Redis owner marker must still match before cleanup"
    );
    let keys = scan_owned(&mut raw, &namespace).await;
    assert!(
        keys.iter().any(|key| key == &redis_owner_key),
        "owned prefix must contain its marker"
    );
    for batch in keys.chunks(128) {
        let _: i64 = redis::cmd("DEL")
            .arg(batch)
            .query_async(&mut raw)
            .await
            .expect("fixture Redis cleanup");
    }
    database
        .clone()
        .drop()
        .await
        .expect("fixture Mongo cleanup");
    assert!(scan_owned(&mut raw, &namespace).await.is_empty());
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "owned fixture database must be gone"
    );
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[test]
fn header_state_rejects_invalid_client_id_without_io() {
    assert_eq!(
        TwitchHeaderState::new("bad\nvalue").err(),
        Some(TwitchHeaderError::InvalidClientId)
    );
}
