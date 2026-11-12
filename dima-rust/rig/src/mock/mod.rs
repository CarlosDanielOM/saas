//! The mock of the outside world: one local HTTP server standing in for every provider in the
//! ledger, started per side. A request names the real host in its first path segment
//! (`/api.twitch.tv/helix/users`); the provider table (`mock/providers.json`) and the target's
//! and scenario's `mock` sections say how it is answered. Every request is recorded; one that
//! names an unknown host or that no route answers gets 501 and fails the scenario, and so does
//! anything the Node preload reports as refused.
//!
//! A second listener per side is a prefixing proxy to the local Qdrant (see [`qdrant`]).

pub mod handlers;
pub mod providers;
pub mod qdrant;
pub mod route;

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::io::Read as _;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, StreamBody, combinators::BoxBody};
use hyper::body::Frame;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::canon::fnv1a64;
use crate::capture::RawCall;
use crate::timefmt;
use handlers::{HandlerState, Req, S3Object, S3ObjectSeed, TwitchSeed, TwitchState};
use providers::Providers;
use route::{Action, AnswerCtx, BodySpec, Fail, Incoming, Respond, Route, RouteFile};

/// Largest request body the mock reads.
pub const MAX_REQUEST_BODY: usize = 64 * 1024 * 1024;

pub type Body = BoxBody<Bytes, std::io::Error>;

/// Request headers whose values are credentials: recorded as their scheme only.
pub const CREDENTIAL_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "cookie",
    "x-dimafx-service-token",
    "x-amz-security-token",
    "x-observability-signature",
];

/// `Bearer <redacted>`; `<redacted>` when the value has no scheme.
pub fn redact(value: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(value);
    match text.split_once(' ') {
        Some((scheme, _))
            if !scheme.is_empty()
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
        {
            format!("{scheme} <redacted>").into_bytes()
        }
        _ => b"<redacted>".to_vec(),
    }
}

/// Percent-decoding (`+` stays a plus); invalid UTF-8 becomes U+FFFD.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while let Some(&c) = b.get(i) {
        if c == b'%'
            && let (Some(h), Some(l)) = (b.get(i + 1), b.get(i + 2))
            && let (Some(h), Some(l)) = ((*h as char).to_digit(16), (*l as char).to_digit(16))
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// `a=1&b=x+y` as decoded pairs, in order (`+` is a space).
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (
                percent_decode(&k.replace('+', " ")),
                percent_decode(&v.replace('+', " ")),
            )
        })
        .collect()
}

/// The body as the mock reads it for matching: gzip undone, JSON parsed, a form as an object of
/// strings (repeated names keep the last value).
pub fn decode_body(headers: &[(String, Vec<u8>)], body: &[u8]) -> (Vec<u8>, Option<Value>) {
    let get = |n: &str| {
        headers
            .iter()
            .find(|(k, _)| k == n)
            .map(|(_, v)| String::from_utf8_lossy(v).to_ascii_lowercase())
            .unwrap_or_default()
    };
    let plain = if get("content-encoding").contains("gzip") {
        let mut out = Vec::new();
        match flate2::read::GzDecoder::new(body).read_to_end(&mut out) {
            Ok(_) => out,
            Err(_) => body.to_vec(),
        }
    } else {
        body.to_vec()
    };
    let ct = get("content-type");
    let json = if ct.contains("x-www-form-urlencoded") {
        let mut m = Map::new();
        for (k, v) in parse_query(&String::from_utf8_lossy(&plain)) {
            m.insert(k, Value::String(v));
        }
        Some(Value::Object(m))
    } else {
        serde_json::from_slice::<Value>(&plain).ok()
    };
    (plain, json)
}

/// Something that must fail the scenario: a request the mock did not expect, or an outbound
/// attempt the preload refused.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub at: i64,
    pub kind: String,
    pub detail: String,
}

