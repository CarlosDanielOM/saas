//! `raid_moderation_requests`: reference `dimabot/src/schemas/raid_session.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/raid_sessions.ts requestRaidBans and processRaidModerationRequests construct admission and lease updates. Routes validate request parameters; no unchecked body copy. Empty census. No timestamps or __v; TTL purgeAt. leaseToken is private.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
fn default_user_id() -> String {
    "".into()
}
str_enum! { /// `origin`.
pub enum OriginKind {/// `history`.
History = "history",/// `live`.
Live = "live"} }
fn default_origin() -> Open<OriginKind> {
    OriginKind::History.into()
}
fn default_include_future() -> bool {
    false
}
str_enum! { /// `status`.
pub enum StatusKind {/// `authorizing`.
Authorizing = "authorizing",/// `pending`.
Pending = "pending",/// `active`.
Active = "active",/// `completed`.
Completed = "completed",/// `cancelled`.
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
fn default_next_attempt_at() -> JsDate {
    JsDate(0)
}
/// Collection name.
pub const COLLECTION: &str = "raid_moderation_requests";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("sessionID"),
    Field::string("actorID"),
    Field::string("userID").default(D::Str("")),
    Field::string("origin").default(D::Str("history")),
    Field::boolean("includeFuture").default(D::Bool(false)),
    Field::date("requestedAt"),
    Field::date("expiresAt"),
    Field::date("purgeAt"),
    Field::string("status").default(D::Str("pending")),
    Field::date("lockedUntil").default_fn(D::DateMs(0)),
    Field::string("leaseToken").default(D::Str("")),
    Field::date("nextAttemptAt").default_fn(D::DateMs(0)),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["leaseToken"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("status", 1), ("nextAttemptAt", 1)]),
    IndexSpec::on(&[("purgeAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("sessionID"),
    Rule::required("actorID"),
    Rule::one_of("origin", OriginKind::STRINGS),
    Rule::required("requestedAt"),
    Rule::required("expiresAt"),
    Rule::required("purgeAt"),
    Rule::one_of("status", StatusKind::STRINGS),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("sessionID"),
    ReadNeed::value("actorID"),
    ReadNeed::not_null("userID"),
    ReadNeed::not_null("origin"),
    ReadNeed::not_null("includeFuture"),
    ReadNeed::value("requestedAt"),
    ReadNeed::value("expiresAt"),
    ReadNeed::value("purgeAt"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("lockedUntil"),
    ReadNeed::not_null("leaseToken"),
    ReadNeed::not_null("nextAttemptAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_moderation_request",
    source: "dimabot/src/schemas/raid_session.schema.ts",
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
    decode: decode_boxed::<RaidModerationRequest>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidModerationRequest {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `sessionID`.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// `actorID`.
    #[serde(rename = "actorID")]
    pub actor_id: String,
    /// `userID`.
    #[serde(rename = "userID", default = "default_user_id")]
    pub user_id: String,
    /// `origin`.
    #[serde(rename = "origin", default = "default_origin")]
    pub origin: Open<OriginKind>,
    /// `includeFuture`.
    #[serde(rename = "includeFuture", default = "default_include_future")]
    pub include_future: bool,
    /// `requestedAt`.
    #[serde(rename = "requestedAt")]
    pub requested_at: JsDate,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `status`.
    #[serde(rename = "status", default = "default_status")]
    pub status: Open<StatusKind>,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", default = "default_locked_until")]
    pub locked_until: JsDate,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", default = "default_lease_token")]
    pub lease_token: Private<String>,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt", default = "default_next_attempt_at")]
    pub next_attempt_at: JsDate,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidModerationRequest {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `sessionID`.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// `actorID`.
    #[serde(rename = "actorID")]
    pub actor_id: String,
    /// `userID`.
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// `origin`.
    #[serde(rename = "origin", skip_serializing_if = "Option::is_none")]
    pub origin: Option<OriginKind>,
    /// `includeFuture`.
    #[serde(rename = "includeFuture", skip_serializing_if = "Option::is_none")]
    pub include_future: Option<bool>,
    /// `requestedAt`.
    #[serde(rename = "requestedAt")]
    pub requested_at: JsDate,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusKind>,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<JsDate>,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<Private<String>>,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt", skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<JsDate>,
}
impl NewRaidModerationRequest {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
