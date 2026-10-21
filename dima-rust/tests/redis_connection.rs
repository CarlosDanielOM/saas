#![cfg(feature = "redis")]

//! Opt-in integration coverage for
//! [`dima_rust::utils::redis::get_redis_client`].
//!
//! Run one fresh process per expectation, against a disposable fixture only:
//!
//! ```sh
//! DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379 \
//! REDIS_TEST_EXPECT=success REDIS_TEST_KEY_PREFIX='dima-rust-fixture' \
//!   cargo test --locked --test redis_connection -- --ignored --exact redis_client_fixture
//! ```
//!
//! Supported `REDIS_TEST_EXPECT` values:
//!
//! - `config`: `DRAGONFLY_HOST`/`DRAGONFLY_PORT` must be missing, blank, or
//!   malformed. Optionally set `REDIS_TEST_CONFIG_CANARY` to a value that must
//!   not appear in the rendered error.
//! - `success`: a reachable fixture. The test joins two first calls, proves one
//!   shared socket with `CLIENT ID`, and exercises `PING`, `SET`/`GET` with a
//!   TTL, and `EVAL` on task-owned keys that it deletes afterwards.
//! - `retry`: a fixture that is initially disabled and becomes reachable later.
//!   The first initialization must fail; the test prints
//!   `INITIAL_FAILURE_OBSERVED`, then retries until the external runner enables
//!   the same endpoint and verifies the cached manager.
//! - `reconnect`: a reachable fixture whose existing TCP connection will be
//!   cut. The test prints `CONNECTION_READY`, optionally waits for the file
//!   named by `REDIS_TEST_RECONNECT_GATE`, then pings the clone taken before the
//!   cut until the endpoint is restored. The external runner cuts the socket,
//!   may stop and restart a proxy, and creates the gate file afterwards.
//!
//! `success`, `retry`, and `reconnect` require `REDIS_TEST_KEY_PREFIX` and only
//! touch keys derived from it. Those keys expire even if cleanup is interrupted.
//!
//! The test reads the process environment instead of mutating it, so it avoids
//! Rust 2024's unsafe environment writes. It is ignored unless explicitly
//! requested; there is no default live access.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use dima_rust::utils::redis::get_redis_client;
use redis::{ErrorKind, RedisResult, aio::ConnectionManager};

const EXPECT_ENV: &str = "REDIS_TEST_EXPECT";
const KEY_PREFIX_ENV: &str = "REDIS_TEST_KEY_PREFIX";
const KEY_TTL_SECS: u64 = 60;
const TEST_TIMEOUT: Duration = Duration::from_secs(90);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an explicitly provided isolated Dragonfly/Redis fixture; set REDIS_TEST_EXPECT and DRAGONFLY_HOST/DRAGONFLY_PORT"]
async fn redis_client_fixture() {
    let mode = std::env::var(EXPECT_ENV)
        .expect("REDIS_TEST_EXPECT must be set to config|success|retry|reconnect");

    let scenario = async {
        match mode.as_str() {
            "config" => expect_config_error().await,
            "success" => expect_success().await,
            "retry" => expect_retry().await,
            "reconnect" => expect_reconnect().await,
            other => panic!(
                "unsupported REDIS_TEST_EXPECT value {other:?}; expected \
                 config|success|retry|reconnect"
            ),
        }
    };

    tokio::time::timeout(TEST_TIMEOUT, scenario)
        .await
        .expect("the fixture exceeded its bounded test timeout");
}

async fn expect_config_error() {
    let error = get_redis_client()
        .await
        .expect_err("initialization must fail with unusable configuration");
    let rendered = error.to_string();

    assert_eq!(error.kind(), ErrorKind::InvalidClientConfig);
    assert!(
        rendered.contains("DRAGONFLY_HOST") || rendered.contains("DRAGONFLY_PORT"),
        "unexpected error: {rendered}"
    );
    assert!(
        !rendered.contains("://"),
        "configuration errors must not echo a connection string: {rendered}"
    );

    if let Ok(canary) = std::env::var("REDIS_TEST_CONFIG_CANARY") {
        let canary = canary.trim();
        if !canary.is_empty() {
            assert!(
                !rendered.contains(canary),
                "configuration errors must not echo the raw input: {rendered}"
            );
        }
    }
}

