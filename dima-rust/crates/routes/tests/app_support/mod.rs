//! Shared by the recordings of this crate: scratch stores cleaned up also on failure, the API's
//! state as the binary builds it (with the fakes and mocks of `app-record.mts`), a raw HTTP/1.1
//! client that sends exactly the recorder's bytes, and the recorder's normalisation.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::{Context, Result};
use dima_core::crypto::CredentialCipher;
use dima_core::{Clock, Random, SecretString, Shutdown, SystemClock, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use dima_model::users::{AccountType, NewAccount, NewUser};
use dima_model::{IndexPolicy, ensure_indexes};
use dima_platform::access::ChannelAccess;
use dima_platform::auth::twitch::HttpTwitchUserApi;
use dima_platform::auth::{AuthConfig, AuthDeps, Authenticator, NoReport};
use dima_platform::oauth::{OAuthConfig, OAuthDeps, OAuthService};
use dima_routes::app::{
    AppConfig, ClientAddressPolicy, ReservedCommands, SiteSnapshots, SnapshotError,
};
use dima_routes::oauth::{
    AreaError, AreaResult, DesktopCredits, DesktopTurns, OAuthAccess, PetControl, TurnAudio,
};
use dima_routes::observability::{AnalyticsConfig, AnalyticsUpstream};
use dima_routes::state::{AppState, Core, Services};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore, WriteContext};
use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The logical Dragonfly database of this crate's tests.
pub const DB: u8 = 8;

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1")
}

/// Scratch stores: a MongoDB database of its own, Dragonfly database 8, the keys to delete.
#[derive(Clone)]
pub struct Stores {
    pub mongo: MongoStore,
    pub cache: Dragonfly,
    pub run: String,
    keys: Arc<Mutex<Vec<String>>>,
}

impl Stores {
    pub fn track(&self, key: impl Into<String>) {
        self.keys.lock().unwrap().push(key.into());
    }
}

