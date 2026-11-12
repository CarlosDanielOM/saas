//! Scheduled stream sampling from `utils/stream_analytics.ts`.
//!
//! The process owner loads Twitch's streamer directory, calls startup reconciliation once,
//! then calls `tick` immediately and every five minutes with the scheduled slot's stable ID.
//! The reference's setInterval starts another invocation even while its predecessor runs:
//! it can insert duplicate snapshots, lose sample increments and advance offline checks twice.
//! Rust coalesces equal IDs across processes under a bounded Redis lease. An unfinished BSON
//! plan resumes before a new slot; deterministic snapshot IDs and counter CAS make every Mongo
//! step replayable without changing the collection schemas. The bounded journal contains one
//! plan, two cursors, the last completed ID and last cleanup time; it has no expiry. A lease
//! lasts the whole-tick deadline plus two store deadlines. Use Shutdown and join cancellation;
//! an abruptly dropped process leaves its lease until expiry, then the same plan is recovered.
//!
//! Helix uses Auth::App, no 401/5xx retries (as in this reference), ordered 100-ID batches.
//! Failed HTTP/credential/body/deadline batches are unobserved, never evidence of offline.
//! Nonempty pagination cursors also leave unreturned channels unobserved; no extra requests
//! are added. The reference ignores cursors and can falsely close those channels.
//! TickOutcome::Partial reports unobserved channels. Same/older scheduled slots coalesce.
//! Transport/malformed-body errors stop later batches as in the reference; non-2xx skips only
//! that batch. This deliberately fixes the reference's false closures on failed Twitch polls.
//! Valid empty responses increment offline checks; the second closes as orphaned/snapshot and
//! requests only the existing summary producer (+120s). The EventSub offline lifecycle path
//! would write offline/eventsub and clips, so is intentionally not used for snapshot closures.
//! Board/startup openings reuse unkeyed online lifecycle; board absence never directly closes.
//! Kept reference quirk: without board recovery, a different Helix stream ID is transplanted
//! onto the existing session rather than opening a new one; its old start/counters remain.
//! Retention stays 90 days, cleanup every six hours; replay also recovers the reference's
//! snapshot-insert/counter-update and orphan-close/summary-acceptance gaps. No env or scheduler.
use crate::{
    Error, bounded,
    clip_recommendations_queue::QueueProducer,
    site_analytics::{BoardOptions, LiveChannelNormalized, SiteAnalytics},
    stream_session_lifecycle::{Online, StreamSessionLifecycle, duration_minutes},
    timeline_store::{Store, date, number, text},
};
use bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use dima_core::{Clock, Random, Shutdown};
use dima_events::jobs::JobQueue;
use dima_http::Path;
use dima_model::{stream_sessions as sessions, stream_viewer_snapshots as snapshots};
use dima_store::{
    dragonfly::{Dragonfly, Script, SetOptions, SetOutcome},
    mongo::{MongoStore, WriteContext},
};
use dima_twitch::{Auth, HelixRequest, Twitch};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
#[path = "stream_session_tick_fetch.rs"]
mod fetch;
#[path = "stream_session_tick_projection.rs"]
mod projection;
static JOURNAL: Script = Script::new(
    "stream analytics tick journal",
    include_str!("stream_session_tick_cache.lua"),
);
const INTERVAL_MS: i64 = 300_000;
const RETENTION_MS: i64 = 90 * 86_400_000;
const CLEANUP_MS: i64 = 6 * 3_600_000;
#[derive(Clone, Debug)]
pub struct Config {
    pub key_prefix: String,
    pub store_deadline: Duration,
    pub request_deadline: Duration,
    pub tick_deadline: Duration,
    pub max_channels: usize,
    /// Startup-parsed STREAM_ANALYTICS_CACHED_LIVE_BOARD_MAX_AGE_MS, minimum 30 seconds.
    pub cached_board_max_age_ms: f64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            key_prefix: String::new(),
            store_deadline: Duration::from_secs(30),
            request_deadline: Duration::from_secs(60),
            tick_deadline: Duration::from_secs(240),
            max_channels: 100_000,
            cached_board_max_age_ms: 60_000.0,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiveStream {
    #[serde(default)]
    pub id: String,
    pub user_id: String,
    pub user_login: Option<String>,
    pub user_name: Option<String>,
    pub started_at: Option<String>,
    pub title: Option<String>,
    pub game_name: Option<String>,
    pub viewer_count: Option<f64>,
}
#[derive(Clone, Debug, Default)]
pub struct LiveStreams {
    pub streams: Vec<LiveStream>,
    /// Only a valid successful response authorizes an offline check for these IDs.
    pub observed: HashSet<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickOutcome {
    Complete,
    Partial,
    AlreadyComplete,
    Busy,
    Cancelled,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reconciled {
    pub recovered: usize,
    pub board_live_count: usize,
}
#[derive(Clone, Serialize, Deserialize)]
struct BoardAction {
    channel: LiveChannelNormalized,
    previous: Option<Document>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Task {
    at: DateTime,
    session: Document,
    stream: Option<LiveStream>,
    snapshot_id: ObjectId,
}
#[derive(Clone, Serialize, Deserialize)]
struct Plan {
    id: String,
    at: DateTime,
    board: Vec<BoardAction>,
    tasks: Option<Vec<Task>>,
    #[serde(default)]
    unobserved: usize,
}
#[derive(Clone)]
pub struct StreamSessionTick {
    store: Store,
    cache: Dragonfly,
    random: Arc<dyn Random>,
    config: Config,
}
impl StreamSessionTick {
    pub fn new(
        mongo: MongoStore,
        cache: Dragonfly,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        config: Config,
    ) -> Result<Self, Error> {
        if config.store_deadline.is_zero()
            || config.request_deadline.is_zero()
            || config.tick_deadline.is_zero()
            || config.max_channels == 0
            || config.max_channels > 100_000
            || !config.cached_board_max_age_ms.is_finite()
            || config.cached_board_max_age_ms < 30_000.0
        {
            return Err(Error::Invalid("invalid stream tick bounds".into()));
        }
        let mut store = Store::new(mongo, clock);
        store.deadline = config.store_deadline;
        Ok(Self {
            store,
            cache,
            random,
            config,
        })
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook);
        self
    }
    fn key(&self, suffix: &str) -> String {
        format!("{}stream:analytics:tick:{suffix}", self.config.key_prefix)
    }
    fn lifecycle(&self) -> StreamSessionLifecycle {
        let lifecycle =
            StreamSessionLifecycle::new(self.store.mongo.clone(), self.store.clock.clone());
        #[cfg(feature = "test-util")]
        let lifecycle = if let Some(h) = &self.store.hook {
            lifecycle.with_write_hook(h.clone())
        } else {
            lifecycle
        };
        lifecycle
    }
    async fn find(&self, name: &str, filter: Document) -> Result<Vec<Document>, Error> {
        // Select only the reference's scalar sampling fields, never event-key histories.
        let rows:Vec<Document> = bounded(self.store.deadline,async{
            self.store.mongo.documents(name).find(filter).projection(doc!{"_id":1,"channelID":1,"channel":1,"stream_id":1,"started_at":1,"sample_count":1,"sample_total_viewers":1,"peak_viewers":1,"messages":1,"commands":1,"consecutive_offline_checks":1}).limit(self.config.max_channels as i64+1).max_time(self.config.store_deadline).await?.try_collect().await
        }).await?;
        if rows.len() > self.config.max_channels {
            return Err(Error::Invalid("stream tick exceeds channel bound".into()));
        }
        Ok(rows)
    }
    async fn board(&self, site: &SiteAnalytics) -> Result<Vec<LiveChannelNormalized>, Error> {
        let board = site
            .get_live_channels_board(BoardOptions {
                require_fresh: true,
                max_age_ms: Some(self.config.cached_board_max_age_ms),
            })
            .await?;
        if board.len() > self.config.max_channels {
            return Err(Error::Invalid("cached board exceeds tick bound".into()));
        }
        Ok(board)
    }
    fn online(channel: &LiveChannelNormalized) -> Online {
        Online {
            channel_id: channel.channel_id.clone(),
            channel: channel.channel.clone(),
            stream_id: Some(channel.stream_id.clone()),
            started_at: Some(channel.started_at.clone()),
            ..Default::default()
        }
    }
    async fn board_actions(
        &self,
        site: &SiteAnalytics,
    ) -> Result<(usize, Vec<BoardAction>), Error> {
        let board = self.board(site).await?;
        let count = board.len();
        if count == 0 {
            return Ok((0, Vec::new()));
        }
        let ids = board
            .iter()
            .map(|c| c.channel_id.clone())
            .collect::<Vec<_>>();
        let existing = self
            .find(
                sessions::INFO.name,
                doc! {"channelID":{"$in":ids},"status":"live","ended_at":Bson::Null},
            )
            .await?;
        let by_channel: HashMap<_, _> = existing
            .into_iter()
            .map(|d| (text(&d, "channelID").to_owned(), d))
            .collect();
        let mut actions = Vec::new();
        for channel in board {
            let previous = by_channel.get(&channel.channel_id).cloned();
            if previous
                .as_ref()
                .map(|s| text(s, "stream_id"))
                .unwrap_or_default()
                != channel.stream_id
            {
                actions.push(BoardAction { channel, previous });
            }
        }
        Ok((count, actions))
    }
    pub async fn reconcile_live_sessions_from_cached_board<Q: JobQueue>(
        &self,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<Reconciled, Error> {
        tokio::time::timeout(self.config.tick_deadline, self.reconcile_board(site, jobs))
            .await
            .map_err(|_| Error::Deadline)?
    }
    async fn reconcile_board<Q: JobQueue>(
        &self,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<Reconciled, Error> {
        let (board_live_count, actions) = self.board_actions(site).await?;
        for action in &actions {
            self.lifecycle()
                .record_stream_online_event(&Self::online(&action.channel), jobs)
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;
        }
        Ok(Reconciled {
            recovered: actions.len(),
            board_live_count,
        })
    }
    /// The process initializes Twitch's directory first; no subscription manager is ported here.
    pub async fn reconcile_live_sessions_on_startup<Q: JobQueue>(
        &self,
        id: &str,
        twitch: &Twitch,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
        shutdown: &Shutdown,
    ) -> Result<TickOutcome, Error> {
        let _ = slot(id)?;
        self.run_leased(shutdown, |owner| async move {
            self.reconcile_board(site, jobs).await?;
            let ids = twitch.streamer_ids().await;
            if ids.len() > self.config.max_channels {
                return Err(Error::Invalid(
                    "startup directory exceeds tick bound".into(),
                ));
            }
            if ids.is_empty() {
                return Ok(TickOutcome::Complete);
            }
            let streams = self.fetch_live_streams_by_channel_ids(twitch, &ids).await?;
            if streams.streams.is_empty() {
                return Ok(TickOutcome::Complete);
            }
            for stream in streams.streams {
                self.lifecycle()
                    .record_stream_online_event(
                        &Online {
                            channel_id: stream.user_id,
                            channel: stream.user_login.or(stream.user_name).unwrap_or_default(),
                            stream_id: Some(stream.id),
                            started_at: stream.started_at,
                            ..Default::default()
                        },
                        jobs,
                    )
                    .await
                    .map_err(|e| Error::Invalid(e.to_string()))?;
            }
            self.run_locked(id, &owner, twitch, site, jobs).await
        })
        .await
    }
    /// Alias of one scheduled tick; no interval is installed. ID must be stable on redelivery.
    pub async fn collect_live_viewer_snapshots<Q: JobQueue>(
        &self,
        id: &str,
        twitch: &Twitch,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
        shutdown: &Shutdown,
    ) -> Result<TickOutcome, Error> {
        self.tick(id, twitch, site, jobs, shutdown).await
    }
    pub async fn tick<Q: JobQueue>(
        &self,
        id: &str,
        twitch: &Twitch,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
        shutdown: &Shutdown,
    ) -> Result<TickOutcome, Error> {
        let _ = slot(id)?;
        self.run_leased(shutdown, |owner| async move {
            self.run_locked(id, &owner, twitch, site, jobs).await
        })
        .await
    }
    async fn run_leased<F, Fut>(
        &self,
        shutdown: &Shutdown,
        operation: F,
    ) -> Result<TickOutcome, Error>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<TickOutcome, Error>>,
    {
        let owner = self
            .random
            .uuid_v4()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let ttl = self
            .config
            .tick_deadline
            .saturating_add(self.config.store_deadline.saturating_mul(2))
            .as_secs()
            .saturating_add(1);
        if bounded(
            self.store.deadline,
            self.cache.set(
                &self.key("lock"),
                owner.as_bytes(),
                SetOptions::if_missing_ex(ttl),
            ),
        )
        .await?
            != SetOutcome::Written
        {
            return Ok(TickOutcome::Busy);
        }
        let work = async {
            self.store.after_write().await;
            operation(owner.clone()).await
        };
        let result = tokio::select! {_=shutdown.wait()=>Ok(TickOutcome::Cancelled),result=tokio::time::timeout(self.config.tick_deadline,work)=>result.map_err(|_|Error::Deadline).and_then(|r|r)};
        // Dropping the inline work stops all local work before the lease is released.
        self.journal(&owner, "release", "", &[]).await?;
        result
    }
    async fn journal(&self, owner: &str, op: &str, field: &str, value: &[u8]) -> Result<(), Error> {
        let keys = [self.key("lock"), self.key("state")];
        let args: [&[u8]; 4] = [owner.as_bytes(), op.as_bytes(), field.as_bytes(), value];
        let result: i64 = bounded(
            self.store.deadline,
            JOURNAL.run::<i64, _, _>(&self.cache, &[keys[0].as_str(), keys[1].as_str()], &args),
        )
        .await?;
        if result != 1 {
            return Err(Error::Invalid(format!(
                "stream tick lost its lease during {op}"
            )));
        }
        Ok(())
    }
    async fn put(&self, owner: &str, field: &str, value: &[u8]) -> Result<(), Error> {
        self.journal(owner, "put", field, value).await?;
        self.store.after_write().await;
        Ok(())
    }
    async fn get(&self, field: &str) -> Result<Option<Vec<u8>>, Error> {
        bounded(
            self.store.deadline,
            self.cache.hget(&self.key("state"), field),
        )
        .await
    }
    async fn plan(&self, owner: &str, plan: &Plan) -> Result<(), Error> {
        let bytes = bson::serialize_to_vec(plan).map_err(|e| Error::Invalid(e.to_string()))?;
        self.put(owner, "plan", &bytes).await
    }
    async fn cursor(&self, field: &str) -> Result<usize, Error> {
        Ok(self
            .get(field)
            .await?
            .and_then(|v| std::str::from_utf8(&v).ok().and_then(|s| s.parse().ok()))
            .unwrap_or(0))
    }
    async fn run_locked<Q: JobQueue>(
        &self,
        id: &str,
        owner: &str,
        twitch: &Twitch,
        site: &SiteAnalytics,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<TickOutcome, Error> {
        if self
            .get("done")
            .await?
            .as_deref()
            .and_then(|b| std::str::from_utf8(b).ok())
            .and_then(|s| slot(s).ok())
            .is_some_and(|done| slot(id).is_ok_and(|next| next <= done))
            && self.get("plan").await?.is_none()
        {
            return Ok(TickOutcome::AlreadyComplete);
        }
        for _ in 0..2 {
            let mut plan = if let Some(bytes) = self.get("plan").await? {
                bson::deserialize_from_slice::<Plan>(&bytes)
                    .map_err(|e| Error::Invalid(e.to_string()))?
            } else {
                let (_, actions) = self.board_actions(site).await?;
                let plan = Plan {
                    id: id.into(),
                    at: self.store.now(),
                    board: actions,
                    tasks: None,
                    unobserved: 0,
                };
                self.plan(owner, &plan).await?;
                plan
            };
            if plan.board.len() > self.config.max_channels
                || plan
                    .tasks
                    .as_ref()
                    .is_some_and(|v| v.len() > self.config.max_channels)
            {
                return Err(Error::Invalid(
                    "stored tick plan exceeds channel bound".into(),
                ));
            }
            for (index, action) in plan
                .board
                .iter()
                .enumerate()
                .skip(self.cursor("board_cursor").await?)
            {
                self.lifecycle()
                    .record_stream_online_event(&Self::online(&action.channel), jobs)
                    .await
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                // Persisted causal predecessor repairs the lifecycle's supersession enqueue gap.
                if let Some(old) = &action.previous {
                    let current=self.find(sessions::INFO.name,doc!{"_id":old.get("_id").cloned().unwrap_or(Bson::Null),"status":"orphaned","closure_source":"superseded"}).await?;
                    if let Some(old) = current.first() {
                        self.lifecycle()
                            .enqueue_post_stream_summary_job(
                                jobs,
                                &action.channel.channel_id,
                                old,
                                "superseded_live_session",
                                "recordStreamOnlineEvent",
                            )
                            .await
                            .map_err(|e| Error::Invalid(e.to_string()))?;
                    }
                }
                self.put(owner, "board_cursor", (index + 1).to_string().as_bytes())
                    .await?;
            }
            let cleanup = self
                .get("cleanup")
                .await?
                .and_then(|v| std::str::from_utf8(&v).ok()?.parse::<i64>().ok())
                .unwrap_or(0);
            if plan.at.timestamp_millis() - cleanup >= CLEANUP_MS {
                let filter = doc! {"captured_at":{"$lt":DateTime::from_millis(plan.at.timestamp_millis()-RETENTION_MS)}};
                // No checked deleteMany adapter exists; cast via the model schema first.
                let prepared = dima_store::mongo::filter::prepare_filter(
                    snapshots::INFO.schema,
                    &filter,
                    &mut WriteContext::new(self.store.clock.now_ms()),
                )?;
                bounded(
                    self.store.deadline,
                    self.store
                        .mongo
                        .documents(snapshots::INFO.name)
                        .delete_many(prepared),
                )
                .await?;
                self.store.after_write().await;
                self.put(
                    owner,
                    "cleanup",
                    plan.at.timestamp_millis().to_string().as_bytes(),
                )
                .await?;
            }
            if plan.tasks.is_none() {
                let active = self
                    .find(
                        sessions::INFO.name,
                        doc! {"status":"live","ended_at":Bson::Null},
                    )
                    .await?;
                let ids = active
                    .iter()
                    .map(|s| text(s, "channelID").to_owned())
                    .collect::<Vec<_>>();
                let fetched = self.fetch_live_streams_by_channel_ids(twitch, &ids).await?;
                plan.unobserved = active
                    .iter()
                    .filter(|s| !fetched.observed.contains(text(s, "channelID")))
                    .count();
                let mut tasks = Vec::new();
                let by_channel: HashMap<_, _> = fetched
                    .streams
                    .iter()
                    .map(|s| (s.user_id.as_str(), s))
                    .collect();
                for session in active {
                    let channel = text(&session, "channelID");
                    if !fetched.observed.contains(channel) {
                        continue;
                    }
                    let stream = by_channel.get(channel).map(|s| (*s).clone());
                    let identity = format!(
                        "{}:{}",
                        plan.id,
                        session
                            .get_object_id("_id")
                            .map_err(|e| Error::Invalid(e.to_string()))?
                            .to_hex()
                    );
                    let hash = dima_core::crypto::sha256(identity).hex();
                    let snapshot_id = ObjectId::parse_str(
                        hash.get(..24)
                            .ok_or_else(|| Error::Invalid("snapshot hash".into()))?,
                    )
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                    tasks.push(Task {
                        at: self.store.now(),
                        session,
                        stream,
                        snapshot_id,
                    });
                }
                plan.tasks = Some(tasks);
                self.plan(owner, &plan).await?;
            }
            if let Some(tasks) = &plan.tasks {
                for (index, task) in tasks.iter().enumerate().skip(self.cursor("cursor").await?) {
                    self.apply(task, task.at, jobs).await?;
                    self.put(owner, "cursor", (index + 1).to_string().as_bytes())
                        .await?;
                }
            }
            self.journal(owner, "finish", &plan.id, &[]).await?;
            self.store.after_write().await;
            if slot(id)? <= slot(&plan.id)? {
                return Ok(if plan.unobserved > 0 {
                    TickOutcome::Partial
                } else {
                    TickOutcome::Complete
                });
            }
        }
        Err(Error::Invalid("stream tick recovery exceeded bound".into()))
    }
}
/// Suggested stable ID for the process owner's scheduled five-minute slot.
pub fn scheduled_tick_id(now_ms: i64) -> String {
    format!("stream-snapshot:{}", now_ms.div_euclid(INTERVAL_MS))
}

fn slot(id: &str) -> Result<i64, Error> {
    if id.len() > 64 {
        return Err(Error::Invalid("tick slot identity is too long".into()));
    }
    id.strip_prefix("stream-snapshot:")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::Invalid("use scheduled_tick_id for a monotonic slot identity".into()))
}
