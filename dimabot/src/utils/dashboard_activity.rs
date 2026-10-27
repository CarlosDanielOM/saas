//! Native scheduled dashboard activity projection and both cached summaries.
//! Producers, API queueing and shared TypeScript helpers remain authoritative.
//! Construction never creates collections/indexes or connects to Redis/Twitch.
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
use garde::Validate;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{Error, ErrorKind, WriteFailure},
    options::{Acknowledgment, ReturnDocument, UpdateOneModel, WriteConcern},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::{sync::oneshot, task::JoinHandle};

use super::dashboard_insights::{
    JsText, bson_number, dashboard_range_start, insights_due, js_json_string,
    normalize_payload_numbers, owned, refresh_dashboard_insights_once,
};
#[path = "dashboard_emote_catalog.rs"]
pub mod emote_catalog;
use emote_catalog::{ChannelEmoteCatalog, ChannelEmoteProvider, javascript_iso, valid_emote_id};

pub type Result<T> = std::result::Result<T, &'static str>;
pub const BATCH_SIZE: usize = 500;
pub const MAX_EVENTS: usize = 502;
const STATE_ID: &str = "dashboard-daily-v1";
const LEASE_MS: i64 = 60_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickOutcome {
    pub events: usize,
    pub ready: bool,
}

pub struct DashboardActivity {
    database: Database,
    activities: Collection<Document>,
    states: Collection<Document>,
    daily: Collection<Document>,
    summaries: Collection<Document>,
    catalog: ChannelEmoteProvider,
}

#[derive(Deserialize)]
struct State {
    #[serde(default)]
    seq: f64,
    #[serde(default)]
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

#[derive(Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct Activity {
    #[serde(rename = "channelID")]
    #[garde(length(min = 1))]
    channel: String,
    #[garde(skip)]
    occurred_at: DateTime,
    #[garde(skip)]
    expires_at: DateTime,
    #[garde(skip)]
    kind: String,
    #[serde(default)]
    #[garde(skip)]
    key: Option<String>,
    #[serde(default)]
    #[garde(skip)]
    label: Option<String>,
    #[serde(default)]
    #[garde(skip)]
    emotes: Option<Vec<ActivityEmote>>,
}
#[derive(Deserialize)]
struct ActivityEmote {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    count: Option<Bson>,
}

fn numeric_emote_count(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) => Some(*value),
        _ => None,
    }
}

struct Change {
    channel: String,
    day: DateTime,
    kind: &'static str,
    key: String,
    label: String,
    count: f64,
    first_at: DateTime,
    expires_at: DateTime,
}

fn pending(now: DateTime) -> Document {
    doc! { "dashboardProcessed":Bson::Null, "kind":{"$in":["command","message"]},
    "occurredAt":{"$lte":now},"expiresAt":{"$gt":now} }
}
fn activity_due(now: DateTime) -> Document {
    doc! {"nextRefreshAt":{"$lte":now},"leaseUntil":{"$lte":now}}
}
fn lease_until() -> DateTime {
    DateTime::from_millis(DateTime::now().timestamp_millis() + LEASE_MS)
}
fn valid_sequence(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&value)
}

/// Daily identity is a SHA256 of the compact JSON array, with JS UTF16 behavior
/// before BSON replacement encoding. Hashing lossy text changes split-surrogate
/// legacy command IDs, so the key's original sliced code units are retained.
fn daily_id(channel: &str, day: DateTime, kind: &str, key: &JsText) -> Result<String> {
    let iso = javascript_iso(day).map_err(|_| "Invalid dashboard daily date")?;
    let values = [
        channel.encode_utf16().collect::<Vec<_>>(),
        iso.encode_utf16().collect(),
        kind.encode_utf16().collect(),
        key.0.clone(),
    ];
    let mut json = String::from("[");
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            json.push(',');
        }
        json.push_str(&js_json_string(value));
    }
    json.push(']');
    Ok(format!("{:x}", Sha256::digest(json.as_bytes())))
}

