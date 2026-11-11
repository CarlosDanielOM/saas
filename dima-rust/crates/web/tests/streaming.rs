//! Streaming responses, Server-Sent Events, client disconnect and the telemetry seam, over real
//! connections.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use dima_web::sse::{self, Event, SseOptions};
use dima_web::{
    App, Observer, Req, RequestEnd, RequestStart, Response, Router, ServeOptions, TraceContext,
    cors, serve,
};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// What the tests' observer recorded.
#[derive(Default)]
struct Recorder {
    ended: Mutex<Vec<RequestEnd>>,
    started: Mutex<Vec<String>>,
}

#[derive(Clone)]
struct Recording(Arc<Recorder>);

#[derive(Debug, Clone, PartialEq)]
struct TraceId(String);

impl Observer for Recording {
    fn on_request(&self, start: &RequestStart<'_>) -> Option<TraceContext> {
        self.0
            .started
            .lock()
            .unwrap()
            .push(format!("{} {}", start.method, start.url));
        let id = start
            .headers
            .get("traceparent")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none")
            .to_owned();
        Some(TraceContext::new(TraceId(id)))
    }

    fn on_response(&self, end: RequestEnd) {
        self.0.ended.lock().unwrap().push(end);
    }
}

impl Recording {
    fn ended(&self) -> Vec<RequestEnd> {
        self.0.ended.lock().unwrap().clone()
    }

    async fn wait_for(&self, count: usize) -> Vec<RequestEnd> {
        for _ in 0..200 {
            let ended = self.ended();
            if ended.len() >= count {
                return ended;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("only {} exchanges ended", self.ended().len());
    }
}

/// Signals sent by handlers' background work.
#[derive(Default)]
struct Signals {
    stream_closed: Mutex<Option<oneshot::Sender<&'static str>>>,
    handler_dropped: Mutex<Option<oneshot::Sender<()>>>,
}

type State = Arc<Signals>;

/// GET /events: a named start event at once, a heartbeat every 100 ms, a JSON event after 250 ms,
/// then the end of the stream.
async fn events(_req: &mut Req<State>) -> Response {
    let (events, body) =
        sse::channel(SseOptions::new().heartbeat(Duration::from_millis(100), "ping"));
    tokio::spawn(async move {
        let start = Event::json(&json!({ "id": "t1", "text": "héllo 😀" }))
            .expect("json")
            .event("start")
            .id("1-0");
        events.send(&start).await.expect("start");
        tokio::time::sleep(Duration::from_millis(250)).await;
        events.json(&json!({ "n": 1 })).await.expect("data");
    });
    Response::new()
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-transform")
        .header("X-Accel-Buffering", "no")
        .stream(body)
}

/// GET /forever: writes every 50 ms until the client goes away, then reports how it noticed.
async fn forever(req: &mut Req<State>) -> Response {
    let (events, body) = sse::channel(SseOptions::new());
    let closed = req.closed();
    let signals = Arc::clone(req.state());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = closed.cancelled() => break,
                () = tokio::time::sleep(Duration::from_millis(50)) => {
                    if events.data("tick").await.is_err() {
                        break;
                    }
                }
            }
        }
        if let Some(tx) = signals.stream_closed.lock().unwrap().take() {
            let _ = tx.send("writer");
        }
    });
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(body)
}

/// GET /quiet: one frame, then nothing until the client goes away (no write to fail).
async fn quiet(req: &mut Req<State>) -> Response {
    let (events, body) = sse::channel(SseOptions::new());
    let signals = Arc::clone(req.state());
    tokio::spawn(async move {
        let _ = events.comment("hello").await;
        events.closed().await;
        if let Some(tx) = signals.stream_closed.lock().unwrap().take() {
            let _ = tx.send("quiet");
        }
    });
    Response::new()
        .header("Content-Type", "text/event-stream")
        .stream(body)
}

