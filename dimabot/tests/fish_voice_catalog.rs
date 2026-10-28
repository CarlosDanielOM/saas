#![cfg(feature = "tts-services")]

use dima_rust::tts_services::fish_voice_catalog::{
    FishCatalog, FishCatalogConfig, FishCatalogError, FishVoiceSearch, JsonValue,
    normalize_fish_voice, normalize_fish_voice_json, parse_json, parse_voice_search_json,
    resolve_fish_voice,
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const WAIT: Duration = Duration::from_secs(3);
const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VOICE: &str = r#"{"_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Fixture","type":"tts","visibility":"public","languages":["en"],"tags":["female","warm"],"licensed":true,"task_count":2.9}"#;

#[derive(Debug)]
struct Request {
    line: String,
    headers: BTreeMap<String, String>,
    connection: usize,
}
enum Reply {
    Response(u16, String),
    Raw(Vec<u8>),
    HoldHeaders,
    HoldBody,
}

struct Server {
    endpoint: String,
    requests: mpsc::UnboundedReceiver<Request>,
    closed: mpsc::UnboundedReceiver<usize>,
    replies: Arc<Mutex<VecDeque<Reply>>>,
    task: JoinHandle<()>,
}
impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/model", listener.local_addr().unwrap());
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let queue = Arc::clone(&replies);
        let (tx, requests) = mpsc::unbounded_channel();
        let (closed_tx, closed) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            let connections = AtomicUsize::new(0);
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let connection = connections.fetch_add(1, Ordering::Relaxed);
                let tx = tx.clone();
                let closed_tx = closed_tx.clone();
                let queue = Arc::clone(&queue);
                children
                    .spawn(async move { serve(socket, connection, tx, closed_tx, queue).await });
            }
        });
        Self {
            endpoint,
            requests,
            closed,
            replies,
            task,
        }
    }
    fn push(&self, reply: Reply) {
        self.replies.lock().unwrap().push_back(reply);
    }
    async fn next(&mut self) -> Request {
        timeout(WAIT, self.requests.recv())
            .await
            .expect("request timed out")
            .expect("server stopped")
    }
    async fn no_more(&mut self) {
        assert!(
            timeout(Duration::from_millis(40), self.requests.recv())
                .await
                .is_err(),
            "unexpected request"
        );
    }
    async fn closed(&mut self, connection: usize) {
        assert_eq!(
            timeout(WAIT, self.closed.recv())
                .await
                .expect("timed out waiting for client socket cleanup"),
            Some(connection)
        );
    }
    fn config(&self) -> FishCatalogConfig {
        let mut config = FishCatalogConfig::new(Some(" fixture-key ".into()));
        config.endpoint = self.endpoint.clone();
        config.timeout = Duration::from_millis(200);
        config
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(
    mut socket: TcpStream,
    connection: usize,
    tx: mpsc::UnboundedSender<Request>,
    closed: mpsc::UnboundedSender<usize>,
    queue: Arc<Mutex<VecDeque<Reply>>>,
) {
    loop {
        let mut head = Vec::new();
        loop {
            let mut byte = [0];
            match socket.read(&mut byte).await {
                Ok(0) | Err(_) => return,
                Ok(_) => head.push(byte[0]),
            }
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(head.len() < 16384, "oversized request headers");
        }
        let head = String::from_utf8(head).unwrap();
        let mut lines = head.split("\r\n");
        let line = lines.next().unwrap().to_owned();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        let reply = queue
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Reply::Response(200, VOICE.into()));
        if tx
            .send(Request {
                line,
                headers,
                connection,
            })
            .is_err()
        {
            return;
        }
        match reply {
            Reply::Response(status, body) => {
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                if socket.write_all(response.as_bytes()).await.is_err() {
                    return;
                }
            }
            Reply::Raw(bytes) => {
                let _ = socket.write_all(&bytes).await;
                return;
            }
            Reply::HoldHeaders => {
                let mut byte = [0];
                let _ = socket.read(&mut byte).await;
                let _ = closed.send(connection);
                return;
            }
            Reply::HoldBody => {
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                    .await;
                let mut byte = [0];
                let _ = socket.read(&mut byte).await;
                let _ = closed.send(connection);
                return;
            }
        }
    }
}
fn request_error(error: FishCatalogError, status: u16, code: &str, message: &str) {
    match error {
        FishCatalogError::Request(error) => {
            assert_eq!(error.status, status);
            assert_eq!(error.code, code);
            assert_eq!(error.message, message);
        }
        other => panic!("expected VoiceRequestError, got {other:?}"),
    }
}
fn id(n: usize) -> String {
    format!("{n:032x}")
}

