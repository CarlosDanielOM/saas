//! Every read and write the runtime makes on `domain_event_deliveries`,
//! `domain_event_checkpoints` and `domain_events`, each as the reference makes it
//! (`utils/domain_event_consumer.ts`): the same filter, the same `$set` in the same order, the
//! same write concern. Writes go through the model's write helpers (Mongoose's timestamps and
//! number types).

use crate::consumer::ConsumerError;
use crate::contracts::policy::ConsumerDefinition;
use crate::store::{bounded, bounded_write};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_model::StrEnum;
use dima_model::domain_event_checkpoints as checkpoints;
use dima_model::domain_event_deliveries as deliveries;
use dima_model::domain_events as events;
use dima_store::mongo::number::{js_number, read_number};
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use std::time::Duration;

/// The statuses a consumer may still act on.
pub(crate) const ACTIVE: [&str; 3] = ["pending", "processing", "retry"];

/// `{w: 1, j: true}`: the failure, policy and replay writes (the others use the default).
fn journaled() -> mongodb::options::WriteConcern {
    events::journal_write_concern()
}

pub(crate) fn date(ms: i64) -> bson::DateTime {
    bson::DateTime::from_millis(ms)
}

/// A stored date in epoch milliseconds.
pub(crate) fn date_ms(document: &Document, field: &str) -> Option<i64> {
    match document.get(field) {
        Some(Bson::DateTime(at)) => Some(at.timestamp_millis()),
        _ => None,
    }
}

/// A stored number (the hydrated default when missing).
pub(crate) fn number(document: &Document, field: &str, default: f64) -> f64 {
    document.get(field).and_then(read_number).unwrap_or(default)
}

/// A stored string (`""` when missing or not text).
pub(crate) fn text<'a>(document: &'a Document, field: &str) -> &'a str {
    document.get_str(field).unwrap_or_default()
}

/// `{$or: [{field: null}, {field: {$lte: now}}]}`.
fn free(field: &str, now: bson::DateTime) -> Document {
    doc! { "$or": [{ field: Bson::Null }, { field: { "$lte": now } }] }
}

/// The store, under one deadline per call.
#[derive(Clone, Debug)]
pub(crate) struct Records {
    pub store: MongoStore,
    pub deadline: Duration,
}

impl Records {
    async fn update(
        &self,
        operation: &'static str,
        now_ms: i64,
        filter: Document,
        update: Document,
        journal: bool,
    ) -> Result<u64, ConsumerError> {
        let mut ctx = WriteContext::new(now_ms);
        let prepared =
            deliveries::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let writes = self.store.writes(deliveries::COLLECTION);
        let mut writes = if journal {
            writes.write_concern(journaled())
        } else {
            writes
        };
        let outcome = bounded_write(operation, self.deadline, writes.update_one(&prepared)).await?;
        Ok(outcome.modified)
    }

    /// The ready deliveries of a consumer, oldest update first: `pending`, `retry` that is due,
    /// `processing` whose lease expired (a dead process's work).
    pub async fn ready(
        &self,
        definition: &ConsumerDefinition,
        batch: i64,
        now_ms: i64,
    ) -> Result<Vec<Document>, ConsumerError> {
        let now = date(now_ms);
        let filter = doc! {
            "consumer": definition.consumer,
            "topic": { "$in": definition.topics.iter().map(|t| t.as_str()).collect::<Vec<_>>() },
            "$or": [
                { "status": "pending" },
                { "status": "retry", "nextAttemptAt": { "$lte": now } },
                { "status": "processing", "$or": [{ "lockedUntil": Bson::Null }, { "lockedUntil": { "$lte": now } }] },
            ],
        };
        let collection = self.store.documents(deliveries::COLLECTION);
        Ok(bounded("read the ready deliveries", self.deadline, async {
            collection
                .find(filter)
                .sort(doc! { "updatedAt": 1, "_id": 1 })
                .limit(batch)
                .await?
                .try_collect()
                .await
        })
        .await?)
    }

    /// `DomainEventSchema.findById(id)`.
    pub async fn event(&self, id: &Bson) -> Result<Option<Document>, ConsumerError> {
        Ok(bounded(
            "read the event",
            self.deadline,
            self.store
                .documents(events::COLLECTION)
                .find_one(doc! { "_id": id.clone() }),
        )
        .await?)
    }

