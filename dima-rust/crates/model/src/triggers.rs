//! `triggers`: reference `dimabot/src/schemas/trigger.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! server/routes/trigger.route.ts:1193 constructs the create then :1212 saves it; name and
//! volume are normalized, file/media come from the library, reward values use || defaults.
//! :1457-1480 rebuilds the update: name validated, volume typeof number, isEnabled typeof boolean,
//! linked reward values || default. No raw body or assistant write reaches this collection:
//! unchecked client-fed paths (0). Explicit fileID/assetID/libraryItemID nulls accepted.
//! No runValidators or hooks. Legacy missing isEnabled, prompt and media references read schema defaults.
//! Reference quirk: name uniqueness is checked by a read before insert, with no unique index;
//! simultaneous creates can share a channel/name. This port preserves the declared indexes.
//! prompt is private command text owned by the command domain, kept as an uninterpreted string.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Stored command text; parsing belongs to the command domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct TriggerPrompt(pub String);
/// Collection name.
pub const COLLECTION: &str = "triggers";
fn read_default_trigger_type() -> String {
    "trigger".into()
}
fn read_default_trigger_is_enabled() -> bool {
    true
}
fn read_default_trigger_volume() -> JsNumber {
    JsNumber(100.0)
}
fn read_default_trigger_cost() -> JsNumber {
    JsNumber(1.0)
}
fn read_default_trigger_cooldown() -> JsNumber {
    JsNumber(0.0)
}
fn read_default_trigger_prompt() -> Private<TriggerPrompt> {
    Private::new(TriggerPrompt("".into()))
}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::string("channel"),
    Field::string("channelID"),
    Field::string("rewardID"),
    Field::string("file"),
    Field::object_id("fileID").default(D::Null),
    Field::object_id("assetID").default(D::Null),
    Field::object_id("libraryItemID").default(D::Null),
    Field::string("type").default(D::Str("trigger")),
    Field::string("mediaType"),
    Field::boolean("isEnabled").default(D::Bool(true)),
    Field::number("volume").default(D::Int(100)),
    Field::number("cost").default(D::Int(1)),
    Field::number("cooldown").default(D::Int(0)),
    Field::string("prompt").default(D::Str("")),
    Field::date("createdAt").default_fn(D::Now),
    Field::nested(
        "date",
        &[
            Field::number("day").default_fn(D::With(crate::defaults::utc_day)),
            Field::number("month").default_fn(D::With(crate::defaults::utc_month)),
            Field::number("year").default_fn(D::With(crate::defaults::utc_year)),
        ],
    ),
]);
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct TriggerDate {
    /// `date.day`.
    #[serde(rename = "day", default)]
    pub day: Option<JsNumber>,
    /// `date.month`.
    #[serde(rename = "month", default)]
    pub month: Option<JsNumber>,
    /// `date.year`.
    #[serde(rename = "year", default)]
    pub year: Option<JsNumber>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewTriggerDate {
    /// `date.day`.
    #[serde(rename = "day", skip_serializing_if = "Option::is_none")]
    pub day: Option<JsNumber>,
    /// `date.month`.
    #[serde(rename = "month", skip_serializing_if = "Option::is_none")]
    pub month: Option<JsNumber>,
    /// `date.year`.
    #[serde(rename = "year", skip_serializing_if = "Option::is_none")]
    pub year: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct Trigger {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: bson::oid::ObjectId,
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `rewardID`.
    #[serde(rename = "rewardID", default)]
    pub reward_id: Option<String>,
    /// `file`.
    #[serde(rename = "file")]
    pub file: String,
    /// `fileID`.
    #[serde(rename = "fileID", default)]
    pub file_id: Option<bson::oid::ObjectId>,
    /// `assetID`.
    #[serde(rename = "assetID", default)]
    pub asset_id: Option<bson::oid::ObjectId>,
    /// `libraryItemID`.
    #[serde(rename = "libraryItemID", default)]
    pub library_item_id: Option<bson::oid::ObjectId>,
    /// `type`.
    #[serde(rename = "type", default = "read_default_trigger_type")]
    pub r#type: String,
    /// `mediaType`.
    #[serde(rename = "mediaType")]
    pub media_type: String,
    /// `isEnabled`.
    #[serde(rename = "isEnabled", default = "read_default_trigger_is_enabled")]
    pub is_enabled: bool,
    /// `volume`.
    #[serde(rename = "volume", default = "read_default_trigger_volume")]
    pub volume: JsNumber,
    /// `cost`.
    #[serde(rename = "cost", default = "read_default_trigger_cost")]
    pub cost: JsNumber,
    /// `cooldown`.
    #[serde(rename = "cooldown", default = "read_default_trigger_cooldown")]
    pub cooldown: JsNumber,
    /// `prompt`.
    #[serde(rename = "prompt", default = "read_default_trigger_prompt")]
    pub prompt: Private<TriggerPrompt>,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `date`.
    #[serde(rename = "date", default)]
    pub date: Option<TriggerDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewTrigger {
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `rewardID`.
    #[serde(rename = "rewardID", skip_serializing_if = "Option::is_none")]
    pub reward_id: Option<String>,
    /// `file`.
    #[serde(rename = "file")]
    pub file: String,
    /// `fileID`.
    #[serde(rename = "fileID", skip_serializing_if = "Nullable::is_unset")]
    pub file_id: Nullable<bson::oid::ObjectId>,
    /// `assetID`.
    #[serde(rename = "assetID", skip_serializing_if = "Nullable::is_unset")]
    pub asset_id: Nullable<bson::oid::ObjectId>,
    /// `libraryItemID`.
    #[serde(rename = "libraryItemID", skip_serializing_if = "Nullable::is_unset")]
    pub library_item_id: Nullable<bson::oid::ObjectId>,
    /// `type`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// `mediaType`.
    #[serde(rename = "mediaType")]
    pub media_type: String,
    /// `isEnabled`.
    #[serde(rename = "isEnabled", skip_serializing_if = "Option::is_none")]
    pub is_enabled: Option<bool>,
    /// `volume`.
    #[serde(rename = "volume", skip_serializing_if = "Option::is_none")]
    pub volume: Option<JsNumber>,
    /// `cost`.
    #[serde(rename = "cost", skip_serializing_if = "Option::is_none")]
    pub cost: Option<JsNumber>,
    /// `cooldown`.
    #[serde(rename = "cooldown", skip_serializing_if = "Option::is_none")]
    pub cooldown: Option<JsNumber>,
    /// `prompt`.
    #[serde(rename = "prompt", skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Private<TriggerPrompt>>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `date`.
    #[serde(rename = "date", skip_serializing_if = "Option::is_none")]
    pub date: Option<NewTriggerDate>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["prompt"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("name"),
    Rule::required("channel"),
    Rule::required("channelID"),
    Rule::required("file"),
    Rule::required("mediaType"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("name"),
    ReadNeed::value("channel"),
    ReadNeed::value("channelID"),
    ReadNeed::value("file"),
    ReadNeed::not_null("type"),
    ReadNeed::value("mediaType"),
    ReadNeed::not_null("isEnabled"),
    ReadNeed::not_null("volume"),
    ReadNeed::not_null("cost"),
    ReadNeed::not_null("cooldown"),
    ReadNeed::not_null("prompt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Trigger",
    source: "dimabot/src/schemas/trigger.schema.ts",
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
    decode: decode_boxed::<Trigger>,
};
impl NewTrigger {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
