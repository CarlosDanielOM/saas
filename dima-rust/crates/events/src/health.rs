//! The journal health report of the admin page (`utils/domain_event_health.ts`,
//! `GET /admin/site/domain-events/health` in `server/routes/admin_site.route.ts`).
//!
//! On demand only: seven independent aggregations (one per delivery status, capped at
//! [`LIMIT`] documents each so a long success history cannot crowd out retries, and one over the
//! dispatch marker), each with the reference's `maxTimeMS` (1 s), no disk use, and its index
//! hint. No payloads are read. At the cap, counts and ages are lower bounds. The report is the
//! reference's JSON, key for key and in its order.

use crate::store::{StoreError, bounded};
use crate::value::Value;
use bson::{Bson, Document, doc};
use dima_model::{domain_event_deliveries, domain_events};
use dima_store::mongo::MongoStore;
use futures_util::TryStreamExt;
use serde_json::{Map, Value as Json, json};
use std::time::Duration;

/// `DOMAIN_EVENT_HEALTH_LIMIT`.
pub const LIMIT: i64 = 10_000;
/// `DOMAIN_EVENT_HEALTH_MAX_TIME_MS`.
pub const MAX_TIME_MS: u64 = 1_000;
/// `DOMAIN_EVENT_HEALTH_EXPIRY_WINDOW_MS`.
pub const EXPIRY_WINDOW_MS: i64 = 60 * 60_000;

const STATUSES: [&str; 6] = [
    "pending",
    "processing",
    "retry",
    "succeeded",
    "skipped",
    "dead",
];

const SCOPE: &str = "retained-deliveries; dispatch is global; independent reads, not a snapshot";
const SEMANTICS: &str = "When capped, counts and maximum ages/durations are lower bounds over an unordered sample. Delivery ages use createdAt; ready age is the age of currently ready work, not time overdue. Dispatch age uses journaledAt. Only succeeded is success. Owner/subject signals use the last prerequisite failure, not journal identity presence. Legacy unclassified failures are not inferred.";

fn count_if(condition: Bson) -> Bson {
    Bson::Document(doc! { "$sum": { "$cond": [condition, 1, 0] } })
}

fn expiry(now: bson::DateTime, soon: bson::DateTime) -> Document {
    doc! {
        "approachingExpiry": count_if(Bson::Document(doc! { "$and": [{ "$gt": ["$expiresAt", now] }, { "$lte": ["$expiresAt", soon] }] })),
        "expired": count_if(Bson::Document(doc! { "$lte": ["$expiresAt", now] })),
    }
}

/// `summarize(row)`: the row without its two timestamps, then `capped` and the ages.
fn summarize(row: Option<&Document>, now_ms: i64) -> Map<String, Json> {
    let mut out = Map::new();
    let empty = doc! { "count": 0, "oldestAt": Bson::Null, "approachingExpiry": 0, "expired": 0 };
    let row = row.unwrap_or(&empty);
    for (key, value) in row {
        if key == "oldestAt" || key == "oldestReadyAt" {
            continue;
        }
        out.insert(
            key.clone(),
            Value::from_bson(value).to_json().unwrap_or(Json::Null),
        );
    }
    let count = row
        .get("count")
        .and_then(dima_store::mongo::number::read_number)
        .unwrap_or(0.0);
    out.insert("capped".into(), Json::Bool(count >= LIMIT as f64));
    let age = |key: &str| match row.get(key) {
        Some(Bson::DateTime(at)) => json!((now_ms - at.timestamp_millis()).max(0)),
        _ => Json::Null,
    };
    out.insert("oldestAgeMs".into(), age("oldestAt"));
    out.insert("oldestReadyAgeMs".into(), age("oldestReadyAt"));
    out
}

async fn aggregate(
    store: &MongoStore,
    deadline: Duration,
    collection: &str,
    pipeline: Vec<Document>,
    hint: Document,
) -> Result<Option<Document>, StoreError> {
    let rows: Vec<Document> = bounded("read the journal health", deadline, async {
        store
            .documents(collection)
            .aggregate(pipeline)
            .max_time(Duration::from_millis(MAX_TIME_MS))
            .allow_disk_use(false)
            .hint(mongodb::options::Hint::Keys(hint))
            .await?
            .try_collect()
            .await
    })
    .await?;
    Ok(rows.into_iter().next())
}

