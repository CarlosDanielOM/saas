//! `triggerfiles`: reference `dimabot/src/schemas/trigger_file.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! The frozen reference no longer writes these legacy upload records. Checked ledger call sites:
//! server/routes/auth.route.ts:1429 and utils/account_deletion.ts:159 delete only;
//! scripts/migrate_trigger_media.script.ts:98 and cleanup_invalid_legacy_trigger_files.script.ts:79
//! read only (the latter deletes at :140). No client-fed writes (0), saves, hooks or runValidators.
//! The census has all declared fields; calendar defaults are computed on writes only.
//! The running API imports the schema for account deletion, so startup still initializes it.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "triggerfiles";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::string("fileName"),
    Field::number("fileSize"),
    Field::string("fileType"),
    Field::string("fileUrl"),
    Field::string("channel"),
    Field::string("channelID"),
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
pub struct TriggerFileDate {
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
pub struct NewTriggerFileDate {
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
pub struct TriggerFile {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: bson::oid::ObjectId,
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `fileName`.
    #[serde(rename = "fileName")]
    pub file_name: String,
    /// `fileSize`.
    #[serde(rename = "fileSize")]
    pub file_size: JsNumber,
    /// `fileType`.
    #[serde(rename = "fileType")]
    pub file_type: String,
    /// `fileUrl`.
    #[serde(rename = "fileUrl")]
    pub file_url: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `date`.
    #[serde(rename = "date", default)]
    pub date: Option<TriggerFileDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewTriggerFile {
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `fileName`.
    #[serde(rename = "fileName")]
    pub file_name: String,
    /// `fileSize`.
    #[serde(rename = "fileSize")]
    pub file_size: JsNumber,
    /// `fileType`.
    #[serde(rename = "fileType")]
    pub file_type: String,
    /// `fileUrl`.
    #[serde(rename = "fileUrl")]
    pub file_url: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `date`.
    #[serde(rename = "date", skip_serializing_if = "Option::is_none")]
    pub date: Option<NewTriggerFileDate>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("name"),
    Rule::required("fileName"),
    Rule::required("fileSize"),
    Rule::required("fileType"),
    Rule::required("fileUrl"),
    Rule::required("channel"),
    Rule::required("channelID"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("name"),
    ReadNeed::value("fileName"),
    ReadNeed::value("fileSize"),
    ReadNeed::value("fileType"),
    ReadNeed::value("fileUrl"),
    ReadNeed::value("channel"),
    ReadNeed::value("channelID"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "TriggerFile",
    source: "dimabot/src/schemas/trigger_file.schema.ts",
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
    decode: decode_boxed::<TriggerFile>,
};
impl NewTriggerFile {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
