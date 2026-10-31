#![cfg(feature = "api-validation-route")]

//! Functional checks for the native validation route.
//!
//! Two layers are exercised:
//!
//! - a fixture replay of the actual TypeScript route (transpiled by the pinned
//!   compiler) recorded in `tests/fixtures/validation_route_reference.cjs`; the
//!   native router runs behind a real loopback Axum server and a recording
//!   RESP2 cache, and every case compares status, body, Redis command order and
//!   logger payloads;
//! - composed checks with the real native `AuthService` middleware and the
//!   task-owned Dragonfly/MongoDB fixtures, plus a loopback Twitch provider.
//!
//! No Twitch credential, production service or shared resource is used.

#[path = "support/api_auth_support.rs"]
mod support;

use dima_rust::{
    api_auth::{AuthConfig, AuthService},
    validation_route::{
        INTERNAL_ERROR_MESSAGE, NOT_ADMIN_MESSAGE, VALIDATION_SUCCESS_MESSAGE,
        ValidationRouteService, admin_details_key, admins_key, token_key,
    },
};
use mongodb::bson::Document;
use redis::{AsyncCommands, aio::ConnectionManager};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use support::{AppServer, Fixtures, Provider, ProviderReply, fixtures};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

const FIXTURE_ACQUIRE_ERROR: &str = "acquire-error";

fn fixture_directory() -> PathBuf {
    let directory = PathBuf::from(
        std::env::var_os("DIMA_VALIDATION_ROUTE_FIXTURE_DIR").expect("external fixture directory"),
    );
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert_eq!(
        directory.canonicalize().expect("fixture directory"),
        directory
    );
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory")
        .parent()
        .expect("workspace root")
        .to_path_buf();
    assert!(
        !directory.starts_with(&workspace),
        "fixture must live outside the workspace"
    );
    directory
}

fn fixture() -> Value {
    let directory = fixture_directory();
    let expected = std::env::var("DIMA_VALIDATION_ROUTE_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture digest must be lowercase hex"
    );
    let file = directory.join("validation-route-reference.json");
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file(),
        "fixture must be a regular file"
    );
    let bytes = std::fs::read(&file).expect("fixture bytes");
    assert_eq!(
        support::sha256_hex(&bytes),
        expected,
        "fixture digest mismatch"
    );
    serde_json::from_slice(&bytes).expect("fixture JSON")
}

fn expected_success() -> Value {
    json!({"error": false, "message": VALIDATION_SUCCESS_MESSAGE, "access": true, "status": 200})
}

fn expected_invalid_token() -> Value {
    json!({"error": true, "message": "Invalid token", "access": false, "status": 400})
}

fn expected_missing_token() -> Value {
    json!({"error": true, "message": "Missing token", "access": false, "status": 400})
}

fn expected_not_admin() -> Value {
    json!({"error": true, "message": NOT_ADMIN_MESSAGE, "access": false, "status": 403})
}

fn expected_internal_error() -> Value {
    json!({"error": true, "message": INTERNAL_ERROR_MESSAGE, "access": false, "status": 500})
}

// ---------------------------------------------------------------------------
// Recording RESP2 cache
// ---------------------------------------------------------------------------

/// One cache command the route issued, as `[command, key, ...]`.
type Command = Vec<String>;

struct RecorderState {
    hashes: HashMap<String, HashMap<String, String>>,
    sets: HashMap<String, HashSet<String>>,
    keys: HashSet<String>,
    fail: Option<(String, usize)>,
    seen: Mutex<HashMap<String, usize>>,
    commands: Mutex<Vec<Command>>,
    outage: AtomicBool,
}

/// Loopback RESP2 server that seeds the route's cache and records commands.
struct Recorder {
    addr: SocketAddr,
    state: Arc<RecorderState>,
    handle: JoinHandle<()>,
}

