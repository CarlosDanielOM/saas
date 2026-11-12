//! Follow relationships, ported from `utils/follow_ledger.ts`.
//!
//! A follow event ends every active edge then inserts a new active edge, under a transaction
//! when supported, with the reference's standalone fallback and three attempts for 11000, 112,
//! 91, 189, 251 and transaction labels. The fallback retains the reference's crash window
//! between ending and inserting; a subsequent full scan restores the active relationship.
//! Incoming and outgoing scans run concurrently, use 100-item Twitch pages and 250-write
//! batches by default. Failed paging never ends unseen rows in that direction. Completed
//! scans end missing edges and reconcile both sides' mutual flags. No index creation here.
//! Sweep reverse resets and mutual reconciliation use bounded batches instead of follower-sized
//! `$in` lists. Intermediate write boundaries differ; a completed pass has the reference state.
//! `shutdown` joins owned filesystem cleanup after active scan futures have been joined.
//!
//! All schema writes pass through `dima_model`. Each read/write has a 30-second default
//! deadline; Twitch attempts use 60 seconds and the enclosing page (including 401 refreshes)
//! has 120 seconds. Pacing is supplied by the caller, as in the reference. Cursors are streamed
//! in bounded batches; seen identities spill to disk rather than growing a follower-sized set.
//! The shared model lacks a bulk-write entry point: `bulk_update` validates with the model
//! before applying the store's recorded bulk preparation (whose upsert defaults differ).
//!
//! Caller inventory: the worker calls sync and channel discovery. The frozen tree has no
//! caller of `recordFollowLedgerStart`. Its behavior is retained for the eventual event port.
use crate::{Error, bounded, seen::Seen};
use bson::{Bson, DateTime, Document, doc};
use dima_core::Clock;
use dima_http::Path;
use dima_model::follow_relationship_ledgers::{COLLECTION, INFO};
use dima_store::mongo::{
    MongoStore, WriteContext,
    update::{BulkUpdate, UpdateOptions, prepare_bulk_update},
    write::WriteError,
};
use dima_twitch::{Auth, HelixRequest, Twitch};
use futures_util::{TryStreamExt, future::BoxFuture};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub batch_size: usize,
    pub store_deadline: Duration,
    pub page_deadline: Duration,
    /// Temporary filesystem storage for scan membership; no environment reads.
    pub spool_directory: std::path::PathBuf,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            batch_size: 250,
            store_deadline: Duration::from_secs(30),
            page_deadline: Duration::from_secs(120),
            spool_directory: std::path::PathBuf::from("/tmp"),
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FollowStart {
    pub platform: Option<String>,
    pub follower_id: String,
    pub followed_id: String,
    pub follower_login: String,
    pub follower_name: String,
    pub followed_login: String,
    pub followed_name: String,
    /// Epoch milliseconds. None is the injected current time (invalid dates at the edge too).
    pub followed_at: Option<i64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Incoming,
    Outgoing,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Follow {
    pub id: String,
    pub login: String,
    pub name: String,
    pub followed_at: String,
}
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub items: Vec<Follow>,
    pub total: u64,
    pub cursor: Option<String>,
}
/// Token preflight, directory name and pacing belong to the source. All calls are bounded.
pub trait Source: Sync {
    fn login<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<String, Error>>;
    fn page<'a>(
        &'a self,
        channel: &'a str,
        direction: Direction,
        cursor: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Page, Error>>;
}
/// Optional reference pacing callback, invoked once before each page, before any 401 retries.
pub type Pacer = Arc<dyn Fn(Direction) -> BoxFuture<'static, Result<(), Error>> + Send + Sync>;
pub struct TwitchSource {
    pub twitch: Twitch,
    pub pacer: Option<Pacer>,
}
impl Source for TwitchSource {
    fn login<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let account = self.twitch.streamer(channel).await;
            self.twitch
                .streamer_credential(channel, None)
                .await
                .map_err(|e| Error::Invalid(e.message()))?;
            Ok(account.map(|a| a.name().to_owned()).unwrap_or_default())
        })
    }
    fn page<'a>(
        &'a self,
        channel: &'a str,
        direction: Direction,
        cursor: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Page, Error>> {
        Box::pin(async move {
            if let Some(pacer) = &self.pacer {
                pacer(direction).await?;
            }
            let (path, id_field, prefix) = match direction {
                Direction::Incoming => ("/channels/followers", "broadcaster_id", "user"),
                Direction::Outgoing => ("/channels/followed", "user_id", "broadcaster"),
            };
            let mut request = HelixRequest::get(Path::fixed(path), Auth::Streamer(channel.into()))
                .query(id_field, channel)
                .query("first", "100")
                .retry_on_401()
                .timeout(Duration::from_secs(60));
            if let Some(cursor) = cursor {
                request = request.query("after", cursor);
            }
            let response = self
                .twitch
                .helix(request)
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if response.refresh_unavailable() {
                return Err(Error::Invalid(
                    "Unable to refresh Twitch streamer token".into(),
                ));
            }
            let status = response.status();
            let value: serde_json::Value = response
                .into_response()
                .json()
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if !status.is_success() || value.get("error").is_some_and(dima_text::js_truthy) {
                return Err(Error::Invalid(
                    value["message"].as_str().unwrap_or("Unknown error").into(),
                ));
            }
            let items = value["data"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| Follow {
                            id: item[format!("{prefix}_id")]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                            login: item[format!("{prefix}_login")]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                            name: item[format!("{prefix}_name")]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                            followed_at: item["followed_at"].as_str().unwrap_or_default().into(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Page {
                items,
                total: value["total"].as_u64().unwrap_or(0),
                cursor: value["pagination"]["cursor"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            })
        })
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_from_api: u64,
    pub requests: u64,
    pub pages: u64,
    pub active_upserts: u64,
    pub ended_count: u64,
}
impl Stats {
    fn merge(self, other: Self) -> Self {
        Self {
            total_from_api: self.total_from_api + other.total_from_api,
            requests: self.requests + other.requests,
            pages: self.pages + other.pages,
            active_upserts: self.active_upserts + other.active_upserts,
            ended_count: self.ended_count + other.ended_count,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub error: bool,
    pub message: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(flatten)]
    pub stats: Stats,
}
#[derive(Clone)]
pub struct Ledger {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    config: Config,
    cleanup: tokio_util::task::TaskTracker,
    #[cfg(feature = "test-util")]
    fault: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
}
impl Ledger {
    pub fn new(store: MongoStore, clock: Arc<dyn Clock>, config: Config) -> Result<Self, Error> {
        if !(1..=1000).contains(&config.batch_size) {
            return Err(Error::Invalid("write batch must be 1..=1000".into()));
        }
        Ok(Self {
            store,
            clock,
            config,
            cleanup: tokio_util::task::TaskTracker::new(),
            #[cfg(feature = "test-util")]
            fault: None,
        })
    }
    /// Test-only boundary after a confirmed write; cancellation here models process death.
    #[cfg(feature = "test-util")]
    pub fn with_fault(
        mut self,
        fault: Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.fault = Some(fault);
        self
    }
    async fn after_write(&self) {
        #[cfg(feature = "test-util")]
        if let Some(fault) = &self.fault {
            fault().await;
        }
    }
    /// The runtime owner calls this after joining active scans, before shutting down Tokio.
    pub async fn shutdown(&self) {
        self.cleanup.close();
        self.cleanup.wait().await;
    }
    fn at(&self) -> DateTime {
        DateTime::from_millis(self.clock.now_ms())
    }
    async fn update(&self, filter: Document, set: Document, many: bool) -> Result<(), Error> {
        let prepared = INFO.prepare_update(
            &filter,
            doc! { "$set": set },
            UpdateOptions::default(),
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        let mut writes = self.store.writes(COLLECTION);
        if many {
            bounded(self.config.store_deadline, writes.update_many(&prepared)).await?;
        } else {
            bounded(self.config.store_deadline, writes.update_one(&prepared)).await?;
        }
        self.after_write().await;
        Ok(())
    }
    async fn bulk_write(&self, operations: Vec<(Document, Document, bool)>) -> Result<(), Error> {
        if operations.is_empty() {
            return Ok(());
        }
        let mut statements = Vec::with_capacity(operations.len());
        for (filter, set, upsert) in operations {
            let options = if upsert {
                UpdateOptions::upsert()
            } else {
                UpdateOptions::default()
            };
            let mut ctx = WriteContext::new(self.clock.now_ms());
            let update = if upsert {
                doc! { "$set": set, "$setOnInsert": { "platform": "twitch" } }
            } else {
                doc! { "$set": set }
            };
            // Workaround: model validation before the shared store's bulk-specific preparation.
            let validated =
                INFO.prepare_update(&filter, update.clone(), options.clone(), &mut ctx)?;
            self.store
                .writes(COLLECTION)
                .check("bulkWrite", &validated.dropped_paths)?;
            let prepared = prepare_bulk_update(
                INFO.schema,
                &filter,
                update,
                BulkUpdate::UpdateOne,
                options,
                &mut ctx,
            )?;
            self.store
                .writes(COLLECTION)
                .check("bulkWrite", &prepared.dropped_paths)?;
            let update = match prepared.update {
                Some(dima_store::mongo::update::UpdateDoc::Document(d)) => d,
                _ => return Err(Error::Invalid("empty bulk update".into())),
            };
            statements
                .push(doc! { "q": prepared.filter, "u":update, "upsert":upsert, "multi":false });
        }
        // Same update command as Mongoose's unordered bulkWrite, through the store's driver.
        let result = bounded(
            self.config.store_deadline,
            self.store
                .database()
                .run_command(doc! { "update":COLLECTION, "updates":statements, "ordered":false }),
        )
        .await?;
        self.after_write().await;
        if result
            .get_array("writeErrors")
            .is_ok_and(|errors| !errors.is_empty())
            || result.contains_key("writeConcernError")
        {
            return Err(Error::Invalid("follow ledger bulk write failed".into()));
        }
        Ok(())
    }
    pub async fn record_follow_ledger_start(&self, input: &FollowStart) -> Result<(), Error> {
        if dima_text::trim(&input.follower_id).is_empty()
            || dima_text::trim(&input.followed_id).is_empty()
        {
            return Ok(());
        }
        let mut input = input.clone();
        input.followed_at = Some(input.followed_at.unwrap_or(self.clock.now_ms()));
        for attempt in 0..3 {
            let result = bounded(
                self.config.store_deadline,
                dima_store::mongo::transaction::with_transaction_or_fallback(
                    self.store.client(),
                    (self.clone(), input.clone()),
                    |session, (ledger, input)| {
                        Box::pin(async move {
                            ledger
                                .start_inner(input, session)
                                .await
                                .map_err(|error| match error {
                                    Error::Mongo(e) | Error::Write(WriteError::Driver(e)) => e,
                                    other => mongodb::error::Error::custom(other.to_string()),
                                })
                        })
                    },
                ),
            )
            .await;
            match result {
                Ok(()) => return Ok(()),
                Err(Error::Mongo(ref e))
                    if attempt < 2
                        && (matches!(
                            dima_store::mongo::error::server_code(e),
                            Some(11000 | 112 | 91 | 189 | 251)
                        ) || e.contains_label("TransientTransactionError")
                            || e.contains_label("UnknownTransactionCommitResult")) => {}
                error => return error,
            }
        }
        Ok(())
    }
    async fn start_inner(
        &self,
        input: &FollowStart,
        mut session: Option<&mut mongodb::ClientSession>,
    ) -> Result<(), Error> {
        let follower = dima_text::trim(&input.follower_id);
        let followed = dima_text::trim(&input.followed_id);
        let platform = input
            .platform
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("twitch");
        let at = DateTime::from_millis(input.followed_at.unwrap_or(self.clock.now_ms()));
        let reverse = doc! { "platform": platform, "follower_id": followed, "followed_id": follower, "status": "active" };
        let collection = self.store.documents(COLLECTION);
        let query = collection
            .find_one(reverse.clone())
            .projection(doc! { "_id": 1, "mutual": 1 });
        let reverse_active = match session.as_deref_mut() {
            Some(s) => bounded(self.config.store_deadline, query.session(s)).await?,
            None => bounded(self.config.store_deadline, query).await?,
        };
        let end = INFO.prepare_update(&doc! { "platform": platform, "follower_id": follower, "followed_id": followed, "status": "active" }, doc! { "$set": { "status": "ended", "ended_at": at, "ended_reason": "unknown", "mutual": false, "last_event_at": at } }, UpdateOptions::default(), &mut WriteContext::new(self.clock.now_ms()))?;
        let mut writes = self.store.writes(COLLECTION);
        if let Some(s) = session.as_deref_mut() {
            writes = writes.session(s);
        }
        bounded(self.config.store_deadline, writes.update_many(&end)).await?;
        self.after_write().await;
        let insert = INFO.prepare_create(&doc! {
            "platform": platform, "follower_id": follower, "followed_id": followed,
            "follower_login": dima_text::trim(&input.follower_login), "follower_name": dima_text::trim(&input.follower_name),
            "followed_login": dima_text::trim(&input.followed_login), "followed_name": dima_text::trim(&input.followed_name),
            "followed_at": at, "ended_at": Bson::Null, "ended_reason": Bson::Null,
            "mutual": reverse_active.is_some(), "status": "active", "last_event_at": at,
        }, &mut WriteContext::new(self.clock.now_ms()))?;
        let mut writes = self.store.writes(COLLECTION);
        if let Some(s) = session.as_deref_mut() {
            writes = writes.session(s);
        }
        bounded(self.config.store_deadline, writes.insert_one(&insert)).await?;
        self.after_write().await;
        if reverse_active.is_some_and(|d| !d.get_bool("mutual").unwrap_or(false)) {
            let prepared = INFO.prepare_update(
                &reverse,
                doc! { "$set": { "mutual": true, "last_event_at": at } },
                UpdateOptions::default(),
                &mut WriteContext::new(self.clock.now_ms()),
            )?;
            let mut writes = self.store.writes(COLLECTION);
            if let Some(s) = session {
                writes = writes.session(s);
            }
            bounded(self.config.store_deadline, writes.update_one(&prepared)).await?;
        }
        Ok(())
    }
    /// Reference returns all unique eligible IDs; only this returned result grows with channels.
    pub async fn get_follow_ledger_sync_channel_ids(&self) -> Result<Vec<String>, Error> {
        let mut rows = bounded(self.config.store_deadline, self.store.documents("users").find(doc! { "accounts": { "$elemMatch": { "type": "twitch", "actived": true, "has_permissions": true } } }).projection(doc! { "accounts": 1 }).batch_size(self.config.batch_size as u32)).await?;
        let mut ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        while let Some(row) = bounded(self.config.store_deadline, rows.try_next()).await? {
            for account in row
                .get_array("accounts")
                .into_iter()
                .flatten()
                .filter_map(Bson::as_document)
            {
                let id = dima_text::trim(account.get_str("id").unwrap_or_default());
                let refresh = account
                    .get_document("refresh_token")
                    .ok()
                    .and_then(|d| d.get_str("content").ok())
                    .is_some_and(|s| !s.is_empty());
                if account.get_str("type").ok() == Some("twitch")
                    && account.get_bool("actived").unwrap_or(false)
                    && account.get_bool("has_permissions").unwrap_or(false)
                    && refresh
                    && !id.is_empty()
                    && seen.insert(id.to_owned())
                {
                    ids.push(id.to_owned());
                }
            }
        }
        Ok(ids)
    }
    async fn direction<S: Source>(
        &self,
        channel: &str,
        login: &str,
        source: &S,
        direction: Direction,
    ) -> Result<(Stats, Option<Error>), Error> {
        let seen = Seen::new(&self.config.spool_directory, self.cleanup.clone()).await?;
        let mut stats = Stats::default();
        let mut cursor = None;
        let (owner, peer, reverse_owner, reason) = match direction {
            Direction::Incoming => (
                "followed_id",
                "follower_id",
                "follower_id",
                "missing_in_followers_scan",
            ),
            Direction::Outgoing => (
                "follower_id",
                "followed_id",
                "followed_id",
                "missing_in_following_scan",
            ),
        };
        loop {
            stats.requests += 1;
            let page = match bounded(
                self.config.page_deadline,
                source.page(channel, direction, cursor.as_deref()),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => return Ok((stats, Some(e))),
            };
            if page.items.len() > 100 {
                return Err(Error::Invalid("Twitch page exceeds 100 rows".into()));
            }
            stats.pages += 1;
            stats.total_from_api = stats.total_from_api.max(page.total);
            let page_ids: Vec<&str> = page
                .items
                .iter()
                .map(|i| dima_text::trim(&i.id))
                .filter(|s| !s.is_empty())
                .collect();
            let reverse_rows: Vec<Document> = bounded(self.config.store_deadline, async {
                self.store.documents(COLLECTION).find(doc! { "platform":"twitch", "status":"active", reverse_owner:channel, owner: { "$in": &page_ids } }).projection(doc! { owner:1 }).limit(100).await?.try_collect().await
            }).await?;
            let reverse_ids: std::collections::HashSet<String> = reverse_rows
                .iter()
                .filter_map(|r| r.get_str(owner).ok())
                .map(str::to_owned)
                .collect();
            for chunk in page.items.chunks(self.config.batch_size) {
                let mut operations = Vec::with_capacity(chunk.len());
                for item in chunk {
                    let id = dima_text::trim(&item.id);
                    if id.is_empty() {
                        continue;
                    }
                    seen.add(id).await?;
                    let mutual = reverse_ids.contains(id);
                    let at = DateTime::from_millis(
                        dima_text::parse_date(&item.followed_at).unwrap_or(self.clock.now_ms()),
                    );
                    let (f_login, f_name, d_login, d_name) = match direction {
                        Direction::Incoming => (
                            dima_text::trim(&item.login),
                            dima_text::trim(&item.name),
                            login,
                            login,
                        ),
                        Direction::Outgoing => (
                            login,
                            login,
                            dima_text::trim(&item.login),
                            dima_text::trim(&item.name),
                        ),
                    };
                    // Reference quirk: a re-follow between scans replaces the earlier timestamp.
                    operations.push((doc! { "platform": "twitch", "status": "active", owner: channel, peer: id }, doc! { "follower_login": f_login, "follower_name": f_name, "followed_login": d_login, "followed_name": d_name, "followed_at": at, "mutual": mutual, "ended_at": Bson::Null, "ended_reason": Bson::Null, "last_event_at": at, "status": "active" }, true));
                    stats.active_upserts += 1;
                }
                self.bulk_write(operations).await?;
            }
            if !reverse_ids.is_empty() {
                let ids: Vec<String> = reverse_ids.into_iter().collect();
                self.update(doc! { "platform":"twitch", "status":"active", reverse_owner:channel, owner: { "$in":ids } }, doc! { "mutual":true }, true).await?;
            }
            cursor = page.cursor.filter(|c| !c.is_empty());
            if cursor.is_none() {
                break;
            }
        }
        let mut rows = bounded(
            self.config.store_deadline,
            self.store
                .documents(COLLECTION)
                .find(doc! { "platform": "twitch", "status": "active", owner: channel })
                .projection(doc! { "_id": 1, peer: 1, "mutual": 1 })
                .batch_size(self.config.batch_size as u32),
        )
        .await?;
        let ended_at = self.at();
        let mut endings = Vec::with_capacity(self.config.batch_size);
        let mut resets = Vec::with_capacity(self.config.batch_size);
        while let Some(row) = bounded(self.config.store_deadline, rows.try_next()).await? {
            let id = dima_text::trim(row.get_str(peer).unwrap_or_default());
            if id.is_empty() || seen.contains(id).await? {
                continue;
            }
            endings.push((doc! { "_id":row.get("_id").cloned(), "status":"active" }, doc! { "status":"ended", "ended_at":ended_at, "ended_reason":reason, "mutual":false, "last_event_at":ended_at }, false));
            stats.ended_count += 1;
            if row.get_bool("mutual").unwrap_or(false) {
                resets.push(id.to_owned());
            }
            if endings.len() == self.config.batch_size {
                self.bulk_write(std::mem::take(&mut endings)).await?;
                if !resets.is_empty() {
                    self.update(doc! { "platform":"twitch", "status":"active", reverse_owner:channel, owner: { "$in":std::mem::take(&mut resets) }, "mutual":true }, doc! { "mutual":false }, true).await?;
                }
            }
        }
        self.bulk_write(endings).await?;
        if !resets.is_empty() {
            self.update(doc! { "platform":"twitch", "status":"active", reverse_owner:channel, owner: { "$in":resets }, "mutual":true }, doc! { "mutual":false }, true).await?;
        }
        Ok((stats, None))
    }
    async fn reconcile_batch(
        &self,
        channel: &str,
        owner: &str,
        peer: &str,
        ids: Vec<String>,
    ) -> Result<(), Error> {
        if ids.is_empty() {
            return Ok(());
        }
        let reverse: Vec<Document> = bounded(self.config.store_deadline, async {
            self.store.documents(COLLECTION).find(doc! { "platform":"twitch", "status":"active", peer:channel, owner: { "$in":&ids } }).projection(doc! { owner:1 }).limit(self.config.batch_size as i64).await?.try_collect().await
        }).await?;
        let reverse: std::collections::HashSet<&str> = reverse
            .iter()
            .filter_map(|r| r.get_str(owner).ok())
            .collect();
        for mutual in [true, false] {
            let group: Vec<&str> = ids
                .iter()
                .map(String::as_str)
                .filter(|id| reverse.contains(id) == mutual)
                .collect();
            if !group.is_empty() {
                self.update(doc! { "platform":"twitch", "status":"active", owner:channel, peer: { "$in":group } }, doc! { "mutual":mutual }, true).await?;
            }
        }
        Ok(())
    }
    async fn reconcile_mutual(&self, channel: &str) -> Result<(), Error> {
        for (owner, peer) in [
            ("follower_id", "followed_id"),
            ("followed_id", "follower_id"),
        ] {
            let mut rows = bounded(
                self.config.store_deadline,
                self.store
                    .documents(COLLECTION)
                    .find(doc! { "platform":"twitch", "status":"active", owner:channel })
                    .projection(doc! { peer:1 })
                    .batch_size(self.config.batch_size as u32),
            )
            .await?;
            let mut ids = Vec::with_capacity(self.config.batch_size);
            while let Some(row) = bounded(self.config.store_deadline, rows.try_next()).await? {
                let id = dima_text::trim(row.get_str(peer).unwrap_or_default());
                if id.is_empty() {
                    continue;
                }
                ids.push(id.to_owned());
                if ids.len() == self.config.batch_size {
                    self.reconcile_batch(channel, owner, peer, std::mem::take(&mut ids))
                        .await?;
                }
            }
            self.reconcile_batch(channel, owner, peer, ids).await?;
        }
        Ok(())
    }
    pub async fn sync_follow_ledger_for_channel<S: Source>(
        &self,
        channel: &str,
        source: &S,
    ) -> SyncResult {
        let normalized = dima_text::trim(channel);
        let mut result = SyncResult {
            error: true,
            message: "Invalid channel ID".into(),
            channel_id: channel.into(),
            stats: Stats::default(),
        };
        if normalized.is_empty() {
            return result;
        }
        result.channel_id = normalized.into();
        let run = async {
            let login = bounded(self.config.page_deadline, source.login(normalized)).await?;
            let (incoming, outgoing) = tokio::join!(
                self.direction(
                    normalized,
                    dima_text::trim(&login),
                    source,
                    Direction::Incoming
                ),
                self.direction(
                    normalized,
                    dima_text::trim(&login),
                    source,
                    Direction::Outgoing
                )
            );
            let incoming = incoming?;
            let outgoing = outgoing?;
            result.stats = incoming.0.merge(outgoing.0);
            if let Some(e) = incoming.1.or(outgoing.1) {
                return Err(e);
            }
            if let Err(error) = self.reconcile_mutual(normalized).await {
                result.stats = Stats::default();
                return Err(error);
            }
            Ok(())
        }
        .await;
        match run {
            Ok(()) => {
                result.error = false;
                result.message = "Follow ledger sync completed".into();
            }
            Err(e) => result.message = e.to_string(),
        }
        result
    }
}
