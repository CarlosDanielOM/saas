//! Native stream-timeline data service. No constructor creates indexes or connects.
use crate::workers::stream_activity::{capture::{ActivityKind, CaptureInput, CaptureSession, StreamActivityCapture, StreamActivityError, bounded, construct_upsert, is_duplicate, session_filter}, read::StreamActivityReader};
use futures_util::TryStreamExt;
use mongodb::{bson::{doc, Bson, DateTime, Document, oid::ObjectId}, Database};
use std::{collections::BTreeMap, time::Duration};

pub const TIMELINE_RETENTION_MS: i64 = 90 * 86_400_000;
pub const TIMELINE_BUCKET_MS: i64 = 5 * 60_000;
pub const MAX_ROWS: usize = 2000;
pub const BOT_ACCOUNT_ID: &str = "698614112";
pub fn timeline_bucket(at_ms: i64, started_ms: i64) -> i64 {
    let bucket = (i128::from(at_ms) - i128::from(started_ms)).div_euclid(i128::from(TIMELINE_BUCKET_MS));
    bucket.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}
pub fn timeline_offset(at_ms: i64, started_ms: i64) -> f64 { ((at_ms as f64 - started_ms as f64) / 1000.0).max(0.0) }
/// Mongoose timestamps apply to the session coverage update, independently of the receipt time.
/// `updateOne` also receives the `$setOnInsert` created timestamp the timestamps
/// pre-hook appends; it is inert without an upsert, but keeping it makes the
/// document match the source exactly.
pub fn participant_coverage_update(at: DateTime, updated_at: DateTime) -> Document {
    doc! {"$min": {"chat_tracking_started_at": at}, "$set": {"updated_at": updated_at}, "$setOnInsert": {"created_at": updated_at}}
}
/// Query documents for one `getStreamTimeline` read. Exposed for the recorded
/// source comparison in `tests/stream_timeline_data.rs`; the service uses it.
#[derive(Clone, Debug)]
pub struct TimelineFilters { pub snapshots: Document, pub raids: Document, pub markers: Document, pub participants: Document }
pub fn timeline_filters(channel_id: &str, session_id: ObjectId, started: DateTime, end: DateTime, now: DateTime) -> TimelineFilters {
    let interval = doc! {"$gte": started, "$lte": end};
    TimelineFilters {
        snapshots: doc! {"channelID": channel_id, "session_id": session_id, "captured_at": interval.clone()},
        raids: doc! {"channelID": channel_id, "source": "twitch-eventsub", "type": "channel.raid.received", "occurredAt": interval, "expiresAt": {"$gt": now}},
        markers: doc! {"channelID": channel_id, "session_id": session_id, "expiresAt": {"$gt": now}},
        participants: doc! {"channelID": channel_id, "session_id": session_id, "expiresAt": {"$gt": now}},
    }
}
/// Retention query for `listTimelineStreams`.
pub fn streams_page_filter(channel_id: &str, cutoff: DateTime) -> Document {
    doc! {"channelID": channel_id, "started_at": {"$gte": cutoff}}
}
/// Retention query for `getTimelineSession`.
pub fn session_row_filter(channel_id: &str, session_id: ObjectId, cutoff: DateTime) -> Document {
    doc! {"_id": session_id, "channelID": channel_id, "started_at": {"$gte": cutoff}}
}
fn datetime(row: &Document, key: &str) -> Result<DateTime, StreamActivityError> { row.get_datetime(key).copied().map_err(|_| StreamActivityError::Runtime) }
fn id(row: &Document) -> Result<ObjectId, StreamActivityError> { row.get_object_id("_id").map_err(|_| StreamActivityError::Runtime) }
fn text<'a>(row: &'a Document, key: &str) -> &'a str { row.get_str(key).unwrap_or("") }
fn number(row: &Document, key: &str) -> f64 { match row.get(key) { Some(Bson::Int32(v)) => f64::from(*v), Some(Bson::Int64(v)) => *v as f64, Some(Bson::Double(v)) => *v, _ => 0.0 } }
fn optional(row: &Document, key: &str) -> Bson { row.get(key).cloned().unwrap_or(Bson::Null) }
fn expire(at: DateTime) -> Result<DateTime, StreamActivityError> { at.timestamp_millis().checked_add(TIMELINE_RETENTION_MS).map(DateTime::from_millis).ok_or(StreamActivityError::Validation) }

