//! The bot runtime metrics against the reference's recording (`tests/reference/record_metrics.mts`):
//! the same observations, two flushes, then every key under the prefix compared (name, type,
//! lifetime, hash fields and values, the snapshot's shape and counters). Differences on purpose
//! are stated where they are applied.

use anyhow::{Context, Result, anyhow, bail, ensure};
use dima_actions::metrics::{
    BotMetrics, MetricsConfig, SemanticMemoryMetric, StreamMemoryActionMetric,
    StreamMemoryJobMetric, ThreadRoutingMetric,
};
use dima_core::{ManualClock, Shutdown};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Ttl};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

/// The type the reference counts under its own name and Rust as `other` (a fixed list of type
/// names keeps the series bounded).
const UNKNOWN_TYPE: &str = "channel.unheard_of.thing";

fn fixture() -> Result<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/metrics_recorded.json"
    );
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    Ok(serde_json::from_str(&text)?)
}

async fn dragonfly() -> Result<Option<Dragonfly>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        if std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1") {
            bail!("DIMA_TEST_DRAGONFLY is not set (DIMA_TEST_REQUIRE_STORES=1)");
        }
        eprintln!("skipped: DIMA_TEST_DRAGONFLY is not set");
        return Ok(None);
    };
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("DIMA_TEST_DRAGONFLY is host:port"))?;
    let config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/11")),
        "dima-actions-tests",
    );
    Ok(Some(Dragonfly::connect(config, Default::default()).await?))
}

async fn keys(client: &Dragonfly, prefix: &str) -> Result<Vec<String>> {
    let mut scan = client.scan(&format!("{prefix}*"), Some(1000));
    let mut keys = Vec::new();
    for _ in 0..10_000 {
        match scan.next_page().await? {
            Some(page) => keys.extend(page.into_iter().filter_map(|k| String::from_utf8(k).ok())),
            None => break,
        }
    }
    keys.sort();
    keys.dedup();
    Ok(keys)
}

/// Every key under `prefix`: suffix to `{type, ttl, value}` as the recorder dumps it.
async fn dump(client: &Dragonfly, prefix: &str) -> Result<BTreeMap<String, (String, i64, Value)>> {
    let mut out = BTreeMap::new();
    for key in keys(client, prefix).await? {
        let kind: String = client.query(redis::cmd("TYPE").arg(&key)).await?;
        let ttl = match client.ttl(&key).await? {
            Ttl::Seconds(seconds) => seconds,
            other => bail!("{key}: lifetime {other:?}"),
        };
        let value = match kind.as_str() {
            "string" => serde_json::from_str(&client.get_text(&key).await?.unwrap_or_default())?,
            "list" => {
                let items: Vec<String> = client
                    .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                    .await?;
                Value::Array(
                    items
                        .iter()
                        .map(|i| serde_json::from_str(i))
                        .collect::<Result<_, _>>()?,
                )
            }
            "hash" => Value::Object(
                client
                    .hgetall(&key)
                    .await?
                    .into_iter()
                    .map(|(field, value)| (field, Value::String(value)))
                    .collect(),
            ),
            other => bail!("{key}: unexpected type {other}"),
        };
        let suffix = key.strip_prefix(prefix).unwrap_or_default().to_owned();
        out.insert(suffix, (kind, ttl, value));
    }
    Ok(out)
}

/// The reference's per-type maps with the unknown type counted as `other`.
fn bounded_types(map: &mut Map<String, Value>) {
    if let Some(value) = map.remove(UNKNOWN_TYPE) {
        map.insert("other".to_owned(), value);
    }
}

