//! Shared helpers: the local Dragonfly from `DIMA_TEST_DRAGONFLY` (logical databases 12 and 13,
//! shared with other agents' tests), unique key names per test, clean-up that also runs when an
//! assertion fails, and stand-ins for an unreachable or a hung server.
//!
//! Without `DIMA_TEST_DRAGONFLY` a test that needs the store is skipped with a message, unless
//! `DIMA_TEST_REQUIRE_STORES=1` (set by `tools/test-env`): then it fails.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_core::ManualClock;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_telemetry::{ConsoleTarget, Level, Telemetry, TelemetryConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether a missing store fails the test instead of skipping it.
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1")
}

/// Settings for logical database `db`, or `None` (with a message) when the store is not set and
/// not required.
pub fn config(db: u8) -> Option<DragonflyConfig> {
    config_from(
        std::env::var("DIMA_TEST_DRAGONFLY").ok().as_deref(),
        stores_required(),
        db,
    )
}

/// [`config`] from the variable's value and the requirement.
pub fn config_from(address: Option<&str>, required: bool, db: u8) -> Option<DragonflyConfig> {
    assert!(
        (12..=13).contains(&db),
        "tests use logical databases 12 and 13 only"
    );
    let Some(address) = address else {
        assert!(
            !required,
            "DIMA_TEST_REQUIRE_STORES=1 but DIMA_TEST_DRAGONFLY is not set"
        );
        eprintln!("skipped: DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
        return None;
    };
    let Some((host, port)) = address.rsplit_once(':') else {
        panic!("DIMA_TEST_DRAGONFLY is not host:port: {address}");
    };
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

/// Runs `body`, then deletes every key matching `patterns` in `store`, also when `body` panicked
/// (a failed assertion); the panic is then resumed.
pub async fn with_cleanup<F: std::future::Future<Output = ()>>(
    store: &DragonflyConfig,
    patterns: &[String],
    body: F,
) {
    use futures_util::FutureExt as _;
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let dragonfly = connect(store).await;
    for pattern in patterns {
        keys_and_cleanup(&dragonfly, pattern).await;
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Points the inbox and overflow keys at a unique prefix and returns the pattern of both.
pub fn unique_inbox(config: &mut TelemetryConfig, name: &str) -> String {
    let prefix = unique(name);
    config.inbox_key = format!("{prefix}:inbox");
    config.overflow_key = format!("{prefix}:overflow");
    format!("{prefix}:*")
}

/// A configuration writing console lines to memory, with the given store. With a store, the
/// inbox and overflow keys are unique to this configuration (see [`inbox_pattern`]), never the
/// production names.
pub fn memory_config(
    service: &str,
    dragonfly: Option<DragonflyConfig>,
) -> (TelemetryConfig, Arc<Mutex<Vec<u8>>>) {
    let console = Arc::new(Mutex::new(Vec::new()));
    let mut config = TelemetryConfig::new(service, "index");
    if dragonfly.is_some() {
        unique_inbox(&mut config, "dima-test-telemetry-inbox");
    }
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

/// The pattern of a configuration's inbox and overflow keys.
pub fn inbox_pattern(config: &TelemetryConfig) -> String {
    let prefix = config
        .inbox_key
        .strip_suffix(":inbox")
        .expect("a test inbox key");
    format!("{prefix}:*")
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

/// `count` distinct metric names `<prefix><index>`, made once per process and prefix. Names are
/// `&'static str` in the API (fixed in the source); tests that need many build them here.
pub fn names(prefix: &'static str, count: usize) -> &'static [&'static str] {
    static MADE: Mutex<Vec<(&'static str, &'static [&'static str])>> = Mutex::new(Vec::new());
    let mut made = MADE.lock().unwrap();
    if let Some((_, names)) = made
        .iter()
        .find(|(known, names)| *known == prefix && names.len() >= count)
    {
        return &names[..count];
    }
    let names: Vec<&'static str> = (0..count)
        .map(|index| &*Box::leak(format!("{prefix}{index}").into_boxed_str()))
        .collect();
    let names: &'static [&'static str] = Box::leak(names.into_boxed_slice());
    made.push((prefix, names));
    names
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
