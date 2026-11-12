//! `moderation_variation_caches`: reference `dimabot/src/schemas/moderation_variation.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writer: utils/moderation/variation_jobs.ts:96 stores generated, validated entries via an upsert. No unchecked client values reach it. No version key or timestamps option. TTL expiresAt. EntryContent remains raw/private for the moderation-pattern domain.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
/// Raw `entry`, owned by its feature.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct EntryContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "moderation_variation_caches";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::mixed("entry"),
    Field::string("model"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["entry"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0)];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::value("_id")];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "moderation_variation_cache",
    source: "dimabot/src/schemas/moderation_variation.schema.ts",
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
    decode: decode_boxed::<ModerationVariationCache>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct ModerationVariationCache {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", default)]
    pub channel_id: Option<String>,
    /// `entry`.
    #[serde(rename = "entry", default)]
    pub entry: Option<Private<EntryContent>>,
    /// `model`.
    #[serde(rename = "model", default)]
    pub model: Option<String>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewModerationVariationCache {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `entry`.
    #[serde(rename = "entry", skip_serializing_if = "Option::is_none")]
    pub entry: Option<Private<Bson>>,
    /// `model`.
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
impl NewModerationVariationCache {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
