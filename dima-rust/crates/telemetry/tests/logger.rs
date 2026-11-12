//! The logger: console lines, cache entries in the local Dragonfly (logical database 12), the
//! telemetry rows of warn and above, redaction on every destination, bounded queues, and an
//! unreachable or hung store that the caller never notices.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_telemetry::{Level, LogOptions, Telemetry};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn console_lines_are_json_filtered_and_redacted() {
    let (mut config, console) = support::memory_config("api", None);
    config.min_level = Level::Info;
    let telemetry = Telemetry::new(config).unwrap();
    let running = telemetry.start();
    assert!(!telemetry.enabled(Level::Debug));
    telemetry.debug(&json!({"hidden": true}), LogOptions::console());
    telemetry.info(
        &json!({"function": "boot", "access_token": "abc", "text": "Bearer abcdefghijklmnop 😀 שלום"}),
        LogOptions::console().channel("123"),
    );
    telemetry.error(&"plain text", LogOptions::new());
    running.shutdown(Duration::from_secs(2)).await;
    let lines = support::lines(&console);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["level"], "info");
    assert_eq!(lines[0]["platform"], "twitch");
    assert_eq!(lines[0]["channelId"], "123");
    assert!(lines[0]["time"].as_str().unwrap().ends_with('Z'));
    assert_eq!(lines[0]["data"]["access_token"], "[REDACTED]");
    assert_eq!(lines[0]["data"]["text"], "[REDACTED] 😀 שלום");
    assert_eq!(lines[1]["data"], "plain text");
    assert!(lines[1].get("channelId").is_none());
    // Without a store the cache half of `both` is lost, and counted.
    assert_eq!(telemetry.stats().cache_dropped, 1);
}

#[tokio::test]
async fn warn_and_above_become_metadata_rows() {
    let telemetry = support::in_memory(0.0);
    telemetry.info(&json!({"function": "a"}), LogOptions::console());
    telemetry.warn(
        &json!({"function": "fetch", "code": "E_TIMEOUT", "message": "private chat", "attempt": 2}),
        LogOptions::console().channel("42"),
    );
    telemetry.fatal(&json!("boom"), LogOptions::console());
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.logs.len(), 2);
    let row = &snapshot.logs[0];
    assert_eq!(
        (row.level, row.name.as_str(), row.channel.as_str()),
        ("warn", "fetch", "42")
    );
    assert_eq!(
        Value::Object(row.fields.clone()),
        json!({"code": "E_TIMEOUT", "function": "fetch", "attempt": 2})
    );
    assert_eq!(snapshot.logs[1].name, "application");
}

