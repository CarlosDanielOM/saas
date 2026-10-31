#![cfg(feature = "oauth-api")]
//! Loopback tests for the desktop WebSocket port.
//!
//! The client speaks masked frames on TCP. `OauthFixture` is not used: its
//! contract is a disposable MongoDB database and a Redis `oauth:*` keyspace,
//! and these tests must not open either. The gate is in-memory. No Twitch
//! call is made. `DASHBOARD_URL` is not read; the gate returns the website.

use std::{
    collections::HashMap,
    future::Future,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::Router;
use dima_rust::oauth_api::{
    catalog::{self, ConfigError},
    desktop_websocket::{
        desktop_websocket_router, DesktopSocketGate, DESKTOP_WS_PATH, DESKTOP_WS_PROTOCOL, DESKTOP_WS_ROUTE,
    },
    hash, AccessIdentity, OAuthError, OAuthFailure,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

const WEBSITE: &str = "https://domdimabot.com";

#[derive(Clone)]
struct MemoryGate {
    inner: Arc<MemoryInner>,
}

struct MemoryInner {
    website: Mutex<Result<String, ConfigError>>,
    website_calls: AtomicUsize,
    identities: Mutex<HashMap<String, AccessIdentity>>,
    calls: Mutex<Vec<(String, i64)>>,
    connect_fail: AtomicBool,
    hold: Mutex<Option<Hold>>,
}

struct Hold {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl MemoryGate {
    fn issuing(pairs: Vec<(String, AccessIdentity)>) -> Self {
        Self {
            inner: Arc::new(MemoryInner {
                website: Mutex::new(Ok(WEBSITE.to_owned())),
                website_calls: AtomicUsize::new(0),
                identities: Mutex::new(pairs.into_iter().collect()),
                calls: Mutex::new(Vec::new()),
                connect_fail: AtomicBool::new(false),
                hold: Mutex::new(None),
            }),
        }
    }

    fn fail_website(&self) {
        *self.inner.website.lock().expect("website") = Err(ConfigError::DashboardUrl);
    }

    fn fail_connect(&self) {
        self.inner.connect_fail.store(true, Ordering::SeqCst);
    }

    fn hold_messages(&self, entered: Arc<Notify>, release: Arc<Notify>) {
        *self.inner.hold.lock().expect("hold") = Some(Hold { entered, release });
    }

    fn calls(&self) -> Vec<(String, i64)> {
        self.inner.calls.lock().expect("calls").clone()
    }

    fn website_calls(&self) -> usize {
        self.inner.website_calls.load(Ordering::SeqCst)
    }
}

impl DesktopSocketGate for MemoryGate {
    fn website(&self) -> Result<String, ConfigError> {
        self.inner.website_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.website.lock().expect("website").clone()
    }

    fn rate_limit<'a>(
        &'a self,
        bucket: &'a str,
        limit: i64,
    ) -> impl Future<Output = Result<(), OAuthFailure>> + Send + 'a {
        let gate = self.clone();
        let bucket = bucket.to_owned();
        async move {
            gate.inner.calls.lock().expect("calls").push((bucket.clone(), limit));
            if bucket.starts_with("ws-message:") {
                let hold = gate.inner.hold.lock().expect("hold").take();
                if let Some(hold) = hold {
                    let wait = hold.release.notified();
                    hold.entered.notify_one();
                    wait.await;
                }
            }
            if gate.inner.connect_fail.load(Ordering::SeqCst) && bucket.starts_with("ws:") {
                return Err(OAuthError::SlowDown.into());
            }
            Ok(())
        }
    }

    fn authenticate<'a>(
        &'a self,
        token: &'a str,
    ) -> impl Future<Output = Result<AccessIdentity, OAuthFailure>> + Send + 'a {
        let gate = self.clone();
        let token = token.to_owned();
        async move {
            gate.inner
                .identities
                .lock()
                .expect("identities")
                .get(&token)
                .cloned()
                .ok_or_else(|| OAuthError::InvalidToken.into())
        }
    }
}