#[test]
fn source_defaults_are_explicit() {
    let config = FishCatalogConfig::new(None);
    assert_eq!(config.endpoint, "https://api.fish.audio/model");
    assert_eq!(config.timeout, Duration::from_secs(12));
    assert_eq!(config.cache_ttl, Duration::from_secs(60));
    assert_eq!(config.cache_capacity, 100);
    assert_eq!(config.max_response_bytes, 8 * 1024 * 1024);
}

#[tokio::test]
async fn get_and_search_send_expected_requests_and_share_client_pool() {
    let mut server = Server::start().await;
    let search_body = format!(r#"{{"items":[{VOICE}],"has_more":true}}"#);
    server.push(Reply::Response(200, VOICE.into()));
    server.push(Reply::Response(200, search_body));
    let catalog = FishCatalog::new(server.config());
    let voice = catalog.get_fish_voice(ID).await.unwrap();
    let value: serde_json::Value = serde_json::from_str(&voice.to_json_string()).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"id":ID,"name":"Fixture","languages":["en"],"gender":"female","licensed":true,"description":"","tags":["warm"],"coverUrl":null,"sample":null,"uses":2})
    );
    let first = server.next().await;
    assert_eq!(first.line, format!("GET /model/{ID} HTTP/1.1"));
    assert_eq!(
        first.headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-key")
    );
    let search = parse_voice_search_json(
        r#"{"name":"a b&c","gender":"female","language":"en","license":"licensed","page":"2"}"#,
    )
    .unwrap();
    let result = catalog.search_fish_voices(&search).await.unwrap();
    let result: serde_json::Value = serde_json::from_str(&result.to_json_string()).unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["page"], 2);
    assert_eq!(result["hasMore"], true);
    let second = server.next().await;
    assert_eq!(
        second.line,
        "GET /model?page_size=20&page_number=2&sort_by=score&title=a+b%26c&tag=female&language=en&licensed=true HTTP/1.1"
    );
    assert_eq!(
        second.headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-key")
    );
    assert_eq!(
        first.connection, second.connection,
        "drained successful responses should reuse pooled HTTP connection"
    );
    server.no_more().await;
}

#[tokio::test]
async fn invalid_ids_and_missing_key_do_not_contact_upstream() {
    let mut server = Server::start().await;
    let mut config = server.config();
    config.key = None;
    let catalog = FishCatalog::new(config);
    for invalid in ["", " ", "not-an-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaé"] {
        request_error(
            catalog.get_fish_voice(invalid).await.unwrap_err(),
            400,
            "invalid_voice",
            "Invalid voice ID",
        );
    }
    request_error(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        503,
        "catalog_unavailable",
        "Voice catalog is unavailable",
    );
    server.no_more().await;
}

