//! Shared harness of the live tests: the local MongoDB and Dragonfly from `tools/test-env`, a
//! throwaway `dima_test_twitch_<random>` database dropped even when a test fails, Dragonfly
//! logical database 14 (15 for the real-data test) with a unique key prefix removed afterwards,
//! and a stateful Twitch mock on `dima_http::testing::MockServer`. Without the stores a test
//! skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use anyhow::{Context, Result, bail};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::crypto::{CredentialCipher, StoredCredential};
use dima_core::{Clock, ManualClock, SecretString, Shutdown, SystemRandom};
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_http::{HttpClient, Provider};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use dima_twitch::events::RecordingEvents;
use dima_twitch::{KeySpace, Timings, Twitch, TwitchConfig, TwitchDeps};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CLIENT_ID: &str = "test-client-id";
pub const CLIENT_SECRET: &str = "test-client-secret-value";
/// A test key only: production tokens cannot be decrypted with it.
pub const TEST_SECRET_KEY: &str = "dima-twitch-test-key";
pub const LIVE_DATABASE: u8 = 14;
pub const REAL_DATA_DATABASE: u8 = 15;
/// 2026-11-11T00:00:00Z.
pub const NOW_MS: i64 = 1_794_355_200_000;

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

fn random_suffix() -> String {
    let mut bytes = [0_u8; 6];
    let _ = dima_core::Random::fill(&SystemRandom, &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The local stores, or `None` (skip) when they are absent and not required.
pub struct Stores {
    pub mongo: MongoStore,
    pub dragonfly: Dragonfly,
    pub keys: KeySpace,
    pub database: String,
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
        "dima-twitch-tests",
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

/// Deletes every key under `prefix` in the test database.
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

/// Runs `test` with fresh stores, then drops the database and the keys, whatever the outcome.
pub async fn with_stores<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(Stores) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let suffix = random_suffix();
    let database = format!("dima_test_twitch_{suffix}");
    let Some(mongo) = connect_mongo(&database).await? else {
        return Ok(());
    };
    let Some(dragonfly) = connect_dragonfly(LIVE_DATABASE).await? else {
        return Ok(());
    };
    let prefix = format!("dtw{suffix}:");
    let stores = Stores {
        mongo: mongo.clone(),
        dragonfly: dragonfly.clone(),
        keys: KeySpace::prefixed(prefix.clone()),
        database: database.clone(),
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

pub fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_SECRET_KEY).expect("test key")
}

pub fn encrypt(text: &str) -> StoredCredential {
    cipher().encrypt(text, &SystemRandom).expect("encrypt")
}

pub fn envelope(text: &str) -> Bson {
    let stored = encrypt(text);
    Bson::Document(doc! { "iv": stored.iv, "content": stored.content })
}

/// A user as sign-up stores it, with one Twitch account.
pub fn user_document(
    id: &str,
    name: &str,
    access: &str,
    refresh: &str,
    expires_at: Option<i64>,
) -> Document {
    let expires = expires_at.map_or(Bson::Null, |secs| {
        i32::try_from(secs).map_or(Bson::Int64(secs), Bson::Int32)
    });
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
            "refresh_token": envelope(refresh),
            "access_token": envelope(access),
            "access_token_expires_at": expires,
            "actived": true,
            "chat_enabled": true,
            "has_permissions": true,
            "up_to_date_permissions": true,
        }],
        "plan_tier": "free",
        "plan_tier_until": Bson::Null,
        "polar_sh_customer_id": Bson::Null,
        "token_balance": 0,
        "created_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
        "updated_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
        "__v": 0,
    }
}

pub async fn insert_user(stores: &Stores, document: Document) -> Result<()> {
    stores.mongo.documents("users").insert_one(document).await?;
    Ok(())
}

/// The stored Twitch account of `id`.
pub async fn stored_account(stores: &Stores, id: &str) -> Result<Document> {
    let user = stores
        .mongo
        .documents("users")
        .find_one(doc! { "accounts.id": id })
        .await?
        .context("user present")?;
    let accounts = user.get_array("accounts")?;
    for account in accounts {
        if let Bson::Document(account) = account
            && account.get_str("id").ok() == Some(id)
        {
            return Ok(account.clone());
        }
    }
    bail!("account {id} not found")
}

