//! The differential test: the real JavaScript clients (socket.io-client 4.8.3 and 4.7.5, over
//! polling, WebSocket and polling upgraded to WebSocket) run the same cases against this server
//! as against the reference (`tests/js/reference-server.mjs`, the installed `socket.io` 4.8.3),
//! and must observe the same thing.
//!
//! The golden file `tests/golden/differential.json` is what the clients observed with the
//! reference; regenerate it with `node tests/js/golden.mjs`. The cases are in
//! `tests/js/client-cases.mjs`, the test namespaces in `tests/support/mod.rs` (mirroring the
//! reference script handler for handler).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use serde_json::Value;
use support::TestServer;

/// Cases expected to differ from the reference, with the reason. Each entry is a substring of
/// a case name (`<client version> <transport> <case>`) or an HTTP case path.
const EXCLUDED: &[(&str, &str)] = &[];

fn excluded(name: &str) -> bool {
    EXCLUDED.iter().any(|(pattern, _)| name.contains(pattern))
}

/// Every place where `observed` differs from `golden`, as `path: golden != observed`.
fn differences(path: &str, golden: &Value, observed: &Value, out: &mut Vec<String>) {
    match (golden, observed) {
        (Value::Object(g), Value::Object(o)) => {
            for (key, value) in g {
                let child = format!("{path} / {key}");
                match o.get(key) {
                    Some(other) => differences(&child, value, other, out),
                    None => out.push(format!("{child}: missing")),
                }
            }
            for key in o.keys().filter(|key| !g.contains_key(*key)) {
                out.push(format!("{path} / {key}: unexpected {}", o[key]));
            }
        }
        _ if golden != observed => out.push(format!(
            "{path}:\n    reference {golden}\n    observed  {observed}"
        )),
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn javascript_clients_observe_what_they_observe_with_the_reference() {
    let Some(node) = support::node() else { return };
    let server = TestServer::start(dima_socketio::Options::default()).await;
    let short = TestServer::start(support::short_options()).await;
    let results = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("socketio-differential-{}.json", std::process::id()));
    let output = tokio::process::Command::new(node)
        .arg("client-cases.mjs")
        .arg(server.port().to_string())
        .arg(short.port().to_string())
        .arg(&results)
        .current_dir(support::js_dir())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(240), output)
        .await
        .expect("client cases finish within 4 minutes")
        .expect("client cases ran");
    server.stop().await;
    short.stop().await;
    assert!(
        output.status.success(),
        "client cases failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value =
        serde_json::from_slice(&std::fs::read(&results).expect("client cases wrote their results"))
            .expect("client cases write JSON");
    let _ = std::fs::remove_file(&results);
    // Kept for a look at what the clients saw when the comparison fails.
    std::fs::write(
        results.with_extension("last.json"),
        serde_json::to_vec_pretty(&observed).unwrap_or_default(),
    )
    .ok();
    let golden: Value = serde_json::from_str(include_str!("golden/differential.json"))
        .expect("golden file is JSON");

    let mut failures = Vec::new();
    let mut compared = 0;
    for group in ["client", "http"] {
        let (Some(golden), Some(observed)) =
            (golden[group].as_object(), observed[group].as_object())
        else {
            panic!("{group} results missing");
        };
        for (name, expected) in golden {
            if excluded(name) {
                continue;
            }
            compared += 1;
            match observed.get(name) {
                Some(actual) => differences(name, expected, actual, &mut failures),
                None => failures.push(format!("{name}: not run")),
            }
        }
    }
    println!("{compared} cases compared with the reference");
    assert!(
        failures.is_empty(),
        "{} differences from the reference:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
