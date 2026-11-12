//! Behaviour of this server that the reference does not have (its bounds and the checks it
//! adds), as the real JavaScript clients (4.8.3 and 4.7.5, polling and WebSocket) see it. The
//! cases are in `tests/js/rust-cases.mjs`; the namespaces are those of `tests/support/mod.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_socketio::{Options, RecoveryLimits};
use serde_json::Value;
use support::TestServer;

/// Runs the JavaScript cases against `server`; `None` when Node is missing (and allowed to be).
async fn run_cases(server: &TestServer) -> Option<serde_json::Map<String, Value>> {
    let node = support::node()?;
    let results = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("socketio-rust-cases-{}.json", std::process::id()));
    let output = tokio::process::Command::new(node)
        .arg("rust-cases.mjs")
        .arg(server.port().to_string())
        .arg(&results)
        .current_dir(support::js_dir())
        .kill_on_drop(true)
        .output();
    // Generous: it bounds a hang, the cases take a few seconds.
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), output)
        .await
        .expect("the cases finish within 3 minutes")
        .expect("the cases ran");
    assert!(
        output.status.success(),
        "cases failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value =
        serde_json::from_slice(&std::fs::read(&results).expect("results written")).unwrap();
    let _ = std::fs::remove_file(&results);
    observed.as_object().cloned()
}

/// The entries of `label` with this kind.
fn entries<'a>(case: &'a Value, label: &str, kind: &str) -> Vec<&'a Value> {
    case[label]
        .as_array()
        .map(|log| log.iter().filter(|e| e[0] == kind).collect())
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_javascript_clients_see_the_recovery_bounds() {
    let options = Options {
        recovery: RecoveryLimits {
            bytes_per_namespace: 4096,
            ..RecoveryLimits::default()
        },
        ..Options::default()
    };
    let server = TestServer::start(options).await;
    let Some(results) = run_cases(&server).await else {
        return;
    };
    server.stop().await;
    let mut checked = 0;
    for (name, case) in &results {
        let connects = entries(case, "a", "connect");
        let pushed: Vec<&Value> = entries(case, "a", "event")
            .into_iter()
            .filter(|e| e[1] == "pushed")
            .collect();
        if name.ends_with("a small missed event is replayed") {
            assert_eq!(connects.len(), 2, "{name}: {case}");
            assert_eq!(connects[1][1]["recovered"], true, "{name}: {case}");
            assert_eq!(pushed.len(), 1, "{name}: {case}");
            assert_eq!(pushed[0][2], "small", "{name}: {case}");
        } else if name.ends_with("an event too large to store breaks recovery") {
            // Finding 8: the client connects fresh instead of recovering without the event
            // (the reference, which stores it, recovers and replays it).
            assert_eq!(connects.len(), 2, "{name}: {case}");
            assert_eq!(connects[1][1]["recovered"], false, "{name}: {case}");
            assert!(pushed.is_empty(), "{name}: {case}");
            let welcomes = entries(case, "a", "event")
                .into_iter()
                .filter(|e| e[1] == "welcome")
                .count();
            assert_eq!(welcomes, 2, "{name}: {case}");
        } else if name.ends_with("an event too large to store is still delivered live") {
            assert_eq!(pushed.len(), 1, "{name}: {case}");
            assert_eq!(pushed[0][2], 5000, "{name}: {case}");
        } else {
            continue;
        }
        checked += 1;
    }
    assert_eq!(
        checked, 12,
        "every case ran for 2 clients over 2 transports"
    );
}
