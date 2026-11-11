//! Behaviour the golden recording cannot cover: panics, the Rust-side error path, typed
//! extraction, state, `next('router')`, refused patterns, and the server (peer address,
//! connection upgrades, request deadline, graceful shutdown).

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::time::Duration;

use dima_web::{
    App, Body, Envelope, Error, Flow, Req, Response, Router, ServeOptions, from_fn, serve,
    set_headers,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

struct State {
    greeting: &'static str,
}

async fn call<S: Send + Sync + 'static>(
    app: &App<S>,
    method: &str,
    uri: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> (u16, String, http::HeaderMap) {
    let mut builder = http::Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    if !body.is_empty() {
        builder = builder.header("content-length", body.len().to_string());
    }
    let response = app
        .handle(builder.body(Body::from(body.to_owned())).expect("request"))
        .await;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        String::from_utf8_lossy(&bytes).into_owned(),
        headers,
    )
}

async fn panics(_req: &mut Req<State>) -> Response {
    panic!("handler bug");
}

async fn greet(req: &mut Req<State>) -> Response {
    Response::new().json(&json!({ "greeting": req.state().greeting }))
}

async fn report_error(error: Error, _req: &mut Req<State>) -> Response {
    Response::status(500).json(&json!({ "caught": error.message(), "status": error.status() }))
}

