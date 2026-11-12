//! Stream online/offline lifecycle from `utils/stream_analytics.ts`.
//!
//! Callers initialize model indexes and supply Mongo, clock and the existing durable queue
//! producer (which supplies randomness and typed queue windows). No scheduler or environment
//! reads. Direct Mongo calls have five-second deadlines; queue producers retain their configured
//! store deadlines. The reference retries selected online
//! operations three times, waiting 100 then 200 ms after errors; unkeyed offline does the same,
//! while keyed offline defers immediately to its durable consumer. CAS misses are not retried.
//!
//! Offline first records the mutation, then separately receipts summary and clip acceptance.
//! Summary acceptance is unconditional (+120 seconds); clips require autoAnalyzeEnabled and
//! the stored user's exact `pro` tier (+300 seconds). Expiry is deliberately not checked.
//! A skipped clip decision is still receipted. Future jobs live in Mongo until due, so normal
//! lifecycle calls do not immediately publish Dragonfly payloads.
//!
//! Preserved reference gaps: cancellation after superseding an old live session but before
//! accepting its summary loses that summary on replay. Unkeyed offline replay after closure
//! has no receipt to recover pending jobs either. Concurrent lifecycle changes can fail
//! their CAS and require consumer redelivery. No transaction or new stored receipt is added.
use crate::{
    Error as StoreError, bounded,
    clip_recommendations_queue::{
        ClipRecommendationInput, QueueProducer, enqueue_clip_recommendation_job,
    },
    stream_memory_queue::{StreamMemorySummaryInput, enqueue_stream_memory_summary_job},
    timeline_store::{Store, date, number, text},
};
use bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use dima_events::{
    consumer::handler::Outcome,
    jobs::{JobError, JobQueue},
};
use dima_model::stream_sessions::INFO;
use dima_store::mongo::{
    MongoStore, WriteContext,
    update::{Returned, UpdateOptions},
    write::UpdateOutcome,
};
use mongodb::options::{Acknowledgment, WriteConcern};
use serde::Deserialize;
use std::{future::Future, sync::Arc, time::Duration};

