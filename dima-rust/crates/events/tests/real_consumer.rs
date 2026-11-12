//! The consumer runtime against the production copy (`domdimabot`, read only: nothing here
//! writes).
//!
//! - Every delivery decodes with the model's read type and is in a state the runtime knows what
//!   to do with (counted by consumer, status and what a pass would do to it).
//! - A dry run of selection for every registered consumer: the deliveries a pass would take now
//!   and the journal events it would read next, compared with the reference's queries
//!   (`utils/domain_event_consumer.ts:517` and `:560`) run as written; every selected event
//!   decodes as the envelope a handler gets.
//! - Every journal event decodes as the runtime reads it.

mod support;

use anyhow::{Context, Result, ensure};
use bson::{Bson, Document, doc};
use dima_core::{Clock, SystemClock, SystemRandom};
use dima_events::config::EventsConfig;
use dima_events::consumer::{Consumer, ConsumerConfig, DeliveryContext, Engine, Handler, Outcome};
use dima_events::contracts::policy::{CONSUMERS, PolicyDecision, evaluate};
use dima_events::dispatch::DispatchEvent;
use dima_events::envelope::Envelope;
use dima_model::index::{IndexError, IndexOutcome, IndexStatus};
use dima_model::{IndexReport, StrEnum, domain_event_deliveries as deliveries, domain_events};
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use std::collections::BTreeMap;
use std::sync::Arc;

const STATUSES: [&str; 6] = [
    "pending",
    "processing",
    "retry",
    "succeeded",
    "skipped",
    "dead",
];
const CODES: [&str; 7] = [
    "",
    "prerequisite_missing",
    "contract_invalid",
    "handler_failed",
    "interrupted",
    "journal_missing",
    "policy_rejected",
];
const KINDS: [&str; 5] = ["", "owner", "subject", "metric", "other"];

/// A handler that is never called (the dry run claims nothing).
#[derive(Debug)]
struct Never;

impl Handler for Never {
    fn handle<'a>(&'a self, _: &'a Envelope, _: &'a DeliveryContext) -> BoxFuture<'a, Outcome> {
        Box::pin(async { Outcome::Failed("the dry run never runs a handler".into()) })
    }
}

fn date_ms(document: &Document, field: &str) -> Option<i64> {
    match document.get(field) {
        Some(Bson::DateTime(at)) => Some(at.timestamp_millis()),
        _ => None,
    }
}

