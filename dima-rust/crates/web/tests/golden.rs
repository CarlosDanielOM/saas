//! Golden conformance against real Express.
//!
//! `golden/record.mjs` builds a fixture app with the Express stack production runs and records
//! every scripted request with its response in `golden/express.json`. This test builds the same
//! fixture with dima-web, serves it on a loopback port, sends the identical request bytes and
//! compares status, headers and body bytes.
//!
//! Headers are compared in full except for this list:
//! - `date`: wall-clock time.
//! - `connection`, `keep-alive`: connection management (Node adds `Keep-Alive: timeout=5`;
//!   hyper words `Connection: close` differently); not part of the application contract.
//! - `x-powered-by`: deliberately not sent by dima-web (decision recorded in the package report).
//! - `content-length` on 204 responses only: hyper never sends it (RFC 9110 section 8.6 forbids
//!   it); Node sends `Content-Length: 0` where `cors()` sets it on preflight answers.
//!
//! Cases in `KNOWN_DIFFERENCES` are checked as described there; each has its reason.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;

use base64::Engine as _;
use dima_web::{
    App, BodyState, Envelope, Error, Flow, Req, Response, Router, ServeOptions, body, cors, serve,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

const EXCLUDED_HEADERS: [&str; 4] = ["date", "connection", "keep-alive", "x-powered-by"];

/// How a known difference is checked.
#[derive(Clone, Copy)]
enum Expect {
    /// Same status; headers and body may differ.
    SameStatus,
    /// hyper refuses the request line with a bare 400 before the application sees it.
    Rejected,
}

const RAW_TARGET: &str = "hyper (http crate) refuses this raw byte in the request target; Node routes it. \
                          Browsers and HTTP clients percent-encode it";

/// Cases where dima-web knowingly answers differently.
const KNOWN_DIFFERENCES: [(&str, Expect, &str); 9] = [
    (
        "json-lone-surrogate",
        Expect::SameStatus,
        "MIGRATION.md text rule 3: lone surrogate escapes become U+FFFD instead of a lone surrogate",
    ),
    ("unmatched-with-query", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-lt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-lt", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-gt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-gt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-quote", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-backtick", Expect::Rejected, RAW_TARGET),
    (
        "raw-char-path-hash",
        Expect::SameStatus,
        "the http crate drops a '#fragment' from the request target, so req.url and \
         req.originalUrl lack it; Node keeps it (clients never send fragments)",
    ),
];

// ------------------------------------------------------------------------------------------
// The fixture, in the same order as record.mjs.
// ------------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct WidgetError {
    message: String,
    status: u16,
}

fn located(req: &Req, mut fields: Map<String, Value>) -> Value {
    fields.insert("path".into(), req.path().into());
    fields.insert("baseUrl".into(), req.base_url().into());
    fields.insert("originalUrl".into(), req.original_url().into());
    fields.insert("url".into(), req.url().into());
    Value::Object(fields)
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn ok(value: Value) -> Response {
    Response::new().json(&value)
}

async fn describe_body(req: &mut Req) -> Response {
    match req.body_state() {
        BodyState::Raw(bytes) => ok(json!({
            "isBuffer": true,
            "length": bytes.len(),
            "hex": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        })),
        _ => ok(json!({ "isBuffer": false, "body": req.body() })),
    }
}

async fn docs_ask(req: &mut Req) -> Response {
    let size = serde_json::to_string(req.body())
        .map(|s| s.len())
        .unwrap_or(0);
    ok(json!({ "size": size }))
}

async fn oauth_boundary(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    if req.method() == http::Method::OPTIONS {
        return Ok(Response::status(204).end().into());
    }
    Ok(Flow::Next)
}

async fn oauth_authorize(req: &mut Req) -> Response {
    ok(json!({ "ok": true, "query": req.query() }))
}

async fn echo_body(req: &mut Req) -> Response {
    ok(json!({ "body": req.body() }))
}

async fn oauth_fail(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(401, "bad token"))
}

async fn oauth_limited(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(429, "slow down"))
}