/// Reports when it is dropped.
struct DropSignal(State);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(tx) = self.0.handler_dropped.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

/// GET /slow: takes 10 s; the client leaves first.
async fn slow(req: &mut Req<State>) -> Response {
    let _signal = DropSignal(Arc::clone(req.state()));
    tokio::time::sleep(Duration::from_secs(10)).await;
    Response::new().text("too late")
}

async fn trace(req: &mut Req<State>) -> Response {
    let id = req
        .trace_context()
        .and_then(|t| t.get::<TraceId>())
        .map(|t| t.0.clone());
    Response::new().json(&json!({ "trace": id }))
}

async fn duel_state(req: &mut Req<State>) -> Response {
    Response::new().json(&json!({ "channel": req.param("channelID") }))
}

async fn start(
    recording: Recording,
) -> (
    std::net::SocketAddr,
    CancellationToken,
    State,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let mut duel = Router::with_merge_params();
    duel.get("/state", duel_state);
    let mut widgets = Router::new();
    widgets.mount("/:channelID/duel", duel);
    let mut root = Router::new();
    root.middleware(cors::cors());
    root.get("/events", events);
    root.get("/forever", forever);
    root.get("/quiet", quiet);
    root.get("/slow", slow);
    root.get("/trace", trace);
    root.mount("/widgets", widgets);
    let signals: State = Arc::new(Signals::default());
    let app = App::with_shared_state(root, Arc::new(Arc::clone(&signals)))
        .expect("app")
        .observe(recording);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let token = CancellationToken::new();
    let server = tokio::spawn(serve(listener, app, token.clone(), ServeOptions::default()));
    (addr, token, signals, server)
}

/// Reads a response head off the stream.
async fn read_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("head");
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// Reads one chunk of a chunked body (`None` at the last chunk).
async fn read_chunk(stream: &mut TcpStream) -> Option<String> {
    let mut line = Vec::new();
    while !line.ends_with(b"\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("chunk size");
        line.push(byte[0]);
    }
    let size = usize::from_str_radix(String::from_utf8_lossy(&line).trim(), 16).expect("hex");
    let mut data = vec![0u8; size + 2];
    stream.read_exact(&mut data).await.expect("chunk");
    data.truncate(size);
    (size > 0).then(|| String::from_utf8(data).expect("UTF-8 chunk"))
}