fn changes(rows: &[Activity]) -> Result<BTreeMap<String, Change>> {
    let mut changes: BTreeMap<String, Change> = BTreeMap::new();
    for row in rows {
        row.validate()
            .map_err(|_| "Invalid dashboard activity metadata")?;
        let day = dashboard_range_start(1, row.occurred_at);
        let mut add = |kind: &'static str, key: JsText, label: String, count: f64| -> Result<()> {
            if !count.is_finite()
                || count <= 0.0
                || count.fract() != 0.0
                || count > MAX_SAFE_INTEGER
            {
                return Ok(());
            }
            let id = daily_id(&row.channel, day, kind, &key)?;
            let change = changes.entry(id).or_insert_with(|| Change {
                channel: row.channel.clone(),
                day,
                kind,
                key: key.bson_text(),
                label,
                count: 0.0,
                first_at: row.occurred_at,
                expires_at: row.expires_at,
            });
            change.count += count;
            change.first_at = change.first_at.min(row.occurred_at);
            change.expires_at = change.expires_at.max(row.expires_at);
            Ok(())
        };
        add("coverage", JsText(Vec::new()), String::new(), 1.0)?;
        if row.kind == "command" {
            let key = row.key.as_deref().unwrap_or("");
            let label = row
                .label
                .as_deref()
                .filter(|label| !label.is_empty())
                .unwrap_or(key);
            add(
                "command",
                JsText::sliced(key, 100),
                JsText::sliced(label, 100).bson_text(),
                1.0,
            )?;
        } else {
            for emote in row.emotes.as_deref().unwrap_or(&[]) {
                let key = emote.key.as_deref().unwrap_or("");
                if key.strip_prefix("twitch:").is_some_and(valid_emote_id) {
                    add(
                        "emote",
                        JsText::sliced(key, usize::MAX),
                        JsText::sliced(emote.label.as_deref().unwrap_or(""), 64).bson_text(),
                        emote
                            .count
                            .as_ref()
                            .and_then(numeric_emote_count)
                            .unwrap_or(0.0),
                    )?;
                }
            }
        }
    }
    Ok(changes)
}

impl DashboardActivity {
    pub fn new(database: Database) -> Self {
        Self {
            activities: database.collection("stream_activities"),
            states: database.collection("stream_activity_states"),
            daily: database.collection("dashboard_activity_dailies"),
            summaries: database.collection("dashboard_activity_summaries"),
            database,
            catalog: ChannelEmoteProvider::new(),
        }
    }

    /// TS-equivalent phase order, each bounded to 500 + one + one work units.
    /// Caller applies the hard 40s OS watchdog, including readiness probes.
    pub async fn run_once(&mut self) -> Result<usize> {
        let projected = self.project_batch(BATCH_SIZE).await?;
        let activity = self.refresh_activity_once().await?;
        let insights = refresh_dashboard_insights_once(&self.database).await?;
        Ok(projected + usize::from(activity) + usize::from(insights))
    }
    pub async fn run_tick(&mut self) -> Result<TickOutcome> {
        let events = self.run_once().await?;
        // Never infer readiness from counts: an expired saved batch returns 0,
        // and either summary queue can remain ready without any projection.
        let ready = self.ready_work().await?;
        Ok(TickOutcome { events, ready })
    }
    pub async fn ready_work(&self) -> Result<bool> {
        let now = DateTime::now();
        let state = self
            .states
            .find_one(doc! {"_id":STATE_ID})
            .projection(doc! {"_id":0,"leaseUntil":1,"active.ids":1})
            .max_time(Duration::from_secs(1))
            .await
            .map_err(|_| "Dashboard ready-work checkpoint lookup failed")?;
        let projection_claimable = state.as_ref().is_none_or(|row| {
            row.get_datetime("leaseUntil")
                .is_ok_and(|&until| until <= now)
        });
        if projection_claimable {
            let active = state
                .as_ref()
                .and_then(|row| row.get_document("active").ok())
                .and_then(|active| active.get_array("ids").ok())
                .is_some_and(|ids| !ids.is_empty());
            if active {
                return Ok(true);
            }
            if self
                .activities
                .find_one(pending(now))
                .projection(doc! {"_id":1})
                .max_time(Duration::from_secs(1))
                .await
                .map_err(|_| "Dashboard ready-work event lookup failed")?
                .is_some()
            {
                return Ok(true);
            }
        }
        if self
            .summaries
            .find_one(activity_due(now))
            .projection(doc! {"_id":1})
            .max_time(Duration::from_secs(1))
            .await
            .map_err(|_| "Dashboard ready-work activity lookup failed")?
            .is_some()
        {
            return Ok(true);
        }
        Ok(self
            .database
            .collection::<Document>("dashboard_insights")
            .find_one(insights_due(now))
            .projection(doc! {"_id":1})
            .max_time(Duration::from_secs(1))
            .await
            .map_err(|_| "Dashboard ready-work insight lookup failed")?
            .is_some())
    }

