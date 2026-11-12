//! H5 of the re-check (2026-11-12): a retained session's size is what it really keeps. A JSON
//! map in the socket's data that was grown, then cleared (or cut down), keeps its allocation:
//! `serde_json::Map` exposes no capacity, so it was measured by its length, as nearly nothing,
//! while megabytes stayed allocated behind the session. Such maps are now compacted when the
//! session is kept, before it is measured.
//!
//! What a value really keeps cannot be read without a counting allocator, which needs `unsafe`
//! (forbidden here), so this test reads the process's resident memory instead, in a test binary
//! of its own (no other test allocates meanwhile). The grown map's entry table is far larger
//! than glibc's largest mapping threshold (32 MiB on 64-bit), so it is always a mapping of its
//! own, and freeing it gives its pages back at once: the drop in resident memory when the
//! session is kept is the table being freed by the compaction.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use dima_socketio::{
    ConnectError, Event, Handshake, Namespace, NamespaceOptions, Options, RetainedSize, Runtime,
    Socket,
};
use serde_json::{Map, Value, json};
use support::TestServer;
use support::raw::{Next, Ws};

const ENTRIES: usize = 400_000;

/// The socket data of `/r`: a JSON map the client's events grow and cut down, measured as a
/// feature package would measure it.
#[derive(Default)]
struct Bag {
    map: Mutex<Map<String, Value>>,
}

impl RetainedSize for Bag {
    fn retained_bytes(&self) -> usize {
        self.map.retained_bytes()
    }
}

#[derive(Default)]
struct Grow {
    last: Mutex<Option<Socket<Bag>>>,
}

impl Namespace for Grow {
    type Data = Bag;

    async fn check(&self, _handshake: &Handshake, _namespace: &str) -> Result<Bag, ConnectError> {
        Ok(Bag::default())
    }

    async fn on_connect(&self, socket: Socket<Bag>) {
        *self.last.lock().unwrap() = Some(socket);
    }

    async fn on_event(&self, socket: Socket<Bag>, mut event: Event) {
        let n = event.args.first().and_then(Value::as_u64).unwrap_or(0) as usize;
        {
            let mut map = socket.data().map.lock().unwrap();
            match event.name.as_str() {
                "grow" => {
                    for i in 0..n {
                        map.insert(format!("k{i}"), Value::Null);
                    }
                }
                "keep" => {
                    let mut seen = 0;
                    map.retain(|_, _| {
                        seen += 1;
                        seen <= n
                    });
                }
                _ => {}
            }
        }
        if let Some(ack) = event.take_ack() {
            let _ = ack.send(&[]);
        }
    }
}

/// Resident memory of this process, in bytes.
fn resident() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = status.lines().find(|l| l.starts_with("VmRSS:")).unwrap();
    let kb: usize = line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap();
    kb * 1024
}

async fn call(client: &mut Ws, id: u32, name: &str, n: usize) {
    client.send(&format!("42/r,{id}[\"{name}\",{n}]")).await;
    let ack = format!("43/r,{id}");
    loop {
        match client.next(Duration::from_secs(60)).await {
            Next::Text(text) if text.starts_with(&ack) => return,
            Next::Text(_) => {}
            other => panic!("no acknowledgement for {name}: {other:?}"),
        }
    }
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_grown_and_cleared_map_is_compacted_when_its_session_is_kept() {
    let grow = Arc::new(Mutex::new(None::<dima_socketio::NamespaceRef<Grow>>));
    let declared = Arc::clone(&grow);
    let server = TestServer::start_with(Options::default(), Runtime::default(), move |builder| {
        let r = builder
            .namespace("/r", NamespaceOptions::default(), Grow::default())
            .unwrap();
        *declared.lock().unwrap() = Some(r);
    })
    .await;
    let grow = grow.lock().unwrap().take().unwrap();
    let io = server.io.clone();

    // Cleared (kept 0), then cut down to 50 entries: both keep the grown table until compacted.
    for (round, keep) in [(1_u32, 0_usize), (2, 50)] {
        let mut client = Ws::open(server.addr).await;
        client.join("/r", &json!({})).await.unwrap();
        call(&mut client, round * 10, "grow", ENTRIES).await;
        call(&mut client, round * 10 + 1, "keep", keep).await;
        let socket = grow.handler().last.lock().unwrap().take().unwrap();
        let before = resident();
        // A network failure: the session is kept, and measured.
        client.drop_connection();
        eventually("the session kept", || io.stats().sessions == round as usize).await;
        let after = resident();
        let freed = before.saturating_sub(after);
        assert!(
            freed >= 32 << 20,
            "round {round}: the grown table is still allocated ({before} -> {after} bytes resident)"
        );
        // What is kept is measured, and small; the entries the client kept are all there.
        let stats = io.stats();
        assert!(
            stats.session_bytes < (16 << 10) * round as usize,
            "{stats:?}"
        );
        let map = socket.data().map.lock().unwrap();
        assert_eq!(map.len(), keep);
        assert!(
            map.keys()
                .enumerate()
                .all(|(i, key)| *key == format!("k{i}"))
        );
    }
    server.stop().await;
}