/// What a target or a scenario says about the mock (`mock` section).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct MockFile {
    #[serde(default)]
    pub routes: Vec<RouteFile>,
    #[serde(default)]
    pub twitch: Option<TwitchSeed>,
    #[serde(default)]
    pub s3: Option<S3File>,
    /// Calls made before the first step (process start-up): `compare` (default) or `ignore`
    /// (not stored in captures, not compared), with a reason.
    #[serde(default)]
    pub startup: Option<String>,
    #[serde(default)]
    pub startup_reason: Option<String>,
    /// How long the side's start-up may keep calling the mock before the first step (the rig
    /// waits until the mock and the stores are quiet for 300 ms, at most this long; default 3000).
    #[serde(default)]
    pub settle_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct S3File {
    #[serde(default)]
    pub objects: BTreeMap<String, S3ObjectSeed>,
}

/// A checked `mock` section.
#[derive(Debug, Clone, Default)]
pub struct MockSpec {
    pub routes: Vec<Route>,
    pub twitch: TwitchSeed,
    pub s3: BTreeMap<String, S3Object>,
    pub startup_ignore: bool,
    pub settle_ms: Option<u64>,
}

impl MockSpec {
    /// Check a `mock` section; `origin` names it in errors (`scenario`, `target`).
    pub fn from_file(f: MockFile, origin: &str) -> Result<MockSpec, String> {
        let providers = Providers::builtin()?;
        let mut routes = Vec::new();
        for (i, r) in f.routes.into_iter().enumerate() {
            let route = Route::compile(r, true, format!("{origin} mock.routes[{i}]"))?;
            if let Some(h) = &route.host
                && !h.contains('*')
                && providers.for_host(h).is_none()
            {
                return Err(format!(
                    "{origin} mock.routes[{i}].host: `{h}` is not a provider host; known: {}",
                    providers
                        .hosts()
                        .iter()
                        .map(|(h, _)| *h)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            routes.push(route);
        }
        let startup_ignore = match f.startup.as_deref() {
            None | Some("compare") => false,
            Some("ignore") => {
                if f.startup_reason
                    .as_deref()
                    .is_none_or(|r| r.trim().chars().count() < 8)
                {
                    return Err(format!(
                        "{origin} mock.startup_reason: say why start-up calls are not compared"
                    ));
                }
                true
            }
            Some(other) => {
                return Err(format!(
                    "{origin} mock.startup: `{other}` (compare or ignore)"
                ));
            }
        };
        let s3 = handlers::s3_objects(&f.s3.map(|s| s.objects).unwrap_or_default())?;
        Ok(MockSpec {
            routes,
            twitch: f.twitch.unwrap_or_default(),
            s3,
            startup_ignore,
            settle_ms: f.settle_ms.map(|m| m.min(120_000)),
        })
    }

    /// The scenario's section over the target's: scenario routes first, Twitch seed lists and
    /// S3 objects merged (the scenario's win on the same token, user id or key).
    pub fn merged(target: &MockSpec, scenario: &MockSpec) -> MockSpec {
        let mut routes = scenario.routes.clone();
        routes.extend(target.routes.iter().cloned());
        let mut twitch = target.twitch.clone();
        let s = &scenario.twitch;
        if s.client_id.is_some() {
            twitch.client_id = s.client_id.clone();
        }
        if s.page_size.is_some() {
            twitch.page_size = s.page_size;
        }
        for u in &s.users {
            twitch.users.retain(|x| x.get("id") != u.get("id"));
            twitch.users.push(u.clone());
        }
        for t in &s.tokens {
            twitch.tokens.retain(|x| x.token != t.token);
            twitch.tokens.push(t.clone());
        }
        twitch.subscriptions.extend(s.subscriptions.iter().cloned());
        let mut s3 = target.s3.clone();
        s3.extend(scenario.s3.clone());
        MockSpec {
            routes,
            twitch,
            s3,
            startup_ignore: scenario.startup_ignore || target.startup_ignore,
            settle_ms: scenario.settle_ms.or(target.settle_ms),
        }
    }
}

struct State {
    routes: Vec<Route>,
    /// Matching requests per scenario/target route.
    counters: Vec<u32>,
    /// Matching requests per default route (provider, route index).
    default_counters: HashMap<(usize, usize), u32>,
    calls: Vec<RawCall>,
    problems: Vec<Problem>,
    twitch: TwitchState,
    s3: BTreeMap<String, S3Object>,
    /// Identical requests seen so far (for deterministic ids).
    seen: HashMap<u64, u32>,
    side_ports: BTreeMap<String, u16>,
    /// The last request (rig clock, epoch ms), for "wait until quiet".
    last_request: i64,
}

struct Shared {
    providers: &'static Providers,
    state: Mutex<State>,
    client: reqwest::Client,
    qdrant: Option<qdrant::Upstream>,
    stop: watch::Receiver<bool>,
}

impl Shared {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn problem(&self, kind: &str, detail: String) {
        let mut st = self.state();
        st.last_request = timefmt::now_ms();
        st.problems.push(Problem {
            at: timefmt::now_ms(),
            kind: kind.into(),
            detail,
        });
    }
}

/// One side's mock: the provider listener, and the Qdrant proxy when configured.
pub struct Mock {
    pub port: u16,
    pub qdrant_port: Option<u16>,
    /// The collection-name prefix of the Qdrant proxy.
    pub qdrant_prefix: Option<String>,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

fn full(status: u16, content_type: &str, body: impl Into<Bytes>) -> Response<Body> {
    let mut r = Response::new(
        Full::new(body.into())
            .map_err(|never: Infallible| match never {})
            .boxed(),
    );
    *r.status_mut() = hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::OK);
    if let Ok(v) = hyper::header::HeaderValue::from_str(content_type) {
        r.headers_mut().insert(hyper::header::CONTENT_TYPE, v);
    }
    r
}

fn not_implemented(what: &str) -> Response<Body> {
    full(
        501,
        "application/json",
        json!({"error": "dima-rig mock", "message": what}).to_string(),
    )
}

/// A short description of a request for problem reports.
fn describe(method: &str, host: &str, path: &str, query: &str, body: &[u8]) -> String {
    let q = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let preview = crate::value::cut(&String::from_utf8_lossy(body), 300);
    if preview.is_empty() {
        format!("{method} {host}{path}{q}")
    } else {
        format!("{method} {host}{path}{q} body {preview}")
    }
}

async fn read_body(req: Request<hyper::body::Incoming>) -> Result<Vec<u8>, String> {
    let limited = http_body_util::Limited::new(req.into_body(), MAX_REQUEST_BODY);
    match limited.collect().await {
        Ok(c) => Ok(c.to_bytes().to_vec()),
        Err(e) => Err(format!("reading the request body: {e}")),
    }
}

async fn serve(listener: TcpListener, shared: Arc<Shared>, qdrant_side: bool) {
    let mut stop = shared.stop.clone();
    loop {
        let accepted = tokio::select! {
            _ = stop.changed() => return,
            a = listener.accept() => a,
        };
        let Ok((stream, _)) = accepted else {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        };
        let shared = shared.clone();
        let mut conn_stop = shared.stop.clone();
        tokio::spawn(async move {
            let svc_shared = shared.clone();
            let svc = service_fn(move |req| {
                let s = svc_shared.clone();
                async move {
                    if qdrant_side {
                        qdrant::handle(s.qdrant.as_ref(), &s, req).await
                    } else {
                        handle(s, req).await
                    }
                }
            });
            let conn = http1::Builder::new()
                .keep_alive(true)
                .serve_connection(TokioIo::new(stream), svc);
            tokio::select! {
                _ = conn_stop.changed() => {}
                _ = conn => {}
            }
        });
    }
}

/// The deterministic id of a request: the same content in the same position among identical
/// requests always gets the same id, whatever came between.
fn request_id(st: &mut State, provider: &str, method: &str, path: &str, body: &[u8]) -> String {
    let mut seed = Vec::with_capacity(body.len() + 64);
    seed.extend_from_slice(provider.as_bytes());
    seed.push(0);
    seed.extend_from_slice(method.as_bytes());
    seed.push(0);
    seed.extend_from_slice(path.as_bytes());
    seed.push(0);
    seed.extend_from_slice(body);
    let h = fnv1a64(&seed);
    let n = st.seen.entry(h).or_insert(0);
    *n += 1;
    handlers::uuid_from(format!("{h:016x}|{n}").as_bytes())
}

enum Chosen {
    Respond(Respond, String),
    Handler {
        name: String,
        args: Value,
        origin: String,
    },
    Proxy(u16, String),
    Unmatched,
}

async fn handle(
    shared: Arc<Shared>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<Body>, std::io::Error> {
    let now = timefmt::now_ms();
    let method = req.method().as_str().to_string();
    if method == "CONNECT" {
        let target = req.uri().to_string();
        shared.problem(
            "refused",
            format!("CONNECT {target} (a child process used the proxy variables the preload sets)"),
        );
        return Ok(full(403, "text/plain", "dima-rig: CONNECT refused"));
    }
    let uri = req.uri().clone();
    let raw_path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();
    // Absolute-form (a child process using HTTP_PROXY) names the host itself.
    let (host, path) = match uri.authority() {
        Some(a) => (a.as_str().to_ascii_lowercase(), raw_path.clone()),
        None => {
            let rest = raw_path.strip_prefix('/').unwrap_or(&raw_path);
            let (h, p) = rest.split_once('/').unwrap_or((rest, ""));
            (h.to_ascii_lowercase(), format!("/{p}"))
        }
    };
    let headers: Vec<(String, Vec<u8>)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.as_bytes().to_vec()))
        .collect();
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(e) => {
            shared.problem("unmatched", format!("{method} {host}{path}: {e}"));
            return Ok(not_implemented(&e));
        }
    };
    if host == "__rig" {
        return Ok(internal(&shared, &method, &path, &body));
    }
    let Some(provider) = shared.providers.for_host(&host) else {
        let d = describe(&method, &host, &path, &query, &body);
        shared.problem("unknown-host", d.clone());
        return Ok(not_implemented(&format!(
            "unknown host {host}: the rig's mock has no provider for it ({d})"
        )));
    };
    let provider_idx = shared
        .providers
        .list
        .iter()
        .position(|p| p.name == provider.name)
        .unwrap_or(0);
    let query_pairs = parse_query(&query);
    let (plain, json) = decode_body(&headers, &body);
    let text = std::str::from_utf8(&plain).ok().map(str::to_string);
    let incoming = Incoming {
        method: &method,
        path: &path,
        query: &query_pairs,
        headers: &headers,
        json: json.as_ref(),
        text: text.as_deref(),
    };
    let mut caps = BTreeMap::new();
    let (chosen, recorded_provider, call_no, id) = {
        let mut st = shared.state();
        st.last_request = now;
        let mut chosen = Chosen::Unmatched;
        let mut origin_provider = provider.name.clone();
        let mut call_no = 0;
        for i in 0..st.routes.len() {
            let Some(r) = st.routes.get(i) else { break };
            if !r.matches(&host, &incoming, &mut caps) {
                continue;
            }
            let n = st.counters.get(i).copied().unwrap_or(0) + 1;
            if let Some(c) = st.counters.get_mut(i) {
                *c = n;
            }
            let Some(r) = st.routes.get(i) else { break };
            if !r.answers_call(n) {
                continue;
            }
            call_no = n;
            if let Some(p) = &r.provider {
                origin_provider = p.clone();
            }
            chosen = match &r.action {
                Action::Respond(resp) => Chosen::Respond(resp.clone(), r.origin.clone()),
                Action::Proxy(port) => {
                    let name = port.trim_start_matches("port.");
                    match st.side_ports.get(name) {
                        Some(p) => Chosen::Proxy(*p, r.origin.clone()),
                        None => Chosen::Unmatched,
                    }
                }
                Action::Handler { name, args } => Chosen::Handler {
                    name: name.clone(),
                    args: args.clone(),
                    origin: r.origin.clone(),
                },
            };
            break;
        }
        if matches!(chosen, Chosen::Unmatched) {
            for (ri, r) in provider.routes.iter().enumerate() {
                if !r.matches(&host, &incoming, &mut caps) {
                    continue;
                }
                let c = st.default_counters.entry((provider_idx, ri)).or_insert(0);
                *c += 1;
                let n = *c;
                if !r.answers_call(n) {
                    continue;
                }
                call_no = n;
                if let Some(p) = &r.provider {
                    origin_provider = p.clone();
                }
                chosen = match &r.action {
                    Action::Respond(resp) => Chosen::Respond(resp.clone(), r.origin.clone()),
                    Action::Proxy(_) => Chosen::Unmatched,
                    Action::Handler { name, args } => Chosen::Handler {
                        name: name.clone(),
                        args: args.clone(),
                        origin: format!("{} ({name})", r.origin),
                    },
                };
                break;
            }
        }
        let id = request_id(&mut st, &origin_provider, &method, &path, &plain);
        (chosen, origin_provider, call_no, id)
    };
    // Run a handler (state is locked again only for that).
    let (chosen, answered_by) = match chosen {
        Chosen::Handler { name, args, origin } => {
            let hreq = Req {
                host: &host,
                method: &method,
                path: &path,
                query: &query_pairs,
                headers: &headers,
                body: &plain,
                json: json.as_ref(),
                now_ms: now,
                id: &id,
            };
            let mut st = shared.state();
            let st = &mut *st;
            let mut hs = HandlerState {
                twitch: &mut st.twitch,
                s3: &mut st.s3,
            };
            match handlers::run(&name, &args, &hreq, &mut hs) {
                Some(resp) => (Chosen::Respond(resp, origin.clone()), origin),
                None => (Chosen::Unmatched, String::new()),
            }
        }
        Chosen::Respond(r, origin) => (Chosen::Respond(r, origin.clone()), origin),
        Chosen::Proxy(p, origin) => (Chosen::Proxy(p, origin.clone()), origin),
        Chosen::Unmatched => (Chosen::Unmatched, String::new()),
    };
    let mut recorded_headers = headers.clone();
    for (k, v) in &mut recorded_headers {
        if CREDENTIAL_HEADERS.contains(&k.as_str()) {
            *v = redact(v);
        }
    }
    let call = RawCall {
        at: now,
        provider: recorded_provider,
        host: host.clone(),
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        headers: recorded_headers,
        body: body.clone(),
        answered: if answered_by.is_empty() {
            "unmatched".into()
        } else {
            answered_by
        },
    };
    shared.state().calls.push(call);
    match chosen {
        Chosen::Handler { .. } | Chosen::Unmatched => {
            let d = describe(&method, &host, &path, &query, &plain);
            shared.problem("unmatched", d.clone());
            Ok(not_implemented(&format!(
                "no mock route answers {d}; add one to the scenario's mock.routes"
            )))
        }
        Chosen::Proxy(port, _) => {
            Ok(proxy(&shared, port, &method, &path, &query, &headers, body).await)
        }
        Chosen::Respond(r, _) => {
            let ctx = AnswerCtx {
                now_ms: now,
                path: &caps,
                query: &query_pairs,
                body: json.as_ref(),
                id: &id,
                call: call_no,
            };
            answer(&shared, &r, &provider.response_headers, &ctx).await
        }
    }
}

/// `/__rig/...`: reports from the preload, and the recorded calls for `dima-rig mock`.
fn internal(shared: &Shared, method: &str, path: &str, body: &[u8]) -> Response<Body> {
    match (method, path) {
        ("POST", "/refused") => {
            let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let kind = v.get("kind").and_then(Value::as_str).unwrap_or("?");
            let detail = v.get("detail").and_then(Value::as_str).unwrap_or("?");
            shared.problem("refused", format!("the preload refused {kind} {detail}"));
            full(204, "text/plain", "")
        }
        ("GET", "/calls") => {
            let st = shared.state();
            let calls: Vec<Value> = st
                .calls
                .iter()
                .map(|c| {
                    json!({"provider": c.provider, "method": c.method, "host": c.host, "path": c.path,
                        "query": c.query, "answered": c.answered})
                })
                .collect();
            let problems: Vec<Value> = st
                .problems
                .iter()
                .map(|p| json!({"kind": p.kind, "detail": p.detail}))
                .collect();
            full(
                200,
                "application/json",
                json!({"calls": calls, "problems": problems}).to_string(),
            )
        }
        _ => not_implemented("unknown rig endpoint"),
    }
}

async fn proxy(
    shared: &Shared,
    port: u16,
    method: &str,
    path: &str,
    query: &str,
    headers: &[(String, Vec<u8>)],
    body: Vec<u8>,
) -> Response<Body> {
    let q = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let url = format!("http://127.0.0.1:{port}{path}{q}");
    let Ok(m) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return not_implemented("bad method");
    };
    let mut rb = shared.client.request(m, &url).body(body);
    for (k, v) in headers {
        if matches!(
            k.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding"
        ) {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_slice());
    }
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let hs: Vec<(String, Vec<u8>)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.as_bytes().to_vec()))
                .collect();
            let bytes = resp.bytes().await.unwrap_or_default();
            let mut r = full(status, "", bytes);
            r.headers_mut().remove(hyper::header::CONTENT_TYPE);
            for (k, v) in hs {
                if matches!(
                    k.as_str(),
                    "content-length" | "transfer-encoding" | "connection"
                ) {
                    continue;
                }
                if let (Ok(n), Ok(val)) = (
                    hyper::header::HeaderName::from_bytes(k.as_bytes()),
                    hyper::header::HeaderValue::from_bytes(&v),
                ) {
                    r.headers_mut().append(n, val);
                }
            }
            r
        }
        Err(e) => {
            shared.problem("unmatched", format!("proxy to port {port} failed: {e}"));
            not_implemented("proxy failed")
        }
    }
}