/// Runs `body` with fresh stores, then drops the database and deletes every tracked key and
/// every key holding the run id, whatever `body` did. Without the stores and outside the gate,
/// the test is skipped.
pub async fn with_stores<F, Fut>(body: F) -> Result<()>
where
    F: FnOnce(Stores) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let (Ok(uri), Ok(address)) = (
        std::env::var("DIMA_TEST_MONGO_URI"),
        std::env::var("DIMA_TEST_DRAGONFLY"),
    ) else {
        anyhow::ensure!(!stores_required(), "the local stores are required");
        return Ok(());
    };
    let run = SystemRandom.hex_token(8)?;
    let database = format!("dima_test_routes_{run}");
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.clone());
    let mongo = MongoStore::connect(&config, None).await?;
    let (host, port) = address.rsplit_once(':').context("address")?;
    let cache = Dragonfly::connect(
        DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/{DB}")), "routes-tests"),
        Hooks::default(),
    )
    .await?;
    let stores = Stores {
        mongo,
        cache,
        run: run.clone(),
        keys: Arc::new(Mutex::new(Vec::new())),
    };
    let result = AssertUnwindSafe(body(stores.clone())).catch_unwind().await;
    anyhow::ensure!(database.starts_with("dima_test_routes_"));
    stores.mongo.database().drop().await?;
    let tracked = stores.keys.lock().unwrap().clone();
    for key in &tracked {
        stores.cache.del(&[key]).await?;
    }
    let mut scan = stores.cache.scan(&format!("*{run}*"), Some(200));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            stores.cache.del(&[std::str::from_utf8(&key)?]).await?;
        }
    }
    match result {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// `oauth:rate:{hash(bucket)}`, `oauth:access:{hash(token)}` and the others.
pub fn oauth_key(kind: &str, value: &str) -> String {
    format!(
        "oauth:{kind}:{}",
        dima_core::crypto::keys::sha256_base64url(value)
    )
}

// ------------------------------------------------------------------------------------ fakes

/// What the area fakes were called with, as `app-record.mts` records it.
#[derive(Default)]
pub struct Calls(Mutex<Vec<Value>>);

impl Calls {
    pub fn push(&self, call: Value) {
        self.0.lock().unwrap().push(call);
    }

    pub fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

fn who(access: &OAuthAccess) -> Value {
    serde_json::to_value(access.identity()).unwrap()
}

pub struct Fakes {
    pub calls: Arc<Calls>,
    pub snapshot_fails: Arc<AtomicBool>,
    pub cases: Value,
    pub public_dir: PathBuf,
}

struct Reserved(Value);

impl ReservedCommands for Reserved {
    fn payload(&self, language: Option<&str>) -> Value {
        let mut payload = Map::new();
        payload.insert("language".to_owned(), json!(language));
        if let Value::Object(rest) = &self.0 {
            payload.extend(rest.clone());
        }
        Value::Object(payload)
    }
}

struct Snapshots {
    snapshot: Value,
    fails: Arc<AtomicBool>,
}

impl SiteSnapshots for Snapshots {
    fn snapshot(&self) -> BoxFuture<'_, Result<Value, SnapshotError>> {
        Box::pin(async move {
            if self.fails.load(Ordering::SeqCst) {
                return Err(SnapshotError("snapshot failed".to_owned()));
            }
            Ok(self.snapshot.clone())
        })
    }
}

struct Turns {
    calls: Arc<Calls>,
    audio: Value,
    public_dir: PathBuf,
}

impl DesktopTurns for Turns {
    fn submit<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.calls
                .push(json!({ "fn": "submit", "who": who(who_), "input": input }));
            if input["crash"] == json!(true) {
                return Err(AreaError::UNAVAILABLE);
            }
            if let Some(code) = input["fail_code"].as_str() {
                let status = input["fail_status"].as_u64().unwrap_or(400) as u16;
                return Err(AreaError::with_status(code.to_owned(), status));
            }
            Ok(json!({ "turn_id": "t1", "status": "queued", "input": input }))
        })
    }

    fn get<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        id: &'a str,
        by_request: bool,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.calls
                .push(json!({ "fn": "get", "who": who(who_), "id": id, "by_request": by_request }));
            Ok(json!({ "turn_id": id, "by_request": by_request }))
        })
    }

    fn cancel<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        turn: &'a str,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.calls
                .push(json!({ "fn": "cancel", "who": who(who_), "id": turn }));
            Ok(json!({ "turn_id": turn, "cancelled": true }))
        })
    }

    fn cancel_speech<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        turn: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.calls.push(
                json!({ "fn": "cancel_speech", "who": who(who_), "id": turn, "input": input }),
            );
            Ok(json!({ "turn_id": turn, "speech": "cancelled", "input": input }))
        })
    }

    fn speech_event<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        turn: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.calls.push(
                json!({ "fn": "speech_event", "who": who(who_), "id": turn, "input": input }),
            );
            Ok(json!({ "turn_id": turn, "event": input }))
        })
    }

    fn claim_audio<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        turn: &'a str,
        ticket: Option<&'a str>,
    ) -> BoxFuture<'a, AreaResult<TurnAudio>> {
        Box::pin(async move {
            self.calls.push(
                json!({ "fn": "claim_audio", "who": who(who_), "id": turn, "ticket": ticket }),
            );
            let file = self.audio[turn].as_str().unwrap_or("missing.mp3");
            Ok(TurnAudio {
                mime_type: "audio/mpeg".to_owned(),
                path: self.public_dir.join(file).display().to_string(),
            })
        })
    }
}

struct Pets(Arc<Calls>);

impl PetControl for Pets {
    fn configuration<'a>(
        &'a self,
        user: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, AreaResult<Map<String, Value>>> {
        Box::pin(async move {
            self.0
                .push(json!({ "fn": "pet_configuration", "user": user, "channel": channel }));
            let Value::Object(map) = json!({ "enabled": true, "profiles": [1], "voices": [2], "user": user, "channel": channel })
            else {
                unreachable!()
            };
            Ok(map)
        })
    }

