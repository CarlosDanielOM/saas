//! Replays the reference recording (`tests/fixtures/recorded.json`, made by
//! `tests/reference/record.mts` from the real TypeScript producers and dispatcher) and compares:
//! every normalized input, every outcome (inserted, already recorded, the error message), every
//! stored event and every delivery, field by field with BSON types, key order, missing against
//! `null`. Generated `_id`s are compared through the event keys they stand for.

mod support;

use anyhow::{Context, Result, anyhow, bail, ensure};
use bson::{Bson, Document, doc};
use dima_core::ManualClock;
use dima_events::config::EventsConfig;
use dima_events::contracts::policy::CONSUMERS;
use dima_events::contracts::{JournalInput, OccurredAt, SubjectInput, Topic};
use dima_events::dispatch::Dispatcher;
use dima_events::producers::goals::{CustomGoalContribution, GoalIngestError, ReceiptCheck};
use dima_events::producers::polar::PolarWebhook;
use dima_events::producers::twitch::TwitchNotification;
use dima_events::producers::{Journal, Observability};
use dima_events::value::{Object, Value};
use dima_model::{StrEnum, domain_event_deliveries, domain_events, users};
use futures_util::TryStreamExt;
use serde_json::Value as Json;
use std::collections::HashMap;
use std::sync::Arc;
use support::{assert_same, decode, decode_object, document, recorded, with_store};

struct NoCheck;

