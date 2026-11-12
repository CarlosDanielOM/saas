//! What the admin routes do with deliveries (`server/routes/admin_site.route.ts`, the
//! `domain-events` routes): the listing, and the operator's replay of a dead delivery
//! (`replayDeadDomainEvent` in `utils/domain_event_consumer.ts`). The health figures are
//! [`crate::health::report`]. Request checks (super admin, the status vocabulary, `limit`
//! between 1 and 100, default 25) and the HTTP answers stay with the route.

use super::ConsumerError;
use super::records::{Records, date, date_ms};
use crate::contracts::policy::{PolicyEvent, can_admin_replay, consumer_named};
use crate::contracts::{Check, validate_contract};
use crate::store::{bounded, bounded_write};
use crate::value::{Object, Value};
use bson::{Bson, Document, doc};
use dima_model::StrEnum;
use dima_model::domain_event_deliveries as deliveries;
use dima_model::domain_events as events;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use serde_json::{Map, Value as Json};
use std::time::Duration;

/// `GET /admin-site/domain-events`: the deliveries (newest update first, at most `limit`), how
/// many match, the count of every status (of the consumer, or of all), and for each delivery
/// the event's `_id`, `type`, `channelID`, `occurredAt` and `journaledAt` (`null` when gone).
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    /// `total`.
    pub total: u64,
    /// `statusCounts`, in the aggregation's order.
    pub status_counts: Vec<(Bson, Bson)>,
    /// The deliveries with their events.
    pub deliveries: Vec<(Document, Option<Document>)>,
}

impl Listing {
    /// The route's `data`, as `res.json` writes it (ObjectIds as hex, dates as ISO text).
    pub fn to_json(&self) -> Json {
        let json = |document: &Document| {
            Value::from_bson(&Bson::Document(document.clone()))
                .to_json()
                .unwrap_or(Json::Null)
        };
        let mut counts = Object::new();
        for (status, count) in &self.status_counts {
            // `Object.fromEntries`: the key is the status as text.
            let key = match status {
                Bson::String(text) => text.clone(),
                Bson::Null => "null".to_owned(),
                other => {
                    dima_text::string_of(&Value::from_bson(other).to_json().unwrap_or(Json::Null))
                }
            };
            counts.insert(key, Value::from_bson(count));
        }
        let deliveries = self
            .deliveries
            .iter()
            .map(|(delivery, event)| {
                let mut entry = match json(delivery) {
                    Json::Object(map) => map,
                    _ => Map::new(),
                };
                entry.insert("event".into(), event.as_ref().map_or(Json::Null, json));
                Json::Object(entry)
            })
            .collect();
        serde_json::json!({
            "total": self.total,
            "statusCounts": Json::Object(counts.to_json()),
            "deliveries": Json::Array(deliveries),
        })
    }
}

/// The listing (see [`Listing`]): `status` and `consumer` as the route checked and trimmed them
/// (`None` for all), `limit` already capped.
pub async fn list(
    store: &MongoStore,
    deadline: Duration,
    status: Option<&str>,
    consumer: Option<&str>,
    limit: i64,
) -> Result<Listing, ConsumerError> {
    let mut filter = Document::new();
    if let Some(status) = status.filter(|s| !s.is_empty()) {
        filter.insert("status", status);
    }
    let consumer = consumer.filter(|c| !c.is_empty());
    if let Some(consumer) = consumer {
        filter.insert("consumer", consumer);
    }
    let collection = store.documents(deliveries::COLLECTION);
    let found = bounded("list the deliveries", deadline, async {
        collection
            .find(filter.clone())
            .sort(doc! { "updatedAt": -1 })
            .limit(limit)
            .await?
            .try_collect::<Vec<Document>>()
            .await
    });
    let total = bounded(
        "count the deliveries",
        deadline,
        collection.count_documents(filter.clone()),
    );
    let matching = match consumer {
        Some(consumer) => doc! { "consumer": consumer },
        None => Document::new(),
    };
    let counts = bounded("count the statuses", deadline, async {
        collection
            .aggregate(vec![
                doc! { "$match": matching },
                doc! { "$group": { "_id": "$status", "count": { "$sum": 1 } } },
            ])
            .await?
            .try_collect::<Vec<Document>>()
            .await
    });
    let (found, total, counts) = futures_util::future::try_join3(found, total, counts).await?;
    let ids: Vec<Bson> = found
        .iter()
        .map(|d| d.get("eventID").cloned().unwrap_or(Bson::Null))
        .collect();
    let journal = store.documents(events::COLLECTION);
    let referenced: Vec<Document> = bounded("read the listed events", deadline, async {
        journal
            .find(doc! { "_id": { "$in": ids } })
            .projection(
                doc! { "_id": 1, "type": 1, "channelID": 1, "occurredAt": 1, "journaledAt": 1 },
            )
            .await?
            .try_collect()
            .await
    })
    .await?;
    let deliveries = found
        .into_iter()
        .map(|delivery| {
            let event = referenced
                .iter()
                .find(|e| e.get("_id").is_some() && e.get("_id") == delivery.get("eventID"))
                .cloned();
            (delivery, event)
        })
        .collect();
    Ok(Listing {
        total,
        status_counts: counts
            .into_iter()
            .map(|row| {
                (
                    row.get("_id").cloned().unwrap_or(Bson::Null),
                    row.get("count").cloned().unwrap_or(Bson::Int32(0)),
                )
            })
            .collect(),
        deliveries,
    })
}

