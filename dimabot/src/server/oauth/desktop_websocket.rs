//! Native desktop WebSocket for `desktop-websocket.ts`.
//!
//! The TypeScript server registers one raw `upgrade` listener. This module
//! does not. [`desktop_websocket_router`] is an Axum route at `/desktop/ws`.
//! [`OAuthApiService::desktop_router`] merges it after the HTTP boundary
//! layer, and [`OAuthApiService::application_router`] nests that router at
//! `/v1`, so the upgrade URL is `GET /v1/desktop/ws`.
//!
//! Socket.IO stays in `dimabot/src/server/websocket.rs`. `socket_io_layer`
//! only claims `req_path("/socket.io")` and passes every other request
//! through. Do not install a process-wide upgrade listener: the source
//! listener 404s any path other than `/v1/desktop/ws` except `/socket.io/`,
//! and that 404 would steal team4's namespace. Hyper answers an unparsable
//! request line itself. This route never sees `/socket.io/`.
//!
//! Admission runs before [`WebSocketUpgrade`]. The extractor completes the
//! handshake, so a query, origin, protocol, rate-limit, token, scope, or
//! connection-count rejection is a normal HTTP status with an empty body.
//! Axum's reason phrases are the standard ones (`Forbidden`, `Upgrade
//! Required`, `Too Many Requests`), not the source text `Rejected`.
//!
//! `pet_available` is always false. The pet runtime is team4's adapter.

use super::{
    catalog::{self, hash, oauth_website, utf16_len, ConfigError},
    service::{AccessIdentity, OAuthApiService, OAuthCreditsReader, OAuthFailure, OAuthPetAccess},
};
use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    time::Duration,
};

/// Mounted upgrade path. The router path is [`DESKTOP_WS_ROUTE`]; nesting at
/// `/v1` produces this path.
pub const DESKTOP_WS_PATH: &str = "/v1/desktop/ws";
/// Route path inside the desktop router, before the `/v1` nest.
pub const DESKTOP_WS_ROUTE: &str = "/desktop/ws";
/// `handleProtocols` accepts only this token.
pub const DESKTOP_WS_PROTOCOL: &str = "dima.desktop.v1";
/// `WebSocketServer` `maxPayload`.
pub const DESKTOP_WS_MAX_MESSAGE_BYTES: usize = 4096;
/// `setTimeout(..., 5000)` around admission. On expiry the source destroys the
/// socket without a status line. Axum must return a response, so this port
/// answers 408 and does not open the socket.
pub const DESKTOP_WS_UPGRADE_TIMEOUT: Duration = Duration::from_secs(5);
/// Shared `setInterval` period. This port runs one timer per connection.
pub const DESKTOP_WS_HEARTBEAT: Duration = Duration::from_secs(15);
const CONNECT_LIMIT: i64 = 120;
const MESSAGE_LIMIT: i64 = 60;
const MAX_LIVE_PER_SESSION: usize = 2;
const UNSUPPORTED: &str = r#"{"type":"error","error":"unsupported_message"}"#;

/// What the upgrade handler asks the OAuth service. Tests supply an in-memory
/// gate. [`OAuthApiService`] delegates to `oauth_website`, `rate_limit`, and
/// `authenticate_access`.
pub trait DesktopSocketGate: Clone + Send + Sync + 'static {
    fn website(&self) -> Result<String, ConfigError>;
    fn rate_limit<'a>(
        &'a self,
        bucket: &'a str,
        limit: i64,
    ) -> impl Future<Output = Result<(), OAuthFailure>> + Send + 'a;
    fn authenticate<'a>(
        &'a self,
        token: &'a str,
    ) -> impl Future<Output = Result<AccessIdentity, OAuthFailure>> + Send + 'a;
}

impl<C, P> DesktopSocketGate for OAuthApiService<C, P>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    fn website(&self) -> Result<String, ConfigError> {
        oauth_website()
    }

    fn rate_limit<'a>(
        &'a self,
        bucket: &'a str,
        limit: i64,
    ) -> impl Future<Output = Result<(), OAuthFailure>> + Send + 'a {
        OAuthApiService::rate_limit(self, bucket, limit)
    }

    fn authenticate<'a>(
        &'a self,
        token: &'a str,
    ) -> impl Future<Output = Result<AccessIdentity, OAuthFailure>> + Send + 'a {
        OAuthApiService::authenticate_access(self, token)
    }
}

