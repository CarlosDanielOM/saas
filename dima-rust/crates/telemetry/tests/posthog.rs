//! Log export to PostHog over OTLP/JSON against the loopback mock: request shape and headers,
//! batch bounds, retries and their limit, and the flush on shutdown.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_core::SecretString;
use dima_http::testing::{MockResponse, MockServer};
use dima_telemetry::{Level, LogOptions, PosthogConfig, Telemetry};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn with_posthog(url: &str) -> Telemetry {
    with_posthog_from(url, None)
}

fn with_posthog_from(url: &str, min_level: Option<Level>) -> Telemetry {
    let (mut config, _console) = support::memory_config("api", None);
    config.posthog = Some(PosthogConfig {
        base_url: url.to_owned(),
        token: SecretString::new("phc_test_key".to_owned()),
        service_name: "DomDimaBot".to_owned(),
        min_level,
    });
    config.sample_rate = 1.0;
    Telemetry::new(config).unwrap()
}

fn attributes(record: &Value) -> Vec<(String, String)> {
    record["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["key"].as_str().unwrap().to_owned(),
                a["value"]["stringValue"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn records_are_exported_in_otlp_json_and_flushed_on_shutdown() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200).body("{}"));
    let telemetry = with_posthog(&server.url());
    let running = telemetry.start();
    telemetry.info(
        &json!({"function": "boot", "count": 3, "ratio": 0.5, "ok": true, "none": null}),
        LogOptions::console(),
    );
    let mut span = telemetry.span("command", "!so");
    span.run(async {
        telemetry.warn(
            &json!({"text": "hola 😀", "password": "hunter2"}),
            LogOptions::cache().channel("123"),
        );
    })
    .await;
    let ids = span.ids();
    span.end("ok");
    telemetry.debug(&"plain", LogOptions::new());
    // Shut down at once: the reference would lose these (it never flushes).
    let report = running.shutdown(Duration::from_secs(5)).await;
    assert!(report.clean);
    assert_eq!(report.stats.posthog_dropped, 0);

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(
        (request.method.as_str(), request.target.as_str()),
        ("POST", "/i/v1/logs")
    );
    assert_eq!(request.header("authorization"), Some("Bearer phc_test_key"));
    assert!(
        request
            .header("content-type")
            .unwrap()
            .starts_with("application/json")
    );
    let body: Value = serde_json::from_slice(&request.body).unwrap();
    let resource = &body["resourceLogs"][0];
    assert_eq!(
        resource["resource"]["attributes"][0],
        json!({"key": "service.name", "value": {"stringValue": "DomDimaBot"}})
    );
    let scope = &resource["scopeLogs"][0];
    assert_eq!(scope["scope"]["name"], "DomDimaBot");
    let records = scope["logRecords"].as_array().unwrap();
    assert_eq!(records.len(), 3);

    let info = &records[0];
    assert_eq!(
        (
            info["severityText"].as_str(),
            info["severityNumber"].as_u64()
        ),
        (Some("info"), Some(9))
    );
    assert!(
        info["timeUnixNano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
            > 1_700_000_000_000_000_000
    );
    let fields: Vec<&Value> = info["body"]["kvlistValue"]["values"]
        .as_array()
        .unwrap()
        .iter()
        .collect();
    let value = |key: &str| &fields.iter().find(|f| f["key"] == key).unwrap()["value"];
    assert_eq!(value("function"), &json!({"stringValue": "boot"}));
    assert_eq!(value("count"), &json!({"intValue": "3"}));
    assert_eq!(value("ratio"), &json!({"doubleValue": 0.5}));
    assert_eq!(value("ok"), &json!({"boolValue": true}));
    assert_eq!(value("none"), &json!({"stringValue": "null"}));
    assert_eq!(
        attributes(info),
        [
            ("destination".into(), "console".into()),
            ("platform".into(), "twitch".into())
        ]
    );
    assert!(info.get("traceId").is_none());

    let warn = &records[1];
    assert_eq!(warn["severityNumber"], 13);
    assert_eq!(warn["traceId"], ids.trace_id.hex().as_str());
    assert_eq!(warn["spanId"], ids.span_id.hex().as_str());
    assert!(attributes(warn).contains(&("channelId".into(), "123".into())));
    let text = serde_json::to_string(warn).unwrap();
    assert!(
        text.contains("hola 😀") && !text.contains("hunter2"),
        "{text}"
    );

    assert_eq!(records[2]["body"], json!({"stringValue": "plain"}));
    assert_eq!(records[2]["severityNumber"], 5);
}

#[tokio::test]
async fn batches_hold_at_most_512_records() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200));
    let telemetry = with_posthog(&server.url());
    for index in 0..1200 {
        telemetry.info(&json!({ "index": index }), LogOptions::console());
    }
    let running = telemetry.start();
    let report = running.shutdown(Duration::from_secs(5)).await;
    assert_eq!(report.stats.posthog_dropped, 0);
    let sizes: Vec<usize> = server
        .requests()
        .iter()
        .map(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
                .as_array()
                .unwrap()
                .len()
        })
        .collect();
    assert_eq!(sizes.iter().sum::<usize>(), 1200);
    assert!(sizes.iter().all(|size| *size <= 512), "{sizes:?}");
}

