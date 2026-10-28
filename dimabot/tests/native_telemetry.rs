#![cfg(feature = "observability")]
use dima_rust::utils::observability::{
    Telemetry, TraceContext, bind_channel, restore_context, telemetry_context, trace_outcome,
    with_telemetry_context,
};
use serde_json::{Value, json};

fn telemetry(url: &str) -> Telemetry {
    Telemetry::new(redis::Client::open(url).unwrap(), "test", true)
}

fn numeric_json_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| numeric_json_eq(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| numeric_json_eq(x, y)))
        }
        _ => left == right,
    }
}

#[tokio::test]
async fn source_observer_parity_and_bounded_logs() {
    let telemetry = telemetry("redis://127.0.0.1:1");
    let _task = telemetry.start().unwrap();
    for n in [-1., 1., 2., 5., 1e13] {
        telemetry.observe("work!", "metric?", n, "ok!", Some("abc-1"), 19999);
    }
    telemetry.record_log("warn", &json!({"function":"task!", "step":"step?", "status":200, "message":"private-message", "extra":"private-extra"}), Some("abc-1"), 123);
    let snapshot = telemetry.snapshot();
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/shared_telemetry_parity.json")).unwrap();
    assert!(numeric_json_eq(
        &serde_json::to_value(&snapshot.metrics).unwrap(),
        &expected["metrics"]
    ));
    let mut logs = serde_json::to_value(&snapshot.logs).unwrap();
    logs[0].as_object_mut().unwrap().remove("at");
    assert_eq!(logs, expected["logs"]);
    assert_eq!(snapshot.dropped, 0);
    for _ in 0..101 {
        telemetry.record_log("error", &json!({"message":"secret"}), None, 123);
    }
    assert_eq!(telemetry.snapshot().logs.len(), 100);
    assert_eq!(telemetry.dropped(), 2);
    assert!(
        !serde_json::to_string(&telemetry.snapshot())
            .unwrap()
            .contains("secret")
    );
}

#[tokio::test]
async fn context_span_lifecycle_and_capacity() {
    let telemetry = telemetry("redis://127.0.0.1:1");
    let _task = telemetry.start().unwrap();
    let parent = TraceContext {
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        sampled: false,
        channel: "original".into(),
        outcome: None,
    };
    with_telemetry_context(parent, async {
        let span = telemetry.begin_span("work", "start", None);
        span.run(async {
            bind_channel("new_channel");
            trace_outcome("error");
        })
        .await;
        span.end("ok", Some("finish"));
        span.end("ok", None);
        assert_eq!(telemetry_context().unwrap().channel, "original");
    })
    .await;
    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.spans.len(), 1);
    let span = &snapshot.spans[0];
    assert_eq!(span.parent_id.as_deref(), Some("bbbbbbbbbbbbbbbb"));
    assert_eq!(span.context.channel, "new_channel");
    assert_eq!(span.outcome, "error");
    assert!(span.partial);
    restore_context(None, "invalid space", async {
        assert_eq!(telemetry_context().unwrap().channel, "");
    })
    .await;
    assert!(telemetry_context().is_none());
    for i in 0..2001 {
        telemetry.observe("kind", &format!("key{i}"), 1., "ok", None, 10000);
    }
    assert_eq!(telemetry.snapshot().metrics.len(), 2000);
    assert!(telemetry.dropped() >= 1);
}

#[cfg(feature = "logger")]
#[tokio::test]
async fn logger_metadata_sink_uses_task_context() {
    use dima_rust::utils::logger::{
        Level, LogOptions, Logger, LoggerConfig, SinkHandles, SystemClock, UuidSource,
    };
    use std::sync::Arc;
    let telemetry = telemetry("redis://127.0.0.1:1");
    let _task = telemetry.start().unwrap();
    let logger = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            metadata: Some(Arc::new(telemetry.clone())),
            ..Default::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .unwrap();
    let context = TraceContext {
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        sampled: true,
        channel: "tenant".into(),
        outcome: None,
    };
    with_telemetry_context(context, async {
        for channel_id in [None, Some("bad space"), Some(""), Some("other")] {
            logger
                .log(
                    Level::Warn,
                    json!({"function":"operation", "message":"secret"}),
                    LogOptions {
                        channel_id: channel_id.map(str::to_owned),
                        ..Default::default()
                    },
                )
                .await;
        }
    })
    .await;
    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.logs.len(), 4);
    assert_eq!(
        snapshot
            .logs
            .iter()
            .map(|r| r.channel.as_str())
            .collect::<Vec<_>>(),
        ["tenant", "", "", "other"]
    );
    assert_eq!(
        snapshot.logs[0].trace_id.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert!(!serde_json::to_string(&snapshot).unwrap().contains("secret"));
}

