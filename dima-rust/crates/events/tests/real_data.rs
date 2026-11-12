//! Stored identities against the production copy (`domdimabot`, read only).
//!
//! For every journaled event: the event key recomputed from its stored source, provider id and
//! type; the retained contract check every consumer runs; and, for Twitch events, the whole
//! producer run again on the stored notification (type, channel, stream, subject, occurrence time,
//! metadata, retention, key) and compared with what the reference stored. For every delivery: its
//! event, key, topic and expiry, and whether its consumer's filter admits the event. For every
//! cron-job intent: its job id, active key and automatic acceptance key.
//!
//! A difference is a bug in this crate or a version of a rule not found yet. The only accepted
//! differences are named here, each with its reason, and counted in the output.

mod support;

use anyhow::{Context, Result, ensure};
use bson::{Bson, Document, doc};
use dima_events::contracts::policy::CONSUMERS;
use dima_events::envelope::Envelope;
use dima_events::identity::{automatic_acceptance_key, event_key, intent_active_key};
use dima_events::producers::twitch::{TwitchNotification, normalize};
use dima_events::value::{Object, Value};
use dima_model::StrEnum;
use futures_util::TryStreamExt;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Default)]
struct Tally {
    checked: BTreeMap<&'static str, usize>,
    explained: BTreeMap<String, usize>,
    mismatches: Vec<String>,
}

impl Tally {
    fn checked(&mut self, what: &'static str) {
        *self.checked.entry(what).or_default() += 1;
    }

    fn explained(&mut self, why: impl Into<String>) {
        *self.explained.entry(why.into()).or_default() += 1;
    }

    fn mismatch(&mut self, what: String) {
        if self.mismatches.len() < 50 {
            self.mismatches.push(what);
        }
    }
}

/// 2026-10-20T18:04:39Z, commit 568600ab.
const SHARED_CHAT_FILTER_MS: i64 = 1_792_519_479_000;

fn metadata_flag(metadata: &Object, key: &str) -> bool {
    matches!(metadata.at(key), Value::Bool(true))
}

/// The producer run again on a stored Twitch event, compared with what is stored.
fn check_twitch(event: &Envelope, tally: &mut Tally) {
    let legacy = event.subject.is_none();
    let notification = TwitchNotification {
        message_id: event.source_event_id.clone(),
        message_timestamp: event.metadata.at("messageTimestamp").as_str().map(str::to_owned),
        message_retry: event.metadata.at("messageRetry").as_number(),
        stale_retry: match event.metadata.at("staleRetry") {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        },
        subscription: event.payload.at("subscription").as_object().cloned().unwrap_or_default(),
        event: event.payload.at("event").clone(),
        source: Some(event.source.clone()),
        durable_chat_handled: metadata_flag(&event.metadata, "durableChatHandled"),
        durable_defense_handled: metadata_flag(&event.metadata, "durableDefenseHandled"),
    };
    let normalized = match normalize(&notification) {
        Ok(Some(normalized)) => normalized,
        Ok(None) => {
            // `isForeignSharedChatEvent` arrived with 568600ab (2026-10-20 18:04:39 UTC); copies
            // journaled before it are a former version of the rule.
            let original = event.metadata.at("originalEventType").as_str().unwrap_or_default();
            if dima_events::producers::twitch::is_foreign_shared_chat_event(original, &notification.event)
                && event.journaled_at_ms.is_some_and(|at| at < SHARED_CHAT_FILTER_MS)
            {
                tally.explained(
                    "shared-chat copy from another channel journaled before 568600ab (2026-10-20) added the filter",
                );
            } else {
                tally.mismatch(format!("{}: the producer would not journal it", event.event_key));
            }
            return;
        }
        Err(error) => {
            tally.mismatch(format!("{}: the producer refuses it: {error}", event.event_key));
            return;
        }
    };
    tally.checked("twitch events re-produced");
    let key = event_key(&normalized.source, &normalized.source_event_id, &normalized.kind);
    if key.as_deref() != Ok(event.event_key.as_str()) {
        tally.mismatch(format!("{}: re-produced key {key:?}", event.event_key));
    }
    if normalized.kind != event.kind {
        tally.mismatch(format!("{}: type {} re-produced as {}", event.event_key, event.kind, normalized.kind));
    }
    if normalized.channel_id != event.channel_id {
        tally.mismatch(format!("{}: channel {:?} re-produced as {:?}", event.event_key, event.channel_id, normalized.channel_id));
    }
    if normalized.stream_id.filter(|s| !s.is_empty()) != event.stream_id {
        tally.mismatch(format!("{}: stream re-produced differently", event.event_key));
    }
    match (&normalized.subject, &event.subject) {
        (Some(want), Some(got)) => {
            if want.provider != got.provider || want.kind != got.kind || want.id != got.id {
                tally.mismatch(format!("{}: subject re-produced differently", event.event_key));
            }
        }
        (Some(_), None) => tally.explained(
            "legacy Twitch row journaled before subjects existed (pre-75e22ef: no subject, owner or durable markers)",
        ),
        _ => tally.mismatch(format!("{}: no subject re-produced", event.event_key)),
    }
    match &normalized.occurred_at {
        Some(dima_events::contracts::OccurredAt::Text(text)) => {
            if dima_text::parse_date(text) != Some(event.occurred_at_ms) {
                tally.mismatch(format!("{}: occurredAt {text} stored as {}", event.event_key, event.occurred_at_ms));
            }
        }
        _ => tally.explained("no provider time: occurredAt was the journal time (not recomputable)"),
    }
    // Metadata: every producer field stored as produced (observability is the trace context).
    let produced = normalized.metadata.unwrap_or_default();
    let stored: Object = event
        .metadata
        .iter()
        .filter(|(k, _)| *k != "observability")
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect();
    if produced != stored {
        let keys = |o: &Object| o.iter().map(|(k, _)| k.to_owned()).collect::<Vec<_>>();
        if legacy && keys(&stored).iter().all(|k| produced.has(k)) {
            tally.explained("legacy Twitch row: metadata without the durable markers of later producers");
        } else {
            tally.mismatch(format!(
                "{}: metadata re-produced as {:?}, stored {:?}",
                event.event_key,
                produced.to_json(),
                stored.to_json()
            ));
        }
    } else {
        let keys_produced: Vec<&str> = produced.iter().map(|(k, _)| k).collect();
        let keys_stored: Vec<&str> = stored.iter().map(|(k, _)| k).collect();
        if keys_produced != keys_stored {
            tally.mismatch(format!("{}: metadata key order {keys_stored:?}", event.event_key));
        }
    }
    // Retention: expiresAt = journaledAt + retention.
    if let Some(journaled) = event.journaled_at_ms {
        let retention = normalized.retention_seconds.unwrap_or(90.0 * 86_400.0);
        if event.expires_at_ms - journaled != (retention * 1000.0) as i64 {
            tally.mismatch(format!(
                "{}: expiresAt - journaledAt = {} ms, retention {retention} s",
                event.event_key,
                event.expires_at_ms - journaled
            ));
        }
    }
}