async fn broken(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("broken"))
}

async fn json_not_found(_req: &mut Req) -> Response {
    Response::status(404).json(&json!({ "error": "not_found" }))
}

async fn oauth_errors(error: Error, _req: &mut Req) -> Response {
    let status = error
        .status()
        .filter(|s| matches!(s, 401 | 429))
        .unwrap_or(503);
    let mut response = Response::status(status);
    if status == 401 {
        response = response.header("WWW-Authenticate", "Bearer error=\"invalid_token\"");
    }
    if status == 429 {
        response = response.header("Retry-After", "60");
    }
    let code = match status {
        401 => "invalid_token",
        429 => "slow_down",
        _ => "temporarily_unavailable",
    };
    response.json(&json!({ "error": code }))
}

async fn pre_get(_req: &mut Req) -> Response {
    ok(json!({ "pre": "get" }))
}

async fn pre_post(_req: &mut Req) -> Response {
    ok(json!({ "pre": "post" }))
}

async fn pre_put(_req: &mut Req) -> Response {
    ok(json!({ "pre": "put" }))
}

async fn early(_req: &mut Req) -> Response {
    ok(json!({ "early": true }))
}

async fn users_id(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "route": "id", "params": req.params().to_json() })),
    ))
}

async fn route_me(_req: &mut Req) -> Response {
    ok(json!({ "route": "me" }))
}

async fn route_id(req: &mut Req) -> Response {
    ok(json!({ "route": "id", "params": req.params().to_json() }))
}

async fn params_only(req: &mut Req) -> Response {
    ok(json!({ "params": req.params().to_json() }))
}

async fn query(req: &mut Req) -> Response {
    ok(json!({ "query": req.query() }))
}

async fn summary(req: &mut Req) -> Response {
    let keys: Vec<&String> = req
        .body()
        .as_object()
        .map(|m| m.keys().collect())
        .unwrap_or_default();
    let pad = req.body().get("pad").and_then(Value::as_str).map(str::len);
    ok(json!({ "keys": keys, "padLength": pad }))
}

async fn form_summary(req: &mut Req) -> Response {
    ok(json!({ "keys": req.body().as_object().map_or(0, Map::len) }))
}

async fn etag(_req: &mut Req) -> Response {
    ok(json!({ "ok": true }))
}

async fn text(_req: &mut Req) -> Response {
    Response::new().text("<p>hello</p>")
}

async fn text_plain(_req: &mut Req) -> Response {
    Response::new().content_type("text/plain").text("plain")
}

async fn buffer(_req: &mut Req) -> Response {
    Response::new().bytes(vec![0u8, 1, 2, 255])
}

async fn buffer_typed(_req: &mut Req) -> Response {
    Response::new()
        .content_type("image/png")
        .bytes(&b"png!"[..])
}

async fn object(_req: &mut Req) -> Response {
    ok(json!({ "sent": "object" }))
}

async fn set_ct(_req: &mut Req) -> Response {
    Response::new()
        .set("Content-Type", "application/javascript")
        .text("var a = 1;")
}

async fn emoji(_req: &mut Req) -> Response {
    ok(json!({ "text": "héllo 😀 שלום e\u{301}" }))
}

async fn send_status(req: &mut Req) -> Response {
    let code = req
        .param("code")
        .and_then(|c| c.parse().ok())
        .unwrap_or(500);
    Response::send_status(code)
}

async fn created(_req: &mut Req) -> Response {
    Response::status(201).json(&json!({ "error": false, "status": 200, "message": "Created" }))
}

async fn no_content(_req: &mut Req) -> Response {
    Response::status(204).json(&json!({ "ignored": true }))
}

async fn reset(_req: &mut Req) -> Response {
    Response::status(205).text("ignored")
}

async fn end_204(_req: &mut Req) -> Response {
    Response::status(204).end()
}

async fn end_200(_req: &mut Req) -> Response {
    Response::new().end()
}