#[derive(Clone)]
struct DesktopWsState<G> {
    gate: G,
    live: Arc<LiveConnections>,
}

struct LiveConnections {
    counts: Mutex<HashMap<String, usize>>,
}

struct SessionSlot {
    live: Arc<LiveConnections>,
    session_id: String,
}

impl LiveConnections {
    fn acquire(self: &Arc<Self>, session_id: &str) -> Option<SessionSlot> {
        let mut counts = self.counts.lock().unwrap_or_else(|poison| poison.into_inner());
        let count = counts.entry(session_id.to_owned()).or_insert(0);
        if *count >= MAX_LIVE_PER_SESSION {
            return None;
        }
        *count += 1;
        Some(SessionSlot { live: Arc::clone(self), session_id: session_id.to_owned() })
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        let mut counts = self.live.counts.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(count) = counts.get_mut(&self.session_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.session_id);
            }
        }
    }
}

struct Admission {
    token: String,
    identity: AccessIdentity,
    slot: SessionSlot,
}

/// Router nested at `/v1` by the desktop router. It has no boundary layer:
/// the source socket is not behind `oauthBoundary`.
pub fn desktop_websocket_router<G: DesktopSocketGate>(gate: G) -> Router {
    let state = DesktopWsState { gate, live: Arc::new(LiveConnections { counts: Mutex::new(HashMap::new()) }) };
    Router::new().route(DESKTOP_WS_ROUTE, any(upgrade::<G>)).with_state(state)
}

async fn upgrade<G: DesktopSocketGate>(State(state): State<DesktopWsState<G>>, request: Request) -> Response {
    let admission = match tokio::time::timeout(DESKTOP_WS_UPGRADE_TIMEOUT, admit(&state, &request)).await {
        Ok(Ok(admission)) => admission,
        Ok(Err(status)) => return status.into_response(),
        Err(_elapsed) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let (mut parts, _body) = request.into_parts();
    let prepared = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let gate = state.gate.clone();
    let Admission { token, identity, slot } = admission;
    prepared
        .protocols([DESKTOP_WS_PROTOCOL])
        .max_message_size(DESKTOP_WS_MAX_MESSAGE_BYTES)
        .max_frame_size(DESKTOP_WS_MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| run_socket(socket, gate, token, identity, slot))
}

/// Source reject order. `oauthWebsite()` runs only when `Origin` is present
/// and non-empty (`origin && origin !== oauthWebsite()`). A throw from that
/// call, from `rateLimit`, or from `authenticateAccess` is the upgrade
/// `catch`, which writes 401, including a rate-limit `slow_down`. The 403
/// scope miss and the 429 connection cap are explicit returns, so they keep
/// those statuses.
async fn admit<G: DesktopSocketGate>(
    state: &DesktopWsState<G>,
    request: &Request,
) -> Result<Admission, StatusCode> {
    if request.uri().query().is_some() {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if !origin.is_empty() {
            let website = state.gate.website().map_err(|_| StatusCode::UNAUTHORIZED)?;
            if origin.as_bytes() != website.as_bytes() {
                return Err(StatusCode::FORBIDDEN);
            }
        }
    }
    if !offers_protocol(request.headers()) {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }
    let peer = peer_ip(request);
    if state.gate.rate_limit(&format!("ws:{peer}"), CONNECT_LIMIT).await.is_err() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let header = request.headers().get(header::AUTHORIZATION).map(latin1).unwrap_or_default();
    let Some(token) = catalog::bearer_token(&header) else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let identity = match state.gate.authenticate(token).await {
        Ok(identity) => identity,
        Err(_) => return Err(StatusCode::UNAUTHORIZED),
    };
    if !identity.scopes.iter().any(|scope| scope == "desktop:connect") {
        return Err(StatusCode::FORBIDDEN);
    }
    let Some(slot) = state.live.acquire(&identity.session_id) else {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    };
    Ok(Admission { token: token.to_owned(), identity, slot })
}

fn offers_protocol(headers: &HeaderMap) -> bool {
    headers.get_all(header::SEC_WEBSOCKET_PROTOCOL).iter().any(|value| {
        value.as_bytes().split(|byte| *byte == b',').any(|part| trim_ascii(part) == DESKTOP_WS_PROTOCOL.as_bytes())
    })
}

fn trim_ascii(part: &[u8]) -> &[u8] {
    let start = part.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(part.len());
    let end = part.iter().rposition(|byte| !byte.is_ascii_whitespace()).map(|index| index + 1).unwrap_or(start);
    &part[start..end]
}

fn peer_ip(request: &Request) -> String {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|byte| char::from(*byte)).collect()
}

