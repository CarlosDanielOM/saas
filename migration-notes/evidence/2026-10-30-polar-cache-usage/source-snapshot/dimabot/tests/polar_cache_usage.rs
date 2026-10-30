#![cfg(feature = "polar-cache-usage")]
//! Authored only; parent must run in its capped, isolated fixture workflow.
use dima_rust::utils::{
    ai_credit_projection::{AiCreditProjection, record_command_at},
    ai_usage_producer::AiUsageProducer,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    polar_cache_usage::{CacheUsageOptions, LlmMetadata, LlmUsage, PolarCacheUsage, prepare_event},
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::PosthogTracking,
};
use std::time::Duration;

fn read_reference_fixture() -> JsonValue {
    use sha2::{Digest, Sha256};
    let path = std::env::var("POLAR_CACHE_USAGE_FIXTURE").expect("explicit pinned source fixture");
    let bytes = std::fs::read(path).unwrap();
    let pin =
        std::env::var("POLAR_CACHE_USAGE_FIXTURE_SHA256").expect("independent fixture SHA-256");
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), pin);
    let fixture = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(JsonValue::Object(files)) = fixture.get("dependencyHashes") else {
        panic!("dependency hashes")
    };
    assert_eq!(files.len(), 9);
    for (name, pin) in files {
        let path = std::path::Path::new(name.as_str().unwrap());
        assert!(
            path.components()
                .all(|p| matches!(p, std::path::Component::Normal(_)))
        );
        let JsonValue::String(pin) = pin else {
            panic!("hash")
        };
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).unwrap())
            ),
            pin.as_str().unwrap(),
            "{path:?}"
        );
    }
    fixture
}

fn options(v: &JsonValue) -> CacheUsageOptions {
    let st = |key: &str| match v.get(key) {
        Some(JsonValue::String(s)) => s.clone(),
        _ => JsString::from(""),
    };
    let num = |v: Option<&JsonValue>| match v {
        Some(JsonValue::Number(n)) => *n,
        _ => 0.0,
    };
    let llm = v
        .get("llm")
        .filter(|v| !matches!(v, JsonValue::Null))
        .map(|v| LlmMetadata {
            model: match v.get("model") {
                Some(JsonValue::String(s)) => s.clone(),
                _ => JsString::from(""),
            },
            usage: LlmUsage {
                prompt_tokens: num(v.get("usage").and_then(|u| u.get("prompt_tokens"))),
                completion_tokens: num(v.get("usage").and_then(|u| u.get("completion_tokens"))),
                total_tokens: num(v.get("usage").and_then(|u| u.get("total_tokens"))),
            },
        });
    let maybe_num = |key| match v.get(key) {
        Some(JsonValue::Number(n)) => Some(*n),
        _ => None,
    };
    CacheUsageOptions {
        customer_id: st("customerId"),
        channel_id: st("channelID"),
        external_id: match v.get("externalId") {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        },
        cost: num(v.get("cost")),
        reason: st("reason"),
        llm,
        polar_cost: maybe_num("_cost"),
        characters: maybe_num("characters"),
        usage: v.get("usage").cloned().unwrap_or(JsonValue::Object(vec![])),
    }
}
#[test]
#[ignore = "requires pinned source oracle generated in a parent-owned fixture directory"]
fn replay_every_generated_case() {
    let fixture = read_reference_fixture();
    assert_eq!(
        fixture.get("sourceHash"),
        Some(&JsonValue::String(
            "5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec".into()
        ))
    );
    let Some(JsonValue::Array(cases)) = fixture.get("cases") else {
        panic!("missing cases")
    };
    assert!(cases.len() >= 20);
    let mut visited = 0;
    for case in cases {
        visited += 1;
        let label = case.get("id").unwrap().to_json_string();
        let input = options(case.get("input").unwrap());
        if input.customer_id.is_empty() || input.channel_id.is_empty() {
            assert_eq!(
                case.get("result").unwrap().get("error"),
                Some(&JsonValue::Bool(true)),
                "{label}"
            );
            continue;
        }
        let Some(JsonValue::Array(calls)) = case.get("calls") else {
            panic!("missing calls")
        };
        let observed = calls.iter().find_map(|call| {
            let JsonValue::Array(parts) = call else {
                return None;
            };
            match parts.as_slice() {
                [
                    JsonValue::String(op),
                    JsonValue::String(key),
                    JsonValue::String(wire),
                    ..,
                ] if op.as_str() == Some("rPush")
                    && key
                        .as_str()
                        .is_some_and(|s| s.ends_with(":ai:polarshevent")) =>
                {
                    wire.as_str()
                }
                _ => None,
            }
        });
        if let Some(wire) = observed {
            assert_eq!(
                prepare_event(&input).unwrap().wire,
                wire,
                "event wire: {label}"
            );
        } else {
            assert_eq!(
                case.get("result").unwrap().get("error"),
                Some(&JsonValue::Bool(true)),
                "missing event write: {label}"
            );
        }
    }
    assert_eq!(visited, cases.len());
}