    /// A ready delivery whose event expired or was removed: `dead` (`journal_missing`), if it is
    /// still as it was read.
    pub async fn journal_missing(
        &self,
        delivery: &Document,
        now_ms: i64,
    ) -> Result<bool, ConsumerError> {
        const MISSING: &str = "Journal event expired or was removed before delivery";
        let now = date(now_ms);
        let filter = doc! {
            "_id": delivery.get("_id").cloned().unwrap_or(Bson::Null),
            "status": delivery.get("status").cloned().unwrap_or(Bson::Null),
            "leaseToken": delivery.get("leaseToken").cloned().unwrap_or(Bson::Null),
        };
        let update = doc! { "$set": {
            "status": "dead",
            "completedAt": now,
            "deadLetteredAt": now,
            "nextAttemptAt": Bson::Null,
            "lockedUntil": Bson::Null,
            "leaseToken": Bson::Null,
            "lastError": MISSING,
            "lastErrorCode": "journal_missing",
            "lastPrerequisiteKind": "",
            "lastAttemptDurationMs": Bson::Null,
            "lastDeadLetterError": MISSING,
        } };
        Ok(self
            .update("dead-letter the delivery", now_ms, filter, update, false)
            .await?
            > 0)
    }

    /// The final attempt was interrupted (its process died, its lease expired): `dead`
    /// (`interrupted`) without another attempt, if nobody leases it and no retry waits.
    pub async fn retire_exhausted(
        &self,
        delivery: &Document,
        max_attempts: i64,
        now_ms: i64,
    ) -> Result<bool, ConsumerError> {
        const INTERRUPTED: &str = "Attempt limit exhausted after interrupted execution";
        let now = date(now_ms);
        let filter = doc! {
            "_id": delivery.get("_id").cloned().unwrap_or(Bson::Null),
            "status": { "$in": ACTIVE.to_vec() },
            "attempts": { "$gte": max_attempts },
            "$and": [free("lockedUntil", now), free("nextAttemptAt", now)],
        };
        let update = doc! { "$set": {
            "status": "dead",
            "deadLetteredAt": now,
            "completedAt": now,
            "lockedUntil": Bson::Null,
            "leaseToken": Bson::Null,
            "nextAttemptAt": Bson::Null,
            "lastError": INTERRUPTED,
            "lastErrorCode": "interrupted",
            "lastPrerequisiteKind": "",
            "lastAttemptDurationMs": Bson::Null,
            "lastDeadLetterError": INTERRUPTED,
        } };
        Ok(self
            .update("retire the delivery", now_ms, filter, update, false)
            .await?
            > 0)
    }

    /// `claimDelivery`'s write: takes the lease with `token` if the delivery is active, below the
    /// attempt limit, unleased and due. The claimed document, or `None`.
    pub async fn claim(
        &self,
        delivery: &Document,
        token: &str,
        lease_ms: i64,
        max_attempts: i64,
        now_ms: i64,
    ) -> Result<Option<Document>, ConsumerError> {
        let now = date(now_ms);
        let filter = doc! {
            "_id": delivery.get("_id").cloned().unwrap_or(Bson::Null),
            "status": { "$in": ACTIVE.to_vec() },
            "attempts": { "$lt": max_attempts },
            "$and": [free("lockedUntil", now), free("nextAttemptAt", now)],
        };
        // `delivery.firstAttemptAt || now`.
        let first = match delivery.get("firstAttemptAt") {
            Some(Bson::DateTime(at)) => Bson::DateTime(*at),
            _ => Bson::DateTime(now),
        };
        let update = doc! {
            "$set": {
                "status": "processing",
                "lockedUntil": date(now_ms + lease_ms),
                "leaseToken": token,
                "nextAttemptAt": Bson::Null,
                "firstAttemptAt": first,
            },
            "$inc": { "attempts": 1 },
        };
        let mut ctx = WriteContext::new(now_ms);
        let prepared = deliveries::INFO.prepare_find_one_and_update(
            &filter,
            update,
            UpdateOptions::default(),
            Returned::After,
            &mut ctx,
        )?;
        let mut writes = self.store.writes(deliveries::COLLECTION);
        Ok(bounded_write(
            "claim the delivery",
            self.deadline,
            writes.find_one_and_update(&prepared),
        )
        .await?)
    }

    /// The delivery as this caller's claim left it, if that claim committed and its lease is
    /// still unexpired (a claim whose reply was lost).
    pub async fn claimed_by(
        &self,
        id: &Bson,
        token: &str,
        now_ms: i64,
    ) -> Result<Option<Document>, ConsumerError> {
        Ok(bounded(
            "reconcile the delivery claim",
            self.deadline,
            self.store.documents(deliveries::COLLECTION).find_one(doc! {
                "_id": id.clone(),
                "status": "processing",
                "leaseToken": token,
                "lockedUntil": { "$gt": date(now_ms) },
            }),
        )
        .await?)
    }

