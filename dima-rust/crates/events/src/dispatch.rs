//! The fan-out of journaled events into one delivery per consumer (`dispatchDomainEvents`,
//! `ensureDelivery` and the unclaimed form of `finishPolicyDelivery` in
//! `utils/domain_event_consumer.ts`).
//!
//! The journal append marks every event `dispatchPending: true`. [`Dispatcher::dispatch`] takes
//! the oldest marked events (at most 500, in `_id` order), creates the delivery of each consumer
//! whose filter admits it (an upsert on the unique `{consumer, eventKey}`, so creating it twice
//! is harmless), settles at once those its policy rejects (too old for an ephemeral consumer:
//! `skipped`; unsupported schema: `dead`), and clears the marker only after every delivery
//! exists. A process that dies anywhere in between leaves the marker set, and the next sweep
//! (every second, or sooner on a wakeup) redoes the batch: the upserts find the deliveries that
//! were made and make the rest.
//!
//! The consumer runtime ([`crate::consumer`]) reuses [`ensure_delivery`] and the policy
//! settlement, claimed or not.

use crate::contracts::policy::{
    ConsumerDefinition, PolicyDecision, PolicyEvent, evaluate, is_schema_compatible,
};
use crate::store::{StoreError, bounded, bounded_write, duplicate_key};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::Clock;
use dima_model::domain_event_deliveries as deliveries;
use dima_model::domain_events as events;
use dima_model::index::RequiredIndexError;
use dima_model::{IndexReport, ModelError, StrEnum};
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// A dispatch that did not complete; the marker stays set and the next sweep retries.
#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    /// MongoDB failed or timed out.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The model refused a write it prepared (a bug: the documents are built here).
    #[error(transparent)]
    Model(#[from] ModelError),
    /// A journaled event lacks a field the dispatcher needs.
    #[error("journaled event {0} cannot be dispatched: {1}")]
    Event(ObjectId, &'static str),
}

/// What [`ensure_delivery`] needs of an event.
#[derive(Clone, Debug, PartialEq)]
pub struct DispatchEvent {
    /// `_id`.
    pub id: ObjectId,
    /// `eventKey`.
    pub event_key: String,
    /// `topic`.
    pub topic: String,
    /// `expiresAt` (the delivery expires with its event).
    pub expires_at: bson::DateTime,
    /// The policy fields.
    pub policy: PolicyEvent,
}

impl DispatchEvent {
    /// Reads the fields from a stored event.
    pub fn from_document(document: &Document) -> Result<Self, DispatchError> {
        let id = match document.get("_id") {
            Some(Bson::ObjectId(id)) => *id,
            _ => return Err(DispatchError::Event(ObjectId::from_bytes([0; 12]), "_id")),
        };
        let text = |field: &'static str| match document.get(field) {
            Some(Bson::String(text)) => Ok(text.clone()),
            _ => Err(DispatchError::Event(id, field)),
        };
        let date = |field: &'static str| match document.get(field) {
            Some(Bson::DateTime(date)) => Some(*date),
            _ => None,
        };
        let expires_at = date("expiresAt").ok_or(DispatchError::Event(id, "expiresAt"))?;
        let schema_version = match document.get("schemaVersion") {
            None => 1.0,
            Some(value) => dima_store::mongo::number::read_number(value)
                .ok_or(DispatchError::Event(id, "schemaVersion"))?,
        };
        Ok(Self {
            id,
            event_key: text("eventKey")?,
            topic: text("topic")?,
            expires_at,
            policy: PolicyEvent {
                schema_version,
                occurred_at_ms: date("occurredAt")
                    .map_or(f64::NAN, |d| d.timestamp_millis() as f64),
                journaled_at_ms: date("journaledAt").map(|d| d.timestamp_millis() as f64),
            },
        })
    }
}

/// `Ok` when the report of `domain_event_deliveries` shows its unique indexes in place
/// ([`crate::indexes::require_unique`]).
pub fn require_unique_delivery_index(indexes: &IndexReport) -> Result<(), RequiredIndexError> {
    crate::indexes::require_unique(indexes, deliveries::COLLECTION, deliveries::INDEXES)
}

/// `{w: 1, j: true}`.
fn journaled() -> mongodb::options::WriteConcern {
    events::journal_write_concern()
}

