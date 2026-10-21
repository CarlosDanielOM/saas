//! Bounded raid-summary projection over the existing TypeScript event producer.
//! Construction performs no I/O and creates no collections or indexes. Follower
//! counts are temporal associations, not evidence that a raid caused a follow.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::{TryStreamExt, future::try_join_all};
use garde::Validate;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{Error, Result},
    options::{Acknowledgment, Hint, ReturnDocument, UpdateOneModel, WriteConcern},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{sync::oneshot, task::JoinHandle};

const DAY_MS: i64 = 86_400_000;
const WINDOW_MS: i64 = 300_000;
const LEASE_MS: i64 = 60_000;
const REPAIR_MS: i64 = 15 * 60_000;
const REFRESH_VERSION: i32 = 1;
const MAX_METRIC_VALUE: u64 = 1_000_000_000_000_000;

/// Elapsed time for attempted phases, including failures. Unreached phases are
/// absent; in particular an idle pass reports only its claim time. These fixed
/// keys contain no channel, owner, query, or source-event data.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTimings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_queries_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_write_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period7_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period30_ms: Option<f64>,
    /// Sum of attempted seven- and thirty-day reciprocity lookups, retaining
    /// the first observation if later work fails before the second lookup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reciprocity_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publish_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_ms: Option<f64>,
}

/// Keeps completed/failed phase observations even when projection returns an
/// error, without changing the original `Result<usize>` public entrypoints.
pub struct ProjectionObservation {
    pub result: Result<usize>,
    pub phases: PhaseTimings,
}

/// Scheduled due work includes currently leased channels. It is distinct from
/// claimable work, which additionally requires an expired lease. No oldest age
/// is known for an empty due set. The two bounded reads are a best-effort sample,
/// rather than a transactionally consistent snapshot.
pub struct BacklogHealth {
    pub due_channels: u64,
    pub oldest_due_age_ms: Option<u64>,
}

fn elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0).min(MAX_METRIC_VALUE as f64)
}

/// One leased channel per pass and at most 25 follow windows, five query tasks
/// at a time. Unchanged sources skip all four summary aggregation pipelines.
#[derive(Clone)]
pub struct RaidAnalyticsProjector {
    database: Database,
    history: Collection<Document>,
    summaries: Collection<Document>,
    events: Collection<Document>,
}

#[derive(Deserialize, Validate)]
struct State {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    id: String,
    #[serde(default, rename = "dirtyAt")]
    #[garde(skip)]
    dirty_at: Option<DateTime>,
    #[serde(default, rename = "nextRefreshAt")]
    #[garde(skip)]
    next_refresh_at: Option<DateTime>,
    #[serde(default)]
    #[garde(skip)]
    payload: Option<Document>,
    #[serde(default, rename = "rustRefresh")]
    #[garde(skip)]
    refresh: Option<RefreshState>,
    #[serde(default, rename = "rustPending")]
    #[garde(skip)]
    pending: bool,
    #[serde(default)]
    #[garde(skip)]
    error: bool,
}

/// Private scheduling metadata in the existing summary document. Nothing is
/// added to the dashboard payload or the immutable domain-event journal.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshState {
    version: i32,
    fingerprint: String,
    next_source_at: Option<DateTime>,
    next_repair_at: Option<DateTime>,
    next_open_at: Option<DateTime>,
    dirty_at: Option<DateTime>,
    has_follow_windows: bool,
}

#[derive(Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct FollowRow {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    id: String,
    #[garde(skip)]
    occurred_at: DateTime,
    #[serde(default)]
    #[garde(skip)]
    follows_after: Option<Bson>,
    #[serde(default)]
    #[garde(skip)]
    follow_window_end: Option<DateTime>,
    #[serde(default)]
    #[garde(skip)]
    follows_computed_at: Option<DateTime>,
}

#[derive(Default)]
struct FollowRefresh {
    changed: bool,
    pending: bool,
    next_open_at: Option<DateTime>,
}

struct FollowUpdate {
    operation: Option<UpdateOneModel>,
    changed: bool,
    next_open_at: Option<DateTime>,
}

struct SourceState {
    fingerprint: String,
    next_source_at: Option<DateTime>,
    has_follow_windows: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextRaid {
    occurred_at: DateTime,
}

/// UTC midnight, inclusive of today, matching Date.UTC in raidRangeStart.
pub fn raid_range_start(days: u32, now: DateTime) -> DateTime {
    let midnight = now.timestamp_millis().div_euclid(DAY_MS) * DAY_MS;
    DateTime::from_millis(midnight - (i64::from(days) - 1) * DAY_MS)
}

fn follow_window(raid: DateTime, next: Option<DateTime>, now: DateTime) -> (DateTime, DateTime) {
    let full = raid.timestamp_millis() + WINDOW_MS;
    let end = full
        .min(next.map_or(i64::MAX, |next| next.timestamp_millis()))
        .min(now.timestamp_millis());
    let closed = end >= full || next.is_some_and(|next| end >= next.timestamp_millis());
    (
        DateTime::from_millis(end),
        if closed {
            now
        } else {
            DateTime::from_millis(0)
        },
    )
}

fn lease_error() -> Error {
    Error::custom("Raid analytics lease lost".to_owned())
}

fn malformed() -> Error {
    Error::custom("Invalid raid analytics projection data".to_owned())
}

fn lease_until(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis() + LEASE_MS)
}

fn owner_filter(id: &str, owner: &str) -> Document {
    doc! { "_id": id, "owner": owner, "leaseUntil": { "$gt": DateTime::now() } }
}

impl RaidAnalyticsProjector {
    /// Exact existing Mongoose collection names; uses only the business MongoDB.
    pub fn new(database: Database) -> Self {
        Self {
            history: database.collection("raid_analytics_histories"),
            summaries: database.collection("raid_analytics_summaries"),
            events: database.collection("domain_events"),
            database,
        }
    }