impl Recorder {
    async fn start(seed: &Value, fail: Option<(String, usize)>) -> Self {
        let mut hashes = HashMap::new();
        if let Some(entries) = seed["hash"].as_object() {
            for (key, fields) in entries {
                let mut hash = HashMap::new();
                for (field, value) in fields.as_object().expect("hash fields") {
                    hash.insert(
                        field.clone(),
                        value.as_str().expect("hash value").to_owned(),
                    );
                }
                hashes.insert(key.clone(), hash);
            }
        }
        let mut sets = HashMap::new();
        if let Some(entries) = seed["sets"].as_object() {
            for (key, members) in entries {
                let members = members
                    .as_array()
                    .expect("set members")
                    .iter()
                    .map(|member| member.as_str().expect("set member").to_owned())
                    .collect();
                sets.insert(key.clone(), members);
            }
        }
        let keys = seed["keys"]
            .as_array()
            .map(|keys| {
                keys.iter()
                    .map(|key| key.as_str().expect("key").to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let state = Arc::new(RecorderState {
            hashes,
            sets,
            keys,
            fail,
            seen: Mutex::new(HashMap::new()),
            commands: Mutex::new(Vec::new()),
            outage: AtomicBool::new(false),
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("recorder listener");
        let addr = listener.local_addr().expect("recorder address");
        let shared = state.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let state = shared.clone();
                tokio::spawn(async move {
                    let _ = serve_recorder_connection(stream, state).await;
                });
            }
        });
        Self {
            addr,
            state,
            handle,
        }
    }

    fn url(&self) -> String {
        format!("redis://{}", self.addr)
    }

    async fn manager(&self) -> ConnectionManager {
        let client = redis::Client::open(self.url()).expect("recorder URL");
        client
            .get_connection_manager()
            .await
            .expect("recorder connection manager")
    }

    fn commands(&self) -> Vec<Command> {
        self.state
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn outage(&self) {
        self.state.outage.store(true, Ordering::SeqCst);
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn serve_recorder_connection(stream: TcpStream, state: Arc<RecorderState>) -> io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    loop {
        if state.outage.load(Ordering::SeqCst) {
            return Ok(());
        }
        let Some(command) = read_recorder_command(&mut reader).await? else {
            return Ok(());
        };
        if command.is_empty() {
            continue;
        }
        let name = command[0].to_ascii_uppercase();
        if state.outage.load(Ordering::SeqCst) {
            return Ok(());
        }
        match name.as_str() {
            "PING" => write.write_all(b"+PONG\r\n").await?,
            "CLIENT" => write.write_all(b"+OK\r\n").await?,
            "HGET" | "SISMEMBER" | "EXISTS" => {
                let seen = {
                    let mut counts = state.seen.lock().unwrap_or_else(|error| error.into_inner());
                    let count = counts.entry(name.clone()).or_insert(0);
                    *count += 1;
                    *count
                };
                state
                    .commands
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(command.clone());
                if let Some((fail_name, skip)) = &state.fail
                    && fail_name.as_str() == name
                    && seen > *skip
                {
                    write.write_all(b"-ERR injected failure\r\n").await?;
                    continue;
                }
                let key = command.get(1).map(String::as_str).unwrap_or_default();
                match name.as_str() {
                    "HGET" => {
                        let field = command.get(2).map(String::as_str).unwrap_or_default();
                        let value = state
                            .hashes
                            .get(key)
                            .and_then(|fields| fields.get(field))
                            .cloned();
                        match value {
                            Some(value) => {
                                write
                                    .write_all(
                                        format!("${}\r\n{value}\r\n", value.len()).as_bytes(),
                                    )
                                    .await?;
                            }
                            None => write.write_all(b"$-1\r\n").await?,
                        }
                    }
                    "SISMEMBER" => {
                        let member = command.get(2).map(String::as_str).unwrap_or_default();
                        let present = state
                            .sets
                            .get(key)
                            .is_some_and(|members| members.contains(member));
                        write
                            .write_all(if present { b":1\r\n" } else { b":0\r\n" })
                            .await?;
                    }
                    _ => {
                        let present = state.keys.contains(key);
                        write
                            .write_all(if present { b":1\r\n" } else { b":0\r\n" })
                            .await?;
                    }
                }
            }
            _ => write.write_all(b"+OK\r\n").await?,
        }
    }
}

async fn read_recorder_command(
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("test HTTP client")
}

async fn post_response(
    addr: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
) -> (u16, Value, Option<String>) {
    let client = http_client();
    let mut request = client.post(format!("http://{addr}{path}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("route response");
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await.expect("route body");
    (
        status,
        serde_json::from_slice(&bytes).expect("JSON body"),
        content_type,
    )
}

async fn post(addr: SocketAddr, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
    let (status, body, _content_type) = post_response(addr, path, headers).await;
    (status, body)
}

async fn post_timed(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
) -> Result<(u16, Value, Duration), reqwest::Error> {
    let started = Instant::now();
    let mut request = client.post(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        started.elapsed(),
    ))
}

async fn serve_route(service: &ValidationRouteService) -> AppServer {
    support::serve_app(service.router(), "validation-unbound").await
}

async fn serve_composed(
    service: &ValidationRouteService,
    fx: &Fixtures,
    provider: &Provider,
) -> AppServer {
    let auth = AuthService::new(
        AuthConfig::new(provider.validate_url(), provider.users_url())
            .with_client_id("fixture-client"),
        http_client(),
        fx.redis.clone(),
        fx.database.collection::<Document>("users"),
        None,
    )
    .expect("valid auth service configuration");
    support::serve_app(auth.protect(service.router()), "validation-unbound").await
}

// ---------------------------------------------------------------------------
// Source oracle replay
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn replays_the_source_oracle_cases() {
    let fixture = fixture();
    assert_eq!(
        fixture["source"]["file"],
        "src/server/routes/validation.route.ts"
    );
    assert_eq!(fixture["route"]["export"], "validationRoute");
    assert_eq!(fixture["route"]["path"], "/:channelID");
    assert_eq!(fixture["route"]["methods"], json!(["post"]));
    assert_eq!(
        fixture["requireCalls"],
        json!([
            "express",
            "../../utils/databases/dragonfly.database.js",
            "../../middleware/auth.middleware.js"
        ])
    );
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 19, "fixture coverage");
    let mut replayed = 0;
    let mut construction_boundaries = 0;
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let request = &case["request"];
        if request["clientError"].as_bool().unwrap_or(false) {
            // The source acquires the cache client per request; the native
            // service receives it once, so this case is proven separately by
            // `acquisition_failure_is_a_construction_error`.
            assert_eq!(name, FIXTURE_ACQUIRE_ERROR);
            assert_eq!(case["expected"]["noResponse"], true);
            construction_boundaries += 1;
            continue;
        }
        let fail = request["cacheError"].as_object().map(|failure| {
            (
                failure
                    .get("command")
                    .and_then(Value::as_str)
                    .expect("failure command")
                    .to_owned(),
                failure.get("skip").and_then(Value::as_u64).unwrap_or(0) as usize,
            )
        });
        let recorder = Recorder::start(&case["seed"], fail).await;
        let (logger, console, _cache) = support::capture_logger();
        let service = ValidationRouteService::new(recorder.manager().await, Some(logger));
        let server = serve_route(&service).await;
        // undici folded the oracle's repeated `Headers` values into one
        // comma-separated line before sending, so the fixture records that
        // effective value. Node's server would itself discard repeated
        // `authorization` lines and keep the first (see `raw_authorization`).
        let joined_duplicate = request["duplicateAuthorization"].as_array().map(|values| {
            values
                .iter()
                .map(|value| value.as_str().expect("duplicate header"))
                .collect::<Vec<_>>()
                .join(", ")
        });
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(joined) = &joined_duplicate {
            headers.push(("authorization", joined.as_str()));
        } else if let Some(header_name) = request["headerName"].as_str() {
            headers.push((
                header_name,
                request["authorization"].as_str().expect("authorization"),
            ));
        }
        let path = request["path"].as_str().expect("path");
        let (status, body, content_type) = post_response(server.addr, path, &headers).await;
        let expected = &case["expected"];
        let boundary = expected["noResponse"].as_bool().unwrap_or(false);

        if boundary {
            // Documented boundary: a Redis command failure completes as a
            // native 500 where the source never answers.
            assert_eq!(status, 500, "{name}: native completed boundary");
            assert_eq!(body, expected_internal_error(), "{name}: boundary body");
            assert_eq!(
                content_type.as_deref(),
                Some("application/json; charset=utf-8"),
                "{name}: boundary content type"
            );
        } else {
            assert_eq!(
                expected["status"].as_u64(),
                Some(u64::from(status)),
                "{name}: status"
            );
            assert_eq!(&body, &expected["body"], "{name}: body");
            assert_eq!(
                content_type.as_deref(),
                expected["contentType"].as_str(),
                "{name}: content type"
            );
        }

        let commands: Vec<Value> = recorder
            .commands()
            .into_iter()
            .map(|command| json!(command))
            .collect();
        assert_eq!(
            &Value::Array(commands),
            &expected["commands"],
            "{name}: commands"
        );

        let records = console.records();
        let errors: Vec<&Value> = records
            .iter()
            .filter(|record| record["level"] == "error")
            .collect();
        if boundary {
            // The source emits no console.error before the rejection; the port
            // adds one native diagnostic record.
            assert_eq!(errors.len(), 1, "{name}: native diagnostic");
            assert_eq!(errors[0]["data"]["function"], "validationRoute");
            assert_eq!(errors[0]["channelId"], case["request"]["channel"]);
        } else {
            let expected_logs = expected["logs"].as_array().expect("logs");
            assert_eq!(errors.len(), expected_logs.len(), "{name}: log count");
            for (record, expected_log) in errors.iter().zip(expected_logs) {
                let mut actual = record["data"].clone();
                let _ = actual
                    .as_object_mut()
                    .expect("payload object")
                    .remove("timestamp");
                let mut payload = expected_log["payload"].clone();
                let _ = payload
                    .as_object_mut()
                    .expect("payload object")
                    .remove("timestamp");
                assert_eq!(actual, payload, "{name}: log payload");
                assert_eq!(
                    record["channelId"], expected_log["channel"],
                    "{name}: log channel"
                );
            }
        }
        let expected_header = match request["duplicateAuthorization"].as_array() {
            Some(values) => json!(
                values
                    .iter()
                    .map(|value| value.as_str().expect("duplicate header"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => request["authorization"]
                .as_str()
                .map_or(Value::Null, |value| json!(value)),
        };
        assert_eq!(
            case["observed"]["authorization"], expected_header,
            "{name}: observed header"
        );
        replayed += 1;
    }
    assert_eq!(construction_boundaries, 1);
    assert_eq!(replayed, cases.len() - construction_boundaries);
}

// ---------------------------------------------------------------------------
// Cache failure boundaries
// ---------------------------------------------------------------------------

#[tokio::test]
async fn acquisition_failure_is_a_construction_error() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("ephemeral listener");
    let addr = listener.local_addr().expect("ephemeral address");
    drop(listener);
    let client = redis::Client::open(format!("redis://{addr}")).expect("closed URL");
    let error = client
        .get_connection_manager()
        .await
        .expect_err("a closed port must not produce a manager");
    assert!(!error.to_string().is_empty());
}

#[tokio::test]
async fn command_failure_completes_500_without_replay() {
    let recorder = Recorder::start(
        &json!({"hash": {"token:owner-token": {"id": "owner-channel", "login": "owner"}}}),
        Some(("HGET".to_owned(), 0)),
    )
    .await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    let (status, body) = post(
        server.addr,
        "/owner-channel",
        &[("authorization", "owner-token")],
    )
    .await;
    assert_eq!(status, 500);
    assert_eq!(body, expected_internal_error());
    let commands = recorder.commands();
    assert_eq!(commands.len(), 1, "no replay or continuation: {commands:?}");
    assert_eq!(commands[0], vec!["HGET", "token:owner-token", "id"]);
}

#[tokio::test]
async fn outage_completes_500_without_hanging_or_replaying() {
    let recorder = Recorder::start(&json!({}), None).await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    recorder.outage();
    let result = post_timed(
        &http_client(),
        &format!("http://{}/channel-1", server.addr),
        &[("authorization", "any-token")],
    )
    .await
    .expect("the outage must produce a completed response");
    assert_eq!(result.0, 500);
    assert_eq!(result.1, expected_internal_error());
    assert!(result.2 < Duration::from_secs(3), "no hang: {:?}", result.2);
    assert!(
        recorder.commands().is_empty(),
        "no command is replayed after the outage"
    );
}

// ---------------------------------------------------------------------------
// Command order, keys and logs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_path_preserves_source_command_order_and_keys() {
    let recorder = Recorder::start(
        &json!({
            "hash": {"token:admin-token": {"id": "admin-user", "login": "moduser"}},
            "sets": {"twitch:channel-1:admins": ["moduser"]},
            "keys": ["twitch:channel-1:admins:admin-user"],
        }),
        None,
    )
    .await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    let (status, body) = post(
        server.addr,
        "/channel-1",
        &[("authorization", "admin-token")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    assert_eq!(
        recorder.commands(),
        vec![
            vec!["HGET", "token:admin-token", "id"],
            vec!["HGET", "token:admin-token", "login"],
            vec!["SISMEMBER", "twitch:channel-1:admins", "moduser"],
            vec!["EXISTS", "twitch:channel-1:admins:admin-user"],
        ]
    );
}

#[tokio::test]
async fn owner_path_stops_before_admin_commands() {
    let recorder = Recorder::start(
        &json!({"hash": {"token:owner-token": {"id": "owner-channel", "login": "owner"}}}),
        None,
    )
    .await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    let (status, _body) = post(
        server.addr,
        "/owner-channel",
        &[("authorization", "owner-token")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        recorder.commands(),
        vec![
            vec!["HGET", "token:owner-token", "id"],
            vec!["HGET", "token:owner-token", "login"],
        ]
    );
}

#[tokio::test]
async fn raw_bearer_header_is_not_stripped() {
    let recorder = Recorder::start(&json!({}), None).await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    let (status, body) = post(
        server.addr,
        "/owner-channel",
        &[("authorization", "Bearer owner-token")],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body, expected_invalid_token());
    assert_eq!(
        recorder.commands()[0],
        vec!["HGET", "token:Bearer owner-token", "id"]
    );
}

#[tokio::test]
async fn denial_logs_match_the_source_fields() {
    // Not a member: logs `userCacheLogin`.
    let recorder = Recorder::start(
        &json!({"hash": {"token:viewer-token": {"id": "viewer-user", "login": "viewer"}}}),
        None,
    )
    .await;
    let (logger, console, _cache) = support::capture_logger();
    let service = ValidationRouteService::new(recorder.manager().await, Some(logger));
    let server = serve_route(&service).await;
    let (status, _body) = post(
        server.addr,
        "/channel-1",
        &[("authorization", "viewer-token")],
    )
    .await;
    assert_eq!(status, 403);
    let records = console.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["level"], "error");
    assert_eq!(records[0]["channelId"], "channel-1");
    let payload = &records[0]["data"];
    assert_eq!(payload["error"], true);
    assert_eq!(payload["message"], NOT_ADMIN_MESSAGE);
    assert_eq!(payload["channelID"], "channel-1");
    assert_eq!(payload["userCacheLogin"], "viewer");
    assert!(payload.get("userCacheID").is_none());
    assert_eq!(payload["timestamp"].as_str().expect("timestamp").len(), 24);

    // Member without the details key: logs `userCacheID`.
    let recorder = Recorder::start(
        &json!({
            "hash": {"token:admin-token": {"id": "admin-user", "login": "moduser"}},
            "sets": {"twitch:channel-1:admins": ["moduser"]},
        }),
        None,
    )
    .await;
    let (logger, console, _cache) = support::capture_logger();
    let service = ValidationRouteService::new(recorder.manager().await, Some(logger));
    let server = serve_route(&service).await;
    let (status, _body) = post(
        server.addr,
        "/channel-1",
        &[("authorization", "admin-token")],
    )
    .await;
    assert_eq!(status, 403);
    let records = console.records();
    assert_eq!(records.len(), 1);
    let payload = &records[0]["data"];
    assert_eq!(payload["message"], NOT_ADMIN_MESSAGE);
    assert_eq!(payload["userCacheID"], "admin-user");
    assert!(payload.get("userCacheLogin").is_none());
}

// ---------------------------------------------------------------------------
// Composed AuthService + Dragonfly checks
// ---------------------------------------------------------------------------

fn validate_ok() -> ProviderReply {
    ProviderReply::Json {
        status: 200,
        body: json!({
            "client_id": "fixture-client",
            "login": "alpha",
            "scopes": ["user:read:email"],
            "user_id": "1001",
            "expires_in": 14124,
        }),
    }
}

fn users_ok(id: &str, login: &str) -> ProviderReply {
    ProviderReply::Json {
        status: 200,
        body: json!({"data": [{
            "id": id,
            "login": login,
            "display_name": "Fixture",
            "profile_image_url": "https://static.invalid/fixture.png",
            "type": "",
            "broadcaster_type": "",
            "created_at": "2020-01-01T00:00:00Z"
        }]}),
    }
}

async fn seed_identity(fx: &Fixtures, token: &str, id: &str, login: &str) {
    let mut connection = fx.redis.clone();
    let _: () = connection
        .hset_multiple(token_key(token), &[("id", id), ("login", login)])
        .await
        .expect("seed token hash");
}

async fn seed_admin(fx: &Fixtures, channel: &str, id: &str, login: &str) {
    let mut connection = fx.redis.clone();
    let _: i64 = redis::cmd("SADD")
        .arg(admins_key(channel))
        .arg(login)
        .query_async(&mut connection)
        .await
        .expect("seed admin set");
    let _: () = connection
        .set(admin_details_key(channel, id), "1")
        .await
        .expect("seed admin details");
}

async fn ttl(fx: &Fixtures, key: &str) -> i64 {
    let mut connection = fx
        .raw_redis
        .get_multiplexed_async_connection()
        .await
        .expect("raw redis connection");
    redis::cmd("TTL")
        .arg(key)
        .query_async::<i64>(&mut connection)
        .await
        .expect("ttl")
}

async fn exists(fx: &Fixtures, key: &str) -> bool {
    let mut connection = fx.redis.clone();
    connection.exists(key).await.expect("exists")
}

async fn del_keys(fx: &Fixtures, keys: &[String]) {
    let Ok(mut connection) = fx.raw_redis.get_multiplexed_async_connection().await else {
        return;
    };
    for key in keys {
        let _: Result<i64, redis::RedisError> =
            redis::AsyncCommands::del(&mut connection, key).await;
    }
}

async fn delivery(fx: &Fixtures, keys: &[String], tokens: &[String], user_ids: &[String]) {
    del_keys(fx, keys).await;
    fx.cleanup(tokens, user_ids).await;
}

#[tokio::test]
async fn composed_owner_with_cached_raw_token() {
    let fx = fixtures("composed-owner").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("owner");
    let channel = fx.user_id("channel");
    seed_identity(&fx, &token, &channel, "owner").await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(server.addr, &path, &[("authorization", token.as_str())]).await;
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    assert!(provider.requests().is_empty(), "cache hit skips Twitch");
    let activity = format!("twitch:{channel}:last_app_activity_touch");
    assert!(exists(&fx, &activity).await, "activity throttle");
    assert!(
        (86_000..=86_400).contains(&ttl(&fx, &activity).await),
        "activity TTL"
    );
    delivery(&fx, &[activity, admins_key(&channel)], &[token], &[channel]).await;
}

#[tokio::test]
async fn composed_bearer_header_authenticates_but_route_rejects() {
    let fx = fixtures("composed-bearer").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("bearer");
    let channel = fx.user_id("channel");
    seed_identity(&fx, &token, &channel, "owner").await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let authorization = format!("Bearer {token}");
    let path = format!("/{channel}");
    let (status, body) = post(
        server.addr,
        &path,
        &[("authorization", authorization.as_str())],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body, expected_invalid_token());
    assert!(
        provider.requests().is_empty(),
        "auth cache hit skips Twitch"
    );
    let activity = format!("twitch:{channel}:last_app_activity_touch");
    assert!(
        exists(&fx, &activity).await,
        "the middleware authenticated the stripped token"
    );
    delivery(&fx, &[activity], &[token], &[channel]).await;
}

#[tokio::test]
async fn composed_missing_header_is_the_middleware_401() {
    let fx = fixtures("composed-missing").await;
    let provider = Provider::start(Vec::new()).await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let client = http_client();
    let response = client
        .post(format!("http://{}/channel-1", server.addr))
        .send()
        .await
        .expect("401 response");
    assert_eq!(response.status().as_u16(), 401);
    let body: Value = serde_json::from_slice(&response.bytes().await.expect("body")).expect("JSON");
    assert_eq!(
        body,
        json!({"error": true, "message": "No token provided", "status": 401, "type": "no_token"})
    );
    assert!(provider.requests().is_empty());
}

#[tokio::test]
async fn composed_duplicate_authorization_lines_use_the_first_value() {
    let fx = fixtures("composed-duplicate").await;
    let provider = Provider::start(Vec::new()).await;
    let first = fx.token("first");
    let second = fx.token("second");
    let channel = fx.user_id("channel");
    let viewer = fx.user_id("viewer");
    seed_identity(&fx, &first, &channel, "owner").await;
    seed_identity(&fx, &second, &viewer, "viewer").await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(
        server.addr,
        &path,
        &[
            ("authorization", first.as_str()),
            ("authorization", second.as_str()),
        ],
    )
    .await;
    // Node treats `authorization` as a singleton header and keeps the first
    // line, for both the middleware and the route. `second` is a non-admin
    // viewer here, so using it would answer 403 instead of this owner success.
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    assert!(
        provider.requests().is_empty(),
        "both cache hits skip Twitch"
    );
    delivery(&fx, &[], &[first, second], &[channel, viewer]).await;
}

#[tokio::test]
async fn composed_admin_membership_and_details_pass() {
    let fx = fixtures("composed-admin").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("admin");
    let channel = fx.user_id("channel");
    let admin = fx.user_id("admin");
    seed_identity(&fx, &token, &admin, "moduser").await;
    seed_admin(&fx, &channel, &admin, "moduser").await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(server.addr, &path, &[("authorization", token.as_str())]).await;
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    delivery(
        &fx,
        &[
            admins_key(&channel),
            admin_details_key(&channel, &admin),
            format!("twitch:{admin}:last_app_activity_touch"),
        ],
        &[token],
        &[admin],
    )
    .await;
}

#[tokio::test]
async fn composed_admin_without_details_is_forbidden() {
    let fx = fixtures("composed-no-details").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("admin");
    let channel = fx.user_id("channel");
    let admin = fx.user_id("admin");
    seed_identity(&fx, &token, &admin, "moduser").await;
    let mut connection = fx.redis.clone();
    let _: i64 = redis::cmd("SADD")
        .arg(admins_key(&channel))
        .arg("moduser")
        .query_async(&mut connection)
        .await
        .expect("seed admin set");
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(server.addr, &path, &[("authorization", token.as_str())]).await;
    assert_eq!(status, 403);
    assert_eq!(body, expected_not_admin());
    delivery(
        &fx,
        &[
            admins_key(&channel),
            admin_details_key(&channel, &admin),
            format!("twitch:{admin}:last_app_activity_touch"),
        ],
        &[token],
        &[admin],
    )
    .await;
}

#[tokio::test]
async fn composed_non_admin_is_forbidden() {
    let fx = fixtures("composed-viewer").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("viewer");
    let channel = fx.user_id("channel");
    let viewer = fx.user_id("viewer");
    seed_identity(&fx, &token, &viewer, "viewer").await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(server.addr, &path, &[("authorization", token.as_str())]).await;
    assert_eq!(status, 403);
    assert_eq!(body, expected_not_admin());
    delivery(&fx, &[admins_key(&channel)], &[token], &[viewer]).await;
}

#[tokio::test]
async fn composed_cold_validation_caches_the_raw_token() {
    let fx = fixtures("composed-cold").await;
    let token = fx.token("cold");
    let channel = fx.user_id("channel");
    let provider = Provider::start(vec![validate_ok(), users_ok(&channel, "owner")]).await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let path = format!("/{channel}");
    let (status, body) = post(server.addr, &path, &[("authorization", token.as_str())]).await;
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "validate then users, once each");
    assert_eq!(requests[0].path, "/oauth2/validate");
    let expected_authorization = format!("Bearer {token}");
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some(expected_authorization.as_str())
    );
    assert_eq!(requests[1].path, "/helix/users");
    assert_eq!(requests[1].client_id.as_deref(), Some("fixture-client"));
    assert!(
        exists(&fx, &token_key(&token)).await,
        "middleware cached the raw token"
    );
    assert!(
        (13_900..=14_000).contains(&ttl(&fx, &token_key(&token)).await),
        "token cache TTL"
    );
    let activity = format!("twitch:{channel}:last_app_activity_touch");
    delivery(&fx, &[activity], &[token], &[channel]).await;
}

#[tokio::test]
async fn composed_cold_bearer_validation_caches_a_key_the_route_never_reads() {
    let fx = fixtures("composed-cold-bearer").await;
    let token = fx.token("coldbearer");
    let channel = fx.user_id("channel");
    let provider = Provider::start(vec![validate_ok(), users_ok(&channel, "owner")]).await;
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let authorization = format!("Bearer {token}");
    let path = format!("/{channel}");
    let (status, body) = post(
        server.addr,
        &path,
        &[("authorization", authorization.as_str())],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body, expected_invalid_token());
    assert_eq!(provider.requests().len(), 2, "middleware validated once");
    assert!(
        exists(&fx, &token_key(&token)).await,
        "stripped token cached"
    );
    let activity = format!("twitch:{channel}:last_app_activity_touch");
    delivery(&fx, &[activity], &[token], &[channel]).await;
}

#[tokio::test]
async fn composed_wrongtype_key_completes_500() {
    let fx = fixtures("composed-wrongtype").await;
    let provider = Provider::start(Vec::new()).await;
    let token = fx.token("wrongtype");
    let channel = fx.user_id("channel");
    seed_identity(&fx, &token, &channel, "owner").await;
    let broken = format!("Bearer {token}");
    let mut connection = fx.redis.clone();
    let _: () = connection
        .set(token_key(&broken), "not-a-hash")
        .await
        .expect("seed wrong type");
    let service = ValidationRouteService::new(fx.redis.clone(), None);
    let server = serve_composed(&service, &fx, &provider).await;
    let url = format!("http://{}/{channel}", server.addr);
    let authorization = format!("Bearer {token}");
    for attempt in 0..2 {
        let (status, body, elapsed) = post_timed(
            &http_client(),
            &url,
            &[("authorization", authorization.as_str())],
        )
        .await
        .expect("completed 500");
        assert_eq!(status, 500, "attempt {attempt}");
        assert_eq!(body, expected_internal_error());
        assert!(elapsed < Duration::from_secs(3), "no hang: {elapsed:?}");
    }
    assert!(provider.requests().is_empty(), "no Twitch call or replay");
    let activity = format!("twitch:{channel}:last_app_activity_touch");
    delivery(&fx, &[activity, token_key(&broken)], &[token], &[channel]).await;
}

#[tokio::test]
async fn mounted_router_reports_the_prefixed_path() {
    let recorder = Recorder::start(
        &json!({"hash": {"token:owner-token": {"id": "owner-channel", "login": "owner"}}}),
        None,
    )
    .await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server =
        support::serve_app(service.mounted_router("/validate"), "validation-unbound").await;
    let (status, body) = post(
        server.addr,
        "/validate/owner-channel",
        &[("authorization", "owner-token")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body, expected_success());
    let (missing, missing_body) = post(server.addr, "/validate/channel-9", &[]).await;
    assert_eq!(missing, 400);
    assert_eq!(missing_body, expected_missing_token());
}

#[tokio::test]
async fn direct_router_without_middleware_keeps_the_source_400() {
    let recorder = Recorder::start(&json!({}), None).await;
    let service = ValidationRouteService::new(recorder.manager().await, None);
    let server = serve_route(&service).await;
    let (status, body) = post(server.addr, "/channel-1", &[]).await;
    assert_eq!(status, 400, "the source handler's own missing-token branch");
    assert_eq!(body, expected_missing_token());
    assert!(recorder.commands().is_empty());
}