#[test]
fn generated_id_is_uuid_and_used_consistently() {
    let input = CacheUsageOptions {
        customer_id: "customer".into(),
        channel_id: "channel".into(),
        external_id: None,
        cost: 0.01,
        reason: "contextual_moderation".into(),
        llm: None,
        polar_cost: None,
        characters: None,
        usage: JsonValue::Object(vec![]),
    };
    let first = prepare_event(&input).unwrap();
    let second = prepare_event(&input).unwrap();
    let id = first.external_id.as_str().unwrap();
    assert!(uuid::Uuid::parse_str(id.strip_prefix("aiu_").unwrap()).is_ok());
    assert_ne!(first.external_id, second.external_id);
    assert_eq!(
        first.context.get("entryId"),
        Some(&JsonValue::String(first.external_id.clone()))
    );
    assert_eq!(
        first.context.get("requestId"),
        Some(&JsonValue::String(first.external_id.clone()))
    );
    let event = parse_json(&first.wire).unwrap();
    assert_eq!(
        event.get("externalId"),
        Some(&JsonValue::String(first.external_id.clone()))
    );
    assert_eq!(
        event.get("metadata").unwrap().get("entry_id"),
        Some(&JsonValue::String(first.external_id))
    );
}

#[tokio::test]
#[ignore = "private task-owned keyword Redis and explicit owner required"]
async fn concrete_cache_queue_and_projection() {
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_OWNER").as_deref(),
        Ok("polar-cache-usage")
    );
    let url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").unwrap();
    assert_eq!(url, "redis://keyword-redis:6379/");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let middle = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert_eq!(middle.len(), 12);
    assert!(
        middle
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let channel = format!("{namespace}channel");
    let queue = format!("twitch:{channel}:ai:polarshevent");
    let lock = format!("locks:polar-ingest:{channel}");
    let receipt = "cron:ai-usage-receipts:queue";
    let client = redis::Client::open(url).unwrap();
    let mut cache = redis::aio::ConnectionManager::new(client).await.unwrap();
    let existing: i64 = redis::cmd("EXISTS")
        .arg(&[queue.as_str(), lock.as_str(), receipt])
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(existing, 0, "fixture owns a fresh private Redis");
    // A task-owned loopback peer receives the concrete transport, never analytics.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/batch/", listener.local_addr().unwrap());
    let peer = std::thread::spawn(move || {
        use std::io::{Read, Write};
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut block = [0u8; 4096];
        let body_start = loop {
            let n = socket.read(&mut block).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&block[..n]);
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let headers = String::from_utf8(bytes[..body_start].to_vec()).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(k, v)| {
                    if k.eq_ignore_ascii_case("content-length") {
                        Some(v.trim().parse().unwrap())
                    } else {
                        None
                    }
                })
            })
            .unwrap();
        while bytes.len() - body_start < length {
            let n = socket.read(&mut block).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&block[..n]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .unwrap();
        String::from_utf8(bytes[body_start..body_start + length].to_vec()).unwrap()
    });
    let mut config = PosthogLosslessConfig::new("fixture", endpoint);
    config.flush_interval = Duration::from_secs(3600);
    config.flush_at = 1000;
    let tracking = PosthogTracking::from_lossless_config(config).unwrap();
    let adapter = PolarCacheUsage::with_logger(
        cache.clone(),
        AiCreditProjection::new(cache.clone(), Duration::from_secs(1)),
        AiUsageProducer::new(cache.clone()),
        tracking.clone(),
        fixture_logger(std::sync::Arc::new(ConsoleCapture::default())),
    );
    redis::cmd("SET")
        .arg(&queue)
        .arg(r#"[{"old":1}]"#)
        .query_async::<()>(&mut cache)
        .await
        .unwrap();
    let input = CacheUsageOptions {
        customer_id: "customer".into(),
        channel_id: channel.as_str().into(),
        external_id: Some(format!("{namespace}moderation").into()),
        cost: 0.01,
        reason: "contextual_moderation".into(),
        llm: None,
        polar_cost: None,
        characters: None,
        usage: JsonValue::Object(vec![]),
    };
    let keys = record_command_at(
        &JsString::from(channel.as_str()),
        10.0,
        input.external_id.as_ref(),
        std::time::SystemTime::now(),
    )
    .unwrap()
    .unwrap()
    .keys;
    let prior: i64 = redis::cmd("EXISTS")
        .arg(&keys)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(prior, 0);
    redis::cmd("SET")
        .arg(&keys[0])
        .arg(r#"{"version":3,"available":true,"balance":5000,"used":0,"limit":5000}"#)
        .query_async::<()>(&mut cache)
        .await
        .unwrap();
    assert!(!adapter.ingest(&input).await.error);
    assert!(!adapter.ingest(&input).await.error);
    let snapshot: String = redis::cmd("GET")
        .arg(&keys[0])
        .query_async(&mut cache)
        .await
        .unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["balance"], 4990);
    assert_eq!(snapshot["used"], 10);
    let list: Vec<String> = redis::cmd("LRANGE")
        .arg(&queue)
        .arg(0)
        .arg(-1)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0], r#"{"old":1}"#);
    assert_eq!(list[1], prepare_event(&input).unwrap().wire);
    assert_eq!(list[2], list[1]);
    let receipts: i64 = redis::cmd("LLEN")
        .arg(receipt)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(receipts, 2);
    assert_eq!(
        redis::cmd("EXISTS")
            .arg(&lock)
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        0
    );
    // A future lease is honored, then the caller queues without owning it.
    redis::cmd("SET")
        .arg(&lock)
        .arg("fixture-other-owner")
        .arg("PX")
        .arg(8000)
        .query_async::<()>(&mut cache)
        .await
        .unwrap();
    let start = tokio::time::Instant::now();
    let response = adapter.ingest(&input).await;
    let elapsed = start.elapsed();
    assert!(!response.error);
    assert_eq!(
        response.message.as_deref(),
        Some("queued (flush in progress)")
    );
    assert!(
        elapsed >= Duration::from_millis(2400) && elapsed < Duration::from_secs(5),
        "{elapsed:?}"
    );
    let token: String = redis::cmd("GET")
        .arg(&lock)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(token, "fixture-other-owner");
    let ttl: i64 = redis::cmd("PTTL")
        .arg(&lock)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(ttl > 0 && ttl <= 8000);
    let _: i64 = redis::cmd("DEL")
        .arg(&lock)
        .arg(&queue)
        .query_async(&mut cache)
        .await
        .unwrap();
    // A valid JSON null is deleted, then `.length` fails before the new push.
    redis::cmd("SET")
        .arg(&queue)
        .arg("null")
        .query_async::<()>(&mut cache)
        .await
        .unwrap();
    let failed = adapter.ingest(&input).await;
    assert!(failed.error);
    assert_eq!(
        redis::cmd("EXISTS")
            .arg(&queue)
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        0
    );
    // Wrong receipt type fails after event/projection; it remains best effort.
    redis::cmd("DEL")
        .arg(receipt)
        .arg(&keys)
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    redis::cmd("SET")
        .arg(receipt)
        .arg("fixture-wrongtype")
        .query_async::<()>(&mut cache)
        .await
        .unwrap();
    redis::cmd("RPUSH")
        .arg(&keys[0])
        .arg("fixture-wrongtype")
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    assert!(!adapter.ingest(&input).await.error);
    assert_eq!(
        redis::cmd("LLEN")
            .arg(&queue)
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        redis::cmd("GET")
            .arg(receipt)
            .query_async::<String>(&mut cache)
            .await
            .unwrap(),
        "fixture-wrongtype"
    );
    assert_eq!(
        redis::cmd("EXISTS")
            .arg(&keys[3])
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        1,
        "projection's marker precedes its failed snapshot read"
    );
    tracking.flush().await.unwrap();
    let batch: serde_json::Value = serde_json::from_str(&peer.join().unwrap()).unwrap();
    let events = batch["batch"].as_array().unwrap();
    assert_eq!(events.len(), 4);
    for event in events {
        assert_eq!(event["event"], "ai_usage_recorded");
        assert_eq!(
            event["properties"]["$insert_id"],
            format!("{namespace}moderation")
        );
        assert_eq!(event["properties"]["credits"], 10);
    }
    // A wrong-type Polar queue fails before projection or receipt.
    redis::cmd("DEL")
        .arg(&queue)
        .arg(&keys)
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    redis::cmd("SADD")
        .arg(&queue)
        .arg("wrong-type")
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    assert!(adapter.ingest(&input).await.error);
    assert_eq!(
        redis::cmd("EXISTS")
            .arg(&keys[3])
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        0
    );
    redis::cmd("DEL")
        .arg(&[queue.as_str(), lock.as_str(), receipt])
        .arg(&keys)
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
}