    /// Returns one only for a published payload change, zero for idle or a
    /// successful no-change check. No-change checks preserve updatedAt.
    pub async fn project_once(&self) -> Result<usize> {
        self.project_once_observed().await.result
    }

    /// Explicit business timestamp for deterministic fixture checks. Lease
    /// expiration/renewal always uses fresh wall time, independent of this value.
    pub async fn project_once_at(&self, now: DateTime) -> Result<usize> {
        self.project_once_observed_at(now).await.result
    }

    /// Same work and error semantics as `project_once`, retaining phase timing
    /// metadata on both success and failure.
    pub async fn project_once_observed(&self) -> ProjectionObservation {
        self.project_once_observed_at(DateTime::now()).await
    }

    pub async fn project_once_observed_at(&self, now: DateTime) -> ProjectionObservation {
        let mut phases = PhaseTimings::default();
        let result = self.project_once_with_phases(now, &mut phases).await;
        ProjectionObservation { result, phases }
    }

    /// Read only the existing scheduling index and one projected date, never
    /// summary payloads. Each query has a server bound; the executable also
    /// wraps this whole operation in a two-second wall-clock timeout.
    pub async fn backlog_health(&self, now: DateTime) -> Result<BacklogHealth> {
        let due = doc! { "nextRefreshAt": { "$lte": now } };
        let index = Hint::Keys(doc! { "nextRefreshAt": 1, "leaseUntil": 1 });
        let count = self
            .summaries
            .count_documents(due.clone())
            .hint(index.clone())
            .max_time(Duration::from_millis(750))
            .await?;
        let oldest_due_age_ms = if count == 0 {
            None
        } else {
            self.summaries
                .find_one(due)
                .sort(doc! { "nextRefreshAt": 1 })
                .projection(doc! { "_id": 0, "nextRefreshAt": 1 })
                .hint(index)
                .max_time(Duration::from_millis(750))
                .await?
                .map(|row| {
                    row.get_datetime("nextRefreshAt")
                        .map(|oldest| {
                            (now.timestamp_millis()
                                .saturating_sub(oldest.timestamp_millis())
                                .max(0) as u64)
                                .min(MAX_METRIC_VALUE)
                        })
                        .map_err(|_| malformed())
                })
                .transpose()?
        };
        Ok(BacklogHealth {
            due_channels: count.min(MAX_METRIC_VALUE),
            oldest_due_age_ms,
        })
    }

