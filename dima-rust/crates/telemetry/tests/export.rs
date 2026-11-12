//! Metrics, spans and telemetry logs exported to the inbox of the local Dragonfly (logical
//! database 13, unique inbox keys), the reference's batch and overflow bounds, and failures that
//! cost data (counted) but never time.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_telemetry::aggregate::LATENCY_BOUNDS;
use dima_telemetry::{LogOptions, Telemetry, TelemetryConfig};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn exporting(store: dima_store::dragonfly::DragonflyConfig, inbox: &str) -> TelemetryConfig {
    let (mut config, _console) = support::memory_config("cron", Some(store));
    config.inbox_key = format!("{inbox}:inbox");
    config.overflow_key = format!("{inbox}:overflow");
    config.sample_rate = 1.0;
    config
}

async fn inbox(dragonfly: &dima_store::dragonfly::Dragonfly, key: &str) -> Vec<Value> {
    let items: Vec<String> = dragonfly
        .query(redis::cmd("LRANGE").arg(key).arg(0).arg(-1))
        .await
        .unwrap();
    items
        .iter()
        .map(|item| serde_json::from_str(item).unwrap())
        .collect()
}

#[tokio::test]
async fn payloads_reach_the_inbox_in_the_reference_envelope() {
    let Some(store) = support::config(13) else {
        return;
    };
    let name = support::unique("dima-test-telemetry");
    support::with_cleanup(&store, &[format!("{name}:*")], async {
        let telemetry = Telemetry::new(exporting(store.clone(), &name)).unwrap();
        telemetry.observe_with("chat", "message", 12.0, "ok", Some("123"));
        telemetry.count("event", "channel.follow");
        let _ = telemetry
            .traced("command", "!so", async { Ok::<_, ()>(()) })
            .await;
        telemetry.error(
            &json!({"function": "tts", "code": "E_PROVIDER", "message": "private"}),
            LogOptions::console(),
        );
        telemetry.sample();
        telemetry.flush().await;
        assert_eq!(telemetry.stats().payloads_sent, 1);

        let dragonfly = support::connect(&store).await;
        let key = format!("{name}:inbox");
        let ttl: i64 = dragonfly.query(redis::cmd("TTL").arg(&key)).await.unwrap();
        assert!((3500..=3600).contains(&ttl), "{ttl}");
        let batches = inbox(&dragonfly, &key).await;
        assert_eq!(batches.len(), 1);
        let batch = &batches[0];
        assert_eq!(batch["version"], 1);
        assert_eq!(batch["service"], "cron");
        assert_eq!(batch["instance"], telemetry.instance());
        let id = batch["id"].as_str().unwrap();
        assert!(id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
        let metrics = batch["metrics"].as_array().unwrap();
        for metric in metrics {
            let histogram: u64 = metric["histogram"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap())
                .sum();
            assert_eq!(histogram, metric["count"].as_u64().unwrap());
            assert_eq!(
                metric["histogram"].as_array().unwrap().len(),
                LATENCY_BOUNDS.len()
            );
            assert_eq!(metric["at"].as_u64().unwrap() % 10_000, 0);
        }
        let find = |name: &str| {
            metrics
                .iter()
                .find(|m| m["name"] == name)
                .unwrap_or_else(|| panic!("{name} in {metrics:?}"))
        };
        assert_eq!(find("message")["channel"], "123");
        assert_eq!(find("message")["sum"], 12.0);
        assert_eq!(find("channel.follow")["kind"], "event");
        // `clean` turns `!` into `_`, as in the reference.
        assert_eq!(find("_so")["kind"], "command");
        for runtime in [
            "index.rss_bytes",
            "index.telemetry_dropped",
            "index.uptime_s",
        ] {
            assert_eq!(find(runtime)["kind"], "runtime", "{runtime}");
        }
        let spans = batch["spans"].as_array().unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["name"], "_so");
        assert_eq!(spans[0]["parentId"], Value::Null);
        assert_eq!(spans[0]["traceId"].as_str().unwrap().len(), 32);
        let logs = batch["logs"].as_array().unwrap();
        assert_eq!(
            logs[0]["fields"],
            json!({"function": "tts", "code": "E_PROVIDER"})
        );
        assert!(!batch.to_string().contains("private"));
        support::keys_and_cleanup(&dragonfly, &format!("{name}:*")).await;
    })
    .await;
}

