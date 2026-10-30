#![cfg(feature = "api-observability-route")]

//! Functional checks for the native observability ingress.
//!
//! Every check uses loopback HTTP only: an Axum upstream records the proxied
//! request and returns a canned response, and the native router is served by a
//! real Axum server on `127.0.0.1`. No real analytics, Twitch, Docker or
//! production resource is contacted. The TypeScript oracle cases are replayed
//! from `DIMA_OBSERVABILITY_ROUTE_FIXTURE_DIR` (see the handoff note); the
//! remaining tests cover held headers/body deadlines, redirects, transport
//! failure and cancellation directly.

#[path = "support/sha256.rs"]
mod digest;

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
};
use dima_rust::observability_route::{
    BODY_LIMIT_MESSAGE, DEFAULT_DEADLINE, ForwardRequest, INVALID_JSON_MESSAGE, JSON_BODY_LIMIT,
    MOUNT_PATH, NOT_FOUND_MESSAGE, ObservabilityConfig, ObservabilityProxy, PRODUCTION_BASE_URL,
    UNAVAILABLE_MESSAGE,
};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};

#[derive(Clone, Debug, Default)]
struct Captured {
    method: String,
    uri: String,
    authorization: Option<String>,
    content_type: Option<String>,
    header_names: Vec<String>,
    body: Vec<u8>,
}

#[derive(Default)]
struct UpstreamState {
    captured: Mutex<Vec<Captured>>,
}

impl UpstreamState {
    fn record(&self, request: Captured) {
        self.captured.lock().expect("captured lock").push(request);
    }

    fn captured(&self) -> Vec<Captured> {
        self.captured.lock().expect("captured lock").clone()
    }
}

async fn capture(request: Request) -> (Captured, String) {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let uri = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| path.clone());
    let headers = request.headers().clone();
    let body = axum::body::to_bytes(request.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap_or_default()
        .to_vec();
    let mut header_names: Vec<String> = headers
        .keys()
        .map(|name| name.as_str().to_owned())
        .collect();
    header_names.sort();
    (
        Captured {
            method,
            uri,
            authorization: header_text(&headers, header::AUTHORIZATION.as_str()),
            content_type: header_text(&headers, header::CONTENT_TYPE.as_str()),
            header_names,
            body,
        },
        path,
    )
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

fn response(
    status: StatusCode,
    content_type: &str,
    cache: Option<&str>,
    body: Vec<u8>,
) -> Response {
    let mut builder = Response::builder().status(status).header(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).expect("header value"),
    );
    if let Some(cache) = cache {
        builder = builder.header(header::CACHE_CONTROL, cache);
    }
    builder.body(Body::from(body)).expect("test response")
}

async fn upstream(State(state): State<Arc<UpstreamState>>, request: Request) -> Response {
    let (captured, path) = capture(request).await;
    state.record(captured);
    match path.as_str() {
        "/api/session" => response(
            StatusCode::OK,
            "application/json",
            None,
            br#"{"ok":true,"route":"session"}"#.to_vec(),
        ),
        "/api/traces" => response(
            StatusCode::OK,
            "application/json",
            None,
            br#"{"traces":[]}"#.to_vec(),
        ),
        "/api/traces/0123456789abcdef0123456789abcdef" => response(
            StatusCode::OK,
            "application/json",
            None,
            br#"{"trace":"0123456789abcdef0123456789abcdef"}"#.to_vec(),
        ),
        "/api/overview" => response(
            StatusCode::UNAUTHORIZED,
            "application/json",
            None,
            br#"{"message":"unauthorized"}"#.to_vec(),
        ),
        // Deliberately hostile upstream headers: the source overrides both.
        "/api/resources" => response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain",
            Some("public, max-age=60"),
            b"upstream failure text".to_vec(),
        ),
        "/api/logs" => {
            let mut reply = response(StatusCode::OK, "application/json", None, b"{}".to_vec());
            reply.headers_mut().insert(
                header::LOCATION,
                axum::http::HeaderValue::from_static("http://example.invalid/redirect"),
            );
            *reply.status_mut() = StatusCode::FOUND;
            reply
        }
        "/api/grants" => response(
            StatusCode::NOT_MODIFIED,
            "application/json",
            None,
            Vec::new(),
        ),
        _ => response(
            StatusCode::OK,
            "application/json",
            None,
            br#"{"grant":true}"#.to_vec(),
        ),
    }
}