#[tokio::test]
async fn failures_are_classified_and_never_cached() {
    let mut server = Server::start().await;
    server.push(Reply::Response(404, "missing".into()));
    server.push(Reply::Response(500, "failed".into()));
    server.push(Reply::Response(200, "{".into()));
    server.push(Reply::Raw(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{".to_vec(),
    ));
    let catalog = FishCatalog::new(server.config());
    request_error(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        404,
        "voice_unavailable",
        "Voice catalog request failed",
    );
    request_error(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        503,
        "catalog_unavailable",
        "Voice catalog request failed",
    );
    assert!(matches!(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        FishCatalogError::Json(_)
    ));
    assert!(matches!(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        FishCatalogError::Body(_)
    ));
    catalog.get_fish_voice(ID).await.unwrap();
    catalog.clone().get_fish_voice(ID).await.unwrap();
    for _ in 0..5 {
        server.next().await;
    }
    server.no_more().await;
}

#[tokio::test]
async fn cache_hit_precedes_key_check_and_json_success_is_cached_before_validation() {
    let mut server = Server::start().await;
    server.push(Reply::Response(
        200,
        VOICE.replace("\"public\"", "\"private\""),
    ));
    let catalog = FishCatalog::new(server.config());
    request_error(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        404,
        "voice_unavailable",
        "This voice is no longer available",
    );
    server.next().await;
    let mut without_key = catalog.clone();
    without_key.config.key = None;
    request_error(
        without_key.get_fish_voice(ID).await.unwrap_err(),
        404,
        "voice_unavailable",
        "This voice is no longer available",
    );
    request_error(
        without_key.get_fish_voice(&id(1)).await.unwrap_err(),
        503,
        "catalog_unavailable",
        "Voice catalog is unavailable",
    );
    server.no_more().await;
}

#[tokio::test]
async fn bounded_response_is_rejected_without_poisoning_cache() {
    let mut server = Server::start().await;
    server.push(Reply::Response(
        200,
        format!("{}{}", VOICE, " ".repeat(1024)),
    ));
    let mut config = server.config();
    config.max_response_bytes = 512;
    let catalog = FishCatalog::new(config);
    assert!(matches!(
        catalog.get_fish_voice(ID).await.unwrap_err(),
        FishCatalogError::Limit(_)
    ));
    server.next().await;
    catalog.get_fish_voice(ID).await.unwrap();
    server.next().await;
    server.no_more().await;
}

#[tokio::test]
async fn header_and_body_deadlines_release_other_requests() {
    let mut server = Server::start().await;
    server.push(Reply::HoldHeaders);
    let catalog = FishCatalog::new(server.config());
    let slow = tokio::spawn({
        let catalog = catalog.clone();
        async move { catalog.get_fish_voice(ID).await }
    });
    let held_headers = server.next().await.connection;
    timeout(Duration::from_millis(150), catalog.get_fish_voice(&id(2)))
        .await
        .expect("cache lock held during HTTP")
        .unwrap();
    server.next().await;
    request_error(
        timeout(WAIT, slow).await.unwrap().unwrap().unwrap_err(),
        503,
        "catalog_unavailable",
        "Voice catalog is temporarily unavailable",
    );
    server.closed(held_headers).await;
    server.push(Reply::HoldBody);
    let result = timeout(WAIT, catalog.get_fish_voice(&id(3)))
        .await
        .expect("body timeout did not finish");
    assert!(
        matches!(result.unwrap_err(), FishCatalogError::Body(_)),
        "post-header body failure must stay an ordinary error"
    );
    let held_body = server.next().await.connection;
    server.closed(held_body).await;
}

#[tokio::test]
async fn expiry_fifo_hits_and_refresh_at_capacity_follow_source_map() {
    let mut server = Server::start().await;
    let now = Arc::new(AtomicU64::new(0));
    let clock = Arc::clone(&now);
    let catalog = FishCatalog::with_clock(
        server.config(),
        reqwest::Client::new(),
        Arc::new(move || Duration::from_millis(clock.load(Ordering::SeqCst))),
    );
    for n in 0..100 {
        catalog.get_fish_voice(&id(n)).await.unwrap();
        server.next().await;
    }
    catalog.clone().get_fish_voice(&id(0)).await.unwrap();
    server.no_more().await;
    catalog.get_fish_voice(&id(100)).await.unwrap();
    server.next().await;
    catalog.get_fish_voice(&id(0)).await.unwrap();
    server.next().await;
    // Expiry is strict: the entry expires exactly at its deadline.
    now.store(60_000, Ordering::SeqCst);
    catalog.get_fish_voice(&id(50)).await.unwrap();
    server.next().await;
    now.store(60_001, Ordering::SeqCst);
    catalog.get_fish_voice(&id(50)).await.unwrap();
    server.no_more().await;
    catalog.get_fish_voice(&id(2)).await.unwrap();
    server.next().await;
}

#[tokio::test]
async fn refresh_existing_at_capacity_evicts_before_updating() {
    let mut server = Server::start().await;
    // The injected clock deliberately goes backwards while populating, making
    // an older insertion live while a later insertion is expired. This exposes
    // the Map eviction quirk without relying on internal cache inspection.
    let now = Arc::new(AtomicU64::new(30_000));
    let clock = Arc::clone(&now);
    let catalog = FishCatalog::with_clock(
        server.config(),
        reqwest::Client::new(),
        Arc::new(move || Duration::from_millis(clock.load(Ordering::SeqCst))),
    );
    catalog.get_fish_voice(&id(0)).await.unwrap();
    server.next().await;
    now.store(0, Ordering::SeqCst);
    for n in 1..100 {
        catalog.get_fish_voice(&id(n)).await.unwrap();
        server.next().await;
    }
    now.store(60_000, Ordering::SeqCst);
    catalog.get_fish_voice(&id(50)).await.unwrap();
    server.next().await;
    catalog.get_fish_voice(&id(0)).await.unwrap();
    server.next().await;
    catalog.get_fish_voice(&id(50)).await.unwrap();
    server.no_more().await;
}

fn property<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    match value {
        JsonValue::Object(fields) => fields
            .iter()
            .find(|(key, _)| key.as_str() == Some(name))
            .map(|(_, value)| value)
            .unwrap_or_else(|| panic!("missing {name}")),
        _ => panic!("expected object for {name}"),
    }
}
fn js_text(value: &JsonValue) -> &str {
    match value {
        JsonValue::String(value) => value.as_str().expect("expected scalar string"),
        _ => panic!("expected string"),
    }
}
fn search_input(value: &JsonValue) -> FishVoiceSearch {
    let name = match property(value, "name") {
        JsonValue::String(name) => name.clone(),
        _ => panic!("search name"),
    };
    let page = match property(value, "page") {
        JsonValue::Number(page) => *page as u8,
        _ => panic!("search page"),
    };
    FishVoiceSearch {
        name,
        gender: js_text(property(value, "gender")).into(),
        language: js_text(property(value, "language")).into(),
        license: js_text(property(value, "license")).into(),
        page,
    }
}
fn check_oracle(name: &str, expected: &JsonValue, actual: Result<String, FishCatalogError>) {
    match (property(expected, "ok"), actual) {
        (JsonValue::Bool(true), Ok(actual)) => {
            assert_eq!(
                parse_json(&actual).unwrap(),
                *property(expected, "value"),
                "value: {name}"
            );
        }
        (JsonValue::Bool(false), Err(error)) => {
            let expected_error = property(expected, "error");
            match error {
                FishCatalogError::Request(error) => {
                    assert_eq!(
                        js_text(property(expected_error, "name")),
                        "Error",
                        "error type: {name}"
                    );
                    assert_eq!(
                        property(expected_error, "status"),
                        &JsonValue::Number(f64::from(error.status)),
                        "status: {name}"
                    );
                    assert_eq!(
                        js_text(property(expected_error, "code")),
                        error.code,
                        "code: {name}"
                    );
                    assert_eq!(
                        js_text(property(expected_error, "message")),
                        error.message,
                        "message: {name}"
                    );
                }
                FishCatalogError::Json(_) => assert_eq!(
                    js_text(property(expected_error, "name")),
                    "SyntaxError",
                    "error type: {name}"
                ),
                FishCatalogError::Body(_) => assert_eq!(
                    js_text(property(expected_error, "name")),
                    "Error",
                    "error type: {name}"
                ),
                FishCatalogError::Coercion(message) => {
                    assert_eq!(
                        js_text(property(expected_error, "name")),
                        "TypeError",
                        "error type: {name}"
                    );
                    assert_eq!(
                        js_text(property(expected_error, "message")),
                        message,
                        "error message: {name}"
                    );
                }
                FishCatalogError::Limit(error) => panic!("unexpected limit {error}: {name}"),
            }
        }
        (_, actual) => panic!("outcome mismatch for {name}: {actual:?}"),
    }
}
fn search_json(search: &FishVoiceSearch) -> String {
    format!(
        "{{\"name\":{},\"gender\":{},\"language\":{},\"license\":{},\"page\":{}}}",
        search.name.to_json_string(),
        serde_json::to_string(&search.gender).unwrap(),
        serde_json::to_string(&search.language).unwrap(),
        serde_json::to_string(&search.license).unwrap(),
        search.page
    )
}

