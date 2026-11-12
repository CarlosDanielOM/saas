//! Replays the reference recording of the consumer runtime (`tests/fixtures/recorded_consumer.json`,
//! made by `tests/reference/record_consumer.mts` from the real `drainDomainEvents`,
//! `dispatchDomainEvents` and `replayDeadDomainEvent` with scripted handlers) and compares, step
//! by step: the drain's counts (or the error it threw), the handler calls in order, and every
//! delivery and checkpoint document field by field (BSON types, key order, missing against
//! `null`), then the admin listing.
//!
//! The same events are inserted (same ids). Generated delivery and checkpoint ids are compared
//! through what they stand for; lease tokens as "a string". Error texts are compared up to their
//! first line break: the reference stores `message + "\n" + stack`, Rust has no stack and stores
//! `message + "\n"` (an intended difference).

mod support;

use anyhow::{Context, Result, anyhow, bail, ensure};
use bson::{Bson, Document, doc};
use dima_core::{Clock, ManualClock};
use dima_events::config::EventsConfig;
use dima_events::consumer::admin;
use dima_events::consumer::{
    Consumer, ConsumerConfig, ConsumerError, DeliveryContext, DrainResult, Engine, Handler,
    ManualMonotonic, Outcome, StopReason,
};
use dima_events::contracts::Topic;
use dima_events::contracts::policy::{ConsumerDefinition, consumer_named};
use dima_events::dispatch::Dispatcher;
use dima_events::envelope::Envelope;
use dima_model::{domain_event_checkpoints, domain_event_deliveries, domain_events};
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use support::{assert_same, document, with_store};

fn script_filter() -> Document {
    doc! { "source": "recorder" }
}

fn ephemeral_filter() -> Document {
    doc! { "source": "recorder-ephemeral" }
}

fn lease_filter() -> Document {
    doc! { "source": "recorder-lease" }
}

const DOMAIN: &[Topic] = &[Topic::Domain];

static SCRIPT: ConsumerDefinition = ConsumerDefinition {
    consumer: "rec-script-v1",
    topics: DOMAIN,
    schema_versions: &[1.0],
    admin_replay: false,
    max_event_age_ms: None,
    event_filter: script_filter,
};

/// The dispatch admits every version (`schemaVersions` undefined in the recording).
static SCRIPT_ANY_VERSION: ConsumerDefinition = ConsumerDefinition {
    schema_versions: &[1.0, 2.0],
    ..SCRIPT
};

static EPHEMERAL: ConsumerDefinition = ConsumerDefinition {
    consumer: "rec-ephemeral-v1",
    topics: DOMAIN,
    schema_versions: &[1.0],
    admin_replay: false,
    max_event_age_ms: Some(300_000.0),
    event_filter: ephemeral_filter,
};

static LEASE: ConsumerDefinition = ConsumerDefinition {
    consumer: "rec-lease-v1",
    topics: DOMAIN,
    schema_versions: &[1.0],
    admin_replay: false,
    max_event_age_ms: None,
    event_filter: lease_filter,
};

/// The recording's scripted handlers (see the recorder).
#[derive(Debug)]
struct Script {
    clock: ManualClock,
    monotonic: ManualMonotonic,
    calls: Mutex<Vec<String>>,
    counts: Mutex<HashMap<String, u32>>,
    analytics_replayed: AtomicBool,
}