fn frame_stream(
    rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<Frame<Bytes>, std::io::Error>> {
    futures_util::stream::unfold(rx, |mut rx| async move {
        let item = rx.recv().await?;
        Some((item.map(Frame::data), rx))
    })
}

async fn answer(
    shared: &Shared,
    r: &Respond,
    provider_headers: &[(String, String)],
    ctx: &AnswerCtx<'_>,
) -> Result<Response<Body>, std::io::Error> {
    if r.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(r.delay_ms)).await;
    }
    match r.fail {
        Some(Fail::Drop) => {
            return Err(std::io::Error::other("dima-rig mock: connection dropped"));
        }
        Some(Fail::Timeout) => {
            let mut stop = shared.stop.clone();
            tokio::select! {
                _ = stop.changed() => {}
                _ = tokio::time::sleep(Duration::from_secs(600)) => {}
            }
            return Err(std::io::Error::other("dima-rig mock: no answer"));
        }
        _ => {}
    }
    let (default_ct, pieces): (&str, Vec<Bytes>) = match &r.body {
        BodySpec::Empty => ("", Vec::new()),
        BodySpec::Json(v) => (
            "application/json",
            vec![Bytes::from(route::render_json(v, ctx).to_string())],
        ),
        BodySpec::Text(t) => (
            "text/plain; charset=utf-8",
            vec![Bytes::from(route::render_text(t, ctx))],
        ),
        BodySpec::Bytes(b) => ("application/octet-stream", vec![Bytes::from(b.clone())]),
        BodySpec::Sse(events) => (
            "text/event-stream",
            events
                .iter()
                .map(|e| {
                    let data = match route::render_json(e, ctx) {
                        Value::String(s) => s,
                        other => other.to_string(),
                    };
                    Bytes::from(format!("data: {data}\n\n"))
                })
                .collect(),
        ),
        BodySpec::Chunks(c) => (
            "application/octet-stream",
            c.iter()
                .map(|x| Bytes::from(route::render_text(x, ctx)))
                .collect(),
        ),
    };
    let streamed =
        matches!(r.body, BodySpec::Sse(_) | BodySpec::Chunks(_)) || r.fail == Some(Fail::Truncate);
    let mut resp = if streamed {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let delay = r.chunk_delay_ms;
        let truncate = r.fail == Some(Fail::Truncate);
        let mut stop = shared.stop.clone();
        tokio::spawn(async move {
            for (i, p) in pieces.into_iter().enumerate() {
                if i > 0 && delay > 0 {
                    tokio::select! {
                        _ = stop.changed() => return,
                        _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    }
                }
                if tx.send(Ok(p)).await.is_err() {
                    return;
                }
                if truncate {
                    let _ = tx
                        .send(Err(std::io::Error::other("dima-rig mock: truncated")))
                        .await;
                    return;
                }
            }
        });
        Response::new(BodyExt::boxed(StreamBody::new(frame_stream(rx))))
    } else {
        let all: Vec<u8> = pieces.iter().flat_map(|b| b.iter().copied()).collect();
        full(r.status, "", all)
    };
    *resp.status_mut() = hyper::StatusCode::from_u16(r.status).unwrap_or(hyper::StatusCode::OK);
    let h = resp.headers_mut();
    h.remove(hyper::header::CONTENT_TYPE);
    let mut set = |k: &str, v: &str| {
        if let (Ok(n), Ok(val)) = (
            hyper::header::HeaderName::from_bytes(k.as_bytes()),
            hyper::header::HeaderValue::from_str(v),
        ) {
            h.insert(n, val);
        }
    };
    if !default_ct.is_empty() {
        set("content-type", default_ct);
    }
    for (k, v) in provider_headers {
        set(k, &route::render_text(v, ctx));
    }
    for (k, v) in &r.headers {
        set(k, &route::render_text(v, ctx));
    }
    Ok(resp)
}

