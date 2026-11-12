//! `asset_libraries` — assets/library.ts:25-28. No timestamps, __v, hooks or indexes.
//! Writers checked: library.ts:67 pull/inc,131 setOnInsert upsert,135 reserve
//! inc/push,141 ready,150 deleting. Callers asset-library.route.ts upload/delete,
//! custom_widgets/media.ts uploadAsset. No direct site-agent model writer.
//! Client file name is sanitized/truncated, MIME/dimensions probed, upload size
//! checked; purpose route enum checked. No unchecked client BSON-null paths,
//! saves or runValidators. Server-only null/removal of READ_NEEDS is refused.
//! No raw fields: assets are schema subdocuments without _id. Upload<=50000000
//! bytes; <=2000 normal assets, mood quota separate; this is a multipart route.
//! Legacy: purpose absent; optional duration; usedBytes and dimensions int32;
//! duration double. JsNumber accepts the census's exact numeric widths.
use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "asset_libraries";
static ASSET_SCHEMA: Schema = Schema::subdocument(&[
    Field::string("id"),
    Field::string("name"),
    Field::string("kind"),
    Field::string("mime"),
    Field::number("bytes"),
    Field::number("width"),
    Field::number("height"),
    Field::number("duration"),
    Field::string("createdAt"),
    Field::string("state"),
    Field::string("purpose"),
])
.no_id();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("usedBytes").default(D::Int(0)),
    Field::document_array("assets", &ASSET_SCHEMA).default(D::EmptyArray),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["assets.$.name"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("usedBytes"),
    ReadNeed::not_null("assets"),
    ReadNeed::value("assets.$.id"),
    ReadNeed::value("assets.$.name"),
    ReadNeed::value("assets.$.kind"),
    ReadNeed::value("assets.$.mime"),
    ReadNeed::value("assets.$.bytes"),
    ReadNeed::value("assets.$.width"),
    ReadNeed::value("assets.$.height"),
    ReadNeed::value("assets.$.createdAt"),
    ReadNeed::value("assets.$.state"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "AssetLibrary",
    source: "dimabot/src/assets/library.ts",
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
    decode: decode_boxed::<AssetLibrary>,
};
/// Stored and input asset subdocument.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssetLibraryEntry {
    /// `id`.
    #[serde(rename = "id")]
    pub id: String,
    /// `name`.
    #[serde(rename = "name")]
    pub name: Private<String>,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: String,
    /// `mime`.
    #[serde(rename = "mime")]
    pub mime: String,
    /// `bytes`.
    #[serde(rename = "bytes")]
    pub bytes: JsNumber,
    /// `width`.
    #[serde(rename = "width")]
    pub width: JsNumber,
    /// `height`.
    #[serde(rename = "height")]
    pub height: JsNumber,
    /// `duration`.
    #[serde(rename = "duration", default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<JsNumber>,
    /// `createdAt`.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// `state`.
    #[serde(rename = "state")]
    pub state: String,
    /// `purpose`.
    #[serde(rename = "purpose", default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct AssetLibrary {
    /// Owner identity.
    #[serde(rename = "_id")]
    pub id: String,
    /// Accounted bytes.
    #[serde(rename = "usedBytes", default)]
    pub used_bytes: JsNumber,
    /// Asset entries.
    #[serde(default)]
    pub assets: Vec<Option<AssetLibraryEntry>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewAssetLibrary {
    /// Owner identity.
    #[serde(rename = "_id")]
    pub id: String,
    /// Initial accounted bytes (otherwise schema default).
    #[serde(rename = "usedBytes", skip_serializing_if = "Option::is_none")]
    pub used_bytes: Option<JsNumber>,
    /// Entries (otherwise schema default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<Option<AssetLibraryEntry>>>,
}
impl NewAssetLibrary {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