impl Handler for Script {
    fn handle<'a>(
        &'a self,
        event: &'a Envelope,
        _context: &'a DeliveryContext,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            if let Ok(mut calls) = self.calls.lock() {
                calls.push(event.event_key.clone());
            }
            let n = match self.counts.lock() {
                Ok(mut counts) => {
                    let n = counts.entry(event.event_key.clone()).or_insert(0);
                    *n += 1;
                    *n
                }
                Err(_) => 0,
            };
            match event.payload.at("script").as_str() {
                Some("ok") => Outcome::Done,
                Some("flaky") if n == 1 => Outcome::Failed("flaky failure".into()),
                Some("flaky") => Outcome::Done,
                Some("poison") => Outcome::Failed("poison".into()),
                Some("contract") => Outcome::Invalid("scripted invalid payload".into()),
                Some("owner") => {
                    Outcome::MissingPrerequisite("owner:recorder owner missing".into())
                }
                Some("metric") => Outcome::MissingPrerequisite("metric-session:1001".into()),
                Some("late-ok") if n == 1 => Outcome::MissingPrerequisite("stream-session".into()),
                Some("late-ok") => Outcome::Done,
                Some("slow") => {
                    self.monotonic.advance(75);
                    Outcome::Done
                }
                Some("long") => Outcome::Failed("é👋 ".repeat(3000)),
                Some("outlive") => {
                    self.clock.advance(60_001);
                    Outcome::Done
                }
                _ if self.analytics_replayed.load(Ordering::SeqCst) => Outcome::Done,
                _ => Outcome::Failed("analytics down".into()),
            }
        })
    }
}

fn result_json(result: &DrainResult) -> Json {
    json!({
        "ready": result.ready, "scanned": result.scanned, "succeeded": result.succeeded,
        "skipped": result.skipped, "alreadyComplete": result.already_complete,
        "retried": result.retried, "dead": result.dead, "deferred": result.deferred,
    })
}

/// The text up to and including its first line break (the reference adds a stack after it).
fn first_line(text: &str) -> String {
    match text.find('\n') {
        Some(at) => text.get(..=at).unwrap_or(text).to_owned(),
        None => text.to_owned(),
    }
}

/// Generated ids by meaning, upsert key order fixed, tokens and error texts as described.
fn normalized(mut document: Document) -> Document {
    if let Some(Bson::String(_)) = document.get("leaseToken") {
        document.insert("leaseToken", "<token>");
    }
    for field in ["lastError", "lastDeadLetterError", "skipReason"] {
        if let Some(Bson::String(text)) = document.get(field) {
            let line = first_line(text);
            document.insert(field, line);
        }
    }
    // An upsert copies its filter's equality fields right after `_id`, in an order the server
    // does not fix.
    let second = if document.contains_key("eventKey") {
        "eventKey"
    } else {
        "topic"
    };
    let leading: Vec<String> = document.keys().take(3).cloned().collect();
    let mut ordered = Document::new();
    ordered.insert("_id", "generated");
    if leading == ["_id", second, "consumer"] || leading == ["_id", "consumer", second] {
        for key in ["consumer", second] {
            ordered.insert(key, document.get(key).cloned().unwrap_or(Bson::Null));
        }
        for (key, value) in document.iter().skip(3) {
            ordered.insert(key.clone(), value.clone());
        }
    } else {
        for (key, value) in document.iter().skip(1) {
            ordered.insert(key.clone(), value.clone());
        }
    }
    ordered
}

async fn all(
    store: &dima_store::mongo::MongoStore,
    collection: &str,
    sort: Document,
) -> Result<Vec<Document>> {
    Ok(store
        .documents(collection)
        .find(doc! {})
        .sort(sort)
        .await?
        .try_collect()
        .await?)
}

fn compare(expected: &[Json], actual: &[Document], what: &str, step: &str) -> Result<()> {
    ensure!(
        expected.len() == actual.len(),
        "{step}: {} {what} recorded, {} found",
        expected.len(),
        actual.len()
    );
    for (want, got) in expected.iter().zip(actual) {
        let want = document(want)?;
        let name = format!(
            "{step}: {}/{}",
            want.get_str("consumer").unwrap_or_default(),
            want.get_str("eventKey")
                .or_else(|_| want.get_str("topic"))
                .unwrap_or_default()
        );
        assert_same(
            &Bson::Document(normalized(want)),
            &Bson::Document(normalized(got.clone())),
            &name,
        )?;
    }
    Ok(())
}