pub fn decrypt_field(account: &Document, field: &str) -> Option<String> {
    let envelope = account.get_document(field).ok()?;
    cipher()
        .decrypt_fields(
            envelope.get_str("iv").ok(),
            envelope.get_str("content").ok(),
        )
        .ok()
        .flatten()
}

/// The hash of `id` as a map.
pub async fn cache_fields(stores: &Stores, id: &str) -> Result<HashMap<String, String>> {
    Ok(stores
        .dragonfly
        .hgetall(&stores.keys.account(id))
        .await?
        .into_iter()
        .collect())
}

pub async fn set_cache(stores: &Stores, id: &str, fields: &[(&str, &str)]) -> Result<()> {
    let fields: Vec<(&str, &[u8])> = fields.iter().map(|(k, v)| (*k, v.as_bytes())).collect();
    stores
        .dragonfly
        .hset(&stores.keys.account(id), &fields)
        .await?;
    Ok(())
}

/// Twitch's token endpoint as a state machine: each streamer has one valid refresh token; a
/// refresh with it rotates both tokens (the old refresh token is consumed when `consume` is
/// set), anything else answers `400 Invalid refresh token`. Helix answers by a handler.
#[derive(Default)]
pub struct TwitchState {
    /// refresh token -> streamer id.
    pub valid: HashMap<String, String>,
    /// streamer id -> rotation count.
    pub rotations: HashMap<String, u32>,
    /// Valid access tokens.
    pub access: HashMap<String, String>,
    pub consume: bool,
    pub expires_in: i64,
    pub delay: Duration,
    pub app_tokens: u32,
}

pub type Shared = Arc<Mutex<TwitchState>>;