async fn serve(app: Router) -> (SocketAddr, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind loopback server");
    let address = listener.local_addr().expect("loopback address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (address, handle)
}

async fn start_upstream() -> (SocketAddr, Arc<UpstreamState>, JoinHandle<()>) {
    let state = Arc::new(UpstreamState::default());
    let app = Router::new().fallback(upstream).with_state(state.clone());
    let (address, handle) = serve(app).await;
    (address, state, handle)
}

async fn start_proxy(base_url: &str, deadline: Duration) -> (SocketAddr, JoinHandle<()>) {
    let proxy = ObservabilityProxy::new(ObservabilityConfig::new(base_url).with_deadline(deadline));
    serve(proxy.mounted_router()).await
}

#[derive(Debug)]
struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("expected JSON body, got {:?}: {error}", self.text()))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    fn cache_control(&self) -> Option<&str> {
        self.header("cache-control")
    }
}

async fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Reply {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test client");
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).expect("test method"),
        format!("http://{address}{path}"),
    );
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if let Some(body) = body {
        request = request.body(body.to_owned());
    }
    let response = request.send().await.expect("loopback proxy response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("response body").to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

#[tokio::test]
async fn forwards_get_with_raw_query_and_only_source_headers() {
    let (upstream_address, upstream_state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    let reply = send(
        proxy,
        "GET",
        "/observability/api/session?window=7d&filter=a%20b&empty=",
        &[
            ("authorization", "Bearer source-token"),
            ("cookie", "session=secret"),
            ("x-trace", "1"),
            ("content-type", "text/plain"),
        ],
        None,
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({"ok": true, "route": "session"}));
    assert_eq!(reply.cache_control(), Some("no-store"));
    assert!(
        reply
            .header("content-type")
            .is_some_and(|value| value.starts_with("application/json")),
        "{:?}",
        reply.header("content-type")
    );

    let captured = upstream_state.captured();
    assert_eq!(captured.len(), 1);
    let request = &captured[0];
    assert_eq!(request.method, "GET");
    assert_eq!(request.uri, "/api/session?window=7d&filter=a%20b&empty=");
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bearer source-token")
    );
    assert_eq!(request.content_type.as_deref(), Some("application/json"));
    assert!(request.body.is_empty());
    assert!(
        !request
            .header_names
            .iter()
            .any(|name| name == "cookie" || name == "x-trace"),
        "{:?}",
        request.header_names
    );

    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn forwards_put_json_and_ignores_get_delete_bodies() {
    let (upstream_address, upstream_state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    let reply = send(
        proxy,
        "PUT",
        "/observability/api/grants/12",
        &[
            ("authorization", "Bearer source-token"),
            ("content-type", "application/json; charset=utf-8"),
        ],
        Some(r#"{"b":1,"a":[true,null],"s":"text"}"#),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.cache_control(), Some("no-store"));

    send(
        proxy,
        "GET",
        "/observability/api/session",
        &[],
        Some(r#"{"ignored":true}"#),
    )
    .await;
    send(
        proxy,
        "DELETE",
        "/observability/api/session?force=1",
        &[],
        Some(r#"{"ignored":true}"#),
    )
    .await;
    send(
        proxy,
        "PUT",
        "/observability/api/grants",
        &[("content-type", "application/json")],
        None,
    )
    .await;
    send(
        proxy,
        "PUT",
        "/observability/api/grants",
        &[("content-type", "application/x-www-form-urlencoded")],
        Some("field=value"),
    )
    .await;

    let captured = upstream_state.captured();
    assert_eq!(captured.len(), 5, "{captured:?}");
    assert_eq!(captured[0].method, "PUT");
    assert_eq!(
        serde_json::from_slice::<Value>(&captured[0].body).expect("put json"),
        json!({"b": 1, "a": [true, null], "s": "text"})
    );
    assert_eq!(
        captured[0].content_type.as_deref(),
        Some("application/json")
    );
    assert_eq!(captured[0].uri, "/api/grants/12");

    assert_eq!(captured[1].method, "GET");
    assert!(captured[1].body.is_empty());
    assert_eq!(captured[2].method, "DELETE");
    assert!(captured[2].body.is_empty());
    assert_eq!(captured[2].uri, "/api/session?force=1");
    assert_eq!(
        captured[3].body,
        b"{}".to_vec(),
        "empty application/json PUT matches body-parser's empty object"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&captured[4].body).unwrap(),
        json!({"field": "value"}),
        "form fields reach analytics"
    );

    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn rejects_forbidden_methods_and_paths_without_calling_upstream() {
    let (upstream_address, upstream_state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    let cases = [
        ("HEAD", "/observability/api/session"),
        ("POST", "/observability/api/session"),
        ("OPTIONS", "/observability/api/session"),
        ("PATCH", "/observability/api/overview"),
        ("GET", "/observability/api/session/"),
        (
            "GET",
            "/observability/api/traces/0123456789ABCDEF0123456789abcdef",
        ),
        (
            "GET",
            "/observability/api/traces/0123456789abcdef0123456789abcde",
        ),
        (
            "GET",
            "/observability/api/grants/1234567890123456789012345678901",
        ),
        ("GET", "/observability/api/grants/abc"),
        ("GET", "/observability/api/unknown"),
        ("GET", "/observability/api"),
    ];
    for (method, path) in cases {
        let reply = send(
            proxy,
            method,
            path,
            &[("authorization", "Bearer source-token")],
            if method == "HEAD" { None } else { Some("{}") },
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "{method} {path} status"
        );
        if method != "HEAD" {
            assert_eq!(
                reply.json(),
                json!({"message": NOT_FOUND_MESSAGE}),
                "{method} {path} body"
            );
        }
        assert_eq!(reply.cache_control(), None, "{method} {path} cache");
    }

    assert!(
        upstream_state.captured().is_empty(),
        "rejected requests must not reach analytics"
    );
    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn preserves_upstream_status_and_raw_body_for_errors() {
    let (upstream_address, _state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    let unauthorized = send(proxy, "GET", "/observability/api/overview", &[], None).await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unauthorized.text(), r#"{"message":"unauthorized"}"#);
    assert_eq!(unauthorized.cache_control(), Some("no-store"));

    let failed = send(proxy, "GET", "/observability/api/resources", &[], None).await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failed.text(), "upstream failure text");
    assert_eq!(
        failed.cache_control(),
        Some("no-store"),
        "the source overrides an upstream cache header"
    );
    assert!(
        failed
            .header("content-type")
            .is_some_and(|value| value.starts_with("application/json")),
        "the source overrides an upstream content type"
    );

    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn treats_redirect_statuses_as_unavailable_but_passes_304() {
    let (upstream_address, _state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    let redirect = send(proxy, "GET", "/observability/api/logs", &[], None).await;
    assert_eq!(redirect.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(redirect.json(), json!({"message": UNAVAILABLE_MESSAGE}));
    assert_eq!(redirect.cache_control(), None);

    let not_modified = send(proxy, "GET", "/observability/api/grants", &[], None).await;
    assert_eq!(not_modified.status, StatusCode::NOT_MODIFIED);
    assert!(not_modified.body.is_empty());
    assert_eq!(not_modified.cache_control(), Some("no-store"));
    assert_eq!(not_modified.header("content-type"), None);

    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn reports_unavailable_on_transport_failure() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("reserve closed port");
    let closed = listener.local_addr().expect("closed address");
    drop(listener);

    let (proxy, proxy_task) =
        start_proxy(&format!("http://{closed}"), Duration::from_secs(5)).await;
    let reply = send(proxy, "GET", "/observability/api/session", &[], None).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.json(), json!({"message": UNAVAILABLE_MESSAGE}));
    assert_eq!(reply.cache_control(), None);
    proxy_task.abort();
}

#[tokio::test]
async fn reports_malformed_and_oversized_put_bodies() {
    let (upstream_address, upstream_state, upstream_task) = start_upstream().await;
    let (proxy, proxy_task) = start_proxy(
        &format!("http://{upstream_address}"),
        Duration::from_secs(5),
    )
    .await;

    for malformed in ["{oops", "null", "\"text\"", "42"] {
        let reply = send(
            proxy,
            "PUT",
            "/observability/api/grants",
            &[("content-type", "application/json")],
            Some(malformed),
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "malformed {malformed}"
        );
        assert_eq!(reply.json(), json!({"message": INVALID_JSON_MESSAGE}));
        assert_eq!(reply.cache_control(), None);
    }

    let oversized = format!(r#"{{"pad":"{}"}}"#, "a".repeat(JSON_BODY_LIMIT));
    let reply = send(
        proxy,
        "PUT",
        "/observability/api/grants",
        &[("content-type", "application/json")],
        Some(oversized.as_str()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.json(), json!({"message": BODY_LIMIT_MESSAGE}));
    assert_eq!(reply.cache_control(), None);

    assert!(upstream_state.captured().is_empty());
    proxy_task.abort();
    upstream_task.abort();
}

/// Headers plus a partial JSON body for the held-body deadline case.
const HELD_RESPONSE_HEAD: &[u8] =
    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{\"partial\":";

/// Accepts one connection, optionally sends response headers plus a partial
/// body, then holds until the peer closes. `accepted`/`closed` make the
/// deadline and cancellation behavior observable without extra crates.
struct HoldServer {
    address: SocketAddr,
    accepted: oneshot::Receiver<()>,
    closed: oneshot::Receiver<()>,
}

async fn start_hold_server(send_partial_body: bool) -> HoldServer {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind hold server");
    let address = listener.local_addr().expect("hold address");
    let (accepted_tx, accepted) = oneshot::channel();
    let (closed_tx, closed) = oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let _ = accepted_tx.send(());
        let mut buffer = [0u8; 2048];
        let mut head = Vec::new();
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    let _ = closed_tx.send(());
                    return;
                }
                Ok(read) => {
                    head.extend_from_slice(&buffer[..read]);
                    if head.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
        if send_partial_body {
            let _ = stream.write_all(HELD_RESPONSE_HEAD).await;
            let _ = stream.flush().await;
        }
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    let _ = closed_tx.send(());
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    HoldServer {
        address,
        accepted,
        closed,
    }
}

#[tokio::test]
async fn deadline_covers_headers_and_body() {
    for send_partial_body in [false, true] {
        let mut hold = start_hold_server(send_partial_body).await;
        let (proxy, proxy_task) = start_proxy(
            &format!("http://{}", hold.address),
            Duration::from_millis(150),
        )
        .await;

        let reply = send(proxy, "GET", "/observability/api/session", &[], None).await;
        assert_eq!(
            reply.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "partial_body={send_partial_body}"
        );
        assert_eq!(reply.json(), json!({"message": UNAVAILABLE_MESSAGE}));
        assert_eq!(
            reply.cache_control(),
            if send_partial_body {
                Some("no-store")
            } else {
                None
            }
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(2), &mut hold.closed)
                .await
                .is_ok(),
            "the deadline must cancel the upstream exchange (partial_body={send_partial_body})"
        );
        proxy_task.abort();
    }
}

#[tokio::test]
async fn cancelled_handler_future_cancels_the_upstream_request() {
    let mut hold = start_hold_server(false).await;
    let proxy = ObservabilityProxy::new(
        ObservabilityConfig::new(format!("http://{}", hold.address))
            .with_deadline(Duration::from_secs(30)),
    );
    let exchange = tokio::spawn(async move {
        proxy
            .forward(ForwardRequest::new(
                Method::GET,
                "/api/session",
                Vec::new(),
                None,
            ))
            .await
    });

    tokio::time::timeout(Duration::from_secs(2), &mut hold.accepted)
        .await
        .expect("upstream accepted the proxied request")
        .expect("accept signal");
    exchange.abort();
    assert!(exchange.await.expect_err("aborted").is_cancelled());
    assert!(
        tokio::time::timeout(Duration::from_secs(2), &mut hold.closed)
            .await
            .is_ok(),
        "dropping the handler must close the upstream request"
    );
}

/// Scripted upstream used by the source-oracle replay.
#[derive(Clone)]
struct Scripted {
    captured: Arc<Mutex<Vec<Captured>>>,
    status: StatusCode,
    body: Vec<u8>,
    location: Option<String>,
}

async fn scripted(State(scripted): State<Scripted>, request: Request) -> Response {
    let (captured, _) = capture(request).await;
    scripted
        .captured
        .lock()
        .expect("scripted lock")
        .push(captured);
    let mut reply = response(
        scripted.status,
        "text/plain",
        Some("public, max-age=60"),
        scripted.body,
    );
    if let Some(location) = scripted.location {
        reply
            .headers_mut()
            .insert(header::LOCATION, HeaderValue::from_str(&location).unwrap());
    }
    reply
}

async fn start_scripted(
    status: StatusCode,
    body: &str,
    location: Option<&str>,
) -> (SocketAddr, Arc<Mutex<Vec<Captured>>>, JoinHandle<()>) {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new().fallback(scripted).with_state(Scripted {
        captured: captured.clone(),
        status,
        body: body.as_bytes().to_vec(),
        location: location.map(str::to_owned),
    });
    let (address, handle) = serve(app).await;
    (address, captured, handle)
}

fn fixture_path() -> PathBuf {
    let directory = std::env::var_os("DIMA_OBSERVABILITY_ROUTE_FIXTURE_DIR").expect(
        "run tests/fixtures/observability_route_reference.cjs --write <abs dir> and set \
         DIMA_OBSERVABILITY_ROUTE_FIXTURE_DIR",
    );
    let directory = PathBuf::from(directory);
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert!(directory.is_dir(), "fixture directory does not exist");
    directory.join("observability-route-reference.json")
}

/// Replays the expected outcomes recorded from the real TypeScript route.
#[tokio::test]
#[ignore = "requires the independently generated TypeScript source fixture"]
async fn replays_the_typescript_source_oracle() {
    let bytes = std::fs::read(fixture_path()).expect("source oracle reference JSON");
    assert_eq!(
        digest::sha256_hex(&bytes),
        std::env::var("DIMA_OBSERVABILITY_ROUTE_FIXTURE_SHA256")
            .expect("independent fixture digest")
    );
    let fixture: Value = serde_json::from_slice(&bytes).expect("source oracle JSON");

    assert_eq!(
        fixture["source"]["file"], "src/server/routes/observability.route.ts",
        "fixture provenance"
    );
    assert_eq!(
        fixture["typescript"], "5.9.3",
        "oracle must use the pinned TypeScript"
    );
    // The public wiring constants still describe the production destination.
    assert_eq!(PRODUCTION_BASE_URL, "http://dima-analytics:3210");
    assert_eq!(DEFAULT_DEADLINE, Duration::from_secs(12));
    assert_eq!(MOUNT_PATH, "/observability");

    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 15, "source oracle coverage");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let request = &case["request"];
        let expected = &case["expected"];
        let method = request["method"].as_str().expect("method");
        let url = request["url"].as_str().expect("url");

        let throws = case["upstream"]["throws"].as_bool() == Some(true);
        let body_failure = case["upstream"]["bodyFailure"].as_bool() == Some(true);
        let (upstream_address, captured, upstream_task) = if throws {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("reserve closed port");
            let closed = listener.local_addr().expect("closed address");
            drop(listener);
            (closed, Arc::new(Mutex::new(Vec::new())), None)
        } else if body_failure {
            let hold = start_hold_server(true).await;
            (hold.address, Arc::new(Mutex::new(Vec::new())), None)
        } else {
            let status = case["upstream"]["status"].as_u64().unwrap_or(200) as u16;
            let body = case["upstream"]["body"].as_str().unwrap_or("{}");
            let (address, captured, task) = start_scripted(
                StatusCode::from_u16(status).expect("status"),
                body,
                case["upstream"]["location"].as_str(),
            )
            .await;
            (address, captured, Some(task))
        };

        let (proxy, proxy_task) = start_proxy(
            &format!("http://{upstream_address}"),
            if body_failure {
                Duration::from_millis(150)
            } else {
                Duration::from_secs(5)
            },
        )
        .await;

        let mut headers = Vec::new();
        if let Some(authorization) = request["authorization"].as_str() {
            headers.push(("authorization".to_owned(), authorization.to_owned()));
        }
        if let Some(content_type) = request["contentType"].as_str() {
            headers.push(("content-type".to_owned(), content_type.to_owned()));
        }
        let header_refs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let raw_body = request["rawBody"].as_str();

        let reply = send(
            proxy,
            method,
            &format!("{MOUNT_PATH}{url}"),
            &header_refs,
            raw_body,
        )
        .await;

        assert_eq!(
            u64::from(reply.status.as_u16()),
            expected["status"].as_u64().expect("expected status"),
            "{name}: status"
        );
        if method != "HEAD" {
            assert_eq!(
                reply.text(),
                expected["body"].as_str().expect("expected body"),
                "{name}: body"
            );
        }
        assert_eq!(
            reply.cache_control(),
            expected["cacheControl"].as_str(),
            "{name}: cache header"
        );
        assert_eq!(
            reply.header("content-type"),
            expected["contentType"].as_str(),
            "{name}: content type"
        );

        let recorded = captured.lock().expect("captured lock").clone();
        if throws {
            // The source attempted fetch; the native transport failed before any
            // upstream request could be recorded.
            assert!(recorded.is_empty(), "{name}: no upstream request");
            let fetch = expected["fetch"]
                .as_object()
                .expect("the source recorded its failed fetch attempt");
            assert_eq!(fetch["timeoutMs"], 12000, "{name}: source deadline");
            assert_eq!(fetch["redirect"], "error", "{name}: source redirect mode");
        } else if body_failure {
            assert!(recorded.is_empty(), "{name}: raw upstream is not captured");
            assert!(expected["fetch"].is_object());
        } else {
            match expected["fetch"].as_object() {
                None => assert!(recorded.is_empty(), "{name}: upstream must not be called"),
                Some(fetch) => {
                    assert_eq!(recorded.len(), 1, "{name}: one upstream call");
                    let upstream = &recorded[0];
                    assert_eq!(upstream.method, fetch["method"].as_str().unwrap(), "{name}");
                    assert_eq!(
                        upstream.uri,
                        fetch["url"]
                            .as_str()
                            .unwrap()
                            .strip_prefix(PRODUCTION_BASE_URL)
                            .expect("source fetch URL starts with the production destination"),
                        "{name}: forwarded URL"
                    );
                    assert_eq!(
                        upstream.authorization.as_deref(),
                        Some(fetch["authorization"].as_str().unwrap()),
                        "{name}: authorization"
                    );
                    assert_eq!(
                        upstream.content_type.as_deref(),
                        Some(fetch["contentType"].as_str().unwrap()),
                        "{name}: upstream content type"
                    );
                    match fetch["body"].as_str() {
                        None => assert!(upstream.body.is_empty(), "{name}: no upstream body"),
                        Some(body) => assert_eq!(
                            serde_json::from_slice::<Value>(&upstream.body).unwrap_or_else(|_| {
                                json!(String::from_utf8_lossy(&upstream.body))
                            }),
                            serde_json::from_str::<Value>(body).expect("source body JSON"),
                            "{name}: forwarded body"
                        ),
                    }
                    assert_eq!(fetch["timeoutMs"], 12000, "{name}: source deadline");
                    assert_eq!(fetch["redirect"], "error", "{name}: source redirect mode");
                    assert_eq!(
                        fetch["hasSignal"].as_bool(),
                        Some(true),
                        "{name}: source abort signal"
                    );
                }
            }
        }

        proxy_task.abort();
        if let Some(task) = upstream_task {
            task.abort();
        }
    }
}
