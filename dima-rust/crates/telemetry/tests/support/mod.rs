//! Shared helpers: the local Dragonfly from `DIMA_TEST_DRAGONFLY` (logical databases 10 to 15),
//! unique key names per test, clean-up, and stand-ins for an unreachable or a hung server.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_core::ManualClock;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_telemetry::{ConsoleTarget, Level, Telemetry, TelemetryConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Settings for logical database `db`, or `None` (with a message) when the store is not set.
pub fn config(db: u8) -> Option<DragonflyConfig> {
    assert!(
        (10..=15).contains(&db),
        "tests use logical databases 10 to 15 only"
    );
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        eprintln!("skipped: DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
        return None;
    };
    let (host, port) = address.rsplit_once(':')?;
    Some(DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{db}")),
        "dima-telemetry-test",
    ))
}

/// A direct connection for assertions.
pub async fn connect(config: &DragonflyConfig) -> Dragonfly {
    Dragonfly::connect(config.clone(), Hooks::default())
        .await
        .expect("connect to the local Dragonfly")
}

/// A name no other test run uses (letters, digits and `-` only).
pub fn unique(name: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() % 1_000_000_000_000)
        .unwrap_or_default();
    format!(
        "{name}-{nanos}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Every key matching `pattern` (SCAN), then deleted.
pub async fn keys_and_cleanup(dragonfly: &Dragonfly, pattern: &str) -> Vec<String> {
    let mut scan = dragonfly.scan(pattern, Some(1000));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await.expect("scan") {
        keys.extend(
            page.into_iter()
                .map(|key| String::from_utf8(key).expect("utf-8 key")),
        );
    }
    for key in &keys {
        let _: i64 = dragonfly
            .query(redis::cmd("DEL").arg(key))
            .await
            .expect("del");
    }
    keys
}

/// A configuration writing console lines to memory, with the given store.
pub fn memory_config(
    service: &str,
    dragonfly: Option<DragonflyConfig>,
) -> (TelemetryConfig, Arc<Mutex<Vec<u8>>>) {
    let console = Arc::new(Mutex::new(Vec::new()));
    let mut config = TelemetryConfig::new(service, "index");
    config.export = dragonfly.is_some();
    config.dragonfly = dragonfly;
    config.console = ConsoleTarget::Memory(console.clone());
    config.min_level = Level::Trace;
    (config, console)
}

/// An exporting handle with no store: everything stays in memory for `take_snapshot`.
pub fn in_memory(sample_rate: f64) -> Telemetry {
    let mut config = TelemetryConfig::new("test", "index");
    // A store that is never contacted (nothing is flushed in these tests).
    config.dragonfly = Some(DragonflyConfig::from_env_values(
        Some("127.0.0.1"),
        Some("1"),
        "unused",
    ));
    config.export = true;
    config.sample_rate = sample_rate;
    config.console = ConsoleTarget::Off;
    Telemetry::new(config).expect("telemetry")
}

/// Console lines as JSON.
pub fn lines(buffer: &Arc<Mutex<Vec<u8>>>) -> Vec<serde_json::Value> {
    let bytes = buffer.lock().unwrap().clone();
    String::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a JSON line"))
        .collect()
}

/// A port where nothing listens.
pub fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// A server that accepts connections and never answers (a hung Dragonfly).
pub async fn black_hole() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    (port, task)
}

/// A store configuration pointing at a local port.
pub fn local_store(port: u16) -> DragonflyConfig {
    DragonflyConfig::from_env_values(Some("127.0.0.1"), Some(&port.to_string()), "hung")
}

/// A manual clock at the current time.
pub fn clock_now() -> ManualClock {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    ManualClock::new(i64::try_from(now).unwrap())
}