#[path = "support/polar_cache_usage.rs"]
mod polar_support;

fn fixture_namespace() -> String {
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_OWNER").as_deref(),
        Ok("polar-cache-usage")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let suffix = ns
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert_eq!(suffix.len(), 12);
    assert!(
        suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    ns
}
#[derive(Default)]
struct ConsoleCapture {
    records: std::sync::Mutex<Vec<serde_json::Value>>,
    recorder: Option<polar_support::Recorder>,
}
impl dima_rust::utils::logger::ConsoleSink for ConsoleCapture {
    fn write(
        &self,
        record: dima_rust::utils::logger::ConsoleRecord,
    ) -> dima_rust::utils::logger::SinkFuture<'_> {
        Box::pin(async move {
            if let Some(recorder) = &self.recorder {
                recorder.note("@log", &record.json);
            }
            self.records
                .lock()
                .unwrap()
                .push(serde_json::from_str(&record.json).unwrap());
            Ok(())
        })
    }
}
fn fixture_logger(capture: std::sync::Arc<ConsoleCapture>) -> dima_rust::utils::logger::Logger {
    use dima_rust::utils::logger::{Logger, LoggerConfig, SinkHandles, SystemClock, UuidSource};
    use std::sync::Arc;
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            console: Some(capture),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .unwrap()
}
fn fixture_tracking() -> PosthogTracking {
    let mut config = PosthogLosslessConfig::new("fixture", "http://127.0.0.1:9/batch/");
    config.flush_interval = Duration::from_secs(3600);
    config.flush_at = 1000;
    PosthogTracking::from_lossless_config(config).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis, exact owner and task namespace"]
async fn native_atomic_release_and_lost_polar_rpush_reply() {
    use polar_support::{Catch, Fault, Proxy, bounded};
    use std::sync::Arc;
    let namespace = fixture_namespace();
    let mut control = bounded(redis::aio::ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").unwrap(),
    ))
    .await
    .unwrap();
    let receipt = "cron:ai-usage-receipts:queue";
    for (label, fault) in [
        ("changed-owner", Fault::Hold),
        ("lost-reply", Fault::LoseReply),
    ] {
        let channel = format!("{namespace}{label}");
        let queue = format!("twitch:{channel}:ai:polarshevent");
        let lock = format!("locks:polar-ingest:{channel}");
        let external = format!("{namespace}{label}-event");
        let input = CacheUsageOptions {
            customer_id: "fixture-customer".into(),
            channel_id: channel.as_str().into(),
            external_id: Some(external.as_str().into()),
            cost: 0.01,
            reason: "contextual_moderation".into(),
            llm: None,
            polar_cost: None,
            characters: None,
            usage: JsonValue::Object(vec![]),
        };
        let keys = record_command_at(
            &input.channel_id,
            10.0,
            input.external_id.as_ref(),
            std::time::SystemTime::now(),
        )
        .unwrap()
        .unwrap()
        .keys;
        let exists: i64 = bounded(
            redis::cmd("EXISTS")
                .arg(&[queue.as_str(), lock.as_str(), receipt])
                .arg(&keys)
                .query_async(&mut control),
        )
        .await
        .unwrap();
        assert_eq!(exists, 0, "never overwrite another fixture's resources");
        let proxy = Proxy::new();
        let through = bounded(redis::aio::ConnectionManager::new(
            redis::Client::open(proxy.url()).unwrap(),
        ))
        .await
        .unwrap();
        let capture = Arc::new(ConsoleCapture::default());
        let logger = fixture_logger(capture.clone());
        let adapter = PolarCacheUsage::with_logger(
            through.clone(),
            AiCreditProjection::new(through.clone(), Duration::from_secs(2)),
            AiUsageProducer::new(through),
            fixture_tracking(),
            logger,
        );
        let expected = prepare_event(&input).unwrap().wire;
        let run = Catch(Box::pin(async {
            proxy.arm("RPUSH", &queue, fault);
            let task = tokio::spawn({
                let adapter = adapter.clone();
                let input = input.clone();
                async move { adapter.ingest(&input).await }
            });
            proxy.applied().await;
            // Upstream acknowledged RPUSH: independent socket observes the one item.
            let rows: Vec<String> = bounded(
                redis::cmd("LRANGE")
                    .arg(&queue)
                    .arg(0)
                    .arg(-1)
                    .query_async(&mut control),
            )
            .await
            .unwrap();
            assert_eq!(rows, vec![expected.clone()]);
            if fault == Fault::Hold {
                let prior: String = bounded(redis::cmd("GET").arg(&lock).query_async(&mut control))
                    .await
                    .unwrap();
                assert_ne!(prior, "new-owner");
                assert!(uuid::Uuid::parse_str(&prior).is_ok());
                let ttl: i64 = bounded(redis::cmd("PTTL").arg(&lock).query_async(&mut control))
                    .await
                    .unwrap();
                assert!(ttl > 0 && ttl <= 8000, "source 8-second PX lease");
                bounded(
                    redis::cmd("SET")
                        .arg(&lock)
                        .arg("new-owner")
                        .arg("PX")
                        .arg(8000)
                        .query_async::<()>(&mut control),
                )
                .await
                .unwrap();
                proxy.release();
                let response = bounded(task).await.unwrap();
                assert!(!response.error);
                let current: String =
                    bounded(redis::cmd("GET").arg(&lock).query_async(&mut control))
                        .await
                        .unwrap();
                assert_eq!(
                    current, "new-owner",
                    "atomic release retains replacement owner"
                );
            } else {
                let response = bounded(task).await.unwrap();
                assert!(response.error, "reply loss has unknown write outcome");
                let rows: Vec<String> = bounded(
                    redis::cmd("LRANGE")
                        .arg(&queue)
                        .arg(0)
                        .arg(-1)
                        .query_async(&mut control),
                )
                .await
                .unwrap();
                assert_eq!(
                    rows,
                    vec![expected.clone()],
                    "applied queue write was not replayed"
                );
                assert!(
                    capture
                        .records
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|v| v["data"]["function"] == "ingestPolarSHEvent")
                );
            }
            assert_eq!(
                proxy.count("RPUSH", &queue),
                1,
                "single forwarded Polar RPUSH across reconnect"
            );
            let releases = proxy
                .commands()
                .iter()
                .filter(|args| {
                    args.first()
                        .is_some_and(|v| v.eq_ignore_ascii_case(b"EVAL"))
                        && args.get(1).is_some_and(|v| {
                            v.as_slice()
                                == dima_rust::utils::ai_usage_lock::RELEASE_SCRIPT.as_bytes()
                        })
                })
                .count();
            assert_eq!(
                releases, 1,
                "one owner-checked release EVAL, never replayed"
            );
        }))
        .await;
        proxy.release();
        // Only keys whose namespace/empty precondition was proven above.
        let cleanup = Catch(Box::pin(async {
            let rows: Vec<String> = bounded(
                redis::cmd("LRANGE")
                    .arg(receipt)
                    .arg(0)
                    .arg(-1)
                    .query_async(&mut control),
            )
            .await
            .unwrap();
            for row in rows {
                let v = parse_json(&row).unwrap();
                if v.get("id") == Some(&JsonValue::String(external.as_str().into())) {
                    bounded(
                        redis::cmd("LREM")
                            .arg(receipt)
                            .arg(0)
                            .arg(row)
                            .query_async::<i64>(&mut control),
                    )
                    .await
                    .unwrap();
                }
            }
            let rest: i64 = bounded(redis::cmd("LLEN").arg(receipt).query_async(&mut control))
                .await
                .unwrap();
            assert_eq!(rest, 0, "unexpected receipt retained");
            bounded(
                redis::cmd("DEL")
                    .arg(&[queue.as_str(), lock.as_str()])
                    .arg(&keys)
                    .query_async::<i64>(&mut control),
            )
            .await
            .unwrap();
        }))
        .await;
        drop(proxy);
        if let Err(e) = cleanup {
            std::panic::resume_unwind(e);
        }
        if let Err(e) = run {
            std::panic::resume_unwind(e);
        }
    }
}

