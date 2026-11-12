//! `bits_rules`.
//! Reference: bits_rules/store.ts. No timestamps, __v, hooks or hidden paths.
//! Writers checked: bits_rules/store.ts:41 create,48 revision CAS update.
//! Callers bits-rules.route.ts:55,68,80; site_agent/tools/write/settings/bits_rules.ts
//! apply/undo (create/update/delete), all via changeBitsRules. Routes/apply use
//! parseRule; undo restores a stored rule without revalidation. No direct body spread
//! or unchecked scalar write; raw rules retain any nested nulls (max:null is normal).
//! No saves/runValidators. Raw rules: <=50, names<=60, messages<=1000, ids<=64;
//! parseRule rebuilds a fixed-depth object (chat nested one level), amount1-1000000.
//! Schema itself has no byte/depth validator; request JSON default100 KiB.
//! Legacy: max:null; revision int32; raw nested BSON numbers preserved.
//! No extra indexes; _id and revision CAS coordinate concurrent editor writes.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `rules`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct BitsRulesRulesContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "bits_rules";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision"),
    Field::mixed_array("rules"),
    Field::date("updatedAt"),
    Field::string("updatedBy"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["rules"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("revision"),
    ReadNeed::not_null("rules"),
    ReadNeed::value("updatedAt"),
    ReadNeed::value("updatedBy"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "BitsRules",
    source: "dimabot/src/bits_rules/store.ts",
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
    decode: decode_boxed::<BitsRules>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct BitsRules {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `rules`.
    #[serde(rename = "rules", default)]
    pub rules: Private<Vec<BitsRulesRulesContent>>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
    /// `updatedBy`.
    #[serde(rename = "updatedBy")]
    pub updated_by: String,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewBitsRules {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `rules`.
    #[serde(rename = "rules")]
    pub rules: Private<Vec<BitsRulesRulesContent>>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
    /// `updatedBy`.
    #[serde(rename = "updatedBy")]
    pub updated_by: String,
}
impl NewBitsRules {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
