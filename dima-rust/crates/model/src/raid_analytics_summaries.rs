//! `raid_analytics_summaries`: reference `dimabot/src/schemas/raid_analytics.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/raid_analytics.ts:11,74-88 build queue, claim and projection updates. No direct body copy. Legacy: missing nextRefreshAt; unknown native rustRefresh fields ignored. No timestamps or __v. Payload remains raw for the analytics domain.
//! A string _id is required by the read guard: omitted/minimized ids would let MongoDB
//! generate an ObjectId, outside this collection's identifier contract.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
fn default_lease_until() -> JsDate {
    JsDate(0)
}
/// Raw `payload`, owned by its feature.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct PayloadContent(pub Bson);
fn default_error() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "raid_analytics_summaries";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::date("dirtyAt"),
    Field::date("nextRefreshAt"),
    Field::date("leaseUntil").default_fn(D::DateMs(0)),
    Field::string("owner"),
    Field::date("updatedAt"),
    Field::mixed("payload"),
    Field::boolean("error").default(D::Bool(false)),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("nextRefreshAt", 1), ("leaseUntil", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("leaseUntil"),
    ReadNeed::not_null("error"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_analytics_summary",
    source: "dimabot/src/schemas/raid_analytics.schema.ts",
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
    decode: decode_boxed::<RaidAnalyticsSummary>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidAnalyticsSummary {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `dirtyAt`.
    #[serde(rename = "dirtyAt", default)]
    pub dirty_at: Option<JsDate>,
    /// `nextRefreshAt`.
    #[serde(rename = "nextRefreshAt", default)]
    pub next_refresh_at: Option<JsDate>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", default = "default_lease_until")]
    pub lease_until: JsDate,
    /// `owner`.
    #[serde(rename = "owner", default)]
    pub owner: Option<String>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
    /// `payload`.
    #[serde(rename = "payload", default)]
    pub payload: Option<PayloadContent>,
    /// `error`.
    #[serde(rename = "error", default = "default_error")]
    pub error: bool,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidAnalyticsSummary {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `dirtyAt`.
    #[serde(rename = "dirtyAt", skip_serializing_if = "Option::is_none")]
    pub dirty_at: Option<JsDate>,
    /// `nextRefreshAt`.
    #[serde(rename = "nextRefreshAt", skip_serializing_if = "Option::is_none")]
    pub next_refresh_at: Option<JsDate>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsDate>,
    /// `owner`.
    #[serde(rename = "owner", skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<JsDate>,
    /// `payload`.
    #[serde(rename = "payload", skip_serializing_if = "Option::is_none")]
    pub payload: Option<Bson>,
    /// `error`.
    #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}
impl NewRaidAnalyticsSummary {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