#[tokio::test]
async fn batches_split_and_the_inbox_keeps_one_hundred() {
    let Some(store) = support::config(13) else {
        return;
    };
    let name = support::unique("dima-test-telemetry");
    support::with_cleanup(&store, &[format!("{name}:*")], async {
        let telemetry = Telemetry::new(exporting(store.clone(), &name)).unwrap();
        let dragonfly = support::connect(&store).await;
        let key = format!("{name}:inbox");
        // 99 stale batches already waiting.
        for index in 0..99 {
            let _: i64 = dragonfly
                .query(redis::cmd("RPUSH").arg(&key).arg(format!("old{index}")))
                .await
                .unwrap();
        }
        for name in support::names("name", 250) {
            telemetry.observe("command", name, 1.0);
        }
        for index in 0..60 {
            telemetry.warn(
                &json!({"function": format!("f{index}")}),
                LogOptions::console(),
            );
        }
        telemetry.flush().await;
        assert_eq!(telemetry.stats().payloads_sent, 3);
        let items: Vec<String> = dragonfly
            .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
            .await
            .unwrap();
        assert_eq!(items.len(), 100);
        // Newest first; the two oldest stale batches were trimmed and counted.
        let newest: Value = serde_json::from_str(&items[0]).unwrap();
        assert_eq!(newest["metrics"].as_array().unwrap().len(), 50);
        assert_eq!(newest["logs"].as_array().unwrap().len(), 10);
        let overflow: i64 = dragonfly
            .query(redis::cmd("GET").arg(format!("{name}:overflow")))
            .await
            .unwrap();
        assert_eq!(overflow, 2);
        // The overflow counter expires like the inbox.
        let ttl: i64 = dragonfly
            .query(redis::cmd("TTL").arg(format!("{name}:overflow")))
            .await
            .unwrap();
        assert!((3500..=3600).contains(&ttl), "overflow ttl {ttl}");
        assert!(items.iter().all(|item| item.len() <= 256_000));
        support::keys_and_cleanup(&dragonfly, &format!("{name}:*")).await;
    })
    .await;
}

async fn failing_flush(store: dima_store::dragonfly::DragonflyConfig) {
    let telemetry = Telemetry::new(exporting(
        store,
        &support::unique("dima-test-telemetry-unreachable"),
    ))
    .unwrap();
    for _ in 0..10 {
        telemetry.observe("command", "x", 1.0);
    }
    let _ = telemetry
        .traced("command", "y", async { Ok::<_, ()>(()) })
        .await;
    telemetry.warn(&json!({"function": "z"}), LogOptions::console());
    let started = Instant::now();
    telemetry.flush().await;
    let spent = started.elapsed();
    assert!(spent < Duration::from_millis(1900), "{spent:?}");
    // 10 + 1 observations, one span, one log.
    assert_eq!(telemetry.stats().pipeline_dropped, 13);
    // A second flush within the back-off gives up at once.
    telemetry.observe("command", "x", 1.0);
    let started = Instant::now();
    telemetry.flush().await;
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(telemetry.stats().pipeline_dropped, 14);
    // The process reports its own loss on the next sample.
    telemetry.sample();
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.metric("index.telemetry_dropped")[0].sum, 14.0);
}

#[tokio::test]
async fn an_unreachable_store_costs_data_not_time() {
    failing_flush(support::local_store(support::closed_port())).await;
}

#[tokio::test]
async fn a_hung_store_costs_data_not_time() {
    let (port, server) = support::black_hole().await;
    failing_flush(support::local_store(port)).await;
    server.abort();
}

#[tokio::test]
async fn series_beyond_the_bound_are_dropped_and_counted() {
    let telemetry = support::in_memory(0.0);
    for name in support::names("name", 2500) {
        telemetry.observe("command", name, 10.0);
    }
    assert_eq!(telemetry.stats().pipeline_dropped, 500);
    assert_eq!(telemetry.stats().series, 2000);
    // Existing series keep counting at the bound.
    telemetry.observe("command", "name0", 10.0);
    assert_eq!(telemetry.stats().pipeline_dropped, 500);
    for _ in 0..400 {
        telemetry.span("cache", "get").end("error");
    }
    // 300 spans per flush (the metric series of the spans is the 2001st: dropped as well).
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.spans.len(), 300);
    assert_eq!(telemetry.stats().pipeline_dropped, 500 + 100 + 400);
    for _ in 0..150 {
        telemetry.error(&json!({"function": "f"}), LogOptions::console());
    }
    assert_eq!(telemetry.take_snapshot().logs.len(), 100);
}

#[tokio::test]
async fn the_exporter_task_flushes_on_shutdown() {
    let Some(store) = support::config(13) else {
        return;
    };
    let name = support::unique("dima-test-telemetry");
    support::with_cleanup(&store, &[format!("{name}:*")], async {
        let telemetry = Telemetry::new(exporting(store.clone(), &name)).unwrap();
        let running = telemetry.start();
        telemetry.count("lifecycle", "stream.started");
        let report = running.shutdown(Duration::from_secs(3)).await;
        assert!(report.clean);
        let dragonfly = support::connect(&store).await;
        let batches = inbox(&dragonfly, &format!("{name}:inbox")).await;
        assert_eq!(batches.len(), 1);
        assert!(
            batches[0]["metrics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["name"] == "stream.started")
        );
        support::keys_and_cleanup(&dragonfly, &format!("{name}:*")).await;
    })
    .await;
}

/// With `DIMA_TEST_REQUIRE_STORES=1` (set by `tools/test-env`) a test that needs Dragonfly fails
/// when it is missing; without it, it is skipped.
#[test]
fn a_missing_store_fails_when_stores_are_required() {
    assert!(support::config_from(None, false, 13).is_none());
    assert!(std::panic::catch_unwind(|| support::config_from(None, true, 13)).is_err());
    assert!(support::config_from(Some("127.0.0.1:6379"), true, 12).is_some());
    // Only the two databases these tests may use.
    assert!(
        std::panic::catch_unwind(|| support::config_from(Some("127.0.0.1:6379"), false, 14))
            .is_err()
    );
}