#[tokio::test]
async fn panics_become_500_and_the_app_keeps_serving() {
    let mut root = Router::new();
    root.get("/boom", panics);
    root.get("/hello", greet);
    let app = App::new(root, State { greeting: "hi" }).expect("app");

    let (status, body, headers) = call(&app, "GET", "/boom", "", &[]).await;
    assert_eq!(status, 500);
    assert!(body.contains("<pre>Internal Server Error</pre>"), "{body}");
    assert_eq!(headers["content-security-policy"], "default-src 'none'");

    let (status, body, _) = call(&app, "GET", "/hello", "", &[]).await;
    assert_eq!((status, body.as_str()), (200, r#"{"greeting":"hi"}"#));
}

/// Review finding: an absurd `If-Modified-Since` year overflowed the date arithmetic (a panic,
/// so a 500) on every GET that sent a body.
#[tokio::test]
async fn absurd_conditional_dates_are_just_stale() {
    let mut root = Router::new();
    root.get("/hello", greet);
    let app = App::new(root, State { greeting: "hi" }).expect("app");
    for date in [
        "Sun, 06 Nov 99999999999999999 08:49:37 GMT",
        "Sun, 06 Nov 9223372036854775807 23:59:59 GMT",
    ] {
        let (status, body, _) =
            call(&app, "GET", "/hello", "", &[("if-modified-since", date)]).await;
        assert_eq!(
            (status, body.as_str()),
            (200, r#"{"greeting":"hi"}"#),
            "{date}"
        );
    }
}

#[tokio::test]
async fn panics_reach_router_error_handlers() {
    let mut widgets = Router::new();
    widgets.get("/boom", panics);
    widgets.on_error(report_error);
    let mut root = Router::new();
    root.mount("/widgets", widgets);
    let app = App::new(root, State { greeting: "hi" }).expect("app");

    let (status, body, _) = call(&app, "GET", "/widgets/boom", "", &[]).await;
    assert_eq!(status, 500);
    assert_eq!(body, r#"{"caught":"handler panicked","status":null}"#);
}

/// A handler that panics while building its future, before any `await`.
fn eager_panic(_req: &mut Req<State>) -> std::future::Ready<Response> {
    panic!("before the future");
}

/// An error handler that panics the same way.
fn eager_error_panic(_error: Error, _req: &mut Req<State>) -> std::future::Ready<Response> {
    panic!("error handler bug");
}

/// Review finding: the handler was invoked before the panic guard was installed, and `from_fn`
/// ran synchronously, so these panics skipped the router's error handlers and lost the route's
/// JSON error shape.
#[tokio::test]
async fn panics_before_the_first_await_reach_router_error_handlers() {
    let mut widgets = Router::new();
    widgets.middleware_at(
        "/sync",
        from_fn(|_req: &mut Req<State>| -> Result<Flow, Error> { panic!("middleware bug") }),
    );
    widgets.get("/eager", eager_panic);
    let mut nested = Router::new();
    nested.get("/boom", panics);
    nested.on_error(eager_error_panic);
    widgets.mount("/nested", nested);
    widgets.on_error(report_error);
    let mut root = Router::new();
    root.mount("/widgets", widgets);
    let app = App::new(root, State { greeting: "hi" }).expect("app");

    for path in ["/widgets/sync", "/widgets/eager", "/widgets/nested/boom"] {
        let (status, body, _) = call(&app, "GET", path, "", &[]).await;
        assert_eq!(status, 500, "{path}");
        assert_eq!(
            body, r#"{"caught":"handler panicked","status":null}"#,
            "{path}"
        );
    }
}

#[derive(Debug, Deserialize)]
struct Rename {
    name: String,
}

async fn typed(req: &mut Req) -> Result<Response, Error> {
    let Rename { name } = req.body_as()?;
    Ok(Envelope::ok("Renamed")
        .data(json!({ "name": name }))
        .reply())
}

async fn untyped(req: &mut Req) -> Response {
    let name = req
        .body()
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("anonymous");
    Response::new().json(&json!({ "name": name, "limit": req.query_str("limit") }))
}

async fn bad_json(_req: &mut Req) -> Response {
    let mut map: HashMap<(u8, u8), u8> = HashMap::new();
    map.insert((1, 2), 3);
    Response::new().json(&map)
}

async fn bad_header(_req: &mut Req) -> Response {
    Response::new()
        .header("X-Bad", "line\nbreak")
        .text("never sent")
}

async fn io_failure(_req: &mut Req) -> Result<Response, Error> {
    Err(std::io::Error::other("disk on fire"))?
}

#[tokio::test]
async fn extraction_and_the_error_path() {
    let mut root = Router::new();
    root.middleware(dima_web::body::json());
    root.post("/typed", typed);
    root.post("/untyped", untyped);
    root.get("/bad-json", bad_json);
    root.get("/bad-header", bad_header);
    root.get("/io", io_failure);
    let app = App::new(root, ()).expect("app");
    let json_ct = [("content-type", "application/json")];

    let (status, body, _) = call(&app, "POST", "/typed", r#"{"name":"Zoë 😀"}"#, &json_ct).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        r#"{"error":false,"message":"Renamed","status":200,"data":{"name":"Zoë 😀"}}"#
    );

    let (status, body, _) = call(&app, "POST", "/typed", r#"{"nom":"x"}"#, &json_ct).await;
    assert_eq!(status, 400);
    assert!(body.contains("<pre>Bad Request</pre>"));

    let (status, body, _) = call(
        &app,
        "POST",
        "/untyped?limit=5&limit=6",
        r#"{"other":1}"#,
        &json_ct,
    )
    .await;
    assert_eq!(
        (status, body.as_str()),
        (200, r#"{"name":"anonymous","limit":null}"#)
    );

    for path in ["/bad-json", "/bad-header", "/io"] {
        let (status, body, headers) = call(&app, "GET", path, "", &[]).await;
        assert_eq!(status, 500, "{path}");
        assert!(body.contains("Internal Server Error"), "{path}");
        assert!(!headers.contains_key("x-bad"));
    }
}

async fn leave(_req: &mut Req) -> Flow {
    Flow::NextRouter
}

async fn never(_req: &mut Req) -> Response {
    Response::new().text("child route")
}

async fn after(req: &mut Req) -> Response {
    Response::new().json(&json!({ "after": true, "cache": req.response_headers().get("cache-control").map(|v| v.to_str().unwrap_or("")) }))
}

#[tokio::test]
async fn next_router_and_header_middleware() {
    let mut child = Router::new();
    child.middleware(leave);
    child.get("/x", never);
    let mut root = Router::new();
    root.middleware(set_headers(&[("Cache-Control", "no-store")]));
    root.middleware(from_fn(|req: &mut Req| {
        req.append_header("X-Trace", "one")?;
        Ok(Flow::Next)
    }));
    root.mount("/child", child);
    root.get("/child/x", after);
    let app = App::new(root, ()).expect("app");

    let (status, body, headers) = call(&app, "GET", "/child/x", "", &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body, r#"{"after":true,"cache":"no-store"}"#);
    assert_eq!(headers["x-trace"], "one");
}

#[tokio::test]
async fn refused_patterns_are_reported() {
    let mut child = Router::new();
    child.get("/:id(\\d+)", never);
    let mut root = Router::new();
    root.get("/a+b", never);
    root.mount("/child", child);
    let error = App::new(root, ()).expect_err("patterns refused");
    let patterns: Vec<&str> = error.0.iter().map(|e| e.pattern.as_str()).collect();
    assert_eq!(patterns, ["/a+b", "/:id(\\d+)"]);
}

async fn who(req: &mut Req) -> Response {
    let upgradable = req.take_upgrade().is_some();
    Response::new().json(&json!({ "ip": req.ip(), "upgradable": upgradable }))
}

async fn echo_upgrade(req: &mut Req) -> Result<Response, Error> {
    let Some(upgrade) = req.take_upgrade() else {
        return Ok(Response::send_status(426));
    };
    tokio::spawn(async move {
        if let Ok(upgraded) = upgrade.await {
            let mut io = hyper_util::rt::TokioIo::new(upgraded);
            let mut buf = [0u8; 4];
            if io.read_exact(&mut buf).await.is_ok() {
                let _ = io.write_all(&buf).await;
            }
        }
    });
    let response = http::Response::builder()
        .status(101)
        .header("Connection", "Upgrade")
        .header("Upgrade", "echo")
        .body(Body::empty())?;
    Ok(Response::from_http(response))
}

async fn slow(_req: &mut Req) -> Response {
    tokio::time::sleep(Duration::from_millis(200)).await;
    Response::new().text("done")
}

async fn read_body(req: &mut Req) -> Response {
    Response::new().json(req.body())
}

async fn start(
    options: ServeOptions,
) -> (
    std::net::SocketAddr,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let mut root = Router::new();
    root.get("/who", who);
    root.get("/up", echo_upgrade);
    root.get("/slow", slow);
    root.middleware_at("/read", dima_web::body::json());
    root.post("/read", read_body);
    let app = App::new(root, ()).expect("app");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let token = CancellationToken::new();
    let server = tokio::spawn(serve(listener, app, token.clone(), options));
    (addr, token, server)
}

async fn roundtrip(addr: std::net::SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    String::from_utf8_lossy(&raw).into_owned()
}

#[tokio::test]
async fn serve_exposes_peer_address_and_upgrades() {
    let (addr, token, server) = start(ServeOptions::default()).await;

    let response = roundtrip(
        addr,
        "GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    )
    .await;
    // hyper attaches the upgrade handle only to requests that ask for an upgrade.
    assert!(
        response.ends_with(r#"{"ip":"127.0.0.1","upgradable":false}"#),
        "{response}"
    );

    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"GET /up HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n")
        .await
        .expect("write");
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("head");
        head.push(byte[0]);
    }
    assert!(
        head.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&head)
    );
    stream.write_all(b"ping").await.expect("ping");
    let mut echoed = [0u8; 4];
    stream.read_exact(&mut echoed).await.expect("echo");
    assert_eq!(&echoed, b"ping");

    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn shutdown_lets_in_flight_requests_finish() {
    let (addr, token, server) = start(ServeOptions::default()).await;
    let pending = tokio::spawn(roundtrip(
        addr,
        "GET /slow HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    token.cancel();
    let response = pending.await.expect("join");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("done"));
    server.await.expect("join").expect("serve");
    assert!(TcpStream::connect(addr).await.is_err(), "listener closed");
}

#[tokio::test]
async fn slow_bodies_hit_the_request_deadline() {
    let options = ServeOptions {
        request_timeout: Duration::from_millis(100),
        ..ServeOptions::default()
    };
    let (addr, token, server) = start(options).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"POST /read HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"a\"")
        .await
        .expect("write");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw))
        .await
        .expect("answered")
        .expect("read");
    let response = String::from_utf8_lossy(&raw);
    assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Reads one response off a kept-alive connection: the head, then `Content-Length` body bytes
/// (none for HEAD).
async fn read_response(stream: &mut TcpStream, head_request: bool) -> (String, Vec<u8>) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("response head");
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let mut body = vec![0u8; if head_request { 0 } else { length }];
    stream.read_exact(&mut body).await.expect("response body");
    (head, body)
}

#[tokio::test]
async fn the_connection_cap_stops_accepting_until_a_slot_frees() {
    let options = ServeOptions {
        max_connections: 1,
        ..ServeOptions::default()
    };
    let (addr, token, server) = start(options).await;
    let request = b"GET /who HTTP/1.1\r\nHost: x\r\n\r\n";

    let mut first = TcpStream::connect(addr).await.expect("connect");
    first.write_all(request).await.expect("write");
    let (head, _) = read_response(&mut first, false).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");

    // The kernel completes the handshake (backlog) but the server does not accept it yet.
    let mut second = TcpStream::connect(addr).await.expect("connect");
    second.write_all(request).await.expect("write");
    let mut byte = [0u8; 1];
    let waited = tokio::time::timeout(Duration::from_millis(300), second.read(&mut byte)).await;
    assert!(waited.is_err(), "answered while at the cap");

    drop(first);
    let (head, body) =
        tokio::time::timeout(Duration::from_secs(5), read_response(&mut second, false))
            .await
            .expect("answered once the first connection closed");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(String::from_utf8_lossy(&body).contains("\"ip\""));
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn request_heads_are_limited_like_node() {
    let (addr, token, server) = start(ServeOptions::default()).await;
    let with_header = |size: usize| {
        format!(
            "GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Big: {}\r\n\r\n",
            "a".repeat(size)
        )
    };
    let fits = roundtrip(addr, &with_header(15 * 1024)).await;
    assert!(
        fits.starts_with("HTTP/1.1 200"),
        "{}",
        fits.lines().next().unwrap_or_default()
    );
    let too_big = roundtrip(addr, &with_header(16 * 1024)).await;
    assert!(too_big.starts_with("HTTP/1.1 431"), "{too_big}");
    let long_path = format!(
        "GET /who?{} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        "q".repeat(17 * 1024)
    );
    assert!(
        roundtrip(addr, &long_path)
            .await
            .starts_with("HTTP/1.1 431")
    );

    let with_lines = |count: usize| {
        let lines: String = (0..count).map(|i| format!("X-H{i}: v\r\n")).collect();
        format!("GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{lines}\r\n")
    };
    assert!(
        roundtrip(addr, &with_lines(90))
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert!(
        roundtrip(addr, &with_lines(100))
            .await
            .starts_with("HTTP/1.1 431")
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn keep_alive_reuses_connections_and_closes_idle_ones() {
    let options = ServeOptions {
        keep_alive_timeout: Duration::from_millis(300),
        ..ServeOptions::default()
    };
    let (addr, token, server) = start(options).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    // A fresh connection is not subject to the keep-alive timer, only to the header timeout.
    tokio::time::sleep(Duration::from_millis(500)).await;
    for _ in 0..2 {
        stream
            .write_all(b"GET /who HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .expect("write");
        let (head, body) = read_response(&mut stream, false).await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(!body.is_empty());
        // Shorter than the idle timeout: the connection stays usable.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // A slow handler is in progress, not idle.
    stream
        .write_all(b"GET /slow HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .expect("write");
    let (head, body) = read_response(&mut stream, false).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, b"done");
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut rest)).await;
    assert!(
        matches!(closed, Ok(Ok(0))),
        "idle connection closed: {closed:?}"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn head_responses_carry_no_body_on_the_wire() {
    let (addr, token, server) = start(ServeOptions::default()).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"HEAD /who HTTP/1.1\r\nHost: x\r\n\r\nGET /who HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .expect("write");
    let (head, _) = read_response(&mut stream, true).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(
        head.to_ascii_lowercase().contains("content-length: 37"),
        "{head}"
    );
    // The next bytes on the wire are the second response, not a HEAD body.
    let (head, body) = read_response(&mut stream, false).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, br#"{"ip":"127.0.0.1","upgradable":false}"#);
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn bind_listens_dual_stack_like_node() {
    let listener = dima_web::bind(0).expect("bind");
    let local = listener.local_addr().expect("address");
    let mut root = Router::new();
    root.get("/who", who);
    let app = App::new(root, ()).expect("app");
    let token = CancellationToken::new();
    let server = tokio::spawn(serve(listener, app, token.clone(), ServeOptions::default()));
    let v4 = std::net::SocketAddr::from(([127, 0, 0, 1], local.port()));
    let response = roundtrip(
        v4,
        "GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    )
    .await;
    let expected = if local.is_ipv6() {
        r#"{"ip":"::ffff:127.0.0.1","upgradable":false}"#
    } else {
        // No IPv6 on this machine: Node falls back to 0.0.0.0 too.
        r#"{"ip":"127.0.0.1","upgradable":false}"#
    };
    assert!(response.ends_with(expected), "{response}");
    token.cancel();
    server.await.expect("join").expect("serve");
}
