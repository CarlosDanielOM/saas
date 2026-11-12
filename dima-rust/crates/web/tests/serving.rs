//! The server's bounds on slow clients and long-lived streams, over real loopback connections:
//! the write-stall deadline, stream admission and what observers see.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use dima_web::{App, Body, Error, Req, Response, Router, ServeOptions, serve};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// What handlers report back to the test.
#[derive(Default)]
struct Probe {
    /// How the upgraded flood's last write failed.
    flood_error: Mutex<Option<std::io::ErrorKind>>,
}

type State = Arc<Probe>;

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
    root.get("/who", who);
    let probe = State::default();
    let app = App::new(root, Arc::clone(&probe)).expect("app");
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
