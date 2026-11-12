//! The consumer check: payloads this crate writes to the inbox (local Dragonfly, logical database
//! 13) are fed to the analytics service's own ingestion code (`dima-analytics/src/store.mjs`,
//! run with `node`, its PostgreSQL pool stubbed; see `tests/analytics/ingest.mjs`), which must
//! accept every batch and store what the admin observability page reads.
//!
//! The payloads are also kept in `tests/fixtures/analytics/` for the later port of that service:
//! set `DIMA_TELEMETRY_WRITE_FIXTURES=1` to rewrite them. The committed fixtures are checked on
//! every run (their timestamps are pinned with `--now-from-payloads`).
//!
//! Skipped with a message when `node`, the analytics source, or the local Dragonfly is missing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_telemetry::{LogOptions, RunOutcome, Telemetry, TelemetryConfig};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn store_module() -> Option<PathBuf> {
    let path = root().join("../../../dima-analytics/src/store.mjs");
    if !path.exists() {
        eprintln!("skipped: {} is missing", path.display());
        return None;
    }
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipped: node is not installed");
        return None;
    }
    Some(path)
}

fn ingest(store: &Path, pin: bool, files: &[PathBuf]) -> Value {
    let mut command = Command::new("node");
    command
        .arg(root().join("tests/analytics/ingest.mjs"))
        .arg(store);
    if pin {
        command.arg("--now-from-payloads");
    }
    let output = command.args(files).output().expect("run node");
    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("harness output")
}

fn config(
    service: &str,
    store: dima_store::dragonfly::DragonflyConfig,
    inbox: &str,
) -> TelemetryConfig {
    let (mut config, _console) = support::memory_config(service, Some(store));
    config.inbox_key = format!("{inbox}:inbox");
    config.overflow_key = format!("{inbox}:overflow");
    config.sample_rate = 0.0;
    config
}

