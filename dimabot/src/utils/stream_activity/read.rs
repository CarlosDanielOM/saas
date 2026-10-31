//! Aggregate read model for `getStreamActivity`.
use super::capture::StreamActivityError;
use futures_util::TryStreamExt;
use mongodb::{bson::{doc, Bson, DateTime, Document, oid::ObjectId}, Database};
use std::time::Duration;

/// Read limits and deadline fixed by the source `getStreamActivity`.
pub const RANK_LIMIT: i64 = 20;
pub const SERIES_LIMIT: i64 = 2001;
pub const READ_MAX_TIME_MS: u64 = 1500;

/// Query documents for one `getStreamActivity` read.
///
/// Exposed so the recorded source documents in
/// `tests/stream_timeline_data.rs` can be compared field by field; the service
/// below uses this same builder, so the comparison covers the live path.
#[derive(Clone, Debug)]
pub struct ActivityFilters { pub summary: Document, pub commands: Document, pub emotes: Document, pub series: Document, pub pending: Document }
pub fn activity_filters(channel_id: &str, session_id: ObjectId, now: DateTime) -> ActivityFilters {
    let scope = doc! {"channelID": channel_id, "session_id": session_id, "expiresAt": {"$gt": now}};
    let mut summary = scope.clone(); summary.insert("scope", "summary");
    let mut commands = scope.clone(); commands.insert("scope", "rank"); commands.insert("kind", "command");
    let mut emotes = scope.clone(); emotes.insert("scope", "rank"); emotes.insert("kind", "emote");
    let mut series = scope.clone(); series.insert("scope", "chart"); series.insert("bucket", doc! {"$gte": 0});
    let mut pending = scope; pending.insert("processed", false);
    ActivityFilters { summary, commands, emotes, series, pending }
}
#[derive(Clone)]
pub struct StreamActivityReader { database: Database, deadline: Duration }
impl StreamActivityReader {
    pub fn new(database: Database) -> Self { Self { database, deadline: Duration::from_secs(12) } }
    pub async fn from_runtime(name: &str) -> Result<Self, StreamActivityError> {
        if name.trim().is_empty() { return Err(StreamActivityError::Configuration); }
        let client = tokio::time::timeout(Duration::from_secs(12), crate::utils::mongo::get_mongo_client()).await
            .map_err(|_| StreamActivityError::Timeout)?.map_err(|_| StreamActivityError::Runtime)?;
        Ok(Self::new(client.database(name)))
    }
    pub async fn get_stream_activity(&self, channel_id: &str, session_id: ObjectId, tier: Option<&str>) -> Result<Document, StreamActivityError> {
        let tier = tier.unwrap_or("free");
        let now = DateTime::now();
        let aggregates = crate::schemas::stream_activity::aggregate_schema().native_collection(&self.database);
        let activities = crate::schemas::stream_activity::schema().native_collection(&self.database);
        let ActivityFilters { summary: summary_query, commands: commands_query, emotes: emotes_query, series: series_query, pending: pending_query } = activity_filters(channel_id, session_id, now);
        let operation = async {
            let summary = async { aggregates.find_one(summary_query).max_time(Duration::from_millis(READ_MAX_TIME_MS)).await };
            let commands = async { aggregates.find(commands_query).sort(doc! {"count": -1, "_id": 1}).limit(RANK_LIMIT).max_time(Duration::from_millis(READ_MAX_TIME_MS)).await?.try_collect::<Vec<Document>>().await };
            let emotes = async { aggregates.find(emotes_query).sort(doc! {"count": -1, "_id": 1}).limit(RANK_LIMIT).max_time(Duration::from_millis(READ_MAX_TIME_MS)).await?.try_collect::<Vec<Document>>().await };
            let series = async { aggregates.find(series_query).sort(doc! {"bucket": 1}).limit(SERIES_LIMIT).max_time(Duration::from_millis(READ_MAX_TIME_MS)).await?.try_collect::<Vec<Document>>().await };
            let pending = async { activities.find_one(pending_query).projection(doc! {"_id": 1}).max_time(Duration::from_millis(READ_MAX_TIME_MS)).await };
            let (summary, commands, emotes, series, pending) = tokio::try_join!(summary, commands, emotes, series, pending).map_err(|_| StreamActivityError::Runtime)?;
            Ok::<_, StreamActivityError>(build_activity_result(summary.as_ref(), &commands, &emotes, &series, pending.is_some(), tier))
        };
        tokio::time::timeout(self.deadline, operation).await.map_err(|_| StreamActivityError::Timeout)?
    }
}
fn copy(source: &Document, dest: &mut Document, from: &str, to: &str) {
    if let Some(value) = source.get(from) { dest.insert(to, value.clone()); }
}
fn number(value: Option<&Bson>) -> f64 { match value { Some(Bson::Int32(v)) => f64::from(*v), Some(Bson::Int64(v)) => *v as f64, Some(Bson::Double(v)) => *v, _ => 0.0 } }
pub fn build_activity_result(summary: Option<&Document>, commands: &[Document], emotes: &[Document], series: &[Document], pending: bool, tier: &str) -> Document {
    let totals = summary.map(|source| { let mut out = Document::new();
        for field in ["messages", "commands", "emotes", "emoteMessages", "redemptions", "follows", "subs", "bits", "raids"] { copy(source, &mut out, field, field); } out });
    let commands: Vec<Document> = commands.iter().map(|row| { let mut out = Document::new();
        for key in ["key", "label", "count"] { copy(row, &mut out, key, key); }
        if tier != "free" { copy(row, &mut out, "failures", "errors"); } out }).collect();
    let emotes: Vec<Document> = emotes.iter().map(|row| { let mut out = Document::new();
        for key in ["key", "label", "count", "messages"] { copy(row, &mut out, key, key); } out }).collect();
    let points: Vec<Document> = series.iter().take(2000).map(|row| { let mut out = doc! {"offsetSeconds": number(row.get("bucket")) * 300.0};
        if tier != "free" { copy(row, &mut out, "commands", "commands"); copy(row, &mut out, "emotes", "emotes"); }
        copy(row, &mut out, "messages", "messages"); copy(row, &mut out, "chatters", "chatters"); out }).collect();
    let date = |name: &str| summary.and_then(|s| s.get(name)).cloned().unwrap_or(Bson::Null);
    doc! {"totals": totals.map(Bson::Document).unwrap_or(Bson::Null), "commands": commands, "emotes": emotes,
        "series": points, "coverageStartedAt": date("firstAt"), "chatterStartedAt": date("messageStartedAt"),
        "updatedAt": date("updatedAt"), "pending": pending, "truncated": series.len() > 2000, "planTier": tier,
        "capabilities": {"trends": tier != "free", "comparison": tier != "free", "users": tier == "pro"} }
}