#[derive(Clone, Debug)]
pub struct TimelineReward { pub id: String, pub title: String, pub cost: f64 }
#[derive(Clone, Debug)]
pub struct TimelineRedemption { pub id: String, pub broadcaster_user_id: String, pub redeemed_at: String, pub reward: TimelineReward, pub status: String }
#[derive(Clone, Debug)]
pub struct TimelineMoment { pub channel_id: String, pub event_id: String, pub kind: ActivityKind, pub at: DateTime, pub label: String, pub value: Option<f64> }
/// Construct and split a participant equality filter and its insert defaults.
pub fn participant_upsert(channel_id: &str, session_id: ObjectId, bucket: i64, user_id: &str, at: DateTime) -> Result<(Document, Document), StreamActivityError> {
    let filter = doc! {"channelID": channel_id, "session_id": session_id, "bucket": bucket, "user_id": user_id};
    let insert = doc! {"expiresAt": expire(at)?};
    construct_upsert(crate::schemas::stream_timeline::participant_schema(), filter, insert, at)
}

/// Apply the marker schema to a merged filter and insert, then split them.
pub fn marker_upsert(filter: Document, insert: Document, now: DateTime) -> Result<(Document, Document), StreamActivityError> {
    construct_upsert(crate::schemas::stream_timeline::marker_schema(), filter, insert, now)
}

/// Redemption marker filter and insert, matching `recordTimelineRedemption`.
pub fn redemption_marker_upsert(event: &TimelineRedemption, session_id: ObjectId, at: DateTime) -> Result<(Document, Document), StreamActivityError> {
    marker_upsert(
        doc! {"channelID": &event.broadcaster_user_id, "session_id": session_id, "key": format!("redemption:{}", event.id)},
        doc! {"kind": "redemption", "label": bounded(Some(&event.reward.title), 120), "occurredAt": at, "rewardID": &event.reward.id,
            "cost": event.reward.cost, "status": &event.status, "expiresAt": expire(at)?},
        at,
    )
}

/// Omit absent `value`, as Mongoose removes undefined update paths.
pub fn moment_marker_upsert(input: &TimelineMoment, session_id: ObjectId) -> Result<(Document, Document), StreamActivityError> {
    let label = bounded(Some(&input.label), 120);
    let label = if label.is_empty() { input.kind.as_str().to_owned() } else { label };
    let mut insert = doc! {"kind": input.kind.as_str(), "label": label};
    if let Some(value) = input.value { insert.insert("value", value); }
    insert.insert("occurredAt", input.at);
    insert.insert("expiresAt", expire(input.at)?);
    marker_upsert(doc! {"channelID": &input.channel_id, "session_id": session_id, "key": format!("event:{}", input.event_id)}, insert, input.at)
}

