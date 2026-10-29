#![cfg(feature = "posthog-lossless")]
//! Execution belongs to the parent's isolated compiler snapshot. All HTTP uses
//! fixture keys and random loopback ports; no application defaults are imported.
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    posthog_lossless::{
        MAX_EVENT_BYTES, MAX_QUEUE_BYTES, PosthogLosslessConfig, PosthogLosslessTransport,
        TransportError,
    },
};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant as WallInstant},
};
use tokio::sync::mpsc;
const KEY: &str = "phc_lossless_loopback_fixture_only";
const LIMIT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
}
impl Gate {
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn wait(&self, stop: &AtomicBool) -> bool {
        let mut open = self.open.lock().unwrap();
        let until = WallInstant::now() + LIMIT;
        while !*open && !stop.load(Ordering::SeqCst) && WallInstant::now() < until {
            open = self
                .changed
                .wait_timeout(open, Duration::from_millis(50))
                .unwrap()
                .0;
        }
        *open && !stop.load(Ordering::SeqCst)
    }
}
#[derive(Clone)]
enum Reply {
    Status(u16),
    Disconnect,
    Headers(Arc<Gate>),
    Body(Arc<Gate>),
}
struct Request {
    connection: usize,
    headers: String,
    body: String,
}
impl Request {
    fn json(&self) -> JsonValue {
        parse_json(&self.body).unwrap()
    }
    fn events(&self) -> Vec<JsonValue> {
        let JsonValue::Array(events) = self.json().get("batch").unwrap().clone() else {
            panic!("batch");
        };
        events
    }
}
struct Server {
    url: String,
    rx: mpsc::UnboundedReceiver<Request>,
    stop: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    streams: Arc<Mutex<Vec<TcpStream>>>,
    task: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/batch/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicUsize::new(0));
        let streams = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Mutex::new(VecDeque::from(replies)));
        let (tx, rx) = mpsc::unbounded_channel();
        let (halt, seen, sockets) = (stop.clone(), count.clone(), streams.clone());
        let task = thread::spawn(move || {
            let mut children = Vec::new();
            let mut connection = 0;
            while !halt.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        connection += 1;
                        if connection > 512 {
                            let _ = stream.shutdown(Shutdown::Both);
                            break;
                        }
                        stream
                            .set_read_timeout(Some(Duration::from_millis(100)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_millis(500)))
                            .unwrap();
                        sockets.lock().unwrap().push(stream.try_clone().unwrap());
                        let (halt, seen, tx, script) =
                            (halt.clone(), seen.clone(), tx.clone(), script.clone());
                        let id = connection;
                        children.push(thread::spawn(move || {
                            let mut buffer = Vec::new();
                            let mut scratch = [0; 8192];
                            let mut idle = WallInstant::now() + LIMIT;
                            while !halt.load(Ordering::SeqCst) && WallInstant::now() < idle {
                                let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                                    match stream.read(&mut scratch) {
                                        Ok(0) => break,
                                        Ok(n) => { buffer.extend_from_slice(&scratch[..n]); if buffer.len() > 32 * 1024 * 1024 { break; } },
                                        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                                        Err(_) => break,
                                    }
                                    continue;
                                };
                                let headers = String::from_utf8_lossy(&buffer[..end]).to_string();
                                let length = headers.lines().find_map(|line| line.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())).unwrap();
                                assert!(length <= 32 * 1024 * 1024);
                                let total = end + 4 + length;
                                if buffer.len() < total {
                                    match stream.read(&mut scratch) {
                                        Ok(0) => break,
                                        Ok(n) => buffer.extend_from_slice(&scratch[..n]),
                                        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                                        Err(_) => break,
                                    }
                                    continue;
                                }
                                assert!(headers.starts_with("POST /batch/ HTTP/1.1"));
                                let body = String::from_utf8(buffer[end + 4..total].to_vec()).unwrap();
                                buffer.drain(..total);
                                let index = seen.fetch_add(1, Ordering::SeqCst);
                                assert!(index < 1024, "fixture request bound");
                                let reply = script.lock().unwrap().pop_front().unwrap_or(Reply::Status(200));
                                if tx.send(Request { connection: id, headers, body }).is_err() { break; }
                                let status = match &reply {
                                    Reply::Disconnect => break,
                                    Reply::Headers(gate) => { if !gate.wait(&halt) { break; } 200 },
                                    Reply::Body(_) => 200,
                                    Reply::Status(code) => *code,
                                };
                                let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n");
                                if stream.write_all(response.as_bytes()).is_err() { break; }
                                if let Reply::Body(gate) = reply && !gate.wait(&halt) { break; }
                                if stream.write_all(b"{}").is_err() { break; }
                                idle = WallInstant::now() + LIMIT;
                            }
                            let _ = stream.shutdown(Shutdown::Both);
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::park_timeout(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            let mut panicked = false;
            for child in children {
                panicked |= child.join().is_err();
            }
            assert!(!panicked, "fixture connection panicked");
        });
        Self {
            url,
            rx,
            stop,
            count,
            streams,
            task: Some(task),
        }
    }
    async fn next(&mut self) -> Request {
        tokio::time::timeout(LIMIT, self.rx.recv())
            .await
            .unwrap()
            .expect("recorder closed")
    }
    fn config(&self) -> PosthogLosslessConfig {
        let mut c = PosthogLosslessConfig::new(KEY, &self.url);
        c.flush_interval = Duration::ZERO;
        c.request_timeout = Duration::from_secs(1);
        c.shutdown_timeout = Duration::from_secs(2);
        c
    }
    fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for stream in self.streams.lock().unwrap().iter() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(task) = self.task.take() {
            // Never double-panic while tearing down a failed test. Every read,
            // write and gate above has a bound and observes stop.
            let result = task.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn props(n: usize) -> JsonValue {
    JsonValue::Object(vec![("n".into(), JsonValue::Number(n as f64))])
}
fn capture(t: &PosthogLosslessTransport, n: usize) {
    t.capture("fixture", &"id".into(), &props(n)).unwrap();
}
fn number(event: &JsonValue) -> usize {
    let JsonValue::Number(n) = event.get("properties").unwrap().get("n").unwrap() else {
        panic!("n")
    };
    *n as usize
}
async fn complete(
    task: tokio::task::JoinHandle<Result<(), TransportError>>,
) -> Result<(), TransportError> {
    tokio::time::timeout(LIMIT, task).await.unwrap().unwrap()
}
fn flush(t: &PosthogLosslessTransport) -> tokio::task::JoinHandle<Result<(), TransportError>> {
    let t = t.clone();
    tokio::spawn(async move { t.flush().await })
}
fn shutdown(t: &PosthogLosslessTransport) -> tokio::task::JoinHandle<Result<(), TransportError>> {
    let t = t.clone();
    tokio::spawn(async move { t.shutdown().await })
}

#[tokio::test]
async fn lossless_nested_utf16_nonfinite_and_metadata() {
    let mut s = Server::new(vec![]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    assert_eq!(s.count(), 0);
    let id = JsString::from_units(vec![0xd800, 0x61, 0xdc00]);
    let value = JsonValue::Object(vec![
        (
            JsString::from_units(vec![0xdc00]),
            JsonValue::Array(vec![
                JsonValue::String(JsString::from_units(vec![0xd800])),
                JsonValue::String("😀".into()),
                JsonValue::Number(f64::NAN),
                JsonValue::Number(f64::INFINITY),
                JsonValue::Number(f64::NEG_INFINITY),
                JsonValue::Number(-0.0),
                JsonValue::Number(1e21),
            ]),
        ),
        ("$is_server".into(), JsonValue::Bool(false)),
        ("$geoip_disable".into(), JsonValue::Bool(false)),
    ]);
    t.capture("$identify", &id, &value).unwrap();
    let f = flush(&t);
    let request = s.next().await;
    assert!(
        request
            .headers
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    assert!(request.body.contains("\\ud800"));
    assert!(request.body.contains("😀"));
    assert!(!request.body.contains("NaN"));
    assert!(!request.body.contains("Infinity"));
    let event = &request.events()[0];
    assert_eq!(event.get("distinct_id"), Some(&JsonValue::String(id)));
    let p = event.get("properties").unwrap();
    assert_eq!(p.get("$is_server"), Some(&JsonValue::Bool(true)));
    assert_eq!(p.get("$geoip_disable"), Some(&JsonValue::Bool(true)));
    let JsonValue::String(uuid) = event.get("uuid").unwrap() else {
        panic!("uuid")
    };
    assert_eq!(uuid.as_str().unwrap().as_bytes()[14], b'4');
    assert_eq!(complete(f).await, Ok(()));
    assert_eq!(t.shutdown().await, Ok(()));
}

#[tokio::test]
async fn twenty_threshold_future_timer_and_empty_no_network() {
    let mut s = Server::new(vec![]);
    let mut c = s.config();
    c.flush_interval = Duration::from_millis(1000);
    let t = PosthogLosslessTransport::new(c).unwrap();
    t.flush().await.unwrap();
    assert_eq!(s.count(), 0);
    for n in 0..19 {
        capture(&t, n);
    }
    // A negative timer assertion is intentional future-work waiting, not a
    // ready-backlog sleep. Receipt of event 20 causally proves the trigger.
    assert!(
        tokio::time::timeout(Duration::from_millis(25), s.rx.recv())
            .await
            .is_err()
    );
    capture(&t, 19);
    assert_eq!(s.next().await.events().len(), 20);
    t.flush().await.unwrap();
    capture(&t, 20);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), s.rx.recv())
            .await
            .is_err()
    );
    assert_eq!(number(&s.next().await.events()[0]), 20);
    t.shutdown().await.unwrap();
    let count = s.count();
    t.flush().await.unwrap();
    t.shutdown().await.unwrap();
    assert_eq!(s.count(), count);
}

#[tokio::test]
async fn normal_ready_backlog_drains_without_interval_and_causal_flush() {
    let mut s = Server::new(vec![]);
    let mut c = s.config();
    c.flush_interval = Duration::from_secs(3600);
    let t = PosthogLosslessTransport::new(c).unwrap();
    // current-thread: the actor cannot run until the whole backlog is ready.
    for n in 0..251 {
        capture(&t, n);
    }
    let mut all = Vec::new();
    for len in [100, 100, 51] {
        let req = s.next().await;
        assert_eq!(req.events().len(), len);
        all.extend(req.events().iter().map(number));
    }
    assert_eq!(all, (0..251).collect::<Vec<_>>());
    t.flush().await.unwrap();
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_flush_includes_precall_events_during_inflight() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let mut c = s.config();
    c.flush_at = 1;
    let t = PosthogLosslessTransport::new(c).unwrap();
    capture(&t, 1);
    let first = s.next().await;
    assert_eq!(number(&first.events()[0]), 1);
    capture(&t, 2);
    let f = flush(&t);
    gate.release();
    assert_eq!(number(&s.next().await.events()[0]), 2);
    assert_eq!(complete(f).await, Ok(()));
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn earlier_barrier_completes_while_later_events_remain_inflight() {
    let a = Arc::new(Gate::default());
    let b = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(a.clone()), Reply::Headers(b.clone())]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    capture(&t, 1);
    let first = flush(&t);
    s.next().await;
    capture(&t, 2);
    let second = flush(&t);
    a.release();
    s.next().await;
    assert_eq!(complete(first).await, Ok(()));
    b.release();
    assert_eq!(complete(second).await, Ok(()));
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn overflow_default_ten_thousand_and_smaller_drop_oldest() {
    for cap in [10_000, 3] {
        let mut s = Server::new(vec![]);
        let mut c = s.config();
        assert_eq!(c.max_queue_size, 10_000);
        c.max_queue_size = cap;
        c.flush_at = cap + 10;
        let t = PosthogLosslessTransport::new(c).unwrap();
        for n in 0..cap + 2 {
            capture(&t, n);
        }
        let f = flush(&t);
        let mut numbers = Vec::new();
        while numbers.len() < cap {
            numbers.extend(s.next().await.events().iter().map(number));
        }
        assert_eq!(numbers, (2..cap + 2).collect::<Vec<_>>());
        assert_eq!(complete(f).await, Err(TransportError::QueueOverflow));
        assert_eq!(t.flush().await, Err(TransportError::QueueOverflow));
        assert_eq!(t.shutdown().await, Err(TransportError::QueueOverflow));
    }
}

#[tokio::test]
async fn overflow_during_http_cannot_dequeue_newer_records_by_count() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let mut c = s.config();
    c.max_queue_size = 3;
    c.flush_at = 1;
    let t = PosthogLosslessTransport::new(c).unwrap();
    capture(&t, 1);
    s.next().await;
    for n in 2..=5 {
        capture(&t, n);
    }
    let f = flush(&t);
    gate.release();
    assert_eq!(
        s.next()
            .await
            .events()
            .iter()
            .map(number)
            .collect::<Vec<_>>(),
        [3, 4, 5]
    );
    assert_eq!(complete(f).await, Err(TransportError::QueueOverflow));
    assert_eq!(t.shutdown().await, Err(TransportError::QueueOverflow));
}

#[tokio::test]
async fn resource_limits_reject_single_event_and_bound_queue_bytes() {
    let mut s = Server::new(vec![]);
    let mut c = s.config();
    c.flush_at = 100_000;
    let t = PosthogLosslessTransport::new(c).unwrap();
    let large = JsonValue::Object(vec![(
        "large".into(),
        JsonValue::String("x".repeat(MAX_EVENT_BYTES).into()),
    )]);
    assert_eq!(
        t.capture("large", &"id".into(), &large),
        Err(TransportError::EventTooLarge)
    );
    assert_eq!(
        t.capture("x", &"id".into(), &JsonValue::Null),
        Err(TransportError::InvalidProperties)
    );
    // Conservative UTF-16 preflight accepts these ~30 KiB ASCII events. Enough
    // events cross the independent byte bound while staying below 10000 items.
    let payload = JsonValue::Object(vec![(
        "large".into(),
        JsonValue::String("x".repeat(30_000).into()),
    )]);
    let total = MAX_QUEUE_BYTES / 30_000 + 5;
    for _ in 0..total {
        t.capture("bytes", &"id".into(), &payload).unwrap();
    }
    let f = flush(&t);
    let mut bytes = 0;
    let mut count = 0;
    // Flush's result determines completion; drain recorder until it completes.
    tokio::pin!(f);
    loop {
        tokio::select! {
            result = &mut f => { assert_eq!(result.unwrap(), Err(TransportError::QueueOverflow)); break; },
            req = s.rx.recv() => { let req = req.unwrap(); for event in req.events() { bytes += event.to_json_string().len(); count += 1; } },
            _ = tokio::time::sleep(LIMIT) => panic!("byte-bound drain deadline"),
        }
    }
    while let Ok(req) = s.rx.try_recv() {
        for event in req.events() {
            bytes += event.to_json_string().len();
            count += 1;
        }
    }
    assert!(count < total);
    assert!(bytes <= MAX_QUEUE_BYTES);
    assert_eq!(t.shutdown().await, Err(TransportError::QueueOverflow));
}

#[tokio::test]
async fn retryable_http_stable_wire_and_order() {
    for code in [408, 429, 500] {
        let mut s = Server::new(vec![Reply::Status(code), Reply::Status(200)]);
        let t = PosthogLosslessTransport::new(s.config()).unwrap();
        capture(&t, 0);
        capture(&t, 1);
        let f = flush(&t);
        let first = s.next().await;
        let second = s.next().await;
        assert_eq!(first.body, second.body);
        assert_eq!(
            second.events().iter().map(number).collect::<Vec<_>>(),
            [0, 1]
        );
        assert_eq!(complete(f).await, Ok(()));
        t.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn exhausted_http_dequeues_but_reports_failure() {
    for code in [400, 413, 503] {
        let mut s = Server::new(vec![Reply::Status(code); 4]);
        let t = PosthogLosslessTransport::new(s.config()).unwrap();
        capture(&t, 1);
        let f = flush(&t);
        let attempts = if code == 503 { 4 } else { 1 };
        for _ in 0..attempts {
            s.next().await;
        }
        assert_eq!(complete(f).await, Err(TransportError::Http(code)));
        assert_eq!(t.flush().await, Err(TransportError::Http(code)));
        assert_eq!(s.count(), attempts);
        assert_eq!(t.shutdown().await, Err(TransportError::Http(code)));
    }
}

#[tokio::test]
async fn oversized_batch_halves_then_keeps_fifo() {
    let mut s = Server::new(vec![Reply::Status(413)]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    for n in 0..5 {
        capture(&t, n);
    }
    let f = flush(&t);
    assert_eq!(s.next().await.events().len(), 5);
    let mut all = Vec::new();
    for len in [2, 2, 1] {
        let r = s.next().await;
        assert_eq!(r.events().len(), len);
        all.extend(r.events().iter().map(number));
    }
    assert_eq!(all, [0, 1, 2, 3, 4]);
    assert_eq!(complete(f).await, Ok(()));
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn exhausted_network_retains_stable_event_for_later_flush() {
    let mut s = Server::new(vec![Reply::Disconnect; 4]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    capture(&t, 1);
    let f = flush(&t);
    let first = s.next().await;
    for _ in 0..3 {
        assert_eq!(s.next().await.body, first.body);
    }
    assert_eq!(complete(f).await, Err(TransportError::Network));
    let f = flush(&t);
    let next = s.next().await;
    assert_eq!(first.events(), next.events());
    assert_eq!(complete(f).await, Ok(()));
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn held_headers_and_body_respect_request_then_shutdown_deadlines() {
    for body in [false, true] {
        let gate = Arc::new(Gate::default());
        let reply = if body {
            Reply::Body(gate.clone())
        } else {
            Reply::Headers(gate.clone())
        };
        let mut s = Server::new(vec![reply]);
        let mut c = s.config();
        c.request_timeout = Duration::from_millis(80);
        c.shutdown_timeout = Duration::from_millis(180);
        let t = PosthogLosslessTransport::new(c).unwrap();
        capture(&t, 1);
        let f = flush(&t);
        s.next().await;
        // A request timeout is retryable; shutdown interrupts its real 3s retry
        // wait at the shared deadline rather than orphaning the request actor.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let began = WallInstant::now();
        assert_eq!(t.shutdown().await, Err(TransportError::ShutdownTimeout));
        assert!(began.elapsed() < Duration::from_secs(1));
        assert_eq!(complete(f).await, Err(TransportError::ShutdownTimeout));
        gate.release();
        assert_eq!(s.count(), 1);
        assert_eq!(t.shutdown().await, Err(TransportError::ShutdownTimeout));
        assert_eq!(
            t.capture("closed", &"id".into(), &props(2)),
            Err(TransportError::Closed)
        );
    }
}

#[tokio::test]
async fn exhausted_request_deadlines_retain_events_and_body_reads_are_bounded() {
    for body in [false, true] {
        let gate = Arc::new(Gate::default());
        let reply = if body {
            Reply::Body(gate.clone())
        } else {
            Reply::Headers(gate.clone())
        };
        let mut s = Server::new(vec![reply; 4]);
        let mut c = s.config();
        c.request_timeout = Duration::from_millis(60);
        let t = PosthogLosslessTransport::new(c).unwrap();
        capture(&t, 1);
        let f = flush(&t);
        let first = s.next().await;
        for _ in 0..3 {
            assert_eq!(s.next().await.body, first.body);
        }
        assert_eq!(complete(f).await, Err(TransportError::RequestTimeout));
        gate.release();
        let f = flush(&t);
        assert_eq!(s.next().await.events(), first.events());
        assert_eq!(complete(f).await, Ok(()));
        t.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn injected_client_and_redacted_configuration_errors() {
    let mut s = Server::new(vec![]);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-fixture-pool",
        reqwest::header::HeaderValue::from_static("injected"),
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .default_headers(headers)
        .build()
        .unwrap();
    let t = PosthogLosslessTransport::with_client(s.config(), client.clone()).unwrap();
    assert_eq!(s.count(), 0);
    capture(&t, 1);
    let f = flush(&t);
    let request = s.next().await;
    assert!(
        request
            .headers
            .to_ascii_lowercase()
            .contains("x-fixture-pool: injected")
    );
    assert_eq!(complete(f).await, Ok(()));
    t.shutdown().await.unwrap();
    let mut config = s.config();
    config.endpoint = "http://fixture-secret:fixture-secret@127.0.0.1/batch/".into();
    let error = PosthogLosslessTransport::with_client(config, client)
        .err()
        .unwrap();
    assert_eq!(error, TransportError::InvalidConfig);
    assert!(!format!("{error:?} {error}").contains("fixture-secret"));
}

#[tokio::test]
async fn shutdown_interrupts_current_held_request_without_waiting_for_request_timeout() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let mut c = s.config();
    c.request_timeout = Duration::from_secs(60);
    c.shutdown_timeout = Duration::from_millis(100);
    let t = PosthogLosslessTransport::new(c).unwrap();
    capture(&t, 1);
    let f = flush(&t);
    s.next().await;
    assert_eq!(t.shutdown().await, Err(TransportError::ShutdownTimeout));
    assert_eq!(complete(f).await, Err(TransportError::ShutdownTimeout));
    gate.release();
}

#[tokio::test]
async fn pool_reused_across_clones_and_cancelled_flush_waiter() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    let clone = t.clone();
    capture(&t, 1);
    let f = flush(&t);
    let first = s.next().await;
    f.abort();
    assert!(f.await.unwrap_err().is_cancelled());
    let other = flush(&clone);
    gate.release();
    assert_eq!(complete(other).await, Ok(()));
    capture(&clone, 2);
    let f = flush(&clone);
    let second = s.next().await;
    assert_eq!(complete(f).await, Ok(()));
    assert_eq!(first.connection, second.connection);
    assert_eq!(s.count(), 2);
    t.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_concurrent_repeated_shutdown_and_no_postclose_network() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let t = PosthogLosslessTransport::new(s.config()).unwrap();
    capture(&t, 1);
    let a = shutdown(&t);
    s.next().await;
    a.abort();
    assert!(a.await.unwrap_err().is_cancelled());
    let b = shutdown(&t);
    let c = shutdown(&t);
    gate.release();
    assert_eq!(complete(b).await, Ok(()));
    assert_eq!(complete(c).await, Ok(()));
    assert_eq!(t.shutdown().await, Ok(()));
    assert_eq!(t.flush().await, Ok(()));
    assert_eq!(
        t.capture("closed", &"id".into(), &props(2)),
        Err(TransportError::Closed)
    );
    assert_eq!(s.count(), 1);
}

#[tokio::test]
async fn last_clone_drop_cancels_http_and_does_not_retry() {
    let gate = Arc::new(Gate::default());
    let mut s = Server::new(vec![Reply::Headers(gate.clone())]);
    let mut c = s.config();
    c.flush_at = 1;
    let t = PosthogLosslessTransport::new(c).unwrap();
    let clone = t.clone();
    capture(&t, 1);
    s.next().await;
    drop(t);
    drop(clone);
    gate.release();
    // Negative observation across the retry boundary is specifically checking
    // absence of post-drop network work, not pacing ready application work.
    assert!(
        tokio::time::timeout(Duration::from_millis(3200), s.rx.recv())
            .await
            .is_err()
    );
    assert_eq!(s.count(), 1);
}

#[tokio::test]
async fn replay_installed_sdk_oracle_is_required_and_nonempty() {
    let directory = std::env::var_os("POSTHOG_LOSSLESS_REFERENCE_DIR").expect("parent must run installed SDK oracle --write DIR and --check DIR, then set POSTHOG_LOSSLESS_REFERENCE_DIR");
    let path = std::path::PathBuf::from(directory).join("reference.json");
    let fixture =
        parse_json(&std::fs::read_to_string(path).expect("oracle reference missing")).unwrap();
    let JsonValue::Array(cases) = fixture.get("cases").expect("cases") else {
        panic!("cases")
    };
    assert!(!cases.is_empty());
    for case in cases {
        let JsonValue::Array(inputs) = case.get("input").unwrap() else {
            panic!("input")
        };
        assert!(!inputs.is_empty());
        let JsonValue::Array(expected) = case.get("batch").unwrap() else {
            panic!("batch")
        };
        assert_eq!(inputs.len(), expected.len());
        let mut s = Server::new(vec![]);
        let t = PosthogLosslessTransport::new(s.config()).unwrap();
        for input in inputs {
            let JsonValue::String(event) = input.get("event").unwrap() else {
                panic!("event")
            };
            let JsonValue::String(id) = input.get("distinct_id").unwrap() else {
                panic!("id")
            };
            t.capture(
                event.as_str().unwrap(),
                id,
                input.get("properties").unwrap(),
            )
            .unwrap();
        }
        let f = flush(&t);
        let mut actual = Vec::new();
        while actual.len() < expected.len() {
            actual.extend(s.next().await.events());
        }
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.get("event"), expected.get("event"));
            assert_eq!(actual.get("distinct_id"), expected.get("distinct_id"));
            let normalize = |v: &JsonValue| {
                let JsonValue::Object(fields) = v.get("properties").unwrap() else {
                    panic!("properties")
                };
                JsonValue::Object(
                    fields
                        .iter()
                        .filter(|(k, _)| !matches!(k.as_str(), Some("$lib" | "$lib_version")))
                        .cloned()
                        .collect(),
                )
                .to_json_string()
            };
            assert_eq!(normalize(actual), normalize(expected));
            for field in ["timestamp", "uuid"] {
                assert!(matches!(actual.get(field), Some(JsonValue::String(s)) if !s.is_empty()));
            }
        }
        assert_eq!(complete(f).await, Ok(()));
        t.shutdown().await.unwrap();
    }
}
