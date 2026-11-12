//! `raid_followers`: reference `dimabot/src/schemas/raid_session.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/raid_sessions.ts recordRaidFollow constructs event fields and dates; processRaidModerationRequests maintains receipt arrays. No direct body copy. No timestamps or __v; recordedAt Date.now is not invented on read. TTL purgeAt.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
fn default_login() -> String {
    "".into()
}
fn default_name() -> String {
    "".into()
}
fn default_queued_request_i_ds() -> Vec<String> {
    Vec::new()
}
fn default_eligible_request_i_ds() -> Vec<String> {
    Vec::new()
}
/// Collection name.
pub const COLLECTION: &str = "raid_followers";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("sessionID"),
    Field::string("eventID"),
    Field::string("userID"),
    Field::string("login").default(D::Str("")),
    Field::string("name").default(D::Str("")),
    Field::date("followedAt"),
    Field::date("recordedAt").default_fn(D::Now),
    Field::array("queuedRequestIDs", ValueType::String).default(D::EmptyArray),
    Field::array("eligibleRequestIDs", ValueType::String).default(D::EmptyArray),
    Field::date("purgeAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("sessionID", 1), ("followedAt", 1), ("_id", 1)]),
    IndexSpec::on(&[("channelID", 1), ("followedAt", 1)]),
    IndexSpec::on(&[("sessionID", 1), ("userID", 1)]),
    IndexSpec::on(&[("purgeAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("sessionID"),
    Rule::required("eventID"),
    Rule::required("userID"),
    Rule::required("followedAt"),
    Rule::required("purgeAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("sessionID"),
    ReadNeed::value("eventID"),
    ReadNeed::value("userID"),
    ReadNeed::not_null("login"),
    ReadNeed::not_null("name"),
    ReadNeed::value("followedAt"),
    ReadNeed::not_null("queuedRequestIDs"),
    ReadNeed::not_null("eligibleRequestIDs"),
    ReadNeed::value("purgeAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_follower",
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
    decode: decode_boxed::<RaidFollower>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidFollower {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `sessionID`.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `login`.
    #[serde(rename = "login", default = "default_login")]
    pub login: String,
    /// `name`.
    #[serde(rename = "name", default = "default_name")]
    pub name: String,
    /// `followedAt`.
    #[serde(rename = "followedAt")]
    pub followed_at: JsDate,
    /// `recordedAt`.
    #[serde(rename = "recordedAt", default)]
    pub recorded_at: Option<JsDate>,
    /// `queuedRequestIDs`.
    #[serde(rename = "queuedRequestIDs", default = "default_queued_request_i_ds")]
    pub queued_request_i_ds: Vec<String>,
    /// `eligibleRequestIDs`.
    #[serde(
        rename = "eligibleRequestIDs",
        default = "default_eligible_request_i_ds"
    )]
    pub eligible_request_i_ds: Vec<String>,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidFollower {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `sessionID`.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `login`.
    #[serde(rename = "login", skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// `name`.
    #[serde(rename = "name", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `followedAt`.
    #[serde(rename = "followedAt")]
    pub followed_at: JsDate,
    /// `recordedAt`.
    #[serde(rename = "recordedAt", skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<JsDate>,
    /// `queuedRequestIDs`.
    #[serde(rename = "queuedRequestIDs", skip_serializing_if = "Option::is_none")]
    pub queued_request_i_ds: Option<Vec<String>>,
    /// `eligibleRequestIDs`.
    #[serde(rename = "eligibleRequestIDs", skip_serializing_if = "Option::is_none")]
    pub eligible_request_i_ds: Option<Vec<String>>,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
}
impl NewRaidFollower {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