/// `getDomainEventHealth(consumer, now)`.
pub async fn report(
    store: &MongoStore,
    deadline: Duration,
    consumer: Option<&str>,
    now_ms: i64,
) -> Result<Json, StoreError> {
    let consumer = consumer.filter(|c| !c.is_empty());
    let now = bson::DateTime::from_millis(now_ms);
    let soon = bson::DateTime::from_millis(now_ms + EXPIRY_WINDOW_MS);
    let deliveries = STATUSES.map(|status| {
        let active = matches!(status, "pending" | "processing" | "retry");
        let due = Bson::Document(doc! { "$lte": [{ "$ifNull": ["$nextAttemptAt", now] }, now] });
        let stale = Bson::Document(doc! { "$lte": [{ "$ifNull": ["$lockedUntil", now] }, now] });
        let ready = match status {
            "pending" => Bson::Boolean(true),
            "retry" => due.clone(),
            "processing" => stale.clone(),
            _ => Bson::Boolean(false),
        };
        let missing = Bson::Document(doc! { "$eq": ["$lastErrorCode", "prerequisite_missing"] });
        let mut matching = doc! { "status": status };
        if let Some(consumer) = consumer {
            matching.insert("consumer", consumer);
        }
        let mut group = doc! {
            "_id": Bson::Null,
            "count": { "$sum": 1 },
            "oldestAt": { "$min": "$createdAt" },
            "oldestReadyAt": { "$min": { "$cond": [ready, "$createdAt", Bson::Null] } },
            "dueRetries": count_if(if status == "retry" { due.clone() } else { Bson::Boolean(false) }),
            "staleProcessing": count_if(if status == "processing" { stale.clone() } else { Bson::Boolean(false) }),
        };
        if active {
            group.extend(expiry(now, soon));
        } else {
            group.insert("approachingExpiry", doc! { "$sum": 0 });
            group.insert("expired", doc! { "$sum": 0 });
        }
        group.insert("prerequisiteMissing", count_if(missing.clone()));
        group.insert(
            "ownerUnresolved",
            count_if(Bson::Document(doc! { "$and": [missing.clone(), { "$eq": ["$lastPrerequisiteKind", "owner"] }] })),
        );
        group.insert(
            "subjectUnresolved",
            count_if(Bson::Document(doc! { "$and": [missing, { "$eq": ["$lastPrerequisiteKind", "subject"] }] })),
        );
        group.insert("maxLastAttemptDurationMs", doc! { "$max": "$lastAttemptDurationMs" });
        let pipeline = vec![
            doc! { "$match": matching },
            doc! { "$limit": LIMIT },
            doc! { "$group": group },
            doc! { "$project": { "_id": 0 } },
        ];
        let hint = if consumer.is_some() {
            doc! { "consumer": 1, "status": 1, "nextAttemptAt": 1 }
        } else {
            doc! { "status": 1 }
        };
        async move {
            let row = aggregate(store, deadline, domain_event_deliveries::COLLECTION, pipeline, hint).await?;
            let mut entry = Map::new();
            for key in ["dueRetries", "staleProcessing", "prerequisiteMissing", "ownerUnresolved", "subjectUnresolved"] {
                entry.insert(key.into(), json!(0));
            }
            entry.insert("maxLastAttemptDurationMs".into(), Json::Null);
            for (key, value) in summarize(row.as_ref(), now_ms) {
                entry.insert(key, value);
            }
            Ok::<_, StoreError>((status, Json::Object(entry)))
        }
    });
    let mut dispatch_group =
        doc! { "_id": Bson::Null, "count": { "$sum": 1 }, "oldestAt": { "$min": "$journaledAt" } };
    dispatch_group.extend(expiry(now, soon));
    let dispatch = aggregate(
        store,
        deadline,
        domain_events::COLLECTION,
        vec![
            doc! { "$match": { "dispatchPending": true } },
            doc! { "$limit": LIMIT },
            doc! { "$group": dispatch_group },
            doc! { "$project": { "_id": 0 } },
        ],
        doc! { "dispatchPending": 1, "_id": 1 },
    );
    let (deliveries, dispatch) =
        futures_util::future::join(futures_util::future::try_join_all(deliveries), dispatch).await;
    let deliveries = deliveries?;
    let dispatch = dispatch?;
    let mut by_status = Map::new();
    for (status, entry) in deliveries {
        by_status.insert(status.into(), entry);
    }
    Ok(json!({
        "asOf": dima_text::to_iso_string(now_ms),
        "consumer": consumer,
        "scope": SCOPE,
        "limits": {
            "documentsPerBucket": LIMIT,
            "maxTimeMSPerQuery": MAX_TIME_MS,
            "approachingExpiryWindowMs": EXPIRY_WINDOW_MS,
        },
        "semantics": SEMANTICS,
        "deliveries": by_status,
        "dispatchPending": summarize(dispatch.as_ref(), now_ms),
    }))
}
