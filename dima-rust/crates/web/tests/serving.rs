//! The server's bounds on slow clients and long-lived streams, over real loopback connections:
//! the write-stall deadline, stream admission and what observers see.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use dima_web::{
    App, Body, Error, Observer, Req, RequestEnd, Response, Router, ServeOptions, serve,
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// What handlers report back to the test.
#[derive(Default)]
struct Probe {
    /// How the upgraded flood's last write failed.
    flood_error: Mutex<Option<std::io::ErrorKind>>,
    /// Sessions the reserving upgrade created.
    sessions: Mutex<usize>,
    /// What the observer saw end.
    ended: Mutex<Vec<RequestEnd>>,
}

type State = Arc<Probe>;

struct Watch(State);

impl Observer for Watch {
    fn on_response(&self, end: RequestEnd) {
        self.0.ended.lock().unwrap().push(end);
    }
}

impl Probe {
    /// The observed (status, aborted) of the exchanges for `url`, waiting until `count` ended.
    async fn ended_for(&self, url: &str, count: usize) -> Vec<(Option<u16>, bool)> {
        for _ in 0..200 {
            let seen: Vec<_> = self
                .ended
                .lock()
                .unwrap()
                .iter()
                .filter(|end| end.url == url)
                .map(|end| (end.status, end.aborted))
                .collect();
            if seen.len() >= count {
                return seen;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fewer than {count} exchanges for {url} ended");
    }
}

/// 64 KiB of filler, sent over and over.
fn chunk() -> Bytes {
    Bytes::from(vec![b'x'; 64 * 1024])
}

/// An endless body of filler that never waits for its producer: only the client's reading
/// limits it.
fn endless() -> Body {
    let stream = futures_util::stream::repeat_with(|| Ok::<_, std::io::Error>(chunk()));
    Body::from_stream(stream)
}

/// GET /flood: an ordinary response that never ends.
async fn flood(_req: &mut Req<State>) -> Response {
    Response::new()
        .header("Content-Type", "application/octet-stream")
        .stream(endless())
}

/// GET /sse-flood: an event stream that writes as fast as it may.
async fn sse_flood(_req: &mut Req<State>) -> Response {
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(endless())
}

/// GET /sse-quiet: one comment, a quiet period longer than the stall deadline, another comment,
/// then the end.
async fn sse_quiet(_req: &mut Req<State>) -> Response {
    let (events, body) = dima_web::sse::channel(dima_web::sse::SseOptions::new());
    tokio::spawn(async move {
        let _ = events.comment("first").await;
        tokio::time::sleep(Duration::from_millis(900)).await;
        let _ = events.comment("second").await;
        tokio::time::sleep(Duration::from_millis(900)).await;
        let _ = events.comment("third").await;
    });
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(body)
}

/// GET /flood-up: an upgrade whose owner writes until a write fails, and records how.
async fn flood_up(req: &mut Req<State>) -> Result<Response, Error> {
    let (Some(upgrade), Some(guard)) = (req.take_upgrade(), req.take_upgrade_guard()) else {
        return Ok(Response::send_status(426));
    };
    let probe = Arc::clone(req.state());
    tokio::spawn(async move {
        let _guard = guard;
        let Ok(upgraded) = upgrade.await else { return };
        let mut io = hyper_util::rt::TokioIo::new(upgraded);
        let filler = chunk();
        loop {
            if let Err(error) = io.write_all(&filler).await {
                *probe.flood_error.lock().unwrap() = Some(error.kind());
                return;
            }
        }
    });
    let response = http::Response::builder()
        .status(101)
        .header("Connection", "Upgrade")
        .header("Upgrade", "flood")
        .body(Body::empty())?;
    Ok(Response::from_http(response))
}

/// GET /sse-once: one comment, then the end of the stream.
async fn sse_once(_req: &mut Req<State>) -> Response {
    let (events, body) = dima_web::sse::channel(dima_web::sse::SseOptions::new());
    tokio::spawn(async move {
        let _ = events.comment("once").await;
    });
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(body)
}

/// GET /sse-hold: an event stream that stays open until the client goes away.
async fn sse_hold(_req: &mut Req<State>) -> Response {
    let (events, body) = dima_web::sse::channel(dima_web::sse::SseOptions::new());
    tokio::spawn(async move {
        let _ = events.comment("open").await;
        events.closed().await;
    });
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(body)
}

/// GET /sse-none: an event-stream type on an answer without a body.
async fn sse_none(_req: &mut Req<State>) -> Response {
    Response::send_status(204).header("Content-Type", "text/event-stream")
}

/// The answer an owner gives when it cannot have a stream slot: nothing was created.
fn no_room() -> Response {
    Response::send_status(503).header("X-Refused-By", "handler")
}

/// GET /reserve-up: reserves a stream slot before creating its session, then upgrades and holds
/// the socket until shutdown.
async fn reserve_up(req: &mut Req<State>) -> Result<Response, Error> {
    let admission = req.stream_admission().cloned();
    if admission.is_none_or(|admission| admission.reserve().is_err()) {
        return Ok(no_room());
    }
    let (Some(upgrade), Some(guard)) = (req.take_upgrade(), req.take_upgrade_guard()) else {
        return Ok(Response::send_status(426));
    };
    *req.state().sessions.lock().unwrap() += 1;
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        guard.shutting_down().await;
        drop(upgraded);
    });
    let response = http::Response::builder()
        .status(101)
        .header("Connection", "Upgrade")
        .header("Upgrade", "flood")
        .body(Body::empty())?;
    Ok(Response::from_http(response))
}

