//! Task-owned support for `tests/api_auth.rs`.
//!
//! Everything here is disposable and loopback-only:
//! - a scripted Twitch provider served by a real Axum HTTP server;
//! - a minimal RESP server that records Redis commands and can inject the
//!   negative cache outcomes a real Dragonfly cannot produce on demand;
//! - a capture logger sink for the native `Logger` error mapping;
//! - fixture loading with an independently supplied SHA-256.
//!
//! No host networking, production service, credential or shared volume is used.

#![allow(dead_code)]

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header::AUTHORIZATION, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::any,
};
use dima_rust::utils::logger::{
    ConsoleRecord, ConsoleSink, Level, Logger, LoggerConfig, LoggerStats, SinkFuture, SinkHandles,
    SystemClock, UuidSource,
};
use redis::{AsyncCommands, aio::ConnectionManager};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

pub const NODE_SHA256: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
pub const TYPESCRIPT_SHA256: &str =
    "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Loads the externally written oracle and verifies its independent digest.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_API_AUTH_FIXTURE_DIR").expect("external fixture directory"),
    );
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert_eq!(
        directory.canonicalize().expect("fixture directory"),
        directory
    );
    assert!(
        !directory.starts_with(&workspace),
        "fixture must live outside the workspace"
    );
    let expected = std::env::var("DIMA_API_AUTH_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture digest must be lowercase hex"
    );
    let file = directory.join("api-auth-reference.json");
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file(),
        "fixture must be a regular file"
    );
    let bytes = std::fs::read(&file).expect("fixture bytes");
    assert_eq!(sha256_hex(&bytes), expected, "fixture digest mismatch");
    serde_json::from_slice(&bytes).expect("fixture JSON")
}

pub fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {name}"))
        .get("expected")
        .expect("expected block")
}

pub fn fixture_case_names(fixture: &Value) -> Vec<String> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .map(|case| case["name"].as_str().expect("case name").to_owned())
        .collect()
}

/// Asserts a native response against the source oracle's recorded outcome.
pub fn assert_case(fixture: &Value, name: &str, status: u16, body: &Value) {
    let expected = fixture_case(fixture, name);
    assert_eq!(
        expected["status"].as_u64(),
        Some(u64::from(status)),
        "{name}: status"
    );
    assert_eq!(body, &expected["body"], "{name}: body");
}

pub struct CaptureConsole {
    records: Mutex<Vec<Value>>,
}

impl CaptureConsole {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(Vec::new()),
        })
    }

    pub fn records(&self) -> Vec<Value> {
        self.records
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn error_functions(&self) -> Vec<String> {
        self.records()
            .iter()
            .filter(|record| record["level"] == "error")
            .filter_map(|record| record["data"]["function"].as_str().map(str::to_owned))
            .collect()
    }
}

impl ConsoleSink for CaptureConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let value: Value = serde_json::from_str(&record.json)
                .map_err(|_| dima_rust::utils::logger::SinkError::Rejected)?;
            self.records
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(value);
            Ok(())
        })
    }
}

pub struct CountingCacheSink {
    pub sets: AtomicUsize,
}

impl CountingCacheSink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sets: AtomicUsize::new(0),
        })
    }
}

impl dima_rust::utils::logger::CacheSink for CountingCacheSink {
    fn store(&self, _record: dima_rust::utils::logger::CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.sets.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
    }
}