/// The report `Engine::new` needs, from the copy's own indexes (read only: `ensure_indexes`
/// would create them).
async fn existing_indexes(store: &dima_store::mongo::MongoStore) -> Result<IndexReport> {
    let names = store
        .documents(deliveries::COLLECTION)
        .list_index_names()
        .await?;
    Ok(IndexReport {
        collection: deliveries::COLLECTION,
        outcomes: deliveries::INDEXES
            .iter()
            .map(|spec| IndexOutcome {
                index: spec.name(),
                required: spec.unique,
                status: if names.contains(&spec.name()) {
                    IndexStatus::Exists
                } else {
                    IndexStatus::Failed(IndexError::Deadline(std::time::Duration::ZERO))
                },
            })
            .collect(),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_production_delivery_is_in_a_state_the_runtime_understands() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let now = SystemClock.now_ms();
    let max_attempts = ConsumerConfig::default().max_attempts as f64;
    let mut by_state: BTreeMap<String, usize> = BTreeMap::new();
    let mut problems: Vec<String> = Vec::new();
    let mut total = 0_usize;
    let mut cursor = store
        .documents(deliveries::COLLECTION)
        .find(doc! {})
        .await?;
    while let Some(delivery) = cursor.try_next().await? {
        total += 1;
        let id = delivery.get("_id").cloned().unwrap_or(Bson::Null);
        let mut problem = |what: String| {
            if problems.len() < 50 {
                problems.push(format!("{id}: {what}"));
            }
        };
        let raw = bson::RawDocumentBuf::try_from(&delivery)?;
        if let Err(error) = (deliveries::INFO.decode)(&raw) {
            problem(format!("does not decode: {error}"));
        }
        let status = delivery.get_str("status").unwrap_or("<missing>");
        let consumer = delivery.get_str("consumer").unwrap_or("<missing>");
        if !STATUSES.contains(&status) {
            problem(format!("status {status}"));
        }
        for (field, vocabulary) in [
            ("lastErrorCode", &CODES[..]),
            ("lastPrerequisiteKind", &KINDS[..]),
        ] {
            match delivery.get(field) {
                None => {}
                Some(Bson::String(value)) if vocabulary.contains(&value.as_str()) => {}
                Some(other) => problem(format!("{field} {other}")),
            }
        }
        let attempts = delivery
            .get("attempts")
            .and_then(dima_store::mongo::number::read_number);
        if attempts.is_none_or(|n| n < 0.0 || n.fract() != 0.0) {
            problem(format!("attempts {:?}", delivery.get("attempts")));
        }
        for field in ["eventID", "eventKey", "topic", "expiresAt"] {
            if !delivery.contains_key(field) {
                problem(format!("{field} missing"));
            }
        }
        let attempts = attempts.unwrap_or(0.0);
        // What a pass of the runtime does with it now.
        let action = match status {
            "succeeded" | "skipped" | "dead" => "final (left as it is)",
            "pending" if attempts >= max_attempts => "ready: retired dead (interrupted)",
            "pending" => "ready: claimed",
            "retry" => match date_ms(&delivery, "nextAttemptAt") {
                Some(at) if at <= now && attempts >= max_attempts => {
                    "ready: retired dead (interrupted)"
                }
                Some(at) if at <= now => "ready: claimed",
                Some(_) => "waits for its retry time",
                None => "retry without a time: only the journal scan takes it",
            },
            "processing" => match date_ms(&delivery, "lockedUntil") {
                Some(at) if at > now => "leased: waits for the lease",
                _ if attempts >= max_attempts => "ready: retired dead (interrupted)",
                _ => "ready: claimed again (lease expired)",
            },
            _ => "unknown",
        };
        if status == "processing" && !matches!(delivery.get("leaseToken"), Some(Bson::String(_))) {
            problem("processing without a lease token".into());
        }
        let known = CONSUMERS.iter().any(|c| c.consumer == consumer);
        let consumer = if known {
            consumer
        } else {
            "<not registered: never drained>"
        };
        *by_state
            .entry(format!("{consumer} {status}: {action}"))
            .or_default() += 1;
    }
    for (state, count) in &by_state {
        eprintln!("{count:>7}  {state}");
    }
    eprintln!("{total} deliveries");
    ensure!(
        problems.is_empty(),
        "deliveries the runtime cannot handle:\n{}",
        problems.join("\n")
    );
    ensure!(
        total > 100_000 || !support::stores_required(),
        "the copy holds {total} deliveries; expected the full production copy"
    );
    ensure!(!by_state.keys().any(|k| k.ends_with("unknown")));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dry_run_selects_what_the_reference_queries_select() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let report = existing_indexes(&store).await?;
    let clock = Arc::new(dima_core::ManualClock::new(SystemClock.now_ms()));
    let engine = Engine::new(
        store.clone(),
        clock.clone(),
        Arc::new(SystemRandom),
        ConsumerConfig::default(),
        &EventsConfig::default(),
        &report,
    )
    .context("the copy has the unique delivery index")?;
    let batch = ConsumerConfig::default().batch_size;
    let journal = store.documents(domain_events::COLLECTION);
    let mut selected = 0;
    let mut previewed = 0;
    let mut replayed: BTreeMap<&str, usize> = BTreeMap::new();
    for definition in &CONSUMERS {
        let consumer = Consumer {
            definition,
            handler: Arc::new(Never),
        };
        let now = bson::DateTime::from_millis(clock.now_ms());
        let topics: Vec<&str> = definition.topics.iter().map(|t| t.as_str()).collect();
        // `drainDomainEvents`, utils/domain_event_consumer.ts:517, as written.
        let reference: Vec<Document> = store
            .documents(deliveries::COLLECTION)
            .find(doc! {
                "consumer": definition.consumer,
                "topic": { "$in": topics.clone() },
                "$or": [
                    { "status": "pending" },
                    { "status": "retry", "nextAttemptAt": { "$lte": now } },
                    { "status": "processing", "$or": [{ "lockedUntil": Bson::Null }, { "lockedUntil": { "$lte": now } }] },
                ],
            })
            .sort(doc! { "updatedAt": 1, "_id": 1 })
            .limit(batch)
            .await?
            .try_collect()
            .await?;
        let ours = engine.select(&consumer).await?;
        let ids = |documents: &[Document]| -> Vec<Bson> {
            documents
                .iter()
                .filter_map(|d| d.get("_id").cloned())
                .collect()
        };
        ensure!(
            ids(&ours) == ids(&reference),
            "{}: ready deliveries differ",
            definition.consumer
        );
        selected += ours.len();
        for delivery in &ours {
            let event = journal
                .find_one(doc! { "_id": delivery.get("eventID").cloned().unwrap_or(Bson::Null) })
                .await?;
            if let Some(event) = event {
                DispatchEvent::from_document(&event)?;
                Envelope::from_document(&event)?;
            }
        }
        for topic in &topics {
            // utils/domain_event_consumer.ts:558-565, as written.
            let checkpoint = store
                .documents(dima_model::domain_event_checkpoints::COLLECTION)
                .find_one(doc! { "consumer": definition.consumer, "topic": *topic })
                .await?;
            let last = checkpoint
                .and_then(|c| c.get_object_id("lastEventID").ok())
                .unwrap_or_else(|| bson::oid::ObjectId::from_bytes([0; 12]));
            let mut filter = (definition.event_filter)();
            filter.insert("schemaVersion", doc! { "$in": [1] });
            filter.insert("topic", *topic);
            filter.insert("_id", doc! { "$gt": last });
            let reference: Vec<Document> = journal
                .find(filter)
                .sort(doc! { "_id": 1 })
                .limit(batch)
                .await?
                .try_collect()
                .await?;
            let (from, ours) = engine.preview(&consumer, topic).await?;
            ensure!(from == last, "{}: checkpoint", definition.consumer);
            ensure!(
                ids(&ours) == ids(&reference),
                "{} {topic}: next events differ",
                definition.consumer
            );
            previewed += ours.len();
            for event in &ours {
                DispatchEvent::from_document(event)?;
                Envelope::from_document(event)?;
            }
            // The copy's checkpoints are at the end of the journal: read again from its start and
            // from its middle, as a consumer whose checkpoint is there would.
            let middle = journal
                .find(doc! { "topic": *topic })
                .sort(doc! { "_id": 1 })
                .skip(journal.count_documents(doc! { "topic": *topic }).await? / 2)
                .limit(1)
                .await?
                .try_collect::<Vec<Document>>()
                .await?
                .first()
                .and_then(|e| e.get_object_id("_id").ok());
            let points = [Some(bson::oid::ObjectId::from_bytes([0; 12])), middle];
            for after in points.into_iter().flatten() {
                let mut filter = (definition.event_filter)();
                filter.insert("schemaVersion", doc! { "$in": [1] });
                filter.insert("topic", *topic);
                filter.insert("_id", doc! { "$gt": after });
                let reference: Vec<Document> = journal
                    .find(filter)
                    .sort(doc! { "_id": 1 })
                    .limit(batch)
                    .await?
                    .try_collect()
                    .await?;
                let ours = engine.preview_from(&consumer, topic, after).await?;
                ensure!(
                    ids(&ours) == ids(&reference),
                    "{} {topic} after {after}: events differ",
                    definition.consumer
                );
                for event in &ours {
                    let journaled = DispatchEvent::from_document(event)?;
                    let envelope = Envelope::from_document(event)?;
                    let decision = evaluate(
                        &definition.policy(),
                        journaled.policy,
                        clock.now_ms() as f64,
                    );
                    let validated = ["twitch-eventsub", "twitch-eventsub-test", "polar-webhook"]
                        .contains(&envelope.source.as_str());
                    let what = match decision {
                        PolicyDecision::Eligible
                            if validated && envelope.validate_retained(clock.now_ms()).is_err() =>
                        {
                            "dead: contract_invalid"
                        }
                        PolicyDecision::Eligible => "handed to the handler",
                        PolicyDecision::Skipped(_) => "skipped: too old",
                        PolicyDecision::Dead(_) => "dead: policy",
                    };
                    *replayed.entry(what).or_default() += 1;
                }
                previewed += ours.len();
            }
        }
    }
    eprintln!(
        "dry run: {selected} ready deliveries, {previewed} journal events read, over {} consumers; read again from the start and middle: {replayed:?}",
        CONSUMERS.len()
    );
    ensure!(
        previewed > 0 || !support::stores_required(),
        "the dry run read nothing"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_journal_event_reads_as_the_runtime_reads_it() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let mut cursor = store
        .documents(domain_events::COLLECTION)
        .find(doc! {})
        .await?;
    let mut total = 0;
    let mut without_journal_time = 0;
    while let Some(event) = cursor.try_next().await? {
        total += 1;
        let id = event.get("_id").cloned().unwrap_or(Bson::Null);
        DispatchEvent::from_document(&event).with_context(|| format!("{id}"))?;
        let envelope = Envelope::from_document(&event).with_context(|| format!("{id}"))?;
        if envelope.journaled_at_ms.is_none() {
            without_journal_time += 1;
        }
    }
    eprintln!("{total} events, {without_journal_time} without journaledAt");
    ensure!(total > 0 || !support::stores_required());
    Ok(())
}