fn lossless_string(v: &JsonValue) -> &str {
    match v {
        JsonValue::String(s) => s.as_str().expect("UTF-8 protocol field"),
        _ => panic!("expected string"),
    }
}
fn array(v: &JsonValue) -> &[JsonValue] {
    match v {
        JsonValue::Array(a) => a,
        _ => panic!("expected array"),
    }
}
fn strip_receipt_dates(wire: &str) -> JsonValue {
    let JsonValue::Object(mut fields) = parse_json(wire).unwrap() else {
        panic!("receipt object")
    };
    fields.retain(|(k, _)| !matches!(k.as_str(), Some("occurredAt" | "enqueuedAt")));
    JsonValue::Object(fields)
}
fn raw_text(v: &[u8]) -> &str {
    std::str::from_utf8(v).expect("UTF-8 Redis command")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned full source corpus and fresh private keyword Redis"]
async fn replay_all_source_io_against_real_redis() {
    use dima_rust::utils::{
        ai_credit_projection::APPLY_AI_CREDIT_USAGE_SCRIPT, ai_usage_lock::RELEASE_SCRIPT,
        posthog_tracking::ai_usage_recorded,
    };
    use polar_support::{Catch, Fault, HttpPeer, Proxy, bounded};
    use std::sync::Arc;
    let namespace = fixture_namespace();
    let fixture = read_reference_fixture();
    assert_eq!(
        lossless_string(fixture.get("namespace").unwrap()),
        namespace
    );
    assert_eq!(
        lossless_string(fixture.get("sourceHash").unwrap()),
        "5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec"
    );
    let cases = array(fixture.get("cases").unwrap());
    assert!(cases.len() >= 20);
    let mut control = bounded(redis::aio::ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").unwrap(),
    ))
    .await
    .unwrap();
    let channel = format!("{namespace}channel");
    let queue = format!("twitch:{channel}:ai:polarshevent");
    let lock = format!("locks:polar-ingest:{channel}");
    let receipt = "cron:ai-usage-receipts:queue";
    let mut visited = 0;
    for case in cases {
        visited += 1;
        let id = lossless_string(case.get("id").unwrap());
        let input = options(case.get("input").unwrap());
        let expected_event = if input.customer_id.is_empty() || input.channel_id.is_empty() {
            None
        } else {
            Some(prepare_event(&input).unwrap())
        };
        let marker_keys = expected_event
            .as_ref()
            .and_then(|e| {
                record_command_at(
                    &input.channel_id,
                    e.credits,
                    Some(&e.external_id),
                    std::time::SystemTime::now(),
                )
                .unwrap()
            })
            .map(|r| r.keys);
        let mut owned = vec![queue.clone(), lock.clone(), receipt.to_owned()];
        if let Some(keys) = &marker_keys {
            owned.extend(keys.iter().cloned());
        }
        let existing: i64 = bounded(redis::cmd("EXISTS").arg(&owned).query_async(&mut control))
            .await
            .unwrap();
        assert_eq!(existing, 0, "case {id}: fixture keys must be fresh");
        if let Some(JsonValue::String(legacy)) = case.get("legacy") {
            bounded(
                redis::cmd("SET")
                    .arg(&queue)
                    .arg(legacy.to_utf8_lossy())
                    .query_async::<()>(&mut control),
            )
            .await
            .unwrap();
        }
        if case.get("contended") == Some(&JsonValue::Bool(true)) {
            bounded(
                redis::cmd("SET")
                    .arg(&lock)
                    .arg("fixture-other-owner")
                    .arg("PX")
                    .arg(8000)
                    .query_async::<()>(&mut control),
            )
            .await
            .unwrap();
        }
        let proxy = Proxy::new();
        let through = bounded(redis::aio::ConnectionManager::new(
            redis::Client::open(proxy.url()).unwrap(),
        ))
        .await
        .unwrap();
        let peer = HttpPeer::new();
        let mut config = PosthogLosslessConfig::new("fixture", peer.endpoint());
        config.flush_at = 1000;
        config.flush_interval = Duration::from_secs(3600);
        let tracking = PosthogTracking::from_lossless_config(config).unwrap();
        if id == "track-failure" {
            tracking.shutdown_posthog().await.unwrap();
        }
        let capture = Arc::new(ConsoleCapture {
            records: std::sync::Mutex::new(Vec::new()),
            recorder: Some(proxy.recorder()),
        });
        let adapter = PolarCacheUsage::with_logger(
            through.clone(),
            AiCreditProjection::new(through.clone(), Duration::from_secs(2)),
            AiUsageProducer::new(through),
            tracking.clone(),
            fixture_logger(capture.clone()),
        );
        if matches!(id, "queue-failure" | "legacy-push-failure") {
            proxy.arm("RPUSH", &queue, Fault::Reject);
        }
        if id == "receipt-failure" {
            proxy.arm("RPUSH", receipt, Fault::Reject);
        }
        if id == "projection-failure" {
            proxy.arm("EVAL", APPLY_AI_CREDIT_USAGE_SCRIPT, Fault::Reject);
        }
        if id == "changed-lock-owner" {
            proxy.arm("RPUSH", &queue, Fault::Hold);
        }
        let run = Catch(Box::pin(async {
            let task = tokio::spawn({
                let adapter = adapter.clone();
                let input = input.clone();
                async move { adapter.ingest(&input).await }
            });
            if id == "changed-lock-owner" {
                proxy.applied().await;
                bounded(
                    redis::cmd("SET")
                        .arg(&lock)
                        .arg("new-owner")
                        .arg("PX")
                        .arg(8000)
                        .query_async::<()>(&mut control),
                )
                .await
                .unwrap();
                proxy.release();
            }
            let result = bounded(task).await.unwrap();
            let source_result = case.get("result").unwrap();
            assert_eq!(
                result.error,
                source_result.get("error") == Some(&JsonValue::Bool(true)),
                "{id}: source result error"
            );
            if matches!(
                id,
                "missing-customer"
                    | "missing-channel"
                    | "legacy-null"
                    | "legacy-string"
                    | "legacy-arraylike-string"
                    | "contended"
            ) {
                assert_eq!(
                    result.message.as_deref(),
                    source_result
                        .get("message")
                        .and_then(|v| if let JsonValue::String(s) = v {
                            s.as_str()
                        } else {
                            None
                        }),
                    "{id}: source result message"
                );
            }
            if id == "changed-lock-owner" {
                assert_eq!(
                    bounded(
                        redis::cmd("GET")
                            .arg(&lock)
                            .query_async::<String>(&mut control)
                    )
                    .await
                    .unwrap(),
                    "new-owner"
                );
            }
            let source_calls = array(case.get("calls").unwrap());
            let mut expected_ops: Vec<String> = Vec::new();
            let mut expected_queue_pushes: Vec<Vec<String>> = Vec::new();
            let mut expected_receipts = Vec::new();
            let mut expected_logs = Vec::new();
            let mut expected_track = None;
            for call in source_calls {
                let c = array(call);
                let op = lossless_string(&c[0]);
                match op {
                    "set" => {
                        if expected_ops.last().map(String::as_str) != Some("acquire") {
                            expected_ops.push("acquire".into());
                        }
                    }
                    "get" if lossless_string(&c[1]).starts_with("locks:") => {
                        expected_ops.push("release".into())
                    }
                    "del" if lossless_string(&c[1]).starts_with("locks:") => {}
                    "type" | "get" | "del" => expected_ops.push(op.into()),
                    "rPush" if lossless_string(&c[1]) == receipt => {
                        expected_ops.push("receipt".into());
                        expected_receipts.push(strip_receipt_dates(lossless_string(&c[2])));
                    }
                    "rPush" => {
                        expected_ops.push("queue".into());
                        expected_queue_pushes.push(match &c[2] {
                            JsonValue::Array(v) => {
                                v.iter().map(|x| lossless_string(x).to_owned()).collect()
                            }
                            JsonValue::String(_) => vec![lossless_string(&c[2]).into()],
                            _ => panic!("source RPUSH arguments"),
                        });
                    }
                    "project" => {
                        let JsonValue::Number(credits) = &c[2] else {
                            panic!("source credits")
                        };
                        if credits.is_finite() && *credits > 0.0 {
                            expected_ops.push("project".into());
                        }
                        let event = expected_event.as_ref().unwrap();
                        assert_eq!(*credits, event.credits, "{id}: projected credits");
                        assert_eq!(&c[3], &JsonValue::String(event.external_id.clone()));
                    }
                    "error" => {
                        expected_ops.push("log".into());
                        expected_logs.push(c[1].clone());
                    }
                    "track" => {
                        expected_track = Some(c[1].clone());
                    }
                    "projection-error" => {}
                    _ => panic!("{id}: unrecognized source call {op}"),
                }
            }
            let attempts = proxy.attempts();
            let mut actual_ops: Vec<String> = Vec::new();
            let mut actual_queue_pushes = Vec::new();
            let mut actual_receipts = Vec::new();
            let mut actual_logs = Vec::new();
            for args in attempts {
                if args.is_empty() {
                    continue;
                }
                let op = raw_text(&args[0]).to_ascii_uppercase();
                match op.as_str() {
                    "CLIENT" | "HELLO" | "PING" => {}
                    "@LOG" => {
                        actual_ops.push("log".into());
                        let entry = parse_json(raw_text(&args[1])).unwrap();
                        actual_logs.push(entry.get("data").unwrap().clone());
                    }
                    "SET" if args.get(1).is_some_and(|v| v.as_slice() == lock.as_bytes()) => {
                        assert!(args.iter().any(|v| v.eq_ignore_ascii_case(b"NX")));
                        assert!(args.iter().any(|v| v.eq_ignore_ascii_case(b"PX")));
                        assert!(args.iter().any(|v| v == b"8000"));
                        if actual_ops.last().map(String::as_str) != Some("acquire") {
                            actual_ops.push("acquire".into());
                        }
                    }
                    "TYPE" | "GET" | "DEL"
                        if args
                            .get(1)
                            .is_some_and(|v| v.as_slice() == queue.as_bytes()) =>
                    {
                        actual_ops.push(op.to_ascii_lowercase())
                    }
                    "RPUSH"
                        if args
                            .get(1)
                            .is_some_and(|v| v.as_slice() == queue.as_bytes()) =>
                    {
                        actual_ops.push("queue".into());
                        actual_queue_pushes.push(
                            args[2..]
                                .iter()
                                .map(|v| raw_text(v).to_owned())
                                .collect::<Vec<_>>(),
                        );
                    }
                    "RPUSH"
                        if args
                            .get(1)
                            .is_some_and(|v| v.as_slice() == receipt.as_bytes()) =>
                    {
                        actual_ops.push("receipt".into());
                        actual_receipts.push(strip_receipt_dates(raw_text(&args[2])));
                    }
                    "EVAL"
                        if args
                            .get(1)
                            .is_some_and(|v| v.as_slice() == RELEASE_SCRIPT.as_bytes()) =>
                    {
                        assert_eq!(raw_text(&args[3]), lock);
                        actual_ops.push("release".into());
                    }
                    "EVAL"
                        if args.get(1).is_some_and(|v| {
                            v.as_slice() == APPLY_AI_CREDIT_USAGE_SCRIPT.as_bytes()
                        }) =>
                    {
                        actual_ops.push("project".into());
                        let event = expected_event.as_ref().unwrap();
                        let command = record_command_at(
                            &input.channel_id,
                            event.credits,
                            Some(&event.external_id),
                            std::time::SystemTime::now(),
                        )
                        .unwrap()
                        .unwrap();
                        assert_eq!(raw_text(&args[2]), "4");
                        for (actual, expected) in args[3..7].iter().zip(command.keys.iter()) {
                            assert_eq!(raw_text(actual), expected);
                        }
                        assert_eq!(raw_text(&args[7]), command.arguments[0]);
                        assert_eq!(raw_text(&args[9]), command.arguments[2]);
                        assert_eq!(raw_text(&args[10]), command.arguments[3]);
                        assert_eq!(raw_text(&args[11]), command.arguments[4]);
                    }
                    _ => panic!("{id}: unexpected native command {op} {args:?}"),
                }
            }
            assert_eq!(
                actual_ops, expected_ops,
                "{id}: normalized source order including diagnostics"
            );
            assert_eq!(
                actual_queue_pushes, expected_queue_pushes,
                "{id}: all Polar queue values/order"
            );
            assert_eq!(
                actual_receipts, expected_receipts,
                "{id}: receipt excluding system-clock fields"
            );
            let kind: String = bounded(redis::cmd("TYPE").arg(&queue).query_async(&mut control))
                .await
                .unwrap();
            let rows: Vec<String> = if kind == "list" {
                bounded(
                    redis::cmd("LRANGE")
                        .arg(&queue)
                        .arg(0)
                        .arg(-1)
                        .query_async(&mut control),
                )
                .await
                .unwrap()
            } else {
                assert_eq!(kind, "none", "{id}: final Polar key type");
                Vec::new()
            };
            let source_rows: Vec<_> = array(case.get("list").unwrap())
                .iter()
                .map(|v| lossless_string(v).to_owned())
                .collect();
            assert_eq!(
                rows, source_rows,
                "{id}: independently observed final queue contents"
            );
            assert_eq!(
                actual_logs.len(),
                expected_logs.len(),
                "{id}: logger call count"
            );
            for entry in capture.records.lock().unwrap().iter() {
                assert_eq!(entry["level"], "error");
                assert_eq!(entry["platform"], "twitch");
                assert_eq!(entry["channelId"], channel);
            }
            for (actual, expected) in actual_logs.iter().zip(expected_logs.iter()) {
                assert_eq!(
                    actual.get("function"),
                    expected.get("function"),
                    "{id}: diagnostic function"
                );
                if !matches!(
                    id,
                    "queue-failure" | "legacy-push-failure" | "receipt-failure"
                ) {
                    assert_eq!(
                        actual.get("error"),
                        expected.get("error"),
                        "{id}: diagnostic message"
                    );
                }
            }
            if let Some(track) = expected_track
                && id != "track-failure"
            {
                tracking.flush().await.unwrap();
                let batch = parse_json(&peer.body()).unwrap();
                let events = array(batch.get("batch").unwrap());
                assert_eq!(events.len(), 1, "{id}: analytics count");
                let expected = ai_usage_recorded(&track).unwrap();
                let actual = &events[0];
                assert_eq!(
                    actual.get("event"),
                    Some(&JsonValue::String(expected.event.into())),
                    "{id}: analytics event"
                );
                assert_eq!(
                    actual.get("distinct_id"),
                    Some(&JsonValue::String(expected.distinct_id)),
                    "{id}: analytics identity"
                );
                let Some(JsonValue::Object(mut properties)) = actual.get("properties").cloned()
                else {
                    panic!("analytics properties")
                };
                assert!(properties.iter().any(|(k, v)| k.as_str() == Some("$lib")
                    && v == &JsonValue::String("dima-rust-lossless".into())));
                properties.retain(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        Some("$lib" | "$lib_version" | "$is_server" | "$geoip_disable")
                    )
                });
                assert_eq!(
                    JsonValue::Object(properties),
                    expected.properties,
                    "{id}: analytics properties"
                );
            }
        }))
        .await;
        proxy.release();
        let cleanup = Catch(Box::pin(async {
            // The shared receipt queue was verified empty and only this case's
            // exact source entry ID may be removed from it.
            let rows: Vec<String> = bounded(
                redis::cmd("LRANGE")
                    .arg(receipt)
                    .arg(0)
                    .arg(-1)
                    .query_async(&mut control),
            )
            .await
            .unwrap();
            for row in rows {
                let value = parse_json(&row).unwrap();
                if expected_event.as_ref().is_some_and(|e| {
                    value.get("id") == Some(&JsonValue::String(e.external_id.clone()))
                }) {
                    bounded(
                        redis::cmd("LREM")
                            .arg(receipt)
                            .arg(0)
                            .arg(row)
                            .query_async::<i64>(&mut control),
                    )
                    .await
                    .unwrap();
                }
            }
            assert_eq!(
                bounded(
                    redis::cmd("LLEN")
                        .arg(receipt)
                        .query_async::<i64>(&mut control)
                )
                .await
                .unwrap(),
                0,
                "{id}: unexpected receipts preserved"
            );
            let mut owned = vec![queue.clone(), lock.clone()];
            if let Some(keys) = &marker_keys {
                owned.extend(keys.iter().cloned());
            }
            bounded(
                redis::cmd("DEL")
                    .arg(owned)
                    .query_async::<i64>(&mut control),
            )
            .await
            .unwrap();
        }))
        .await;
        drop(proxy);
        drop(peer);
        if let Err(e) = cleanup {
            std::panic::resume_unwind(e);
        }
        if let Err(e) = run {
            std::panic::resume_unwind(e);
        }
    }
    assert_eq!(visited, cases.len());
}