#[tokio::test]
async fn failed_flush_accounts_for_swapped_rows() {
    let telemetry = telemetry("redis://127.0.0.1:1");
    let _task = telemetry.start().unwrap();
    telemetry.observe("work", "item", 1., "ok", None, 10000);
    telemetry.observe("work", "item", 1., "ok", None, 10000);
    telemetry.record_log("warn", &json!({}), None, 0);
    telemetry.flush().await;
    assert_eq!(telemetry.dropped(), 3);
    assert!(telemetry.snapshot().metrics.is_empty());
    assert!(telemetry.snapshot().logs.is_empty());
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis in DIMA_TEST_REDIS_URL"]
async fn redis_inbox_batch_overflow_and_expiry() {
    let url = std::env::var("DIMA_TEST_REDIS_URL").expect("disposable Redis URL");
    let client = redis::Client::open(url.as_str()).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    let _: () = redis::cmd("DEL")
        .arg("observability:v1:inbox")
        .arg("observability:v1:overflow")
        .query_async(&mut conn)
        .await
        .unwrap();
    let telemetry = Telemetry::new(client, "test", true);
    let _task = telemetry.start().unwrap();
    for i in 0..101 {
        telemetry.observe("work", &format!("key{i}"), 1., "ok", None, 10000);
    }
    telemetry.flush().await;
    let rows: Vec<String> = redis::cmd("LRANGE")
        .arg("observability:v1:inbox")
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    let metrics: usize = rows
        .iter()
        .map(|s| {
            serde_json::from_str::<Value>(s).unwrap()["metrics"]
                .as_array()
                .unwrap()
                .len()
        })
        .sum();
    assert_eq!(metrics, 101);
    for _ in 0..100 {
        telemetry.flush().await;
    }
    let len: usize = redis::cmd("LLEN")
        .arg("observability:v1:inbox")
        .query_async(&mut conn)
        .await
        .unwrap();
    let overflow: u64 = redis::cmd("GET")
        .arg("observability:v1:overflow")
        .query_async(&mut conn)
        .await
        .unwrap();
    let ttl: i64 = redis::cmd("TTL")
        .arg("observability:v1:inbox")
        .query_async(&mut conn)
        .await
        .unwrap();
    assert_eq!(len, 100);
    assert_eq!(overflow, 2);
    assert!((1..=3600).contains(&ttl));
    let _: () = redis::cmd("DEL")
        .arg("observability:v1:inbox")
        .arg("observability:v1:overflow")
        .query_async(&mut conn)
        .await
        .unwrap();
}

#[tokio::test]
async fn source_boundaries_and_span_fallback() {
    use dima_rust::utils::observability::LATENCY_BOUNDS;
    let telemetry = telemetry("redis://127.0.0.1:1");
    let _task = telemetry.start().unwrap();
    for n in LATENCY_BOUNDS {
        telemetry.observe("kind😀", "x😀", n, "ok", Some("bad space"), 10000);
    }
    telemetry.observe("overflow", "sum", f64::MAX, "ok", None, 10000);
    telemetry.observe("overflow", "sum", f64::MAX, "ok", None, 10000);
    let overflow = telemetry
        .snapshot()
        .metrics
        .into_iter()
        .find(|m| m.name == "sum")
        .unwrap();
    assert_eq!(overflow.count, 2);
    assert!(overflow.sum.is_infinite());
    assert_eq!(serde_json::to_value(overflow).unwrap()["sum"], Value::Null);
    let row = &telemetry.snapshot().metrics[0];
    assert_eq!(row.kind, "kind__");
    assert_eq!(row.name, "x__");
    assert_eq!(row.channel, "");
    assert_eq!(row.histogram, [1; 16]);
    for level in ["trace", "debug", "info", "warn", "error", "fatal"] {
        telemetry.record_log(
            level,
            &json!({"function":42,"operation":"fallback","message":"secret","attempt":2}),
            Some("bad space"),
            0,
        );
    }
    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.logs.len(), 3);
    assert_eq!(snapshot.logs[0].name, "42");
    assert_eq!(snapshot.logs[0].channel, "");
    assert_eq!(
        snapshot.logs[0].fields,
        json!({"function":42,"operation":"fallback","attempt":2})
            .as_object()
            .unwrap()
            .clone()
    );
    let parent = TraceContext {
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        sampled: true,
        channel: "chan".into(),
        outcome: None,
    };
    with_telemetry_context(parent, async {
        let span = telemetry.begin_span("work", "start", None);
        span.run(async {
            trace_outcome("");
        })
        .await;
        span.end("ok", Some(""));
        span.end("error", None);
    })
    .await;
    let snapshot = telemetry.snapshot();
    assert_eq!(snapshot.spans.len(), 1);
    assert_eq!(snapshot.spans[0].outcome, "ok");
    assert_eq!(snapshot.spans[0].name, "start");
    let result: Result<(), &str> = telemetry
        .traced_result("work", "fails", None, async { Err("failure") })
        .await;
    assert_eq!(result, Err("failure"));
    assert!(
        telemetry
            .snapshot()
            .spans
            .iter()
            .any(|s| s.name == "fails" && s.outcome == "error")
    );
}