/// A small slice of what the API and the cron binary report.
async fn workload(api: &Telemetry, cron: &Telemetry) {
    api.sample();
    let mut request = api.span("http", "GET /speech/:channelID");
    request
        .run(async {
            dima_telemetry::trace::bind_channel("123456");
            api.observe_with("cache_lookup", "get", 0.0, "miss", None);
            api.span("cache", "get").end("ok");
            api.span("database", "mongo.find").end("ok");
            api.error(
                &json!({"function": "speech", "code": "E_PROVIDER", "status": 503, "message": "private text", "token": "secret"}),
                LogOptions::console(),
            );
        })
        .await;
    request.end("error");
    api.span("http", "GET /api/health").end("200");
    api.observe_with("chat", "message", 14.0, "ok", Some("123456"));
    api.count("event", "channel.follow");
    api.observe_with("queue_wait", "tts", 820.0, "ok", Some("123456"));
    let _ = api
        .traced("queue_run", "tts.fish", async { Ok::<_, ()>(()) })
        .await;

    cron.sample();
    let goals = cron.worker("goals.worker");
    let stream = cron.worker("stream_activity_rust");
    goals
        .instrument(async {
            goals.run().finish(RunOutcome::Ok);
            goals.run().finish(RunOutcome::Idle);
            goals.run().finish(RunOutcome::Error);
        })
        .await;
    goals.error("claim", "E_LEASE");
    goals.restarted();
    stream
        .instrument(async {
            let run = stream.run();
            stream.batch("batch_events", 25, Duration::from_millis(40), true);
            stream.health(true);
            stream.gauge("pending_work", 0.0);
            stream.gauge("last_success_age_ms", 1200.0);
            run.finish(RunOutcome::Ok);
        })
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    api.sample();
    cron.sample();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_analytics_service_accepts_and_stores_what_the_admin_page_reads() {
    let Some(store_mjs) = store_module() else {
        return;
    };
    let Some(store) = support::config(13) else {
        return;
    };
    let name = support::unique("dima-test-telemetry-consumer");
    let api = Telemetry::new(config("api", store.clone(), &name)).unwrap();
    let cron = Telemetry::new(config("cron", store.clone(), &name)).unwrap();
    // The real background work: probe, sampler, and the final sample and flush on shutdown.
    let (api_running, cron_running) = (api.start(), cron.start());
    workload(&api, &cron).await;
    assert!(api_running.shutdown(Duration::from_secs(3)).await.clean);
    assert!(cron_running.shutdown(Duration::from_secs(3)).await.clean);
    let dragonfly = support::connect(&store).await;
    let raw: Vec<String> = dragonfly
        .query(
            redis::cmd("LRANGE")
                .arg(format!("{name}:inbox"))
                .arg(0)
                .arg(-1),
        )
        .await
        .unwrap();
    support::keys_and_cleanup(&dragonfly, &format!("{name}:*")).await;
    // One batch per process, or more if a scheduled flush fell inside the test.
    assert!(raw.len() >= 2, "{}", raw.len());

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    let mut files = Vec::new();
    for (index, payload) in raw.iter().rev().enumerate() {
        let service = serde_json::from_str::<Value>(payload).unwrap()["service"]
            .as_str()
            .unwrap()
            .to_owned();
        let file = dir.join(format!("{index}-{service}.json"));
        std::fs::write(&file, payload).unwrap();
        files.push(file);
    }
    if std::env::var("DIMA_TELEMETRY_WRITE_FIXTURES").as_deref() == Ok("1") {
        let fixtures = root().join("tests/fixtures/analytics");
        std::fs::create_dir_all(&fixtures).unwrap();
        for file in &files {
            let pretty = serde_json::to_string_pretty(
                &serde_json::from_slice::<Value>(&std::fs::read(file).unwrap()).unwrap(),
            )
            .unwrap();
            std::fs::write(fixtures.join(file.file_name().unwrap()), pretty + "\n").unwrap();
        }
    }
    let result = ingest(&store_mjs, false, &files);
    std::fs::remove_dir_all(&dir).ok();
    check(&result, files.len());
}

#[test]
fn the_committed_fixtures_are_still_accepted() {
    let Some(store_mjs) = store_module() else {
        return;
    };
    let fixtures = root().join("tests/fixtures/analytics");
    let Ok(entries) = std::fs::read_dir(&fixtures) else {
        panic!(
            "{} is missing: run with DIMA_TELEMETRY_WRITE_FIXTURES=1",
            fixtures.display()
        );
    };
    let mut files: Vec<PathBuf> = entries
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(files.len() >= 2, "{files:?}");
    check(&ingest(&store_mjs, true, &files), files.len());
}

fn check(result: &Value, batches: usize) {
    assert_eq!(result["failures"], json!([]), "{result:#}");
    assert_eq!(result["accepted"], batches);
    // Replays are deduplicated by the batch id.
    assert_eq!(result["replayed"], batches);
    let processes = &result["processes"];
    // Process rows: "API server" and "Workers host".
    for key in ["api|index", "cron|index"] {
        let row = &processes[key];
        assert!(row["rss_bytes"].as_f64().unwrap() > 1e6, "{key}: {row}");
        assert!(row["cpu_cores"].as_f64().is_some(), "{key}: {row}");
        assert!(row["event_loop_p99_ms"].as_f64().is_some(), "{key}: {row}");
        assert_eq!(row["telemetry_dropped"], 0.0, "{key}: {row}");
        assert!(row.get("heap_bytes").is_none());
    }
    // Worker rows: busy cores and the longest poll, no memory of their own.
    for key in ["cron|goals.worker", "cron|stream_activity_rust"] {
        let row = &processes[key];
        assert!(row["cpu_cores"].as_f64().is_some(), "{key}: {row}");
        assert!(row["event_loop_p99_ms"].as_f64().is_some(), "{key}: {row}");
        assert!(row.get("rss_bytes").is_none());
    }
    let group = |service: &str, kind: &str, name: &str| {
        result["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["service"] == service && g["kind"] == kind && g["name"] == name)
            .unwrap_or_else(|| panic!("{service} {kind} {name}"))
            .clone()
    };
    let http = group("api", "http", "GET /speech/:channelID");
    assert_eq!(
        (http["channel"].as_str(), http["errors"].as_u64()),
        (Some("123456"), Some(1))
    );
    assert_eq!(group("api", "chat", "message")["sum"], 14.0);
    assert_eq!(group("api", "cache_lookup", "get")["channel"], "123456");
    // Refresh-health panel of the native stream worker.
    let health = group("cron", "worker", "stream_activity_rust.health_query");
    assert_eq!(
        (health["channel"].as_str(), health["lastValue"].as_f64()),
        (Some(""), Some(1.0))
    );
    assert_eq!(
        group("cron", "worker", "goals.worker.state")["kind"],
        "worker"
    );
    // Queue rows.
    let queues = &result["queues"];
    assert_eq!(queues["goals"]["jobs"], 3);
    assert_eq!(queues["goals"]["failures"], 1);
    assert!(queues["stream_activity_rust"]["jobs"].as_u64().unwrap() >= 2);
    assert!(queues["tts"]["jobs"].as_u64().unwrap() >= 1);
    // Traces and logs.
    let spans = result["spans"].as_array().unwrap();
    let failed = spans
        .iter()
        .find(|s| s["name"] == "GET /speech/:channelID")
        .unwrap();
    assert_eq!(
        (
            failed["service"].as_str(),
            failed["outcome"].as_str(),
            failed["partial"].as_bool()
        ),
        (Some("api"), Some("error"), Some(true))
    );
    let logs = result["logs"].as_array().unwrap();
    let speech = logs.iter().find(|l| l["name"] == "speech").unwrap();
    assert_eq!(
        speech["fields"],
        json!({"function": "speech", "status": 503, "code": "E_PROVIDER"})
    );
    assert_eq!(speech["channel"], "123456");
    assert!(speech["traceId"].as_str().is_some_and(|id| id.len() == 32));
    let lease = logs.iter().find(|l| l["name"] == "goals.worker").unwrap();
    assert_eq!(lease["fields"]["code"], "E_LEASE");
    assert!(
        !result.to_string().contains("private text") && !result.to_string().contains("secret\"")
    );
}