pub fn form(body: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

pub fn form_value(request: &RecordedRequest, name: &str) -> Option<String> {
    form(&request.body_text())
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Starts the mock with the stateful token endpoint; Helix requests go to `helix`.
pub async fn twitch_mock(
    state: Shared,
    helix: impl Fn(&RecordedRequest, &Shared) -> MockResponse + Send + Sync + 'static,
) -> Result<MockServer> {
    let server = MockServer::start().await?;
    let handler_state = Arc::clone(&state);
    server.fallback(move |request| {
        if request.path() == "/oauth2/token" {
            token_endpoint(request, &handler_state)
        } else {
            helix(request, &handler_state)
        }
    });
    Ok(server)
}

fn token_endpoint(request: &RecordedRequest, state: &Shared) -> MockResponse {
    let fields = form(&request.body_text());
    let get = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let mut state = state.lock().expect("state");
    let delay = state.delay;
    if get("client_id").as_deref() != Some(CLIENT_ID)
        || get("client_secret").as_deref() != Some(CLIENT_SECRET)
    {
        return MockResponse::json(403, r#"{"status":403,"message":"invalid client"}"#)
            .delay(delay);
    }
    match get("grant_type").as_deref() {
        Some("client_credentials") => {
            state.app_tokens += 1;
            let body = json!({
                "access_token": format!("app-token-{}", state.app_tokens),
                "expires_in": 5_011_271,
                "token_type": "bearer",
            });
            MockResponse::json(200, &body.to_string()).delay(delay)
        }
        Some("refresh_token") => {
            let presented = get("refresh_token").unwrap_or_default();
            let Some(user) = state.valid.get(&presented).cloned() else {
                return MockResponse::json(
                    400,
                    r#"{"status":400,"message":"Invalid refresh token"}"#,
                )
                .delay(delay);
            };
            let count = {
                let count = state.rotations.entry(user.clone()).or_insert(0);
                *count += 1;
                *count
            };
            let access = format!("{user}-access-{count}");
            let refresh = format!("{user}-refresh-{count}");
            if state.consume {
                state.valid.remove(&presented);
            }
            state.valid.insert(refresh.clone(), user.clone());
            state.access.insert(access.clone(), user);
            let body = json!({
                "access_token": access,
                "refresh_token": refresh,
                "expires_in": state.expires_in,
                "scope": ["chat:read"],
                "token_type": "bearer",
            });
            MockResponse::json(200, &body.to_string()).delay(delay)
        }
        _ => MockResponse::json(400, r#"{"status":400,"message":"missing grant_type"}"#),
    }
}

/// Helix accepts any token the state knows (`Authorization` checked by scheme and value).
pub fn helix_ok(request: &RecordedRequest, state: &Shared) -> MockResponse {
    let token = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    let known = {
        let state = state.lock().expect("state");
        state.access.contains_key(&token) || token.starts_with("app-token-")
    };
    if known {
        MockResponse::json(200, r#"{"data":[]}"#)
    } else {
        MockResponse::json(
            401,
            r#"{"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}"#,
        )
    }
}

/// Short timings so the lock tests take milliseconds, not seconds.
pub fn fast_timings() -> Timings {
    Timings {
        refresh_lock_ttl: Duration::from_millis(800),
        refresh_wait: Duration::from_millis(720),
        refresh_wait_poll: Duration::from_millis(20),
        refresh_backoff: vec![Duration::from_millis(40), Duration::from_millis(90)],
        oauth_timeout: Duration::from_millis(1500),
        helix_refresh_deadline: Duration::from_secs(5),
        store_deadline: Duration::from_secs(10),
        emote_timeout: Duration::from_millis(500),
        shutdown_grace: Duration::from_secs(5),
        ..Timings::reference()
    }
}

/// One "process": its own handle (own in-memory state) on the shared stores and mock.
pub struct Process {
    pub twitch: Twitch,
    pub events: Arc<RecordingEvents>,
    pub clock: ManualClock,
    pub shutdown: Shutdown,
}

pub fn process(stores: &Stores, server: &MockServer, timings: Timings) -> Result<Process> {
    process_at(stores, server, timings, ManualClock::new(NOW_MS))
}

pub fn process_at(
    stores: &Stores,
    server: &MockServer,
    timings: Timings,
    clock: ManualClock,
) -> Result<Process> {
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = stores.keys.clone();
    config.timings = timings;
    let helix: Provider = server.provider(dima_twitch::helix_provider(CLIENT_ID))?;
    let oauth: Provider = server.provider(dima_twitch::oauth_provider())?;
    let shutdown = Shutdown::new();
    let events = Arc::new(RecordingEvents::default());
    let clock_dyn: Arc<dyn Clock> = Arc::new(clock.clone());
    let http = HttpClient::builder()
        .shutdown(shutdown.clone())
        .clock(Arc::clone(&clock_dyn))
        .build()?;
    let twitch = Twitch::new(
        config,
        TwitchDeps {
            http,
            helix,
            oauth,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock: clock_dyn,
            random: Arc::new(SystemRandom),
            events: events.clone(),
            shutdown: shutdown.clone(),
        },
    );
    Ok(Process {
        twitch,
        events,
        clock,
        shutdown,
    })
}

/// Requests to the token endpoint so far.
pub fn token_requests(server: &MockServer) -> Vec<RecordedRequest> {
    server
        .requests()
        .into_iter()
        .filter(|request| request.path() == "/oauth2/token")
        .collect()
}

/// Asserts a token request has the reference's shape (`ledger/outbound.md` TW-079/TW-080):
/// `POST /oauth2/token`, no query, a form body with the fields in order.
pub fn assert_token_request(request: &RecordedRequest, grant: &str, refresh: Option<&str>) {
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.target, "/oauth2/token",
        "credentials never in the URL"
    );
    assert_eq!(
        request.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert!(request.header("authorization").is_none());
    let mut expected = vec![
        ("client_id".to_owned(), CLIENT_ID.to_owned()),
        ("client_secret".to_owned(), CLIENT_SECRET.to_owned()),
        ("grant_type".to_owned(), grant.to_owned()),
    ];
    if let Some(refresh) = refresh {
        expected.push(("refresh_token".to_owned(), refresh.to_owned()));
    }
    assert_eq!(form(&request.body_text()), expected);
}

/// Asserts a Helix request carries the reference's headers; the token by scheme only.
pub fn assert_helix_headers(request: &RecordedRequest) {
    assert_eq!(request.header("client-id"), Some(CLIENT_ID));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert!(
        request
            .header("authorization")
            .is_some_and(|value| value.starts_with("Bearer ")),
        "bearer scheme"
    );
}

/// Asserts that no log entry mentions any of `secrets`.
pub fn assert_no_secrets(events: &RecordingEvents, secrets: &[&str]) {
    for secret in secrets.iter().chain([&CLIENT_SECRET]) {
        assert!(
            !events.mentions(secret),
            "a log entry mentions a secret ({} characters)",
            secret.len()
        );
    }
}

/// `{"data": [...]}` helper for Helix answers.
pub fn data(values: Value) -> String {
    json!({ "data": values }).to_string()
}