#[derive(Serialize)]
struct Hello<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    session_id: &'a str,
    channel_id: &'a str,
    scopes: &'a [String],
    pet_available: bool,
}

#[derive(Serialize)]
struct Pong<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
}

enum Beat {
    Ping,
    Expired,
    Terminate,
}

enum Step {
    Reply(String),
    Close { code: u16, reason: &'static str },
}

async fn run_socket<G: DesktopSocketGate>(
    socket: WebSocket,
    gate: G,
    token: String,
    identity: AccessIdentity,
    slot: SessionSlot,
) {
    let _slot = slot;
    let (mut sink, mut stream) = socket.split();
    let hello = Hello {
        kind: "hello",
        protocol_version: 1,
        session_id: &identity.session_id,
        channel_id: &identity.channel_id,
        scopes: &identity.scopes,
        pet_available: false,
    };
    let Ok(hello) = serde_json::to_string(&hello) else {
        return;
    };
    if sink.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    let alive = Arc::new(AtomicBool::new(true));
    let (beat_tx, mut beat_rx) = tokio::sync::mpsc::channel(4);
    let heartbeat = tokio::spawn(heartbeat(gate.clone(), token.clone(), Arc::clone(&alive), beat_tx));
    let _abort = Abort(heartbeat);
    loop {
        tokio::select! {
            biased;
            incoming = stream.next() => {
                match classify(incoming) {
                    Incoming::Pong => alive.store(true, Ordering::SeqCst),
                    Incoming::Ping | Incoming::Ignore => {}
                    Incoming::Stop => break,
                    Incoming::Data(message) => {
                        if drive_message(&gate, &token, &mut sink, &mut stream, &alive, &mut beat_rx, message).await {
                            break;
                        }
                    }
                }
            }
            beat = beat_rx.recv() => {
                if apply_beat(&mut sink, beat).await {
                    break;
                }
            }
        }
    }
}

/// `true` closes the socket. A second data frame while the first handler is
/// still awaiting rate-limit or re-authentication is close 4429. Ping and
/// pong are not `message` events in `ws`, so they do not trip the busy flag.
async fn drive_message<G: DesktopSocketGate>(
    gate: &G,
    token: &str,
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    alive: &AtomicBool,
    beat_rx: &mut tokio::sync::mpsc::Receiver<Beat>,
    message: Message,
) -> bool {
    let work = handle_data(gate, token, message);
    tokio::pin!(work);
    loop {
        tokio::select! {
            biased;
            incoming = stream.next() => {
                match classify(incoming) {
                    Incoming::Pong => alive.store(true, Ordering::SeqCst),
                    Incoming::Ping | Incoming::Ignore => {}
                    Incoming::Stop => return true,
                    Incoming::Data(_) => {
                        let _ = sink.send(close_message(4429, "Too many requests")).await;
                        return true;
                    }
                }
            }
            beat = beat_rx.recv() => {
                if apply_beat(sink, beat).await {
                    return true;
                }
            }
            result = &mut work => {
                return match result {
                    Ok(Step::Reply(text)) => sink.send(Message::Text(text.into())).await.is_err(),
                    Ok(Step::Close { code, reason }) => {
                        let _ = sink.send(close_message(code, reason)).await;
                        true
                    }
                    Err(()) => {
                        let _ = sink.send(close_message(4401, "Session expired or revoked")).await;
                        true
                    }
                };
            }
        }
    }
}

async fn handle_data<G: DesktopSocketGate>(gate: &G, token: &str, message: Message) -> Result<Step, ()> {
    gate.rate_limit(&format!("ws-message:{}", hash(token)), MESSAGE_LIMIT).await.map_err(|_| ())?;
    gate.authenticate(token).await.map_err(|_| ())?;
    let text = match message {
        Message::Text(text) => text,
        Message::Binary(_) => return Ok(Step::Close { code: 4400, reason: "Text messages required" }),
        _ => return Ok(Step::Reply(UNSUPPORTED.to_owned())),
    };
    let value = match serde_json::from_str::<Value>(text.as_str()) {
        Ok(value) => value,
        Err(_) => return Ok(Step::Close { code: 4400, reason: "Invalid JSON" }),
    };
    if !is_ping(&value) {
        return Ok(Step::Reply(UNSUPPORTED.to_owned()));
    }
    Ok(Step::Reply(pong_body(&value)))
}

fn is_ping(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("type").and_then(Value::as_str) != Some("ping") {
        return false;
    }
    match object.get("id") {
        None => true,
        Some(Value::String(id)) => utf16_len(id) <= 64,
        Some(_) => false,
    }
}

fn pong_body(value: &Value) -> String {
    let id = value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty());
    serde_json::to_string(&Pong { kind: "pong", id }).unwrap_or_else(|_| UNSUPPORTED.to_owned())
}