    fn runtime<'a>(&'a self, user: &'a str, channel: &'a str) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.0
                .push(json!({ "fn": "pet_runtime", "user": user, "channel": channel }));
            Ok(json!({ "state": "idle", "user": user, "channel": channel }))
        })
    }

    fn select_playback<'a>(
        &'a self,
        who_: &'a OAuthAccess,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.0
                .push(json!({ "fn": "pet_playback", "who": who(who_), "input": input }));
            Ok(json!({ "selected": input }))
        })
    }

    fn cancel_request<'a>(
        &'a self,
        user: &'a str,
        request: &'a str,
        command: Option<&'a Value>,
    ) -> BoxFuture<'a, AreaResult<Value>> {
        Box::pin(async move {
            self.0.push(
                json!({ "fn": "pet_cancel", "user": user, "request": request, "command": command }),
            );
            Ok(json!({ "cancelled": request, "commandId": command }))
        })
    }
}

struct Credits(Arc<Calls>);

impl DesktopCredits for Credits {
    fn credits<'a>(
        &'a self,
        user: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, AreaResult<Option<Value>>> {
        Box::pin(async move {
            self.0
                .push(json!({ "fn": "credits", "user": user, "channel": channel }));
            Ok(Some(
                json!({ "balance": 5, "plan": "free", "display": { "label": "5 credits" } }),
            ))
        })
    }
}

// ------------------------------------------------------------------------------------ the app

pub struct Harness {
    pub stores: Stores,
    pub state: Arc<AppState>,
    pub fakes: Fakes,
    pub twitch: MockServer,
    pub analytics: MockServer,
    pub port: u16,
    pub shutdown: tokio_util::sync::CancellationToken,
    pub public: PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.shutdown.cancel();
        let _ = std::fs::remove_dir_all(&self.public);
    }
}

fn write_public(dir: &Path, cases: &Value) -> Result<()> {
    let mtime_ms = dima_text::parse_date(cases["public"]["mtime"].as_str().context("mtime")?)
        .context("mtime")?;
    let mtime = std::time::UNIX_EPOCH + Duration::from_millis(u64::try_from(mtime_ms)?);
    for (relative, content) in cases["public"]["files"].as_object().context("files")? {
        let file = dir.join(relative);
        std::fs::create_dir_all(file.parent().context("parent")?)?;
        std::fs::write(&file, content.as_str().context("content")?)?;
        std::fs::File::options()
            .write(true)
            .open(&file)?
            .set_modified(mtime)?;
    }
    Ok(())
}