async fn redirect(_req: &mut Req) -> Response {
    Response::redirect("/target?x=1&y=é")
}

async fn redirect_301(_req: &mut Req) -> Response {
    Response::redirect_with(301, "https://example.com/a b<c>")
}

async fn throw(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("boom"))
}

async fn next_err(req: &mut Req) -> Result<Response, Error> {
    let status = req
        .param("status")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Err(Error::new(status, "x"))
}

async fn next_err_headers(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(429, "x").with_header("Retry-After", "60"))
}

async fn status_then_error(req: &mut Req) -> Result<Response, Error> {
    req.set_status(403);
    Err(Error::msg("x"))
}

async fn header_then_next(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    Ok(Flow::Next)
}

async fn skip_route(_req: &mut Req) -> Flow {
    Flow::NextRoute
}

async fn first(_req: &mut Req) -> Response {
    ok(json!({ "first": true }))
}

async fn second(_req: &mut Req) -> Response {
    ok(json!({ "second": true }))
}

async fn any_method(req: &mut Req) -> Response {
    ok(json!({ "method": req.method().as_str() }))
}

async fn vary(_req: &mut Req) -> Response {
    Response::new()
        .vary("Origin")
        .vary("Accept")
        .json(&json!({ "vary": true }))
}

async fn no_store(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    Ok(Flow::Next)
}

async fn widget_overlay(req: &mut Req) -> Response {
    ok(json!({ "public": true, "channel": req.param("channelID") }))
}

async fn widget_auth(req: &mut Req) -> Flow {
    if req.header("authorization").as_deref() != Some("Bearer good") {
        return Response::status(401)
            .json(&json!({ "error": true, "status": 401, "message": "Unauthorized" }))
            .into();
    }
    Flow::Next
}

async fn widget_access(req: &mut Req) -> Flow {
    if req.param("channelID") == Some("forbidden") {
        return Response::status(403)
            .json(&json!({ "error": true, "status": 403, "code": "permission_required" }))
            .into();
    }
    Flow::Next
}

async fn duel_state(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "duel": true, "params": req.params().to_json() })),
    ))
}

async fn duel_fail(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(409, "duel"))
}

async fn plain_state(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "plain": true, "params": req.params().to_json() })),
    ))
}

async fn widget_get(req: &mut Req) -> Response {
    ok(json!({ "channel": req.param("channelID") }))
}

async fn widget_post(req: &mut Req) -> Response {
    ok(json!({ "channel": req.param("channelID"), "body": req.body() }))
}

async fn widget_boom(_req: &mut Req) -> Result<Response, Error> {
    Err(WidgetError {
        message: "Bad widget".into(),
        status: 422,
    }
    .into())
}

async fn widget_crash(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("crash"))
}

async fn widget_errors(error: Error, _req: &mut Req) -> Response {
    let known = error.downcast_ref::<WidgetError>();
    let status = known.map_or(500, |e| e.status);
    Response::status(status).json(&json!({
        "error": true,
        "status": status,
        "code": if known.is_some() { "widget" } else { "internal" },
        "message": known.map_or("Widget operation failed".to_owned(), |e| e.message.clone()),
    }))
}

async fn timeline(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "timeline": req.param("channelID") })),
    ))
}

async fn analytics_summary(_req: &mut Req) -> Response {
    ok(json!({ "summary": true }))
}

async fn overlay(req: &mut Req) -> Response {
    ok(located(req, fields(json!({ "overlay": req.param("id") }))))
}

async fn v1_me(_req: &mut Req) -> Response {
    ok(json!({ "me": true }))
}

async fn email_a(_req: &mut Req) -> Response {
    ok(json!({ "email": "a" }))
}

async fn email_b(_req: &mut Req) -> Response {
    ok(json!({ "email": "b" }))
}

fn docs_origin(origin: Option<&str>) -> bool {
    origin.is_none_or(|o| o.is_empty() || o == "https://docs.example.com")
}