enum Incoming {
    Data(Message),
    Pong,
    Ping,
    Ignore,
    Stop,
}

fn classify(incoming: Option<Result<Message, axum::Error>>) -> Incoming {
    match incoming {
        Some(Ok(Message::Text(text))) => Incoming::Data(Message::Text(text)),
        Some(Ok(Message::Binary(data))) => Incoming::Data(Message::Binary(data)),
        Some(Ok(Message::Pong(_))) => Incoming::Pong,
        Some(Ok(Message::Ping(_))) => Incoming::Ping,
        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => Incoming::Stop,
    }
}

async fn apply_beat(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    beat: Option<Beat>,
) -> bool {
    match beat {
        Some(Beat::Ping) => sink.send(Message::Ping(Bytes::new())).await.is_err(),
        Some(Beat::Expired) => {
            let _ = sink.send(close_message(4401, "Session expired or revoked")).await;
            true
        }
        // `ws.terminate()` on a missed pong. No close code: the source does
        // not use 4401 for silence. 4401 is the re-auth failure.
        Some(Beat::Terminate) | None => true,
    }
}

fn close_message(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static(reason) }))
}

type AuthFuture = Pin<Box<dyn Future<Output = Result<AccessIdentity, OAuthFailure>> + Send>>;

async fn heartbeat<G: DesktopSocketGate>(
    gate: G,
    token: String,
    alive: Arc<AtomicBool>,
    beat_tx: tokio::sync::mpsc::Sender<Beat>,
) {
    let mut interval = tokio::time::interval(DESKTOP_WS_HEARTBEAT);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    let mut checking: Option<AuthFuture> = None;
    loop {
        tokio::select! {
            biased;
            result = poll_checking(&mut checking), if checking.is_some() => {
                checking = None;
                match result {
                    Ok(_) => {
                        if beat_tx.send(Beat::Ping).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = beat_tx.send(Beat::Expired).await;
                        break;
                    }
                }
            }
            _ = interval.tick() => {
                if checking.is_some() {
                    continue;
                }
                if !alive.load(Ordering::SeqCst) {
                    let _ = beat_tx.send(Beat::Terminate).await;
                    break;
                }
                alive.store(false, Ordering::SeqCst);
                let gate = gate.clone();
                let token = token.clone();
                checking = Some(Box::pin(async move { gate.authenticate(&token).await }));
            }
        }
    }
}

async fn poll_checking(checking: &mut Option<AuthFuture>) -> Result<AccessIdentity, OAuthFailure> {
    match checking.as_mut() {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

struct Abort(tokio::task::JoinHandle<()>);

impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}