    async fn project_once_with_phases(
        &self,
        now: DateTime,
        phases: &mut PhaseTimings,
    ) -> Result<usize> {
        let owner = ObjectId::new().to_hex();
        let wall_now = DateTime::now();
        let started = Instant::now();
        let state = self
            .summaries
            .clone_with_type::<State>()
            .find_one_and_update(
                doc! { "nextRefreshAt": { "$lte": now }, "leaseUntil": { "$lte": wall_now } },
                doc! { "$set": { "owner": &owner, "leaseUntil": lease_until(wall_now) } },
            )
            .sort(doc! { "nextRefreshAt": 1 })
            .return_document(ReturnDocument::After)
            .await;
        phases.claim_ms = Some(elapsed_ms(started));
        let Some(state) = state? else {
            return Ok(0);
        };
        let heartbeat = Heartbeat::start(self.summaries.clone(), state.id.clone(), owner.clone());
        let result = async {
            state.validate().map_err(|_| malformed())?;
            let follows = self
                .refresh_follow_counts(&state.id, &owner, now, &heartbeat.lost, phases)
                .await?;
            let previous = state
                .refresh
                .as_ref()
                .filter(|refresh| refresh.version == REFRESH_VERSION && state.payload.is_some());
            // A quiet repair only needs bounded follow-count checks. Raid
            // history is immutable except for these derived follow fields; its
            // existing producer always queues changes through dirtyAt.
            let source = if needs_source_check(&state, previous, follows.changed, now) {
                self.source_state(&state.id, now).await?
            } else {
                let previous = previous.ok_or_else(malformed)?;
                SourceState {
                    fingerprint: previous.fingerprint.clone(),
                    next_source_at: previous.next_source_at,
                    has_follow_windows: previous.has_follow_windows,
                }
            };
            let rebuild = previous.is_none_or(|refresh| refresh.fingerprint != source.fingerprint);
            let mut payload = None;
            if rebuild {
                let started = Instant::now();
                let period7 = self.build_period_data(&state.id, 7, now).await;
                phases.period7_ms = Some(elapsed_ms(started));
                let mut period7 = period7?;
                let started = Instant::now();
                let reciprocity = self.attach_reciprocity(&state.id, &mut period7, now).await;
                phases.reciprocity_ms = Some(elapsed_ms(started));
                reciprocity?;
                let started = Instant::now();
                let period30 = self.build_period_data(&state.id, 30, now).await;
                phases.period30_ms = Some(elapsed_ms(started));
                let mut period30 = period30?;
                let started = Instant::now();
                let reciprocity = self.attach_reciprocity(&state.id, &mut period30, now).await;
                phases.reciprocity_ms = Some(
                    (phases.reciprocity_ms.unwrap_or(0.0) + elapsed_ms(started))
                        .min(MAX_METRIC_VALUE as f64),
                );
                reciprocity?;
                let candidate = doc! {
                    "7": period_payload(period7, 7, now),
                    "30": period_payload(period30, 30, now),
                };
                if !state
                    .payload
                    .as_ref()
                    .is_some_and(|old| same_payload(old, &candidate))
                {
                    payload = Some(candidate);
                }
            }
            let refresh = RefreshState {
                version: REFRESH_VERSION,
                fingerprint: source.fingerprint,
                next_source_at: source.next_source_at,
                next_repair_at: if source.has_follow_windows {
                    Some(
                        previous
                            .and_then(|refresh| refresh.next_repair_at)
                            .filter(|at| *at > now || follows.pending)
                            .unwrap_or_else(|| {
                                DateTime::from_millis(now.timestamp_millis() + REPAIR_MS)
                            }),
                    )
                } else {
                    None
                },
                next_open_at: follows.next_open_at,
                dirty_at: state.dirty_at,
                has_follow_windows: source.has_follow_windows,
            };
            let next = next_refresh_at(&refresh, follows.pending, now);
            let started = Instant::now();
            let changed = payload.is_some();
            let mut published_changed = false;
            let published: Result<()> = async {
                self.assert_owner(&state.id, &owner, &heartbeat.lost)
                    .await?;
                let mut values = doc! {
                    "rustRefresh": mongodb::bson::serialize_to_document(&refresh)
                        .map_err(|_| malformed())?,
                    "error": false,
                    "rustPending": false,
                };
                if let Some(payload) = payload {
                    values.insert("payload", payload);
                    values.insert("updatedAt", now);
                }
                let mut update = doc! { "$set": values };
                if let Some(next) = next {
                    update
                        .get_document_mut("$set")
                        .map_err(|_| malformed())?
                        .insert("nextRefreshAt", next);
                } else {
                    update.insert("$unset", doc! { "nextRefreshAt": "" });
                }
                let mut filter = owner_filter(&state.id, &owner);
                // Exact claimed dirtyAt is essential: a queued raid during a
                // repair must remain due, including deterministic fixture time.
                // An in-pass producer write with both timestamp values
                // identical is indistinguishable under the existing TS queue
                // contract; it supplies no monotonic event generation.
                filter.insert("dirtyAt", state.dirty_at.map_or(Bson::Null, Bson::DateTime));
                let saved = self.summaries.update_one(filter, update).await?;
                if saved.matched_count == 0 {
                    // A new producer dirty value retains all old metadata and
                    // the due schedule. Follow writes are safe to rediscover
                    // from the last successfully persisted source fingerprint.
                    self.assert_owner(&state.id, &owner, &heartbeat.lost)
                        .await?;
                } else {
                    published_changed = changed;
                }
                Ok(())
            }
            .await;
            phases.publish_ms = Some(elapsed_ms(started));
            published?;
            Ok(usize::from(published_changed))
        }
        .await;
        if result.is_err() {
            // Never mark a replacement owner's summary as failed or postpone it.
            let mut filter = owner_filter(&state.id, &owner);
            filter.insert("dirtyAt", state.dirty_at.map_or(Bson::Null, Bson::DateTime));
            let _ = self.summaries.update_one(filter,
                doc! { "$set": { "error": true, "nextRefreshAt": DateTime::from_millis(DateTime::now().timestamp_millis() + 30_000) } }).await;
        }
        let started = Instant::now();
        heartbeat.stop().await;
        let released = self
            .summaries
            .update_one(
                doc! { "_id": &state.id, "owner": &owner },
                doc! { "$set": { "leaseUntil": DateTime::from_millis(0) } },
            )
            .await;
        phases.release_ms = Some(elapsed_ms(started));
        match result {
            Err(error) => Err(error),
            Ok(count) => {
                released?;
                Ok(count)
            }
        }
    }

    async fn assert_owner(&self, id: &str, owner: &str, lost: &AtomicBool) -> Result<()> {
        if lost.load(Ordering::Acquire) {
            return Err(lease_error());
        }
        let state = self
            .summaries
            .find_one(owner_filter(id, owner))
            .projection(doc! { "_id": 1 })
            .await?;
        if state.is_none() || lost.load(Ordering::Acquire) {
            return Err(lease_error());
        }
        Ok(())
    }

    async fn refresh_follow_counts(
        &self,
        channel: &str,
        owner: &str,
        now: DateTime,
        lost: &AtomicBool,
        phases: &mut PhaseTimings,
    ) -> Result<FollowRefresh> {
        let started = Instant::now();
        let mut refreshed = FollowRefresh::default();
        let queried: Result<(Vec<UpdateOneModel>, Vec<String>)> = async {
            let rows: Vec<FollowRow> = self
                .history
                .clone_with_type::<FollowRow>()
                .find(follow_due_filter(channel, now))
                .sort(doc! { "followsComputedAt": 1, "occurredAt": 1 })
                .limit(25)
                .max_time(Duration::from_millis(2000))
                .await?
                .try_collect()
                .await?;
            let ids = rows.iter().map(|row| row.id.clone()).collect();
            let mut operations = Vec::with_capacity(rows.len());
            for chunk in rows.chunks(5) {
                self.assert_owner(channel, owner, lost).await?;
                let updates = try_join_all(
                    chunk
                        .iter()
                        .map(|row| self.follow_update(channel, row, now)),
                )
                .await?;
                for update in updates {
                    refreshed.changed |= update.changed;
                    earliest(&mut refreshed.next_open_at, update.next_open_at);
                    if let Some(operation) = update.operation {
                        operations.push(operation);
                    }
                }
            }
            Ok((operations, ids))
        }
        .await;
        phases.follow_queries_ms = Some(elapsed_ms(started));
        let (operations, ids) = queried?;
        if !operations.is_empty() {
            let started = Instant::now();
            let written: Result<()> = async {
                self.assert_owner(channel, owner, lost).await?;
                if refreshed.changed {
                    // Persist before any business-field write. If the bulk,
                    // a later aggregate, publication, or lease fails, another
                    // pass must fingerprint even when all counts now match.
                    let marked = self
                        .summaries
                        .update_one(
                            owner_filter(channel, owner),
                            doc! { "$set": { "rustPending": true } },
                        )
                        .await?;
                    if marked.matched_count == 0 {
                        return Err(lease_error());
                    }
                }
                // Keep Mongoose history's explicit w:1,j:true concern. A
                // partial bulk failure leaves the old source fingerprint in
                // the summary, so successful siblings cannot hide on retry.
                self.database
                    .client()
                    .bulk_write(operations)
                    .ordered(false)
                    .write_concern(
                        WriteConcern::builder()
                            .w(Acknowledgment::Nodes(1))
                            .journal(true)
                            .build(),
                    )
                    .await?;
                Ok(())
            }
            .await;
            phases.follow_write_ms = Some(elapsed_ms(started));
            written?;
        }
        let started = Instant::now();
        let mut due = follow_due_filter(channel, now);
        // Open windows deliberately retain epoch computedAt. Exclude this
        // pass's at most 25 checked IDs when deciding whether to drain more
        // work immediately, otherwise one open window creates a tight loop.
        due.insert("_id", doc! { "$nin": ids });
        let pending = self
            .history
            .find_one(due)
            .projection(doc! { "_id": 1 })
            .max_time(Duration::from_millis(2000))
            .await;
        phases.follow_queries_ms = Some(
            (phases.follow_queries_ms.unwrap_or(0.0) + elapsed_ms(started))
                .min(MAX_METRIC_VALUE as f64),
        );
        refreshed.pending = pending?.is_some();
        Ok(refreshed)
    }

