//! `titleconfigs`: reference `dimabot/src/schemas/title_config.schema.ts`.
//! Only account_deletion.ts:161 imports the model (deleteMany); no active create/update writer.
//! No hooks, no runValidators calls; client-fed null paths: none.
//! Legacy: missing optional values and __v are accepted; numeric widths use JsNumber.
//! Intended difference: server-only nulls/removals in READ_NEEDS are refused.
//! No timestamps option; version key __v. One of four documents lacks __v.
//! Startup import: account deletion in the API. No indexes.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::{
    WriteContext,
    id::IdType,
    insert::PreparedInsert,
    schema::{DefaultValue as D, Field, Schema},
};
use serde::{Deserialize, Serialize};
fn default_active() -> bool {
    true
}

/// Collection name.
pub const COLLECTION: &str = "titleconfigs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel"),
    Field::string("pretitle"),
    Field::string("posttitle"),
    Field::boolean("active").default(D::Bool(true)),
]);
/// Hidden paths (none).
pub const HIDDEN: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators in schema order.
pub const RULES: &[Rule] = &[Rule::required("channelID"), Rule::required("channel")];
/// Strict read requirements; server-only paths refuse null.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("channel"),
    ReadNeed::not_null("active"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "titleConfig",
    source: "dimabot/src/schemas/title_config.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<TitleConfig>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct TitleConfig {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `pretitle`.
    #[serde(rename = "pretitle", default)]
    pub pretitle: Option<String>,
    /// `posttitle`.
    #[serde(rename = "posttitle", default)]
    pub posttitle: Option<String>,
    /// `active`.
    #[serde(rename = "active", default = "default_active")]
    pub active: bool,
}
/// New document. Optional values are omitted so defaults apply.
#[derive(Clone, Debug, Serialize)]
pub struct NewTitleConfig {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `pretitle`.
    #[serde(rename = "pretitle", skip_serializing_if = "Option::is_none")]
    pub pretitle: Option<String>,
    /// `posttitle`.
    #[serde(rename = "posttitle", skip_serializing_if = "Option::is_none")]
    pub posttitle: Option<String>,
    /// `active`.
    #[serde(rename = "active", skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
}
impl NewTitleConfig {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