#[tokio::test]
#[ignore = "requires FISH_CATALOG_FIXTURE_DIR from the actual TypeScript oracle"]
async fn typescript_catalog_fixture_replay() {
    let directory =
        std::env::var_os("FISH_CATALOG_FIXTURE_DIR").expect("FISH_CATALOG_FIXTURE_DIR is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::path::PathBuf::from(directory).join("fish-catalog-reference.json"))
            .expect("TypeScript catalog fixture missing"),
    )
    .expect("invalid fixture");
    assert_eq!(fixture["schema"], 1);
    let cases = fixture["cases"].as_array().expect("fixture cases");
    assert!(!cases.is_empty(), "fixture must contain cases");
    let mut names = std::collections::BTreeSet::new();
    let mut counts = BTreeMap::<String, usize>::new();
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        assert!(names.insert(name), "duplicate case {name}");
        let operation = case["operation"].as_str().unwrap();
        *counts.entry(operation.to_owned()).or_default() += 1;
        let input_raw = case["inputJson"].as_str().unwrap();
        let input = parse_json(input_raw).unwrap();
        let expected = parse_json(case["outcomeJson"].as_str().unwrap()).unwrap();
        match operation {
            "resolve" => {
                let arg = match &input {
                    JsonValue::Null => None,
                    _ => Some(js_text(&input)),
                };
                let actual = resolve_fish_voice(arg)
                    .map(|s| serde_json::to_string(&s).unwrap())
                    .unwrap_or_else(|| "null".into());
                check_oracle(name, &expected, Ok(actual));
            }
            "parse" => check_oracle(
                name,
                &expected,
                parse_voice_search_json(input_raw).map(|search| search_json(&search)),
            ),
            "normalize" => {
                let actual = if case["special"] == "nan" {
                    let mut prepared = input.clone();
                    let fields = match &mut prepared {
                        JsonValue::Object(fields) => fields,
                        _ => panic!("NaN fixture object"),
                    };
                    let (_, value) = fields
                        .iter_mut()
                        .find(|(key, _)| key.as_str() == Some("task_count"))
                        .expect("NaN fixture task count");
                    *value = JsonValue::Number(f64::NAN);
                    normalize_fish_voice(&prepared)
                } else {
                    normalize_fish_voice_json(input_raw)
                };
                check_oracle(
                    name,
                    &expected,
                    actual.map(|voice| {
                        voice
                            .map(|v| v.to_json_string())
                            .unwrap_or_else(|| "null".into())
                    }),
                );
            }
            "get" | "search" | "sequence" => {
                let mut server = Server::start().await;
                for reply in case["responses"].as_array().unwrap() {
                    if reply["transport"] == "reject" {
                        server.push(Reply::Raw(Vec::new()));
                    } else if reply["bodyReject"] == true {
                        server.push(Reply::Raw(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{".to_vec(),
                        ));
                    } else {
                        server.push(Reply::Response(
                            reply["status"].as_u64().unwrap() as u16,
                            reply["bodyJson"].as_str().unwrap().into(),
                        ));
                    }
                }
                let mut config = server.config();
                if case["configuration"]["key"] == false {
                    config.key = None;
                }
                let now = Arc::new(AtomicU64::new(0));
                let clock = Arc::clone(&now);
                let catalog = FishCatalog::with_clock(
                    config,
                    reqwest::Client::new(),
                    Arc::new(move || Duration::from_millis(clock.load(Ordering::SeqCst))),
                );
                match operation {
                    "get" => check_oracle(
                        name,
                        &expected,
                        catalog
                            .get_fish_voice(js_text(&input))
                            .await
                            .map(|v| v.to_json_string()),
                    ),
                    "search" => check_oracle(
                        name,
                        &expected,
                        catalog
                            .search_fish_voices(&search_input(&input))
                            .await
                            .map(|v| v.to_json_string()),
                    ),
                    _ => {
                        let (steps, outcomes) = match (&input, &expected) {
                            (JsonValue::Array(steps), JsonValue::Array(outcomes)) => {
                                (steps, outcomes)
                            }
                            _ => panic!("sequence arrays"),
                        };
                        assert_eq!(steps.len(), outcomes.len(), "sequence lengths: {name}");
                        for (step, expected) in steps.iter().zip(outcomes) {
                            let time = match property(step, "time") {
                                JsonValue::Number(time) => *time as u64,
                                _ => panic!("sequence time"),
                            };
                            now.store(time, Ordering::SeqCst);
                            check_oracle(
                                name,
                                expected,
                                catalog
                                    .get_fish_voice(js_text(property(step, "input")))
                                    .await
                                    .map(|v| v.to_json_string()),
                            );
                        }
                    }
                }
                for expected in case["requests"].as_array().unwrap() {
                    let received = server.next().await;
                    // fetch parses the supplied URL before emitting a network
                    // request; the oracle records the pre-parse argument.
                    let url = reqwest::Url::parse(expected["url"].as_str().unwrap()).unwrap();
                    let path = match url.query() {
                        Some(query) => format!("{}?{query}", url.path()),
                        None => url.path().to_owned(),
                    };
                    assert_eq!(
                        received.line,
                        format!("GET {path} HTTP/1.1"),
                        "request target: {name}"
                    );
                    assert_eq!(
                        received.headers.get("authorization").map(String::as_str),
                        Some("Bearer fixture-key"),
                        "authorization: {name}"
                    );
                }
                server.no_more().await;
            }
            other => panic!("unknown operation {other}"),
        }
    }
    for operation in ["resolve", "parse", "normalize", "get", "search", "sequence"] {
        assert!(
            counts.get(operation).copied().unwrap_or(0) > 0,
            "fixture missing {operation} cases"
        );
    }
}