/// GET /reserve-sse: reserves, then streams until the client goes away.
async fn reserve_sse(req: &mut Req<State>) -> Response {
    let reserved = req
        .stream_admission()
        .is_some_and(|admission| admission.reserve().is_ok());
    if !reserved {
        return no_room();
    }
    sse_hold(req).await
}

/// GET /reserve-then-fail: reserves, then answers an ordinary 400.
async fn reserve_then_fail(req: &mut Req<State>) -> Response {
    let reserved = req
        .stream_admission()
        .is_some_and(|admission| admission.reserve().is_ok());
    Response::send_status(if reserved { 400 } else { 500 })
}

async fn who(_req: &mut Req<State>) -> Response {
    Response::new().text("here")
}

async fn start(
    options: ServeOptions,
) -> (
    std::net::SocketAddr,
    State,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let mut root = Router::new();
    root.get("/flood", flood);
    root.get("/sse-flood", sse_flood);
    root.get("/sse-quiet", sse_quiet);
    root.get("/flood-up", flood_up);
    root.get("/sse-once", sse_once);
    root.get("/sse-hold", sse_hold);
    root.get("/sse-none", sse_none);
    root.get("/reserve-up", reserve_up);
    root.get("/reserve-sse", reserve_sse);
    root.get("/reserve-then-fail", reserve_then_fail);
    root.get("/who", who);
    let probe = State::default();
    let app = App::new(root, Arc::clone(&probe))
        .expect("app")
        .observe(Watch(Arc::clone(&probe)));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let token = CancellationToken::new();
    let server = tokio::spawn(serve(listener, app, token.clone(), options));
    (addr, probe, token, server)
}

/// Reads a response head byte by byte.
async fn read_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("response head");
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// Sends `request` on a new connection and returns the answer's first line.
async fn status_of(addr: std::net::SocketAddr, request: &str) -> String {
    let answer = async {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("write");
        read_head(&mut stream).await
    };
    let head = tokio::time::timeout(Duration::from_secs(5), answer)
        .await
        .expect("answered");
    head.lines().next().unwrap_or_default().to_owned()
}

/// A connection that opens `path` and then never reads again.
async fn stalled_reader(addr: std::net::SocketAddr, path: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("write");
    let head = read_head(&mut stream).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    stream
}

/// Reads until the server closes the connection; `false` when it is still open after `within`.
async fn closes_within(stream: &mut TcpStream, within: Duration) -> bool {
    let drain = async {
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    };
    tokio::time::timeout(within, drain).await.is_ok()
}

const STALL: Duration = Duration::from_millis(300);