fn identity(session_id: &str, scopes: &[&str]) -> AccessIdentity {
    AccessIdentity {
        session_id: session_id.to_owned(),
        user_id: "user-1".to_owned(),
        client_id: "dima-desktop".to_owned(),
        channel_id: "12345".to_owned(),
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
    }
}

fn token(mark: char) -> String {
    format!("dima_at_{}", mark.to_string().repeat(43))
}

fn hello_json(identity: &AccessIdentity) -> String {
    format!(
        r#"{{"type":"hello","protocol_version":1,"session_id":"{}","channel_id":"{}","scopes":{},"pet_available":false}}"#,
        identity.session_id,
        identity.channel_id,
        serde_json::to_string(&identity.scopes).expect("scopes"),
    )
}

fn assert_buckets(gate: &MemoryGate, raw_token: &str, messages: bool) {
    let calls = gate.calls();
    let message = format!("ws-message:{}", hash(raw_token));
    assert!(calls.iter().all(|(bucket, limit)| {
        (bucket == "ws:127.0.0.1" && *limit == 120) || (bucket == &message && *limit == 60)
    }));
    assert!(calls.iter().any(|(bucket, _)| bucket == "ws:127.0.0.1"));
    if messages {
        assert!(calls.iter().any(|(bucket, _)| bucket == &message));
    }
}

struct Frame {
    opcode: u8,
    payload: Vec<u8>,
}

struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
}

struct Socket {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    conn: Conn,
}

impl Conn {
    async fn pull(&mut self, need: usize) {
        while self.buf.len() < need {
            let mut tmp = [0_u8; 2048];
            let read = tokio::time::timeout(Duration::from_secs(2), self.stream.read(&mut tmp))
                .await
                .expect("read timeout")
                .expect("read");
            assert!(read > 0, "socket closed");
            self.buf.extend_from_slice(&tmp[..read]);
        }
    }

    async fn send(&mut self, opcode: u8, payload: &[u8]) {
        self.stream.write_all(&client_frame(opcode, payload)).await.expect("write");
        self.stream.flush().await.expect("flush");
    }

    async fn read_frame(&mut self) -> Frame {
        self.pull(2).await;
        let first = self.buf[0];
        let second = self.buf[1];
        assert_eq!(first & 0x80, 0x80, "fin");
        assert_eq!(first & 0x70, 0, "rsv");
        assert_eq!(second & 0x80, 0, "server frames are unmasked");
        let mut length = (second & 0x7f) as usize;
        let mut header = 2;
        if length == 126 {
            self.pull(4).await;
            length = u16::from_be_bytes([self.buf[2], self.buf[3]]) as usize;
            header = 4;
        }
        self.pull(header + length).await;
        let payload = self.buf[header..header + length].to_vec();
        self.buf.drain(..header + length);
        Frame { opcode: first & 0x0f, payload }
    }

    async fn read_data(&mut self) -> Frame {
        loop {
            let frame = self.read_frame().await;
            if frame.opcode == 9 || frame.opcode == 10 {
                continue;
            }
            return frame;
        }
    }
}

impl Socket {
    async fn text(&mut self) -> String {
        let frame = tokio::time::timeout(Duration::from_secs(2), self.conn.read_data())
            .await
            .expect("text timeout");
        assert_eq!(frame.opcode, 1, "text opcode");
        String::from_utf8(frame.payload).expect("utf-8")
    }

    async fn close(&mut self) -> (u16, String) {
        let frame = tokio::time::timeout(Duration::from_secs(2), self.conn.read_data())
            .await
            .expect("close timeout");
        assert_eq!(frame.opcode, 8, "close opcode");
        assert!(frame.payload.len() >= 2, "close payload");
        let code = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
        let reason = String::from_utf8(frame.payload[2..].to_vec()).expect("reason");
        (code, reason)
    }

    async fn send(&mut self, opcode: u8, payload: &[u8]) {
        self.conn.send(opcode, payload).await;
    }
}