/// Native logger with a capturing console sink and an in-memory cache sink.
pub fn capture_logger() -> (Logger, Arc<CaptureConsole>, Arc<CountingCacheSink>) {
    let console = CaptureConsole::new();
    let cache = CountingCacheSink::new();
    let logger = Logger::new(
        LoggerConfig {
            min_level: Level::Trace,
            ..Default::default()
        },
        SinkHandles {
            cache: Some(cache.clone()),
            console: Some(console.clone()),
            ..Default::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("logger configuration");
    (logger, console, cache)
}

#[derive(Clone, Debug)]
pub enum ProviderReply {
    Json { status: u16, body: Value },
    InvalidJson { status: u16 },
}

#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub client_id: Option<String>,
}

struct ProviderState {
    replies: Mutex<VecDeque<ProviderReply>>,
    requests: Mutex<Vec<ProviderRequest>>,
}

/// Loopback Twitch stand-in. Replies are consumed in request order.
pub struct Provider {
    pub addr: SocketAddr,
    state: Arc<ProviderState>,
    handle: JoinHandle<()>,
}

impl Provider {
    pub async fn start(replies: Vec<ProviderReply>) -> Self {
        let state = Arc::new(ProviderState {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/oauth2/validate", any(provider_handler))
            .route("/helix/users", any(provider_handler))
            .with_state(state.clone());
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("provider listener");
        let addr = listener.local_addr().expect("provider address");
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            addr,
            state,
            handle,
        }
    }

    pub fn validate_url(&self) -> String {
        format!("http://{}/oauth2/validate", self.addr)
    }

    pub fn users_url(&self) -> String {
        format!("http://{}/helix/users", self.addr)
    }

    pub fn requests(&self) -> Vec<ProviderRequest> {
        self.state
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn pending_replies(&self) -> usize {
        self.state
            .replies
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn provider_handler(State(state): State<Arc<ProviderState>>, request: Request) -> Response {
    let headers = request.headers();
    state
        .requests
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(ProviderRequest {
            path: request.uri().path().to_owned(),
            authorization: headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            client_id: headers
                .get("client-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
        });
    let reply = state
        .replies
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .pop_front();
    match reply {
        Some(ProviderReply::Json { status, body }) => (
            StatusCode::from_u16(status).expect("provider status"),
            Json(body),
        )
            .into_response(),
        Some(ProviderReply::InvalidJson { status }) => {
            let mut response = StatusCode::from_u16(status)
                .expect("provider status")
                .into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            *response.body_mut() = Body::from("{not-json");
            response
        }
        None => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A loopback URL whose listener was closed again, so connections are refused.
pub async fn closed_endpoint() -> String {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("ephemeral listener");
    let addr = listener.local_addr().expect("ephemeral address");
    drop(listener);
    format!("http://{addr}")
}

/// Serves a protected test router through a real Axum HTTP server with a
/// per-request telemetry context, so `bind_channel` behavior is observable.
pub struct AppServer {
    pub addr: SocketAddr,
    handle: JoinHandle<()>,
}

pub async fn serve_app(app: Router<()>, context_channel: &'static str) -> AppServer {
    let app = app.layer(axum::middleware::from_fn(
        move |request: Request, next: axum::middleware::Next| async move {
            let context = dima_rust::utils::observability::TraceContext {
                trace_id: "0123456789abcdef0123456789abcdef".into(),
                span_id: "0123456789abcdef".into(),
                sampled: false,
                channel: context_channel.into(),
                outcome: None,
            };
            dima_rust::utils::observability::with_telemetry_context(context, next.run(request))
                .await
        },
    ));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("app listener");
    let addr = listener.local_addr().expect("app address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    AppServer { addr, handle }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub fn app_url(addr: SocketAddr, path: &str) -> String {
    format!("http://{addr}{path}")
}

pub async fn get_with_token(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
) -> (u16, Value) {
    let mut request = client.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("app response");
    let status = response.status().as_u16();
    let bytes = response.bytes().await.expect("app body");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

// ---------------------------------------------------------------------------
// Scripted Redis protocol server
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StubFailure {
    None,
    /// Every command fails with an error reply.
    All,
    /// Only `HGETALL` fails.
    Hgetall,
    /// Only `HSET` fails.
    Hset,
    /// Only `EXISTS` fails.
    Exists,
    /// Only `SET` fails.
    Set,
    /// Only `EXPIRE` fails, matching a cache TTL write failure.
    Expire,
    /// Close the connection on the first data command and stop accepting.
    CloseAll,
}

struct StubState {
    hash: Mutex<Vec<(String, String)>>,
    exists: Mutex<bool>,
    failure: StubFailure,
    commands: Mutex<Vec<Vec<String>>>,
}

/// Minimal RESP2 server that records commands and injects cache failures.
pub struct RedisStub {
    pub url: String,
    state: Arc<StubState>,
    handle: JoinHandle<()>,
}

impl RedisStub {
    pub async fn start(failure: StubFailure, exists: bool) -> Self {
        let state = Arc::new(StubState {
            hash: Mutex::new(Vec::new()),
            exists: Mutex::new(exists),
            failure,
            commands: Mutex::new(Vec::new()),
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("redis stub listener");
        let addr = listener.local_addr().expect("redis stub address");
        let shared = state.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let state = shared.clone();
                let outcome =
                    tokio::spawn(async move { serve_stub_connection(stream, state).await }).await;
                if failure == StubFailure::CloseAll {
                    // One connected client observed an outage, then the server
                    // stops accepting so reconnects fail like a dead cache.
                    return;
                }
                let _ = outcome;
            }
        });
        Self {
            url: format!("redis://{addr}"),
            state,
            handle,
        }
    }

    pub fn command_names(&self) -> Vec<String> {
        self.state
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|command| command[0].to_ascii_uppercase())
            .filter(|name| name != "CLIENT" && name != "PING")
            .collect()
    }

    pub fn commands(&self) -> Vec<Vec<String>> {
        self.state
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|command| !command[0].eq_ignore_ascii_case("CLIENT"))
            .cloned()
            .collect()
    }

    pub fn hash(&self) -> Vec<(String, String)> {
        let entries = self
            .state
            .hash
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let mut collapsed: Vec<(String, String)> = Vec::new();
        for (field, value) in entries {
            match collapsed.iter_mut().find(|(name, _)| *name == field) {
                Some(slot) => slot.1 = value,
                None => collapsed.push((field, value)),
            }
        }
        collapsed
    }

    pub async fn connection(&self) -> ConnectionManager {
        let client = redis::Client::open(self.url.as_str()).expect("redis stub URL");
        client
            .get_connection_manager()
            .await
            .expect("redis stub connection manager")
    }
}

impl Drop for RedisStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn serve_stub_connection(stream: TcpStream, state: Arc<StubState>) -> io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    loop {
        let Some(command) = read_command(&mut reader).await? else {
            return Ok(());
        };
        if command.is_empty() {
            continue;
        }
        let name = command[0].to_ascii_uppercase();
        state
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(command.clone());
        match state.failure {
            StubFailure::All => {
                write.write_all(b"-ERR stub cache failure\r\n").await?;
                continue;
            }
            StubFailure::CloseAll => {
                if !matches!(name.as_str(), "CLIENT" | "PING") {
                    drop(write);
                    return Ok(());
                }
            }
            StubFailure::Hgetall if name == "HGETALL" => {
                write.write_all(b"-ERR stub hgetall failure\r\n").await?;
                continue;
            }
            StubFailure::Hset if name == "HSET" => {
                write.write_all(b"-ERR stub hset failure\r\n").await?;
                continue;
            }
            StubFailure::Exists if name == "EXISTS" => {
                write.write_all(b"-ERR stub exists failure\r\n").await?;
                continue;
            }
            StubFailure::Set if name == "SET" => {
                write.write_all(b"-ERR stub set failure\r\n").await?;
                continue;
            }
            _ => {}
        }
        match name.as_str() {
            "PING" => write.write_all(b"+PONG\r\n").await?,
            "CLIENT" => write.write_all(b"+OK\r\n").await?,
            "HGETALL" => {
                let entries = state
                    .hash
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                let mut reply = format!("*{}\r\n", entries.len() * 2);
                for (field, value) in entries {
                    reply.push_str(&format!(
                        "${}\r\n{field}\r\n${}\r\n{value}\r\n",
                        field.len(),
                        value.len()
                    ));
                }
                write.write_all(reply.as_bytes()).await?;
            }
            "HSET" => {
                if command.len() >= 4 {
                    let mut hash = state.hash.lock().unwrap_or_else(|error| error.into_inner());
                    for pair in command[2..].chunks(2) {
                        if pair.len() == 2 {
                            hash.push((pair[0].clone(), pair[1].clone()));
                        }
                    }
                }
                write.write_all(b":1\r\n").await?;
            }
            "EXPIRE" => {
                if state.failure == StubFailure::Expire {
                    write.write_all(b"-ERR stub expire failure\r\n").await?;
                } else {
                    write.write_all(b":1\r\n").await?;
                }
            }
            "EXISTS" => {
                let exists = *state
                    .exists
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                write
                    .write_all(if exists { b":1\r\n" } else { b":0\r\n" })
                    .await?;
            }
            "SET" => {
                *state
                    .exists
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = true;
                write.write_all(b"+OK\r\n").await?;
            }
            _ => write.write_all(b"+OK\r\n").await?,
        }
    }
}

async fn read_command(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> io::Result<Option<Vec<String>>> {
    let mut first = Vec::new();
    if reader.read_until(b'\n', &mut first).await? == 0 {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&first);
    let text = text.trim_end_matches(['\r', '\n']);
    if let Some(number) = text.strip_prefix('*') {
        let count: usize = number
            .parse()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "array length"))?;
        let mut command = Vec::with_capacity(count);
        for _ in 0..count {
            let mut header = Vec::new();
            reader.read_until(b'\n', &mut header).await?;
            let header = String::from_utf8_lossy(&header);
            let header = header.trim_end_matches(['\r', '\n']);
            let length: usize = header
                .strip_prefix('$')
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bulk header"))?
                .parse()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bulk length"))?;
            let mut value = vec![0_u8; length];
            reader.read_exact(&mut value).await?;
            let mut terminator = [0_u8; 2];
            reader.read_exact(&mut terminator).await?;
            command.push(String::from_utf8_lossy(&value).into_owned());
        }
        Ok(Some(command))
    } else {
        Ok(Some(text.split_whitespace().map(str::to_owned).collect()))
    }
}

/// Task-owned Mongo/Redis namespace derived from the driver fixture env.
pub struct Fixtures {
    pub database: mongodb::Database,
    pub redis: ConnectionManager,
    pub raw_redis: redis::Client,
    pub stem: String,
    pub mongo_client: mongodb::Client,
}

pub async fn fixtures(suffix: &str) -> Fixtures {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")
            .as_deref()
            .ok(),
        Some("dimabot-migration"),
        "task-owned fixture owner marker"
    );
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").expect("fixture Mongo URI");
    let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").expect("fixture Redis URL");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    let alphanumeric: String = namespace
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let hex = alphanumeric.trim_start_matches("keywordfixture").to_owned();
    assert!(!hex.is_empty(), "fixture namespace must carry an id");
    let clean = suffix.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let stem = format!("api-auth-{hex}-{clean}");
    let database_name = format!("api_auth_{hex}_{clean}");
    let mongo_client = mongodb::Client::with_uri_str(mongo_uri)
        .await
        .expect("fixture Mongo client");
    let database = mongo_client.database(&database_name);
    let raw_redis = redis::Client::open(redis_url.clone()).expect("fixture Redis URL");
    let redis = raw_redis
        .get_connection_manager()
        .await
        .expect("fixture Redis manager");
    Fixtures {
        database,
        redis,
        raw_redis,
        stem,
        mongo_client,
    }
}

impl Fixtures {
    pub fn token(&self, suffix: &str) -> String {
        format!("{}-token-{suffix}", self.stem)
    }

    pub fn user_id(&self, suffix: &str) -> String {
        format!("{}-user-{suffix}", self.stem)
    }

    pub fn db_name(&self) -> String {
        self.database.name().to_owned()
    }

    /// Removes only this task's namespace: one database and its prefixed keys.
    pub async fn cleanup(&self, tokens: &[String], user_ids: &[String]) {
        self.purge(tokens, user_ids).await;
        let _ = self.database.drop().await;
    }

    /// Deletes only the Redis keys this task owns.
    pub async fn purge(&self, tokens: &[String], user_ids: &[String]) {
        let Ok(mut connection) = self.raw_redis.get_multiplexed_async_connection().await else {
            return;
        };
        let mut keys = Vec::new();
        for token in tokens {
            keys.push(format!("token:{token}"));
        }
        for id in user_ids {
            keys.push(format!("twitch:{id}:last_app_activity_touch"));
        }
        for key in keys {
            let _: Result<i64, redis::RedisError> = AsyncCommands::del(&mut connection, key).await;
        }
    }
}

/// Reads a live TTL without following the connection manager's clone.
pub async fn ttl(redis: &redis::Client, key: &str) -> i64 {
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    redis::cmd("TTL")
        .arg(key)
        .query_async::<i64>(&mut connection)
        .await
        .expect("redis ttl")
}

pub fn assert_relative_to_now(millis: i64, slack: i64) {
    let now = mongodb::bson::DateTime::now().timestamp_millis();
    assert!(
        (now - millis).abs() <= slack,
        "timestamp {millis} is not within {slack} ms of {now}"
    );
}

pub fn read_json_file(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("json file")).expect("json contents")
}

/// Small helper for the logger mapping assertions.
pub fn stats_of(logger: &Logger) -> LoggerStats {
    logger.stats()
}
