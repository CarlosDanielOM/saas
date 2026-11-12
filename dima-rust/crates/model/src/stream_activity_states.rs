//! `stream_activity_states`: reference `dimabot/src/schemas/stream_activity.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_activity.ts:51,52,57,68,134,139; utils/dashboard_activity.ts:21,22,26,37,73,76.
//! No client-fed writes: projector lease/checkpoint state is entirely server-built.
//! Legacy seq is int32/double; active absent after completion. Both projector-v1 and dashboard-daily-v1
//! use string ids. Rust initializes active.ids=[] explicitly; Mongoose supplies the nested array default.
//! Active seq and ids preserve in-flight membership; owner, leaseUntil, updatedAt may be absent.
//! Native lease owners are 24-character ObjectId hex strings; TypeScript uses UUID strings.
//! Both are opaque strings here.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "stream_activity_states";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("owner"),
    Field::date("leaseUntil"),
    Field::number("seq").default(D::Int(0)),
    Field::nested(
        "active",
        &[
            Field::number("seq"),
            Field::array("ids", ValueType::String).default(D::EmptyArray),
        ],
    ),
    Field::date("updatedAt"),
])
.declared_id()
.no_version_key();
fn default_stream_activity_state_seq() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_state_active_ids() -> Vec<Option<String>> {
    vec![]
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamActivityStateActive {
    /// `active.seq`.
    #[serde(rename = "seq", default)]
    pub seq: Option<JsNumber>,
    /// `active.ids`.
    #[serde(rename = "ids", default = "default_stream_activity_state_active_ids")]
    pub ids: Vec<Option<String>>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamActivityStateActive {
    /// `active.seq`.
    #[serde(rename = "seq", skip_serializing_if = "Option::is_none")]
    pub seq: Option<JsNumber>,
    /// `active.ids`.
    #[serde(rename = "ids", skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<Option<String>>>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamActivityState {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner", default)]
    pub owner: Option<String>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", default)]
    pub lease_until: Option<JsDate>,
    /// `seq`.
    #[serde(rename = "seq", default = "default_stream_activity_state_seq")]
    pub seq: JsNumber,
    /// `active`.
    #[serde(rename = "active", default)]
    pub active: Option<StreamActivityStateActive>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamActivityState {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `owner`.
    #[serde(rename = "owner", skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsDate>,
    /// `seq`.
    #[serde(rename = "seq", skip_serializing_if = "Option::is_none")]
    pub seq: Option<JsNumber>,
    /// `active`.
    #[serde(rename = "active", skip_serializing_if = "Option::is_none")]
    pub active: Option<NewStreamActivityStateActive>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<JsDate>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("seq"),
    ReadNeed::not_null("active.ids"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_activity_state",
    source: "dimabot/src/schemas/stream_activity.schema.ts",
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
    decode: decode_boxed::<StreamActivityState>,
};
impl NewStreamActivityState {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