fn fixture() -> App {
    let mut app = Router::new();

    let mut hook = Router::new();
    hook.post(
        "/",
        (body::raw().types(&["application/json"]), describe_body),
    );
    app.mount("/hook", hook);

    app.middleware_at("/big", body::json().limit(body::mb(5)));
    app.middleware_at("/mid", body::json().limit(body::mb(1)));
    app.middleware_at("/four", body::json().limit(body::mb(4)));

    let mut docs = Router::new();
    docs.middleware(
        cors::cors()
            .origin(cors::Origin::Callback(std::sync::Arc::new(docs_origin)))
            .methods(&["POST"])
            .max_age(86_400),
    );
    docs.middleware(body::json().limit(body::kb(256)));
    docs.post("/ask", docs_ask);
    app.mount("/docs", docs);

    app.middleware(body::json());
    app.middleware(body::urlencoded());

    let mut oauth = Router::new();
    oauth.middleware(oauth_boundary);
    oauth.get("/authorize", oauth_authorize);
    oauth.post("/token", echo_body);
    oauth.get("/fail", oauth_fail);
    oauth.get("/limited", oauth_limited);
    oauth.get("/broken", broken);
    oauth.middleware(json_not_found);
    oauth.on_error(oauth_errors);
    app.mount("/oauth", oauth);

    let mut pre = Router::new();
    pre.get("/thing", pre_get);
    pre.post("/thing", pre_post);
    pre.put("/other", pre_put);
    app.mount("/pre", pre);
    app.get("/early", early);

    app.middleware(cors::cors());

    app.get("/users/:id", users_id);
    app.get("/users/me", route_me);
    app.get("/order/me", route_me);
    app.get("/order/:id", route_id);
    app.get("/opt/:a/:b?", params_only);
    app.get("/files/*", params_only);
    app.get("/f/:name.:ext", params_only);
    app.post("/only-post/:id", params_only);
    app.get("/query", query);
    app.post("/echo", echo_body);
    app.put("/echo", echo_body);
    app.post("/big/echo", summary);
    app.post("/mid/echo", summary);
    app.post("/four/echo", summary);
    app.post("/form-summary", form_summary);
    app.get("/etag", etag);
    app.post("/etag", etag);
    app.get("/text", text);
    app.get("/text-plain", text_plain);
    app.get("/buffer", buffer);
    app.get("/buffer-typed", buffer_typed);
    app.get("/object", object);
    app.get("/set-ct", set_ct);
    app.get("/emoji", emoji);
    app.get("/status/:code", send_status);
    app.get("/created", created);
    app.get("/no-content", no_content);
    app.get("/reset", reset);
    app.get("/end", end_204);
    app.get("/end200", end_200);
    app.get("/redirect", redirect);
    app.get("/redirect301", redirect_301);
    app.get("/throw", throw);
    app.get("/next-err/:status", next_err);
    app.get("/next-err-headers", next_err_headers);
    app.get("/status-then-error", status_then_error);
    app.get("/header-then-404", header_then_next);
    app.get("/next-route", (skip_route, first));
    app.get("/next-route", second);
    app.all("/any", any_method);
    app.get("/vary", vary);

    let mut widgets = Router::new();
    widgets.middleware(no_store);
    widgets.get("/:channelID/overlay", widget_overlay);
    widgets.middleware(widget_auth);
    widgets.middleware_at("/:channelID", widget_access);
    let mut duel = Router::with_merge_params();
    duel.get("/state", duel_state);
    duel.post("/fail", duel_fail);
    widgets.mount("/:channelID/duel", duel);
    let mut plain = Router::new();
    plain.get("/state", plain_state);
    widgets.mount("/:channelID/plain", plain);
    widgets.get("/:channelID", widget_get);
    widgets.post("/:channelID", widget_post);
    widgets.get("/:channelID/boom", widget_boom);
    widgets.get("/:channelID/crash", widget_crash);
    widgets.on_error(widget_errors);
    app.mount("/widgets", widgets);

    let mut timeline_router = Router::new();
    timeline_router.get("/streams/:channelID", timeline);
    let mut analytics = Router::new();
    analytics.get("/summary", analytics_summary);
    analytics.mount("/", timeline_router);
    app.mount("/analytics", analytics);

    let mut overlays = Router::new();
    overlays.get("/overlays/:id", overlay);
    app.mount("/", overlays);

    let mut v1 = Router::new();
    v1.get("/me", v1_me);
    v1.middleware(json_not_found);
    app.mount("/v1", v1);

    let mut email_first = Router::new();
    email_first.get("/a", email_a);
    let mut email_second = Router::new();
    email_second.get("/b", email_b);
    app.mount("/email", email_first);
    app.mount("/email", email_second);

    // Unused by the fixture; keeps the envelope helper in the compiled example surface.
    let _ = Envelope::ok("unused");
    App::new(app, ()).expect("fixture patterns are supported")
}

