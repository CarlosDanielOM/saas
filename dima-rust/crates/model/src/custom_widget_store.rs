//! `custom_widget_store`.
//! Reference: custom_widgets/widget-store.ts. No timestamps, __v, hooks or hidden paths.
//! Writer checked: custom_widgets/widget-store.ts:49 storeSet updateOne upsert.
//! Callers overlays/live.ts:310 widget storage handler; namespace/key checked;
//! raw client value JSON.stringify(raw ?? null) produces a string, including null
//! as text. No unchecked BSON-null path; no document saves or runValidators.
//! JSON is private arbitrary client content, <=64000 UTF-8 bytes/value, <=500 keys,
//! <=2000000 bytes/channel; key1-100 characters; no explicit depth bound.
//! No Mixed schema fields. HTTP /overlay-studio limit5 MiB; OBS socket transport
//! has no explicit limit in this module. Legacy bytes int32; JSON text remains unparsed.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "custom_widget_store";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("owner"),
    Field::string("namespace"),
    Field::string("key"),
    Field::string("json"),
    Field::number("bytes"),
    Field::date("updatedAt"),
])
.declared_id()
.no_version_key()
.no_minimize();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["json"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("owner", 1), ("namespace", 1), ("key", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("owner"),
    ReadNeed::value("namespace"),
    ReadNeed::value("key"),
    ReadNeed::value("json"),
    ReadNeed::value("bytes"),
    ReadNeed::value("updatedAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "CustomWidgetStore",
    source: "dimabot/src/custom_widgets/widget-store.ts",
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
    decode: decode_boxed::<CustomWidgetStore>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct CustomWidgetStore {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner")]
    pub owner: String,
    /// `namespace`.
    #[serde(rename = "namespace")]
    pub namespace: String,
    /// `key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `json`.
    #[serde(rename = "json")]
    pub json: Private<String>,
    /// `bytes`.
    #[serde(rename = "bytes")]
    pub bytes: JsNumber,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewCustomWidgetStore {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner")]
    pub owner: String,
    /// `namespace`.
    #[serde(rename = "namespace")]
    pub namespace: String,
    /// `key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `json`.
    #[serde(rename = "json")]
    pub json: Private<String>,
    /// `bytes`.
    #[serde(rename = "bytes")]
    pub bytes: JsNumber,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
}
impl NewCustomWidgetStore {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
