//! Manual port of the TypeScript stream-activity projector, with identical stored
//! identities and batch fences. Uses MongoDB 8.0+ client bulk writes. Constructing
//! a projector does not connect, register a worker, or create/change indexes.

mod projection;

use std::{
    collections::BTreeMap,
    error::Error as _,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{Error, ErrorKind, Result},
    options::{ReturnDocument, UpdateOneModel},
};
use serde::Deserialize;
use tokio::{sync::oneshot, task::JoinHandle};

use projection::{Activity, Projection, defaults};

const STATE_ID: &str = "projector-v1";
const LEASE_MS: i64 = 60_000;
pub const HEALTH_METRIC_MAX: u64 = 1_000_000_000_000_000;

/// Read-only health metadata; checkpoint identifiers never leave the projector.
#[derive(Debug, PartialEq, Eq)]
pub struct StreamActivityHealth {
    pub has_pending: bool,
    pub oldest_pending_age_ms: Option<u64>,
    pub checkpoint_seq: Option<u64>,
    pub active_batch_events: Option<usize>,
}

fn health_error() -> Error {
    Error::custom("Invalid stream activity health metadata".to_owned())
}

fn health_sequence(value: &Bson) -> Result<u64> {
    let value = match value {
        Bson::Int32(value) => f64::from(*value),
        Bson::Int64(value) => *value as f64,
        Bson::Double(value) => *value,
        _ => return Err(health_error()),
    };
    if !value.is_finite()
        || !(0.0..=HEALTH_METRIC_MAX as f64).contains(&value)
        || value.fract() != 0.0
    {
        return Err(health_error());
    }
    Ok(value as u64)
}

fn health_metadata(
    pending: Option<&Document>,
    state: Option<&Document>,
    now: DateTime,
) -> Result<StreamActivityHealth> {
    let oldest_pending_age_ms = pending
        .map(|row| {
            let occurred_at = row.get_datetime("occurredAt").map_err(|_| health_error())?;
            let age = now
                .timestamp_millis()
                .saturating_sub(occurred_at.timestamp_millis())
                .max(0) as u64;
            if age > HEALTH_METRIC_MAX {
                return Err(health_error());
            }
            Ok(age)
        })
        .transpose()?;
    let checkpoint_seq = state
        .and_then(|row| row.get("seq"))
        .map(health_sequence)
        .transpose()?;
    let active_batch_events = state
        .map(|row| {
            let active = match row.get("active") {
                None | Some(Bson::Null) => return Ok(0),
                Some(Bson::Document(active)) => active,
                _ => return Err(health_error()),
            };
            match active.get("ids") {
                None => Ok(0),
                Some(Bson::Array(ids))
                    if ids.len() <= 1000 && ids.iter().all(|id| matches!(id, Bson::String(_))) =>
                {
                    Ok(ids.len())
                }
                _ => Err(health_error()),
            }
        })
        .transpose()?;
    Ok(StreamActivityHealth {
        has_pending: pending.is_some(),
        oldest_pending_age_ms,
        checkpoint_seq,
        active_batch_events,
    })
}

/// A bounded projector using an explicitly selected database. The caller owns
/// connection configuration, runtime lifetime, scheduling, and shutdown.
#[derive(Clone)]
pub struct StreamActivityProjector {
    database: Database,
    activities: Collection<Document>,
    aggregates: Collection<Document>,
    states: Collection<Document>,
}

#[derive(Deserialize)]
struct State {
    #[serde(default)]
    seq: f64,
    active: Option<Active>,
}

#[derive(Deserialize)]
struct Active {
    #[serde(default)]
    seq: f64,
    #[serde(default)]
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct Id {
    #[serde(rename = "_id")]
    id: String,
}

fn lease_error() -> Error {
    Error::custom("Timeline projection lease lost".to_owned())
}
fn lease_until() -> DateTime {
    DateTime::from_millis(DateTime::now().timestamp_millis() + LEASE_MS)
}

impl StreamActivityProjector {
    /// Selects the existing Mongoose collection names, without any I/O.
    pub fn new(database: Database) -> Self {
        Self {
            activities: database.collection("stream_activities"),
            aggregates: database.collection("stream_activity_aggregates"),
            states: database.collection("stream_activity_states"),
            database,
        }
    }