/// Why a replay request is malformed (`normalizeRequired`: the route answers 400 before this).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Domain event consumer {0} is required")]
pub struct ReplayInputError(pub &'static str);

/// `replayDeadDomainEvent(consumer, eventKey)`: `true` when the dead delivery was reset to a due
/// `retry` with its attempts back to 0 (the route's 202), `false` when replay is denied (409):
/// the consumer is not registered or does not allow replay, the delivery is not `dead` or has
/// expired, or its event is gone, expired, outside the consumer's filter or schema, too old for
/// an ephemeral consumer, or no longer valid against its contract. The event's own expiry bounds
/// the reset (TTL deletion is asynchronous); replay never extends retention.
pub async fn replay(
    store: &MongoStore,
    deadline: Duration,
    now_ms: i64,
    consumer: &str,
    event_key: &str,
) -> Result<Result<bool, ReplayInputError>, ConsumerError> {
    let consumer = dima_text::trim(consumer);
    if consumer.is_empty() {
        return Ok(Err(ReplayInputError("name")));
    }
    let event_key = dima_text::trim(event_key);
    if event_key.is_empty() {
        return Ok(Err(ReplayInputError("eventKey")));
    }
    let Some(definition) = consumer_named(consumer).filter(|d| d.admin_replay) else {
        return Ok(Ok(false));
    };
    let records = Records {
        store: store.clone(),
        deadline,
    };
    let delivery = bounded(
        "read the dead delivery",
        deadline,
        store
            .documents(deliveries::COLLECTION)
            .find_one(doc! { "consumer": consumer, "eventKey": event_key, "status": "dead" }),
    )
    .await?;
    let Some(delivery) = delivery else {
        return Ok(Ok(false));
    };
    if date_ms(&delivery, "expiresAt").is_none_or(|at| at <= now_ms) {
        return Ok(Ok(false));
    }
    let now = date(now_ms);
    let mut filter = (definition.event_filter)();
    filter.insert(
        "_id",
        delivery.get("eventID").cloned().unwrap_or(Bson::Null),
    );
    filter.insert("eventKey", event_key);
    filter.insert(
        "topic",
        doc! { "$in": definition.topics.iter().map(|t| t.as_str()).collect::<Vec<_>>() },
    );
    filter.insert(
        "schemaVersion",
        doc! { "$in": definition.schema_versions.iter().map(|v| js_number(*v)).collect::<Vec<_>>() },
    );
    filter.insert("expiresAt", doc! { "$gt": now });
    let event = bounded(
        "read the event to replay",
        deadline,
        store.documents(events::COLLECTION).find_one(filter),
    )
    .await?;
    let Some(event) = event else {
        return Ok(Ok(false));
    };
    // The lean event, as stored.
    let expires_at = date_ms(&event, "expiresAt");
    let policy_event = PolicyEvent {
        schema_version: event
            .get("schemaVersion")
            .and_then(dima_store::mongo::number::read_number)
            .unwrap_or(f64::NAN),
        occurred_at_ms: date_ms(&event, "occurredAt").map_or(f64::NAN, |ms| ms as f64),
        journaled_at_ms: date_ms(&event, "journaledAt").map(|ms| ms as f64),
    };
    if !can_admin_replay(
        Some(&definition.policy()),
        Some((policy_event, expires_at.map_or(f64::NAN, |ms| ms as f64))),
        now_ms as f64,
    ) {
        return Ok(Ok(false));
    }
    if validate_contract(&Object::from_bson(&event), Check::retained(now_ms)).is_err() {
        return Ok(Ok(false));
    }
    let Some(expires_at) = expires_at else {
        return Ok(Ok(false));
    };
    let filter = doc! {
        "_id": delivery.get("_id").cloned().unwrap_or(Bson::Null),
        "consumer": consumer,
        "eventKey": event_key,
        "status": "dead",
        "expiresAt": { "$gt": now },
        // TTL deletion is asynchronous; the journal's original horizon still bounds the reset.
        "$expr": { "$lt": ["$$NOW", date(expires_at)] },
    };
    let update = doc! {
        "$set": {
            "status": "retry",
            "attempts": 0,
            "nextAttemptAt": now,
            "lockedUntil": Bson::Null,
            "leaseToken": Bson::Null,
            "lastError": "",
            "lastErrorCode": "",
            "lastPrerequisiteKind": "",
            "lastAttemptDurationMs": Bson::Null,
            "lastDeadLetterError": "",
            "deadLetteredAt": Bson::Null,
            "completedAt": Bson::Null,
            "skipReason": "",
            "lastReplayedAt": now,
        },
        "$inc": { "replayCount": 1 },
    };
    let mut ctx = WriteContext::new(now_ms);
    let prepared =
        deliveries::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
    let mut writes = records
        .store
        .writes(deliveries::COLLECTION)
        .write_concern(events::journal_write_concern());
    let outcome = bounded_write(
        "replay the delivery",
        deadline,
        writes.update_one(&prepared),
    )
    .await?;
    Ok(Ok(outcome.modified > 0))
}