// ------------------------------------------------------------------------------------------
// Replay.
// ------------------------------------------------------------------------------------------

fn generate(spec: &Value) -> Vec<u8> {
    let kind = spec["type"].as_str().unwrap_or_default();
    let n = |key: &str| spec[key].as_u64().unwrap_or(0) as usize;
    match kind {
        "json-pad" => format!(
            "{{\"pad\":\"{}\"}}",
            "a".repeat(n("size") - "{\"pad\":\"\"}".len())
        )
        .into_bytes(),
        "form-pad" => format!("pad={}", "a".repeat(n("size") - 4)).into_bytes(),
        "form-params" => (0..n("count"))
            .map(|i| format!("k{i}={i}"))
            .collect::<Vec<_>>()
            .join("&")
            .into_bytes(),
        "form-depth" => format!("a{}=1", "[x]".repeat(n("depth"))).into_bytes(),
        other => panic!("unknown generator {other}"),
    }
}

fn body_bytes(body: &Value) -> Option<Vec<u8>> {
    if body.is_null() {
        return None;
    }
    if let Some(text) = body.get("utf8").and_then(Value::as_str) {
        return Some(text.as_bytes().to_vec());
    }
    if let Some(encoded) = body.get("base64").and_then(Value::as_str) {
        return Some(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("base64 body"),
        );
    }
    Some(generate(&body["gen"]))
}

fn request_bytes(case: &Value) -> Vec<u8> {
    let method = case["method"].as_str().unwrap_or_default();
    let path = case["path"].as_str().unwrap_or_default();
    let mut lines = vec![
        format!("{method} {path} HTTP/1.1"),
        "Host: localhost".into(),
        "Connection: close".into(),
    ];
    for header in case["headers"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{}: {}",
            header[0].as_str().unwrap_or_default(),
            header[1].as_str().unwrap_or_default()
        ));
    }
    let mut payload = Vec::new();
    if let Some(body) = body_bytes(&case["body"]) {
        if case["chunked"].as_bool().unwrap_or(false) {
            lines.push("Transfer-Encoding: chunked".into());
            for piece in body.chunks(16_384) {
                payload.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
                payload.extend_from_slice(piece);
                payload.extend_from_slice(b"\r\n");
            }
            payload.extend_from_slice(b"0\r\n\r\n");
        } else {
            lines.push(format!("Content-Length: {}", body.len()));
            payload = body;
        }
    }
    // Header text is latin1 on the wire, as Node writes it.
    let head = format!("{}\r\n\r\n", lines.join("\r\n"));
    let mut bytes: Vec<u8> = head.chars().map(|c| u32::from(c) as u8).collect();
    bytes.extend_from_slice(&payload);
    bytes
}