    /// Two bounded reads reuse the pending-event index and checkpoint key.
    /// Callers also bound the whole probe, including server selection/network I/O.
    /// This does not acquire a lease, create state, or change projection behavior.
    pub async fn health(&self, now: DateTime) -> Result<StreamActivityHealth> {
        let pending = self
            .activities
            .find(doc! { "processed": false, "expiresAt": { "$gt": now } })
            .sort(doc! { "occurredAt": 1, "_id": 1 })
            .limit(1)
            .projection(doc! { "_id": 0, "occurredAt": 1 })
            .max_time(Duration::from_secs(1))
            .await?
            .try_next()
            .await?;
        let state = self
            .states
            .find_one(doc! { "_id": STATE_ID })
            .projection(doc! { "_id": 0, "seq": 1, "active.ids": 1 })
            .max_time(Duration::from_secs(1))
            .await?;
        health_metadata(pending.as_ref(), state.as_ref(), now)
    }

    /// Projects a fixed persisted batch (default caller size 500, clamped 1–1000).
    /// Returns zero when no events are pending or another owner holds the lease.
    /// Failed batches retain their membership and sequence for fenced replay.
    pub async fn project_batch(&self, limit: usize) -> Result<usize> {
        let now = DateTime::now();
        let owner = ObjectId::new().to_hex();
        self.states
            .update_one(
                doc! { "_id": STATE_ID },
                doc! {
                    "$setOnInsert": { "seq": 0, "leaseUntil": DateTime::from_millis(0), "active.ids": [] }
                },
            )
            .upsert(true)
            .await?;
        let state = self
            .states
            .clone_with_type::<State>()
            .find_one_and_update(
                doc! { "_id": STATE_ID, "leaseUntil": { "$lte": now } },
                doc! { "$set": { "owner": &owner, "leaseUntil": lease_until() } },
            )
            .return_document(ReturnDocument::After)
            .await?;
        let Some(state) = state else {
            return Ok(0);
        };
        let heartbeat = Heartbeat::start(self.states.clone(), owner.clone());
        let result = self
            .project_owned(state, &owner, now, limit, &heartbeat.lost)
            .await;
        heartbeat.stop().await;
        // Owner-fenced release cannot clobber the lease of a replacement worker.
        let released = self
            .states
            .update_one(
                doc! { "_id": STATE_ID, "owner": &owner },
                doc! { "$set": { "leaseUntil": DateTime::from_millis(0) } },
            )
            .await;
        match result {
            Err(error) => Err(error),
            Ok(count) => {
                released?;
                Ok(count)
            }
        }
    }

    async fn assert_owner(&self, owner: &str, lost: &AtomicBool) -> Result<()> {
        if lost.load(Ordering::Acquire) {
            return Err(lease_error());
        }
        let state = self
            .states
            .find_one(doc! { "_id": STATE_ID, "owner": owner,
            "leaseUntil": { "$gt": DateTime::now() } })
            .projection(doc! { "_id": 1 })
            .await?;
        if state.is_none() || lost.load(Ordering::Acquire) {
            return Err(lease_error());
        }
        Ok(())
    }