/// A snapshot with the figures that cannot be equal masked: process identity and memory, the
/// V8-only figures (null in Rust), the scheduler delay (numbers both sides).
fn masked(snapshot: &Value, rust: bool) -> Result<Value> {
    let mut snapshot = snapshot.clone();
    let object = snapshot.as_object_mut().context("snapshot")?;
    for (section, keys) in [
        ("process", &["pid", "node", "uptimeSeconds"][..]),
        (
            "memory",
            &[
                "rssBytes",
                "heapTotalBytes",
                "heapUsedBytes",
                "externalBytes",
                "arrayBuffersBytes",
            ][..],
        ),
        ("runtime", &["activeHandles", "activeRequests"][..]),
        (
            "eventLoop",
            &[
                "minMs", "maxMs", "meanMs", "stddevMs", "p50Ms", "p95Ms", "p99Ms",
            ][..],
        ),
    ] {
        let part = object
            .get_mut(section)
            .and_then(Value::as_object_mut)
            .with_context(|| format!("snapshot.{section}"))?;
        for key in keys {
            let value = part
                .get(*key)
                .with_context(|| format!("{section}.{key} missing"))?;
            let expected_shape = match (rust, section, *key) {
                // V8 heap and handle counts do not exist in Rust: null (the reference already
                // writes null for the handle counts when Node lacks them).
                (true, "memory", key) if key != "rssBytes" => value.is_null(),
                (true, "runtime", _) => value.is_null(),
                (_, "process", "node") => value.is_string(),
                _ => value.is_number(),
            };
            ensure!(expected_shape, "{section}.{key}: {value}");
            part.insert((*key).to_owned(), Value::Null);
        }
    }
    for section in ["window", "totals"] {
        if let Some(Value::Object(by_type)) = object
            .get_mut(section)
            .and_then(|part| part.get_mut("eventsubByType"))
        {
            bounded_types(by_type);
        }
    }
    Ok(snapshot)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_recorded_metrics_match() -> Result<()> {
    let fixture = fixture()?;
    let Some(client) = dragonfly().await? else {
        return Ok(());
    };
    let prefix = format!("dima:test:actions:{}:", bson_like_id());
    let outcome = run(&fixture, &client, &prefix).await;
    let cleanup = clean(&client, &prefix).await;
    outcome?;
    cleanup
}

fn bson_like_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}-{}", std::process::id())
}

async fn clean(client: &Dragonfly, prefix: &str) -> Result<()> {
    for key in keys(client, prefix).await? {
        client.del(&[key.as_str()]).await?;
    }
    Ok(())
}

