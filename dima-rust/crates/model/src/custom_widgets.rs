//! `custom_widgets`.
//! Reference: custom_widgets/store.ts. No timestamps, __v, hooks or hidden paths.
//! Writers checked: custom_widgets/store.ts:156 create,179 replaceFiles,
//! 197 rename/network,251 lazy manifest,373 prune; media.ts:117 copied media.
//! Callers overlay-studio.route.ts:134-136,164; no direct site-agent writer found.
//! Source text is type checked by source/readPackage; name/network checked; media
//! URLs checked against externalMedia and upload validation; manifest inferred.
//! No unchecked top-level client writes, saves or runValidators. Mixed data may
//! contain client nulls; raw wrappers retain them, nested numeric BSON and dates.
//! Raw revisions: html/css each 512000 bytes, js 1000000, fields 256000,data128000;
//! package total2000000; starting values JSON depth6,500 fields,200 options;
//! history budget6000000 bytes/10 revisions (pinned/latest always retained).
//! Raw media: <=200 discovered URLs, URL length2048; no schema depth/size limit.
//! Route /overlay-studio JSON limit5 MiB; MongoDB document ceiling16 MiB.
//! Code itself lives in S3, references/metadata in revisions; private nonetheless.
//! Legacy: media absent, network absent; revision int32, nested createdAt BSON Date.
//! No schema enum on engine/network; do not close the read vocabulary.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `revisions`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CustomWidgetRevisionsContent(pub Bson);
/// Raw `media`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CustomWidgetMediaContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "custom_widgets";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("owner"),
    Field::string("name"),
    Field::string("engine"),
    Field::number("revision"),
    Field::mixed_array("revisions"),
    Field::date("createdAt"),
    Field::date("updatedAt"),
    Field::mixed("media"),
    Field::string("network"),
])
.declared_id()
.no_version_key()
.no_minimize();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["revisions", "media"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("owner", 1), ("createdAt", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("owner"),
    ReadNeed::value("name"),
    ReadNeed::value("engine"),
    ReadNeed::value("revision"),
    ReadNeed::not_null("revisions"),
    ReadNeed::value("createdAt"),
    ReadNeed::value("updatedAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "CustomWidget",
    source: "dimabot/src/custom_widgets/store.ts",
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
    decode: decode_boxed::<CustomWidget>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct CustomWidget {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner")]
    pub owner: String,
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `engine`.
    #[serde(rename = "engine")]
    pub engine: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `revisions`.
    #[serde(rename = "revisions", default)]
    pub revisions: Private<Vec<CustomWidgetRevisionsContent>>,
    /// `createdAt`.
    #[serde(rename = "createdAt")]
    pub created_at: JsDate,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
    /// `media`.
    #[serde(rename = "media", default)]
    pub media: Option<Private<CustomWidgetMediaContent>>,
    /// `network`.
    #[serde(rename = "network", default)]
    pub network: Option<String>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewCustomWidget {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner")]
    pub owner: String,
    /// `name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `engine`.
    #[serde(rename = "engine")]
    pub engine: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `revisions`.
    #[serde(rename = "revisions")]
    pub revisions: Private<Vec<CustomWidgetRevisionsContent>>,
    /// `createdAt`.
    #[serde(rename = "createdAt")]
    pub created_at: JsDate,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
    /// `media`.
    #[serde(rename = "media", skip_serializing_if = "Option::is_none")]
    pub media: Option<Private<CustomWidgetMediaContent>>,
    /// `network`.
    #[serde(rename = "network", skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
}
impl NewCustomWidget {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