    async fn project_owned(
        &self,
        state: State,
        owner: &str,
        now: DateTime,
        limit: usize,
        lost: &AtomicBool,
    ) -> Result<usize> {
        let active = match state.active.filter(|active| !active.ids.is_empty()) {
            Some(active) => active,
            None => {
                let pending: Vec<Id> = self
                    .activities
                    .clone_with_type::<Id>()
                    .find(doc! { "processed": false, "expiresAt": { "$gt": now } })
                    .sort(doc! { "occurredAt": 1, "_id": 1 })
                    .limit(limit.clamp(1, 1000) as i64)
                    .projection(doc! { "_id": 1 })
                    .max_time(Duration::from_secs(2))
                    .await?
                    .try_collect()
                    .await?;
                if pending.is_empty() {
                    return Ok(0);
                }
                let active = Active {
                    seq: state.seq + 1.0,
                    ids: pending.into_iter().map(|row| row.id).collect(),
                };
                let saved = self.states.update_one(doc! { "_id": STATE_ID, "owner": owner },
                    doc! { "$set": { "seq": active.seq, "active": { "seq": active.seq, "ids": &active.ids } } }).await?;
                if saved.matched_count == 0 {
                    return Err(lease_error());
                }
                active
            }
        };
        if active.ids.len() > 1000 || !active.seq.is_finite() || active.seq <= 0.0 {
            return Err(Error::custom(
                "Invalid stream activity checkpoint".to_owned(),
            ));
        }
        let rows: Vec<Activity> = self
            .activities
            .clone_with_type::<Activity>()
            .find(doc! { "_id": { "$in": &active.ids } })
            .projection(doc! {
                "_id": 0, "channelID": 1, "session_id": 1, "occurredAt": 1, "expiresAt": 1,
                "kind": 1, "offset": 1, "key": 1, "label": 1, "actor": 1,
                "actorLabel": 1, "value": 1, "outcome": 1, "emotes": 1
            })
            .await?
            .try_collect()
            .await?;
        let mut projection = Projection::new(&rows);
        if !projection.distinct.is_empty() {
            let operations = projection.distinct.iter().map(|(id, &(row, bucket))| {
                let mut base = doc! { "channelID": &row.channel_id, "session_id": row.session_id,
                    "scope": "distinct", "kind": "message", "actor": row.actor.as_deref().unwrap_or(""),
                    "key": "", "bucket": bucket, "firstSeq": active.seq, "expiresAt": row.expires_at };
                defaults(&mut base, &BTreeMap::new(), false);
                self.operation(doc! { "_id": id }, doc! { "$setOnInsert": base })
            }).collect::<Vec<_>>();
            self.assert_owner(owner, lost).await?;
            self.database
                .client()
                .bulk_write(operations)
                .ordered(true)
                .await?;
            let inserted: Vec<Id> = self.aggregates.clone_with_type::<Id>().find(doc! {
                "_id": { "$in": projection.distinct.keys().cloned().collect::<Vec<_>>() }, "firstSeq": active.seq
            }).projection(doc! { "_id": 1 }).await?.try_collect().await?;
            for row in inserted {
                projection.add_chatter(&row.id);
            }
        }
        projection.add_rows(&rows);
        self.assert_owner(owner, lost).await?;
        let now = DateTime::now();
        let operations = projection.changes.into_iter().map(|(id, change)| self.operation(doc! {
            "_id": id, "$or": [ { "lastSeq": { "$lt": active.seq } }, { "lastSeq": { "$exists": false } } ]
        }, change.update(active.seq, now))).collect::<Vec<_>>();
        if !operations.is_empty()
            && let Err(error) = self
                .database
                .client()
                .bulk_write(operations)
                .ordered(false)
                .await
            && !only_fence_duplicates(&error)
        {
            return Err(error);
        }
        // The TS lease flag alone can miss a takeover; verify ownership again
        // before acknowledging the outbox. Replays remain protected by lastSeq.
        self.assert_owner(owner, lost).await?;
        self.activities
            .update_many(
                doc! { "_id": { "$in": &active.ids } },
                doc! { "$set": { "processed": true } },
            )
            .await?;
        let completed = self
            .states
            .update_one(
                doc! { "_id": STATE_ID, "owner": owner },
                doc! {
                    "$unset": { "active": "" }, "$set": { "updatedAt": DateTime::now() }
                },
            )
            .await?;
        if completed.matched_count == 0 {
            return Err(lease_error());
        }
        Ok(rows.len())
    }

