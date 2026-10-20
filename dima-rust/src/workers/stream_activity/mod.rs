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
    bson::{DateTime, Document, doc, oid::ObjectId},
    error::{Error, ErrorKind, Result},
    options::{ReturnDocument, UpdateOneModel},
};
use serde::Deserialize;
use tokio::{sync::oneshot, task::JoinHandle};

use projection::{Activity, Projection, defaults};

const STATE_ID: &str = "projector-v1";
const LEASE_MS: i64 = 60_000;

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