fn client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [0x11, 0x22, 0x33, 0x44];
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(0x80 | opcode);
    if payload.len() < 126 {
        out.push(0x80 | payload.len() as u8);
    } else {
        out.push(0x80 | 126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));
    out
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

async fn serve(gate: MemoryGate) -> SocketAddr {
    let router = Router::new().nest(catalog::DESKTOP_MOUNT, desktop_websocket_router(gate));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await;
    });
    address
}

async fn dial(address: SocketAddr, path: &str, headers: &[(&str, &str)]) -> Socket {
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    );
    for (name, value) in headers {
        request.push_str(name);
        if value.is_empty() {
            request.push_str(":\r\n");
        } else {
            request.push_str(": ");
            request.push_str(value);
            request.push_str("\r\n");
        }
    }
    request.push_str("\r\n");
    let mut last = String::new();
    for _ in 0..40 {
        match TcpStream::connect(address).await {
            Ok(mut stream) => {
                stream.write_all(request.as_bytes()).await.expect("handshake write");
                let mut conn = Conn { stream, buf: Vec::new() };
                conn.pull(4).await;
                let split = loop {
                    if let Some(index) = conn.buf.windows(4).position(|window| window == b"\r\n\r\n") {
                        break index;
                    }
                    conn.pull(conn.buf.len() + 1).await;
                };
                let header_text = String::from_utf8(conn.buf[..split].to_vec()).expect("headers").replace('\r', "");
                conn.buf.drain(..split + 4);
                let status = header_text
                    .lines()
                    .next()
                    .expect("status")
                    .split_whitespace()
                    .nth(1)
                    .expect("code")
                    .parse()
                    .expect("status number");
                let headers = header_text
                    .lines()
                    .skip(1)
                    .filter_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        Some((name.trim().to_owned(), value.trim().to_owned()))
                    })
                    .collect::<Vec<_>>();
                let length = header(&headers, "content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
                conn.pull(length).await;
                let body = conn.buf[..length].to_vec();
                conn.buf.drain(..length);
                return Socket { status, headers, body, conn };
            }
            Err(error) => {
                last = error.to_string();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
    panic!("connect failed: {last}");
}

async fn opened(address: SocketAddr, raw_token: &str, origin: Option<&str>, protocol: &str) -> Socket {
    let authorization = format!("Bearer {raw_token}");
    let mut pairs = vec![("Sec-WebSocket-Protocol", protocol), ("Authorization", authorization.as_str())];
    if let Some(origin) = origin {
        pairs.push(("Origin", origin));
    }
    let socket = dial(address, "/v1/desktop/ws", &pairs).await;
    assert_eq!(socket.status, 101);
    assert_eq!(header(&socket.headers, "sec-websocket-protocol"), Some(DESKTOP_WS_PROTOCOL));
    assert!(socket.body.is_empty());
    socket
}

async fn rejected(address: SocketAddr, path: &str, headers: &[(&str, &str)]) -> u16 {
    let socket = dial(address, path, headers).await;
    assert!(socket.body.is_empty(), "raw status body is empty");
    socket.status
}

#[test]
fn desktop_socket_path_is_under_v1() {
    assert_eq!(catalog::DESKTOP_MOUNT, "/v1");
    assert_eq!(DESKTOP_WS_ROUTE, "/desktop/ws");
    assert_eq!(DESKTOP_WS_PATH, "/v1/desktop/ws");
    assert_eq!(DESKTOP_WS_PROTOCOL, "dima.desktop.v1");
}

#[tokio::test]
async fn hello_ping_and_protocol_list_match_source_frames() {
    let raw = token('a');
    let who = identity("sess-1", &["desktop:connect", "profile:read"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    let address = serve(gate.clone()).await;
    let mut socket = opened(address, &raw, Some(WEBSITE), DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    socket.send(1, br#"{"type":"ping"}"#).await;
    assert_eq!(socket.text().await, r#"{"type":"pong"}"#);
    socket.send(1, br#"{"type":"ping","id":"abc"}"#).await;
    assert_eq!(socket.text().await, r#"{"type":"pong","id":"abc"}"#);
    socket.send(1, br#"{"type":"ping","id":""}"#).await;
    assert_eq!(socket.text().await, r#"{"type":"pong"}"#);
    let long = "x".repeat(64);
    let ping = format!(r#"{{"type":"ping","id":"{long}"}}"#);
    let pong = format!(r#"{{"type":"pong","id":"{long}"}}"#);
    socket.send(1, ping.as_bytes()).await;
    assert_eq!(socket.text().await, pong);
    socket.send(1, br#"{"extra":true,"type":"ping","id":"a"}"#).await;
    assert_eq!(socket.text().await, r#"{"type":"pong","id":"a"}"#);
    assert_eq!(gate.website_calls(), 1);
    assert_buckets(&gate, &raw, true);

    let mut spaced = opened(address, &raw, None, "foo, dima.desktop.v1").await;
    assert_eq!(spaced.text().await, hello_json(&who));
    assert_eq!(gate.website_calls(), 1);
}

#[tokio::test]
async fn unsupported_messages_stay_open() {
    let raw = token('b');
    let who = identity("sess-2", &["desktop:connect"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    let address = serve(gate).await;
    let mut socket = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    let unsupported = r#"{"type":"error","error":"unsupported_message"}"#;
    let payloads = [
        r#"{"type":"hello"}"#.to_owned(),
        format!(r#"{{"type":"ping","id":"{}"}}"#, "y".repeat(65)),
        r#"{"type":"ping","id":1}"#.to_owned(),
        r#"{"type":"ping","id":null}"#.to_owned(),
        "[]".to_owned(),
        "null".to_owned(),
    ];
    for payload in payloads {
        socket.send(1, payload.as_bytes()).await;
        assert_eq!(socket.text().await, unsupported);
    }
}

#[tokio::test]
async fn binary_frame_closes_4400() {
    let raw = token('c');
    let who = identity("sess-3", &["desktop:connect"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    let address = serve(gate).await;
    let mut socket = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    socket.send(2, &[1, 2, 3]).await;
    assert_eq!(socket.close().await, (4400, "Text messages required".to_owned()));
}

#[tokio::test]
async fn invalid_json_closes_4400() {
    let raw = token('d');
    let who = identity("sess-4", &["desktop:connect"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    let address = serve(gate).await;
    let mut socket = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    socket.send(1, b"{").await;
    assert_eq!(socket.close().await, (4400, "Invalid JSON".to_owned()));
}

#[tokio::test]
async fn second_data_frame_while_busy_closes_4429() {
    let raw = token('e');
    let who = identity("sess-5", &["desktop:connect"]);
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    gate.hold_messages(Arc::clone(&entered), release);
    let address = serve(gate.clone()).await;
    let mut socket = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    let waiting = entered.notified();
    socket.send(1, br#"{"type":"ping"}"#).await;
    tokio::time::timeout(Duration::from_secs(2), waiting).await.expect("handler held");
    socket.send(9, b"ping").await;
    socket.send(1, br#"{"type":"ping","id":"second"}"#).await;
    assert_eq!(socket.close().await, (4429, "Too many requests".to_owned()));
    assert_buckets(&gate, &raw, true);
}

#[tokio::test]
async fn query_and_origin_are_403_before_the_protocol_check() {
    let raw = token('f');
    let gate = MemoryGate::issuing(vec![(raw.clone(), identity("sess-6", &["desktop:connect"]))]);
    let address = serve(gate.clone()).await;
    let authorization = format!("Bearer {raw}");
    let protocol = [("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL), ("Authorization", authorization.as_str())];
    assert_eq!(rejected(address, "/v1/desktop/ws?", &protocol).await, 403);
    assert_eq!(rejected(address, "/v1/desktop/ws?x=1", &protocol).await, 403);
    assert_eq!(gate.website_calls(), 0);
    assert!(gate.calls().is_empty());
    assert_eq!(
        rejected(address, "/v1/desktop/ws", &[("Origin", "https://evil.example"), ("Authorization", authorization.as_str())]).await,
        403
    );
    assert_eq!(gate.website_calls(), 1);
    assert!(gate.calls().is_empty());
}

#[tokio::test]
async fn protocol_token_scope_and_connect_limit_use_raw_statuses() {
    let raw = token('g');
    let other = token('h');
    let gate = MemoryGate::issuing(vec![
        (raw.clone(), identity("sess-7", &["desktop:connect"])),
        (other.clone(), identity("sess-8", &["profile:read"])),
    ]);
    let address = serve(gate.clone()).await;
    let authorization = format!("Bearer {raw}");
    assert_eq!(rejected(address, "/v1/desktop/ws", &[("Authorization", authorization.as_str())]).await, 426);
    assert_eq!(
        rejected(address, "/v1/desktop/ws", &[("Sec-WebSocket-Protocol", "foo"), ("Authorization", authorization.as_str())]).await,
        426
    );
    assert_eq!(rejected(address, "/v1/desktop/ws", &[("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL)]).await, 401);
    assert_eq!(
        rejected(
            address,
            "/v1/desktop/ws",
            &[("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL), ("Authorization", "Bearer not-a-token")],
        )
        .await,
        401
    );
    let scoped = format!("Bearer {other}");
    assert_eq!(
        rejected(
            address,
            "/v1/desktop/ws",
            &[("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL), ("Authorization", scoped.as_str())],
        )
        .await,
        403
    );
    assert_eq!(gate.website_calls(), 0);
    assert!(gate.calls().iter().all(|(bucket, limit)| bucket == "ws:127.0.0.1" && *limit == 120));
    assert!(gate.calls().len() >= 3);

    gate.fail_connect();
    assert_eq!(
        rejected(
            address,
            "/v1/desktop/ws",
            &[("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL), ("Authorization", authorization.as_str())],
        )
        .await,
        401
    );
}

#[tokio::test]
async fn missing_or_empty_origin_does_not_call_website() {
    let raw = token('i');
    let who = identity("sess-9", &["desktop:connect"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    gate.fail_website();
    let address = serve(gate.clone()).await;
    let mut socket = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(socket.text().await, hello_json(&who));
    assert_eq!(gate.website_calls(), 0);
    let mut empty = opened(address, &raw, Some(""), DESKTOP_WS_PROTOCOL).await;
    assert_eq!(empty.text().await, hello_json(&who));
    assert_eq!(gate.website_calls(), 0);
    let authorization = format!("Bearer {raw}");
    assert_eq!(
        rejected(
            address,
            "/v1/desktop/ws",
            &[
                ("Origin", WEBSITE),
                ("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL),
                ("Authorization", authorization.as_str()),
            ],
        )
        .await,
        401
    );
    assert_eq!(gate.website_calls(), 1);
}

#[tokio::test]
async fn two_live_sockets_return_429_until_one_closes() {
    let raw = token('j');
    let who = identity("sess-live", &["desktop:connect"]);
    let gate = MemoryGate::issuing(vec![(raw.clone(), who.clone())]);
    let address = serve(gate).await;
    let mut first = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(first.text().await, hello_json(&who));
    let mut second = opened(address, &raw, None, DESKTOP_WS_PROTOCOL).await;
    assert_eq!(second.text().await, hello_json(&who));
    let authorization = format!("Bearer {raw}");
    let headers = [("Sec-WebSocket-Protocol", DESKTOP_WS_PROTOCOL), ("Authorization", authorization.as_str())];
    assert_eq!(rejected(address, "/v1/desktop/ws", &headers).await, 429);
    first.send(8, &1000_u16.to_be_bytes()).await;
    drop(first);
    let mut reopened = None;
    for _ in 0..40 {
        let mut socket = dial(address, "/v1/desktop/ws", &headers).await;
        if socket.status == 101 {
            assert_eq!(socket.text().await, hello_json(&who));
            reopened = Some(socket);
            break;
        }
        assert_eq!(socket.status, 429);
        assert!(socket.body.is_empty());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(reopened.is_some(), "slot released after close");
    drop(second);
}
