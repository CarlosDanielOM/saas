//! Event capture for stream activity; the existing projector processes the rows.
use mongodb::{bson::{doc, Bson, DateTime, Document, oid::ObjectId}, error::{Error, ErrorKind, WriteFailure}, options::{Acknowledgment, WriteConcern}, Database};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, str::FromStr, time::Duration};

pub const ACTIVITY_RETENTION_MS: i64 = 90 * 86_400_000;
pub const FUTURE_WINDOW_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind { Message, Command, Redemption, Follow, Sub, Gift, Bits, Raid }
impl ActivityKind {
    pub fn as_str(self) -> &'static str { match self { Self::Message => "message", Self::Command => "command", Self::Redemption => "redemption", Self::Follow => "follow", Self::Sub => "sub", Self::Gift => "gift", Self::Bits => "bits", Self::Raid => "raid" } }
}
impl FromStr for ActivityKind {
    type Err = StreamActivityError;
    fn from_str(s: &str) -> Result<Self, Self::Err> { match s {
        "message" => Ok(Self::Message), "command" => Ok(Self::Command), "redemption" => Ok(Self::Redemption), "follow" => Ok(Self::Follow), "sub" => Ok(Self::Sub), "gift" => Ok(Self::Gift), "bits" => Ok(Self::Bits), "raid" => Ok(Self::Raid), _ => Err(StreamActivityError::Validation),
    } }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamActivityError { Configuration, Validation, Runtime, NotFound, Timeout }
impl fmt::Display for StreamActivityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(match self { Self::Configuration => "stream activity configuration error", Self::Validation => "stream activity validation error", Self::Runtime => "stream activity runtime error", Self::NotFound => "stream activity not found", Self::Timeout => "stream activity operation timed out" }) }
}
impl std::error::Error for StreamActivityError {}

