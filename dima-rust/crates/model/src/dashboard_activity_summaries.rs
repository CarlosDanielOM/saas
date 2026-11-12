//! `dashboard_activity_summaries`: reference `dimabot/src/schemas/dashboard_activity.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! Writers checked: utils/dashboard_activity.ts:13,107,113,114,116,118; workers/dashboard_activity.rs:506,554.
//! dashboard.route.ts:62 reads only. No unchecked client-fed writes, saves or runValidators.
//! String _id is channelID. Native worker normalizes payload numbers; payload stays raw for its
//! analytics domain. No legacy nulls; queued records can lack owner/updatedAt/payload.
//! Native lease owners are 24-character ObjectId hex strings; TypeScript uses UUID strings.
//! Both are opaque strings here.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "dashboard_activity_summaries";
/// Raw analytics-domain content.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct DashboardActivitySummaryPayloadContent(pub bson::Bson);
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
fn default_dashboard_activity_summary_lease_until() -> JsDate {
    JsDate(0)
}
fn default_dashboard_activity_summary_error() -> bool {
    false
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct DashboardActivitySummary {
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
    #[serde(
        rename = "leaseUntil",
        default = "default_dashboard_activity_summary_lease_until"
    )]
    pub lease_until: JsDate,
    /// `owner`.
    #[serde(rename = "owner", default)]
    pub owner: Option<String>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
    /// `payload`.
    #[serde(rename = "payload", default)]
    pub payload: Option<DashboardActivitySummaryPayloadContent>,
    /// `error`.
    #[serde(rename = "error", default = "default_dashboard_activity_summary_error")]
    pub error: bool,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewDashboardActivitySummary {
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
    pub payload: Option<bson::Bson>,
    /// `error`.
    #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}
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
    model: "dashboard_activity_summary",
    source: "dimabot/src/schemas/dashboard_activity.schema.ts",
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
    decode: decode_boxed::<DashboardActivitySummary>,
};
impl NewDashboardActivitySummary {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
