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
use tokio::{sync::oneshot, task::JoinHandle};

const DAY_MS: i64 = 86_400_000;
const WINDOW_MS: i64 = 300_000;
const LEASE_MS: i64 = 60_000;
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

/// One leased channel per pass, at most 25 follow windows, five query tasks at a
/// time, then the unchanged MongoDB 7/30-day aggregation pipelines.
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
}

#[derive(Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct FollowRow {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    id: String,
    #[garde(skip)]
    occurred_at: DateTime,
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

    /// Returns zero when idle or one when a channel summary was refreshed.
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
            self.refresh_follow_counts(&state.id, &owner, now, &heartbeat.lost, phases).await?;
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
            phases.reciprocity_ms = Some((phases.reciprocity_ms.unwrap_or(0.0) + elapsed_ms(started))
                .min(MAX_METRIC_VALUE as f64));
            reciprocity?;
            let payload = doc! {
                "7": period_payload(period7, 7, now),
                "30": period_payload(period30, 30, now),
            };
            let started = Instant::now();
            let published: Result<()> = async {
                self.assert_owner(&state.id, &owner, &heartbeat.lost).await?;
                let saved = self.summaries.update_one(owner_filter(&state.id, &owner),
                    doc! { "$set": { "payload": payload, "updatedAt": now, "error": false } }).await?;
                if saved.matched_count == 0 { return Err(lease_error()); }
                self.assert_owner(&state.id, &owner, &heartbeat.lost).await?;
                let mut filter = owner_filter(&state.id, &owner);
                filter.insert("dirtyAt", doc! { "$lte": now });
                // A producer queueing a new event during this pass keeps it due.
                self.summaries.update_one(filter,
                    doc! { "$set": { "nextRefreshAt": DateTime::from_millis(now.timestamp_millis() + 60_000) } }).await?;
                Ok(())
            }.await;
            phases.publish_ms = Some(elapsed_ms(started));
            published?;
            Ok(1)
        }.await;
        if result.is_err() {
            // Never mark a replacement owner's summary as failed or postpone it.
            let _ = self.summaries.update_one(owner_filter(&state.id, &owner),
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
    ) -> Result<()> {
        let started = Instant::now();
        let operations: Result<Vec<UpdateOneModel>> = async {
            let rows: Vec<FollowRow> = self.history.clone_with_type::<FollowRow>().find(doc! {
                "channelID": channel, "direction": "incoming",
                "occurredAt": { "$gte": raid_range_start(30, now), "$lte": now }, "expiresAt": { "$gt": now },
                "$or": [{ "followsComputedAt": Bson::Null }, { "followsComputedAt": { "$lt": DateTime::from_millis(now.timestamp_millis() - 15 * 60_000) } }]
            }).sort(doc! { "followsComputedAt": 1, "occurredAt": 1 }).limit(25)
                .max_time(Duration::from_millis(2000)).await?.try_collect().await?;
            let mut operations = Vec::with_capacity(rows.len());
            for chunk in rows.chunks(5) {
                self.assert_owner(channel, owner, lost).await?;
                let updates = try_join_all(
                    chunk
                        .iter()
                        .map(|row| self.follow_update(channel, row, now)),
                )
                .await?;
                operations.extend(updates);
            }
            Ok(operations)
        }.await;
        phases.follow_queries_ms = Some(elapsed_ms(started));
        let operations = operations?;
        if !operations.is_empty() {
            let started = Instant::now();
            let written: Result<()> = async {
                self.assert_owner(channel, owner, lost).await?;
                // Mongoose history writes explicitly require w:1,j:true. Client
                // bulk writes otherwise inherit client, not collection, concerns.
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
        Ok(())
    }

    async fn follow_update(
        &self,
        channel: &str,
        row: &FollowRow,
        now: DateTime,
    ) -> Result<UpdateOneModel> {
        row.validate().map_err(|_| malformed())?;
        let next = self.history.clone_with_type::<NextRaid>().find_one(doc! {
            "channelID": channel, "direction": "incoming", "expiresAt": { "$gt": now },
            "$or": [{ "occurredAt": { "$gt": row.occurred_at } }, { "occurredAt": row.occurred_at, "_id": { "$gt": &row.id } }]
        }).sort(doc! { "occurredAt": 1, "_id": 1 }).projection(doc! { "occurredAt": 1 })
            .max_time(Duration::from_millis(1500)).await?;
        let (end, computed) =
            follow_window(row.occurred_at, next.map(|next| next.occurred_at), now);
        let count = self.events.count_documents(doc! {
            "channelID": channel, "source": "twitch-eventsub", "type": "channel.follow.received",
            "occurredAt": { "$gte": row.occurred_at, "$lt": end }, "expiresAt": { "$gt": now }
        }).max_time(Duration::from_millis(2000)).await?;
        // Match the JS driver's numeric serialization for Mongoose Number:
        // integral int32 when representable, otherwise a JS numeric double.
        let count = i32::try_from(count).map_or_else(|_| Bson::Double(count as f64), Bson::Int32);
        Ok(UpdateOneModel::builder().namespace(self.history.namespace())
            .filter(doc! { "_id": &row.id })
            .update(doc! { "$set": { "followsAfter": count, "followWindowEnd": end, "followsComputedAt": computed } })
            .build())
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