#[derive(Clone)]
pub struct StreamTimelineService { database: Database, capture: StreamActivityCapture, reader: StreamActivityReader, deadline: Duration }
impl StreamTimelineService {
    pub fn new(database: Database) -> Self { Self { capture: StreamActivityCapture::new(database.clone()), reader: StreamActivityReader::new(database.clone()), database, deadline: Duration::from_secs(12) } }
    pub async fn from_runtime(name: &str) -> Result<Self, StreamActivityError> {
        if name.trim().is_empty() { return Err(StreamActivityError::Configuration); }
        let client = tokio::time::timeout(Duration::from_secs(12), crate::utils::mongo::get_mongo_client()).await
            .map_err(|_| StreamActivityError::Timeout)?.map_err(|_| StreamActivityError::Runtime)?;
        Ok(Self::new(client.database(name)))
    }
    pub async fn record_timeline_participant(&self, channel_id: &str, session_id: ObjectId, started_at: DateTime, user_id: &str, at: DateTime) -> Result<(), StreamActivityError> {
        if user_id.is_empty() || user_id == BOT_ACCOUNT_ID || at.timestamp_millis() < started_at.timestamp_millis() { return Ok(()); }
        let operation = async {
            let participant = crate::schemas::stream_timeline::participant_schema().native_collection(&self.database);
            let (filter, update) = participant_upsert(channel_id, session_id, timeline_bucket(at.timestamp_millis(), started_at.timestamp_millis()), user_id, at)?;
            let result = participant.update_one(filter, update).upsert(true).await;
            if let Err(error) = result { if !is_duplicate(&error) { return Err(StreamActivityError::Runtime); } }
            crate::schemas::stream_session::schema().native_collection(&self.database).update_one(doc! {"_id": session_id, "channelID": channel_id}, participant_coverage_update(at, DateTime::now())).await.map_err(|_| StreamActivityError::Runtime)?;
            Ok(())
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
    pub async fn record_timeline_redemption(&self, event: &TimelineRedemption) -> Result<(), StreamActivityError> {
        let Some(at) = crate::utils::js_date::parse_date(&event.redeemed_at).map(DateTime::from_millis) else { return Ok(()); };
        if event.id.is_empty() { return Ok(()); }
        let operation = async {
            let sessions = crate::schemas::stream_session::schema().native_collection(&self.database);
            let Some(session) = sessions.find_one(session_filter(&event.broadcaster_user_id, at)).projection(doc! {"_id": 1}).await.map_err(|_| StreamActivityError::Runtime)? else { return Ok(()); };
            let session_id = id(&session)?;
            let markers = crate::schemas::stream_timeline::marker_schema().native_collection(&self.database);
            let (filter, update) = redemption_marker_upsert(event, session_id, at)?;
            let result = markers.update_one(filter, update).upsert(true).await;
            if let Err(error) = result { if !is_duplicate(&error) { return Err(StreamActivityError::Runtime); } }
            let input = CaptureInput { channel_id: event.broadcaster_user_id.clone(), event_id: event.id.clone(), kind: ActivityKind::Redemption,
                occurred_at: Some(at), session: None, actor: None, actor_label: None, key: Some(event.reward.id.clone()), label: Some(event.reward.title.clone()), value: None, outcome: None, emotes: vec![] };
            self.capture.capture_stream_activity(&input).await
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
    pub async fn record_timeline_moment(&self, input: &TimelineMoment) -> Result<(), StreamActivityError> {
        let operation = async {
            let sessions = crate::schemas::stream_session::schema().native_collection(&self.database);
            let Some(session) = sessions.find_one(session_filter(&input.channel_id, input.at)).sort(doc! {"started_at": -1}).projection(doc! {"_id": 1, "started_at": 1}).await.map_err(|_| StreamActivityError::Runtime)? else { return Ok(()); };
            let session = CaptureSession { id: id(&session)?, started_at: datetime(&session, "started_at")? };
            let (filter, update) = moment_marker_upsert(input, session.id)?;
            let markers = crate::schemas::stream_timeline::marker_schema().native_collection(&self.database);
            let result = markers.update_one(filter, update).upsert(true).await;
            if let Err(error) = result { if !is_duplicate(&error) { return Err(StreamActivityError::Runtime); } }
            self.capture.capture_stream_activity(&CaptureInput { channel_id: input.channel_id.clone(), event_id: input.event_id.clone(), kind: input.kind,
                occurred_at: Some(input.at), session: Some(session), actor: None, actor_label: None, key: None, label: Some(input.label.clone()), value: input.value, outcome: None, emotes: vec![] }).await
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
    pub async fn list_timeline_streams(&self, channel_id: &str, page: u64) -> Result<Document, StreamActivityError> {
        let skip = page.checked_sub(1).and_then(|n| n.checked_mul(20)).ok_or(StreamActivityError::Validation)?;
        let cutoff = DateTime::from_millis(DateTime::now().timestamp_millis() - TIMELINE_RETENTION_MS);
        let filter = streams_page_filter(channel_id, cutoff);
        let operation = async {
            let collection = crate::schemas::stream_session::schema().native_collection(&self.database);
            let rows: Vec<Document> = collection.find(filter).sort(doc! {"started_at": -1}).skip(skip).limit(21)
                .projection(doc! {"_id": 1, "started_at": 1, "ended_at": 1, "status": 1, "peak_viewers": 1, "messages": 1})
                .max_time(Duration::from_millis(3000)).await.map_err(|_| StreamActivityError::Runtime)?.try_collect().await.map_err(|_| StreamActivityError::Runtime)?;
            let mut streams = Vec::new();
            for row in rows.iter().take(20) { streams.push(doc! {"id": id(row)?.to_hex(), "startedAt": optional(row, "started_at"), "endedAt": optional(row, "ended_at"), "status": optional(row, "status")}); }
            Ok(doc! {"streams": streams, "page": page as i64, "hasMore": rows.len() > 20})
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
    pub async fn get_timeline_session(&self, channel_id: &str, session_id: &str) -> Result<Option<Document>, StreamActivityError> {
        let id = ObjectId::parse_str(session_id).map_err(|_| StreamActivityError::Validation)?;
        let cutoff = DateTime::from_millis(DateTime::now().timestamp_millis() - TIMELINE_RETENTION_MS);
        let collection = crate::schemas::stream_session::schema().native_collection(&self.database);
        let filter = session_row_filter(channel_id, id, cutoff);
        tokio::time::timeout(self.deadline, async { collection.find_one(filter).max_time(Duration::from_millis(1500)).await.map_err(|_| StreamActivityError::Runtime) }).await.map_err(|_| StreamActivityError::Timeout)?
    }
    pub async fn get_stream_timeline(&self, channel_id: &str, session_id: &str, tier: Option<&str>) -> Result<Option<Document>, StreamActivityError> {
        let tier = tier.unwrap_or("free");
        let Some(session) = self.get_timeline_session(channel_id, session_id).await? else { return Ok(None); };
        let session_object_id = id(&session)?;
        let started = datetime(&session, "started_at")?;
        let now = DateTime::now();
        let end = session.get_datetime("ended_at").copied().unwrap_or(now);
        let activity = self.reader.get_stream_activity(channel_id, session_object_id, Some(tier)).await?;
        let TimelineFilters { snapshots: snapshots_query, raids: raids_query, markers: markers_query, participants: participants_query } =
            timeline_filters(channel_id, session_object_id, started, end, now);
        let operation = async {
            let snapshots_collection = crate::schemas::stream_viewer_snapshot::schema().native_collection(&self.database);
            let events_collection = crate::schemas::domain_event::schema().native_collection(&self.database);
            let markers_collection = crate::schemas::stream_timeline::marker_schema().native_collection(&self.database);
            let participants_collection = crate::schemas::stream_timeline::participant_schema().native_collection(&self.database);
            let snapshots = async { snapshots_collection.find(snapshots_query)
                .sort(doc! {"captured_at": 1}).limit((MAX_ROWS + 1) as i64).max_time(Duration::from_millis(3000)).await?.try_collect::<Vec<Document>>().await };
            let raids = async { events_collection.find(raids_query)
                .sort(doc! {"occurredAt": 1}).limit(101).projection(doc! {"occurredAt": 1, "payload": 1, "eventKey": 1}).max_time(Duration::from_millis(1500)).await?.try_collect::<Vec<Document>>().await };
            let markers = async { markers_collection.find(markers_query)
                .sort(doc! {"occurredAt": 1, "_id": 1}).limit(101).max_time(Duration::from_millis(1500)).await?.try_collect::<Vec<Document>>().await };
            let participants = async {
                if matches!(activity.get("chatterStartedAt"), Some(Bson::DateTime(_))) { return Ok(Vec::<Document>::new()); }
                participants_collection.find(participants_query)
                    .projection(doc! {"bucket": 1}).limit(10_001).max_time(Duration::from_millis(1500)).await?.try_collect::<Vec<Document>>().await
            };
            let (snapshots, raids, markers, participants) = tokio::try_join!(snapshots, raids, markers, participants).map_err(|_| StreamActivityError::Runtime)?;
            build_timeline(session_id, &session, started, end, now, activity, &snapshots, &raids, &markers, &participants, tier)
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?.map(Some)
    }
}

/// Build the `getStreamTimeline` response from stored documents.
///
/// Public so the recorded source output can be replayed without a database; the
/// service calls this exact function.
#[allow(clippy::too_many_arguments)]
pub fn build_timeline(session_id: &str, session: &Document, started: DateTime, end: DateTime, now: DateTime, activity: Document,
    snapshots: &[Document], raids: &[Document], markers: &[Document], participants: &[Document], tier: &str) -> Result<Document, StreamActivityError> {
    let offset = |at: DateTime| timeline_offset(at.timestamp_millis(), started.timestamp_millis());
    let mut points = Vec::new(); let mut events = Vec::<Document>::new();
    for (index, row) in snapshots.iter().take(MAX_ROWS).enumerate() {
        let at = datetime(row, "captured_at")?;
        let previous = index.checked_sub(1).and_then(|n| snapshots.get(n));
        let previous_at = previous.map(|p| datetime(p, "captured_at")).transpose()?.unwrap_or(started);
        let seconds = (at.timestamp_millis() as f64 - previous_at.timestamp_millis() as f64) / 1000.0;
        let delta = number(row, "messages") - previous.map(|p| number(p, "messages")).unwrap_or(0.0);
        let command_delta = number(row, "commands") - previous.map(|p| number(p, "commands")).unwrap_or(0.0);
        if let Some(previous) = previous {
            for (field, kind) in [("game_name", "game"), ("title", "title")] {
                if row.get(field) != previous.get(field) { events.push(doc! {"id": format!("{}:{}", kind, id(row)?.to_hex()), "kind": kind, "offsetSeconds": offset(at), "label": optional(row, field)}); }
            }
        }
        let mpm = if seconds > 0.0 && delta >= 0.0 { Bson::Double((delta / seconds * 600.0).round() / 10.0) } else { Bson::Null };
        let cpm = if tier != "free" && seconds > 0.0 && seconds <= 600.0 && command_delta >= 0.0 { Bson::Double((command_delta / seconds * 600.0).round() / 10.0) } else { Bson::Null };
        points.push(doc! {"offsetSeconds": offset(at), "viewers": optional(row, "viewers"), "messagesPerMinute": mpm, "commandsPerMinute": cpm,
            "gap": previous.is_some() && seconds > 600.0, "title": optional(row, "title"), "game": optional(row, "game_name")});
    }
    for row in raids.iter().take(100) {
        let payload = row.get_document("payload").ok().and_then(|v| v.get_document("event").ok());
        let label = payload.map(|v| { let name = text(v, "from_broadcaster_user_name"); if name.is_empty() { text(v, "from_broadcaster_user_login") } else { name } }).unwrap_or("");
        let viewers = payload.map(|v| number(v, "viewers").max(0.0)).unwrap_or(0.0);
        events.push(doc! {"id": format!("event:{}", text(row, "eventKey")), "kind": "raid", "offsetSeconds": offset(datetime(row, "occurredAt")?), "label": label, "value": viewers});
    }
    for row in markers.iter().take(100) {
        let kind = text(row, "kind");
        let marker_id = if kind == "raid" { text(row, "key").to_owned() } else { id(row)?.to_hex() };
        let mut event = doc! {"id": marker_id, "kind": kind, "offsetSeconds": offset(datetime(row, "occurredAt")?), "label": optional(row, "label")};
        if let Some(value) = row.get("value").filter(|v| !matches!(v, Bson::Null)) { event.insert("value", value.clone()); }
        if !text(row, "rewardID").is_empty() {
            event.insert("rewardID", text(row, "rewardID"));
            for field in ["cost", "status"] { if let Some(value) = row.get(field).filter(|v| !matches!(v, Bson::Null)) { event.insert(field, value.clone()); } }
        }
        events.push(event);
    }
    let legacy_truncated = participants.len() > 10_000;
    let mut counts = BTreeMap::<i64, i64>::new();
    if !legacy_truncated { for row in participants { *counts.entry(number(row, "bucket") as i64).or_default() += 1; } }
    let activity_tracking = activity.get_datetime("chatterStartedAt").ok().copied();
    let tracking = activity_tracking.or_else(|| session.get_datetime("chat_tracking_started_at").ok().copied()).map(offset);
    let mut projected = BTreeMap::<i64, Bson>::new();
    if let Ok(series) = activity.get_array("series") { for row in series.iter().filter_map(Bson::as_document) { projected.insert((number(row, "offsetSeconds") / 300.0) as i64, optional(row, "chatters")); } }
    let duration = offset(end);
    let size = ((duration / 300.0).ceil() as usize).min(MAX_ROWS);
    let chatters: Vec<Document> = (0..size).map(|bucket| {
        let known = !legacy_truncated && tracking.is_some_and(|at| (bucket * 300) as f64 >= at);
        let count = if !known { Bson::Null } else if activity_tracking.is_some() {
            projected.get(&(bucket as i64)).filter(|v| !matches!(v, Bson::Null)).cloned().unwrap_or(Bson::Int32(0))
        } else { Bson::Int64(*counts.get(&(bucket as i64)).unwrap_or(&0)) };
        doc! {"offsetSeconds": (bucket * 300) as i64, "count": count}
    }).collect();
    // JS Map replacement keeps the original position for repeated ids.
    let mut deduped = Vec::<Document>::new();
    let mut indices = std::collections::HashMap::<String, usize>::new();
    for event in events { let key = text(&event, "id").to_owned(); if let Some(index) = indices.get(&key) { deduped[*index] = event; } else { indices.insert(key, deduped.len()); deduped.push(event); } }
    deduped.sort_by(|a, b| number(a, "offsetSeconds").total_cmp(&number(b, "offsetSeconds")));
    let cursor = if markers.len() > 100 { let row = &markers[99];
        // `Date.prototype.toISOString`: three fractional digits and `Z`, which
        // RFC 3339 formatting only produces by accident.
        let iso = crate::utils::credit_policy::JsDate::from_millis(datetime(row, "occurredAt")?.timestamp_millis() as f64)
            .to_iso_string().map_err(|_| StreamActivityError::Runtime)?;
        Bson::String(format!("{}|{}", iso, id(row)?.to_hex()))
    } else { Bson::Null };
    let truncated = snapshots.len() > MAX_ROWS || legacy_truncated || activity.get_bool("truncated").unwrap_or(false) || duration > (MAX_ROWS * 300) as f64;
    Ok(doc! {"session": {"id": session_id, "startedAt": started, "endedAt": optional(session, "ended_at"), "status": optional(session, "status"), "durationSeconds": duration},
        "points": points, "chatters": chatters, "events": deduped, "activity": activity,
        "markerPage": {"hasMore": markers.len() > 100, "cursor": cursor},
        "coverage": {"retentionDays": 90, "chatterTrackingStartedAt": optional(session, "chat_tracking_started_at"), "truncated": truncated,
            "momentsPartial": raids.len() > 100 || markers.len() > 100}, "asOf": now})
}
