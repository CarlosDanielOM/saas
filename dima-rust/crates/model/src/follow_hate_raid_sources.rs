//! `follow_hate_raid_sources`: reference `dimabot/src/schemas/follow_hate_raid_source.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/follow_defense.ts:359,365 derive counter receipts from recorded attacks. No unchecked body reaches writes. appliedLogIDs is select:false and private. Empty census. Camel-case timestamps and __v. Unique channel pair prevents duplicate counters; no reference index wait or action execution.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_target_channel_login() -> String {
    "".into()
}
fn default_target_channel_name() -> String {
    "".into()
}
fn default_raider_channel_login() -> String {
    "".into()
}
fn default_raider_channel_name() -> String {
    "".into()
}
fn default_count() -> JsNumber {
    JsNumber(1.0)
}
/// Collection name.
pub const COLLECTION: &str = "follow_hate_raid_sources";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("targetChannelID"),
    Field::string("targetChannelLogin").default(D::Str("")),
    Field::string("targetChannelName").default(D::Str("")),
    Field::string("raiderChannelID"),
    Field::string("raiderChannelLogin").default(D::Str("")),
    Field::string("raiderChannelName").default(D::Str("")),
    Field::number("count").default(D::Int(1)),
    Field::array("appliedLogIDs", ValueType::ObjectId).no_default(),
    Field::date("firstSeenAt"),
    Field::date("lastSeenAt"),
])
.timestamps(Timestamps::CAMEL);
/// Hidden paths.
pub const HIDDEN: &[&str] = &["appliedLogIDs"];
/// Private paths.
pub const PRIVATE: &[&str] = &["appliedLogIDs"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("targetChannelID", 1)]),
    IndexSpec::on(&[("raiderChannelID", 1)]),
    IndexSpec::on(&[("targetChannelID", 1), ("raiderChannelID", 1)]).unique(),
    IndexSpec::on(&[("targetChannelID", 1), ("count", -1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("targetChannelID"),
    Rule::required("raiderChannelID"),
    Rule::required("firstSeenAt"),
    Rule::required("lastSeenAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("targetChannelID"),
    ReadNeed::not_null("targetChannelLogin"),
    ReadNeed::not_null("targetChannelName"),
    ReadNeed::value("raiderChannelID"),
    ReadNeed::not_null("raiderChannelLogin"),
    ReadNeed::not_null("raiderChannelName"),
    ReadNeed::not_null("count"),
    ReadNeed::value("firstSeenAt"),
    ReadNeed::value("lastSeenAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_hate_raid_source",
    source: "dimabot/src/schemas/follow_hate_raid_source.schema.ts",
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
    decode: decode_boxed::<FollowHateRaidSource>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowHateRaidSource {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `targetChannelID`.
    #[serde(rename = "targetChannelID")]
    pub target_channel_id: String,
    /// `targetChannelLogin`.
    #[serde(
        rename = "targetChannelLogin",
        default = "default_target_channel_login"
    )]
    pub target_channel_login: String,
    /// `targetChannelName`.
    #[serde(rename = "targetChannelName", default = "default_target_channel_name")]
    pub target_channel_name: String,
    /// `raiderChannelID`.
    #[serde(rename = "raiderChannelID")]
    pub raider_channel_id: String,
    /// `raiderChannelLogin`.
    #[serde(
        rename = "raiderChannelLogin",
        default = "default_raider_channel_login"
    )]
    pub raider_channel_login: String,
    /// `raiderChannelName`.
    #[serde(rename = "raiderChannelName", default = "default_raider_channel_name")]
    pub raider_channel_name: String,
    /// `count`.
    #[serde(rename = "count", default = "default_count")]
    pub count: JsNumber,
    /// `appliedLogIDs`.
    #[serde(rename = "appliedLogIDs", default)]
    pub applied_log_i_ds: Option<Private<Vec<ObjectId>>>,
    /// `firstSeenAt`.
    #[serde(rename = "firstSeenAt")]
    pub first_seen_at: JsDate,
    /// `lastSeenAt`.
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: JsDate,
    /// `createdAt`.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowHateRaidSource {
    /// `targetChannelID`.
    #[serde(rename = "targetChannelID")]
    pub target_channel_id: String,
    /// `targetChannelLogin`.
    #[serde(rename = "targetChannelLogin", skip_serializing_if = "Option::is_none")]
    pub target_channel_login: Option<String>,
    /// `targetChannelName`.
    #[serde(rename = "targetChannelName", skip_serializing_if = "Option::is_none")]
    pub target_channel_name: Option<String>,
    /// `raiderChannelID`.
    #[serde(rename = "raiderChannelID")]
    pub raider_channel_id: String,
    /// `raiderChannelLogin`.
    #[serde(rename = "raiderChannelLogin", skip_serializing_if = "Option::is_none")]
    pub raider_channel_login: Option<String>,
    /// `raiderChannelName`.
    #[serde(rename = "raiderChannelName", skip_serializing_if = "Option::is_none")]
    pub raider_channel_name: Option<String>,
    /// `count`.
    #[serde(rename = "count", skip_serializing_if = "Option::is_none")]
    pub count: Option<JsNumber>,
    /// `appliedLogIDs`.
    #[serde(rename = "appliedLogIDs", skip_serializing_if = "Option::is_none")]
    pub applied_log_i_ds: Option<Private<Vec<ObjectId>>>,
    /// `firstSeenAt`.
    #[serde(rename = "firstSeenAt")]
    pub first_seen_at: JsDate,
    /// `lastSeenAt`.
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: JsDate,
}
impl NewFollowHateRaidSource {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