async fn run(fixture: &Value, client: &Dragonfly, prefix: &str) -> Result<()> {
    let now = fixture["nowMs"].as_i64().context("nowMs")?;
    let clock = ManualClock::new(now);
    let config =
        MetricsConfig::from_env_values(None, None, Some(&format!("{prefix}metrics:bot")), None);
    let metrics = BotMetrics::new(config, client.clone(), Arc::new(clock), None);
    let shutdown = Shutdown::new();
    let running = metrics
        .start_loop(&shutdown)
        .context("the loop starts once")?;
    ensure!(
        metrics.start_loop(&shutdown).is_none(),
        "a second start does nothing"
    );

    for _ in 0..3 {
        metrics.observe_eventsub_notification("channel.chat.message", 512);
    }
    metrics.observe_eventsub_notification("channel.follow", 300);
    metrics.observe_eventsub_notification("", 5);
    metrics.observe_eventsub_notification(UNKNOWN_TYPE, 10);
    let first = metrics.start_eventsub_handler("channel.chat.message");
    let second = metrics.start_eventsub_handler("channel.follow");
    first.end(false);
    second.end(true);
    let message = metrics.start_message_handler();
    let left_in_flight = metrics.start_message_handler();
    message.end(true);
    metrics.observe_embedding_queue(7, true);
    metrics.record_embedding_enqueued(9);
    metrics.record_embedding_batch_result(5, true);
    metrics.record_embedding_batch_result(3, false);
    metrics.record_redis_ops_estimate(4.6);
    metrics.record_openrouter_embedding_request(120);
    metrics.record_openrouter_embedding_error();
    metrics
        .record_semantic_memory(&SemanticMemoryMetric {
            channel_id: "1001".into(),
            requested: Some(5.0),
            retrieved: Some(3.4),
            latency_ms: Some(12.5),
            avg_score: Some(0.8765),
            failed: true,
            pass: Some("first".into()),
        })
        .await;
    metrics
        .record_semantic_memory(&SemanticMemoryMetric {
            channel_id: "1001".into(),
            ..Default::default()
        })
        .await;
    metrics
        .record_thread_routing(&ThreadRoutingMetric {
            channel_id: "1001".into(),
            candidate_count: Some(4.0),
            selected_score: Some(0.5),
            prompt_turns_used: Some(6.0),
            latency_ms: Some(30.0),
            user_evictions: Some(1.0),
            channel_evictions: Some(0.0),
            created: true,
            reused: false,
            failed: false,
        })
        .await;
    metrics
        .record_stream_memory_job(&StreamMemoryJobMetric {
            channel_id: "1002".into(),
            latency_ms: Some(1500.0),
            failed: false,
            status: Some("done".into()),
            job_type: Some("summary".into()),
            source: Some("stream_offline".into()),
        })
        .await;
    metrics
        .record_stream_memory_job(&StreamMemoryJobMetric {
            channel_id: "1002".into(),
            failed: true,
            ..Default::default()
        })
        .await;
    metrics
        .record_stream_memory_action(&StreamMemoryActionMetric {
            channel_id: "1002".into(),
            action: Some("insert".into()),
            source: Some("manual".into()),
            count: Some(3.0),
        })
        .await;
    metrics
        .record_stream_memory_action(&StreamMemoryActionMetric {
            channel_id: "1002".into(),
            action: Some("insert".into()),
            count: Some(0.0),
            ..Default::default()
        })
        .await;
    // Let the probe take a few samples, then the two shutdown flushes of the reference.
    tokio::time::sleep(Duration::from_millis(100)).await;
    metrics.flush().await;
    metrics.observe_eventsub_notification("channel.follow", 100);
    metrics.flush().await;
    shutdown.trigger();
    running.await?;
    ensure!(
        metrics.write_errors() == 0,
        "{} write errors",
        metrics.write_errors()
    );
    drop(left_in_flight);

    let recorded = fixture["keys"].as_object().context("keys")?;
    let actual = dump(client, &format!("{prefix}metrics:bot:")).await?;
    let expected_keys: Vec<&String> = recorded.keys().collect();
    let actual_keys: Vec<&String> = actual.keys().collect();
    ensure!(
        expected_keys == actual_keys,
        "keys {actual_keys:?}, the reference {expected_keys:?}"
    );
    let mut differences = 0;
    for (key, expected) in recorded {
        let (kind, ttl, value) = actual.get(key).context("key")?;
        ensure!(
            expected["type"].as_str() == Some(kind.as_str()),
            "{key}: type {kind}"
        );
        let expected_ttl = expected["ttl"].as_i64().context("ttl")?;
        let full = if key.starts_with("runtime:") || key.starts_with("eventsub:") {
            172_800
        } else {
            86_400
        };
        ensure!(
            (expected_ttl - full).abs() <= 2 && (ttl - full).abs() <= 5,
            "{key}: lifetime {ttl}, the reference {expected_ttl}"
        );
        let mut expected_value = expected["value"].clone();
        match kind.as_str() {
            "hash" => {
                if let Value::Object(map) = &mut expected_value
                    && map.contains_key(UNKNOWN_TYPE)
                {
                    bounded_types(map);
                    differences += 1;
                }
                ensure!(
                    &expected_value == value,
                    "{key}: {value}, the reference {expected_value}"
                );
            }
            "string" => {
                ensure!(
                    masked(&expected_value, false)? == masked(value, true)?,
                    "{key}: {value}"
                );
                differences += 1;
            }
            "list" => {
                let expected_items = expected_value.as_array().context("list")?;
                let items = value.as_array().context("list")?;
                ensure!(
                    expected_items.len() == items.len(),
                    "{key}: {} items",
                    items.len()
                );
                for (expected, actual) in expected_items.iter().zip(items) {
                    ensure!(
                        masked(expected, false)? == masked(actual, true)?,
                        "{key}: {actual}"
                    );
                }
                differences += 1;
            }
            other => bail!("{key}: {other}"),
        }
    }
    // The unknown type counted as `other` in two hashes (the minute's and the cumulative
    // per-type hash; the snapshots' per-type maps are mapped the same way above), and the
    // snapshot figures that are the runtime's own (process, memory, scheduler delay) in the
    // latest snapshot and in the history.
    ensure!(differences == 4, "{differences} intended differences");
    Ok(())
}