    /// The heartbeat: moves the lease to `started + lease_ms` while it is still held.
    pub async fn renew(
        &self,
        id: &Bson,
        token: &str,
        started_ms: i64,
        lease_ms: i64,
    ) -> Result<bool, ConsumerError> {
        let filter = doc! {
            "_id": id.clone(),
            "status": "processing",
            "leaseToken": token,
            "lockedUntil": { "$gt": date(started_ms) },
        };
        let update = doc! { "$set": { "lockedUntil": date(started_ms + lease_ms) } };
        Ok(self
            .update("renew the lease", started_ms, filter, update, false)
            .await?
            > 0)
    }

    fn held(id: &Bson, token: &str, now: bson::DateTime) -> Document {
        doc! {
            "_id": id.clone(),
            "status": "processing",
            "leaseToken": token,
            "lockedUntil": { "$gt": now },
        }
    }

    /// The completion, under the lease.
    pub async fn complete(
        &self,
        id: &Bson,
        token: &str,
        duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool, ConsumerError> {
        let now = date(now_ms);
        let update = doc! { "$set": {
            "status": "succeeded",
            "completedAt": now,
            "lockedUntil": Bson::Null,
            "leaseToken": Bson::Null,
            "nextAttemptAt": Bson::Null,
            "lastError": "",
            "lastErrorCode": "",
            "lastPrerequisiteKind": "",
            "lastAttemptDurationMs": js_number(duration_ms as f64),
            "lastDeadLetterError": "",
        } };
        Ok(self
            .update(
                "complete the delivery",
                now_ms,
                Self::held(id, token, now),
                update,
                false,
            )
            .await?
            > 0)
    }

    /// The failure write, under the lease (`$set` built by the caller, in the reference's
    /// order), giving the attempt back when `refund`.
    pub async fn fail(
        &self,
        id: &Bson,
        token: &str,
        set: Document,
        refund: bool,
        now_ms: i64,
    ) -> Result<bool, ConsumerError> {
        let mut update = doc! { "$set": set };
        if refund {
            update.insert("$inc", doc! { "attempts": -1 });
        }
        Ok(self
            .update(
                "record the failure",
                now_ms,
                Self::held(id, token, date(now_ms)),
                update,
                true,
            )
            .await?
            > 0)
    }

    /// The consumer's checkpoint on `topic`: the last event it read (`000…0` before the first).
    pub async fn checkpoint(&self, consumer: &str, topic: &str) -> Result<ObjectId, ConsumerError> {
        let found = bounded(
            "read the checkpoint",
            self.deadline,
            self.store
                .documents(checkpoints::COLLECTION)
                .find_one(doc! { "consumer": consumer, "topic": topic }),
        )
        .await?;
        Ok(found
            .and_then(|c| c.get_object_id("lastEventID").ok())
            .unwrap_or_else(|| ObjectId::from_bytes([0; 12])))
    }

    /// The next events the consumer admits on `topic` after `after`, in journal order.
    pub async fn scan(
        &self,
        definition: &ConsumerDefinition,
        topic: &str,
        after: ObjectId,
        batch: i64,
    ) -> Result<Vec<Document>, ConsumerError> {
        let mut filter = (definition.event_filter)();
        filter.insert(
            "schemaVersion",
            doc! { "$in": definition.schema_versions.iter().map(|v| js_number(*v)).collect::<Vec<_>>() },
        );
        filter.insert("topic", topic);
        filter.insert("_id", doc! { "$gt": after });
        let collection = self.store.documents(events::COLLECTION);
        Ok(bounded("read the journal", self.deadline, async {
            collection
                .find(filter)
                .sort(doc! { "_id": 1 })
                .limit(batch)
                .await?
                .try_collect()
                .await
        })
        .await?)
    }

    /// `advanceCheckpoint`: `$max` of the last event read (an upsert on `{consumer, topic}`).
    pub async fn advance(
        &self,
        consumer: &str,
        topic: &str,
        event: ObjectId,
        now_ms: i64,
    ) -> Result<(), ConsumerError> {
        let mut ctx = WriteContext::new(now_ms);
        let prepared = checkpoints::INFO.prepare_update(
            &doc! { "consumer": consumer, "topic": topic },
            doc! {
                "$max": { "lastEventID": event },
                "$setOnInsert": { "consumer": consumer, "topic": topic },
            },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        let mut writes = self.store.writes(checkpoints::COLLECTION);
        bounded_write(
            "advance the checkpoint",
            self.deadline,
            writes.update_one(&prepared),
        )
        .await?;
        Ok(())
    }
}