#[tokio::test]
async fn sse_frames_are_flushed_one_by_one_with_heartbeats() {
    let recording = Recording(Arc::default());
    let (addr, token, _signals, server) = start(recording.clone()).await;
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"GET /events HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .expect("write");
    let head = tokio::time::timeout(Duration::from_millis(200), read_head(&mut stream))
        .await
        .expect("headers go out at once");
    let lower = head.to_ascii_lowercase();
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    for line in [
        "content-type: text/event-stream; charset=utf-8",
        "cache-control: no-cache, no-transform",
        "x-accel-buffering: no",
        "transfer-encoding: chunked",
        "access-control-allow-origin: *",
    ] {
        assert!(lower.contains(line), "{line} in {head}");
    }
    assert!(!lower.contains("etag"), "{head}");

    // The first frame arrives before the producer's 250 ms pause: it was flushed on its own.
    let first = tokio::time::timeout(Duration::from_millis(200), read_chunk(&mut stream))
        .await
        .expect("flushed")
        .expect("frame");
    assert_eq!(
        first,
        "id: 1-0\nevent: start\ndata: {\"id\":\"t1\",\"text\":\"héllo 😀\"}\n\n"
    );
    let mut rest = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(2), read_chunk(&mut stream))
        .await
        .expect("chunk")
    {
        rest.push(chunk);
    }
    let heartbeats = rest.iter().filter(|c| *c == ": ping\n\n").count();
    assert!((1..=3).contains(&heartbeats), "{rest:?}");
    assert_eq!(rest.last().map(String::as_str), Some("data: {\"n\":1}\n\n"));

    let ended = recording.wait_for(1).await;
    assert_eq!(ended[0].status, Some(200));
    assert!(!ended[0].aborted);
    assert_eq!(
        ended[0].bytes_sent as usize,
        first.len() + rest.iter().map(String::len).sum::<usize>()
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn sse_writers_learn_the_client_is_gone() {
    let recording = Recording(Arc::default());
    let (addr, token, signals, server) = start(recording.clone()).await;
    for (path, expected) in [("/forever", "writer"), ("/quiet", "quiet")] {
        let (tx, rx) = oneshot::channel();
        *signals.stream_closed.lock().unwrap() = Some(tx);
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .await
            .expect("write");
        read_head(&mut stream).await;
        read_chunk(&mut stream).await.expect("a first frame");
        drop(stream);
        let how = tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .expect("noticed within 2 s")
            .expect("signal");
        assert_eq!(how, expected);
    }
    let ended = recording.wait_for(2).await;
    assert!(
        ended
            .iter()
            .all(|end| end.aborted && end.status == Some(200)),
        "{ended:?}"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn a_client_leaving_before_the_answer_cancels_the_handler() {
    let recording = Recording(Arc::default());
    let (addr, token, signals, server) = start(recording.clone()).await;
    let (tx, rx) = oneshot::channel();
    *signals.handler_dropped.lock().unwrap() = Some(tx);
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(b"GET /slow HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .expect("write");
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(stream);
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .expect("handler dropped within 2 s")
        .expect("signal");
    let ended = recording.wait_for(1).await;
    assert_eq!(ended[0].status, None);
    assert!(ended[0].aborted);
    assert_eq!(ended[0].route.as_ref().map(|r| r.pattern.as_str()), None);
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn the_observer_sees_routes_status_size_and_trace() {
    let recording = Recording(Arc::default());
    let (addr, token, _signals, server) = start(recording.clone()).await;
    let roundtrip = |request: &'static str| async move {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.expect("read");
        String::from_utf8_lossy(&raw).into_owned()
    };
    let traced = roundtrip(
        "GET /trace HTTP/1.1\r\nHost: x\r\nConnection: close\r\ntraceparent: 00-abc-def-01\r\n\r\n",
    )
    .await;
    assert!(traced.ends_with(r#"{"trace":"00-abc-def-01"}"#), "{traced}");
    roundtrip("GET /widgets/Chan%20%F0%9F%98%80/duel/state?x=1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
    roundtrip("GET /nothing HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
    roundtrip("HEAD /trace HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;

    let ended = recording.wait_for(4).await;
    let trace = &ended[0];
    assert_eq!(trace.status, Some(200));
    assert_eq!(
        trace.bytes_sent,
        r#"{"trace":"00-abc-def-01"}"#.len() as u64
    );
    assert_eq!(
        trace
            .trace
            .as_ref()
            .and_then(|t| t.get::<TraceId>())
            .cloned(),
        Some(TraceId("00-abc-def-01".into()))
    );
    let duel = &ended[1];
    let route = duel.route.as_ref().expect("route");
    assert_eq!(route.pattern, "/widgets/:channelID/duel/state");
    assert_eq!(route.base_url, "/widgets/Chan%20%F0%9F%98%80/duel");
    assert_eq!(route.path, "/state");
    assert_eq!(duel.url, "/widgets/Chan%20%F0%9F%98%80/duel/state?x=1");
    assert_eq!(duel.method, http::Method::GET);
    assert!(!duel.aborted);
    let missing = &ended[2];
    assert_eq!((missing.status, missing.route.is_none()), (Some(404), true));
    assert!(missing.bytes_sent > 0);
    let head = &ended[3];
    assert_eq!(
        (head.status, head.bytes_sent, head.aborted),
        (Some(200), 0, false)
    );
    assert_eq!(recording.0.started.lock().unwrap().len(), 4);
    token.cancel();
    server.await.expect("join").expect("serve");
}