pub fn hash(parts: &[serde_json::Value]) -> Result<String, StreamActivityError> {
    let bytes = serde_json::to_vec(parts).map_err(|_| StreamActivityError::Validation)?;
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(64);
    for byte in digest { use std::fmt::Write; write!(&mut result, "{byte:02x}").map_err(|_| StreamActivityError::Runtime)?; }
    Ok(result)
}
/// JavaScript truncates UTF-16 units. A split surrogate cannot be represented
/// by BSON UTF-8 and is replaced with U+FFFD at this Rust string boundary.
pub fn bounded(value: Option<&str>, length: usize) -> String {
    String::from_utf16_lossy(&value.unwrap_or("").encode_utf16().take(length).collect::<Vec<_>>())
}
pub fn activity_time_valid(at: i64, now: i64) -> bool {
    (-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&at)
        && i128::from(at) >= i128::from(now) - i128::from(ACTIVITY_RETENTION_MS)
        && i128::from(at) <= i128::from(now) + i128::from(FUTURE_WINDOW_MS)
}
pub fn offset_seconds(at: i64, started: i64) -> f64 { (at as f64 - started as f64) / 1000.0 }
/// `Math.max(0, value ?? 1)`: NaN stays NaN, and every value that is not
/// greater than +0 becomes +0. Negative zero must not survive, because the Node
/// BSON writer would encode it as a Double where the source stores Int32 zero.
pub fn activity_value(value: Option<f64>) -> f64 {
    let n = value.unwrap_or(1.0);
    if n.is_nan() { n } else if n > 0.0 { n } else { 0.0 }
}
pub fn activity_outcome(value: Option<&str>) -> &'static str { if value == Some("error") { "error" } else { "ok" } }
pub fn session_filter(channel_id: &str, at: DateTime) -> Document {
    doc! {"channelID": channel_id, "started_at": {"$lte": at}, "$or": [{"ended_at": {"$gt": at}}, {"ended_at": Bson::Null}]}
}
pub fn duplicate_code(code: i32) -> bool { code == 11000 }
pub fn is_duplicate(error: &Error) -> bool { match error.kind.as_ref() {
    ErrorKind::Write(WriteFailure::WriteError(error)) => duplicate_code(error.code),
    ErrorKind::Command(error) => duplicate_code(error.code), _ => false,
} }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimelineEmote { pub key: String, pub label: String, pub count: i64 }
#[derive(Clone, Debug, Deserialize)]
pub struct ChatEmote { pub id: Option<String> }
#[derive(Clone, Debug, Deserialize)]
pub struct ChatFragment { pub r#type: String, pub text: String, pub emote: Option<ChatEmote> }
#[derive(Clone, Debug, Deserialize)]
pub struct ChatMessage { pub fragments: Vec<ChatFragment> }
pub fn extract_timeline_emotes(message: &ChatMessage) -> Vec<TimelineEmote> {
    let mut result: Vec<TimelineEmote> = Vec::new();
    for fragment in message.fragments.iter().take(500) {
        if fragment.r#type != "emote" { continue; }
        let Some(id) = fragment.emote.as_ref().and_then(|emote| emote.id.as_deref()).filter(|id| !id.is_empty()) else { continue; };
        let key = format!("twitch:{}", bounded(Some(id), 64));
        if let Some(row) = result.iter_mut().find(|row| row.key == key) { row.count += 1; }
        else { result.push(TimelineEmote { key, label: bounded(Some(&fragment.text), 64), count: 1 }); }
    }
    result
}
#[derive(Clone, Debug)]
pub struct CaptureSession { pub id: ObjectId, pub started_at: DateTime }
#[derive(Clone, Debug)]
pub struct CaptureInput {
    pub channel_id: String, pub event_id: String, pub kind: ActivityKind, pub occurred_at: Option<DateTime>,
    pub session: Option<CaptureSession>, pub actor: Option<String>, pub actor_label: Option<String>,
    pub key: Option<String>, pub label: Option<String>, pub value: Option<f64>, pub outcome: Option<String>, pub emotes: Vec<TimelineEmote>,
}
pub fn activity_insert(input: &CaptureInput, session: &CaptureSession, at: DateTime) -> Result<Document, StreamActivityError> {
    let expiry = at.timestamp_millis().checked_add(ACTIVITY_RETENTION_MS).ok_or(StreamActivityError::Validation)?;
    let emotes = input.emotes.iter().map(|e| doc! {"key": &e.key, "label": &e.label, "count": e.count}).collect::<Vec<_>>();
    Ok(doc! {"channelID": &input.channel_id, "session_id": session.id, "occurredAt": at,
        "offset": offset_seconds(at.timestamp_millis(), session.started_at.timestamp_millis()),
        "kind": input.kind.as_str(), "actor": bounded(input.actor.as_deref(), 64), "actorLabel": bounded(input.actor_label.as_deref(), 64),
        "key": bounded(input.key.as_deref(), 100), "label": bounded(input.label.as_deref(), 100),
        "value": activity_value(input.value), "outcome": activity_outcome(input.outcome.as_deref()),
        "emotes": emotes, "processed": false, "expiresAt": DateTime::from_millis(expiry) })
}
/// Cast an equality filter and insertion payload using the accepted schema.
/// `construct` adds an ObjectId for non-string IDs; discard that generated ID
/// when it was not part of the input so MongoDB still creates it on insert.
pub fn construct_upsert(
    schema: &crate::schemas::SchemaDefinition,
    filter: Document,
    insert: Document,
    now: DateTime,
) -> Result<(Document, Document), StreamActivityError> {
    let filter_names: Vec<String> = filter.keys().cloned().collect();
    let had_id = filter.contains_key("_id") || insert.contains_key("_id");
    let mut merged = filter;
    merged.extend(insert);
    let mut constructed = schema.construct(&merged, now).map_err(|_| StreamActivityError::Validation)?;
    if !had_id { constructed.remove("_id"); }
    let mut cast_filter = Document::new();
    for name in filter_names {
        let value = constructed.remove(&name).ok_or(StreamActivityError::Validation)?;
        cast_filter.insert(name, value);
    }
    Ok((cast_filter, doc! {"$setOnInsert": constructed}))
}

pub fn activity_upsert(input: &CaptureInput, session: &CaptureSession, at: DateTime) -> Result<(Document, Document), StreamActivityError> {
    let id = hash(&[input.channel_id.clone().into(), input.kind.as_str().into(), input.event_id.clone().into()])?;
    construct_upsert(crate::schemas::stream_activity::schema(), doc! {"_id": id}, activity_insert(input, session, at)?, at)
}

pub fn activity_update(input: &CaptureInput, session: &CaptureSession, at: DateTime) -> Result<Document, StreamActivityError> {
    Ok(activity_upsert(input, session, at)?.1)
}
#[derive(Clone)]
pub struct StreamActivityCapture { database: Database, deadline: Duration }
impl StreamActivityCapture {
    pub fn new(database: Database) -> Self { Self { database, deadline: Duration::from_secs(12) } }
    pub async fn from_runtime(name: &str) -> Result<Self, StreamActivityError> {
        if name.trim().is_empty() { return Err(StreamActivityError::Configuration); }
        let client = tokio::time::timeout(Duration::from_secs(12), crate::utils::mongo::get_mongo_client()).await
            .map_err(|_| StreamActivityError::Timeout)?.map_err(|_| StreamActivityError::Runtime)?;
        Ok(Self::new(client.database(name)))
    }
    pub async fn capture_stream_activity(&self, input: &CaptureInput) -> Result<(), StreamActivityError> {
        let now = DateTime::now();
        self.capture_at(input, now).await
    }
    pub async fn capture_at(&self, input: &CaptureInput, now: DateTime) -> Result<(), StreamActivityError> {
        if input.event_id.is_empty() || input.channel_id.is_empty() { return Ok(()); }
        let at = input.occurred_at.unwrap_or(now);
        if !activity_time_valid(at.timestamp_millis(), now.timestamp_millis()) { return Ok(()); }
        let operation = async {
            let session = if let Some(session) = &input.session { session.clone() } else {
                let collection = crate::schemas::stream_session::schema().native_collection(&self.database);
                let found = collection.find_one(session_filter(&input.channel_id, at)).sort(doc! {"started_at": -1})
                    .projection(doc! {"_id": 1, "started_at": 1}).max_time(Duration::from_millis(1500)).await.map_err(|_| StreamActivityError::Runtime)?;
                let Some(row) = found else { return Ok(()); };
                CaptureSession { id: row.get_object_id("_id").map_err(|_| StreamActivityError::Runtime)?, started_at: *row.get_datetime("started_at").map_err(|_| StreamActivityError::Runtime)? }
            };
            if at.timestamp_millis() < session.started_at.timestamp_millis() { return Ok(()); }
            let (filter, update) = activity_upsert(input, &session, at)?;
            let collection = crate::schemas::stream_activity::schema().native_collection(&self.database);
            let write = collection.update_one(filter, update).upsert(true)
                .write_concern(WriteConcern::builder().w(Acknowledgment::Nodes(1)).journal(true).build()).await;
            match write { Ok(_) => Ok(()), Err(error) if is_duplicate(&error) => Ok(()), Err(_) => Err(StreamActivityError::Runtime) }
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
}
