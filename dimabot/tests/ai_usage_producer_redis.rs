#![cfg(feature = "ai-usage-producer")]
//! Concrete ConnectionManager + disposable Dragonfly tests. Parent must provide
//! a fresh private fixture: the ORIGINAL global queue key must start empty.
//! No FLUSHDB/DEL, worker startup, credentials or production access. The proxy
//! forwards successful RPUSH to real Dragonfly; it supplies faults, not policy.
#[path = "support/ai_usage_producer.rs"]
mod support;
use dima_rust::utils::{
    ai_usage_producer::*,
    credit_policy::JsDate,
    lossless_json::{JsonValue, parse_json},
};
use redis::aio::ConnectionManager;
use std::{
    future::Future,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    pin::Pin,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use support::*;
use tokio::sync::Notify;
const LIMIT: Duration = Duration::from_secs(10);

// Catch an async panic without adding futures-util to the opt-in feature graph.
struct Catch<F: Future>(Pin<Box<F>>);
impl<F: Future> Future for Catch<F> {
    type Output = std::thread::Result<F::Output>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match catch_unwind(AssertUnwindSafe(|| self.get_mut().0.as_mut().poll(cx))) {
            Ok(Poll::Ready(v)) => Poll::Ready(Ok(v)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(e) => Poll::Ready(Err(e)),
        }
    }
}
async fn bounded<F: Future>(f: F) -> F::Output {
    tokio::time::timeout(LIMIT, f)
        .await
        .expect("bounded fixture operation")
}

fn fixture_address() -> String {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration"),
        "explicit disposable resource ownership"
    );
    let url = std::env::var("DIMA_TEST_REDIS_URL").expect("explicit disposable Redis URL required");
    let rest = url
        .strip_prefix("redis://")
        .expect("plain isolated redis:// URL");
    let authority = rest
        .strip_suffix("/0")
        .or_else(|| rest.strip_suffix('/'))
        .unwrap_or(rest);
    assert!(
        !authority.contains(['@', '?', '#', '/']),
        "no credentials/query/nonzero DB"
    );
    let (host, port) = if let Some(s) = authority.strip_prefix('[') {
        let (host, port) = s.split_once("]:").expect("IPv6 fixture with explicit port");
        (host, port)
    } else {
        authority
            .rsplit_once(':')
            .expect("fixture host and explicit port")
    };
    assert!(
        [
            "keyword-redis",
            "redis-fixture",
            "127.0.0.1",
            "localhost",
            "::1"
        ]
        .contains(&host),
        "only isolated fixture/loopback hosts"
    );
    assert!(port.parse::<u16>().is_ok_and(|p| p != 0));
    authority.to_owned()
}

