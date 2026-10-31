//! Schema contract for `channel_stream_summary.schema.ts`.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{doc, DateTime, oid::ObjectId};
use std::sync::OnceLock;

pub const ACTIONS: &[&str] = &["create", "edit", "archive", "delete", "noop"];
pub const RISKS: &[&str] = &["low", "medium", "high"];
pub const ACTION_STATUSES: &[&str] = &["applied", "skipped", "failed"];
pub const SUMMARY_STATUSES: &[&str] = &["pending", "applied", "noop", "failed"];
pub const SUMMARY_SOURCES: &[&str] = &["stream_offline", "weekly_maintenance", "monthly_maintenance", "manual"];

pub fn memory_proposal_fields() -> Vec<Field> {
    let mut fields = vec![Field::new("action", T::String).enumeration(ACTIONS).required()];
    for name in ["type", "targetMemoryId", "summary", "content"] { fields.push(Field::new(name, T::String).default(D::String(""))); }
    fields.push(Field::new("confidence", T::Number).default(D::Number(0.0)));
    fields.push(Field::new("risk", T::String).enumeration(RISKS).default(D::String("low")));
    fields.push(Field::new("reason", T::String).default(D::String("")));
    fields.push(Field::new("evidence", T::Array(Box::new(T::String))).default(D::Array));
    fields
}
pub fn memory_action_result_fields() -> Vec<Field> {
    vec![Field::new("action", T::String).enumeration(ACTIONS).required(),
        Field::new("targetMemoryId", T::String).default(D::String("")),
        Field::new("status", T::String).enumeration(ACTION_STATUSES).required(),
        Field::new("reason", T::String).default(D::String("")),
        Field::new("error", T::String).default(D::String(""))]
}
pub fn memory_action_totals_fields() -> Vec<Field> {
    ["proposed", "applied", "skipped", "failed"].into_iter().map(|name| Field::new(name, T::Number).default(D::Number(0.0))).collect()
}
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut fields = vec![Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).required().default(D::String("Unknown")),
            Field::new("stream_session_id", T::ObjectId).required(),
            Field::new("stream_id", T::String).required().default(D::String("")),
            Field::new("started_at", T::Date).required(), Field::new("ended_at", T::Date).required()];
        for name in ["duration_minutes", "average_viewers", "peak_viewers", "follows", "subs", "bits", "donations"] {
            fields.push(Field::new(name, T::Number).default(D::Number(0.0)));
        }
        for name in ["headline", "recap"] { fields.push(Field::new(name, T::String).default(D::String(""))); }
        fields.push(Field::new("highlights", T::Array(Box::new(T::String))).default(D::Array));
        for name in ["chat_messages_sampled", "snapshot_count"] { fields.push(Field::new(name, T::Number).default(D::Number(0.0))); }
        fields.push(Field::new("proposed_actions", T::Array(Box::new(T::Subdocument { fields: memory_proposal_fields(), generate_id: false }))).default(D::Array));
        fields.push(Field::new("applied_actions", T::Array(Box::new(T::Subdocument { fields: memory_action_result_fields(), generate_id: false }))).default(D::Array));
        fields.push(Field::new("totals", T::Subdocument { fields: memory_action_totals_fields(), generate_id: false }).default(D::Object));
        fields.push(Field::new("status", T::String).enumeration(SUMMARY_STATUSES).required().default(D::String("pending")));
        fields.push(Field::new("error_message", T::String).default(D::String("")));
        fields.push(Field::new("source", T::String).enumeration(SUMMARY_SOURCES).required().default(D::String("stream_offline")));
        SchemaDefinition { model: "ChannelStreamSummary", collection: "channelstreamsummaries", string_id: false,
            version_key: true, write_concern_journaled: false, timestamps: Some(("created_at", "updated_at")), save_clock_field: None, fields,
            indexes: vec![SchemaIndex::new(doc! {"channelID": 1}), SchemaIndex::new(doc! {"stream_session_id": 1}),
                SchemaIndex::new(doc! {"started_at": 1}), SchemaIndex::new(doc! {"ended_at": 1}),
                SchemaIndex::new(doc! {"status": 1}), SchemaIndex::new(doc! {"source": 1}),
                SchemaIndex::new(doc! {"channelID": 1, "stream_session_id": 1, "source": 1}).unique(),
                SchemaIndex::new(doc! {"channelID": 1, "ended_at": -1}), SchemaIndex::new(doc! {"status": 1, "created_at": -1})] }
    })
}
#[derive(Clone, Debug, PartialEq)]
pub struct IMemoryProposal { pub action: String, pub kind: Option<String>, pub target_memory_id: Option<String>, pub summary: Option<String>, pub content: Option<String>, pub confidence: Option<f64>, pub risk: Option<String>, pub reason: Option<String>, pub evidence: Option<Vec<String>> }
#[derive(Clone, Debug, PartialEq)]
pub struct IMemoryActionResult { pub action: String, pub target_memory_id: Option<String>, pub status: String, pub reason: Option<String>, pub error: Option<String> }
#[derive(Clone, Debug, PartialEq)]
pub struct IMemoryActionTotals { pub proposed: f64, pub applied: f64, pub skipped: f64, pub failed: f64 }
#[derive(Clone, Debug, PartialEq)]
pub struct IStreamSummary {
    pub id: ObjectId, pub channel_id: String, pub channel: String, pub stream_session_id: ObjectId,
    pub stream_id: String, pub started_at: DateTime, pub ended_at: DateTime, pub duration_minutes: f64,
    pub average_viewers: f64, pub peak_viewers: f64, pub follows: f64, pub subs: f64, pub bits: f64,
    pub donations: f64, pub headline: String, pub recap: String, pub highlights: Vec<String>,
    pub chat_messages_sampled: f64, pub snapshot_count: f64, pub proposed_actions: Vec<IMemoryProposal>,
    pub applied_actions: Vec<IMemoryActionResult>, pub totals: IMemoryActionTotals, pub status: String,
    pub error_message: String, pub source: String, pub created_at: DateTime, pub updated_at: DateTime,
}