#[tokio::test]
async fn failures_are_retried_twice_then_dropped_and_counted() {
    let server = MockServer::start().await.unwrap();
    for _ in 0..3 {
        server.push(MockResponse::new(503));
    }
    server.push(MockResponse::new(429));
    server.fallback(|_| MockResponse::new(200));
    let telemetry = with_posthog(&server.url());
    let running = telemetry.start();
    telemetry.error(&"first", LogOptions::console());
    // Three attempts (1 s, then 2 s apart), then the batch is lost.
    tokio::time::sleep(Duration::from_millis(3600)).await;
    telemetry.error(&"second", LogOptions::console());
    let started = Instant::now();
    let report = running.shutdown(Duration::from_secs(5)).await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(report.stats.posthog_dropped, 1);
    let requests = server.requests();
    // 3 failed attempts for "first", then 429 and a success for "second".
    assert_eq!(requests.len(), 5);
    let last: Value = serde_json::from_slice(&requests[4].body).unwrap();
    assert!(last.to_string().contains("second"));
}

#[tokio::test]
async fn an_unreachable_endpoint_never_reaches_the_caller() {
    let telemetry = with_posthog(&format!("http://127.0.0.1:{}", support::closed_port()));
    let running = telemetry.start();
    let started = Instant::now();
    for index in 0..200 {
        telemetry.info(&json!({ "index": index }), LogOptions::console());
    }
    assert!(started.elapsed() < Duration::from_millis(200));
    let report = running.shutdown(Duration::from_secs(6)).await;
    assert_eq!(report.stats.posthog_dropped, 200);
}

fn exported_levels(server: &MockServer) -> Vec<String> {
    server
        .requests()
        .iter()
        .flat_map(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
                .as_array()
                .unwrap()
                .iter()
                .map(|record| record["severityText"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn log_every_level(telemetry: &Telemetry) {
    for level in [
        Level::Trace,
        Level::Debug,
        Level::Info,
        Level::Warn,
        Level::Error,
        Level::Fatal,
    ] {
        telemetry.log(level, &level.as_str(), LogOptions::console());
    }
}

/// The default is the reference's behaviour: `utils/logger.ts` calls `openLog.emit` for every log
/// call whatever its level, and only the logger's own minimum level filters. Gating at `warn` by
/// default would silently remove the info and debug records PostHog shows today.
#[tokio::test]
async fn by_default_every_enabled_level_is_exported_as_in_the_reference() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200));
    assert_eq!(PosthogConfig::reference().min_level, None);
    let telemetry = with_posthog(&server.url());
    let running = telemetry.start();
    log_every_level(&telemetry);
    let report = running.shutdown(Duration::from_secs(5)).await;
    assert_eq!(
        exported_levels(&server),
        ["trace", "debug", "info", "warn", "error", "fatal"]
    );
    assert_eq!(report.stats.posthog_below_level, 0);
}

/// An operator may choose a minimum export level; what it keeps out is counted, not lost
/// silently, and is not reported as a failure.
#[tokio::test]
async fn an_optional_minimum_export_level_keeps_lower_entries_out_and_counts_them() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200));
    let telemetry = with_posthog_from(&server.url(), Some(Level::Warn));
    let running = telemetry.start();
    log_every_level(&telemetry);
    let report = running.shutdown(Duration::from_secs(5)).await;
    assert_eq!(exported_levels(&server), ["warn", "error", "fatal"]);
    assert_eq!(report.stats.posthog_below_level, 3);
    assert_eq!(report.stats.posthog_dropped, 0);
    assert_eq!(report.stats.total_dropped(), 0);
}