    pub async fn project_batch(&self, limit: usize) -> Result<usize> {
        let now = DateTime::now();
        let owner = ObjectId::new().to_hex();
        let initialized = self
            .states
            .update_one(
                doc! {"_id":STATE_ID},
                doc! {
            "$setOnInsert":{"seq":bson_number(0.0),"leaseUntil":DateTime::from_millis(0),"active.ids":[]}
                },
            )
            .upsert(true)
            .await;
        if let Err(error) = initialized
            && !duplicate_key(&error)
        {
            return Err("Dashboard checkpoint initialization failed");
        }
        let state = self
            .states
            .clone_with_type::<State>()
            .find_one_and_update(
                doc! {
                    "_id":STATE_ID,"leaseUntil":{"$lte":now}
                },
                doc! {"$set":{"owner":&owner,"leaseUntil":lease_until()}},
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| "Dashboard projector claim failed")?;
        let Some(state) = state else { return Ok(0) };
        let heartbeat = Heartbeat::start(self.states.clone(), owner.clone());
        let result = self
            .project_owned(state, &owner, now, limit, &heartbeat.lost)
            .await;
        heartbeat.stop().await;
        let released = self
            .states
            .update_one(
                doc! {"_id":STATE_ID,"owner":&owner},
                doc! {
                    "$set":{"leaseUntil":DateTime::from_millis(0)}
                },
            )
            .await
            .map_err(|_| "Dashboard projector release failed");
        let count = result?;
        released?;
        Ok(count)
    }

