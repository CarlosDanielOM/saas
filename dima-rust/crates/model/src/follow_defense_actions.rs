//! `follow_defense_actions`: reference `dimabot/src/schemas/follow_defense_action.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/follow_defense_actions.ts enqueueFollowDefenseBan/enqueueRaidSessionBan and executor build all values. The implicit unique string _id is the durable action idempotency key; no separately declared unique index. No __v; camel-case timestamps. Lease token and error details are private. Empty census.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
str_enum! { /// `kind`.
pub enum KindKind {/// `ban`.
Ban = "ban",/// `announcement`.
Announcement = "announcement"} }
fn default_follower_id() -> String {
    "".into()
}
str_enum! { /// `authorization`.
pub enum AuthorizationKind {/// `automatic`.
Automatic = "automatic",/// `manual`.
Manual = "manual"} }
fn default_authorization() -> Open<AuthorizationKind> {
    AuthorizationKind::Automatic.into()
}
fn default_raid_session_id() -> String {
    "".into()
}
fn default_raid_follower_id() -> String {
    "".into()
}
fn default_raid_request_id() -> String {
    "".into()
}
fn default_reason() -> Private<String> {
    Private::new("".into())
}
fn default_message() -> Private<String> {
    Private::new("".into())
}
str_enum! { /// `mode`.
pub enum ModeKind {/// `protection`.
Protection = "protection",/// `attack`.
Attack = "attack"} }
str_enum! { /// `status`.
pub enum StatusKind {/// `pending`.
Pending = "pending",/// `processing`.
Processing = "processing",/// `succeeded`.
Succeeded = "succeeded",/// `failed`.
Failed = "failed",/// `cancelled`.
Cancelled = "cancelled",/// `expired`.
Expired = "expired"} }
fn default_status() -> Open<StatusKind> {
    StatusKind::Pending.into()
}
fn default_locked_until() -> JsDate {
    JsDate(0)
}
fn default_lease_token() -> Private<String> {
    Private::new("".into())
}
fn default_attempts() -> JsNumber {
    JsNumber(0.0)
}
fn default_failures() -> JsNumber {
    JsNumber(0.0)
}
fn default_last_status() -> JsNumber {
    JsNumber(0.0)
}
fn default_last_message() -> Private<String> {
    Private::new("".into())
}
fn default_audit_pending() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "follow_defense_actions";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("eventID"),
    Field::string("kind"),
    Field::string("followerID").default(D::Str("")),
    Field::string("authorization").default(D::Str("automatic")),
    Field::string("raidSessionID").default(D::Str("")),
    Field::string("raidFollowerID").default(D::Str("")),
    Field::string("raidRequestID").default(D::Str("")),
    Field::string("reason").default(D::Str("")),
    Field::string("message").default(D::Str("")),
    Field::string("mode"),
    Field::date("authorizedAt"),
    Field::date("followedAt"),
    Field::string("status").default(D::Str("pending")),
    Field::date("nextAttemptAt"),
    Field::date("lockedUntil").default_fn(D::DateMs(0)),
    Field::string("leaseToken").default(D::Str("")),
    Field::number("attempts").default(D::Int(0)),
    Field::number("failures").default(D::Int(0)),
    Field::number("lastStatus").default(D::Int(0)),
    Field::string("lastMessage").default(D::Str("")),
    Field::date("completedAt").default(D::Null),
    Field::date("expiresAt"),
    Field::date("purgeAt"),
    Field::boolean("auditPending").default(D::Bool(false)),
])
.declared_id()
.no_version_key()
.timestamps(Timestamps::CAMEL);
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["leaseToken", "lastMessage", "reason", "message"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[
        ("channelID", 1),
        ("status", 1),
        ("nextAttemptAt", 1),
        ("createdAt", 1),
    ]),
    IndexSpec::on(&[("status", 1), ("expiresAt", 1)]),
    IndexSpec::on(&[("auditPending", 1)]),
    IndexSpec::on(&[("raidSessionID", 1), ("followerID", 1), ("status", 1)]),
    IndexSpec::on(&[("purgeAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("eventID"),
    Rule::required("kind"),
    Rule::one_of("kind", KindKind::STRINGS),
    Rule::one_of("authorization", AuthorizationKind::STRINGS),
    Rule::required("mode"),
    Rule::one_of("mode", ModeKind::STRINGS),
    Rule::required("authorizedAt"),
    Rule::required("status"),
    Rule::one_of("status", StatusKind::STRINGS),
    Rule::required("nextAttemptAt"),
    Rule::required("expiresAt"),
    Rule::required("purgeAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("eventID"),
    ReadNeed::value("kind"),
    ReadNeed::not_null("followerID"),
    ReadNeed::not_null("authorization"),
    ReadNeed::not_null("raidSessionID"),
    ReadNeed::not_null("raidFollowerID"),
    ReadNeed::not_null("raidRequestID"),
    ReadNeed::not_null("reason"),
    ReadNeed::not_null("message"),
    ReadNeed::value("mode"),
    ReadNeed::value("authorizedAt"),
    ReadNeed::not_null("status"),
    ReadNeed::value("nextAttemptAt"),
    ReadNeed::not_null("lockedUntil"),
    ReadNeed::not_null("leaseToken"),
    ReadNeed::not_null("attempts"),
    ReadNeed::not_null("failures"),
    ReadNeed::not_null("lastStatus"),
    ReadNeed::not_null("lastMessage"),
    ReadNeed::value("expiresAt"),
    ReadNeed::value("purgeAt"),
    ReadNeed::not_null("auditPending"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_defense_action",
    source: "dimabot/src/schemas/follow_defense_action.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<FollowDefenseAction>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowDefenseAction {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: Open<KindKind>,
    /// `followerID`.
    #[serde(rename = "followerID", default = "default_follower_id")]
    pub follower_id: String,
    /// `authorization`.
    #[serde(rename = "authorization", default = "default_authorization")]
    pub authorization: Open<AuthorizationKind>,
    /// `raidSessionID`.
    #[serde(rename = "raidSessionID", default = "default_raid_session_id")]
    pub raid_session_id: String,
    /// `raidFollowerID`.
    #[serde(rename = "raidFollowerID", default = "default_raid_follower_id")]
    pub raid_follower_id: String,
    /// `raidRequestID`.
    #[serde(rename = "raidRequestID", default = "default_raid_request_id")]
    pub raid_request_id: String,
    /// `reason`.
    #[serde(rename = "reason", default = "default_reason")]
    pub reason: Private<String>,
    /// `message`.
    #[serde(rename = "message", default = "default_message")]
    pub message: Private<String>,
    /// `mode`.
    #[serde(rename = "mode")]
    pub mode: Open<ModeKind>,
    /// `authorizedAt`.
    #[serde(rename = "authorizedAt")]
    pub authorized_at: JsDate,
    /// `followedAt`.
    #[serde(rename = "followedAt", default)]
    pub followed_at: Option<JsDate>,
    /// `status`.
    #[serde(rename = "status", default = "default_status")]
    pub status: Open<StatusKind>,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", default = "default_locked_until")]
    pub locked_until: JsDate,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", default = "default_lease_token")]
    pub lease_token: Private<String>,
    /// `attempts`.
    #[serde(rename = "attempts", default = "default_attempts")]
    pub attempts: JsNumber,
    /// `failures`.
    #[serde(rename = "failures", default = "default_failures")]
    pub failures: JsNumber,
    /// `lastStatus`.
    #[serde(rename = "lastStatus", default = "default_last_status")]
    pub last_status: JsNumber,
    /// `lastMessage`.
    #[serde(rename = "lastMessage", default = "default_last_message")]
    pub last_message: Private<String>,
    /// `completedAt`.
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `auditPending`.
    #[serde(rename = "auditPending", default = "default_audit_pending")]
    pub audit_pending: bool,
    /// `createdAt`.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowDefenseAction {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: KindKind,
    /// `followerID`.
    #[serde(rename = "followerID", skip_serializing_if = "Option::is_none")]
    pub follower_id: Option<String>,
    /// `authorization`.
    #[serde(rename = "authorization", skip_serializing_if = "Option::is_none")]
    pub authorization: Option<AuthorizationKind>,
    /// `raidSessionID`.
    #[serde(rename = "raidSessionID", skip_serializing_if = "Option::is_none")]
    pub raid_session_id: Option<String>,
    /// `raidFollowerID`.
    #[serde(rename = "raidFollowerID", skip_serializing_if = "Option::is_none")]
    pub raid_follower_id: Option<String>,
    /// `raidRequestID`.
    #[serde(rename = "raidRequestID", skip_serializing_if = "Option::is_none")]
    pub raid_request_id: Option<String>,
    /// `reason`.
    #[serde(rename = "reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<Private<String>>,
    /// `message`.
    #[serde(rename = "message", skip_serializing_if = "Option::is_none")]
    pub message: Option<Private<String>>,
    /// `mode`.
    #[serde(rename = "mode")]
    pub mode: ModeKind,
    /// `authorizedAt`.
    #[serde(rename = "authorizedAt")]
    pub authorized_at: JsDate,
    /// `followedAt`.
    #[serde(rename = "followedAt", skip_serializing_if = "Option::is_none")]
    pub followed_at: Option<JsDate>,
    /// `status`.
    #[serde(rename = "status")]
    pub status: StatusKind,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<JsDate>,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<Private<String>>,
    /// `attempts`.
    #[serde(rename = "attempts", skip_serializing_if = "Option::is_none")]
    pub attempts: Option<JsNumber>,
    /// `failures`.
    #[serde(rename = "failures", skip_serializing_if = "Option::is_none")]
    pub failures: Option<JsNumber>,
    /// `lastStatus`.
    #[serde(rename = "lastStatus", skip_serializing_if = "Option::is_none")]
    pub last_status: Option<JsNumber>,
    /// `lastMessage`.
    #[serde(rename = "lastMessage", skip_serializing_if = "Option::is_none")]
    pub last_message: Option<Private<String>>,
    /// `completedAt`.
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `auditPending`.
    #[serde(rename = "auditPending", skip_serializing_if = "Option::is_none")]
    pub audit_pending: Option<bool>,
}
impl NewFollowDefenseAction {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