// RESP2/RESP3 framing is transport-only; all normal command responses come from
// the real fixture. Bounded sockets and gates prevent hung parent test runs.
fn frame(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    if !line.ends_with(b"\r\n") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let head = *line.first().ok_or(io::ErrorKind::InvalidData)?;
    if matches!(head, b'$' | b'!' | b'=') {
        let n = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(|_| io::ErrorKind::InvalidData)?
            .parse::<i64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if n >= 0 {
            if n > 8 * 1024 * 1024 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let mut payload = vec![0; n as usize + 2];
            reader.read_exact(&mut payload)?;
            line.extend(payload);
        }
    } else if matches!(head, b'*' | b'%' | b'~' | b'>') {
        let n = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(|_| io::ErrorKind::InvalidData)?
            .parse::<i64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if n > 4096 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        for _ in 0..n.max(0) * (if head == b'%' { 2 } else { 1 }) {
            line.extend(frame(reader)?);
        }
    }
    Ok(line)
}
fn command(raw: &[u8]) -> String {
    let mut r = BufReader::new(raw);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    line.clear();
    r.read_line(&mut line).unwrap();
    let n = line
        .trim()
        .strip_prefix('$')
        .unwrap()
        .parse::<usize>()
        .unwrap();
    let mut word = vec![0; n];
    r.read_exact(&mut word).unwrap();
    String::from_utf8(word).unwrap().to_ascii_uppercase()
}
struct State {
    stopped: AtomicBool,
    accepts: AtomicUsize,
    commands: Mutex<Vec<String>>,
    mode: AtomicUsize,
    applied: Notify,
    gate: Mutex<bool>,
    release: Condvar,
    sockets: Mutex<Vec<TcpStream>>,
}
struct Proxy {
    address: String,
    state: Arc<State>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Proxy {
    fn new(upstream: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let state = Arc::new(State {
            stopped: AtomicBool::new(false),
            accepts: AtomicUsize::new(0),
            commands: Mutex::new(Vec::new()),
            mode: AtomicUsize::new(0),
            applied: Notify::new(),
            gate: Mutex::new(false),
            release: Condvar::new(),
            sockets: Mutex::new(Vec::new()),
        });
        let s = state.clone();
        let thread = std::thread::spawn(move || {
            let mut children = Vec::new();
            for incoming in listener.incoming() {
                let Ok(mut client) = incoming else {
                    break;
                };
                if s.stopped.load(Ordering::SeqCst) {
                    break;
                }
                s.accepts.fetch_add(1, Ordering::SeqCst);
                client.set_read_timeout(Some(LIMIT)).unwrap();
                client.set_write_timeout(Some(LIMIT)).unwrap();
                s.sockets.lock().unwrap().push(client.try_clone().unwrap());
                let upstream = upstream.clone();
                let s = s.clone();
                children.push(std::thread::spawn(move || {
                    let mut server = TcpStream::connect(upstream).unwrap();
                    server.set_read_timeout(Some(LIMIT)).unwrap();
                    server.set_write_timeout(Some(LIMIT)).unwrap();
                    s.sockets.lock().unwrap().push(server.try_clone().unwrap());
                    let mut request = BufReader::new(client.try_clone().unwrap());
                    let mut response = BufReader::new(server.try_clone().unwrap());
                    while let Ok(raw) = frame(&mut request) {
                        let cmd = command(&raw);
                        s.commands.lock().unwrap().push(cmd.clone());
                        let mode = if cmd == "RPUSH" {
                            s.mode.swap(0, Ordering::SeqCst)
                        } else {
                            0
                        };
                        if mode == 1 {
                            if client
                                .write_all(b"-WRONGTYPE fixture-injected command failure\r\n")
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                        if server.write_all(&raw).is_err() {
                            break;
                        }
                        let Ok(reply) = frame(&mut response) else {
                            break;
                        };
                        if cmd == "RPUSH" && (mode == 2 || mode == 3) {
                            // Signal only AFTER real Dragonfly applied RPUSH and
                            // replied. An independent manager observes its data.
                            s.applied.notify_one();
                            if mode == 3 {
                                let _ = client.shutdown(Shutdown::Both);
                                break;
                            }
                            let held = s.gate.lock().unwrap();
                            let (released, wait) = s
                                .release
                                .wait_timeout_while(held, LIMIT, |v| {
                                    !*v && !s.stopped.load(Ordering::SeqCst)
                                })
                                .unwrap();
                            if wait.timed_out() || !*released {
                                break;
                            }
                        }
                        if client.write_all(&reply).is_err() {
                            break;
                        }
                    }
                }));
            }
            for c in children {
                c.join().unwrap();
            }
        });
        Self {
            address,
            state,
            thread: Some(thread),
        }
    }
    fn url(&self) -> String {
        format!("redis://{}/", self.address)
    }
    fn counts(&self) -> (usize, usize) {
        (
            self.state.accepts.load(Ordering::SeqCst),
            self.state.commands.lock().unwrap().len(),
        )
    }
    fn pushes(&self) -> usize {
        self.state
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() == "RPUSH")
            .count()
    }
    fn arm(&self, mode: usize) {
        *self.state.gate.lock().unwrap() = false;
        self.state.mode.store(mode, Ordering::SeqCst);
    }
    fn release(&self) {
        *self.state.gate.lock().unwrap() = true;
        self.state.release.notify_all();
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::SeqCst);
        self.release();
        for s in self.state.sockets.lock().unwrap().iter() {
            let _ = s.shutdown(Shutdown::Both);
        }
        let _ = TcpStream::connect(&self.address); // wakes the blocking accept
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
struct Clock {
    date: JsDate,
    calls: AtomicUsize,
}
impl ReceiptClock for Clock {
    fn now(&self) -> JsDate {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.date
    }
}
async fn manager(url: &str) -> ConnectionManager {
    bounded(ConnectionManager::new(redis::Client::open(url).unwrap()))
        .await
        .unwrap()
}
async fn queue(cache: &mut ConnectionManager) -> Vec<String> {
    bounded(
        redis::cmd("LRANGE")
            .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
            .arg(0)
            .arg(-1)
            .query_async(cache),
    )
    .await
    .unwrap()
}
async fn ping(cache: &mut ConnectionManager) {
    let p: String = bounded(redis::cmd("PING").query_async(cache))
        .await
        .unwrap();
    assert_eq!(p, "PONG");
}
fn role<'a>(f: &'a JsonValue, role: &str) -> &'a JsonValue {
    array(field(f, "cases"))
        .iter()
        .find(|c| c.get("integrationRole").is_some_and(|r| text(r) == role))
        .expect("actual-source integration role")
}
fn expected(case: &JsonValue) -> &str {
    let run = &array(field(field(case, "output"), "runs"))[0];
    let call = &array(field(run, "calls"))[0];
    text(field(call, "wire"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned source corpus, task-owned private fresh Dragonfly, ownership guard and URL"]
async fn native_rpush_source_wire_shared_socket_errors_cancellation_cleanup() {
    let address = fixture_address();
    let f = fixture();
    let namespace = text(field(&f, "namespace"));
    let suffix = namespace
        .strip_prefix("producer-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("task namespace");
    assert!((8..=32).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric()));
    for name in [
        "wire",
        "utf16",
        "concurrent-a",
        "concurrent-b",
        "error",
        "cancel",
        "disconnect",
        "system",
        "null",
    ] {
        let c = context(field(role(&f, name), "input"));
        assert_eq!(
            text(field(&c, "entryId")),
            format!("{namespace}{name}"),
            "exact unique task-owned source ID before any write"
        );
    }
    let now = JsDate::from_millis(bits(field(&f, "fixedNowBits")));
    let mut control = manager(&format!("redis://{address}/")).await;
    let length: i64 = bounded(
        redis::cmd("LLEN")
            .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
            .query_async(&mut control),
    )
    .await
    .unwrap();
    assert_eq!(
        length, 0,
        "private fixture must start with empty ORIGINAL queue; never clear somebody else's data"
    );
    let proxy = Proxy::new(address);
    let mut cache = manager(&proxy.url()).await;
    ping(&mut cache).await;
    let mut owned = Vec::new();
    let result = Catch(Box::pin(async {
        let before = proxy.counts();
        let clock = Arc::new(Clock {
            date: now,
            calls: AtomicUsize::new(0),
        });
        let producer = AiUsageProducer::with_clock(cache.clone(), clock.clone());
        let clone = producer.clone();
        assert_eq!(proxy.counts(), before, "construct/clone issues no commands");
        assert_eq!(clock.calls.load(Ordering::SeqCst), 0);
        producer.enqueue(None).await.unwrap();
        producer.enqueue_at(None, JsDate::invalid()).await.unwrap();
        assert_eq!(proxy.counts(), before, "null enqueue has no IO");
        assert_eq!(
            clock.calls.load(Ordering::SeqCst),
            0,
            "null enqueue never samples clock"
        );
        let first_id: i64 = bounded(redis::cmd("CLIENT").arg("ID").query_async(&mut cache))
            .await
            .unwrap();
        let mut shared = cache.clone();
        let second_id: i64 = bounded(redis::cmd("CLIENT").arg("ID").query_async(&mut shared))
            .await
            .unwrap();
        assert_eq!(first_id, second_id, "same actual server connection");
        assert_eq!(proxy.counts().0, 1);
        for name in ["wire", "utf16"] {
            let case = role(&f, name);
            let receipt = build_case(case, now).unwrap();
            let wire = expected(case).to_owned();
            assert!(text(receipt.get("id").unwrap()).starts_with(namespace));
            owned.push(wire.clone());
            bounded(producer.enqueue(Some(&receipt))).await.unwrap();
            assert_eq!(
                queue(&mut control).await,
                owned,
                "actual Dragonfly RPUSH bytes and list order from TS oracle"
            );
        }
        let a_case = role(&f, "concurrent-a");
        let b_case = role(&f, "concurrent-b");
        let a = build_case(a_case, now).unwrap();
        let b = build_case(b_case, now).unwrap();
        owned.push(expected(a_case).into());
        owned.push(expected(b_case).into());
        let (a_result, b_result) =
            bounded(async { tokio::join!(producer.enqueue(Some(&a)), clone.enqueue(Some(&b))) })
                .await;
        a_result.unwrap();
        b_result.unwrap();
        let rows = queue(&mut control).await;
        assert_eq!(&rows[..2], &owned[..2]);
        let mut actual = rows[2..].to_vec();
        actual.sort();
        let mut wanted = owned[2..].to_vec();
        wanted.sort();
        assert_eq!(actual, wanted);
        assert_eq!(
            proxy.counts().0,
            1,
            "cloned concurrent services share one socket; no reconnect"
        );
        producer.enqueue(None).await.unwrap();
        assert_eq!(queue(&mut control).await.len(), 4);
        let error = build_case(role(&f, "error"), now).unwrap();
        let before_pushes = proxy.pushes();
        proxy.arm(1);
        let failure = bounded(producer.enqueue(Some(&error))).await.unwrap_err();
        assert_eq!(failure.kind(), redis::ErrorKind::Extension);
        assert!(failure.to_string().contains("WRONGTYPE"));
        assert_eq!(
            proxy.pushes(),
            before_pushes + 1,
            "server command error propagated once"
        );
        assert_eq!(
            queue(&mut control).await.len(),
            4,
            "fault proxy never mutated shared queue"
        );
        assert_eq!(proxy.counts().0, 1);
        // Holding a real server reply proves cancellation is not rollback.
        let cancel_case = role(&f, "cancel");
        let cancel = build_case(cancel_case, now).unwrap();
        owned.push(expected(cancel_case).into());
        proxy.arm(2);
        let pushes = proxy.pushes();
        let worker = producer.clone();
        let task = tokio::spawn(async move { worker.enqueue(Some(&cancel)).await });
        bounded(proxy.state.applied.notified()).await;
        assert!(
            queue(&mut control)
                .await
                .contains(&expected(cancel_case).to_owned()),
            "write visible before response release"
        );
        task.abort();
        assert!(bounded(task).await.unwrap_err().is_cancelled());
        proxy.release();
        ping(&mut shared).await;
        assert_eq!(
            proxy.pushes(),
            pushes + 1,
            "aborted mutation is never automatically replayed"
        );
        assert_eq!(proxy.counts().0, 1);
        // Losing the reply after a successful server write likewise returns an
        // error; driver reconnect may occur, but RPUSH itself must not retry.
        let dc_case = role(&f, "disconnect");
        let dc = build_case(dc_case, now).unwrap();
        owned.push(expected(dc_case).into());
        proxy.arm(3);
        let pushes = proxy.pushes();
        assert!(bounded(producer.enqueue(Some(&dc))).await.is_err());
        bounded(proxy.state.applied.notified()).await;
        ping(&mut shared).await;
        assert_eq!(proxy.pushes(), pushes + 1);
        assert_eq!(
            queue(&mut control)
                .await
                .iter()
                .filter(|s| s.as_str() == expected(dc_case))
                .count(),
            1,
            "uncertain mutation applied exactly once"
        );
        // Real default SystemTime clock, checked within before/after rather than
        // asserted equal to a particular instant. Cleanup identifies only its
        // exact owned ID + payload, even if an assertion panics after the write.
        let system_case = role(&f, "system");
        let system = build_case(system_case, now).unwrap();
        let before = SystemReceiptClock.now().to_iso_string().unwrap();
        bounded(AiUsageProducer::new(cache.clone()).enqueue(Some(&system)))
            .await
            .unwrap();
        let after = SystemReceiptClock.now().to_iso_string().unwrap();
        let rows = queue(&mut control).await;
        let system_id = text(system.get("id").unwrap());
        let row = rows
            .iter()
            .find(|row| {
                parse_json(row)
                    .ok()
                    .and_then(|v| v.get("id").cloned())
                    .is_some_and(|id| text(&id) == system_id)
            })
            .unwrap();
        owned.push(row.clone());
        let parsed = parse_json(row).unwrap();
        let stamp = text(field(&parsed, "enqueuedAt"));
        assert!(stamp >= before.as_str() && stamp <= after.as_str());
        let null_case = role(&f, "null");
        assert!(build_case(null_case, now).is_none());
        producer
            .enqueue(build_case(null_case, now).as_ref())
            .await
            .unwrap();
        assert_eq!(queue(&mut control).await.len(), 7);
        let zero = clock.calls.load(Ordering::SeqCst);
        let commands = proxy.counts();
        assert!(
            producer
                .enqueue_at(Some(&a), JsDate::invalid())
                .await
                .is_err()
        );
        assert_eq!(clock.calls.load(Ordering::SeqCst), zero);
        assert_eq!(
            proxy.counts(),
            commands,
            "invalid explicit clock is rejected before Redis"
        );
    }))
    .await;
    // Always cleanup after async panic, using ONLY LREM exact payloads whose ID
    // is one of the frozen source cases in this unique owned namespace. This
    // also discovers a SystemTime payload if panic preceded registration.
    proxy.release();
    let mut cleanup = control.clone();
    let cleanup_result = Catch(Box::pin(async {
        let source_ids: Vec<_> = array(field(&f, "cases"))
            .iter()
            .filter(|c| c.get("integrationRole").is_some())
            .filter_map(|c| build_case(c, now))
            .filter_map(|r| r.get("id").cloned())
            .collect();
        for payload in queue(&mut cleanup).await {
            let value = parse_json(&payload).expect("fixture queue JSON");
            let id = field(&value, "id");
            if source_ids.contains(id) && text(id).starts_with(namespace) {
                let removed: i64 = bounded(
                    redis::cmd("LREM")
                        .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                        .arg(0)
                        .arg(&payload)
                        .query_async(&mut cleanup),
                )
                .await
                .unwrap();
                assert!(removed >= 1);
            }
        }
        assert!(
            queue(&mut cleanup).await.is_empty(),
            "unexpected records are preserved, never blindly deleted"
        );
    }))
    .await;
    drop(proxy);
    if let Err(e) = cleanup_result {
        resume_unwind(e);
    }
    if let Err(e) = result {
        resume_unwind(e);
    }
}