/// The API as the binary builds it, over scratch stores, served on a loopback port: the Twitch
/// and analytics mocks of `app-record.mts`, the area fakes, the cases' configuration, and the
/// client address read from `X-Forwarded-For` behind the trusted proxy `127.0.0.1`.
pub async fn harness(stores: Stores, cases: Value) -> Result<Harness> {
    let client_id = cases["client_id"].as_str().context("client_id")?.to_owned();
    let twitch_mock = MockServer::start().await?;
    let tokens = cases["browser_tokens"].clone();
    let validate_client = client_id.clone();
    twitch_mock.fallback(move |request| {
        let auth = request.header("authorization").unwrap_or_default();
        let token = auth.strip_prefix("OAuth ").or_else(|| auth.strip_prefix("Bearer ")).unwrap_or(auth);
        match tokens[token].as_str() {
            Some(user) if request.path().ends_with("/oauth2/validate") => MockResponse::json(
                200,
                &json!({ "client_id": validate_client, "login": "viewer_one", "scopes": [], "user_id": user, "expires_in": 3600 })
                    .to_string(),
            ),
            _ => MockResponse::json(401, r#"{"status":401,"message":"invalid access token"}"#),
        }
    });
    let analytics_mock = MockServer::start().await?;
    let answers = cases["analytics"].clone();
    analytics_mock.fallback(move |request| {
        let answer = &answers[request.path()];
        if answer["drop"] == json!(true) {
            return MockResponse::drop_connection();
        }
        match answer["status"].as_u64() {
            Some(status) => MockResponse::new(status as u16)
                .body(answer["body"].as_str().unwrap_or_default().to_owned()),
            None => MockResponse::json(404, r#"{"message":"no"}"#),
        }
    });

    let public = std::env::temp_dir().join(format!("dima-routes-public-{}", stores.run));
    write_public(&public, &cases)?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let http = HttpClient::builder().build()?;
    let user_api = Arc::new(HttpTwitchUserApi::new(
        HttpClient::builder().build()?,
        twitch_mock.provider(dima_twitch::oauth_provider())?,
        twitch_mock.provider(dima_twitch::helix_provider(&client_id))?,
    ));
    let mut twitch_config =
        TwitchConfig::new(client_id.clone(), SecretString::from("routes-secret"));
    twitch_config.keys = KeySpace::prefixed(format!("dima_test_routes_{}:tw:", stores.run));
    let twitch = Twitch::new(
        twitch_config,
        TwitchDeps {
            http: http.clone(),
            exchange_http: dima_twitch::exchange_client(HttpClient::builder())?,
            helix: twitch_mock.provider(dima_twitch::helix_provider(&client_id))?,
            oauth: twitch_mock.provider(dima_twitch::oauth_provider())?,
            mongo: stores.mongo.clone(),
            dragonfly: stores.cache.clone(),
            cipher: CredentialCipher::new("routes-test-only")?,
            clock: Arc::clone(&clock),
            random: Arc::new(SystemRandom),
            events: Arc::new(dima_twitch::NoopEvents),
            shutdown: Shutdown::new(),
        },
    );
    let mut oauth_config = OAuthConfig::new(
        cases["issuer"].as_str(),
        cases["website"].as_str(),
        &client_id,
    )?;
    oauth_config.store_deadline = Duration::from_secs(20);
    let oauth = OAuthService::new(
        oauth_config,
        OAuthDeps {
            mongo: stores.mongo.clone(),
            cache: stores.cache.clone(),
            clock: Arc::clone(&clock),
            random: Arc::new(SystemRandom),
            twitch: user_api.clone(),
        },
    );
    let authenticator = Authenticator::new(
        AuthConfig::new(client_id.clone())?,
        AuthDeps {
            twitch: user_api,
            cache: stores.cache.clone(),
            mongo: stores.mongo.clone(),
            clock: Arc::clone(&clock),
            report: Arc::new(NoReport),
        },
    );
    let mut telemetry_config = dima_telemetry::TelemetryConfig::new("api", "routes-tests");
    telemetry_config.export = false;
    telemetry_config.console = dima_telemetry::ConsoleTarget::Off;
    let mut config = AppConfig::new(&public.display().to_string());
    config.client_address = ClientAddressPolicy::parse(Some("127.0.0.1"), None)?;
    config.analytics = AnalyticsConfig {
        base_url: analytics_mock.url(),
        ..AnalyticsConfig::reference()
    };
    let core = Core {
        mongo: stores.mongo.clone(),
        dragonfly: stores.cache.clone(),
        twitch,
        authenticator,
        access: ChannelAccess::new(stores.mongo.clone(), Duration::from_secs(5)),
        oauth,
        http: http.clone(),
        clock: Arc::clone(&clock),
        random: Arc::new(SystemRandom),
        telemetry: dima_telemetry::Telemetry::new(telemetry_config)?,
        config,
    };
    let fakes = Fakes {
        calls: Arc::new(Calls::default()),
        snapshot_fails: Arc::new(AtomicBool::new(false)),
        cases: cases.clone(),
        public_dir: public.clone(),
    };
    let mut services = Services::new();
    let reserved: Arc<dyn ReservedCommands> = Arc::new(Reserved(cases["reserved"].clone()));
    services.provide(reserved)?;
    let snapshots: Arc<dyn SiteSnapshots> = Arc::new(Snapshots {
        snapshot: cases["snapshot"].clone(),
        fails: Arc::clone(&fakes.snapshot_fails),
    });
    services.provide(snapshots)?;
    let turns: Arc<dyn DesktopTurns> = Arc::new(Turns {
        calls: Arc::clone(&fakes.calls),
        audio: cases["audio"].clone(),
        public_dir: public.clone(),
    });
    services.provide(turns)?;
    let pets: Arc<dyn PetControl> = Arc::new(Pets(Arc::clone(&fakes.calls)));
    services.provide(pets)?;
    let credits: Arc<dyn DesktopCredits> = Arc::new(Credits(Arc::clone(&fakes.calls)));
    services.provide(credits)?;
    let upstream = AnalyticsUpstream::new(
        http,
        analytics_mock.provider(core.config.analytics.provider())?,
    );
    services.provide(Arc::new(upstream))?;
    let required: Vec<_> = dima_routes::app::SERVICES
        .iter()
        .chain(dima_routes::oauth::SERVICES)
        .chain(dima_routes::observability::SERVICES)
        .copied()
        .collect();
    anyhow::ensure!(services.missing(&required).is_empty());

    // The reference's `init()` indexes, the desktop client, the site users.
    for info in [
        &dima_model::oauth_clients::INFO,
        &dima_model::oauth_grants::INFO,
        &dima_model::oauth_sessions::INFO,
        &dima_model::oauth_refresh_tokens::INFO,
    ] {
        let report = ensure_indexes(
            &stores.mongo,
            info,
            IndexPolicy::RequireAll,
            Duration::from_secs(30),
        )
        .await;
        report.require().map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    core.oauth
        .initialize()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    for user in cases["users"].as_array().context("users")? {
        let mut account = NewAccount::new(
            AccountType::Twitch,
            user["twitch_id"].as_str().context("id")?,
        );
        account.name = user["login"].as_str().map(str::to_owned);
        let new = NewUser {
            name: user["name"].as_str().map(str::to_owned),
            accounts: vec![account],
            ..NewUser::default()
        };
        let prepared = new.prepare(&mut WriteContext::new(clock.now_ms()))?;
        stores
            .mongo
            .writes(dima_model::users::COLLECTION)
            .insert_one(&prepared)
            .await?;
    }

    let state = Arc::new(AppState::new(core, services));
    let app = dima_routes::app::application(Arc::clone(&state))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let shutdown = tokio_util::sync::CancellationToken::new();
    let options = dima_routes::state::RouteState::core(state.as_ref())
        .config
        .serve;
    tokio::spawn(dima_web::serve(listener, app, shutdown.clone(), options));
    Ok(Harness {
        stores,
        state,
        fakes,
        twitch: twitch_mock,
        analytics: analytics_mock,
        port,
        shutdown,
        public,
    })
}

// ------------------------------------------------------------------------------- raw HTTP

/// An answer as both sides record it.
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// The request body of a case (`app-record.mts`'s `bodyOf`).
pub fn body_of(case: &Value, subst: &dyn Fn(&str) -> String) -> Option<Vec<u8>> {
    if let Some(size) = case["json_of_size"].as_u64() {
        return Some(format!("{{\"a\":\"{}\"}}", "x".repeat(size as usize - 8)).into_bytes());
    }
    if let Some(size) = case["form_of_size"].as_u64() {
        return Some(format!("a={}", "x".repeat(size as usize - 2)).into_bytes());
    }
    if let Some(n) = case["form_params"].as_u64() {
        let pairs: Vec<String> = (0..n).map(|i| format!("p{i}=1")).collect();
        return Some(pairs.join("&").into_bytes());
    }
    case["body"].as_str().map(|body| subst(body).into_bytes())
}

/// Sends a case's request on a new connection, exactly as the recorder does, and reads the
/// answer (for an event stream, up to its first complete event).
pub async fn send(port: u16, case: &Value, subst: &dyn Fn(&str) -> String) -> Result<Answer> {
    let body = body_of(case, subst);
    let mut headers: Vec<(String, String)> = case["headers"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), subst(v.as_str().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default();
    if let Some(body) = &body
        && !headers.iter().any(|(k, _)| k == "content-length")
    {
        headers.push(("content-length".to_owned(), body.len().to_string()));
    }
    let mut head = format!(
        "{} {} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n",
        case["method"].as_str().context("method")?,
        subst(case["path"].as_str().context("path")?)
    );
    for (name, value) in &headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(head.as_bytes()).await?;
    if let Some(body) = &body {
        // A refused body may be cut short by the server; the answer is what counts.
        let _ = socket.write_all(body).await;
    }
    if case["half_close"] == json!(true) {
        socket.shutdown().await?;
    }
    let stream = case["stream"] == json!(true);
    let mut raw = Vec::new();
    let read = async {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match socket.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => raw.extend_from_slice(&buffer[..n]),
            }
            if stream && parse(&raw).is_ok_and(|answer| contains(&answer.body, b"\n\n")) {
                break;
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(10), read).await;
    parse(&raw)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Head and (de-chunked) body.
pub fn parse(raw: &[u8]) -> Result<Answer> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .context("no head")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .context("status")?
        .parse()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    if headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v == "chunked")
    {
        let mut out = Vec::new();
        let mut at = 0;
        while let Some(end) = body[at..].windows(2).position(|w| w == b"\r\n") {
            let end = at + end;
            let size = usize::from_str_radix(std::str::from_utf8(&body[at..end])?.trim(), 16)?;
            if size == 0 || end + 2 + size > body.len() {
                if size != 0 {
                    out.extend_from_slice(&body[end + 2..]);
                }
                break;
            }
            out.extend_from_slice(&body[end + 2..end + 2 + size]);
            at = end + 2 + size + 2;
            if at >= body.len() {
                break;
            }
        }
        body = out;
    }
    Ok(Answer {
        status,
        headers,
        body,
    })
}

/// The headers both sides record.
pub const COMPARED: &[&str] = &[
    "content-type",
    "content-length",
    "cache-control",
    "pragma",
    "referrer-policy",
    "x-content-type-options",
    "content-security-policy",
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-credentials",
    "access-control-max-age",
    "access-control-expose-headers",
    "vary",
    "location",
    "etag",
    "last-modified",
    "accept-ranges",
    "content-range",
    "www-authenticate",
    "retry-after",
    "allow",
];

/// `normalise` of `app-record.mts`.
pub fn normalise(text: &str, captured: &[(String, String)]) -> String {
    let mut text = text.to_owned();
    let mut sorted: Vec<&(String, String)> = captured.iter().collect();
    sorted.sort_by_key(|pair| std::cmp::Reverse(pair.1.len()));
    for (name, value) in sorted {
        text = text.replace(value.as_str(), &format!("${name}"));
    }
    let rules: [(&str, &str); 5] = [
        (r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", "$$DATE"),
        (r"dima_at_[A-Za-z0-9_-]{43}", "$$AT_TOKEN"),
        (r"dima_rt_[A-Za-z0-9_-]{43}", "$$RT_TOKEN"),
        (r"\b[0-9a-f]{24}\b", "$$OID"),
        (
            r#""refresh_expires_in":\d+"#,
            r#""refresh_expires_in":$$SECONDS"#,
        ),
    ];
    for (pattern, replacement) in rules {
        text = regex::Regex::new(pattern)
            .unwrap()
            .replace_all(&text, replacement)
            .into_owned();
    }
    regex::Regex::new(r"([?&])code=[A-Za-z0-9_-]{43}")
        .unwrap()
        .replace_all(&text, "${1}code=$$SECRET")
        .into_owned()
}