/// `ensureDelivery(consumer, event)`: the delivery of `event` to `consumer`, created `pending`
/// when it does not exist (an upsert on the unique `{consumer, eventKey}`; a concurrent creator's
/// duplicate key reads the winner's).
pub async fn ensure_delivery(
    store: &MongoStore,
    deadline: Duration,
    now_ms: i64,
    consumer: &str,
    event: &DispatchEvent,
) -> Result<Document, DispatchError> {
    let filter = doc! { "consumer": consumer, "eventKey": event.event_key.as_str() };
    let update = doc! { "$setOnInsert": {
        "consumer": consumer,
        "topic": event.topic.as_str(),
        "eventID": event.id,
        "eventKey": event.event_key.as_str(),
        "status": "pending",
        "attempts": 0,
        "nextAttemptAt": Bson::Null,
        "lockedUntil": Bson::Null,
        "leaseToken": Bson::Null,
        "lastError": "",
        "lastErrorCode": "",
        "lastPrerequisiteKind": "",
        "lastAttemptDurationMs": Bson::Null,
        "lastDeadLetterError": "",
        "firstAttemptAt": Bson::Null,
        "completedAt": Bson::Null,
        "skipReason": "",
        "deadLetteredAt": Bson::Null,
        "replayCount": 0,
        "lastReplayedAt": Bson::Null,
        "expiresAt": event.expires_at,
    } };
    let mut ctx = WriteContext::new(now_ms);
    let prepared = deliveries::INFO.prepare_find_one_and_update(
        &filter,
        update,
        UpdateOptions::upsert(),
        Returned::After,
        &mut ctx,
    )?;
    let mut writes = store
        .writes(deliveries::COLLECTION)
        .write_concern(journaled());
    match bounded_write(
        "create the delivery",
        deadline,
        writes.find_one_and_update(&prepared),
    )
    .await
    {
        Ok(Some(found)) => Ok(found),
        Ok(None) => Err(DispatchError::Event(
            event.id,
            "delivery upsert returned nothing",
        )),
        Err(error) if duplicate_key(&error).is_some() => {
            let found = bounded(
                "read the delivery",
                deadline,
                store.documents(deliveries::COLLECTION).find_one(filter),
            )
            .await?;
            found.ok_or(DispatchError::Store(error))
        }
        Err(error) => Err(error.into()),
    }
}

/// What [`finish_policy_delivery`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyOutcome {
    /// The delivery is now `dead` (`policy_rejected`).
    Dead,
    /// The delivery is now `skipped`.
    Skipped,
    /// Nothing matched (it is leased, waiting for a retry, or settled): `deferred`.
    Deferred,
}

/// `finishPolicyDelivery(delivery, decision)` for an unclaimed delivery: settles it as the
/// policy decided, unless it is leased or waiting for a retry.
pub async fn finish_policy_delivery(
    store: &MongoStore,
    deadline: Duration,
    now_ms: i64,
    delivery: &Document,
    decision: &PolicyDecision,
) -> Result<PolicyOutcome, DispatchError> {
    finish_policy(store, deadline, now_ms, delivery, decision, None).await
}

/// The lease of a delivery a consumer claimed, for [`finish_policy`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct HeldLease<'a> {
    /// The claim's `leaseToken`.
    pub token: &'a str,
    /// `lastAttemptDurationMs`.
    pub duration_ms: i64,
}

/// `finishPolicyDelivery(delivery, decision, claimed, durationMs)`: unclaimed (`held` is
/// `None`), only a delivery nobody leases and no retry waits on is settled; claimed, only under
/// the caller's unexpired lease, and the claim's attempt is given back.
pub(crate) async fn finish_policy(
    store: &MongoStore,
    deadline: Duration,
    now_ms: i64,
    delivery: &Document,
    decision: &PolicyDecision,
    held: Option<HeldLease<'_>>,
) -> Result<PolicyOutcome, DispatchError> {
    let (dead, reason) = match decision {
        PolicyDecision::Eligible => return Ok(PolicyOutcome::Deferred),
        PolicyDecision::Dead(reason) => (true, reason.as_str()),
        PolicyDecision::Skipped(reason) => (false, reason.as_str()),
    };
    let id = delivery.get("_id").cloned().unwrap_or(Bson::Null);
    let now = bson::DateTime::from_millis(now_ms);
    // `delivery.lastDeadLetterError` of the hydrated delivery: the schema default `''` when the
    // stored document lacks it.
    let previous_dead_letter = delivery
        .get("lastDeadLetterError")
        .cloned()
        .unwrap_or_else(|| Bson::String(String::new()));
    let filter = match held {
        Some(held) => doc! {
            "_id": id,
            "status": "processing",
            "leaseToken": held.token,
            "lockedUntil": { "$gt": now },
        },
        None => doc! {
            "_id": id,
            "status": { "$in": ["pending", "processing", "retry"] },
            "$and": [
                { "$or": [{ "lockedUntil": Bson::Null }, { "lockedUntil": { "$lte": now } }] },
                { "$or": [{ "nextAttemptAt": Bson::Null }, { "nextAttemptAt": { "$lte": now } }] },
            ],
        },
    };
    let mut set = doc! {
        "status": if dead { "dead" } else { "skipped" },
        "completedAt": now,
        "skipReason": if dead { "" } else { reason },
        "lastError": if dead { reason } else { "" },
        "lastErrorCode": if dead { "policy_rejected" } else { "" },
        "lastPrerequisiteKind": "",
        "lastAttemptDurationMs": held.map_or(Bson::Null, |held| {
            dima_store::mongo::number::js_number(held.duration_ms as f64)
        }),
    };
    if dead {
        set.insert("lastDeadLetterError", reason);
    } else {
        set.insert("lastDeadLetterError", previous_dead_letter);
    }
    set.insert(
        "deadLetteredAt",
        if dead {
            Bson::DateTime(now)
        } else {
            Bson::Null
        },
    );
    set.insert("lockedUntil", Bson::Null);
    set.insert("leaseToken", Bson::Null);
    set.insert("nextAttemptAt", Bson::Null);
    let mut update = doc! { "$set": set };
    if held.is_some() {
        update.insert("$inc", doc! { "attempts": -1 });
    }
    let mut ctx = WriteContext::new(now_ms);
    let prepared =
        deliveries::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
    let mut writes = store
        .writes(deliveries::COLLECTION)
        .write_concern(journaled());
    let outcome = bounded_write(
        "settle the delivery",
        deadline,
        writes.update_one(&prepared),
    )
    .await?;
    Ok(match (outcome.modified > 0, dead) {
        (true, true) => PolicyOutcome::Dead,
        (true, false) => PolicyOutcome::Skipped,
        (false, _) => PolicyOutcome::Deferred,
    })
}