    async fn follow_update(
        &self,
        channel: &str,
        row: &FollowRow,
        now: DateTime,
    ) -> Result<FollowUpdate> {
        row.validate().map_err(|_| malformed())?;
        let next = self.history.clone_with_type::<NextRaid>().find_one(doc! {
            "channelID": channel, "direction": "incoming", "expiresAt": { "$gt": now },
            "$or": [{ "occurredAt": { "$gt": row.occurred_at } }, { "occurredAt": row.occurred_at, "_id": { "$gt": &row.id } }]
        }).sort(doc! { "occurredAt": 1, "_id": 1 }).projection(doc! { "occurredAt": 1 })
            .max_time(Duration::from_millis(1500)).await?;
        let next = next.map(|next| next.occurred_at);
        let (end, computed) = follow_window(row.occurred_at, next, now);
        let count = self.events.count_documents(doc! {
            "channelID": channel, "source": "twitch-eventsub", "type": "channel.follow.received",
            "occurredAt": { "$gte": row.occurred_at, "$lt": end }, "expiresAt": { "$gt": now }
        }).max_time(Duration::from_millis(2000)).await?;
        let (values, changed) = follow_values(row, count, end, computed);
        let next_open_at = (computed.timestamp_millis() == 0).then(|| {
            DateTime::from_millis(
                (now.timestamp_millis() + 60_000)
                    .min(row.occurred_at.timestamp_millis() + WINDOW_MS)
                    .min(next.map_or(i64::MAX, |next| next.timestamp_millis())),
            )
        });
        Ok(FollowUpdate {
            operation: (!values.is_empty()).then(|| {
                UpdateOneModel::builder()
                    .namespace(self.history.namespace())
                    .filter(doc! { "_id": &row.id })
                    .update(doc! { "$set": values })
                    .build()
            }),
            changed,
            next_open_at,
        })
    }