    async fn assert_owner(&self, owner: &str, lost: &AtomicBool) -> Result<()> {
        if lost.load(Ordering::Acquire) {
            return Err("Dashboard projector lease lost");
        }
        let found = self
            .states
            .find_one(owned(STATE_ID, owner))
            .projection(doc! {"_id":1})
            .max_time(Duration::from_secs(1))
            .await
            .map_err(|_| "Dashboard projector ownership lookup failed")?;
        if found.is_none() || lost.load(Ordering::Acquire) {
            return Err("Dashboard projector lease lost");
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
                if !valid_sequence(state.seq) || state.seq >= MAX_SAFE_INTEGER {
                    return Err("Invalid dashboard checkpoint sequence");
                }
                let pending: Vec<Id> = self
                    .activities
                    .clone_with_type::<Id>()
                    .find(pending(now))
                    .sort(doc! {"occurredAt":1,"_id":1})
                    .projection(doc! {"_id":1})
                    .limit(limit.clamp(1, BATCH_SIZE) as i64)
                    .max_time(Duration::from_secs(2))
                    .await
                    .map_err(|_| "Dashboard pending event lookup failed")?
                    .try_collect()
                    .await
                    .map_err(|_| "Invalid dashboard event identity")?;
                if pending.is_empty() {
                    return Ok(0);
                }
                let active = Active {
                    seq: state.seq + 1.0,
                    ids: pending.into_iter().map(|row| row.id).collect(),
                };
                let saved=self.states.update_one(owned(STATE_ID,owner),doc! {
                    "$set":{"seq":bson_number(active.seq),"active":{"seq":bson_number(active.seq),"ids":&active.ids}}
                }).await.map_err(|_|"Dashboard checkpoint save failed")?;
                if saved.matched_count == 0 {
                    return Err("Dashboard projector lease lost");
                }
                active
            }
        };
        if active.ids.len() > BATCH_SIZE || !valid_sequence(active.seq) || active.seq <= 0.0 {
            return Err("Invalid dashboard active checkpoint");
        }
        // Saved membership is authoritative on replay, even if a member's kind,
        // processed marker or occurredAt no longer matches the initial query.
        // Only expiry is rechecked, exactly as in the TypeScript projector.
        let rows: Vec<Activity> = self
            .activities
            .clone_with_type::<Activity>()
            .find(doc! {
                "_id":{"$in":&active.ids},"expiresAt":{"$gt":now}
            })
            .projection(doc! {"_id":0,"channelID":1,"occurredAt":1,"expiresAt":1,
            "kind":1,"key":1,"label":1,"emotes.key":1,"emotes.label":1,"emotes.count":1})
            .max_time(Duration::from_secs(2))
            .await
            .map_err(|_| "Dashboard retained event lookup failed")?
            .try_collect()
            .await
            .map_err(|_| "Invalid dashboard retained metadata")?;
        let changes = changes(&rows)?;
        self.assert_owner(owner, lost).await?;
        let operations:Vec<_>=changes.into_iter().map(|(id,row)|UpdateOneModel::builder()
            .namespace(self.daily.namespace()).filter(doc! {"_id":id,"$or":[
                {"lastSeq":{"$lt":active.seq}},{"lastSeq":{"$exists":false}}
            ]}).update(doc! {
                "$setOnInsert":{"channelID":row.channel,"day":row.day,"kind":row.kind,"key":row.key,"label":row.label},
                "$inc":{"count":bson_number(row.count)},"$set":{"lastSeq":bson_number(active.seq)},
                "$min":{"firstAt":row.first_at},"$max":{"expiresAt":row.expires_at}
            }).upsert(true).build()).collect();
        if !operations.is_empty()
            && let Err(error) = self
                .database
                .client()
                .bulk_write(operations)
                .ordered(false)
                .write_concern(
                    WriteConcern::builder()
                        .w(Acknowledgment::Nodes(1))
                        .journal(true)
                        .build(),
                )
                .await
            && !only_fence_duplicates(&error)
        {
            return Err("Dashboard daily projection write failed");
        }
        self.assert_owner(owner, lost).await?;
        let mut channels = Vec::new();
        for row in &rows {
            if !channels.contains(&row.channel) {
                channels.push(row.channel.clone());
            }
        }
        for channel in channels {
            self.queue_activity(&channel).await?;
        }
        self.assert_owner(owner, lost).await?;
        self.activities
            .update_many(
                doc! {"_id":{"$in":&active.ids}},
                doc! {"$set":{"dashboardProcessed":true}},
            )
            .await
            .map_err(|_| "Dashboard event acknowledgement failed")?;
        let completed = self
            .states
            .update_one(
                owned(STATE_ID, owner),
                doc! {
                    "$unset":{"active":""},"$set":{"updatedAt":DateTime::now()}
                },
            )
            .await
            .map_err(|_| "Dashboard checkpoint completion failed")?;
        if completed.matched_count == 0 {
            return Err("Dashboard projector lease lost");
        }
        Ok(rows.len())
    }

    async fn queue_activity(&self, channel: &str) -> Result<()> {
        let now = DateTime::now();
        let update = doc! {"$set":{"dirtyAt":now,"nextRefreshAt":now},
        "$setOnInsert":{"leaseUntil":DateTime::from_millis(0),"error":false}};
        if let Err(error) = self
            .summaries
            .update_one(doc! {"_id":channel}, update.clone())
            .upsert(true)
            .await
        {
            if !duplicate_key(&error) {
                return Err("Dashboard activity queue update failed");
            }
            // Concurrent insert is the sole tolerated race; retry without upsert.
            self.summaries
                .update_one(doc! {"_id":channel}, update)
                .await
                .map_err(|_| "Dashboard activity queue retry failed")?;
        }
        Ok(())
    }

    pub async fn refresh_activity_once(&self) -> Result<bool> {
        let now = DateTime::now();
        let owner = ObjectId::new().to_hex();
        let state = self
            .summaries
            .find_one_and_update(
                activity_due(now),
                doc! {
                    "$set":{"owner":&owner,"leaseUntil":lease_until()}
                },
            )
            .return_document(ReturnDocument::After)
            .sort(doc! {"nextRefreshAt":1})
            .await
            .map_err(|_| "Dashboard activity summary claim failed")?;
        let Some(state) = state else { return Ok(false) };
        let channel = state
            .get_str("_id")
            .map_err(|_| "Invalid dashboard activity channel")?;
        let result = async {
            let catalog = self.catalog.get(channel).await;
            let mut payload = doc! {
                "7":self.build_period(channel,7,now,&catalog).await?,
                "30":self.build_period(channel,30,now,&catalog).await?
            };
            normalize_payload_numbers(&mut payload);
            let published = self
                .summaries
                .update_one(
                    owned(channel, &owner),
                    doc! {
                        "$set":{"payload":payload,"updatedAt":now,"error":false}
                    },
                )
                .await
                .map_err(|_| "Dashboard activity summary publish failed")?;
            if published.matched_count == 0 {
                return Err("Dashboard activity summary lease lost");
            }
            let mut filter = owned(channel, &owner);
            filter.insert("dirtyAt", doc! {"$lte":now});
            // A concurrent queue call leaves nextRefreshAt due. Never move a
            // dirtyAt newer than the aggregation snapshot into the future.
            self.summaries
                .update_one(
                    filter,
                    doc! {"$set":{
                        "nextRefreshAt":DateTime::from_millis(now.timestamp_millis()+60_000)
                    }},
                )
                .await
                .map_err(|_| "Dashboard activity summary schedule failed")?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _=self.summaries.update_one(owned(channel,&owner),doc! {"$set":{
                "error":true,"nextRefreshAt":DateTime::from_millis(DateTime::now().timestamp_millis()+30_000)
            }}).await;
        }
        let released = self
            .summaries
            .update_one(
                doc! {"_id":channel,"owner":&owner},
                doc! {
                    "$set":{"leaseUntil":DateTime::from_millis(0)}
                },
            )
            .await
            .map_err(|_| "Dashboard activity summary release failed");
        result?;
        released?;
        Ok(true)
    }

    async fn build_period(
        &self,
        channel: &str,
        days: u32,
        now: DateTime,
        catalog: &ChannelEmoteCatalog,
    ) -> Result<Document> {
        let from = dashboard_range_start(days, now);
        let catalog_keys: Vec<_> = catalog
            .emotes
            .iter()
            .map(|emote| format!("twitch:{}", emote.id))
            .collect();
        let aggregation = async {
            let mut cursor=self.daily.aggregate(vec![
                doc! {"$match":{"channelID":channel,"day":{"$gte":from,"$lte":now},"expiresAt":{"$gt":now}}},
                doc! {"$group":{"_id":{"kind":"$kind","key":"$key"},"label":{"$first":"$label"},
                    "count":{"$sum":"$count"},"firstAt":{"$min":"$firstAt"}}},
                doc! {"$sort":{"count":-1,"_id.key":1}},
                doc! {"$facet":{
                    "commands":[{"$match":{"_id.kind":"command"}},{"$limit":5}],
                    "emotes":[{"$match":{"_id.kind":"emote"}},{"$limit":5}],
                    "streamerEmotes":[{"$match":{"_id.kind":"emote","_id.key":{"$in":&catalog_keys}}},{"$limit":5}],
                    "streamerTotal":[{"$match":{"_id.kind":"emote","_id.key":{"$in":&catalog_keys}}},
                        {"$group":{"_id":Bson::Null,"count":{"$sum":"$count"}}}],
                    "totals":[{"$group":{"_id":"$_id.kind","count":{"$sum":"$count"},"distinct":{"$sum":1},"firstAt":{"$min":"$firstAt"}}}]
                }}
            ]).max_time(Duration::from_secs(3)).await.map_err(|_|"Dashboard activity aggregation failed")?;
            cursor
                .try_next()
                .await
                .map_err(|_| "Dashboard activity aggregation read failed")?
                .ok_or("Invalid dashboard activity aggregation")
        };
        let remaining = async {
            Ok::<_,&'static str>(self.activities.find_one(doc! {
                "channelID":channel,"dashboardProcessed":Bson::Null,"kind":{"$in":["command","message"]},
                "occurredAt":{"$gte":from,"$lte":now},"expiresAt":{"$gt":now}
            }).projection(doc! {"_id":1}).max_time(Duration::from_millis(1500))
                .await.map_err(|_|"Dashboard activity pending lookup failed")?.is_some())
        };
        let (data, pending) = tokio::try_join!(aggregation, remaining)?;
        let items = |name: &str| -> Result<Vec<Bson>> {
            array_documents(&data,name)?.into_iter().map(|row| {
                let id=row.get_document("_id").map_err(|_|"Invalid dashboard activity rank identity")?;
                Ok(Bson::Document(doc! {"key":id.get("key").cloned().unwrap_or(Bson::Null),
                    "label":row.get("label").cloned().unwrap_or(Bson::Null),"count":row.get("count").cloned().unwrap_or(Bson::Int32(0))}))
            }).collect()
        };
        let totals = array_documents(&data, "totals")?;
        let count = |kind: &str| {
            totals
                .iter()
                .find(|row| row.get_str("_id").ok() == Some(kind))
                .and_then(|row| row.get("count"))
                .cloned()
                .unwrap_or(Bson::Int32(0))
        };
        let coverage = totals
            .iter()
            .find(|row| row.get_str("_id").ok() == Some("coverage"))
            .and_then(|row| row.get("firstAt"))
            .cloned()
            .unwrap_or(Bson::Null);
        let streamer_total = array_documents(&data, "streamerTotal")?
            .first()
            .and_then(|row| row.get("count"))
            .cloned()
            .unwrap_or(Bson::Int32(0));
        Ok(doc! {"days":days as i32,"from":from,"to":now,
        "streamerEmotes":if catalog.status=="unavailable" {Bson::Null} else {Bson::Array(items("streamerEmotes")?)},
        "streamerEmoteUses":if catalog.status=="unavailable" {Bson::Null} else {streamer_total},
        "emoteCatalog":{"status":catalog.status,"checkedAt":catalog.checked_at.clone()},
        "commands":items("commands")?,"emotes":items("emotes")?,"pending":pending,
        "commandRuns":count("command"),"emoteUses":count("emote"),"coverageStartedAt":coverage})
    }
}