/// The dispatcher (`dispatchDomainEvents`).
#[derive(Clone, Debug)]
pub struct Dispatcher {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    deadline: Duration,
    consumers: &'static [ConsumerDefinition],
}

/// What one [`Dispatcher::dispatch`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dispatched {
    /// Events taken from the marker (the reference's return value).
    pub events: usize,
    /// Deliveries made or found.
    pub deliveries: usize,
}

impl Dispatcher {
    /// A dispatcher for `consumers` (normally [`crate::contracts::policy::CONSUMERS`]), usable
    /// once the unique `{consumer, eventKey}` index of `domain_event_deliveries` exists
    /// (`indexes` is its startup report). The reference awaits `DomainEventDeliverySchema.init()`
    /// before every dispatch: without that index two dispatchers could create two deliveries of
    /// one event, and a consumer would apply it twice. (`dima_model::startup_policy` lists the
    /// collection as best effort; this check holds the line until it is required there.)
    pub fn new(
        store: MongoStore,
        clock: Arc<dyn Clock>,
        config: &crate::config::EventsConfig,
        consumers: &'static [ConsumerDefinition],
        indexes: &IndexReport,
    ) -> Result<Self, RequiredIndexError> {
        require_unique_delivery_index(indexes)?;
        Ok(Self {
            store,
            clock,
            deadline: config.store_deadline,
            consumers,
        })
    }

    /// One batch: at most `batch_size` (1 to 500) marked events, oldest first.
    pub async fn dispatch(&self, batch_size: i64) -> Result<Dispatched, DispatchError> {
        let limit = batch_size.clamp(1, 500);
        let journal = self.store.documents(events::COLLECTION);
        let marked: Vec<Document> = bounded("read the events to dispatch", self.deadline, async {
            journal
                .find(doc! { "dispatchPending": true })
                .sort(doc! { "_id": 1 })
                .limit(limit)
                .await?
                .try_collect()
                .await
        })
        .await?;
        if marked.is_empty() {
            return Ok(Dispatched::default());
        }
        let batch = marked
            .iter()
            .map(DispatchEvent::from_document)
            .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<Bson> = batch.iter().map(|event| Bson::ObjectId(event.id)).collect();
        let mut made = 0;
        for consumer in self.consumers {
            let mut filter = (consumer.event_filter)();
            filter.insert(
                "schemaVersion",
                doc! { "$in": consumer.schema_versions.iter().map(|v| dima_store::mongo::number::js_number(*v)).collect::<Vec<_>>() },
            );
            filter.insert(
                "topic",
                doc! { "$in": consumer.topics.iter().map(|t| t.as_str()).collect::<Vec<_>>() },
            );
            filter.insert("_id", doc! { "$in": ids.clone() });
            let matching: Vec<Document> = bounded("match consumers", self.deadline, async {
                journal
                    .find(filter)
                    .projection(doc! { "_id": 1 })
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
            let matching: HashSet<ObjectId> = matching
                .iter()
                .filter_map(|d| d.get_object_id("_id").ok())
                .collect();
            let policy = consumer.policy();
            for event in &batch {
                if !matching.contains(&event.id)
                    || !is_schema_compatible(&policy, event.policy.schema_version)
                {
                    continue;
                }
                let now = self.clock.now_ms();
                let delivery =
                    ensure_delivery(&self.store, self.deadline, now, consumer.consumer, event)
                        .await?;
                made += 1;
                let now = self.clock.now_ms();
                let decision = evaluate(&policy, event.policy, now as f64);
                if decision != PolicyDecision::Eligible {
                    finish_policy_delivery(&self.store, self.deadline, now, &delivery, &decision)
                        .await?;
                }
            }
        }
        // The marker is part of the journal insert. Clear it only after every delivery exists,
        // so a crash or an out-of-order insert cannot strand an acknowledged event.
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let clear = events::INFO.prepare_update(
            &doc! { "_id": { "$in": ids }, "dispatchPending": true },
            doc! { "$set": { "dispatchPending": false } },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        let mut writes = self
            .store
            .writes(events::COLLECTION)
            .write_concern(journaled());
        bounded_write(
            "clear the dispatch marker",
            self.deadline,
            writes.update_many(&clear),
        )
        .await?;
        Ok(Dispatched {
            events: batch.len(),
            deliveries: made,
        })
    }
}