struct Parsed {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn parse_response(raw: &[u8], method: &str) -> Parsed {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response head");
    let head: String = raw[..split].iter().map(|&b| char::from(b)).collect();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(n, v)| n == "transfer-encoding" && v.contains("chunked"));
    if method == "HEAD" {
        body.clear();
    } else if chunked {
        let mut out = Vec::new();
        let mut at = 0;
        loop {
            let eol = at
                + body[at..]
                    .windows(2)
                    .position(|w| w == b"\r\n")
                    .expect("chunk size line");
            let size = usize::from_str_radix(std::str::from_utf8(&body[at..eol]).expect("hex"), 16)
                .expect("size");
            if size == 0 {
                break;
            }
            out.extend_from_slice(&body[eol + 2..eol + 2 + size]);
            at = eol + 2 + size + 2;
        }
        body = out;
    }
    Parsed {
        status,
        headers,
        body,
    }
}

async fn exchange(addr: SocketAddr, bytes: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    // The server may answer and close before the whole body is written (an oversized body).
    let _ = stream.write_all(bytes).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    raw
}

fn comparable(headers: &[(String, String)], status: u16) -> Vec<(String, String)> {
    let mut list: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| !EXCLUDED_HEADERS.contains(&name.as_str()))
        .filter(|(name, _)| !(status == 204 && name == "content-length"))
        .cloned()
        .collect();
    list.sort();
    list
}

fn expected_headers(response: &Value, status: u16) -> Vec<(String, String)> {
    let mut list = Vec::new();
    for (name, values) in response["headers"].as_object().into_iter().flatten() {
        for value in values.as_array().into_iter().flatten() {
            list.push((name.clone(), value.as_str().unwrap_or_default().to_owned()));
        }
    }
    comparable(&list, status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn matches_express() {
    let golden: Value =
        serde_json::from_str(include_str!("golden/express.json")).expect("golden file");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 200, "golden file has {} cases", cases.len());

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("address");
    let shutdown = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        fixture(),
        shutdown.clone(),
        ServeOptions::default(),
    ));

    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        let method = case["method"].as_str().unwrap_or_default();
        let raw = exchange(addr, &request_bytes(case)).await;
        if raw.is_empty() {
            failures.push(format!("{name}: no response"));
            continue;
        }
        let actual = parse_response(&raw, method);
        let expected = &case["response"];
        let expected_status = expected["status"].as_u64().unwrap_or(0) as u16;
        match KNOWN_DIFFERENCES
            .iter()
            .find(|(known, _, _)| *known == name)
        {
            Some((_, Expect::Rejected, _)) => {
                if actual.status != 400 || expected_status == 400 {
                    failures.push(format!(
                        "{name}: expected hyper's 400, got {} (express {expected_status})",
                        actual.status
                    ));
                }
                continue;
            }
            Some((_, Expect::SameStatus, _)) => {
                if actual.status != expected_status {
                    failures.push(format!(
                        "{name}: status {} != express {expected_status}",
                        actual.status
                    ));
                }
                continue;
            }
            None => {}
        }
        if actual.status != expected_status {
            failures.push(format!(
                "{name}: status {} != express {expected_status}",
                actual.status
            ));
            continue;
        }
        let expected_headers = expected_headers(expected, expected_status);
        let actual_headers = comparable(&actual.headers, actual.status);
        if actual_headers != expected_headers {
            failures.push(format!(
                "{name}: headers\n  dima-web: {actual_headers:?}\n  express:  {expected_headers:?}"
            ));
        }
        let expected_body = base64::engine::general_purpose::STANDARD
            .decode(expected["bodyBase64"].as_str().unwrap_or_default())
            .expect("golden body");
        if actual.body != expected_body {
            failures.push(format!(
                "{name}: body\n  dima-web: {}\n  express:  {}",
                String::from_utf8_lossy(&actual.body),
                String::from_utf8_lossy(&expected_body)
            ));
        }
    }

    shutdown.cancel();
    server.await.expect("server task").expect("server");
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[tokio::test]
async fn known_differences_are_real_cases() {
    let golden: Value =
        serde_json::from_str(include_str!("golden/express.json")).expect("golden file");
    let names: Vec<&str> = golden["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["name"].as_str())
        .collect();
    for (name, _, reason) in KNOWN_DIFFERENCES {
        assert!(
            names.contains(&name),
            "{name} ({reason}) is not a golden case"
        );
    }
}
