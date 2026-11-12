//! `moderation_chatters`: reference `dimabot/src/schemas/moderation_chatter.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writer: utils/moderation/spam.ts:102 hashes channel/user ids and inserts firstSeenAt with $setOnInsert. No unchecked client values reach it. Implicit unique string _id makes first-seen claims atomic. No version key, timestamps option or declared indexes.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};

/// Collection name.
pub const COLLECTION: &str = "moderation_chatters";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[Field::string("_id"), Field::date("firstSeenAt")])
    .declared_id()
    .no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("_id"), Rule::required("firstSeenAt")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::value("_id"), ReadNeed::value("firstSeenAt")];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "moderation_chatter",
    source: "dimabot/src/schemas/moderation_chatter.schema.ts",
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
    decode: decode_boxed::<ModerationChatter>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct ModerationChatter {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `firstSeenAt`.
    #[serde(rename = "firstSeenAt")]
    pub first_seen_at: JsDate,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewModerationChatter {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `firstSeenAt`.
    #[serde(rename = "firstSeenAt")]
    pub first_seen_at: JsDate,
}
impl NewModerationChatter {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