    fn operation(&self, filter: Document, update: Document) -> UpdateOneModel {
        UpdateOneModel::builder()
            .namespace(self.aggregates.namespace())
            .filter(filter)
            .update(update)
            .upsert(true)
            .build()
    }
}

fn only_fence_duplicates(error: &Error) -> bool {
    if error.source().is_some() {
        return false;
    }
    match error.kind.as_ref() {
        ErrorKind::BulkWrite(failure) => {
            !failure.write_errors.is_empty()
                && failure.write_concern_errors.is_empty()
                && failure
                    .write_errors
                    .values()
                    .all(|failure| failure.code == 11000)
        }
        _ => false,
    }
}

struct Heartbeat {
    lost: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl Heartbeat {
    fn start(states: Collection<Document>, owner: String) -> Self {
        let lost = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&lost);
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                // sleep, rather than interval's immediate first tick, matches TS.
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
                let result = states
                    .update_one(
                        doc! { "_id": STATE_ID, "owner": &owner },
                        doc! { "$set": { "leaseUntil": lease_until() } },
                    )
                    .await;
                if !matches!(result, Ok(result) if result.matched_count > 0) {
                    flag.store(true, Ordering::Release);
                    break;
                }
            }
        });
        Self {
            lost,
            stop: Some(stop),
            task: Some(task),
        }
    }

    async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod health_tests {
    use super::{HEALTH_METRIC_MAX, StreamActivityHealth, health_metadata, health_sequence};
    use mongodb::bson::{Bson, DateTime, doc};

    #[test]
    fn missing_checkpoint_and_empty_checkpoint_have_distinct_health() {
        let now = DateTime::from_millis(1000);
        assert_eq!(
            health_metadata(None, None, now).unwrap(),
            StreamActivityHealth {
                has_pending: false,
                oldest_pending_age_ms: None,
                checkpoint_seq: None,
                active_batch_events: None,
            }
        );
        for state in [
            doc! { "seq": 0 },
            doc! { "seq": 0, "active": null },
            doc! { "seq": 0, "active": {} },
            doc! { "seq": 0, "active": { "ids": [] } },
        ] {
            let health = health_metadata(None, Some(&state), now).unwrap();
            assert_eq!(health.checkpoint_seq, Some(0));
            assert_eq!(health.active_batch_events, Some(0));
        }
    }

    #[test]
    fn pending_age_is_nonnegative_and_invalid_dates_fail_the_sample() {
        let now = DateTime::from_millis(1000);
        for (timestamp, expected) in [(500, 500), (1000, 0), (2000, 0)] {
            let row = doc! { "occurredAt": DateTime::from_millis(timestamp) };
            let health = health_metadata(Some(&row), None, now).unwrap();
            assert!(health.has_pending);
            assert_eq!(health.oldest_pending_age_ms, Some(expected));
        }
        for row in [
            doc! {},
            doc! { "occurredAt": "invalid" },
            doc! { "occurredAt": 1000 },
            doc! { "occurredAt": DateTime::from_millis(i64::MIN) },
        ] {
            assert!(health_metadata(Some(&row), None, now).is_err());
        }
    }

    #[test]
    fn checkpoint_sequence_must_be_a_bounded_nonnegative_safe_integer() {
        for value in [
            Bson::Int32(0),
            Bson::Int64(12),
            Bson::Double(12.0),
            Bson::Int64(HEALTH_METRIC_MAX as i64),
        ] {
            assert!(health_sequence(&value).is_ok());
        }
        for value in [
            Bson::Int32(-1),
            Bson::Double(1.5),
            Bson::Double(f64::NAN),
            Bson::Double(f64::INFINITY),
            Bson::Int64(HEALTH_METRIC_MAX as i64 + 1),
            Bson::String("12".to_owned()),
            Bson::Null,
        ] {
            assert!(health_sequence(&value).is_err());
            assert!(health_metadata(None, Some(&doc! { "seq": value }), DateTime::now()).is_err());
        }
    }

    #[test]
    fn active_checkpoint_membership_is_bounded_and_never_exposed() {
        let now = DateTime::now();
        let ids: Vec<String> = (0..1000).map(|index| format!("private-{index}")).collect();
        let state = doc! { "seq": 4.0, "active": { "ids": &ids } };
        let health = health_metadata(None, Some(&state), now).unwrap();
        assert_eq!(health.active_batch_events, Some(1000));
        assert_eq!(health.checkpoint_seq, Some(4));
        assert!(!format!("{health:?}").contains("private-"));
        for state in [
            doc! { "active": "invalid" },
            doc! { "active": { "ids": null } },
            doc! { "active": { "ids": [1] } },
            doc! { "active": { "ids": vec!["private"; 1001] } },
        ] {
            assert!(health_metadata(None, Some(&state), now).is_err());
        }
    }
}