/// Review finding: an active response switched idle eviction off and nothing bounded a write
/// that made no progress, so clients that stopped reading held their connection slots for ever.
#[tokio::test]
async fn a_response_nobody_reads_is_closed_after_the_write_stall() {
    let options = ServeOptions {
        max_connections: 1,
        write_stall_timeout: STALL,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let _stalled = stalled_reader(addr, "/flood").await;
    // The only slot frees once the stalled write gives up, and the next client is served.
    assert_eq!(
        status_of(
            addr,
            "GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
        )
        .await,
        "HTTP/1.1 200 OK"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Review finding: clients that open an event stream and never read used up `max_streams`.
#[tokio::test]
async fn an_event_stream_nobody_reads_is_closed_after_the_write_stall() {
    let options = ServeOptions {
        max_streams: 1,
        write_stall_timeout: STALL,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let _stalled = stalled_reader(addr, "/sse-flood").await;
    let mut status = String::new();
    for _ in 0..50 {
        status = status_of(addr, "GET /sse-quiet HTTP/1.1\r\nHost: x\r\n\r\n").await;
        if status.starts_with("HTTP/1.1 200") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(status, "HTTP/1.1 200 OK");
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Only a pending write that makes no progress counts: a healthy stream may be quiet for
/// longer than the deadline.
#[tokio::test]
async fn a_quiet_event_stream_is_not_a_stall() {
    let options = ServeOptions {
        write_stall_timeout: STALL,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let mut stream = stalled_reader(addr, "/sse-quiet").await;
    let mut received = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), async {
        let mut buf = [0u8; 1024];
        while !String::from_utf8_lossy(&received).contains(": third") {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            received.extend_from_slice(&buf[..n]);
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .expect("every frame arrived");
    assert!(read.is_ok(), "{read:?}");
    let text = String::from_utf8_lossy(&received);
    assert!(
        text.contains(": first") && text.contains(": third"),
        "{text}"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// The deadline covers upgraded sockets too: the owner's write fails with `TimedOut` and the
/// connection closes.
#[tokio::test]
async fn an_upgraded_socket_whose_peer_stops_reading_fails_its_writes() {
    let options = ServeOptions {
        write_stall_timeout: STALL,
        ..ServeOptions::default()
    };
    let (addr, probe, token, server) = start(options).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(
            b"GET /flood-up HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: flood\r\n\r\n",
        )
        .await
        .expect("write");
    let head = read_head(&mut stream).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    let mut failed = None;
    for _ in 0..100 {
        failed = *probe.flood_error.lock().unwrap();
        if failed.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(failed, Some(std::io::ErrorKind::TimedOut));
    assert!(closes_within(&mut stream, Duration::from_secs(5)).await);
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Review finding: after a finite event stream the connection went back to keep-alive requests
/// while still holding its stream slot. A promoted connection now closes when its answer ends.
#[tokio::test]
async fn a_finished_event_stream_closes_its_connection() {
    let options = ServeOptions {
        max_connections: 1,
        max_streams: 1,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"GET /sse-once HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .expect("write");
    let mut received = Vec::new();
    // Well before the 5 s keep-alive timeout.
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut received))
        .await
        .expect("the server closed the connection")
        .expect("read");
    let text = String::from_utf8_lossy(&received);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert!(text.contains(": once"), "{text}");
    assert!(
        text.to_ascii_lowercase().contains("connection: close"),
        "{text}"
    );
    // Both quotas are free again.
    assert_eq!(
        status_of(addr, "GET /sse-hold HTTP/1.1\r\nHost: x\r\n\r\n").await,
        "HTTP/1.1 200 OK"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Review finding: HEAD, 204 and 304 answers with an event-stream type were promoted (or
/// refused with 503) although no stream follows them.
#[tokio::test]
async fn answers_without_a_body_never_take_a_stream_slot() {
    let options = ServeOptions {
        max_streams: 1,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let held = stalled_reader(addr, "/sse-hold").await;
    let close = "Host: x\r\nConnection: close\r\n\r\n";
    assert_eq!(
        status_of(addr, &format!("HEAD /sse-hold HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 200 OK"
    );
    assert_eq!(
        status_of(addr, &format!("GET /sse-none HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 204 No Content"
    );
    // A real second stream is still refused.
    assert_eq!(
        status_of(addr, &format!("GET /sse-hold HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 503 Service Unavailable"
    );
    drop(held);
    token.cancel();
    server.await.expect("join").expect("serve");
}

const UPGRADE: &str = "Host: x\r\nConnection: Upgrade\r\nUpgrade: flood\r\n\r\n";

/// Review finding: the stream quota was checked only once the answer was built, so a refused
/// upgrade had already created its session. A handler now reserves the slot first, and a
/// reserved answer is promoted without a second check.
#[tokio::test]
async fn a_handler_reserves_a_stream_slot_before_creating_anything() {
    let options = ServeOptions {
        max_streams: 1,
        ..ServeOptions::default()
    };
    let (addr, probe, token, server) = start(options).await;
    // The reservation holds the only slot; its own answer is still promoted.
    let held = stalled_reader(addr, "/reserve-sse").await;
    let mut refused = TcpStream::connect(addr).await.expect("connect");
    refused
        .write_all(format!("GET /reserve-up HTTP/1.1\r\n{UPGRADE}").as_bytes())
        .await
        .expect("write");
    let head = read_head(&mut refused).await;
    assert!(head.starts_with("HTTP/1.1 503"), "{head}");
    assert!(head.contains("x-refused-by: handler"), "{head}");
    assert_eq!(*probe.sessions.lock().unwrap(), 0, "nothing was created");
    drop(refused);
    drop(held);
    let mut head = String::new();
    let mut upgraded = None;
    for _ in 0..100 {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream
            .write_all(format!("GET /reserve-up HTTP/1.1\r\n{UPGRADE}").as_bytes())
            .await
            .expect("write");
        head = read_head(&mut stream).await;
        if head.starts_with("HTTP/1.1 101") {
            upgraded = Some(stream);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(upgraded.is_some(), "{head}");
    assert_eq!(*probe.sessions.lock().unwrap(), 1);
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// A reservation whose answer starts no stream gives its slot back.
#[tokio::test]
async fn a_reservation_without_a_stream_is_released() {
    let options = ServeOptions {
        max_streams: 1,
        ..ServeOptions::default()
    };
    let (addr, _probe, token, server) = start(options).await;
    let close = "Host: x\r\nConnection: close\r\n\r\n";
    assert_eq!(
        status_of(addr, &format!("GET /reserve-then-fail HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 400 Bad Request"
    );
    assert_eq!(
        status_of(addr, &format!("GET /reserve-then-fail HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 400 Bad Request"
    );
    let held = stalled_reader(addr, "/sse-hold").await;
    drop(held);
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// Review finding: when the late check refused a stream, the completion record said 101 (or
/// the event stream's 200) although the client received 503.
#[tokio::test]
async fn observers_see_the_refusal_that_was_sent() {
    let options = ServeOptions {
        max_streams: 1,
        ..ServeOptions::default()
    };
    let (addr, probe, token, server) = start(options).await;
    let held = stalled_reader(addr, "/sse-hold").await;
    let close = "Host: x\r\nConnection: close\r\n\r\n";
    assert_eq!(
        status_of(addr, &format!("GET /sse-once HTTP/1.1\r\n{close}")).await,
        "HTTP/1.1 503 Service Unavailable"
    );
    assert_eq!(
        status_of(addr, &format!("GET /flood-up HTTP/1.1\r\n{UPGRADE}")).await,
        "HTTP/1.1 503 Service Unavailable"
    );
    assert_eq!(probe.ended_for("/sse-once", 1).await, [(Some(503), false)]);
    assert_eq!(probe.ended_for("/flood-up", 1).await, [(Some(503), false)]);
    drop(held);
    token.cancel();
    server.await.expect("join").expect("serve");
}

/// An observer that takes its time over every record, or never returns from one.
struct Slow {
    delay: Option<Duration>,
    delivered: Arc<Mutex<usize>>,
}

impl Observer for Slow {
    fn on_response(&self, _end: RequestEnd) {
        match self.delay {
            Some(delay) => std::thread::sleep(delay),
            // Stuck for good (the test process ends around it).
            None => loop {
                std::thread::park();
            },
        }
        *self.delivered.lock().unwrap() += 1;
    }
}

async fn serve_slow_observer(
    delay: Option<Duration>,
) -> (
    std::net::SocketAddr,
    Arc<Mutex<usize>>,
    dima_web::ObserverQueue,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let mut root = Router::new();
    root.get("/who", who);
    let delivered = Arc::new(Mutex::new(0));
    let app = App::new(root, State::default())
        .expect("app")
        .observe(Slow {
            delay,
            delivered: Arc::clone(&delivered),
        });
    let queue = app.observer_queue().expect("observed");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let token = CancellationToken::new();
    let options = ServeOptions {
        drain_timeout: Duration::from_millis(300),
        ..ServeOptions::default()
    };
    let server = tokio::spawn(serve(listener, app, token.clone(), options));
    (addr, delivered, queue, token, server)
}

/// Review finding: `serve` returned without waiting for queued completion records.
#[tokio::test]
async fn shutdown_waits_for_queued_completion_records() {
    let (addr, delivered, _queue, token, server) =
        serve_slow_observer(Some(Duration::from_millis(250))).await;
    let close = "Host: x\r\nConnection: close\r\n\r\n";
    for _ in 0..3 {
        assert_eq!(
            status_of(addr, &format!("GET /who HTTP/1.1\r\n{close}")).await,
            "HTTP/1.1 200 OK"
        );
    }
    token.cancel();
    server.await.expect("join").expect("serve");
    assert_eq!(*delivered.lock().unwrap(), 3);
}

/// Review finding: a stuck observer callback left `idle()` pending for ever. Shutdown waits a
/// bounded time, then the observer is shut down and `idle()` returns.
#[tokio::test]
async fn a_stuck_observer_cannot_hold_shutdown() {
    let (addr, delivered, queue, token, server) = serve_slow_observer(None).await;
    let close = "Host: x\r\nConnection: close\r\n\r\n";
    for _ in 0..2 {
        assert_eq!(
            status_of(addr, &format!("GET /who HTTP/1.1\r\n{close}")).await,
            "HTTP/1.1 200 OK"
        );
    }
    let began = std::time::Instant::now();
    token.cancel();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("serve returned")
        .expect("join")
        .expect("serve");
    assert!(
        began.elapsed() >= Duration::from_secs(1),
        "{:?}",
        began.elapsed()
    );
    tokio::time::timeout(Duration::from_secs(1), queue.idle())
        .await
        .expect("idle returns once the observer is shut down");
    assert_eq!(*delivered.lock().unwrap(), 0);
}