#[tokio::test]
async fn cache_entries_are_written_with_their_expiry_in_one_command() {
    let Some(store) = support::config(12) else {
        return;
    };
    let platform = support::unique("tlog");
    let (config, _console) = support::memory_config("api", Some(store.clone()));
    let telemetry = Telemetry::new(config).unwrap();
    let running = telemetry.start();
    let options = LogOptions::new().platform(&platform);
    telemetry.info(
        &json!({"step": "both", "secret": "hunter2"}),
        options.channel("777"),
    );
    telemetry.warn(
        &json!({"step": "cache"}),
        LogOptions::cache().platform(&platform),
    );
    telemetry.error(
        &json!({"step": "console"}),
        LogOptions::console().platform(&platform),
    );
    // Inside a trace the entry names it.
    let mut span = telemetry.span("command", "test");
    span.run(async {
        telemetry.info(
            &json!({"step": "traced"}),
            LogOptions::cache().platform(&platform),
        );
    })
    .await;
    let trace_id = span.ids().trace_id;
    span.end("ok");
    let report = running.shutdown(Duration::from_secs(3)).await;
    assert!(report.clean);
    assert_eq!(report.stats.cache_written, 3);

    let dragonfly = support::connect(&store).await;
    let pattern = format!("logger:{platform}:*");
    let mut scan = dragonfly.scan(&pattern, Some(1000));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await.unwrap() {
        keys.extend(page.into_iter().map(|key| String::from_utf8(key).unwrap()));
    }
    keys.sort();
    assert_eq!(keys.len(), 3, "{keys:?}");
    let mut seen = Vec::new();
    for key in &keys {
        let parts: Vec<&str> = key.split(':').collect();
        assert_eq!(parts.len(), 5, "{key}");
        let (channel, level, id) = (parts[2], parts[3], parts[4]);
        let (ms, suffix) = id.split_once('-').unwrap();
        assert!(ms.parse::<u64>().is_ok() && suffix.len() == 8, "{key}");
        let ttl: i64 = dragonfly.query(redis::cmd("TTL").arg(key)).await.unwrap();
        assert!((604_700..=604_800).contains(&ttl), "{key} ttl {ttl}");
        let raw = dragonfly.get_text(key).await.unwrap().unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let fields: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            &fields[..4],
            ["data", "timestamp", "level", "platform"],
            "{raw}"
        );
        assert_eq!(value["level"], level);
        assert_eq!(value["platform"], platform.as_str());
        assert!(value["timestamp"].as_str().unwrap().contains(", "));
        seen.push((channel.to_owned(), level.to_owned(), value));
    }
    let both = seen
        .iter()
        .find(|(_, _, v)| v["data"]["step"] == "both")
        .unwrap();
    assert_eq!(both.0, "777");
    assert_eq!(both.2["channelId"], "777");
    assert_eq!(both.2["data"]["secret"], "[REDACTED]");
    let cache = seen
        .iter()
        .find(|(_, _, v)| v["data"]["step"] == "cache")
        .unwrap();
    assert_eq!((cache.0.as_str(), cache.1.as_str()), ("global", "warn"));
    assert!(cache.2.get("channelId").is_none());
    let traced = seen
        .iter()
        .find(|(_, _, v)| v["data"]["step"] == "traced")
        .unwrap();
    assert_eq!(traced.2["traceId"], trace_id.hex().as_str());
    assert!(!seen.iter().any(|(_, _, v)| v["data"]["step"] == "console"));
    assert_eq!(
        support::keys_and_cleanup(&dragonfly, &pattern).await.len(),
        3
    );
}

#[tokio::test]
async fn full_queues_and_a_spent_budget_drop_and_count() {
    let (mut config, console) = support::memory_config("api", None);
    config.log_queue = 4;
    let telemetry = Telemetry::new(config).unwrap();
    // Not started yet: the console queue fills at 4.
    for index in 0..10 {
        telemetry.info(&json!({ "index": index }), LogOptions::console());
    }
    assert_eq!(telemetry.stats().console_dropped, 6);
    let running = telemetry.start();
    running.shutdown(Duration::from_secs(2)).await;
    assert_eq!(support::lines(&console).len(), 4);

    let (mut config, _console) = support::memory_config("api", None);
    config.log_budget = 4096;
    let telemetry = Telemetry::new(config).unwrap();
    telemetry.info(&"x".repeat(3000), LogOptions::console());
    telemetry.info(&"y".repeat(3000), LogOptions::console());
    assert_eq!(telemetry.stats().console_dropped, 1);
}

async fn caller_never_waits(store: dima_store::dragonfly::DragonflyConfig) {
    let (config, _console) = support::memory_config("api", Some(store));
    let telemetry = Telemetry::new(config).unwrap();
    let running = telemetry.start();
    let started = Instant::now();
    for index in 0..500 {
        telemetry.info(&json!({ "index": index }), LogOptions::cache());
        telemetry.count("command", "x");
    }
    let spent = started.elapsed();
    assert!(
        spent < Duration::from_millis(250),
        "500 calls took {spent:?}"
    );
    telemetry.flush().await;
    let shutdown = Instant::now();
    let report = running.shutdown(Duration::from_secs(4)).await;
    assert!(
        shutdown.elapsed() < Duration::from_secs(5),
        "{:?}",
        shutdown.elapsed()
    );
    assert_eq!(report.stats.cache_written, 0);
    assert_eq!(report.stats.cache_dropped, 500);
    assert!(report.stats.pipeline_dropped >= 500, "{:?}", report.stats);
}

#[tokio::test]
async fn an_unreachable_store_is_not_noticed() {
    caller_never_waits(support::local_store(support::closed_port())).await;
}

#[tokio::test]
async fn a_hung_store_is_not_noticed() {
    let (port, server) = support::black_hole().await;
    caller_never_waits(support::local_store(port)).await;
    server.abort();
}
