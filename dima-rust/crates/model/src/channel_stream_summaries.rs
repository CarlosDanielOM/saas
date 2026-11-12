//! `channelstreamsummaries`: reference `dimabot/src/schemas/channel_stream_summary.schema.ts`.
//! No hooks or hidden paths. Snake-case timestamps and __v. Indexes declared below.
//! Writers checked: utils/ai/memory/stream_memory_runner.ts:130 builds a summary from normalized context and AI decisions.
//! server/routes/stream-summary.route.ts:56,116 only reads; account_deletion.ts:167 only deletes.
//! No unchecked client-fed writes, document saves or runValidators. Typed proposal/action schemas
//! retained; private summary, evidence, reasons and errors are redacted. No legacy nulls.
//! duration_minutes and proposal confidence contain int32/double. Required unique session/source
//! identity prevents duplicate workflow summaries. No old Rust worker writes this collection.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "channelstreamsummaries";
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummaryProposedActionsActionValue {/// Schema value.
Create = "create",/// Schema value.
Edit = "edit",/// Schema value.
Archive = "archive",/// Schema value.
Delete = "delete",/// Schema value.
Noop = "noop"}}
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummaryProposedActionsRiskValue {/// Schema value.
Low = "low",/// Schema value.
Medium = "medium",/// Schema value.
High = "high"}}
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummaryAppliedActionsActionValue {/// Schema value.
Create = "create",/// Schema value.
Edit = "edit",/// Schema value.
Archive = "archive",/// Schema value.
Delete = "delete",/// Schema value.
Noop = "noop"}}
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummaryAppliedActionsStatusValue {/// Schema value.
Applied = "applied",/// Schema value.
Skipped = "skipped",/// Schema value.
Failed = "failed"}}
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummaryStatusValue {/// Schema value.
Pending = "pending",/// Schema value.
Applied = "applied",/// Schema value.
Noop = "noop",/// Schema value.
Failed = "failed"}}
crate::enums::str_enum! { /// Schema vocabulary.
pub enum ChannelStreamSummarySourceValue {/// Schema value.
StreamOffline = "stream_offline",/// Schema value.
WeeklyMaintenance = "weekly_maintenance",/// Schema value.
MonthlyMaintenance = "monthly_maintenance",/// Schema value.
Manual = "manual"}}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("Unknown")),
    Field::object_id("stream_session_id"),
    Field::string("stream_id").default(D::Str("")),
    Field::date("started_at"),
    Field::date("ended_at"),
    Field::number("duration_minutes").default(D::Int(0)),
    Field::number("average_viewers").default(D::Int(0)),
    Field::number("peak_viewers").default(D::Int(0)),
    Field::number("follows").default(D::Int(0)),
    Field::number("subs").default(D::Int(0)),
    Field::number("bits").default(D::Int(0)),
    Field::number("donations").default(D::Int(0)),
    Field::string("headline").default(D::Str("")),
    Field::string("recap").default(D::Str("")),
    Field::array("highlights", ValueType::String).default(D::EmptyArray),
    Field::number("chat_messages_sampled").default(D::Int(0)),
    Field::number("snapshot_count").default(D::Int(0)),
    Field::document_array(
        "proposed_actions",
        &Schema::subdocument(&[
            Field::string("action"),
            Field::string("type").default(D::Str("")),
            Field::string("targetMemoryId").default(D::Str("")),
            Field::string("summary").default(D::Str("")),
            Field::string("content").default(D::Str("")),
            Field::number("confidence").default(D::Int(0)),
            Field::string("risk").default(D::Str("low")),
            Field::string("reason").default(D::Str("")),
            Field::array("evidence", ValueType::String).default(D::EmptyArray),
        ])
        .no_id(),
    )
    .default(D::EmptyArray),
    Field::document_array(
        "applied_actions",
        &Schema::subdocument(&[
            Field::string("action"),
            Field::string("targetMemoryId").default(D::Str("")),
            Field::string("status"),
            Field::string("reason").default(D::Str("")),
            Field::string("error").default(D::Str("")),
        ])
        .no_id(),
    )
    .default(D::EmptyArray),
    Field::subdocument(
        "totals",
        &Schema::subdocument(&[
            Field::number("proposed").default(D::Int(0)),
            Field::number("applied").default(D::Int(0)),
            Field::number("skipped").default(D::Int(0)),
            Field::number("failed").default(D::Int(0)),
        ])
        .no_id(),
    )
    .default_fn(D::With(default_totals_write)),
    Field::string("status").default(D::Str("pending")),
    Field::string("error_message").default(D::Str("")),
    Field::string("source").default(D::Str("stream_offline")),
])
.timestamps(Timestamps::SNAKE);
fn default_channel_stream_summary_channel() -> String {
    "Unknown".into()
}
fn default_channel_stream_summary_stream_id() -> String {
    "".into()
}
fn default_channel_stream_summary_duration_minutes() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_average_viewers() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_peak_viewers() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_follows() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_subs() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_bits() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_donations() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_headline() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_recap() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_highlights() -> crate::Private<Vec<Option<String>>> {
    crate::Private::new(vec![])
}
fn default_channel_stream_summary_chat_messages_sampled() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_snapshot_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_proposed_actions_type() -> String {
    "".into()
}
fn default_channel_stream_summary_proposed_actions_target_memory_id() -> String {
    "".into()
}
fn default_channel_stream_summary_proposed_actions_summary() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_proposed_actions_content() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_proposed_actions_confidence() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_proposed_actions_risk()
-> crate::Open<ChannelStreamSummaryProposedActionsRiskValue> {
    crate::Open::Known(ChannelStreamSummaryProposedActionsRiskValue::Low)
}
fn default_channel_stream_summary_proposed_actions_reason() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_proposed_actions_evidence() -> crate::Private<Vec<Option<String>>>
{
    crate::Private::new(vec![])
}
fn default_channel_stream_summary_proposed_actions()
-> Vec<Option<ChannelStreamSummaryProposedActions>> {
    vec![]
}
fn default_channel_stream_summary_applied_actions_target_memory_id() -> String {
    "".into()
}
fn default_channel_stream_summary_applied_actions_reason() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_applied_actions_error() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_applied_actions()
-> Vec<Option<ChannelStreamSummaryAppliedActions>> {
    vec![]
}
fn default_channel_stream_summary_totals_proposed() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_totals_applied() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_totals_skipped() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_totals_failed() -> JsNumber {
    JsNumber(0.0)
}
fn default_channel_stream_summary_totals() -> ChannelStreamSummaryTotals {
    ChannelStreamSummaryTotals {
        proposed: JsNumber(0.0),
        applied: JsNumber(0.0),
        skipped: JsNumber(0.0),
        failed: JsNumber(0.0),
    }
}
fn default_channel_stream_summary_status() -> crate::Open<ChannelStreamSummaryStatusValue> {
    crate::Open::Known(ChannelStreamSummaryStatusValue::Pending)
}
fn default_channel_stream_summary_error_message() -> crate::Private<String> {
    crate::Private::new("".into())
}
fn default_channel_stream_summary_source() -> crate::Open<ChannelStreamSummarySourceValue> {
    crate::Open::Known(ChannelStreamSummarySourceValue::StreamOffline)
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelStreamSummaryProposedActions {
    /// `proposed_actions.$.action`.
    #[serde(rename = "action")]
    pub action: crate::Open<ChannelStreamSummaryProposedActionsActionValue>,
    /// `proposed_actions.$.type`.
    #[serde(
        rename = "type",
        default = "default_channel_stream_summary_proposed_actions_type"
    )]
    pub r#type: String,
    /// `proposed_actions.$.targetMemoryId`.
    #[serde(
        rename = "targetMemoryId",
        default = "default_channel_stream_summary_proposed_actions_target_memory_id"
    )]
    pub target_memory_id: String,
    /// `proposed_actions.$.summary`.
    #[serde(
        rename = "summary",
        default = "default_channel_stream_summary_proposed_actions_summary"
    )]
    pub summary: crate::Private<String>,
    /// `proposed_actions.$.content`.
    #[serde(
        rename = "content",
        default = "default_channel_stream_summary_proposed_actions_content"
    )]
    pub content: crate::Private<String>,
    /// `proposed_actions.$.confidence`.
    #[serde(
        rename = "confidence",
        default = "default_channel_stream_summary_proposed_actions_confidence"
    )]
    pub confidence: JsNumber,
    /// `proposed_actions.$.risk`.
    #[serde(
        rename = "risk",
        default = "default_channel_stream_summary_proposed_actions_risk"
    )]
    pub risk: crate::Open<ChannelStreamSummaryProposedActionsRiskValue>,
    /// `proposed_actions.$.reason`.
    #[serde(
        rename = "reason",
        default = "default_channel_stream_summary_proposed_actions_reason"
    )]
    pub reason: crate::Private<String>,
    /// `proposed_actions.$.evidence`.
    #[serde(
        rename = "evidence",
        default = "default_channel_stream_summary_proposed_actions_evidence"
    )]
    pub evidence: crate::Private<Vec<Option<String>>>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelStreamSummaryProposedActions {
    /// `proposed_actions.$.action`.
    #[serde(rename = "action")]
    pub action: ChannelStreamSummaryProposedActionsActionValue,
    /// `proposed_actions.$.type`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// `proposed_actions.$.targetMemoryId`.
    #[serde(rename = "targetMemoryId", skip_serializing_if = "Option::is_none")]
    pub target_memory_id: Option<String>,
    /// `proposed_actions.$.summary`.
    #[serde(rename = "summary", skip_serializing_if = "Option::is_none")]
    pub summary: Option<crate::Private<String>>,
    /// `proposed_actions.$.content`.
    #[serde(rename = "content", skip_serializing_if = "Option::is_none")]
    pub content: Option<crate::Private<String>>,
    /// `proposed_actions.$.confidence`.
    #[serde(rename = "confidence", skip_serializing_if = "Option::is_none")]
    pub confidence: Option<JsNumber>,
    /// `proposed_actions.$.risk`.
    #[serde(rename = "risk", skip_serializing_if = "Option::is_none")]
    pub risk: Option<ChannelStreamSummaryProposedActionsRiskValue>,
    /// `proposed_actions.$.reason`.
    #[serde(rename = "reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<crate::Private<String>>,
    /// `proposed_actions.$.evidence`.
    #[serde(rename = "evidence", skip_serializing_if = "Option::is_none")]
    pub evidence: Option<crate::Private<Vec<Option<String>>>>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelStreamSummaryAppliedActions {
    /// `applied_actions.$.action`.
    #[serde(rename = "action")]
    pub action: crate::Open<ChannelStreamSummaryAppliedActionsActionValue>,
    /// `applied_actions.$.targetMemoryId`.
    #[serde(
        rename = "targetMemoryId",
        default = "default_channel_stream_summary_applied_actions_target_memory_id"
    )]
    pub target_memory_id: String,
    /// `applied_actions.$.status`.
    #[serde(rename = "status")]
    pub status: crate::Open<ChannelStreamSummaryAppliedActionsStatusValue>,
    /// `applied_actions.$.reason`.
    #[serde(
        rename = "reason",
        default = "default_channel_stream_summary_applied_actions_reason"
    )]
    pub reason: crate::Private<String>,
    /// `applied_actions.$.error`.
    #[serde(
        rename = "error",
        default = "default_channel_stream_summary_applied_actions_error"
    )]
    pub error: crate::Private<String>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelStreamSummaryAppliedActions {
    /// `applied_actions.$.action`.
    #[serde(rename = "action")]
    pub action: ChannelStreamSummaryAppliedActionsActionValue,
    /// `applied_actions.$.targetMemoryId`.
    #[serde(rename = "targetMemoryId", skip_serializing_if = "Option::is_none")]
    pub target_memory_id: Option<String>,
    /// `applied_actions.$.status`.
    #[serde(rename = "status")]
    pub status: ChannelStreamSummaryAppliedActionsStatusValue,
    /// `applied_actions.$.reason`.
    #[serde(rename = "reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<crate::Private<String>>,
    /// `applied_actions.$.error`.
    #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::Private<String>>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelStreamSummaryTotals {
    /// `totals.proposed`.
    #[serde(
        rename = "proposed",
        default = "default_channel_stream_summary_totals_proposed"
    )]
    pub proposed: JsNumber,
    /// `totals.applied`.
    #[serde(
        rename = "applied",
        default = "default_channel_stream_summary_totals_applied"
    )]
    pub applied: JsNumber,
    /// `totals.skipped`.
    #[serde(
        rename = "skipped",
        default = "default_channel_stream_summary_totals_skipped"
    )]
    pub skipped: JsNumber,
    /// `totals.failed`.
    #[serde(
        rename = "failed",
        default = "default_channel_stream_summary_totals_failed"
    )]
    pub failed: JsNumber,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelStreamSummaryTotals {
    /// `totals.proposed`.
    #[serde(rename = "proposed", skip_serializing_if = "Option::is_none")]
    pub proposed: Option<JsNumber>,
    /// `totals.applied`.
    #[serde(rename = "applied", skip_serializing_if = "Option::is_none")]
    pub applied: Option<JsNumber>,
    /// `totals.skipped`.
    #[serde(rename = "skipped", skip_serializing_if = "Option::is_none")]
    pub skipped: Option<JsNumber>,
    /// `totals.failed`.
    #[serde(rename = "failed", skip_serializing_if = "Option::is_none")]
    pub failed: Option<JsNumber>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelStreamSummary {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", default = "default_channel_stream_summary_channel")]
    pub channel: String,
    /// `stream_session_id`.
    #[serde(rename = "stream_session_id")]
    pub stream_session_id: ObjectId,
    /// `stream_id`.
    #[serde(
        rename = "stream_id",
        default = "default_channel_stream_summary_stream_id"
    )]
    pub stream_id: String,
    /// `started_at`.
    #[serde(rename = "started_at")]
    pub started_at: JsDate,
    /// `ended_at`.
    #[serde(rename = "ended_at")]
    pub ended_at: JsDate,
    /// `duration_minutes`.
    #[serde(
        rename = "duration_minutes",
        default = "default_channel_stream_summary_duration_minutes"
    )]
    pub duration_minutes: JsNumber,
    /// `average_viewers`.
    #[serde(
        rename = "average_viewers",
        default = "default_channel_stream_summary_average_viewers"
    )]
    pub average_viewers: JsNumber,
    /// `peak_viewers`.
    #[serde(
        rename = "peak_viewers",
        default = "default_channel_stream_summary_peak_viewers"
    )]
    pub peak_viewers: JsNumber,
    /// `follows`.
    #[serde(rename = "follows", default = "default_channel_stream_summary_follows")]
    pub follows: JsNumber,
    /// `subs`.
    #[serde(rename = "subs", default = "default_channel_stream_summary_subs")]
    pub subs: JsNumber,
    /// `bits`.
    #[serde(rename = "bits", default = "default_channel_stream_summary_bits")]
    pub bits: JsNumber,
    /// `donations`.
    #[serde(
        rename = "donations",
        default = "default_channel_stream_summary_donations"
    )]
    pub donations: JsNumber,
    /// `headline`.
    #[serde(
        rename = "headline",
        default = "default_channel_stream_summary_headline"
    )]
    pub headline: crate::Private<String>,
    /// `recap`.
    #[serde(rename = "recap", default = "default_channel_stream_summary_recap")]
    pub recap: crate::Private<String>,
    /// `highlights`.
    #[serde(
        rename = "highlights",
        default = "default_channel_stream_summary_highlights"
    )]
    pub highlights: crate::Private<Vec<Option<String>>>,
    /// `chat_messages_sampled`.
    #[serde(
        rename = "chat_messages_sampled",
        default = "default_channel_stream_summary_chat_messages_sampled"
    )]
    pub chat_messages_sampled: JsNumber,
    /// `snapshot_count`.
    #[serde(
        rename = "snapshot_count",
        default = "default_channel_stream_summary_snapshot_count"
    )]
    pub snapshot_count: JsNumber,
    /// `proposed_actions`.
    #[serde(
        rename = "proposed_actions",
        default = "default_channel_stream_summary_proposed_actions"
    )]
    pub proposed_actions: Vec<Option<ChannelStreamSummaryProposedActions>>,
    /// `applied_actions`.
    #[serde(
        rename = "applied_actions",
        default = "default_channel_stream_summary_applied_actions"
    )]
    pub applied_actions: Vec<Option<ChannelStreamSummaryAppliedActions>>,
    /// `totals`.
    #[serde(rename = "totals", default = "default_channel_stream_summary_totals")]
    pub totals: ChannelStreamSummaryTotals,
    /// `status`.
    #[serde(rename = "status", default = "default_channel_stream_summary_status")]
    pub status: crate::Open<ChannelStreamSummaryStatusValue>,
    /// `error_message`.
    #[serde(
        rename = "error_message",
        default = "default_channel_stream_summary_error_message"
    )]
    pub error_message: crate::Private<String>,
    /// `source`.
    #[serde(rename = "source", default = "default_channel_stream_summary_source")]
    pub source: crate::Open<ChannelStreamSummarySourceValue>,
    /// Timestamp.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Timestamp.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelStreamSummary {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `stream_session_id`.
    #[serde(rename = "stream_session_id")]
    pub stream_session_id: ObjectId,
    /// `stream_id`.
    #[serde(rename = "stream_id")]
    pub stream_id: String,
    /// `started_at`.
    #[serde(rename = "started_at")]
    pub started_at: JsDate,
    /// `ended_at`.
    #[serde(rename = "ended_at")]
    pub ended_at: JsDate,
    /// `duration_minutes`.
    #[serde(rename = "duration_minutes", skip_serializing_if = "Option::is_none")]
    pub duration_minutes: Option<JsNumber>,
    /// `average_viewers`.
    #[serde(rename = "average_viewers", skip_serializing_if = "Option::is_none")]
    pub average_viewers: Option<JsNumber>,
    /// `peak_viewers`.
    #[serde(rename = "peak_viewers", skip_serializing_if = "Option::is_none")]
    pub peak_viewers: Option<JsNumber>,
    /// `follows`.
    #[serde(rename = "follows", skip_serializing_if = "Option::is_none")]
    pub follows: Option<JsNumber>,
    /// `subs`.
    #[serde(rename = "subs", skip_serializing_if = "Option::is_none")]
    pub subs: Option<JsNumber>,
    /// `bits`.
    #[serde(rename = "bits", skip_serializing_if = "Option::is_none")]
    pub bits: Option<JsNumber>,
    /// `donations`.
    #[serde(rename = "donations", skip_serializing_if = "Option::is_none")]
    pub donations: Option<JsNumber>,
    /// `headline`.
    #[serde(rename = "headline", skip_serializing_if = "Option::is_none")]
    pub headline: Option<crate::Private<String>>,
    /// `recap`.
    #[serde(rename = "recap", skip_serializing_if = "Option::is_none")]
    pub recap: Option<crate::Private<String>>,
    /// `highlights`.
    #[serde(rename = "highlights", skip_serializing_if = "Option::is_none")]
    pub highlights: Option<crate::Private<Vec<Option<String>>>>,
    /// `chat_messages_sampled`.
    #[serde(
        rename = "chat_messages_sampled",
        skip_serializing_if = "Option::is_none"
    )]
    pub chat_messages_sampled: Option<JsNumber>,
    /// `snapshot_count`.
    #[serde(rename = "snapshot_count", skip_serializing_if = "Option::is_none")]
    pub snapshot_count: Option<JsNumber>,
    /// `proposed_actions`.
    #[serde(rename = "proposed_actions", skip_serializing_if = "Option::is_none")]
    pub proposed_actions: Option<Vec<Option<NewChannelStreamSummaryProposedActions>>>,
    /// `applied_actions`.
    #[serde(rename = "applied_actions", skip_serializing_if = "Option::is_none")]
    pub applied_actions: Option<Vec<Option<NewChannelStreamSummaryAppliedActions>>>,
    /// `totals`.
    #[serde(rename = "totals", skip_serializing_if = "Option::is_none")]
    pub totals: Option<NewChannelStreamSummaryTotals>,
    /// `status`.
    #[serde(rename = "status")]
    pub status: ChannelStreamSummaryStatusValue,
    /// `error_message`.
    #[serde(rename = "error_message", skip_serializing_if = "Option::is_none")]
    pub error_message: Option<crate::Private<String>>,
    /// `source`.
    #[serde(rename = "source")]
    pub source: ChannelStreamSummarySourceValue,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[
    "headline",
    "recap",
    "highlights",
    "proposed_actions.$.summary",
    "proposed_actions.$.content",
    "proposed_actions.$.reason",
    "proposed_actions.$.evidence",
    "applied_actions.$.reason",
    "applied_actions.$.error",
    "error_message",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("stream_session_id", 1)]),
    IndexSpec::on(&[("started_at", 1)]),
    IndexSpec::on(&[("ended_at", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("source", 1)]),
    IndexSpec::on(&[("channelID", 1), ("stream_session_id", 1), ("source", 1)]).unique(),
    IndexSpec::on(&[("channelID", 1), ("ended_at", -1)]),
    IndexSpec::on(&[("status", 1), ("created_at", -1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("stream_session_id"),
    Rule::required("stream_id"),
    Rule::required("started_at"),
    Rule::required("ended_at"),
    Rule::required("proposed_actions.$.action"),
    Rule::one_of(
        "proposed_actions.$.action",
        &["create", "edit", "archive", "delete", "noop"],
    ),
    Rule::one_of("proposed_actions.$.risk", &["low", "medium", "high"]),
    Rule::required("applied_actions.$.action"),
    Rule::one_of(
        "applied_actions.$.action",
        &["create", "edit", "archive", "delete", "noop"],
    ),
    Rule::required("applied_actions.$.status"),
    Rule::one_of(
        "applied_actions.$.status",
        &["applied", "skipped", "failed"],
    ),
    Rule::required("status"),
    Rule::one_of("status", &["pending", "applied", "noop", "failed"]),
    Rule::required("source"),
    Rule::one_of(
        "source",
        &[
            "stream_offline",
            "weekly_maintenance",
            "monthly_maintenance",
            "manual",
        ],
    ),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::value("stream_session_id"),
    ReadNeed::not_null("stream_id"),
    ReadNeed::value("started_at"),
    ReadNeed::value("ended_at"),
    ReadNeed::not_null("duration_minutes"),
    ReadNeed::not_null("average_viewers"),
    ReadNeed::not_null("peak_viewers"),
    ReadNeed::not_null("follows"),
    ReadNeed::not_null("subs"),
    ReadNeed::not_null("bits"),
    ReadNeed::not_null("donations"),
    ReadNeed::not_null("headline"),
    ReadNeed::not_null("recap"),
    ReadNeed::not_null("highlights"),
    ReadNeed::not_null("chat_messages_sampled"),
    ReadNeed::not_null("snapshot_count"),
    ReadNeed::value("proposed_actions.$.action"),
    ReadNeed::not_null("proposed_actions.$.type"),
    ReadNeed::not_null("proposed_actions.$.targetMemoryId"),
    ReadNeed::not_null("proposed_actions.$.summary"),
    ReadNeed::not_null("proposed_actions.$.content"),
    ReadNeed::not_null("proposed_actions.$.confidence"),
    ReadNeed::not_null("proposed_actions.$.risk"),
    ReadNeed::not_null("proposed_actions.$.reason"),
    ReadNeed::not_null("proposed_actions.$.evidence"),
    ReadNeed::not_null("proposed_actions"),
    ReadNeed::value("applied_actions.$.action"),
    ReadNeed::not_null("applied_actions.$.targetMemoryId"),
    ReadNeed::value("applied_actions.$.status"),
    ReadNeed::not_null("applied_actions.$.reason"),
    ReadNeed::not_null("applied_actions.$.error"),
    ReadNeed::not_null("applied_actions"),
    ReadNeed::not_null("totals.proposed"),
    ReadNeed::not_null("totals.applied"),
    ReadNeed::not_null("totals.skipped"),
    ReadNeed::not_null("totals.failed"),
    ReadNeed::not_null("totals"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("error_message"),
    ReadNeed::not_null("source"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ChannelStreamSummary",
    source: "dimabot/src/schemas/channel_stream_summary.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ChannelStreamSummary>,
};
impl NewChannelStreamSummary {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

fn default_totals_write(_: i64) -> bson::Bson {
    bson::Bson::Document(bson::doc! {"proposed":0,"applied":0,"skipped":0,"failed":0})
}