async fn expect_success() {
    let prefix = key_prefix();
    let string_key = format!("{prefix}:success");
    let lua_key = format!("{prefix}:success:lua");
    let value = "dima-rust-fixture-value";

    // First callers race on an empty cell; both must succeed with handles that
    // share one multiplexed socket.
    let (first, second) = tokio::join!(get_redis_client(), get_redis_client());
    let mut first = first.expect("first initialization must succeed");
    let mut second = second.expect("concurrent initialization must succeed");

    assert_eq!(ping(&mut first).await, "PONG");
    let socket = client_id(&mut first).await;
    assert_eq!(
        client_id(&mut second).await,
        socket,
        "concurrent callers must receive handles sharing one socket"
    );

    // A later call must reuse the cached manager rather than creating another.
    let mut third = get_redis_client()
        .await
        .expect("cached manager must be returned");
    assert_eq!(
        client_id(&mut third).await,
        socket,
        "cached manager must be reused across calls"
    );

    let written: redis::Value = redis::cmd("SET")
        .arg(&string_key)
        .arg(value)
        .arg("EX")
        .arg(KEY_TTL_SECS)
        .query_async(&mut first)
        .await
        .expect("fixture must accept SET");
    assert_eq!(written, redis::Value::Okay);

    let stored: String = redis::cmd("GET")
        .arg(&string_key)
        .query_async(&mut second)
        .await
        .expect("the same socket must serve GET");
    assert_eq!(stored, value);

    let ttl: i64 = redis::cmd("TTL")
        .arg(&string_key)
        .query_async(&mut first)
        .await
        .expect("fixture must report TTL");
    assert!(
        (1..=KEY_TTL_SECS as i64).contains(&ttl),
        "unexpected TTL: {ttl}"
    );

    let lua = concat!(
        "local value = redis.call('INCR', KEYS[1]); ",
        "redis.call('EXPIRE', KEYS[1], ARGV[1]); return value"
    );
    let incremented: i64 = redis::cmd("EVAL")
        .arg(lua)
        .arg(1)
        .arg(&lua_key)
        .arg(KEY_TTL_SECS)
        .query_async(&mut first)
        .await
        .expect("fixture must accept EVAL");
    assert_eq!(incremented, 1);

    let removed: i64 = remove_keys(&mut first, &[&string_key, &lua_key])
        .await
        .expect("task-owned keys must be deleted");
    assert_eq!(removed, 2, "both task-owned keys must be deleted");
}

async fn expect_retry() {
    let error = get_redis_client()
        .await
        .expect_err("the fixture endpoint must initially be disabled");
    assert_ne!(
        error.kind(),
        ErrorKind::InvalidClientConfig,
        "retry mode requires valid configuration"
    );

    // The external fixture runner enables the same endpoint after this marker.
    // Configuration stays unchanged throughout this process.
    println!("INITIAL_FAILURE_OBSERVED");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut attempts = 0_u32;
    let mut recovered = loop {
        attempts += 1;
        match get_redis_client().await {
            Ok(manager) => break manager,
            Err(error) if Instant::now() >= deadline => {
                panic!("initialization did not recover after {attempts} attempts: {error}");
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    };

    assert_eq!(ping(&mut recovered).await, "PONG");
    let socket = client_id(&mut recovered).await;
    let mut cached = get_redis_client()
        .await
        .expect("the recovered manager must be cached");
    assert_eq!(
        client_id(&mut cached).await,
        socket,
        "a later call must reuse the recovered manager"
    );
}

async fn expect_reconnect() {
    let prefix = key_prefix();
    let key = format!("{prefix}:reconnect");
    let mut handle = get_redis_client()
        .await
        .expect("fixture must be reachable before the cut");
    let mut preexisting = handle.clone();

    assert_eq!(ping(&mut handle).await, "PONG");
    println!("CONNECTION_READY");

    // Optional coordination: the external runner cuts the socket, restores the
    // endpoint, and then creates this file. Without it, the retry loop below
    // still tolerates a short outage.
    if let Ok(gate) = std::env::var("REDIS_TEST_RECONNECT_GATE") {
        wait_for_gate(Path::new(&gate)).await;
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut attempts = 0_u32;
    loop {
        attempts += 1;
        match try_ping(&mut preexisting).await {
            Ok(pong) => {
                assert_eq!(pong, "PONG");
                break;
            }
            Err(error) if Instant::now() >= deadline || attempts >= 120 => {
                panic!("the pre-cut clone did not recover after {attempts} attempts: {error}");
            }
            // A command that fails during the disconnect is not replayed; the
            // manager reconnects in the background, so a bounded retry is safe.
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }

    let socket = client_id(&mut preexisting).await;
    let mut cached = get_redis_client()
        .await
        .expect("the reconnected manager must stay cached");
    assert_eq!(
        client_id(&mut cached).await,
        socket,
        "the cached handle must share the reconnected socket"
    );

    // Keep the recovered clone usable for one explicit task-owned write.
    let written: redis::Value = redis::cmd("SET")
        .arg(&key)
        .arg("reconnected")
        .arg("EX")
        .arg(KEY_TTL_SECS)
        .query_async(&mut preexisting)
        .await
        .expect("the recovered clone must accept SET");
    assert_eq!(written, redis::Value::Okay);
    assert_eq!(
        remove_keys(&mut preexisting, &[&key])
            .await
            .expect("task-owned key must be deleted"),
        1
    );
}

fn key_prefix() -> String {
    let prefix = std::env::var(KEY_PREFIX_ENV).expect(
        "REDIS_TEST_KEY_PREFIX must name an explicit disposable key prefix for this fixture",
    );
    assert!(
        !prefix.trim().is_empty(),
        "REDIS_TEST_KEY_PREFIX must not be blank"
    );
    prefix
}

async fn ping(manager: &mut ConnectionManager) -> String {
    try_ping(manager).await.expect("fixture must answer PING")
}

async fn try_ping(manager: &mut ConnectionManager) -> RedisResult<String> {
    redis::cmd("PING").query_async(manager).await
}

async fn client_id(manager: &mut ConnectionManager) -> u64 {
    redis::cmd("CLIENT")
        .arg("ID")
        .query_async(manager)
        .await
        .expect("fixture must report CLIENT ID")
}

async fn remove_keys(manager: &mut ConnectionManager, keys: &[&str]) -> RedisResult<i64> {
    let mut command = redis::cmd("DEL");
    for key in keys {
        command.arg(key);
    }
    command.query_async(manager).await
}

async fn wait_for_gate(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !path.exists() {
        if Instant::now() >= deadline {
            panic!("reconnect gate {} was not created in time", path.display());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
