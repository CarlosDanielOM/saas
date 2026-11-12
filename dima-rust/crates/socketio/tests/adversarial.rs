//! Adversarial tests with raw Engine.IO clients (no JavaScript): floods, a client that never
//! reads, oversized and malformed packets, acknowledgement id abuse, forged and expired
//! sessions, reconnects racing for one session, shutdown, and the bounds behind each.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dima_core::{ManualClock, Random as _, SystemRandom};
use dima_socketio::telemetry::{RecoveryOutcome, Refusal, SendOutcome};
use dima_socketio::{
    AckError, ConnectError, Delivery, DisconnectReason, Dispatch, Event, Handshake, Namespace,
    NamespaceOptions, NamespaceRef, Options, QueueLimits, Recovery, RecoveryLimits, Runtime,
    SendError, Socket, Telemetry,
};
use serde_json::{Value, json};
use support::TestServer;
use support::raw::{Next, Polling, Ws, event, http};

const SECOND: Duration = Duration::from_secs(1);

// ----- a probe namespace and counting telemetry ---------------------------------------------

#[derive(Default)]
struct Seen {
    disconnects: Mutex<Vec<(String, DisconnectReason)>>,
}

struct Probe {
    seen: Arc<Seen>,
}

impl Namespace for Probe {
    type Data = ();

    async fn check(&self, handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        if handshake.auth().contains_key("boom") {
            panic!("check exploded");
        }
        if handshake.auth().contains_key("deny") {
            return Err(ConnectError::new("denied").with_data(json!({"why": "asked"})));
        }
        Ok(())
    }

    async fn on_connect(&self, socket: Socket<()>) {
        let _ = socket.emit("hello", &[json!(socket.namespace())]);
    }