#[tokio::test]
async fn stored_identities_are_recomputed_byte_for_byte() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let mut tally = Tally::default();
    let now = dima_core::SystemClock;
    let now_ms = dima_core::Clock::now_ms(&now);

    // Events.
    let mut cursor = store
        .documents(dima_model::domain_events::COLLECTION)
        .find(doc! {})
        .await?;
    let mut keys: HashMap<String, (bson::oid::ObjectId, String, i64)> = HashMap::new();
    let mut legacy_rows: HashSet<bson::oid::ObjectId> = HashSet::new();
    while let Some(document) = cursor.try_next().await? {
        tally.checked("events");
        let event = match Envelope::from_document(&document) {
            Ok(event) => event,
            Err(error) => {
                tally.mismatch(format!("{:?}: {error}", document.get("_id")));
                continue;
            }
        };
        if event.source.starts_with("twitch-eventsub") && event.subject.is_none() {
            legacy_rows.insert(event.id);
        }
        keys.insert(
            event.event_key.clone(),
            (event.id, event.topic.clone(), event.expires_at_ms),
        );
        match event_key(&event.source, &event.source_event_id, &event.kind) {
            Ok(key) if key == event.event_key => tally.checked("event keys recomputed"),
            other => tally.mismatch(format!("{}: recomputed {other:?}", event.event_key)),
        }
        match event.validate_retained(now_ms) {
            Ok(()) => tally.checked("retained contract"),
            Err(error) => tally.mismatch(format!("{}: retained contract: {error}", event.event_key)),
        }
        if event.source.starts_with("twitch-eventsub") {
            check_twitch(&event, &mut tally);
        }
        if event.source == "goals-custom" {
            tally.checked("goal events");
        }
    }

    // Deliveries: their event, and the consumer filters.
    let mut cursor = store
        .documents(dima_model::domain_event_deliveries::COLLECTION)
        .find(doc! {})
        .await?;
    let mut by_consumer: HashMap<String, Vec<(bson::oid::ObjectId, i64)>> = HashMap::new();
    while let Some(delivery) = cursor.try_next().await? {
        tally.checked("deliveries");
        let key = delivery.get_str("eventKey").unwrap_or_default();
        let consumer = delivery.get_str("consumer").unwrap_or_default();
        let Some((id, topic, expires)) = keys.get(key) else {
            tally.explained("delivery whose event the TTL already removed from the copy");
            continue;
        };
        if delivery.get_object_id("eventID").ok() != Some(*id)
            || delivery.get_str("topic").ok() != Some(topic.as_str())
            || delivery.get_datetime("expiresAt").ok().map(|d| d.timestamp_millis()) != Some(*expires)
        {
            tally.mismatch(format!("{consumer}/{key}: delivery does not match its event"));
        }
        if CONSUMERS.iter().all(|c| c.consumer != consumer) {
            tally.mismatch(format!("{consumer}: a consumer the registry does not list"));
        }
        let created = delivery
            .get_datetime("createdAt")
            .map_or(i64::MAX, |d| d.timestamp_millis());
        by_consumer.entry(consumer.to_owned()).or_default().push((*id, created));
    }
    let journal = store.documents(dima_model::domain_events::COLLECTION);
    for consumer in &CONSUMERS {
        let Some(ids) = by_consumer.get(consumer.consumer) else {
            continue;
        };
        let mut filter = (consumer.event_filter)();
        filter.insert("topic", doc! { "$in": consumer.topics.iter().map(|t| t.as_str()).collect::<Vec<_>>() });
        let mut admitted = HashSet::new();
        for chunk in ids.chunks(5_000) {
            let mut scoped = filter.clone();
            scoped.insert("_id", doc! { "$in": chunk.iter().map(|(id, _)| Bson::ObjectId(*id)).collect::<Vec<_>>() });
            let found: Vec<Document> = journal
                .find(scoped)
                .projection(doc! { "_id": 1 })
                .await?
                .try_collect()
                .await?;
            admitted.extend(found.iter().filter_map(|d| d.get_object_id("_id").ok()));
        }
        let mut refused: Vec<i64> = Vec::new();
        for (id, created) in ids {
            if admitted.contains(id) {
                tally.checked("deliveries admitted by their consumer's filter");
            } else if consumer.consumer == "stream-operations-v1" && legacy_rows.contains(id) {
                // 6508fce2 (2026-09-04) introduced this consumer with no event filter (every
                // channel event; the handler ignored the rest); 75e22ef1 gave it today's filter.
                // Its extra deliveries are exactly the legacy rows journaled in between.
                tally.explained(
                    "stream-operations-v1 delivery of a legacy row, made while the consumer had no filter (6508fce2 to 75e22ef1)",
                );
            } else {
                refused.push(*created);
            }
        }
        if let (Some(first), Some(last)) = (refused.iter().min(), refused.iter().max()) {
            println!(
                "{}: {} deliveries not admitted by today's filter, created {} .. {}",
                consumer.consumer,
                refused.len(),
                dima_text::to_iso_string(*first).unwrap_or_default(),
                dima_text::to_iso_string(*last).unwrap_or_default()
            );
            tally.mismatch(format!(
                "{}: {} deliveries its filter does not admit",
                consumer.consumer,
                refused.len()
            ));
        }
    }

    // Cron-job intents.
    let mut cursor = store
        .documents(dima_model::cron_job_intents::COLLECTION)
        .find(doc! {})
        .await?;
    while let Some(intent) = cursor.try_next().await? {
        tally.checked("cron intents");
        let job_id = intent.get_str("jobID").unwrap_or_default();
        let queue = intent.get_str("queueKey").unwrap_or_default();
        let Ok(payload) = intent.get_document("payload") else {
            tally.mismatch(format!("{job_id}: payload is not a document"));
            continue;
        };
        if payload.get_str("id").ok() != Some(job_id) {
            tally.mismatch(format!("{job_id}: jobID is not payload.id"));
        }
        let data = payload.get_document("data").ok();
        let json = |key: &str| {
            data.and_then(|d| d.get(key))
                .map(|v| v.clone().into_relaxed_extjson())
        };
        let automatic = automatic_acceptance_key(
            payload.get_str("job").unwrap_or_default(),
            payload.get_str("channelID").ok(),
            json("source").as_ref(),
            json("sessionID").as_ref(),
        );
        if intent.get_str("automaticKey").ok().map(str::to_owned) != automatic {
            tally.mismatch(format!("{job_id}: automaticKey recomputed as {automatic:?}"));
        }
        let active = intent_active_key(queue, payload.get_str("dedupeKey").ok(), job_id);
        match intent.get_str("activeKey") {
            Ok(stored) if stored == active => tally.checked("intent active keys recomputed"),
            Ok(stored) => tally.mismatch(format!("{job_id}: activeKey {stored:?}, recomputed {active:?}")),
            Err(_) => tally.explained("intent whose expired dedupe key a later job took over ($unset activeKey)"),
        }
    }

    println!("checked: {:#?}", tally.checked);
    println!("explained differences: {:#?}", tally.explained);
    ensure!(
        tally.mismatches.is_empty(),
        "unexplained mismatches (first 50):\n{}",
        tally.mismatches.join("\n")
    );
    let events = tally.checked.get("events").copied().unwrap_or_default();
    ensure!(
        !support::stores_required() || events > 10_000,
        "the production copy holds only {events} events"
    );
    let _ = Context::context(Some(()), "");
    Ok(())
}