pub const SNAPSHOT_OFFLINE_MATCH_WINDOW_MS: i64 = 60_000;
#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Job(#[from] JobError),
    #[error("{0}")]
    MissingPrerequisite(String),
}
impl LifecycleError {
    pub fn consumer_outcome(self) -> Outcome {
        match self {
            Self::MissingPrerequisite(p) => Outcome::MissingPrerequisite(p),
            e => Outcome::Failed(e.to_string()),
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Online {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(default)]
    pub channel: String,
    #[serde(rename = "streamID")]
    pub stream_id: Option<String>,
    pub started_at: Option<String>,
    pub event_key: Option<String>,
    pub reopen_closed: Option<bool>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offline {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub ended_at: Option<String>,
    pub event_key: Option<String>,
    #[serde(rename = "repairSessionID")]
    pub repair_session_id: Option<String>,
}
#[cfg(feature = "test-util")]
type Before = Arc<dyn Fn(&'static str) -> Result<(), StoreError> + Send + Sync>;
#[derive(Clone)]
pub struct StreamSessionLifecycle {
    store: Store,
    #[cfg(feature = "test-util")]
    before: Option<Before>,
}
impl StreamSessionLifecycle {
    pub fn new(mongo: MongoStore, clock: Arc<dyn dima_core::Clock>) -> Self {
        Self {
            store: Store::new(mongo, clock),
            #[cfg(feature = "test-util")]
            before: None,
        }
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook);
        self
    }
    #[cfg(feature = "test-util")]
    pub fn with_operation_hook(mut self, hook: Before) -> Self {
        self.before = Some(hook);
        self
    }
    fn before(&self, operation: &'static str) -> Result<(), StoreError> {
        #[cfg(feature = "test-util")]
        if let Some(h) = &self.before {
            h(operation)?;
        }
        let _ = operation;
        Ok(())
    }
    fn at(&self, value: &Option<String>) -> DateTime {
        DateTime::from_millis(
            value
                .as_deref()
                .and_then(dima_text::parse_date)
                .unwrap_or_else(|| self.store.clock.now_ms()),
        )
    }
    async fn find(&self, filter: Document, sort: Document) -> Result<Option<Document>, StoreError> {
        Ok(self
            .store
            .find(INFO.name, filter, sort, 1, 0, 1500)
            .await?
            .into_iter()
            .next())
    }
    async fn update(
        &self,
        filter: Document,
        update: Document,
        upsert: bool,
        journal: bool,
    ) -> Result<UpdateOutcome, StoreError> {
        let p = INFO.prepare_update(
            &filter,
            update,
            UpdateOptions {
                upsert,
                ..Default::default()
            },
            &mut WriteContext::new(self.store.clock.now_ms()),
        )?;
        let mut writes = self.store.mongo.writes(INFO.name);
        if journal {
            writes = writes.write_concern(concern());
        }
        let result = bounded(self.store.deadline, writes.update_one(&p)).await?;
        if result.sent {
            self.store.after_write().await;
        }
        Ok(result)
    }
    async fn create(
        &self,
        filter: Document,
        update: Document,
    ) -> Result<Option<Document>, StoreError> {
        let p = INFO.prepare_find_one_and_update(
            &filter,
            update,
            UpdateOptions {
                upsert: true,
                ..Default::default()
            },
            Returned::After,
            &mut WriteContext::new(self.store.clock.now_ms()),
        )?;
        let result = bounded(
            self.store.deadline,
            self.store
                .mongo
                .writes(INFO.name)
                .write_concern(concern())
                .find_one_and_update(&p),
        )
        .await?;
        if result.is_some() {
            self.store.after_write().await;
        }
        Ok(result)
    }
    async fn receipt(&self, channel: &str, key: &str) -> Result<Option<Document>, StoreError> {
        self.find(
            doc! {"channelID":channel,"applied_domain_event_keys":key},
            doc! {},
        )
        .await
    }
    pub async fn record_stream_online_event<Q: JobQueue>(
        &self,
        input: &Online,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<(), LifecycleError> {
        let channel = &input.channel_id;
        if channel.is_empty() {
            return Ok(());
        }
        let start = self.at(&input.started_at);
        let stream = input
            .stream_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("stream-{channel}-{}", start.timestamp_millis()));
        let key = input.event_key.as_deref().filter(|s| !s.is_empty());
        if let Some(key) = key
            && self.receipt(channel, key).await?.is_some()
        {
            return Ok(());
        }
        let existing = self
            .find(doc! {"channelID":channel,"stream_id":&stream}, doc! {})
            .await?;
        let live = retry(2, || async {
            self.before("findExistingLiveSession")?;
            self.find(
                doc! {"channelID":channel,"status":"live","ended_at":Bson::Null},
                doc! {"started_at":-1},
            )
            .await
        })
        .await?;
        let threshold = existing
            .as_ref()
            .map(|d| date(d, "started_at"))
            .transpose()?
            .unwrap_or(start);
        let newer=self.find(doc!{"channelID":channel,"stream_id":{"$ne":&stream},"started_at":{"$gte":threshold}},doc!{"started_at":1}).await?;
        if let Some(old) = &existing
            && text(old, "status") != "live"
        {
            let recover = key.is_some()
                && input.stream_id.as_ref().is_some_and(|s| !s.is_empty())
                && text(old, "status") == "orphaned"
                && ["", "snapshot"].contains(&text(old, "closure_source"))
                && number(old, "consecutive_offline_checks") >= 2.0
                && !present(old, "offline_summary_enqueued_at")
                && !present(old, "offline_clips_completed_at")
                && live.is_none()
                && newer.is_none();
            if recover || input.reopen_closed == Some(false) || text(old, "status") == "offline" {
                if let Some(key) = key {
                    let mut filter = doc! {"_id":id(old),"status":text(old,"status"),"ended_at":field(old,"ended_at"),"applied_domain_event_keys":{"$ne":key}};
                    let mut update = doc! {"$addToSet":{"applied_domain_event_keys":key}};
                    if recover {
                        filter.extend(doc!{"consecutive_offline_checks":{"$gte":2},"closure_source":source(old),"offline_summary_enqueued_at":Bson::Null,"offline_clips_completed_at":Bson::Null});
                        update.extend(doc!{"$set":{"channel":&input.channel,"status":"live","ended_at":Bson::Null,"last_seen_live_at":self.store.now(),"consecutive_offline_checks":0},"$unset":{"closure_source":1}});
                    }
                    if self.update(filter, update, false, true).await?.matched == 0 {
                        return Err(changed(
                            "Session changed while applying stream.online",
                            channel,
                        )
                        .into());
                    }
                }
                return Ok(());
            }
        }
        if let Some(live) = &live
            && text(live, "stream_id") == stream
        {
            let result = retry(2, || async {
                self.before("updateExistingSession")?;
                let update = with_key(
                    doc! {"$set":{"channel":&input.channel,"last_seen_live_at":self.store.now(),"consecutive_offline_checks":0,"status":"live","ended_at":Bson::Null}}, key,
                );
                self.update(
                    doc! {"_id":id(live),"status":"live","ended_at":Bson::Null},
                    update.clone(),
                    false,
                    true,
                )
                .await
            })
            .await?;
            if result.matched == 0 {
                return Err(
                    changed("Live session changed while applying stream.online", channel).into(),
                );
            }
            return Ok(());
        }
        if let Some(newer) = newer {
            let end = date(&newer, "started_at")?;
            let mut base = initial(channel, &stream, start);
            base.extend(doc!{"ended_at":end,"status":"orphaned","closure_source":"superseded","channel":&input.channel,"duration_minutes":duration_minutes(start,end)});
            let result = self
                .update(
                    doc! {"channelID":channel,"stream_id":&stream},
                    with_key(doc! {"$setOnInsert":base}, key),
                    true,
                    true,
                )
                .await?;
            if result.matched == 0 && result.upserted_id.is_none() {
                return Err(changed(
                    "Historical session changed while applying stream.online",
                    channel,
                )
                .into());
            }
            return Ok(());
        }
        if let Some(live) = &live {
            let update = doc! {"$set":{"ended_at":start,"status":"orphaned","closure_source":"superseded","duration_minutes":duration_minutes(date(live,"started_at")?,start)}};
            let result = retry(2, || async {
                self.before("orphanOldSession")?;
                self.update(
                    doc! {"_id":id(live),"status":"live","ended_at":Bson::Null},
                    update.clone(),
                    false,
                    false,
                )
                .await
            })
            .await?;
            if result.modified == 0 {
                return Err(
                    changed("Live session changed while applying stream.online", channel).into(),
                );
            }
            // Intentionally best effort, as in the reference. Replay after this gap does not
            // revisit the old session and cannot recover a summary not yet accepted.
            let _ = self
                .enqueue_post_stream_summary_job(
                    jobs,
                    channel,
                    live,
                    "superseded_live_session",
                    "recordStreamOnlineEvent",
                )
                .await;
        }
        let update = with_key(
            doc! {"$setOnInsert":initial(channel,&stream,start),"$set":{"channel":&input.channel,"status":"live","ended_at":Bson::Null,"last_seen_live_at":self.store.now(),"consecutive_offline_checks":0},"$unset":{"closure_source":1}},
            key,
        );
        let filter = doc! {"channelID":channel,"stream_id":&stream,"status":existing.as_ref().map(|d|text(d,"status")).unwrap_or("live"),"ended_at":existing.as_ref().map(|d|field(d,"ended_at")).unwrap_or(Bson::Null)};
        let result = retry(2, || async {
            self.before("createSession")?;
            self.create(filter.clone(), update.clone()).await
        })
        .await?;
        if result.is_none() {
            return Err(changed("Session changed while creating stream.online", channel).into());
        }
        Ok(())
    }
    pub async fn record_stream_offline_event<Q: JobQueue>(
        &self,
        input: &Offline,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<(), LifecycleError> {
        let channel = &input.channel_id;
        if channel.is_empty() {
            return Ok(());
        }
        let end = self.at(&input.ended_at);
        let key = input.event_key.as_deref().filter(|s| !s.is_empty());
        let applied = if let Some(key) = key {
            self.receipt(channel, key).await?
        } else {
            None
        };
        let missing = || {
            LifecycleError::MissingPrerequisite(format!(
                "stream-session:{channel}:{}",
                dima_text::to_iso_string(end.timestamp_millis()).unwrap_or_default()
            ))
        };
        let ambiguous =
            || LifecycleError::MissingPrerequisite(format!("ambiguous-stream-session:{channel}"));
        let session = if let Some(session) = &applied {
            Some(session.clone())
        } else {
            let bounds = doc! {"$gte":DateTime::from_millis(end.timestamp_millis()-SNAPSHOT_OFFLINE_MATCH_WINDOW_MS),"$lte":DateTime::from_millis(end.timestamp_millis()+SNAPSHOT_OFFLINE_MATCH_WINDOW_MS)};
            let mut alternatives = vec![
                doc! {"status":"live","ended_at":Bson::Null},
                doc! {"status":"orphaned","closure_source":"snapshot","ended_at":bounds.clone()},
            ];
            if let Some(repair) = input.repair_session_id.as_deref().filter(|s| !s.is_empty()) {
                let repair =
                    ObjectId::parse_str(repair).map_err(|e| StoreError::Invalid(e.to_string()))?;
                alternatives.push(doc!{"_id":repair,"status":"orphaned","closure_source":Bson::Null,"consecutive_offline_checks":{"$gte":2},"ended_at":bounds});
            }
            retry(if key.is_some() { 0 } else { 2 }, || async {
                self.before("findActiveSession")?;
                self.find(
                    doc! {"channelID":channel,"started_at":{"$lte":end},"$or":alternatives.clone()},
                    doc! {"started_at":-1},
                )
                .await
            })
            .await?
        };
        let Some(session) = session else {
            return if key.is_some() {
                Err(missing())
            } else {
                Ok(())
            };
        };
        if applied.is_none() {
            if let Some(repair) = input.repair_session_id.as_deref().filter(|s| !s.is_empty())
                && session
                    .get_object_id("_id")
                    .map(|v| v.to_hex())
                    .ok()
                    .as_deref()
                    != Some(repair)
            {
                return Err(ambiguous());
            }
            let newer=self.find(doc!{"channelID":channel,"_id":{"$ne":id(&session)},"started_at":{"$gte":date(&session,"started_at")?,"$lte":end}},doc!{}).await?;
            let other=self.find(doc!{"channelID":channel,"_id":{"$ne":id(&session)},"status":{"$ne":"live"},"started_at":{"$lte":end},"ended_at":{"$gte":DateTime::from_millis(end.timestamp_millis()-SNAPSHOT_OFFLINE_MATCH_WINDOW_MS)}},doc!{}).await?;
            if newer.is_some() || other.is_some() {
                return Err(ambiguous());
            }
            let mut filter = doc! {"_id":id(&session),"status":text(&session,"status"),"ended_at":field(&session,"ended_at"),"closure_source":source(&session)};
            if let Some(key) = key {
                filter.insert("applied_domain_event_keys", doc! {"$ne":key});
            }
            let update = with_key(
                doc! {"$set":{"ended_at":end,"status":"offline","closure_source":"eventsub","duration_minutes":duration_minutes(date(&session,"started_at")?,end),"consecutive_offline_checks":0}},
                key,
            );
            let result = retry(if key.is_some() { 0 } else { 2 }, || async {
                self.before("markSessionOffline")?;
                self.update(filter.clone(), update.clone(), false, true)
                    .await
            })
            .await?;
            if result.modified==0 && (key.is_none() || self.find(doc!{"_id":id(&session),"applied_domain_event_keys":key.unwrap_or_default()},doc!{}).await?.is_none()) {return Err(missing());}
        }
        for step in ["offline_summary_enqueued_at", "offline_clips_completed_at"] {
            if key.is_some() && present(&session, step) {
                continue;
            }
            let result = if step == "offline_summary_enqueued_at" {
                self.enqueue_post_stream_summary_job(
                    jobs,
                    channel,
                    &session,
                    "stream_offline",
                    "recordStreamOfflineEvent",
                )
                .await
            } else {
                self.enqueue_automatic_clip_recommendation_job(
                    jobs,
                    channel,
                    &session,
                    duration_minutes(date(&session, "started_at")?, end),
                )
                .await
            };
            if key.is_some() {
                result?;
            }
            if let Some(key) = key {
                let mut set = Document::new();
                set.insert(step, self.store.now());
                if self
                    .update(
                        doc! {"_id":id(&session),"applied_domain_event_keys":key},
                        doc! {"$set":set},
                        false,
                        true,
                    )
                    .await?
                    .matched
                    == 0
                {
                    return Err(StoreError::Invalid(format!(
                        "Offline job receipt lost its session: {step}"
                    ))
                    .into());
                }
            }
        }
        Ok(())
    }
    /// Accept a summary intent even for free users; the consumer owns AI eligibility.
    pub(crate) async fn enqueue_post_stream_summary_job<Q: JobQueue>(
        &self,
        jobs: &QueueProducer<'_, Q>,
        channel: &str,
        session: &Document,
        reason: &str,
        requested_by: &str,
    ) -> Result<(), LifecycleError> {
        let result = enqueue_stream_memory_summary_job(
            jobs,
            &StreamMemorySummaryInput {
                channel_id: channel.into(),
                session_id: Some(session_id(session)?),
                stream_id: Some(text(session, "stream_id").into()),
                reason: Some(reason.into()),
                source: Some("stream_offline".into()),
                requested_by: Some(requested_by.into()),
                not_before_unix: (self.store.clock.now_ms().div_euclid(1000) + 120) as f64,
            },
        )
        .await?;
        self.accepted(result).await
    }
    async fn enqueue_automatic_clip_recommendation_job<Q: JobQueue>(
        &self,
        jobs: &QueueProducer<'_, Q>,
        channel: &str,
        session: &Document,
        duration: f64,
    ) -> Result<(), LifecycleError> {
        let (config, user) = tokio::try_join!(
            self.store.find(
                "cliprecommendationconfigs",
                doc! {"channelID":channel},
                doc! {},
                1,
                0,
                1500
            ),
            self.store.find(
                "users",
                doc! {"accounts.id":channel,"accounts.type":"twitch"},
                doc! {},
                1,
                0,
                1500
            )
        )?;
        if !config
            .first()
            .is_some_and(|d| d.get_bool("autoAnalyzeEnabled").unwrap_or(false))
            || !user.first().is_some_and(|d| text(d, "plan_tier") == "pro")
        {
            return Ok(());
        }
        let result = enqueue_clip_recommendation_job(
            jobs,
            &ClipRecommendationInput {
                channel_id: channel.into(),
                channel: Some(text(session, "channel").into()),
                session_id: Some(session_id(session)?),
                stream_id: Some(text(session, "stream_id").into()),
                vod_url: format!("twitch-latest:{channel}"),
                source: "stream_offline".into(),
                requested_by: Some("recordStreamOfflineEvent".into()),
                vod_duration_minutes: if duration == 0.0 { 60.0 } else { duration },
                not_before_unix: (self.store.clock.now_ms().div_euclid(1000) + 300) as f64,
                ..Default::default()
            },
        )
        .await?;
        self.accepted(result).await
    }
    async fn accepted(
        &self,
        result: crate::clip_recommendations_queue::EnqueueJobResult,
    ) -> Result<(), LifecycleError> {
        if !result.enqueued && result.dedupe_key.is_empty() {
            return Err(StoreError::Invalid(result.message).into());
        }
        if result.enqueued {
            self.store.after_write().await;
        }
        Ok(())
    }
}
async fn retry<T, F, Fut>(retries: u32, mut operation: F) -> Result<T, StoreError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, StoreError>>,
{
    for attempt in 0..=retries {
        match operation().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt == retries => return Err(e),
            Err(_) => tokio::time::sleep(Duration::from_millis(100 * u64::from(attempt + 1))).await,
        }
    }
    Err(StoreError::Invalid("retry budget exhausted".into()))
}
fn concern() -> WriteConcern {
    WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build()
}
fn field(d: &Document, k: &str) -> Bson {
    d.get(k).cloned().unwrap_or(Bson::Null)
}
fn id(d: &Document) -> Bson {
    field(d, "_id")
}
fn present(d: &Document, k: &str) -> bool {
    d.get(k).is_some_and(|v| !matches!(v, Bson::Null))
}
fn session_id(d: &Document) -> Result<String, StoreError> {
    d.get_object_id("_id")
        .map(|v| v.to_hex())
        .map_err(|e| StoreError::Invalid(e.to_string()))
}
fn changed(prefix: &str, channel: &str) -> StoreError {
    StoreError::Invalid(format!("{prefix} for {channel}"))
}
fn with_key(mut update: Document, key: Option<&str>) -> Document {
    if let Some(key) = key {
        update.insert("$addToSet", doc! {"applied_domain_event_keys":key});
    }
    update
}
fn initial(channel: &str, stream: &str, start: DateTime) -> Document {
    doc! {"channelID":channel,"stream_id":stream,"started_at":start,"peak_viewers":0,"average_viewers":0,"sample_count":0,"sample_total_viewers":0,"duration_minutes":0,"follows":0,"subs":0,"bits":0,"donations":0,"messages":0,"commands":0}
}
pub(crate) fn duration_minutes(start: DateTime, end: DateTime) -> f64 {
    dima_text::parse_number(&dima_text::to_fixed(
        (end.timestamp_millis() - start.timestamp_millis()).max(0) as f64 / 60_000.0,
        1,
    ))
}

fn source(d: &Document) -> Bson {
    if text(d, "closure_source").is_empty() {
        Bson::Null
    } else {
        field(d, "closure_source")
    }
}