impl ReceiptCheck for NoCheck {
    async fn check(&self, _: &str, _: &str, _: &str, _: f64) -> Result<(), GoalIngestError> {
        Ok(())
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn twitch_input(input: &Object) -> Result<TwitchNotification> {
    Ok(TwitchNotification {
        message_id: text(input.at("messageId")).unwrap_or_default(),
        message_timestamp: text(input.at("messageTimestamp")),
        message_retry: input.at("messageRetry").as_number(),
        stale_retry: match input.at("staleRetry") {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        },
        subscription: input
            .at("subscription")
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("subscription"))?,
        event: input.at("event").clone(),
        source: text(input.at("source")),
        durable_chat_handled: input.at("durableChatHandled").truthy(),
        durable_defense_handled: input.at("durableDefenseHandled").truthy(),
    })
}

fn polar_input(input: &Object) -> PolarWebhook {
    let event = input.at("event");
    PolarWebhook {
        webhook_id: text(input.at("webhookId")).unwrap_or_default(),
        event_type: text(event.at("type")).unwrap_or_default(),
        timestamp: event.at("timestamp").clone(),
        data: event.at("data").clone(),
    }
}

fn goal_input(input: &Object) -> CustomGoalContribution {
    CustomGoalContribution {
        channel_id: text(input.at("channelID")).unwrap_or_default(),
        receipt_identity: text(input.at("receiptIdentity")).unwrap_or_default(),
        item_key: text(input.at("itemKey")).unwrap_or_default(),
        quantity: input.at("quantity").as_number().unwrap_or(f64::NAN),
        occurred_at_ms: match input.at("occurredAt") {
            Value::Date(ms) => *ms,
            _ => f64::NAN,
        },
    }
}

fn journal_input(input: &Object) -> Result<JournalInput> {
    let subject = input.at("subject").as_object().map(|subject| SubjectInput {
        provider: text(subject.at("provider")).unwrap_or_default(),
        kind: text(subject.at("kind")).unwrap_or_default(),
        id: text(subject.at("id")).unwrap_or_default(),
    });
    Ok(JournalInput {
        source: text(input.at("source")).unwrap_or_default(),
        source_event_id: text(input.at("sourceEventId")).unwrap_or_default(),
        kind: text(input.at("type")).unwrap_or_default(),
        topic: input
            .at("topic")
            .as_str()
            .and_then(Topic::parse)
            .ok_or_else(|| anyhow!("topic"))?,
        schema_version: input.at("schemaVersion").as_number(),
        owner_user_id: text(input.at("ownerUserId")),
        subject,
        channel_id: text(input.at("channelID")),
        stream_id: text(input.at("streamID")),
        occurred_at: match input.at("occurredAt") {
            Value::String(text) => Some(OccurredAt::Text(text.clone())),
            Value::Date(ms) => Some(OccurredAt::Date(*ms)),
            _ => None,
        },
        payload: input.at("payload").as_object().cloned().unwrap_or_default(),
        metadata: input.at("metadata").as_object().cloned(),
        retention_seconds: input.at("retentionSeconds").as_number(),
    })
}

/// The normalized input as the recording encodes it (top-level `undefined` properties dropped:
/// the TypeScript literal names them, the Rust input leaves them out).
fn without_undefined(object: &Object) -> Object {
    object
        .iter()
        .filter(|(_, v)| !v.is_undefined())
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

fn same_object_unordered(expected: &Object, actual: &Object, name: &str) -> Result<()> {
    let expected = without_undefined(expected);
    ensure!(
        expected.len() == actual.len(),
        "{name}: normalized keys differ\n  expected {:?}\n  actual   {:?}",
        expected.iter().map(|(k, _)| k).collect::<Vec<_>>(),
        actual.iter().map(|(k, _)| k).collect::<Vec<_>>()
    );
    for (key, value) in expected.iter() {
        let other = actual
            .get(key)
            .ok_or_else(|| anyhow!("{name}: normalized {key} missing"))?;
        // Payload and metadata are compared in order (they are stored in this order).
        ensure!(
            value == other && value.to_json() == other.to_json(),
            "{name}: normalized {key} differs\n  expected {value:?}\n  actual   {other:?}"
        );
        if let (Value::Object(a), Value::Object(b)) = (value, other) {
            let ka: Vec<&str> = a.iter().map(|(k, _)| k).collect();
            let kb: Vec<&str> = b.iter().map(|(k, _)| k).collect();
            ensure!(
                ka == kb,
                "{name}: normalized {key} key order differs: {ka:?} {kb:?}"
            );
        }
    }
    Ok(())
}

fn outcome_json(outcome: Result<Option<(bool, String)>, String>) -> Json {
    match outcome {
        Ok(None) => Json::Null,
        Ok(Some((inserted, key))) => serde_json::json!({ "inserted": inserted, "eventKey": key }),
        Err(message) => serde_json::json!({ "error": { "message": message } }),
    }
}

fn recorded_outcome(json: &Json) -> Json {
    match json.get("error") {
        Some(error) => serde_json::json!({ "error": { "message": error.get("message") } }),
        None => json.clone(),
    }
}

/// Maps a document's generated ids: `_id` of an event to its event key, `_id` of a delivery to
/// `consumer/eventKey`, `eventID` to the event key it points at.
fn normalized(mut document: Document, ids: &HashMap<bson::oid::ObjectId, String>) -> Document {
    let key = |id: Option<&Bson>| match id {
        Some(Bson::ObjectId(id)) => {
            Bson::String(ids.get(id).cloned().unwrap_or_else(|| "unknown".into()))
        }
        other => other.cloned().unwrap_or(Bson::Null),
    };
    if document.contains_key("consumer") {
        let mapped = key(document.get("eventID"));
        document.insert("eventID", mapped);
        // An upsert copies its filter's equality fields (`consumer`, `eventKey`) right after
        // `_id`, in an order the server does not fix (the reference's own recording has both
        // orders): put the two in one order, every other key keeps its place.
        let leading: Vec<String> = document.keys().take(3).cloned().collect();
        if leading == ["_id", "eventKey", "consumer"] || leading == ["_id", "consumer", "eventKey"]
        {
            let mut ordered = Document::new();
            ordered.insert("_id", "generated");
            for key in ["consumer", "eventKey"] {
                ordered.insert(key, document.get(key).cloned().unwrap_or(Bson::Null));
            }
            for (key, value) in document.iter().skip(3) {
                ordered.insert(key.clone(), value.clone());
            }
            return ordered;
        }
        document.insert("_id", "generated");
    } else {
        let mapped = key(document.get("_id"));
        document.insert("_id", mapped);
    }
    document
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

#[tokio::test]
async fn the_journal_writes_what_the_reference_writes() -> Result<()> {
    let recording = recorded()?;
    with_store(|store| async move {
        let now = recording["nowMs"].as_i64().context("nowMs")?;
        let clock = ManualClock::new(now);
        let report = support::indexes(&store, &domain_events::INFO).await?;
        support::indexes(&store, &users::INFO).await?;
        let users_seed: Vec<Document> = recording["users"]
            .as_array()
            .context("users")?
            .iter()
            .map(document)
            .collect::<Result<_>>()?;
        store.documents(users::COLLECTION).insert_many(users_seed).await?;
        let journal = Journal::new(store.clone(), Arc::new(clock.clone()), &EventsConfig::default(), &report)?;

        let cases = recording["cases"].as_array().context("cases")?;
        let mut compared = 0;
        for case in cases {
            let name = case["name"].as_str().unwrap_or_default();
            let kind = case["kind"].as_str().unwrap_or_default();
            let input = decode_object(&case["input"])?;
            clock.set(now);
            let observability = case["observability"].as_object().map(|o| Observability {
                trace_id: o["traceId"].as_str().unwrap_or_default().to_owned(),
                span_id: o["spanId"].as_str().unwrap_or_default().to_owned(),
                sampled: o["sampled"].as_bool().unwrap_or_default(),
                channel: o["channel"].as_str().unwrap_or_default().to_owned(),
                outcome: None,
            });
            // The normalization step alone.
            let normalized: Result<Option<JournalInput>, String> = match kind {
                "twitch" => dima_events::producers::twitch::normalize(&twitch_input(&input)?)
                    .map_err(|e| e.to_string()),
                "polar" => dima_events::producers::polar::normalize(&polar_input(&input), now)
                    .map(Some)
                    .map_err(|e| e.to_string()),
                "goal" => dima_events::producers::goals::normalize(&goal_input(&input))
                    .map(Some)
                    .map_err(|e| e.to_string()),
                _ => journal_input(&input).map(Some).map_err(|e| e.to_string()),
            };
            match (&case["normalizeError"], &normalized) {
                (Json::Object(error), Err(message)) => ensure!(
                    error.get("message").and_then(Json::as_str) == Some(message.as_str()),
                    "{name}: normalize error\n  expected {error:?}\n  actual   {message}"
                ),
                (Json::Object(error), Ok(_)) => bail!("{name}: expected the normalize error {error:?}"),
                (_, Err(message)) => bail!("{name}: unexpected normalize error {message}"),
                (_, Ok(None)) => ensure!(case["normalized"].is_null(), "{name}: expected an event"),
                (_, Ok(Some(event))) => {
                    let expected = decode_object(&case["normalized"])?;
                    same_object_unordered(&expected, &event.to_object(), name)?;
                }
            }
            // The whole ingest.
            let outcome: Result<Option<(bool, String)>, String> = match kind {
                "twitch" => journal
                    .ingest_twitch(&twitch_input(&input)?, observability.as_ref())
                    .await
                    .map(|r| r.map(|r| (r.inserted, r.event.event_key)))
                    .map_err(|e| e.to_string()),
                "polar" => journal
                    .ingest_polar(&polar_input(&input), observability.as_ref())
                    .await
                    .map(|r| Some((r.inserted, r.event.event_key)))
                    .map_err(|e| e.to_string()),
                "goal" => journal
                    .ingest_goal(&goal_input(&input), &NoCheck, observability.as_ref())
                    .await
                    .map(|r| Some((r.inserted, r.event.event_key)))
                    .map_err(|e| e.to_string()),
                _ => journal
                    .append(&journal_input(&input)?, observability.as_ref())
                    .await
                    .map(|r| Some((r.inserted, r.event.event_key)))
                    .map_err(|e| e.to_string()),
            };
            let expected = recorded_outcome(&case["outcome"]);
            let actual = outcome_json(outcome);
            ensure!(expected == actual, "{name}: outcome\n  expected {expected}\n  actual   {actual}");
            compared += 1;
        }
        ensure!(compared == cases.len() && compared > 70, "compared {compared} cases");

        // The stored events.
        let stored = all(&store, domain_events::COLLECTION, doc! { "eventKey": 1 }).await?;
        let expected: Vec<Document> = recording["events"].as_array().context("events")?.iter().map(document).collect::<Result<_>>()?;
        ensure!(stored.len() == expected.len(), "{} events stored, {} recorded", stored.len(), expected.len());
        let ids_of = |documents: &[Document]| -> HashMap<bson::oid::ObjectId, String> {
            documents
                .iter()
                .filter_map(|d| Some((d.get_object_id("_id").ok()?, d.get_str("eventKey").ok()?.to_owned())))
                .collect()
        };
        let (expected_ids, actual_ids) = (ids_of(&expected), ids_of(&stored));
        for (want, got) in expected.iter().zip(&stored) {
            let key = want.get_str("eventKey").unwrap_or_default().to_owned();
            assert_same(
                &Bson::Document(normalized(want.clone(), &expected_ids)),
                &Bson::Document(normalized(got.clone(), &actual_ids)),
                &key,
            )?;
        }

        // The dispatcher's fan-out.
        let dispatch = &recording["dispatch"];
        clock.set(dispatch["nowMs"].as_i64().context("dispatch.nowMs")?);
        let deliveries_report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let dispatcher = Dispatcher::new(store.clone(), Arc::new(clock.clone()), &EventsConfig::default(), &CONSUMERS, &deliveries_report)?;
        let first = dispatcher.dispatch(500).await?;
        let second = dispatcher.dispatch(500).await?;
        let counts = [first.events, second.events];
        ensure!(
            serde_json::json!(counts) == dispatch["dispatched"],
            "dispatched {counts:?}, recorded {}",
            dispatch["dispatched"]
        );
        let delivered = all(&store, domain_event_deliveries::COLLECTION, doc! { "consumer": 1, "eventKey": 1 }).await?;
        let expected: Vec<Document> = dispatch["deliveries"].as_array().context("deliveries")?.iter().map(document).collect::<Result<_>>()?;
        ensure!(delivered.len() == expected.len(), "{} deliveries, {} recorded", delivered.len(), expected.len());
        for (want, got) in expected.iter().zip(&delivered) {
            let key = format!(
                "{}/{}",
                want.get_str("consumer").unwrap_or_default(),
                want.get_str("eventKey").unwrap_or_default()
            );
            assert_same(
                &Bson::Document(normalized(want.clone(), &expected_ids)),
                &Bson::Document(normalized(got.clone(), &actual_ids)),
                &key,
            )?;
        }
        let pending = store
            .documents(domain_events::COLLECTION)
            .count_documents(doc! { "dispatchPending": true })
            .await?;
        ensure!(serde_json::json!(pending) == dispatch["pending"], "pending {pending}");

        // The admin health report on the same state, as text (key order included).
        let deliveries = store.documents(domain_event_deliveries::COLLECTION);
        deliveries
            .update_one(
                doc! { "consumer": "stream-analytics-v1" },
                doc! { "$set": { "status": "processing", "lockedUntil": bson::DateTime::from_millis(now + 30_000) } },
            )
            .await?;
        deliveries
            .update_one(
                doc! { "consumer": "polar-credits-v1" },
                doc! { "$set": { "status": "retry", "nextAttemptAt": bson::DateTime::from_millis(now), "lastErrorCode": "prerequisite_missing", "lastPrerequisiteKind": "owner", "lastAttemptDurationMs": 12.5 } },
            )
            .await?;
        store
            .documents(domain_events::COLLECTION)
            .update_one(doc! { "eventKey": "twitch-eventsub:message-1:channel.bits.received" }, doc! { "$set": { "dispatchPending": true } })
            .await?;
        let health = &recording["health"];
        let at = health["nowMs"].as_i64().context("health.nowMs")?;
        let deadline = std::time::Duration::from_secs(10);
        for (name, consumer) in [("all", None), ("widget", Some("widget-actions-v1")), ("credits", Some("polar-credits-v1")), ("empty", Some(""))] {
            let report = dima_events::health::report(&store, deadline, consumer, at).await?;
            let (expected, actual) = (serde_json::to_string(&health[name])?, serde_json::to_string(&report)?);
            ensure!(expected == actual, "health {name}\n  expected {expected}\n  actual   {actual}");
        }
        Ok(())
    })
    .await
}

#[test]
fn the_recording_names_the_frozen_reference() -> Result<()> {
    let recording = recorded()?;
    ensure!(
        recording["reference"]
            .as_str()
            .is_some_and(|r| r.starts_with("0c71108e")),
        "recorded from {}",
        recording["reference"]
    );
    // The recorded sources must still be the reference: a change in them invalidates the fixture.
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    for (file, hash) in recording["sources"].as_object().context("sources")? {
        let bytes = std::fs::read(format!("{root}/{file}")).with_context(|| file.clone())?;
        ensure!(
            dima_core::crypto::sha256(&bytes).hex() == hash.as_str().unwrap_or_default(),
            "{file} changed since the recording"
        );
    }
    let _ = decode(&Json::Null);
    Ok(())
}