impl Mock {
    /// Start a mock on a free loopback port (and the Qdrant proxy when `qdrant` is given).
    pub async fn start(qdrant: Option<qdrant::Upstream>) -> std::io::Result<Mock> {
        Mock::start_at(0, qdrant).await
    }

    /// Start a mock on this loopback port (0: a free one).
    pub async fn start_at(port: u16, qdrant: Option<qdrant::Upstream>) -> std::io::Result<Mock> {
        let providers = Providers::builtin().map_err(std::io::Error::other)?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(std::io::Error::other)?;
        let shared = Arc::new(Shared {
            providers,
            state: Mutex::new(State {
                routes: Vec::new(),
                counters: Vec::new(),
                default_counters: HashMap::new(),
                calls: Vec::new(),
                problems: Vec::new(),
                twitch: TwitchState::default(),
                s3: BTreeMap::new(),
                seen: HashMap::new(),
                side_ports: BTreeMap::new(),
                last_request: 0,
            }),
            client,
            qdrant: qdrant.clone(),
            stop: stop_rx,
        });
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        let port = listener.local_addr()?.port();
        let mut tasks = vec![tokio::spawn(serve(listener, shared.clone(), false))];
        let mut qdrant_port = None;
        if qdrant.is_some() {
            let ql = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
            qdrant_port = Some(ql.local_addr()?.port());
            tasks.push(tokio::spawn(serve(ql, shared.clone(), true)));
        }
        Ok(Mock {
            port,
            qdrant_port,
            qdrant_prefix: qdrant.map(|q| q.prefix),
            shared,
            stop: stop_tx,
            tasks,
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Start a scenario: its routes and seeds, and nothing recorded yet.
    pub fn reset(&self, spec: &MockSpec, side_ports: &BTreeMap<String, u16>) {
        let now = timefmt::now_ms();
        let mut st = self.shared.state();
        st.counters = vec![0; spec.routes.len()];
        st.routes = spec.routes.clone();
        st.default_counters.clear();
        st.calls.clear();
        st.problems.clear();
        st.twitch = TwitchState::from_seed(&spec.twitch, now);
        st.s3 = spec.s3.clone();
        st.seen.clear();
        st.side_ports = side_ports.clone();
        st.last_request = 0;
    }

    pub fn calls(&self) -> Vec<RawCall> {
        self.shared.state().calls.clone()
    }

    pub fn problems(&self) -> Vec<Problem> {
        self.shared.state().problems.clone()
    }

    /// When the mock last received a request (epoch ms, 0 for never).
    pub fn last_request(&self) -> i64 {
        self.shared.state().last_request
    }

    /// Calls recorded so far that satisfy `f`.
    pub fn count(&self, f: impl Fn(&RawCall) -> bool) -> usize {
        self.shared.state().calls.iter().filter(|c| f(c)).count()
    }

    /// Stop listening and close every connection.
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        for t in self.tasks.drain(..) {
            let _ = tokio::time::timeout(Duration::from_secs(2), t).await;
        }
    }
}

/// `dima-rig mock`: run one mock in the foreground and print every request until Ctrl-C.
pub async fn run_standalone(
    port: u16,
    spec: MockSpec,
    qdrant: Option<qdrant::Upstream>,
) -> std::io::Result<()> {
    let mock = Mock::start_at(port, qdrant).await?;
    mock.reset(&spec, &BTreeMap::new());
    println!("dima-rig mock listening on {}", mock.url());
    println!(
        "  a request names the real host first: {}/api.twitch.tv/helix/users",
        mock.url()
    );
    if let (Some(p), Some(prefix)) = (mock.qdrant_port, &mock.qdrant_prefix) {
        println!("  Qdrant proxy on http://127.0.0.1:{p} (collections prefixed {prefix})");
    }
    let providers = Providers::builtin().map_err(std::io::Error::other)?;
    for p in &providers.list {
        if !p.hosts.is_empty() {
            println!("  {:<15} {}", p.name, p.hosts.join(", "));
        }
    }
    let (mut seen_calls, mut seen_problems) = (0, 0);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        let calls = mock.calls();
        for c in calls.iter().skip(seen_calls) {
            let q = if c.query.is_empty() {
                String::new()
            } else {
                format!("?{}", c.query)
            };
            println!(
                "{} {:<12} {} {}{}{q} -> {}",
                timefmt::format_iso_ms(c.at).unwrap_or_default(),
                c.provider,
                c.method,
                c.host,
                c.path,
                c.answered
            );
        }
        seen_calls = calls.len();
        let problems = mock.problems();
        for p in problems.iter().skip(seen_problems) {
            println!("PROBLEM {}: {}", p.kind, p.detail);
        }
        seen_problems = problems.len();
    }
    if let Some(q) = mock.qdrant_prefix.clone()
        && let Some(up) = mock.shared.qdrant.clone()
    {
        match qdrant::drop_prefixed(&up).await {
            Ok(names) if !names.is_empty() => {
                println!("dropped Qdrant collections {}", names.join(", "))
            }
            Ok(_) => {}
            Err(e) => eprintln!("dima-rig mock: dropping Qdrant collections {q}*: {e}"),
        }
    }
    mock.stop().await;
    Ok(())
}

impl Drop for Mock {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        for t in &self.tasks {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn credentials_keep_their_scheme_only() {
        assert_eq!(redact(b"Bearer abc"), b"Bearer <redacted>".to_vec());
        assert_eq!(redact(b"OAuth abc"), b"OAuth <redacted>".to_vec());
        assert_eq!(
            redact(b"AWS4-HMAC-SHA256 Credential=x/1/nyc3, Signature=f"),
            b"AWS4-HMAC-SHA256 <redacted>".to_vec()
        );
        assert_eq!(redact(b"secret"), b"<redacted>".to_vec());
    }

    #[test]
    fn queries_and_bodies_decode() {
        assert_eq!(
            parse_query("a=1&b=x+y%2B&c"),
            vec![
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "x y+".to_string()),
                ("c".to_string(), String::new())
            ]
        );
        assert_eq!(percent_decode("%C3%B1%zz"), "ñ%zz");
        let form = vec![(
            "content-type".to_string(),
            b"application/x-www-form-urlencoded".to_vec(),
        )];
        let (_, j) = decode_body(&form, b"grant_type=client_credentials&client_id=x");
        assert_eq!(
            j,
            Some(json!({"grant_type": "client_credentials", "client_id": "x"}))
        );
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, br#"{"batch":[1]}"#).unwrap();
        let zipped = gz.finish().unwrap();
        let h = vec![
            ("content-encoding".to_string(), b"gzip".to_vec()),
            ("content-type".to_string(), b"application/json".to_vec()),
        ];
        assert_eq!(decode_body(&h, &zipped).1, Some(json!({"batch": [1]})));
    }
}
