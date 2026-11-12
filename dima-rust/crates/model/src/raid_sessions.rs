//! `raid_sessions`: reference `dimabot/src/schemas/raid_session.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/raid_sessions.ts recordRaidSession and recordRaidFollow construct event fields and dates. No direct body copy. Legacy endedAt null; optional cursor/progress fields use schema defaults. No timestamps or __v; TTL purgeAt.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_raider_login() -> String {
    "".into()
}
fn default_raider_name() -> String {
    "".into()
}
fn default_viewers() -> JsNumber {
    JsNumber(0.0)
}
fn default_backfill_cursor() -> String {
    "".into()
}
fn default_backfill_done() -> bool {
    false
}
fn default_manual_request_id() -> String {
    "".into()
}
/// Collection name.
pub const COLLECTION: &str = "raid_sessions";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("eventID"),
    Field::string("raiderID"),
    Field::string("raiderLogin").default(D::Str("")),
    Field::string("raiderName").default(D::Str("")),
    Field::number("viewers").default(D::Int(0)),
    Field::date("startedAt"),
    Field::date("endedAt").default(D::Null),
    Field::date("captureUntil"),
    Field::number("retentionHours"),
    Field::date("expiresAt"),
    Field::date("purgeAt"),
    Field::date("backfillUntil"),
    Field::string("backfillCursor").default(D::Str("")),
    Field::boolean("backfillDone").default(D::Bool(false)),
    Field::string("manualRequestID").default(D::Str("")),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("startedAt", -1)]),
    IndexSpec::on(&[("purgeAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("eventID"),
    Rule::required("raiderID"),
    Rule::required("startedAt"),
    Rule::required("captureUntil"),
    Rule::required("retentionHours"),
    Rule::required("expiresAt"),
    Rule::required("purgeAt"),
    Rule::required("backfillUntil"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("eventID"),
    ReadNeed::value("raiderID"),
    ReadNeed::not_null("raiderLogin"),
    ReadNeed::not_null("raiderName"),
    ReadNeed::not_null("viewers"),
    ReadNeed::value("startedAt"),
    ReadNeed::value("captureUntil"),
    ReadNeed::value("retentionHours"),
    ReadNeed::value("expiresAt"),
    ReadNeed::value("purgeAt"),
    ReadNeed::value("backfillUntil"),
    ReadNeed::not_null("backfillCursor"),
    ReadNeed::not_null("backfillDone"),
    ReadNeed::not_null("manualRequestID"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_session",
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
    decode: decode_boxed::<RaidSession>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidSession {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `raiderID`.
    #[serde(rename = "raiderID")]
    pub raider_id: String,
    /// `raiderLogin`.
    #[serde(rename = "raiderLogin", default = "default_raider_login")]
    pub raider_login: String,
    /// `raiderName`.
    #[serde(rename = "raiderName", default = "default_raider_name")]
    pub raider_name: String,
    /// `viewers`.
    #[serde(rename = "viewers", default = "default_viewers")]
    pub viewers: JsNumber,
    /// `startedAt`.
    #[serde(rename = "startedAt")]
    pub started_at: JsDate,
    /// `endedAt`.
    #[serde(rename = "endedAt", default)]
    pub ended_at: Option<JsDate>,
    /// `captureUntil`.
    #[serde(rename = "captureUntil")]
    pub capture_until: JsDate,
    /// `retentionHours`.
    #[serde(rename = "retentionHours")]
    pub retention_hours: JsNumber,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `backfillUntil`.
    #[serde(rename = "backfillUntil")]
    pub backfill_until: JsDate,
    /// `backfillCursor`.
    #[serde(rename = "backfillCursor", default = "default_backfill_cursor")]
    pub backfill_cursor: String,
    /// `backfillDone`.
    #[serde(rename = "backfillDone", default = "default_backfill_done")]
    pub backfill_done: bool,
    /// `manualRequestID`.
    #[serde(rename = "manualRequestID", default = "default_manual_request_id")]
    pub manual_request_id: String,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidSession {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `raiderID`.
    #[serde(rename = "raiderID")]
    pub raider_id: String,
    /// `raiderLogin`.
    #[serde(rename = "raiderLogin", skip_serializing_if = "Option::is_none")]
    pub raider_login: Option<String>,
    /// `raiderName`.
    #[serde(rename = "raiderName", skip_serializing_if = "Option::is_none")]
    pub raider_name: Option<String>,
    /// `viewers`.
    #[serde(rename = "viewers", skip_serializing_if = "Option::is_none")]
    pub viewers: Option<JsNumber>,
    /// `startedAt`.
    #[serde(rename = "startedAt")]
    pub started_at: JsDate,
    /// `endedAt`.
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<JsDate>,
    /// `captureUntil`.
    #[serde(rename = "captureUntil")]
    pub capture_until: JsDate,
    /// `retentionHours`.
    #[serde(rename = "retentionHours")]
    pub retention_hours: JsNumber,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `purgeAt`.
    #[serde(rename = "purgeAt")]
    pub purge_at: JsDate,
    /// `backfillUntil`.
    #[serde(rename = "backfillUntil")]
    pub backfill_until: JsDate,
    /// `backfillCursor`.
    #[serde(rename = "backfillCursor", skip_serializing_if = "Option::is_none")]
    pub backfill_cursor: Option<String>,
    /// `backfillDone`.
    #[serde(rename = "backfillDone", skip_serializing_if = "Option::is_none")]
    pub backfill_done: Option<bool>,
    /// `manualRequestID`.
    #[serde(rename = "manualRequestID", skip_serializing_if = "Option::is_none")]
    pub manual_request_id: Option<String>,
}
impl NewRaidSession {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
