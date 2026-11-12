//! `cliprecommendations`: reference `dimabot/src/schemas/clip_recommendation.schema.ts`.
//! Snake timestamps, __v; hidden notificationPayload; no hooks or runValidators.
//! Writers checked: utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts:238-260,
//! 314-318,431-451,525-603,648-665,739-749,804-869 (creates, saves, updates);
//! clip_recommendation_notifications.ts:16-62 (rendered payload save and retry states),
//! clip_recommendation_reconciliation.ts:70; scripts/cleanup_orphaned_clip_recommendations.script.ts:37.
//! Client-fed writes: none. server/routes/clip-recommendations.route.ts:154-186 normalizes
//! VOD/session/stream inputs before enqueue; :241 maps a checked confirm/deny action to a
//! server-selected candidate status. clip_recommendations_queue.ts normalizes strings/numbers;
//! workers/vod_clip_recommender.worker.ts:251 selects a closed source value; the runner builds candidates.
//! Legacy: billing/notification/cleanup fields and queueJobID may be absent; missing literal
//! defaults hydrate, missing/null date fields stay optional. Candidates' confidence is double;
//! counts, seconds and credits are int32 in the census. JsNumber writes preserve Node's widths.
//! Hidden rendered mail, candidate explanation text, preview locations and errors are private.
//! The schema defines candidate fields and rendered-email fields explicitly, with no Mixed
//! model-answer field: unknown structured-answer keys are dropped by the strict schema.
//! Unique sparse queueJobID is required: duplicate rows would count one analysis job twice.
//! Other server-only READ_NEEDS nulls/removals are refused; reads never invent Date.now.
use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::schema::{Timestamps, ValueType};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
str_enum! { /// `source`.
pub enum SourceKind {/// `stream_offline`.
StreamOffline = "stream_offline",/// `manual`.
Manual = "manual"} }
str_enum! { /// `status`.
pub enum StatusKind {/// `pending`.
Pending = "pending",/// `processing`.
Processing = "processing",/// `completed`.
Completed = "completed",/// `failed`.
Failed = "failed"} }
str_enum! { /// `billingStatus`.
pub enum BillingStatusKind {/// `pending`.
Pending = "pending",/// `charged`.
Charged = "charged",/// `failed`.
Failed = "failed"} }
str_enum! { /// `notificationStatus`.
pub enum NotificationStatusKind {/// `not_required`.
NotRequired = "not_required",/// `pending`.
Pending = "pending",/// `sent`.
Sent = "sent",/// `failed`.
Failed = "failed"} }
str_enum! { /// `candidates.$.status`.
pub enum CandidatesStatusKind {/// `pending`.
Pending = "pending",/// `approved`.
Approved = "approved",/// `rejected`.
Rejected = "rejected",/// `confirmed`.
Confirmed = "confirmed",/// `denied`.
Denied = "denied"} }
fn default_channel() -> String {
    String::new()
}
fn default_session_id() -> String {
    String::new()
}
fn default_stream_id() -> String {
    String::new()
}
fn default_vod_id() -> String {
    String::new()
}
fn default_vod_url() -> Private<String> {
    Private::new(String::new())
}
fn default_source() -> Open<SourceKind> {
    SourceKind::Manual.into()
}
fn default_status() -> Open<StatusKind> {
    StatusKind::Pending.into()
}
fn default_requested_by() -> String {
    String::new()
}
fn default_model_id() -> String {
    "meta/muse-spark-1.2-contributor".into()
}
fn default_vod_duration_minutes() -> JsNumber {
    JsNumber(0.0)
}
fn default_cost_credits() -> JsNumber {
    JsNumber(0.0)
}
fn default_billing_status() -> Open<BillingStatusKind> {
    BillingStatusKind::Pending.into()
}
fn default_charge_error() -> Private<String> {
    Private::new(String::new())
}
fn default_billing_attempt_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_notification_status() -> Open<NotificationStatusKind> {
    NotificationStatusKind::NotRequired.into()
}
fn default_notification_payload_to() -> Private<Vec<Option<String>>> {
    Private::new(Vec::new())
}
fn default_notification_error() -> Private<String> {
    Private::new(String::new())
}
fn default_preview_cleanup_pending() -> bool {
    false
}
fn default_preview_cleanup_error() -> Private<String> {
    Private::new(String::new())
}
fn default_candidate_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_approved_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_error_message() -> Private<String> {
    Private::new(String::new())
}
fn default_candidates_reason() -> Private<String> {
    Private::new(String::new())
}
fn default_candidates_audio_confidence() -> JsNumber {
    JsNumber(0.0)
}
fn default_candidates_video_approved() -> bool {
    false
}
fn default_candidates_video_why() -> Private<String> {
    Private::new(String::new())
}
fn default_candidates_s3_key() -> Private<String> {
    Private::new(String::new())
}
fn default_candidates_preview_url() -> Private<String> {
    Private::new(String::new())
}
fn default_candidates_status() -> Open<CandidatesStatusKind> {
    CandidatesStatusKind::Pending.into()
}
fn default_candidates_twitch_clip_id() -> String {
    String::new()
}
fn default_candidates() -> Vec<Option<ClipRecommendationCandidates>> {
    Vec::new()
}
/// Collection name.
pub const COLLECTION: &str = "cliprecommendations";
/// Frozen schema.
static CLIP_RECOMMENDATION_NOTIFICATION_PAYLOAD: Schema = Schema::new(&[
    Field::string("from"),
    Field::array("to", ValueType::String).default(D::EmptyArray),
    Field::string("subject"),
    Field::string("html"),
    Field::string("text"),
])
.no_id()
.no_version_key();
/// Frozen schema.
static CLIP_RECOMMENDATION_CANDIDATES: Schema = Schema::new(&[
    Field::number("startSeconds"),
    Field::number("endSeconds"),
    Field::string("reason").default(D::Str("")),
    Field::number("audioConfidence").default(D::Int(0)),
    Field::boolean("videoApproved").default(D::Bool(false)),
    Field::string("videoWhy").default(D::Str("")),
    Field::string("s3Key").default(D::Str("")),
    Field::string("previewUrl").default(D::Str("")),
    Field::string("status").default(D::Str("pending")),
    Field::string("twitchClipID").default(D::Str("")),
    Field::date("created_at").default_fn(D::Now),
])
.no_version_key();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("")),
    Field::string("sessionID").default(D::Str("")),
    Field::string("streamID").default(D::Str("")),
    Field::string("vodID").default(D::Str("")),
    Field::string("vodUrl").default(D::Str("")),
    Field::string("source").default(D::Str("manual")),
    Field::string("status").default(D::Str("pending")),
    Field::string("requestedBy").default(D::Str("")),
    Field::string("queueJobID"),
    Field::string("modelID").default(D::Str("meta/muse-spark-1.2-contributor")),
    Field::number("vodDurationMinutes").default(D::Int(0)),
    Field::number("costCredits").default(D::Int(0)),
    Field::string("billingStatus").default(D::Str("pending")),
    Field::string("chargeError").default(D::Str("")),
    Field::date("chargedAt").default(D::Null),
    Field::date("analysisCompletedAt").default(D::Null),
    Field::number("billingAttemptCount").default(D::Int(0)),
    Field::date("billingLastAttemptAt").default(D::Null),
    Field::date("billingNextRetryAt").default(D::Null),
    Field::string("notificationStatus").default(D::Str("not_required")),
    Field::subdocument(
        "notificationPayload",
        &CLIP_RECOMMENDATION_NOTIFICATION_PAYLOAD,
    ),
    Field::string("notificationError").default(D::Str("")),
    Field::date("notificationLastAttemptAt").default(D::Null),
    Field::date("notificationNextRetryAt").default(D::Null),
    Field::date("notifiedAt").default(D::Null),
    Field::boolean("previewCleanupPending").default(D::Bool(false)),
    Field::string("previewCleanupError").default(D::Str("")),
    Field::date("previewCleanupNextRetryAt").default(D::Null),
    Field::number("candidateCount").default(D::Int(0)),
    Field::number("approvedCount").default(D::Int(0)),
    Field::string("errorMessage").default(D::Str("")),
    Field::document_array("candidates", &CLIP_RECOMMENDATION_CANDIDATES).default(D::EmptyArray),
    Field::date("startedAt").default(D::Null),
    Field::date("completedAt").default(D::Null),
])
.timestamps(Timestamps::SNAKE);
/// Hidden fields.
pub const HIDDEN: &[&str] = &["notificationPayload"];
/// Private fields.
pub const PRIVATE: &[&str] = &[
    "vodUrl",
    "notificationPayload",
    "chargeError",
    "notificationError",
    "previewCleanupError",
    "errorMessage",
    "candidates.$.reason",
    "candidates.$.videoWhy",
    "candidates.$.s3Key",
    "candidates.$.previewUrl",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("sessionID", 1)]),
    IndexSpec::on(&[("streamID", 1)]),
    IndexSpec::on(&[("source", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("billingStatus", 1)]),
    IndexSpec::on(&[("billingNextRetryAt", 1)]),
    IndexSpec::on(&[("notificationStatus", 1)]),
    IndexSpec::on(&[("notificationNextRetryAt", 1)]),
    IndexSpec::on(&[("previewCleanupPending", 1)]),
    IndexSpec::on(&[("candidates.status", 1)]),
    IndexSpec::on(&[("channelID", 1), ("created_at", -1)]),
    IndexSpec::on(&[("channelID", 1), ("sessionID", 1), ("source", 1)]),
    IndexSpec::on(&[("status", 1), ("created_at", 1)]),
    IndexSpec::on(&[("queueJobID", 1)]).unique().sparse(),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("vodUrl"),
    Rule::required("source"),
    Rule::one_of("source", SourceKind::STRINGS),
    Rule::one_of("status", StatusKind::STRINGS),
    Rule::one_of("billingStatus", BillingStatusKind::STRINGS),
    Rule::one_of("notificationStatus", NotificationStatusKind::STRINGS),
    Rule::required("notificationPayload.from"),
    Rule::required("notificationPayload.to"),
    Rule::required("notificationPayload.subject"),
    Rule::required("notificationPayload.html"),
    Rule::required("notificationPayload.text"),
    Rule::required("candidates.$.startSeconds"),
    Rule::min("candidates.$.startSeconds", 0.0),
    Rule::required("candidates.$.endSeconds"),
    Rule::min("candidates.$.endSeconds", 0.0),
    Rule::required("candidates.$.reason"),
    Rule::min("candidates.$.audioConfidence", 0.0),
    Rule::max("candidates.$.audioConfidence", 1.0),
    Rule::one_of("candidates.$.status", CandidatesStatusKind::STRINGS),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("candidates.$._id"),
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::not_null("sessionID"),
    ReadNeed::not_null("streamID"),
    ReadNeed::not_null("vodID"),
    ReadNeed::not_null("vodUrl"),
    ReadNeed::not_null("source"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("requestedBy"),
    ReadNeed::not_null("modelID"),
    ReadNeed::not_null("vodDurationMinutes"),
    ReadNeed::not_null("costCredits"),
    ReadNeed::not_null("billingStatus"),
    ReadNeed::not_null("chargeError"),
    ReadNeed::not_null("billingAttemptCount"),
    ReadNeed::not_null("notificationStatus"),
    ReadNeed::value("notificationPayload.from"),
    ReadNeed::not_null("notificationPayload.to"),
    ReadNeed::value("notificationPayload.subject"),
    ReadNeed::value("notificationPayload.html"),
    ReadNeed::value("notificationPayload.text"),
    ReadNeed::not_null("notificationError"),
    ReadNeed::not_null("previewCleanupPending"),
    ReadNeed::not_null("previewCleanupError"),
    ReadNeed::not_null("candidateCount"),
    ReadNeed::not_null("approvedCount"),
    ReadNeed::not_null("errorMessage"),
    ReadNeed::value("candidates.$.startSeconds"),
    ReadNeed::value("candidates.$.endSeconds"),
    ReadNeed::not_null("candidates.$.reason"),
    ReadNeed::not_null("candidates.$.audioConfidence"),
    ReadNeed::not_null("candidates.$.videoApproved"),
    ReadNeed::not_null("candidates.$.videoWhy"),
    ReadNeed::not_null("candidates.$.s3Key"),
    ReadNeed::not_null("candidates.$.previewUrl"),
    ReadNeed::not_null("candidates.$.status"),
    ReadNeed::not_null("candidates.$.twitchClipID"),
    ReadNeed::not_null("candidates"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ClipRecommendation",
    source: "dimabot/src/schemas/clip_recommendation.schema.ts",
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
    decode: decode_boxed::<ClipRecommendation>,
};
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ClipRecommendationNotificationPayload {
    /// `notificationPayload.from`.
    #[serde(rename = "from")]
    pub from: Private<String>,
    /// `notificationPayload.to`.
    #[serde(rename = "to", default = "default_notification_payload_to")]
    pub to: Private<Vec<Option<String>>>,
    /// `notificationPayload.subject`.
    #[serde(rename = "subject")]
    pub subject: Private<String>,
    /// `notificationPayload.html`.
    #[serde(rename = "html")]
    pub html: Private<String>,
    /// `notificationPayload.text`.
    #[serde(rename = "text")]
    pub text: Private<String>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewClipRecommendationNotificationPayload {
    /// `notificationPayload.from`.
    #[serde(rename = "from")]
    pub from: Private<String>,
    /// `notificationPayload.to`.
    #[serde(rename = "to")]
    pub to: Private<Vec<Option<String>>>,
    /// `notificationPayload.subject`.
    #[serde(rename = "subject")]
    pub subject: Private<String>,
    /// `notificationPayload.html`.
    #[serde(rename = "html")]
    pub html: Private<String>,
    /// `notificationPayload.text`.
    #[serde(rename = "text")]
    pub text: Private<String>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ClipRecommendationCandidates {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `candidates.$.startSeconds`.
    #[serde(rename = "startSeconds")]
    pub start_seconds: JsNumber,
    /// `candidates.$.endSeconds`.
    #[serde(rename = "endSeconds")]
    pub end_seconds: JsNumber,
    /// `candidates.$.reason`.
    #[serde(rename = "reason", default = "default_candidates_reason")]
    pub reason: Private<String>,
    /// `candidates.$.audioConfidence`.
    #[serde(
        rename = "audioConfidence",
        default = "default_candidates_audio_confidence"
    )]
    pub audio_confidence: JsNumber,
    /// `candidates.$.videoApproved`.
    #[serde(
        rename = "videoApproved",
        default = "default_candidates_video_approved"
    )]
    pub video_approved: bool,
    /// `candidates.$.videoWhy`.
    #[serde(rename = "videoWhy", default = "default_candidates_video_why")]
    pub video_why: Private<String>,
    /// `candidates.$.s3Key`.
    #[serde(rename = "s3Key", default = "default_candidates_s3_key")]
    pub s3_key: Private<String>,
    /// `candidates.$.previewUrl`.
    #[serde(rename = "previewUrl", default = "default_candidates_preview_url")]
    pub preview_url: Private<String>,
    /// `candidates.$.status`.
    #[serde(rename = "status", default = "default_candidates_status")]
    pub status: Open<CandidatesStatusKind>,
    /// `candidates.$.twitchClipID`.
    #[serde(rename = "twitchClipID", default = "default_candidates_twitch_clip_id")]
    pub twitch_clip_id: String,
    /// `candidates.$.created_at`.
    #[serde(rename = "created_at", default)]
    pub created_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewClipRecommendationCandidates {
    /// `candidates.$.startSeconds`.
    #[serde(rename = "startSeconds")]
    pub start_seconds: JsNumber,
    /// `candidates.$.endSeconds`.
    #[serde(rename = "endSeconds")]
    pub end_seconds: JsNumber,
    /// `candidates.$.reason`.
    #[serde(rename = "reason")]
    pub reason: Private<String>,
    /// `candidates.$.audioConfidence`.
    #[serde(rename = "audioConfidence", skip_serializing_if = "Option::is_none")]
    pub audio_confidence: Option<JsNumber>,
    /// `candidates.$.videoApproved`.
    #[serde(rename = "videoApproved", skip_serializing_if = "Option::is_none")]
    pub video_approved: Option<bool>,
    /// `candidates.$.videoWhy`.
    #[serde(rename = "videoWhy", skip_serializing_if = "Option::is_none")]
    pub video_why: Option<Private<String>>,
    /// `candidates.$.s3Key`.
    #[serde(rename = "s3Key", skip_serializing_if = "Option::is_none")]
    pub s3_key: Option<Private<String>>,
    /// `candidates.$.previewUrl`.
    #[serde(rename = "previewUrl", skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<Private<String>>,
    /// `candidates.$.status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<CandidatesStatusKind>,
    /// `candidates.$.twitchClipID`.
    #[serde(rename = "twitchClipID", skip_serializing_if = "Option::is_none")]
    pub twitch_clip_id: Option<String>,
    /// `candidates.$.created_at`.
    #[serde(rename = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ClipRecommendation {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", default = "default_channel")]
    pub channel: String,
    /// `sessionID`.
    #[serde(rename = "sessionID", default = "default_session_id")]
    pub session_id: String,
    /// `streamID`.
    #[serde(rename = "streamID", default = "default_stream_id")]
    pub stream_id: String,
    /// `vodID`.
    #[serde(rename = "vodID", default = "default_vod_id")]
    pub vod_id: String,
    /// `vodUrl`.
    #[serde(rename = "vodUrl", default = "default_vod_url")]
    pub vod_url: Private<String>,
    /// `source`.
    #[serde(rename = "source", default = "default_source")]
    pub source: Open<SourceKind>,
    /// `status`.
    #[serde(rename = "status", default = "default_status")]
    pub status: Open<StatusKind>,
    /// `requestedBy`.
    #[serde(rename = "requestedBy", default = "default_requested_by")]
    pub requested_by: String,
    /// `queueJobID`.
    #[serde(rename = "queueJobID", default)]
    pub queue_job_id: Option<String>,
    /// `modelID`.
    #[serde(rename = "modelID", default = "default_model_id")]
    pub model_id: String,
    /// `vodDurationMinutes`.
    #[serde(
        rename = "vodDurationMinutes",
        default = "default_vod_duration_minutes"
    )]
    pub vod_duration_minutes: JsNumber,
    /// `costCredits`.
    #[serde(rename = "costCredits", default = "default_cost_credits")]
    pub cost_credits: JsNumber,
    /// `billingStatus`.
    #[serde(rename = "billingStatus", default = "default_billing_status")]
    pub billing_status: Open<BillingStatusKind>,
    /// `chargeError`.
    #[serde(rename = "chargeError", default = "default_charge_error")]
    pub charge_error: Private<String>,
    /// `chargedAt`.
    #[serde(rename = "chargedAt", default)]
    pub charged_at: Option<JsDate>,
    /// `analysisCompletedAt`.
    #[serde(rename = "analysisCompletedAt", default)]
    pub analysis_completed_at: Option<JsDate>,
    /// `billingAttemptCount`.
    #[serde(
        rename = "billingAttemptCount",
        default = "default_billing_attempt_count"
    )]
    pub billing_attempt_count: JsNumber,
    /// `billingLastAttemptAt`.
    #[serde(rename = "billingLastAttemptAt", default)]
    pub billing_last_attempt_at: Option<JsDate>,
    /// `billingNextRetryAt`.
    #[serde(rename = "billingNextRetryAt", default)]
    pub billing_next_retry_at: Option<JsDate>,
    /// `notificationStatus`.
    #[serde(rename = "notificationStatus", default = "default_notification_status")]
    pub notification_status: Open<NotificationStatusKind>,
    /// `notificationPayload`.
    #[serde(rename = "notificationPayload", default)]
    pub notification_payload: Option<Private<ClipRecommendationNotificationPayload>>,
    /// `notificationError`.
    #[serde(rename = "notificationError", default = "default_notification_error")]
    pub notification_error: Private<String>,
    /// `notificationLastAttemptAt`.
    #[serde(rename = "notificationLastAttemptAt", default)]
    pub notification_last_attempt_at: Option<JsDate>,
    /// `notificationNextRetryAt`.
    #[serde(rename = "notificationNextRetryAt", default)]
    pub notification_next_retry_at: Option<JsDate>,
    /// `notifiedAt`.
    #[serde(rename = "notifiedAt", default)]
    pub notified_at: Option<JsDate>,
    /// `previewCleanupPending`.
    #[serde(
        rename = "previewCleanupPending",
        default = "default_preview_cleanup_pending"
    )]
    pub preview_cleanup_pending: bool,
    /// `previewCleanupError`.
    #[serde(
        rename = "previewCleanupError",
        default = "default_preview_cleanup_error"
    )]
    pub preview_cleanup_error: Private<String>,
    /// `previewCleanupNextRetryAt`.
    #[serde(rename = "previewCleanupNextRetryAt", default)]
    pub preview_cleanup_next_retry_at: Option<JsDate>,
    /// `candidateCount`.
    #[serde(rename = "candidateCount", default = "default_candidate_count")]
    pub candidate_count: JsNumber,
    /// `approvedCount`.
    #[serde(rename = "approvedCount", default = "default_approved_count")]
    pub approved_count: JsNumber,
    /// `errorMessage`.
    #[serde(rename = "errorMessage", default = "default_error_message")]
    pub error_message: Private<String>,
    /// `candidates`.
    #[serde(rename = "candidates", default = "default_candidates")]
    pub candidates: Vec<Option<ClipRecommendationCandidates>>,
    /// `startedAt`.
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<JsDate>,
    /// `completedAt`.
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<JsDate>,
    /// `created_at`.
    pub created_at: Option<JsDate>,
    /// `updated_at`.
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewClipRecommendation {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// `sessionID`.
    #[serde(rename = "sessionID", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `streamID`.
    #[serde(rename = "streamID", skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    /// `vodID`.
    #[serde(rename = "vodID", skip_serializing_if = "Option::is_none")]
    pub vod_id: Option<String>,
    /// `vodUrl`.
    #[serde(rename = "vodUrl")]
    pub vod_url: Private<String>,
    /// `source`.
    #[serde(rename = "source")]
    pub source: SourceKind,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusKind>,
    /// `requestedBy`.
    #[serde(rename = "requestedBy", skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// `queueJobID`.
    #[serde(rename = "queueJobID", skip_serializing_if = "Option::is_none")]
    pub queue_job_id: Option<String>,
    /// `modelID`.
    #[serde(rename = "modelID", skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// `vodDurationMinutes`.
    #[serde(rename = "vodDurationMinutes", skip_serializing_if = "Option::is_none")]
    pub vod_duration_minutes: Option<JsNumber>,
    /// `costCredits`.
    #[serde(rename = "costCredits", skip_serializing_if = "Option::is_none")]
    pub cost_credits: Option<JsNumber>,
    /// `billingStatus`.
    #[serde(rename = "billingStatus", skip_serializing_if = "Option::is_none")]
    pub billing_status: Option<BillingStatusKind>,
    /// `chargeError`.
    #[serde(rename = "chargeError", skip_serializing_if = "Option::is_none")]
    pub charge_error: Option<Private<String>>,
    /// `chargedAt`.
    #[serde(rename = "chargedAt", skip_serializing_if = "Nullable::is_unset")]
    pub charged_at: Nullable<JsDate>,
    /// `analysisCompletedAt`.
    #[serde(
        rename = "analysisCompletedAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub analysis_completed_at: Nullable<JsDate>,
    /// `billingAttemptCount`.
    #[serde(
        rename = "billingAttemptCount",
        skip_serializing_if = "Option::is_none"
    )]
    pub billing_attempt_count: Option<JsNumber>,
    /// `billingLastAttemptAt`.
    #[serde(
        rename = "billingLastAttemptAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub billing_last_attempt_at: Nullable<JsDate>,
    /// `billingNextRetryAt`.
    #[serde(
        rename = "billingNextRetryAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub billing_next_retry_at: Nullable<JsDate>,
    /// `notificationStatus`.
    #[serde(rename = "notificationStatus", skip_serializing_if = "Option::is_none")]
    pub notification_status: Option<NotificationStatusKind>,
    /// `notificationPayload`.
    #[serde(
        rename = "notificationPayload",
        skip_serializing_if = "Option::is_none"
    )]
    pub notification_payload: Option<Private<NewClipRecommendationNotificationPayload>>,
    /// `notificationError`.
    #[serde(rename = "notificationError", skip_serializing_if = "Option::is_none")]
    pub notification_error: Option<Private<String>>,
    /// `notificationLastAttemptAt`.
    #[serde(
        rename = "notificationLastAttemptAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub notification_last_attempt_at: Nullable<JsDate>,
    /// `notificationNextRetryAt`.
    #[serde(
        rename = "notificationNextRetryAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub notification_next_retry_at: Nullable<JsDate>,
    /// `notifiedAt`.
    #[serde(rename = "notifiedAt", skip_serializing_if = "Nullable::is_unset")]
    pub notified_at: Nullable<JsDate>,
    /// `previewCleanupPending`.
    #[serde(
        rename = "previewCleanupPending",
        skip_serializing_if = "Option::is_none"
    )]
    pub preview_cleanup_pending: Option<bool>,
    /// `previewCleanupError`.
    #[serde(
        rename = "previewCleanupError",
        skip_serializing_if = "Option::is_none"
    )]
    pub preview_cleanup_error: Option<Private<String>>,
    /// `previewCleanupNextRetryAt`.
    #[serde(
        rename = "previewCleanupNextRetryAt",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub preview_cleanup_next_retry_at: Nullable<JsDate>,
    /// `candidateCount`.
    #[serde(rename = "candidateCount", skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<JsNumber>,
    /// `approvedCount`.
    #[serde(rename = "approvedCount", skip_serializing_if = "Option::is_none")]
    pub approved_count: Option<JsNumber>,
    /// `errorMessage`.
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    pub error_message: Option<Private<String>>,
    /// `candidates`.
    #[serde(rename = "candidates", skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Option<NewClipRecommendationCandidates>>>,
    /// `startedAt`.
    #[serde(rename = "startedAt", skip_serializing_if = "Nullable::is_unset")]
    pub started_at: Nullable<JsDate>,
    /// `completedAt`.
    #[serde(rename = "completedAt", skip_serializing_if = "Nullable::is_unset")]
    pub completed_at: Nullable<JsDate>,
}
impl NewClipRecommendation {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

impl NewClipRecommendationCandidates {
    /// Check the schema's nonnegative seconds and confidence range before creating a candidate.
    pub fn new(
        start: f64,
        end: f64,
        reason: impl Into<String>,
        confidence: Option<f64>,
    ) -> Result<Self, crate::ValidationError> {
        let reason = reason.into();
        let mut candidate = bson::doc! {
            "startSeconds": dima_store::mongo::number::js_number(start),
            "endSeconds": dima_store::mongo::number::js_number(end),
            "reason": reason.clone(),
        };
        if let Some(confidence) = confidence {
            candidate.insert(
                "audioConfidence",
                dima_store::mongo::number::js_number(confidence),
            );
        }
        INFO.validate(&bson::doc! { "channelID":"candidate", "vodUrl":"candidate", "source":"manual", "candidates":[candidate] })?;
        Ok(Self {
            start_seconds: JsNumber(start),
            end_seconds: JsNumber(end),
            reason: Private::new(reason),
            audio_confidence: confidence.map(JsNumber),
            video_approved: None,
            video_why: None,
            s3_key: None,
            preview_url: None,
            status: None,
            twitch_clip_id: None,
            created_at: None,
        })
    }
}