/// A listing's delivery entries by `consumer/eventKey`, with `_id` and tokens left out.
fn listed(data: &Json) -> HashMap<String, Json> {
    data["deliveries"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut item = item.clone();
                    if let Some(map) = item.as_object_mut() {
                        map.remove("_id");
                        for field in ["lastError", "lastDeadLetterError", "skipReason"] {
                            if let Some(Json::String(text)) = map.get(field) {
                                let line = first_line(text);
                                map.insert(field.into(), Json::String(line));
                            }
                        }
                    }
                    let key = format!(
                        "{}/{}",
                        item["consumer"].as_str().unwrap_or_default(),
                        item["eventKey"].as_str().unwrap_or_default()
                    );
                    (key, item)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runtime_writes_what_the_reference_writes() -> Result<()> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/recorded_consumer.json"
    );
    let recording: Json = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    with_store(|store| async move {
        let now = recording["nowMs"].as_i64().context("nowMs")?;
        let clock = ManualClock::new(now);
        let monotonic = ManualMonotonic::default();
        support::indexes(&store, &domain_events::INFO).await?;
        let deliveries_report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        support::indexes(&store, &domain_event_checkpoints::INFO).await?;
        let events: Vec<Document> = recording["events"]
            .as_array()
            .context("events")?
            .iter()
            .map(document)
            .collect::<Result<_>>()?;
        store
            .documents(domain_events::COLLECTION)
            .insert_many(events)
            .await?;

        let script = Arc::new(Script {
            clock: clock.clone(),
            monotonic: monotonic.clone(),
            calls: Mutex::new(Vec::new()),
            counts: Mutex::new(HashMap::new()),
            analytics_replayed: AtomicBool::new(false),
        });
        let analytics = consumer_named("stream-analytics-v1").context("registry")?;
        let consumers: HashMap<&str, (Consumer, i64)> = [
            ("script", (&SCRIPT, 5)),
            ("ephemeral", (&EPHEMERAL, 5)),
            ("lease", (&LEASE, 2)),
            ("analytics", (analytics, 2)),
        ]
        .into_iter()
        .map(|(name, (definition, attempts))| {
            let handler: Arc<dyn Handler> = script.clone();
            (
                name,
                (
                    Consumer {
                        definition,
                        handler,
                    },
                    attempts,
                ),
            )
        })
        .collect();
        let engine = |attempts: i64| -> Result<Engine> {
            Ok(Engine::new(
                store.clone(),
                Arc::new(clock.clone()),
                Arc::new(dima_core::SeededRandom::new(5)),
                ConsumerConfig {
                    max_attempts: attempts,
                    ..ConsumerConfig::default()
                },
                &EventsConfig::default(),
                &deliveries_report,
            )?
            .with_monotonic(Arc::new(monotonic.clone())))
        };
        let dispatched: &'static [ConsumerDefinition] =
            Box::leak(Box::new([SCRIPT_ANY_VERSION, *analytics]));
        let dispatcher = Dispatcher::new(
            store.clone(),
            Arc::new(clock.clone()),
            &EventsConfig::default(),
            dispatched,
            &deliveries_report,
        )?;
        let shutdown = dima_core::Shutdown::new();
        let deadline = std::time::Duration::from_secs(10);

        let steps = recording["steps"].as_array().context("steps")?;
        for step in steps {
            let name = step["name"].as_str().unwrap_or_default();
            let action = &step["action"];
            clock.set(step["at"].as_i64().context("at")?);
            let before = script.calls.lock().map(|c| c.len()).unwrap_or(0);
            let value: Json = match action["kind"].as_str().unwrap_or_default() {
                "drain" => {
                    let which = action["consumer"].as_str().unwrap_or_default();
                    let (consumer, attempts) = consumers.get(which).context("consumer")?;
                    match engine(*attempts)?.drain(consumer, &shutdown).await {
                        Ok(result) => result_json(&result),
                        Err(ConsumerError::Stopped {
                            reason: StopReason::LeaseLost,
                            ..
                        }) => json!({ "error": "Domain event execution lease expired" }),
                        Err(error) => bail!("{name}: {error}"),
                    }
                }
                "dispatch" => json!(dispatcher.dispatch(500).await?.events),
                "replay" => {
                    let replayed = admin::replay(
                        &store,
                        deadline,
                        clock.now_ms(),
                        action["consumer"].as_str().unwrap_or_default(),
                        action["eventKey"].as_str().unwrap_or_default(),
                    )
                    .await?
                    .map_err(|e| anyhow!("{e}"))?;
                    if replayed {
                        script.analytics_replayed.store(true, Ordering::SeqCst);
                    }
                    json!(replayed)
                }
                "delete" => {
                    let deleted = store
                        .documents(domain_events::COLLECTION)
                        .delete_one(
                            doc! { "eventKey": action["eventKey"].as_str().unwrap_or_default() },
                        )
                        .await?;
                    json!(deleted.deleted_count)
                }
                other => bail!("unknown action {other}"),
            };
            ensure!(
                value == step["value"],
                "{name}: result\n  expected {}\n  actual   {value}",
                step["value"]
            );
            let calls: Vec<String> = script
                .calls
                .lock()
                .map(|c| c.get(before..).unwrap_or_default().to_vec())
                .unwrap_or_default();
            ensure!(
                json!(calls) == step["calls"],
                "{name}: handler calls\n  expected {}\n  actual   {calls:?}",
                step["calls"]
            );
            ensure!(
                json!(clock.now_ms()) == step["after"],
                "{name}: the clock after the step"
            );
            let delivered = all(
                &store,
                domain_event_deliveries::COLLECTION,
                doc! { "consumer": 1, "eventKey": 1 },
            )
            .await?;
            compare(
                step["deliveries"].as_array().context("deliveries")?,
                &delivered,
                "deliveries",
                name,
            )?;
            let checkpoints = all(
                &store,
                domain_event_checkpoints::COLLECTION,
                doc! { "consumer": 1, "topic": 1 },
            )
            .await?;
            compare(
                step["checkpoints"].as_array().context("checkpoints")?,
                &checkpoints,
                "checkpoints",
                name,
            )?;
        }

        // The admin listing on the final state.
        clock.set(now + 7_000);
        let full = listed(&recording["listings"][0]["data"]);
        for listing in recording["listings"].as_array().context("listings")? {
            let status = listing["status"].as_str().filter(|s| !s.is_empty());
            let consumer = listing["consumer"].as_str().filter(|s| !s.is_empty());
            let limit = listing["limit"].as_i64().unwrap_or(25);
            let data = admin::list(&store, deadline, status, consumer, limit)
                .await?
                .to_json();
            let expected = &listing["data"];
            ensure!(
                data["total"] == expected["total"],
                "listing total {status:?} {consumer:?}"
            );
            ensure!(
                data["statusCounts"] == expected["statusCounts"],
                "listing counts {status:?} {consumer:?}: {} / {}",
                data["statusCounts"],
                expected["statusCounts"]
            );
            let got = listed(&data);
            ensure!(
                got.len() == listed(expected).len(),
                "listing size {status:?} {consumer:?}"
            );
            for (key, item) in &got {
                ensure!(
                    full.get(key) == Some(item),
                    "listing {key}\n  expected {:?}\n  actual   {item}",
                    full.get(key)
                );
            }
            // Newest update first.
            let times: Vec<&str> = data["deliveries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| d["updatedAt"].as_str().unwrap_or_default())
                .collect();
            ensure!(times.windows(2).all(|w| w[0] >= w[1]), "listing order");
            let expected_times: Vec<&str> = expected["deliveries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| d["updatedAt"].as_str().unwrap_or_default())
                .collect();
            ensure!(
                times == expected_times,
                "listing times {status:?} {consumer:?}"
            );
        }
        Ok(())
    })
    .await
}

#[test]
fn the_recording_names_the_frozen_reference() -> Result<()> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/recorded_consumer.json"
    );
    let recording: Json = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    ensure!(
        recording["reference"]
            .as_str()
            .is_some_and(|r| r.starts_with("0c71108e")),
        "recorded from {}",
        recording["reference"]
    );
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    for (file, hash) in recording["sources"].as_object().context("sources")? {
        let bytes = std::fs::read(format!("{root}/{file}")).with_context(|| file.clone())?;
        ensure!(
            dima_core::crypto::sha256(&bytes).hex() == hash.as_str().unwrap_or_default(),
            "{file} changed since the recording"
        );
    }
    Ok(())
}