    async fn on_event(&self, socket: Socket<()>, mut event: Event) {
        let ack = event.take_ack();
        match event.name.as_str() {
            "echo" => match ack {
                Some(ack) => {
                    let _ = ack.send(&event.args);
                }
                None => {
                    let _ = socket.emit("echo", &event.args);
                }
            },
            "sleep" => {
                let ms = event.args.first().and_then(Value::as_u64).unwrap_or(1000);
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            "boom" => panic!("handler exploded"),
            _ => {}
        }
    }

    async fn on_disconnect(&self, socket: Socket<()>, reason: DisconnectReason) {
        self.seen
            .disconnects
            .lock()
            .unwrap()
            .push((socket.namespace().to_owned(), reason));
    }
}

#[derive(Default)]
struct Counting(Mutex<HashMap<String, usize>>);

impl Counting {
    fn bump(&self, key: String) {
        *self.0.lock().unwrap().entry(key).or_default() += 1;
    }
    fn get(&self, key: &str) -> usize {
        self.0.lock().unwrap().get(key).copied().unwrap_or(0)
    }
}

impl Telemetry for Counting {
    fn connection_opened(&self) {
        self.bump("opened".into());
    }
    fn connection_closed(&self, reason: DisconnectReason) {
        self.bump(format!("closed:{reason}"));
    }
    fn connection_refused(&self) {
        self.bump("refused".into());
    }
    fn socket_connected(&self, _namespace: &str, recovered: bool) {
        self.bump(format!("connected:{recovered}"));
    }
    fn socket_disconnected(&self, _namespace: &str, reason: DisconnectReason) {
        self.bump(format!("disconnected:{reason}"));
    }
    fn connect_refused(&self, _namespace: &str, refusal: Refusal) {
        self.bump(format!("refusal:{refusal:?}"));
    }
    fn send(&self, _namespace: &str, outcome: SendOutcome) {
        self.bump(format!("send:{outcome:?}"));
    }
    fn recovery(&self, _namespace: &str, outcome: RecoveryOutcome) {
        self.bump(format!("recovery:{outcome:?}"));
    }
    fn protocol_error(&self) {
        self.bump("protocol".into());
    }
    fn handler_panicked(&self, _namespace: &str) {
        self.bump("panic".into());
    }
    fn handler_timed_out(&self, _namespace: &str, handler: dima_socketio::telemetry::Handler) {
        self.bump(format!("timeout:{handler:?}"));
    }
}

struct Setup {
    server: TestServer,
    probe: NamespaceRef<Probe>,
    family: NamespaceRef<Probe>,
    seen: Arc<Seen>,
    telemetry: Arc<Counting>,
    clock: ManualClock,
}

/// A server with `/p` (static) and `/f/*` (family), both probes with `options`.
async fn setup(server_options: Options, options: NamespaceOptions) -> Setup {
    let seen = Arc::new(Seen::default());
    let telemetry = Arc::new(Counting::default());
    let clock = ManualClock::new(1_762_862_400_000);
    let runtime = Runtime {
        clock: Arc::new(clock.clone()),
        random: Arc::new(SystemRandom),
        telemetry: Arc::clone(&telemetry) as Arc<dyn Telemetry>,
    };
    type Refs = (NamespaceRef<Probe>, NamespaceRef<Probe>);
    let refs: Arc<Mutex<Option<Refs>>> = Arc::default();
    let declared = Arc::clone(&refs);
    let probe_seen = Arc::clone(&seen);
    let server = TestServer::start_with(server_options, runtime, move |builder| {
        let probe = builder
            .namespace(
                "/p",
                options,
                Probe {
                    seen: Arc::clone(&probe_seen),
                },
            )
            .unwrap();
        let family = builder
            .family(r"^\/f\/\w+$", options, Probe { seen: probe_seen })
            .unwrap();
        *declared.lock().unwrap() = Some((probe, family));
    })
    .await;
    let (probe, family) = refs.lock().unwrap().take().unwrap();
    Setup {
        server,
        probe,
        family,
        seen,
        telemetry,
        clock,
    }
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn ok() -> Value {
    json!({})
}

// ----- tests --------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn namespace_floods_are_refused_before_anything_is_allocated() {
    // Changed on purpose by finding 6: the table must hold what the connections may claim
    // (2 static names + 2 connections × 8), so it can no longer fill before the connection cap;
    // the old version of this test filled a 15-entry table from two connections.
    let s = setup(
        Options {
            max_connections: 2,
            max_namespaces: 2 + 2 * 8,
            ..Options::default()
        },
        NamespaceOptions::default(),
    )
    .await;
    let base = s.server.io.stats().namespaces;
    assert_eq!(base, 2, "`/` and `/p` exist from the start");

    // Per connection: 8 namespaces.
    let mut a = Ws::open(s.server.addr).await;
    for i in 0..8 {
        assert!(a.join(&format!("/f/a{i}"), &ok()).await.is_ok());
    }
    assert_eq!(
        a.join("/f/a8", &ok()).await,
        Err(json!({"message": "Invalid namespace"}))
    );
    // Names that are too long, or outside every family, allocate nothing.
    let mut b = Ws::open(s.server.addr).await;
    let long = format!("/f/{}", "a".repeat(300));
    assert_eq!(
        b.join(&long, &ok()).await,
        Err(json!({"message": "Invalid namespace"}))
    );
    for name in ["/f/", "/f/a-b", "/f/é", "/nope", "/f/a/b"] {
        assert_eq!(
            b.join(name, &ok()).await,
            Err(json!({"message": "Invalid namespace"})),
            "{name}"
        );
    }
    assert_eq!(s.server.io.stats().namespaces, base + 8);
    // Server-wide: every connection gets its 8, and a third connection is refused by the
    // connection cap before it could claim any.
    let mut joined = 0;
    for i in 0..8 {
        if b.join(&format!("/f/b{i}"), &ok()).await.is_ok() {
            joined += 1;
        }
    }
    assert_eq!(joined, 8);
    assert_eq!(s.server.io.stats().namespaces, 18);
    assert_eq!(try_open(s.server.addr).await.err(), Some(Some(503)));
    assert_eq!(s.telemetry.get("refusal:TooManyOnConnection"), 1);
    assert_eq!(s.telemetry.get("refusal:NameTooLong"), 1);
    assert_eq!(s.telemetry.get("refusal:InvalidNamespace"), 5);
    assert_eq!(s.telemetry.get("refusal:TooManyNamespaces"), 0);
    // Members are released with their last socket.
    a.close().await;
    b.close().await;
    let io = s.server.io.clone();
    eventually("members released", || io.stats().namespaces == base).await;
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_never_reads_is_closed_as_a_slow_consumer() {
    let s = setup(
        Options {
            close_timeout: Duration::from_millis(500),
            ..Options::default()
        },
        NamespaceOptions {
            queue: Some(QueueLimits {
                packets: 1024,
                bytes: 256 << 10,
            }),
            ..NamespaceOptions::default()
        },
    )
    .await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let socket = s.probe.sockets("/p").pop().unwrap();
    // The client stops reading: the TCP buffers fill, then the socket's 256 KiB queue.
    let payload = json!("x".repeat(64 << 10));
    let mut outcome = Ok(());
    for _ in 0..4000 {
        outcome = socket.emit("big", std::slice::from_ref(&payload));
        if outcome.is_err() {
            break;
        }
    }
    assert_eq!(outcome, Err(SendError::SlowConsumer));
    let closing = socket.clone();
    eventually("the slow consumer closed", || !closing.connected()).await;
    assert_eq!(
        socket.disconnect_reason(),
        Some(DisconnectReason::SlowConsumer)
    );
    assert_eq!(s.telemetry.get("send:SlowConsumer"), 1);
    let io = s.server.io.clone();
    eventually("queued bytes released", || io.stats().outbound_bytes == 0).await;
    // A recoverable reason: the session is kept.
    assert_eq!(s.server.io.stats().sessions, 1);
    drop(client);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lossy_events_are_dropped_and_replaceable_ones_coalesce() {
    let s = setup(
        Options::default(),
        NamespaceOptions {
            queue: Some(QueueLimits {
                packets: 5,
                bytes: 64 << 10,
            }),
            ..NamespaceOptions::default()
        },
    )
    .await;
    // A polling client takes nothing until it polls.
    let client = Polling::open(s.server.addr).await;
    assert_eq!(client.post(&["40/p,{}"]).await, Some(200));
    let probe = s.probe.clone();
    eventually("joined", || probe.sockets("/p").len() == 1).await;
    let socket = s.probe.sockets("/p").pop().unwrap();
    let payload = json!("y".repeat(16 << 10));
    let mut dropped = 0;
    for _ in 0..10 {
        let outcome = socket.emit_with(&Delivery::Lossy, "sample", std::slice::from_ref(&payload));
        if outcome == Err(SendError::Dropped) {
            dropped += 1;
        }
    }
    assert_eq!(
        dropped,
        10 - 3,
        "five packets: the CONNECT, the hello and three samples"
    );
    assert!(socket.connected(), "dropping never disconnects");
    // Snapshots while the queue is full: one waits, each newer one replaces it.
    let state = Delivery::Replaceable("state".to_owned());
    for version in 0..50 {
        assert_eq!(socket.emit_with(&state, "state", &[json!(version)]), Ok(()));
    }
    assert_eq!(s.telemetry.get("send:Deferred"), 1);
    assert_eq!(s.telemetry.get("send:Replaced"), 49);
    // The client catches up: it sees the newest state only.
    let mut states = Vec::new();
    for _ in 0..5 {
        let Ok(packets) = client.poll(SECOND).await else {
            break;
        };
        for packet in packets {
            if let Some(args) = event(&packet, "/p")
                && args.first() == Some(&json!("state"))
            {
                states.push(args[1].clone());
            }
        }
        if !states.is_empty() {
            break;
        }
    }
    assert_eq!(states, [json!(49)]);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_payloads_follow_the_one_megabyte_limit() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    // WebSocket: a message of exactly 1,000,000 bytes is accepted, one byte more closes.
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let wrap = "42/p,1[\"echo\",\"\"]".len();
    let exact = format!("42/p,1[\"echo\",\"{}\"]", "a".repeat(1_000_000 - wrap));
    assert_eq!(exact.len(), 1_000_000);
    client.send(&exact).await;
    let answer = client.until(|t| t.starts_with("43/p,1"), 5 * SECOND).await;
    let expected = 1_000_000 - "\"echo\",".len();
    assert_eq!(answer.map(|a| a.len()), Some(expected));
    let over = format!(
        "42/p,[\"echo\",\"{}\"]",
        "a".repeat(1_000_001 - "42/p,[\"echo\",\"\"]".len())
    );
    client.send(&over).await;
    assert!(client.closed_within(5 * SECOND).await);
    // Polling: 413 for a body beyond the limit; the session is kept.
    let polling = Polling::open(s.server.addr).await;
    // 1,000,001 bytes declared: refused before the body is read.
    let answer = http(
        s.server.addr,
        "POST",
        &format!("/socket.io/?EIO=4&transport=polling&sid={}", polling.sid),
        &[("Content-Length", "1000001")],
        b"4x",
        5 * SECOND,
    )
    .await
    .unwrap();
    assert_eq!(answer.status, 413);
    assert_eq!(polling.post(&["40/p,{}"]).await, Some(200));
    let packets = polling.poll(5 * SECOND).await.unwrap();
    assert!(
        packets.iter().any(|p| p.starts_with("40/p,{\"sid\"")),
        "{packets:?}"
    );
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_packets_close_the_connection_and_harmless_ones_do_not() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let deep = format!("42/p,[\"echo\",{}{}]", "[".repeat(200), "]".repeat(200));
    let closing = [
        "4garbage",
        "4",
        "4 0",
        "47",
        "451-/p,[\"x\",{\"_placeholder\":true,\"num\":0}]",
        "42/p,[\"connect\"]",
        "42/p,[\"disconnecting\",1]",
        "42/p,[]",
        "42/p,{}",
        "40/p,{}",
        "42/other,[\"x\"]",
        "42/p,9007199254740992[\"x\"]",
        "42/p, [\"x\"]",
        "44/p,{\"message\":\"from the client\"}",
        "41/p,{}",
        "42/p,[\"x\"",
        deep.as_str(),
        "9",
    ];
    for packet in closing {
        let mut client = Ws::open(s.server.addr).await;
        client.join("/p", &ok()).await.unwrap();
        client.send(packet).await;
        assert!(client.closed_within(3 * SECOND).await, "{packet:?} closes");
    }
    // A binary frame is a protocol error too.
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    client.send_binary(vec![4, 1, 2, 3]).await;
    assert!(client.closed_within(3 * SECOND).await, "binary closes");

    // Accepted and ignored, as the reference does.
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    for packet in [
        "43/p,",
        "42/p,",
        "43/p,5[]",
        "43/p,[1]",
        "42/p,[\"unknown event\"]",
    ] {
        client.send(packet).await;
    }
    client.send("42/p,7[\"echo\",\"still here\"]").await;
    assert_eq!(
        client
            .until(|t| t.starts_with("43/p,7"), 3 * SECOND)
            .await
            .as_deref(),
        Some("43/p,7[\"still here\"]")
    );
    assert!(s.telemetry.get("protocol") >= closing.len());
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn acknowledgement_ids_cannot_be_abused() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let socket = s.probe.sockets("/p").pop().unwrap();
    let asks: Vec<_> = (0..3)
        .map(|i| {
            let socket = socket.clone();
            tokio::spawn(async move { socket.emit_with_ack("q", &[json!(i)], 2 * SECOND).await })
        })
        .collect();
    let mut ids = Vec::new();
    for _ in 0..3 {
        let asked = |t: &str| {
            t.strip_prefix("42/p,")
                .is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
        };
        let text = client.until(asked, 3 * SECOND).await.unwrap();
        let id: u64 = text
            .strip_prefix("42/p,")
            .unwrap()
            .split('[')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        ids.push(id);
    }
    ids.sort_unstable();
    assert_eq!(ids, [0, 1, 2]);
    // Unknown, duplicate and late answers are ignored; the right one resolves.
    client.send("43/p,77[\"junk\"]").await;
    client.send("43/p,1[\"one\"]").await;
    client.send("43/p,1[\"again\"]").await;
    client.send("43/p,0[\"zero\"]").await;
    client.send("43/other,2[\"wrong namespace\"]").await;
    assert!(
        client.closed_within(SECOND).await,
        "an ACK for an unjoined namespace closes"
    );
    let mut results = Vec::new();
    for ask in asks {
        results.push(ask.await.unwrap());
    }
    // The connection closed before the third answer: it fails as disconnected.
    let answered: Vec<_> = results
        .iter()
        .filter_map(|r| r.as_ref().ok().cloned())
        .collect();
    assert!(answered.contains(&vec![json!("zero")]) && answered.contains(&vec![json!("one")]));
    assert!(results.iter().any(|r| *r == Err(AckError::Disconnected)));

    // At most 32 answers awaited per socket.
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let socket = s.probe.sockets("/p").pop().unwrap();
    let pending: Vec<_> = (0..32)
        .map(|_| {
            let socket = socket.clone();
            tokio::spawn(async move { socket.emit_with_ack("q", &[], 3 * SECOND).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        socket.emit_with_ack("q", &[], SECOND).await,
        Err(AckError::TooMany)
    );
    client.close().await;
    for task in pending {
        assert_eq!(task.await.unwrap(), Err(AckError::Disconnected));
    }
    s.server.stop().await;
}

/// Joins `/p`, receives the hello, and returns the session ids and the offset.
async fn join_and_hello(client: &mut Ws, auth: &Value) -> (String, String, String) {
    let connect = client.join("/p", auth).await.unwrap();
    let hello = client
        .until(|t| event(t, "/p").is_some(), 3 * SECOND)
        .await
        .unwrap();
    let args = event(&hello, "/p").unwrap();
    (
        connect["sid"].as_str().unwrap().to_owned(),
        connect["pid"].as_str().unwrap().to_owned(),
        args.last().and_then(Value::as_str).unwrap().to_owned(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forged_or_expired_sessions_connect_fresh() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    let (sid, pid, offset) = join_and_hello(&mut client, &ok()).await;
    client.drop_connection();
    let probe = s.probe.clone();
    eventually("the socket left", || probe.sockets("/p").is_empty()).await;
    assert_eq!(s.server.io.stats().sessions, 1);

    let mut forged = Ws::open(s.server.addr).await;
    let fake_pid = SystemRandom.base64url_token(15).unwrap();
    let (sid2, pid2, _) =
        join_and_hello(&mut forged, &json!({"pid": fake_pid, "offset": offset})).await;
    assert!(sid2 != sid && pid2 != pid && pid2 != fake_pid);
    // The right private id with an offset that was never stored: fresh, and the session stays.
    let mut wrong_offset = Ws::open(s.server.addr).await;
    let (sid3, _, _) =
        join_and_hello(&mut wrong_offset, &json!({"pid": pid, "offset": "nope"})).await;
    assert_ne!(sid3, sid);
    assert_eq!(s.server.io.stats().sessions, 1);
    // Non-string ids are not a recovery attempt.
    let mut odd = Ws::open(s.server.addr).await;
    let (sid4, _, _) = join_and_hello(&mut odd, &json!({"pid": 1, "offset": ["x"]})).await;
    assert_ne!(sid4, sid);
    // Past the 2-minute window: fresh.
    s.clock.advance(120_001);
    let mut late = Ws::open(s.server.addr).await;
    let (sid5, pid5, _) = join_and_hello(&mut late, &json!({"pid": pid, "offset": offset})).await;
    assert!(sid5 != sid && pid5 != pid);
    assert_eq!(s.telemetry.get("recovery:UnknownSession"), 1);
    assert_eq!(s.telemetry.get("recovery:UnknownOffset"), 1);
    assert_eq!(s.telemetry.get("recovery:Expired"), 1);
    assert_eq!(s.telemetry.get("recovery:Recovered"), 0);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnects_racing_for_one_session_recover_it_once() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    let (sid, pid, offset) = join_and_hello(&mut client, &ok()).await;
    client.drop_connection();
    let probe = s.probe.clone();
    eventually("the socket left", || probe.sockets("/p").is_empty()).await;

    let auth = json!({"pid": pid, "offset": offset});
    let racers: Vec<_> = (0..20)
        .map(|_| {
            let auth = auth.clone();
            let addr = s.server.addr;
            tokio::spawn(async move {
                let mut client = Ws::open(addr).await;
                let connect = client.join("/p", &auth).await.unwrap();
                (connect, client)
            })
        })
        .collect();
    let mut recovered = 0;
    let mut clients = Vec::new();
    for racer in racers {
        let (connect, client) = racer.await.unwrap();
        if connect["sid"] == json!(sid) {
            assert_eq!(connect["pid"], json!(pid));
            recovered += 1;
        } else {
            assert_ne!(connect["pid"], json!(pid));
        }
        clients.push(client);
    }
    assert_eq!(recovered, 1);
    assert_eq!(s.probe.sockets("/p").len(), 20);
    assert_eq!(
        s.probe
            .sockets("/p")
            .iter()
            .filter(|socket| socket.id() == sid)
            .count(),
        1
    );
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_emitted_during_a_restore_arrive_once_and_in_order() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    let (sid, pid, offset) = join_and_hello(&mut client, &ok()).await;
    client.drop_connection();
    let probe = s.probe.clone();
    eventually("the socket left", || probe.sockets("/p").is_empty()).await;
    for n in 0..500 {
        s.probe.emit("/p", "n", &[json!(n)]).unwrap();
    }
    let emitter = {
        let probe = s.probe.clone();
        tokio::spawn(async move {
            for n in 500..1000 {
                probe.emit("/p", "n", &[json!(n)]).unwrap();
                if n % 50 == 0 {
                    tokio::task::yield_now().await;
                }
            }
        })
    };
    let mut back = Ws::open(s.server.addr).await;
    back.send(&format!("40/p,{}", json!({"pid": pid, "offset": offset})))
        .await;
    let mut seen = Vec::new();
    let mut connect = None;
    while seen.len() < 1000 || connect.is_none() {
        let Next::Text(text) = back.next(5 * SECOND).await else {
            panic!(
                "stream ended after {} events (CONNECT: {connect:?})",
                seen.len()
            );
        };
        if let Some(data) = text.strip_prefix("40/p,") {
            connect = Some(serde_json::from_str::<Value>(data).unwrap());
        } else if let Some(args) = event(&text, "/p")
            && args.first() == Some(&json!("n"))
        {
            seen.push(args[1].as_u64().unwrap());
        }
    }
    emitter.await.unwrap();
    assert_eq!(seen, (0..1000).collect::<Vec<_>>());
    let connect = connect.expect("CONNECT received");
    assert_eq!(
        (connect["sid"].as_str(), connect["pid"].as_str()),
        (Some(sid.as_str()), Some(pid.as_str()))
    );
    assert_eq!(s.telemetry.get("recovery:Recovered"), 1);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recovery_stores_are_bounded() {
    let s = setup(
        Options {
            recovery: RecoveryLimits {
                packets_per_namespace: 10,
                sessions_per_namespace: 2,
                ..RecoveryLimits::default()
            },
            ..Options::default()
        },
        NamespaceOptions::default(),
    )
    .await;
    let mut client = Ws::open(s.server.addr).await;
    let (sid, pid, offset) = join_and_hello(&mut client, &ok()).await;
    client.drop_connection();
    let probe = s.probe.clone();
    eventually("the socket left", || probe.sockets("/p").is_empty()).await;
    for n in 0..25 {
        s.probe.emit("/p", "n", &[json!(n)]).unwrap();
    }
    assert_eq!(s.server.io.stats().stored_packets, 10);
    // The offset was dropped to make room: a fresh connection, never a partial replay.
    let mut back = Ws::open(s.server.addr).await;
    let connect = back
        .join("/p", &json!({"pid": pid, "offset": offset}))
        .await
        .unwrap();
    assert_ne!(connect["sid"], json!(sid));
    // Two sessions per namespace at most.
    for _ in 0..4 {
        let mut c = Ws::open(s.server.addr).await;
        join_and_hello(&mut c, &ok()).await;
        c.drop_connection();
    }
    back.drop_connection();
    let io = s.server.io.clone();
    eventually("sessions kept", || io.stats().sessions == 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(s.server.io.stats().sessions, 2);
    // Expiry follows the reference's sweep: everything goes 2 minutes after the next sweep.
    s.clock.advance(200_000);
    let mut probe_client = Ws::open(s.server.addr).await;
    join_and_hello(&mut probe_client, &ok()).await;
    s.server.stop().await;
}

/// `/slow` dispatches one event at a time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_flooding_busy_handlers_is_closed() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    for _ in 0..400 {
        if !client.send("42/p,[\"sleep\",5000]").await {
            break;
        }
    }
    assert!(client.closed_within(5 * SECOND).await);
    let seen = Arc::clone(&s.seen);
    eventually("on_disconnect", || {
        seen.disconnects
            .lock()
            .unwrap()
            .contains(&("/p".to_owned(), DisconnectReason::InboundOverflow))
    })
    .await;
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handler_panics_are_contained() {
    let s = setup(
        Options::default(),
        NamespaceOptions {
            dispatch: Dispatch::Concurrent(4),
            ..NamespaceOptions::default()
        },
    )
    .await;
    let mut client = Ws::open(s.server.addr).await;
    assert_eq!(
        client.join("/p", &json!({"boom": true})).await,
        Err(json!({"message": "Internal server error"}))
    );
    assert_eq!(
        client.join("/p", &json!({"deny": true})).await,
        Err(json!({"message": "denied", "data": {"why": "asked"}}))
    );
    client.join("/p", &ok()).await.unwrap();
    client.send("42/p,[\"boom\"]").await;
    client.send("42/p,3[\"echo\",\"alive\"]").await;
    assert_eq!(
        client
            .until(|t| t.starts_with("43/p,3"), 3 * SECOND)
            .await
            .as_deref(),
        Some("43/p,3[\"alive\"]")
    );
    assert_eq!(s.telemetry.get("panic"), 2);
    assert_eq!(s.telemetry.get("refusal:CheckPanicked"), 1);
    assert_eq!(s.telemetry.get("refusal:Check"), 1);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_that_joins_nothing_is_closed_after_the_connect_timeout() {
    let s = setup(
        Options {
            connect_timeout: Duration::from_millis(300),
            ..Options::default()
        },
        NamespaceOptions::default(),
    )
    .await;
    let mut idle = Ws::open(s.server.addr).await;
    let mut joined = Ws::open(s.server.addr).await;
    joined.join("/p", &ok()).await.unwrap();
    let started = tokio::time::Instant::now();
    assert!(idle.closed_within(2 * SECOND).await);
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(
        !joined.closed_within(SECOND).await,
        "a joined connection stays"
    );
    assert_eq!(s.telemetry.get("closed:forced server close"), 1);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connections_beyond_the_limit_are_refused() {
    let s = setup(
        Options {
            max_connections: 2,
            ..Options::default()
        },
        NamespaceOptions::default(),
    )
    .await;
    let first = Polling::open(s.server.addr).await;
    let _second = Ws::open(s.server.addr).await;
    let third = http(
        s.server.addr,
        "GET",
        "/socket.io/?EIO=4&transport=polling",
        &[],
        b"",
        SECOND,
    )
    .await
    .unwrap();
    assert_eq!(third.status, 503);
    let ws = tokio_tungstenite::connect_async(format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket",
        s.server.addr
    ))
    .await;
    assert!(
        ws.is_err(),
        "a WebSocket handshake beyond the limit is refused"
    );
    // Closing one frees a place.
    assert_eq!(first.post(&["1"]).await, Some(200));
    let io = s.server.io.clone();
    eventually("a place freed", || io.stats().connections == 1).await;
    let _fourth = Polling::open(s.server.addr).await;
    assert_eq!(s.telemetry.get("refused"), 2);
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_says_goodbye_and_releases_everything() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let mut ws = Ws::open(s.server.addr).await;
    ws.join("/p", &ok()).await.unwrap();
    let polling = Polling::open(s.server.addr).await;
    assert_eq!(polling.post(&["40/f/x,{}"]).await, Some(200));
    // Take everything queued so far: the hello. The first heartbeat ping comes one ping
    // interval (25 s) after the session opened, as in `engine.io`.
    let mut hello = false;
    for _ in 0..5 {
        for packet in polling.poll(2 * SECOND).await.unwrap_or_default() {
            hello |= event(&packet, "/f/x").is_some();
        }
        if hello {
            break;
        }
    }
    assert!(hello);
    let mut wait = tokio::spawn(async move { polling.poll(10 * SECOND).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let io = s.server.io.clone();
    let seen = Arc::clone(&s.seen);
    let started = tokio::time::Instant::now();
    s.server.stop().await;
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(ws.closed_within(SECOND).await);
    let packets = tokio::time::timeout(SECOND, &mut wait)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        packets,
        Ok(vec!["1".to_owned()]),
        "the pending poll gets the close packet"
    );
    let reasons: Vec<_> = seen
        .disconnects
        .lock()
        .unwrap()
        .iter()
        .map(|(_, r)| *r)
        .collect();
    assert_eq!(reasons, [DisconnectReason::ServerShuttingDown; 2]);
    let stats = io.stats();
    assert_eq!(
        (
            stats.connections,
            stats.sessions,
            stats.stored_packets,
            stats.outbound_bytes
        ),
        (0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_web_server_shutting_down_shuts_socket_io_down() {
    // Two signals on purpose: only the one `dima_web::serve` watches fires.
    let io_token = dima_core::Shutdown::new();
    let web_token = tokio_util::sync::CancellationToken::new();
    let io =
        dima_socketio::SocketIo::builder(Options::default(), Runtime::default(), io_token.clone())
            .build(&dima_web::ServeOptions::default())
            .unwrap();
    let listener = dima_web::bind_to(std::net::SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let addr = listener.local_addr().unwrap();
    let serve = tokio::spawn(dima_web::serve(
        listener,
        io.layer(support::app()),
        web_token.clone(),
        dima_web::ServeOptions::default(),
    ));
    let mut client = Ws::open(addr).await;
    client.join("/", &ok()).await.unwrap();
    web_token.cancel();
    // The upgrade guard's token reached Socket.IO: the WebSocket is closed well before the
    // web server's 10 s drain deadline.
    assert!(client.closed_within(3 * SECOND).await);
    tokio::time::timeout(3 * SECOND, io.closed()).await.unwrap();
    tokio::time::timeout(3 * SECOND, serve)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!io_token.is_triggered());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn clients_closing_during_an_upgrade_never_break_the_server() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    for _ in 0..60 {
        let polling = Polling::open(s.server.addr).await;
        let url = format!(
            "ws://{}/socket.io/?EIO=4&transport=websocket&sid={}",
            s.server.addr, polling.sid
        );
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            continue;
        };
        use futures_util::SinkExt as _;
        use tokio_tungstenite::tungstenite::Message;
        let _ = ws.send(Message::text("2probe")).await;
        let _ = futures_util::StreamExt::next(&mut ws).await;
        let _ = ws.send(Message::text("5")).await;
        let _ = ws.close(None).await;
    }
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    client.send("42/p,1[\"echo\",\"fine\"]").await;
    assert!(
        client
            .until(|t| t.starts_with("43/p,1"), 3 * SECOND)
            .await
            .is_some()
    );
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_recovery_modes_differ_as_in_the_reference() {
    for (recovery, offsets, kept) in [
        (Recovery::Full, true, 1),
        (Recovery::OffsetsOnly, true, 0),
        (Recovery::Off, false, 0),
    ] {
        let s = setup(
            Options::default(),
            NamespaceOptions {
                recovery,
                ..NamespaceOptions::default()
            },
        )
        .await;
        let mut client = Ws::open(s.server.addr).await;
        let connect = client.join("/p", &ok()).await.unwrap();
        // The private id is always there: recovery is on for the server.
        assert!(connect["pid"].is_string());
        let hello = client
            .until(|t| event(t, "/p").is_some(), SECOND)
            .await
            .unwrap();
        let args = event(&hello, "/p").unwrap();
        assert_eq!(
            args.len(),
            if offsets { 3 } else { 2 },
            "{recovery:?}: {hello}"
        );
        client.drop_connection();
        let probe = s.probe.clone();
        eventually("the socket left", || probe.sockets("/p").is_empty()).await;
        assert_eq!(s.server.io.stats().sessions, kept, "{recovery:?}");
        // Emits to nobody are stored only with full recovery.
        s.probe.emit("/p", "x", &[]).unwrap();
        assert_eq!(s.server.io.stats().stored_packets, kept * 2, "{recovery:?}");
        s.server.stop().await;
    }
    // The namespace emit refuses names the declaration does not cover.
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    assert_eq!(
        s.family.emit("/p", "x", &[]),
        Err(SendError::UnknownNamespace)
    );
    assert_eq!(
        s.family.emit("/f/a", "connect", &[]),
        Err(SendError::Reserved)
    );
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_stops_answering_heartbeats_is_closed() {
    let s = setup(
        Options {
            ping_interval: Duration::from_millis(200),
            ping_timeout: Duration::from_millis(200),
            ..Options::default()
        },
        NamespaceOptions::default(),
    )
    .await;
    let mut alive = Ws::open(s.server.addr).await;
    alive.join("/p", &ok()).await.unwrap();
    // Read (and answer pings) all along.
    let alive = tokio::spawn(async move { alive.closed_within(2 * SECOND).await });
    let mut silent = Ws::open(s.server.addr).await;
    silent.join("/f/silent", &ok()).await.unwrap();
    silent.answer_pings = false;
    assert!(silent.closed_within(3 * SECOND).await);
    let seen = Arc::clone(&s.seen);
    eventually("ping timeout", || {
        seen.disconnects
            .lock()
            .unwrap()
            .contains(&("/f/silent".to_owned(), DisconnectReason::PingTimeout))
    })
    .await;
    // A recoverable reason: the session is kept.
    assert_eq!(s.server.io.stats().sessions, 1);
    assert!(!alive.await.unwrap(), "a client that answers stays");
    s.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_polling_requests_end_the_session() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    // Two polls at once (`overlap from client`). Nothing is queued (the first heartbeat ping
    // waits one ping interval), so the first one waits.
    let polling = Polling::open(s.server.addr).await;
    let first = tokio::spawn({
        let addr = s.server.addr;
        let path = format!("/socket.io/?EIO=4&transport=polling&sid={}", polling.sid);
        async move {
            http(addr, "GET", &path, &[], b"", 5 * SECOND)
                .await
                .map(|a| a.status)
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let second = polling.poll(SECOND).await;
    assert_eq!(second, Err(Some(400)));
    let first = first.await.unwrap();
    assert_eq!(first, Some(200), "the waiting poll ends with the close");
    assert_eq!(
        polling.poll(SECOND).await,
        Err(Some(400)),
        "the session is gone"
    );
    // Two POSTs at once (`data request overlap from client`): the first one's body never comes.
    let polling = Polling::open(s.server.addr).await;
    let path = format!("/socket.io/?EIO=4&transport=polling&sid={}", polling.sid);
    let stalled = {
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\n4"
        );
        let mut stream = tokio::net::TcpStream::connect(s.server.addr).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut stream, request.as_bytes())
            .await
            .unwrap();
        stream
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(polling.post(&["40/p,{}"]).await, Some(400));
    assert_eq!(
        polling.poll(SECOND).await,
        Err(Some(400)),
        "the session is gone"
    );
    drop(stalled);
    s.server.stop().await;
}

/// A WebSocket upgrade that fails after its handshake (here a wrong probe) closes the probe
/// only; the client stays on polling, as in `engine.io` (socket.js 243-246). Upstream
/// `engineioxide` ended the whole session; the vendored copy is patched (vendor/README.md,
/// change 1).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_upgrade_keeps_the_session_on_polling() {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message;
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let polling = Polling::open(s.server.addr).await;
    assert_eq!(polling.post(&["40/p,{}"]).await, Some(200));
    let _ = polling.poll(SECOND).await;
    let url = format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket&sid={}",
        s.server.addr, polling.sid
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::text("4not a probe")).await.unwrap();
    let closed = tokio::time::timeout(2 * SECOND, async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the probe WebSocket was not closed");
    assert_eq!(
        polling.post(&["42/p,1[\"echo\",\"still\"]"]).await,
        Some(200)
    );
    let mut answered = false;
    for _ in 0..20 {
        match polling.poll(SECOND).await {
            Ok(packets) if packets.iter().any(|p| p.starts_with("43/p,1")) => {
                answered = true;
                break;
            }
            Ok(_) => {}
            Err(status) => panic!("the polling session ended: {status:?}"),
        }
    }
    assert!(answered, "no answer over polling after the failed upgrade");
    s.server.stop().await;
}

/// `/k`: the check counts its calls and gives each socket its own counter.
struct Counted {
    checks: Arc<std::sync::atomic::AtomicUsize>,
}

impl Namespace for Counted {
    type Data = std::sync::atomic::AtomicUsize;

    async fn check(
        &self,
        _handshake: &Handshake,
        _namespace: &str,
    ) -> Result<Self::Data, ConnectError> {
        let n = self
            .checks
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(std::sync::atomic::AtomicUsize::new(n * 100))
    }

    async fn on_connect(&self, socket: Socket<Self::Data>) {
        let value = socket
            .data()
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = socket.emit("value", &[json!(value), json!(socket.recovered())]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recovered_socket_keeps_its_data_and_skips_the_check() {
    let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let slot: Arc<Mutex<Option<NamespaceRef<Counted>>>> = Arc::default();
    let declared = Arc::clone(&slot);
    let counted_checks = Arc::clone(&checks);
    let server = TestServer::start_with(Options::default(), Runtime::default(), move |builder| {
        let r = builder
            .namespace(
                "/k",
                NamespaceOptions::default(),
                Counted {
                    checks: counted_checks,
                },
            )
            .unwrap();
        *declared.lock().unwrap() = Some(r);
    })
    .await;
    let counted = slot.lock().unwrap().take().unwrap();
    let mut client = Ws::open(server.addr).await;
    let connect = client.join("/k", &ok()).await.unwrap();
    let value = client
        .until(|t| event(t, "/k").is_some(), SECOND)
        .await
        .unwrap();
    let args = event(&value, "/k").unwrap();
    assert_eq!((&args[1], &args[2]), (&json!(0), &json!(false)));
    let before = counted.sockets("/k").pop().unwrap();
    client.drop_connection();
    eventually("the socket left", || counted.sockets("/k").is_empty()).await;
    let auth = json!({"pid": connect["pid"], "offset": args[3]});
    let mut back = Ws::open(server.addr).await;
    assert_eq!(back.join("/k", &auth).await.unwrap(), connect);
    let value = back
        .until(|t| event(t, "/k").is_some(), SECOND)
        .await
        .unwrap();
    let args = event(&value, "/k").unwrap();
    assert_eq!(
        (&args[1], &args[2]),
        (&json!(1), &json!(true)),
        "same counter, recovered"
    );
    assert_eq!(
        checks.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the check was skipped"
    );
    let after = counted.sockets("/k").pop().unwrap();
    assert!(Arc::ptr_eq(before.data(), after.data()));
    server.stop().await;
}

// ----- review fixes (F-SOCKETIO-b) ----------------------------------------------------------

/// Finding 13: dropping the future of `emit_with_ack` (a `select!`, a timeout around it) frees
/// its slot at once, on the socket and in the server's count.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_acknowledgement_frees_its_slot() {
    let options = Options {
        max_pending_acks: 2,
        ..Options::default()
    };
    let s = setup(options, NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let socket = s.probe.sockets("/p").pop().unwrap();
    for _ in 0..5 {
        let asked = socket.emit_with_ack("q", &[], 60 * SECOND);
        // The client never answers: the wait is cancelled after the question went out.
        let outcome = tokio::time::timeout(Duration::from_millis(20), asked).await;
        assert!(outcome.is_err(), "cancelled, not refused: {outcome:?}");
    }
    assert_eq!(s.server.io.stats().pending_acks, 0);
    assert_eq!(
        socket
            .emit_with_ack("q", &[], Duration::from_millis(50))
            .await,
        Err(AckError::Timeout)
    );
    client.close().await;
    s.server.stop().await;
}

/// Finding 16: a polling answer can be compressed, so it names `Accept-Encoding` in `Vary`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn polling_answers_vary_on_the_accepted_encoding() {
    let s = setup(Options::default(), NamespaceOptions::default()).await;
    let answer = http(
        s.server.addr,
        "GET",
        "/socket.io/?EIO=4&transport=polling",
        &[("Accept-Encoding", "gzip")],
        b"",
        5 * SECOND,
    )
    .await
    .unwrap();
    assert_eq!(answer.status, 200);
    assert_eq!(answer.header("vary"), Some("Accept-Encoding"));
    s.server.stop().await;
}

/// A WebSocket handshake to `/socket.io/`: `Ok` with the client once the open packet arrived,
/// `Err(status)` when the server answered the handshake with an error status.
async fn try_open(addr: std::net::SocketAddr) -> Result<impl Sized, Option<u16>> {
    use futures_util::StreamExt as _;
    let url = format!("ws://{addr}/socket.io/?EIO=4&transport=websocket");
    match tokio_tungstenite::connect_async(url).await {
        Ok((mut ws, _)) => match tokio::time::timeout(5 * SECOND, ws.next()).await {
            Ok(Some(Ok(message))) if message.to_text().is_ok_and(|t| t.starts_with('0')) => Ok(ws),
            _ => Err(None),
        },
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(Some(response.status().as_u16()))
        }
        Err(_) => Err(None),
    }
}

/// Finding 5: the connection cap is a reservation taken before the asynchronous part of a
/// WebSocket handshake, so handshakes racing each other cannot all pass it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_websocket_handshakes_never_exceed_the_connection_cap() {
    let options = Options {
        max_connections: 5,
        ..Options::default()
    };
    let s = setup(options, NamespaceOptions::default()).await;
    let addr = s.server.addr;
    let attempts: Vec<_> = (0..40).map(|_| tokio::spawn(try_open(addr))).collect();
    let mut open = Vec::new();
    let mut refused = 0;
    for attempt in attempts {
        match attempt.await.unwrap() {
            Ok(ws) => open.push(ws),
            Err(Some(503)) => refused += 1,
            Err(other) => panic!("unexpected handshake outcome {other:?}"),
        }
    }
    assert_eq!((open.len(), refused), (5, 35));
    assert_eq!(s.server.io.stats().connections, 5);
    assert_eq!(s.telemetry.get("refused"), 35);
    // Slots come back when sessions end.
    drop(open);
    let io = s.server.io.clone();
    eventually("the sessions ended", || io.stats().connections == 0).await;
    assert!(try_open(addr).await.is_ok());
    s.server.stop().await;
}

/// Finding 5: the connection cap may not exceed `dima-web`'s stream quota, which every
/// WebSocket of the server also takes a slot of.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_cap_beyond_the_stream_quota_refuses_to_build() {
    let builder = dima_socketio::SocketIo::builder(
        Options {
            max_connections: 11,
            ..Options::default()
        },
        Runtime::default(),
        dima_core::Shutdown::new(),
    );
    let serve = dima_web::ServeOptions {
        max_streams: 10,
        ..dima_web::ServeOptions::default()
    };
    assert_eq!(
        builder.build(&serve).err(),
        Some(dima_socketio::BuildError::StreamQuota {
            connections: 11,
            streams: 10
        })
    );
}

/// Finding 6: the namespace table must hold what the connections may claim.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_namespace_table_smaller_than_the_connections_may_claim_refuses_to_build() {
    let builder = dima_socketio::SocketIo::builder(
        Options {
            max_connections: 100,
            max_namespaces: 100 * 8,
            ..Options::default()
        },
        Runtime::default(),
        dima_core::Shutdown::new(),
    );
    assert_eq!(
        builder.build(&dima_web::ServeOptions::default()).err(),
        Some(dima_socketio::BuildError::NamespaceTable {
            namespaces: 800,
            needed: 801
        })
    );
    assert!(
        dima_socketio::SocketIo::builder(
            Options::default(),
            Runtime::default(),
            dima_core::Shutdown::new()
        )
        .build(&dima_web::ServeOptions::default())
        .is_ok()
    );
}

/// Finding 5: a WebSocket reserves its `dima-web` stream slot before Engine.IO sees it; when
/// other streams (the app's own WebSocket here) took the quota, it is refused with `503` and no
/// session exists, while polling (no stream) still connects.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_stream_quota_refuses_a_websocket_before_its_session_exists() {
    use futures_util::{SinkExt as _, StreamExt as _};
    let serve = dima_web::ServeOptions {
        max_streams: 2,
        ..dima_web::ServeOptions::default()
    };
    let options = Options {
        max_connections: 2,
        ..Options::default()
    };
    let telemetry = Arc::new(Counting::default());
    let runtime = Runtime {
        telemetry: Arc::clone(&telemetry) as Arc<dyn Telemetry>,
        ..Runtime::default()
    };
    let server = TestServer::start_serving(options, runtime, serve, support::declare).await;
    let addr = server.addr;
    let (mut app_ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/raw-ws"))
        .await
        .unwrap();
    app_ws
        .send(tokio_tungstenite::tungstenite::Message::text("hi"))
        .await
        .unwrap();
    assert!(app_ws.next().await.is_some());
    let first = try_open(addr).await;
    assert!(first.is_ok());
    assert_eq!(try_open(addr).await.err(), Some(Some(503)));
    assert_eq!(server.io.stats().connections, 1);
    assert_eq!(telemetry.get("opened"), 1);
    let polling = Polling::open(addr).await;
    assert!(!polling.sid.is_empty());
    assert_eq!(server.io.stats().connections, 2);
    drop(first);
    server.stop().await;
}

/// Finding 5: sockets per namespace are reserved under the member lock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_namespace_refuses_further_sockets() {
    let options = Options {
        max_sockets_per_namespace: 1,
        ..Options::default()
    };
    let s = setup(options, NamespaceOptions::default()).await;
    let mut a = Ws::open(s.server.addr).await;
    a.join("/p", &ok()).await.unwrap();
    let mut b = Ws::open(s.server.addr).await;
    assert_eq!(
        b.join("/p", &ok()).await,
        Err(json!({"message": "Invalid namespace"}))
    );
    assert_eq!(s.telemetry.get("refusal:NamespaceFull"), 1);
    a.close().await;
    let probe = s.probe.clone();
    eventually("the socket left", || probe.sockets("/p").is_empty()).await;
    assert!(b.join("/p", &ok()).await.is_ok());
    s.server.stop().await;
}

/// Finding 2: inbound memory is bounded in bytes. The parsed size of an event is reserved on
/// its socket's budget before it is parsed and held until its handler returns; an event that
/// does not fit closes the connection as an inbound overflow without being parsed. A long
/// string costs about its length, so ordinary large events still pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inbound_events_are_bounded_in_bytes() {
    let options = Options {
        max_inbound_bytes: 4 << 20,
        ..Options::default()
    };
    let s = setup(options, NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/p", &ok()).await.unwrap();
    let io = s.server.io.clone();
    // The CONNECT data (`auth`, kept by the handshake) stays charged while the socket lives.
    let joined = io.stats().inbound_bytes;
    assert!(joined > 0);
    // A 900 kB string: about 1.8 MB reserved, inside the 4 MiB budget.
    let text = "x".repeat(900_000);
    client.send(&format!("42/p,1[\"echo\",\"{text}\"]")).await;
    let answer = client
        .until(|t| t.starts_with("43/p,1"), 5 * SECOND)
        .await
        .unwrap();
    assert_eq!(answer.len(), "43/p,1[\"\"]".len() + text.len());
    eventually("the event's memory came back", || {
        io.stats().inbound_bytes == joined
    })
    .await;
    // While a handler holds an event, its memory stays reserved.
    client.send("42/p,[\"sleep\",1500]").await;
    eventually("the event is held", || io.stats().inbound_bytes > joined).await;
    // 300 kB of zeros parse to far more than their text: refused before parsing.
    let zeros = format!("[\"echo\",[{}0]]", "0,".repeat(150_000));
    client.send(&format!("42/p,{zeros}")).await;
    assert!(client.closed_within(3 * SECOND).await);
    let seen = Arc::clone(&s.seen);
    eventually("the socket left", || {
        !seen.disconnects.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(
        s.seen.disconnects.lock().unwrap()[0],
        ("/p".to_owned(), DisconnectReason::InboundOverflow)
    );
    eventually("everything was given back", || {
        io.stats().inbound_bytes == 0
    })
    .await;
    s.server.stop().await;
}

/// Finding 2: the server-wide inbound budget is shared by every client.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_server_wide_inbound_budget_is_shared() {
    let options = Options {
        max_inbound_total: 1 << 20,
        ..Options::default()
    };
    let s = setup(options, NamespaceOptions::default()).await;
    let mut a = Ws::open(s.server.addr).await;
    a.join("/p", &ok()).await.unwrap();
    let mut b = Ws::open(s.server.addr).await;
    b.join("/p", &ok()).await.unwrap();
    // `a` holds about 800 kB in a sleeping handler.
    let text = "y".repeat(400_000);
    a.send(&format!("42/p,[\"sleep\",3000,\"{text}\"]")).await;
    let io = s.server.io.clone();
    eventually("a's event is held", || io.stats().inbound_bytes > 700_000).await;
    // `b`'s 400 kB event does not fit in what is left.
    b.send(&format!("42/p,[\"echo\",\"{text}\"]")).await;
    assert!(b.closed_within(3 * SECOND).await);
    assert!(!a.closed_within(Duration::from_millis(200)).await);
    s.server.stop().await;
}

// ----- finding 3: each socket owns its handlers --------------------------------------------

type Shared = Arc<Mutex<Vec<String>>>;
type Handles = Arc<Mutex<Vec<Socket<Mutex<Vec<String>>>>>>;

/// Records `what` in `log` when dropped (a handler future cancelled or ended).
struct OnDrop(Shared, &'static str);

impl Drop for OnDrop {
    fn drop(&mut self) {
        self.0.lock().unwrap().push(self.1.to_owned());
    }
}

/// `/z`: full recovery; the socket's data is a list of writes; handlers that hang, write late,
/// and a slow `on_disconnect`.
struct Fenced {
    log: Shared,
    handles: Handles,
}

impl Namespace for Fenced {
    type Data = Mutex<Vec<String>>;

    async fn check(&self, _handshake: &Handshake, _nsp: &str) -> Result<Self::Data, ConnectError> {
        Ok(Mutex::new(Vec::new()))
    }

    async fn on_connect(&self, socket: Socket<Self::Data>) {
        self.handles.lock().unwrap().push(socket.clone());
        if socket.recovered() {
            let seen = socket.data().lock().unwrap().clone();
            self.log
                .lock()
                .unwrap()
                .push(format!("recovered saw {seen:?}"));
            return;
        }
        let _ = socket.emit("hello", &[]);
        if socket.handshake().auth().contains_key("hang") {
            let _guard = OnDrop(Arc::clone(&self.log), "connect dropped");
            std::future::pending::<()>().await;
        }
    }

    async fn on_event(&self, socket: Socket<Self::Data>, mut event: Event) {
        match event.name.as_str() {
            "slow-write" => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                socket.data().lock().unwrap().push("old event".to_owned());
            }
            "hang" => {
                let _guard = OnDrop(Arc::clone(&self.log), "event dropped");
                std::future::pending::<()>().await;
            }
            "ping" => {
                if let Some(ack) = event.take_ack() {
                    let _ = ack.send(&[json!("pong")]);
                }
            }
            _ => {}
        }
    }

    async fn on_disconnect(&self, socket: Socket<Self::Data>, _reason: DisconnectReason) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        socket
            .data()
            .lock()
            .unwrap()
            .push("disconnect done".to_owned());
        self.log.lock().unwrap().push("disconnect".to_owned());
    }
}

struct FencedSetup {
    server: TestServer,
    log: Shared,
    handles: Handles,
    telemetry: Arc<Counting>,
}

async fn fenced(options: NamespaceOptions) -> FencedSetup {
    let log: Shared = Arc::default();
    let handles: Handles = Arc::default();
    let telemetry = Arc::new(Counting::default());
    let runtime = Runtime {
        telemetry: Arc::clone(&telemetry) as Arc<dyn Telemetry>,
        ..Runtime::default()
    };
    let (l, h) = (Arc::clone(&log), Arc::clone(&handles));
    let server = TestServer::start_with(Options::default(), runtime, move |builder| {
        builder
            .namespace("/z", options, Fenced { log: l, handles: h })
            .unwrap();
    })
    .await;
    FencedSetup {
        server,
        log,
        handles,
        telemetry,
    }
}

fn logged(log: &Shared, what: &str) -> bool {
    log.lock().unwrap().iter().any(|entry| entry == what)
}

/// Finding 3: a socket that leaves while its `on_connect` never returns has it cancelled, and
/// `on_disconnect` still runs (before, both stayed: the task lived until shutdown).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_socket_that_leaves_cancels_its_running_handlers() {
    let s = fenced(NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    client.join("/z", &json!({"hang": true})).await.unwrap();
    let log = Arc::clone(&s.log);
    client.close().await;
    eventually("on_connect cancelled, on_disconnect run", || {
        logged(&log, "connect dropped") && logged(&log, "disconnect")
    })
    .await;
    // An event handler too.
    let mut client = Ws::open(s.server.addr).await;
    client.join("/z", &ok()).await.unwrap();
    client.send("42/z,[\"hang\"]").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!logged(&log, "event dropped"));
    client.close().await;
    eventually("on_event cancelled", || logged(&log, "event dropped")).await;
    s.server.stop().await;
}

/// Finding 3: every handler kind has a deadline; an event handler past it is dropped and the
/// socket carries on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handler_past_its_deadline_is_dropped() {
    for dispatch in [Dispatch::Sequential, Dispatch::Concurrent(4)] {
        let options = NamespaceOptions {
            dispatch,
            deadlines: Some(dima_socketio::HandlerDeadlines {
                event: Duration::from_millis(200),
                ..dima_socketio::HandlerDeadlines::default()
            }),
            ..NamespaceOptions::default()
        };
        let s = fenced(options).await;
        let mut client = Ws::open(s.server.addr).await;
        client.join("/z", &ok()).await.unwrap();
        client.send("42/z,[\"hang\"]").await;
        let log = Arc::clone(&s.log);
        eventually("the event handler timed out", || {
            logged(&log, "event dropped")
        })
        .await;
        assert_eq!(s.telemetry.get("timeout:Event"), 1);
        client.send("42/z,5[\"ping\"]").await;
        assert_eq!(
            client
                .until(|t| t.starts_with("43/z,5"), 3 * SECOND)
                .await
                .as_deref(),
            Some("43/z,5[\"pong\"]")
        );
        client.close().await;
        s.server.stop().await;
    }
}

/// Finding 3: work of a socket that left cannot touch what a recovered socket now holds. Its
/// running event handler is cancelled when it leaves (the late write never happens); the
/// recovered socket starts only after the old `on_disconnect` has finished; and an emit
/// through a handle of the old socket after the recovery is not stored for the new one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn old_work_cannot_touch_a_recovered_socket() {
    let s = fenced(NamespaceOptions::default()).await;
    let mut client = Ws::open(s.server.addr).await;
    let connect = client.join("/z", &ok()).await.unwrap();
    let hello = client
        .until(|t| event(t, "/z").is_some(), 3 * SECOND)
        .await
        .unwrap();
    let offset = event(&hello, "/z")
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let pid = connect["pid"].as_str().unwrap().to_owned();
    // The write is 400 ms away when the connection drops.
    client.send("42/z,[\"slow-write\"]").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    client.drop_connection();
    let io = s.server.io.clone();
    eventually("the session is kept", || io.stats().sessions == 1).await;
    let mut back = Ws::open(s.server.addr).await;
    let again = back
        .join("/z", &json!({"pid": pid, "offset": offset}))
        .await
        .unwrap();
    assert_eq!(again["pid"].as_str(), Some(pid.as_str()));
    let log = Arc::clone(&s.log);
    eventually("the recovered socket connected", || {
        log.lock()
            .unwrap()
            .iter()
            .any(|e| e.starts_with("recovered saw"))
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let entries = s.log.lock().unwrap().clone();
    assert!(
        entries.contains(&"recovered saw [\"disconnect done\"]".to_owned()),
        "{entries:?}"
    );
    let handles = s.handles.lock().unwrap().clone();
    assert_eq!(handles.len(), 2);
    assert_eq!(
        *handles[1].data().lock().unwrap(),
        ["disconnect done".to_owned()]
    );
    // The old handle: disconnected, and nothing is stored on behalf of the new socket.
    let stored = io.stats().stored_packets;
    assert_eq!(
        handles[0].emit("stale", &[]),
        Err(dima_socketio::SendError::Disconnected)
    );
    assert_eq!(io.stats().stored_packets, stored);
    // While the new one is connected, its own emits are stored as usual.
    assert_eq!(handles[1].emit("fresh", &[]), Ok(()));
    assert_eq!(io.stats().stored_packets, stored + 1);
    back.close().await;
    s.server.stop().await;
}