#[test]
#[ignore = "requires the source benchmark fixture and explicit output path"]
fn fish_catalog_normalization_benchmark() {
    use std::{hint::black_box, path::PathBuf, time::Instant};

    struct Workload {
        name: String,
        input: JsonValue,
        expected: Vec<u8>,
        iterations: u64,
    }
    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0, "odd expected UTF-8 hex length");
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("hex encoding");
                u8::from_str_radix(pair, 16).expect("invalid expected UTF-8 hex")
            })
            .collect()
    }
    fn render(input: &JsonValue) -> String {
        normalize_fish_voice(input)
            .expect("benchmark normalization failed")
            .map(|voice| voice.to_json_string())
            .unwrap_or_else(|| "null".into())
    }
    fn consume(output: &str, checksum: &mut u32, bytes: &mut u64) {
        *bytes += output.len() as u64;
        for byte in output.as_bytes() {
            *checksum = checksum.wrapping_add(u32::from(*byte));
        }
    }

    let directory =
        std::env::var_os("FISH_CATALOG_FIXTURE_DIR").expect("FISH_CATALOG_FIXTURE_DIR is required");
    let output = std::env::var_os("FISH_CATALOG_BENCH_OUTPUT")
        .expect("FISH_CATALOG_BENCH_OUTPUT is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(directory).join("fish-catalog-benchmark-inputs.json"))
            .expect("source benchmark inputs missing"),
    )
    .expect("invalid source benchmark inputs");
    assert_eq!(fixture["schema"], 1);
    let cases = fixture["workloads"]
        .as_array()
        .expect("benchmark workloads");
    assert!(!cases.is_empty(), "benchmark workloads must not be empty");
    let expected_workloads = [
        "normalize-valid",
        "normalize-cuts",
        "normalize-gender",
        "normalize-large",
    ];
    assert_eq!(
        cases.len(),
        expected_workloads.len(),
        "unexpected benchmark workload count"
    );
    let mut seen = std::collections::BTreeSet::new();
    let prepared: Vec<_> = cases
        .iter()
        .map(|case| {
            let name = case["name"].as_str().expect("workload name");
            assert!(
                expected_workloads.contains(&name),
                "unexpected workload {name}"
            );
            assert!(seen.insert(name.to_owned()), "duplicate workload {name}");
            let input = parse_json(case["inputJson"].as_str().expect("input JSON"))
                .expect("invalid benchmark input JSON");
            let expected_json = case["expectedJson"].as_str().expect("expected JSON");
            let expected = decode_hex(
                case["expectedUtf8Hex"]
                    .as_str()
                    .expect("expected UTF-8 hex"),
            );
            assert_eq!(
                expected,
                expected_json.as_bytes(),
                "source JSON and UTF-8 differ for {name}"
            );
            assert_eq!(
                render(&input).as_bytes(),
                expected,
                "benchmark output differs from source for {name}"
            );
            let iterations = case["iterations"].as_u64().expect("iterations");
            assert_eq!(
                iterations,
                if name == "normalize-large" {
                    1_000
                } else {
                    10_000
                },
                "iteration count for {name}"
            );
            Workload {
                name: name.to_owned(),
                input,
                expected,
                iterations,
            }
        })
        .collect();
    assert_eq!(seen.len(), expected_workloads.len());

    let mut results = Vec::with_capacity(prepared.len());
    for workload in prepared {
        for _ in 0..100 {
            let rendered = black_box(render(black_box(&workload.input)));
            let mut checksum = 0;
            let mut bytes = 0;
            consume(black_box(&rendered), &mut checksum, &mut bytes);
            black_box((checksum, bytes));
        }
        let per_output_checksum = workload
            .expected
            .iter()
            .fold(0u32, |sum, byte| sum.wrapping_add(u32::from(*byte)));
        let expected_checksum = per_output_checksum.wrapping_mul(workload.iterations as u32);
        let expected_bytes = workload.expected.len() as u64 * workload.iterations;
        let mut samples = Vec::with_capacity(7);
        for _ in 0..7 {
            let mut checksum = 0u32;
            let mut bytes = 0u64;
            let start = Instant::now();
            for _ in 0..workload.iterations {
                let rendered = black_box(render(black_box(&workload.input)));
                consume(black_box(&rendered), &mut checksum, &mut bytes);
            }
            let elapsed_ns =
                u64::try_from(start.elapsed().as_nanos()).expect("benchmark duration exceeds u64");
            black_box((checksum, bytes));
            assert_eq!(
                (checksum, bytes),
                (expected_checksum, expected_bytes),
                "benchmark sample differs for {}",
                workload.name
            );
            samples.push(
                serde_json::json!({"elapsedNs":elapsed_ns,"checksum":checksum,"bytes":bytes}),
            );
        }
        results.push(serde_json::json!({"name":workload.name,"iterations":workload.iterations,"samples":samples}));
    }
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema":1,"warmups":100,"samples":7,"workloads":results
        }))
        .unwrap(),
    )
    .expect("write Rust benchmark output");
}