fn array_documents<'a>(data: &'a Document, key: &str) -> Result<Vec<&'a Document>> {
    data.get_array(key)
        .map_err(|_| "Invalid dashboard activity aggregate shape")?
        .iter()
        .map(|row| {
            row.as_document()
                .ok_or("Invalid dashboard activity aggregate row")
        })
        .collect()
}
fn duplicate_key(error: &Error) -> bool {
    error.source().is_none()
        && matches!(error.kind.as_ref(),
        ErrorKind::Write(WriteFailure::WriteError(error)) if error.code==11000)
}
fn only_fence_duplicates(error: &Error) -> bool {
    if error.source().is_some() {
        return false;
    }
    match error.kind.as_ref() {
        ErrorKind::BulkWrite(error) => {
            !error.write_errors.is_empty()
                && error.write_concern_errors.is_empty()
                && error.write_errors.values().all(|error| error.code == 11000)
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
                tokio::select! {_=&mut stopped=>break,_=tokio::time::sleep(Duration::from_secs(10))=>{}}
                let result = states
                    .update_one(
                        owned(STATE_ID, &owner),
                        doc! {"$set":{"leaseUntil":lease_until()}},
                    )
                    .await;
                if !matches!(result,Ok(result) if result.matched_count>0) {
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
    fn raw_bson_emote_count_types_skip_invalid_values_without_losing_the_batch() {
        let counts = [
            Bson::Int32(2),
            Bson::Int64(3),
            Bson::Double(4.0),
            Bson::String("4".into()),
            Bson::Boolean(true),
            Bson::Null,
            Bson::Array(vec![Bson::Int32(4)]),
            Bson::Document(doc! {"value":4}),
            Bson::Double(0.5),
            Bson::Double(f64::NAN),
            Bson::Double(f64::INFINITY),
            Bson::Int64(9_007_199_254_740_992),
        ];
        let emotes: Vec<_> = counts
            .into_iter()
            .map(|count| Bson::Document(doc! {"key":"twitch:valid","label":"Valid","count":count}))
            .collect();
        let raw = doc! {
            "channelID":"1","occurredAt":DateTime::from_millis(1),
            "expiresAt":DateTime::from_millis(99),"kind":"message","emotes":emotes
        };
        let bytes = mongodb::bson::serialize_to_vec(&raw).unwrap();
        let row: Activity = mongodb::bson::deserialize_from_slice(&bytes).unwrap();
        let values = changes(&[row]).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(
            values
                .values()
                .find(|row| row.kind == "coverage")
                .unwrap()
                .count,
            1.0
        );
        assert_eq!(
            values
                .values()
                .find(|row| row.kind == "emote")
                .unwrap()
                .count,
            9.0
        );
    }
    #[test]
    fn json_identity_preserves_lone_surrogates_and_js_escape_spellings() {
        let key = JsText::sliced(&format!("{}😀", "x".repeat(99)), 100);
        assert!(js_json_string(&key.0).ends_with("\\ud83d\""));
        assert!(key.bson_text().ends_with('\u{fffd}'));
        assert_eq!(
            js_json_string(
                &"\"\\\n\t\u{0001}/é😀\u{2028}"
                    .encode_utf16()
                    .collect::<Vec<_>>()
            ),
            "\"\\\"\\\\\\n\\t\\u0001/é😀\u{2028}\""
        );
        assert_ne!(
            daily_id("1", DateTime::from_millis(0), "command", &key).unwrap(),
            daily_id(
                "1",
                DateTime::from_millis(0),
                "command",
                &JsText::sliced(&key.bson_text(), 100)
            )
            .unwrap()
        );
    }
    #[test]
    fn safe_emote_counts_and_retained_membership_rules() {
        let row = Activity {
            channel: "1".into(),
            occurred_at: DateTime::from_millis(1),
            expires_at: DateTime::from_millis(99),
            kind: "follow".into(),
            key: None,
            label: None,
            emotes: Some(vec![
                ActivityEmote {
                    key: Some("twitch:Case_A-1".into()),
                    label: Some("E".into()),
                    count: Some(Bson::Double(2.0)),
                },
                ActivityEmote {
                    key: Some("twitch:Case_A-1".into()),
                    label: Some("later".into()),
                    count: Some(Bson::Double(3.0)),
                },
                ActivityEmote {
                    key: Some("twitch:invalid".into()),
                    label: None,
                    count: Some(Bson::Double(0.5)),
                },
            ]),
        };
        let values = changes(&[row]).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(
            values
                .values()
                .find(|row| row.kind == "emote")
                .unwrap()
                .count,
            5.0
        );
        // A saved non-message membership still supplies coverage + emotes, like
        // the source's replay query. Only new membership filters by kind.
        assert_eq!(
            values
                .values()
                .find(|row| row.kind == "coverage")
                .unwrap()
                .count,
            1.0
        );
    }
}