    /// Stream only the existing retained channel history, with constant client
    /// memory and a server deadline. No ID watermark: insertion ordering does
    /// not affect late-source repair. This runs only for producer dirtiness,
    /// actual follow changes, source time boundaries, or one-time adoption.
    async fn source_state(&self, channel: &str, now: DateTime) -> Result<SourceState> {
        let mut rows = self
            .history
            .find(doc! {
                "channelID": channel, "expiresAt": { "$gt": now },
            })
            .sort(doc! { "occurredAt": -1, "_id": 1 })
            .projection(doc! {
                "_id": 1, "direction": 1, "peerID": 1, "peerLogin": 1,
                "peerName": 1, "viewers": 1, "occurredAt": 1, "expiresAt": 1,
                "followsAfter": 1, "followWindowEnd": 1,
            })
            .batch_size(100)
            .max_time(Duration::from_millis(3000))
            .await?;
        let mut digest = Sha256::new();
        let mut next_source_at = None;
        let mut has_follow_windows = false;
        let mut has_period_rows = false;
        while let Some(row) = rows.try_next().await? {
            let occurred = *row.get_datetime("occurredAt").map_err(|_| malformed())?;
            let expires = *row.get_datetime("expiresAt").map_err(|_| malformed())?;
            if occurred > now {
                earliest(&mut next_source_at, Some(occurred.min(expires)));
                continue;
            }
            let in_period = occurred >= raid_range_start(30, now);
            let outgoing = row.get_str("direction").map_err(|_| malformed())? == "outgoing";
            if !in_period && !outgoing {
                continue;
            }
            earliest(&mut next_source_at, Some(expires));
            let mut source = Document::new();
            let fields: &[&str] = if in_period {
                has_period_rows = true;
                has_follow_windows |= !outgoing;
                &[
                    "_id",
                    "direction",
                    "peerID",
                    "peerLogin",
                    "peerName",
                    "viewers",
                    "occurredAt",
                    "followsAfter",
                    "followWindowEnd",
                ]
            } else {
                // Outgoing history older than 30 days still affects reciprocity.
                &["_id", "direction", "peerID", "occurredAt"]
            };
            for field in fields {
                if let Some(value) = row.get(*field) {
                    source.insert(*field, value.clone());
                }
            }
            let bytes = mongodb::bson::serialize_to_vec(&source).map_err(|_| malformed())?;
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
        if has_period_rows {
            // UTC range boundaries change the published from dates as well as
            // membership. An empty channel needs neither midnight work nor a
            // repair timer; its existing producer will queue the next raid.
            digest.update(raid_range_start(7, now).timestamp_millis().to_le_bytes());
            digest.update(raid_range_start(30, now).timestamp_millis().to_le_bytes());
            earliest(
                &mut next_source_at,
                Some(DateTime::from_millis(
                    (now.timestamp_millis().div_euclid(DAY_MS) + 1) * DAY_MS,
                )),
            );
        }
        Ok(SourceState {
            fingerprint: format!("{:x}", digest.finalize()),
            next_source_at,
            has_follow_windows,
        })
    }

    async fn build_period_data(&self, channel: &str, days: u32, now: DateTime) -> Result<Document> {
        let top = |direction: &str| {
            vec![
                doc! { "$match": { "direction": direction } },
                doc! { "$group": { "_id": "$peerID", "count": { "$sum": 1 }, "viewers": { "$sum": "$viewers" },
                "name": { "$first": "$peerName" }, "login": { "$first": "$peerLogin" }, "lastAt": { "$first": "$occurredAt" } } },
                doc! { "$sort": { "count": -1, "_id": 1 } },
                doc! { "$limit": 5 },
            ]
        };
        let recent = |direction: &str| {
            vec![
                doc! { "$match": { "direction": direction } },
                doc! { "$limit": 5 },
                doc! { "$project": { "_id": 0, "peerID": 1, "peerName": 1, "peerLogin": 1, "viewers": 1,
                "occurredAt": 1, "followsAfter": 1, "followWindowEnd": 1 } },
            ]
        };
        let mut results: Vec<Document> = self.history.aggregate(vec![
            doc! { "$match": { "channelID": channel, "occurredAt": { "$gte": raid_range_start(days, now), "$lte": now }, "expiresAt": { "$gt": now } } },
            doc! { "$sort": { "occurredAt": -1, "_id": 1 } },
            doc! { "$facet": {
                "totals": [{ "$group": { "_id": "$direction", "raids": { "$sum": 1 }, "viewers": { "$sum": "$viewers" },
                    "biggest": { "$max": "$viewers" }, "followsAfter": { "$sum": "$followsAfter" },
                    "evaluatedRaids": { "$sum": { "$cond": [{ "$ne": ["$followsAfter", Bson::Null] }, 1, 0] } }, "firstAt": { "$min": "$occurredAt" } } }],
                "incoming": recent("incoming"), "outgoing": recent("outgoing"), "topIncoming": top("incoming"), "topOutgoing": top("outgoing")
            } },
        ]).max_time(Duration::from_millis(3000)).await?.try_collect().await?;
        results.pop().ok_or_else(malformed)
    }

    async fn attach_reciprocity(
        &self,
        channel: &str,
        period: &mut Document,
        now: DateTime,
    ) -> Result<()> {
        // Preserve the original per-period lookup over at most five recent
        // and five top incoming peers. Retained outgoing history before the
        // period still determines reciprocity; there is no lower date bound.
        let peers = period_peers(period)?;
        let outgoing: Vec<Document> = self.history.aggregate(vec![
            doc! { "$match": { "channelID": channel, "direction": "outgoing", "peerID": { "$in": peers },
                "expiresAt": { "$gt": now }, "occurredAt": { "$lte": now } } },
            doc! { "$group": { "_id": "$peerID", "lastAt": { "$max": "$occurredAt" } } },
        ]).max_time(Duration::from_millis(2000)).await?.try_collect().await?;
        attach_outgoing(period, &outgoing)
    }
}

fn needs_source_check(
    state: &State,
    previous: Option<&RefreshState>,
    follows_changed: bool,
    now: DateTime,
) -> bool {
    state.pending || state.error || follows_changed
        || previous.is_none_or(|refresh| {
            refresh.dirty_at != state.dirty_at
                || refresh.next_source_at.is_some_and(|at| at <= now)
        })
        // TS queueRaidSummary writes the same timestamp to both fields. A
        // producer can queue two different raids within one millisecond, so
        // equal remembered dirtyAt alone is insufficient to detect its write.
        || state.dirty_at.is_some_and(|at| state.next_refresh_at == Some(at))
}

fn earliest(current: &mut Option<DateTime>, candidate: Option<DateTime>) {
    if let Some(candidate) = candidate {
        *current = Some(current.map_or(candidate, |current| current.min(candidate)));
    }
}

fn next_refresh_at(refresh: &RefreshState, pending: bool, now: DateTime) -> Option<DateTime> {
    if pending {
        return Some(now);
    }
    let mut next = refresh.next_source_at;
    earliest(&mut next, refresh.next_repair_at);
    earliest(&mut next, refresh.next_open_at);
    next
}

fn follow_due_filter(channel: &str, now: DateTime) -> Document {
    doc! {
        "channelID": channel, "direction": "incoming",
        "occurredAt": { "$gte": raid_range_start(30, now), "$lte": now },
        "expiresAt": { "$gt": now },
        "$or": [
            { "followsComputedAt": Bson::Null },
            { "followsComputedAt": { "$lte": DateTime::from_millis(now.timestamp_millis() - REPAIR_MS) } },
        ],
    }
}

fn same_count(value: Option<&Bson>, count: u64) -> bool {
    match value {
        Some(Bson::Int32(value)) => *value >= 0 && *value as u64 == count,
        Some(Bson::Int64(value)) => *value >= 0 && *value as u64 == count,
        Some(Bson::Double(value)) => *value == count as f64,
        _ => false,
    }
}

fn follow_values(
    row: &FollowRow,
    count: u64,
    end: DateTime,
    computed: DateTime,
) -> (Document, bool) {
    let count_changed = !same_count(row.follows_after.as_ref(), count);
    let finalized = computed.timestamp_millis() != 0;
    // Moving open-window time is not fresh source data. Retain the last
    // evaluated end until a count changes or the exact final end is known.
    let end_changed = (count_changed || finalized) && row.follow_window_end != Some(end);
    let mut values = Document::new();
    if count_changed {
        // Match Mongoose Number's int32-or-JS-double serialization.
        values.insert(
            "followsAfter",
            i32::try_from(count).map_or_else(|_| Bson::Double(count as f64), Bson::Int32),
        );
    }
    if end_changed {
        values.insert("followWindowEnd", end);
    }
    if row.follows_computed_at != Some(computed) {
        // Closed checks advance only this scheduling field when unchanged;
        // open checks with no data change perform no history write at all.
        values.insert("followsComputedAt", computed);
    }
    (values, count_changed || end_changed)
}

fn same_payload(old: &Document, candidate: &Document) -> bool {
    fn stable(payload: &Document) -> Document {
        let mut payload = payload.clone();
        for key in ["7", "30"] {
            if let Ok(period) = payload.get_document_mut(key) {
                period.remove("to");
                // $group does not promise direction order. The recent/top
                // arrays are explicitly ordered and must remain untouched.
                if let Ok(totals) = period.get_array_mut("totals") {
                    totals.sort_by(|left, right| {
                        let left = left
                            .as_document()
                            .and_then(|row| row.get_str("_id").ok())
                            .unwrap_or("");
                        let right = right
                            .as_document()
                            .and_then(|row| row.get_str("_id").ok())
                            .unwrap_or("");
                        left.cmp(right)
                    });
                }
            }
        }
        payload
    }
    stable(old) == stable(candidate)
}

fn period_peers(data: &Document) -> Result<Vec<Bson>> {
    let mut peers = Vec::with_capacity(10);
    for (key, field) in [("incoming", "peerID"), ("topIncoming", "_id")] {
        for row in data.get_array(key).map_err(|_| malformed())? {
            let row = row.as_document().ok_or_else(malformed)?;
            let peer = row.get(field).cloned().unwrap_or(Bson::Null);
            if !peers.contains(&peer) {
                peers.push(peer);
            }
        }
    }
    Ok(peers)
}

fn attach_outgoing(data: &mut Document, outgoing: &[Document]) -> Result<()> {
    for (key, field) in [("incoming", "peerID"), ("topIncoming", "_id")] {
        for row in data.get_array_mut(key).map_err(|_| malformed())? {
            let row = row.as_document_mut().ok_or_else(malformed)?;
            let last = outgoing
                .iter()
                .find(|sent| sent.get("_id") == row.get(field))
                .and_then(|sent| sent.get("lastAt"))
                .cloned()
                .unwrap_or(Bson::Null);
            row.insert("lastOutgoingAt", last);
        }
    }
    Ok(())
}

fn period_payload(data: Document, days: u32, now: DateTime) -> Document {
    let mut period = doc! { "days": days as i32, "from": raid_range_start(days, now), "to": now };
    period.extend(data);
    period
}

struct Heartbeat {
    lost: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl Heartbeat {
    fn start(states: Collection<Document>, id: String, owner: String) -> Self {
        let lost = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&lost);
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
                let result = states
                    .update_one(
                        owner_filter(&id, &owner),
                        doc! { "$set": { "leaseUntil": lease_until(DateTime::now()) } },
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
mod tests {
    use super::*;

    #[test]
    fn utc_ranges_include_today_and_handle_pre_epoch_dates() {
        for now in [0, 1, DAY_MS - 1, DAY_MS, 20_000 * DAY_MS + 12_345, -1] {
            let now = DateTime::from_millis(now);
            for days in [7, 30] {
                let from = raid_range_start(days, now).timestamp_millis();
                assert_eq!(from.rem_euclid(DAY_MS), 0);
                assert_eq!(
                    now.timestamp_millis().div_euclid(DAY_MS) - from.div_euclid(DAY_MS),
                    i64::from(days) - 1
                );
            }
        }
    }

    #[test]
    fn attribution_windows_are_half_open_and_close_at_the_next_raid() {
        let at = DateTime::from_millis(1_000_000);
        for (next, now, end, completed) in [
            (None, 1_100_000, 1_100_000, 0),
            (None, 1_300_000, 1_300_000, 1_300_000),
            (None, 1_900_000, 1_300_000, 1_900_000),
            (Some(1_050_000), 1_100_000, 1_050_000, 1_100_000),
            (Some(1_200_000), 1_100_000, 1_100_000, 0),
            (Some(1_000_000), 1_100_000, 1_000_000, 1_100_000),
        ] {
            assert_eq!(
                follow_window(
                    at,
                    next.map(DateTime::from_millis),
                    DateTime::from_millis(now)
                ),
                (DateTime::from_millis(end), DateTime::from_millis(completed))
            );
        }
    }

    #[test]
    fn state_and_follow_rows_reject_empty_id_without_requiring_optional_defaults() {
        let state: State =
            mongodb::bson::deserialize_from_document(doc! { "_id": "channel" }).unwrap();
        assert!(state.validate().is_ok());
        let state: State = mongodb::bson::deserialize_from_document(doc! { "_id": "" }).unwrap();
        assert!(state.validate().is_err());
        let row: FollowRow = mongodb::bson::deserialize_from_document(
            doc! { "_id": "raid", "occurredAt": DateTime::from_millis(0) },
        )
        .unwrap();
        assert!(row.validate().is_ok());
    }

    #[test]
    fn phases_omit_unreached_work_and_keep_fixed_names_for_attempted_work() {
        let phases = PhaseTimings::default();
        assert_eq!(serde_json::to_value(phases).unwrap(), serde_json::json!({}));
        let phases = PhaseTimings {
            claim_ms: Some(1.0),
            follow_queries_ms: Some(2.0),
            follow_write_ms: Some(3.0),
            period7_ms: Some(4.0),
            period30_ms: Some(5.0),
            reciprocity_ms: Some(6.0),
            publish_ms: Some(7.0),
            release_ms: Some(8.0),
        };
        assert_eq!(
            serde_json::to_value(phases).unwrap(),
            serde_json::json!({
                "claimMs": 1.0, "followQueriesMs": 2.0, "followWriteMs": 3.0,
                "period7Ms": 4.0, "period30Ms": 5.0, "reciprocityMs": 6.0,
                "publishMs": 7.0, "releaseMs": 8.0
            })
        );
    }

    fn followed_row(count: Option<Bson>, end: i64, computed: i64) -> FollowRow {
        FollowRow {
            id: "raid".into(),
            occurred_at: DateTime::from_millis(1_000_000),
            follows_after: count,
            follow_window_end: Some(DateTime::from_millis(end)),
            follows_computed_at: Some(DateTime::from_millis(computed)),
        }
    }

    #[test]
    fn an_unchanged_open_window_does_not_advance_derived_data_or_write_history() {
        let row = followed_row(Some(Bson::Int32(0)), 1_060_000, 0);
        let (values, changed) = follow_values(
            &row,
            0,
            DateTime::from_millis(1_120_000),
            DateTime::from_millis(0),
        );
        assert!(!changed);
        assert!(values.is_empty());
        let (values, changed) = follow_values(
            &row,
            1,
            DateTime::from_millis(1_120_000),
            DateTime::from_millis(0),
        );
        assert!(changed);
        assert_eq!(values.get_i32("followsAfter").unwrap(), 1);
        assert_eq!(
            *values.get_datetime("followWindowEnd").unwrap(),
            DateTime::from_millis(1_120_000)
        );
    }

    #[test]
    fn finalization_changes_the_end_once_and_closed_repairs_only_advance_scheduling() {
        let mut row = followed_row(Some(Bson::Double(3.0)), 1_060_000, 0);
        let closed = DateTime::from_millis(1_300_000);
        let (values, changed) = follow_values(&row, 3, closed, closed);
        assert!(changed);
        assert!(!values.contains_key("followsAfter"));
        assert_eq!(*values.get_datetime("followWindowEnd").unwrap(), closed);
        row.follow_window_end = Some(closed);
        row.follows_computed_at = Some(closed);
        let later = DateTime::from_millis(closed.timestamp_millis() + REPAIR_MS);
        let (values, changed) = follow_values(&row, 3, closed, later);
        assert!(!changed);
        assert_eq!(values, doc! { "followsComputedAt": later });
        let (values, changed) = follow_values(&row, 4, closed, later);
        assert!(changed);
        assert_eq!(values.get_i32("followsAfter").unwrap(), 4);
    }

    #[test]
    fn unevaluated_zero_is_a_change_and_count_serialization_matches_mongoose() {
        let row = followed_row(None, 1_060_000, 0);
        let (values, changed) = follow_values(
            &row,
            0,
            DateTime::from_millis(1_060_000),
            DateTime::from_millis(0),
        );
        assert!(changed);
        assert_eq!(values.get_i32("followsAfter").unwrap(), 0);
        let count = i32::MAX as u64 + 1;
        let (values, changed) = follow_values(
            &row,
            count,
            DateTime::from_millis(1_060_000),
            DateTime::from_millis(0),
        );
        assert!(changed);
        assert_eq!(values.get_f64("followsAfter").unwrap(), count as f64);
    }

    #[test]
    fn no_change_guard_ignores_only_the_moving_to_time() {
        let from = DateTime::from_millis(0);
        let mut old = doc! {
            "7": { "from": from, "to": from, "incoming": [{ "followsAfter": 0 }] },
            "30": { "from": from, "to": from, "incoming": [] },
        };
        let mut candidate = old.clone();
        candidate
            .get_document_mut("7")
            .unwrap()
            .insert("to", DateTime::from_millis(60_000));
        candidate
            .get_document_mut("30")
            .unwrap()
            .insert("to", DateTime::from_millis(60_000));
        assert!(same_payload(&old, &candidate));
        candidate
            .get_document_mut("7")
            .unwrap()
            .insert("from", DateTime::from_millis(DAY_MS));
        assert!(!same_payload(&old, &candidate));
        old.get_document_mut("7")
            .unwrap()
            .insert("from", DateTime::from_millis(DAY_MS));
        assert!(same_payload(&old, &candidate));
        candidate
            .get_document_mut("7")
            .unwrap()
            .insert("incoming", vec![doc! { "followsAfter": 1 }]);
        assert!(!same_payload(&old, &candidate));
    }

    #[test]
    fn group_order_is_not_a_change_but_recent_order_is() {
        let old = doc! {
            "7": {
                "totals": [{ "_id": "incoming", "raids": 1 }, { "_id": "outgoing", "raids": 2 }],
                "incoming": [{ "peerID": "first" }, { "peerID": "second" }],
            },
            "30": {},
        };
        let mut reordered = old.clone();
        reordered
            .get_document_mut("7")
            .unwrap()
            .get_array_mut("totals")
            .unwrap()
            .reverse();
        assert!(same_payload(&old, &reordered));
        reordered
            .get_document_mut("7")
            .unwrap()
            .get_array_mut("incoming")
            .unwrap()
            .reverse();
        assert!(!same_payload(&old, &reordered));
    }

    #[test]
    fn same_timestamp_producer_queue_still_checks_source_but_scheduled_restart_does_not() {
        let now = DateTime::from_millis(1_000_000);
        let scheduled = DateTime::from_millis(now.timestamp_millis() + REPAIR_MS);
        let mut state: State = mongodb::bson::deserialize_from_document(doc! {
            "_id": "channel", "dirtyAt": now, "nextRefreshAt": scheduled,
            "payload": {},
        })
        .unwrap();
        let previous = RefreshState {
            version: REFRESH_VERSION,
            fingerprint: "already-published".into(),
            next_source_at: Some(scheduled),
            next_repair_at: Some(scheduled),
            next_open_at: None,
            dirty_at: Some(now),
            has_follow_windows: true,
        };
        assert!(!needs_source_check(&state, Some(&previous), false, now));
        // A new outgoing raid uses the same dirtyAt millisecond as the prior
        // one. Its producer queue resets nextRefreshAt to that timestamp.
        state.next_refresh_at = Some(now);
        assert!(needs_source_check(&state, Some(&previous), false, now));
        state.next_refresh_at = Some(scheduled);
        // A persisted partial-write marker survives process restart even when
        // the retry's follow counts and producer timestamps are unchanged.
        state.pending = true;
        assert!(needs_source_check(&state, Some(&previous), false, now));
    }

    #[test]
    fn pending_windows_drain_immediately_and_empty_channels_wait_for_the_producer() {
        let now = DateTime::from_millis(1_000_000);
        let mut refresh = RefreshState {
            version: REFRESH_VERSION,
            fingerprint: String::new(),
            next_source_at: None,
            next_repair_at: None,
            next_open_at: None,
            dirty_at: Some(now),
            has_follow_windows: false,
        };
        assert_eq!(next_refresh_at(&refresh, false, now), None);
        assert_eq!(next_refresh_at(&refresh, true, now), Some(now));
        let repair = DateTime::from_millis(now.timestamp_millis() + REPAIR_MS);
        let open = DateTime::from_millis(now.timestamp_millis() + 60_000);
        let future = DateTime::from_millis(now.timestamp_millis() + 5_000);
        refresh.next_repair_at = Some(repair);
        assert_eq!(next_refresh_at(&refresh, false, now), Some(repair));
        refresh.next_open_at = Some(open);
        assert_eq!(next_refresh_at(&refresh, false, now), Some(open));
        // The same boundary covers future activation and older outgoing expiry.
        refresh.next_source_at = Some(future);
        assert_eq!(next_refresh_at(&refresh, false, now), Some(future));
    }

    #[test]
    fn per_period_peers_and_enrichment_preserve_order_dates_types_and_null_defaults() {
        let older = DateTime::from_millis(0);
        let newer = DateTime::from_millis(DAY_MS);
        let now = DateTime::from_millis(60 * DAY_MS);
        let mut period7 = doc! {
            "totals": [{ "_id": "incoming", "raids": 2_i32, "viewers": 7.5_f64 }],
            "incoming": [{ "peerID": "shared", "viewers": 3_i32 }, {}, { "peerID": Bson::Null }],
            "outgoing": [],
            "topIncoming": [{ "_id": "recent-only", "count": 2_i32 }],
            "topOutgoing": [],
        };
        let mut period30 = doc! {
            "totals": [],
            "incoming": [{ "peerID": "month-only" }, { "peerID": "shared" }],
            "outgoing": [],
            "topIncoming": [{ "_id": "shared" }, { "_id": "unanswered" }],
            "topOutgoing": [],
        };
        let outgoing = vec![
            doc! { "_id": "shared", "lastAt": older },
            doc! { "_id": "month-only", "lastAt": newer },
            doc! { "_id": Bson::Null, "lastAt": newer },
        ];
        assert_eq!(
            period_peers(&period7).unwrap(),
            vec![
                Bson::String("shared".into()),
                Bson::Null,
                Bson::String("recent-only".into()),
            ]
        );
        assert_eq!(
            period_peers(&period30).unwrap(),
            vec![
                Bson::String("month-only".into()),
                Bson::String("shared".into()),
                Bson::String("unanswered".into())
            ]
        );
        attach_outgoing(&mut period7, &outgoing).unwrap();
        attach_outgoing(&mut period30, &outgoing).unwrap();
        let incoming = period7.get_array("incoming").unwrap();
        assert_eq!(
            incoming[0],
            Bson::Document(doc! { "peerID": "shared", "viewers": 3_i32, "lastOutgoingAt": older })
        );
        // A missing peer and an explicit null retain their existing distinction.
        assert_eq!(
            incoming[1],
            Bson::Document(doc! { "lastOutgoingAt": Bson::Null })
        );
        assert_eq!(
            incoming[2],
            Bson::Document(doc! { "peerID": Bson::Null, "lastOutgoingAt": newer })
        );
        assert_eq!(
            period30.get_array("incoming").unwrap(),
            &vec![
                Bson::Document(doc! { "peerID": "month-only", "lastOutgoingAt": newer }),
                Bson::Document(doc! { "peerID": "shared", "lastOutgoingAt": older }),
            ]
        );
        assert_eq!(
            period30.get_array("topIncoming").unwrap()[1],
            Bson::Document(doc! {
                "_id": "unanswered", "lastOutgoingAt": Bson::Null
            })
        );
        let payload = period_payload(period7, 7, now);
        assert_eq!(
            payload.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "days",
                "from",
                "to",
                "totals",
                "incoming",
                "outgoing",
                "topIncoming",
                "topOutgoing"
            ]
        );
        assert_eq!(payload.get_i32("days").unwrap(), 7);
        assert_eq!(
            *payload.get_datetime("from").unwrap(),
            raid_range_start(7, now)
        );
        assert_eq!(*payload.get_datetime("to").unwrap(), now);
        assert_eq!(
            payload.get_array("totals").unwrap()[0],
            Bson::Document(doc! {
                "_id": "incoming", "raids": 2_i32, "viewers": 7.5_f64
            })
        );
    }
}
