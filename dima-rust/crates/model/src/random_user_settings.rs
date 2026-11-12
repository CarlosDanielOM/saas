//! `random_user_settings`: reference `dimabot/src/schemas/randomuser_settings.schema.ts`.
//! command.route.ts:42 normalizes body.blacklist with normalizeRandomUserBlacklist before its upsert. No unchecked client value reaches the write.
//! No hooks, no runValidators calls; client-fed null paths: none.
//! Legacy: missing optional values and __v are accepted; numeric widths use JsNumber.
//! Intended difference: server-only nulls/removals in READ_NEEDS are refused.
//! Camel-case timestamps, version key __v. The one stored document has no legacy gaps.
//! Startup imports: API, bot and cron. Unique channelID is best effort (no action dedupe).

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::{
    WriteContext,
    date::JsDate,
    id::IdType,
    insert::PreparedInsert,
    schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType},
};
use serde::{Deserialize, Serialize};
fn default_blacklist() -> Vec<String> {
    Vec::new()
}

/// Collection name.
pub const COLLECTION: &str = "random_user_settings";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::array("blacklist", ValueType::String).default(D::EmptyArray),
])
.timestamps(Timestamps::CAMEL);
/// Hidden paths (none).
pub const HIDDEN: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1)]).unique()];
/// Validators in schema order.
pub const RULES: &[Rule] = &[Rule::required("channelID")];
/// Strict read requirements; server-only paths refuse null.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("blacklist"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "random_user_settings",
    source: "dimabot/src/schemas/randomuser_settings.schema.ts",
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
    decode: decode_boxed::<RandomUserSettings>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RandomUserSettings {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `blacklist`.
    #[serde(rename = "blacklist", default = "default_blacklist")]
    pub blacklist: Vec<String>,
    /// `createdAt`.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}
/// New document. Optional values are omitted so defaults apply.
#[derive(Clone, Debug, Serialize)]
pub struct NewRandomUserSettings {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `blacklist`.
    #[serde(rename = "blacklist", skip_serializing_if = "Option::is_none")]
    pub blacklist: Option<Vec<String>>,
}
impl NewRandomUserSettings {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
