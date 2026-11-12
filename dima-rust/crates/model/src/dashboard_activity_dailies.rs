//! `dashboard_activity_dailies`: reference `dimabot/src/schemas/dashboard_activity.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! Schema writeConcern is {w:1,j:true}; projection writes remain journaled.
//! Writers checked: utils/dashboard_activity.ts:60,66 and workers/dashboard_activity.rs:447.
//! No client-fed writes: workers build daily projections. No saves or runValidators.
//! Hash _id is SHA256(JSON array [channelID, UTC-day ISO string, kind, key]).
//! Native bson_number normalizes counts and sequence to int32 just like TypeScript; no legacy nulls.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "dashboard_activity_dailies";
crate::enums::str_enum! { /// Schema vocabulary.
pub enum DashboardActivityDailyKindValue {/// Schema value.
Command = "command",/// Schema value.
Emote = "emote",/// Schema value.
Coverage = "coverage"}}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::date("day"),
    Field::string("kind"),
    Field::string("key"),
    Field::string("label"),
    Field::number("count").default(D::Int(0)),
    Field::date("firstAt"),
    Field::number("lastSeq").default(D::Int(0)),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
fn default_dashboard_activity_daily_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_dashboard_activity_daily_last_seq() -> JsNumber {
    JsNumber(0.0)
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct DashboardActivityDaily {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `day`.
    #[serde(rename = "day")]
    pub day: JsDate,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: crate::Open<DashboardActivityDailyKindValue>,
    /// `key`.
    #[serde(rename = "key", default)]
    pub key: Option<String>,
    /// `label`.
    #[serde(rename = "label", default)]
    pub label: Option<String>,
    /// `count`.
    #[serde(rename = "count", default = "default_dashboard_activity_daily_count")]
    pub count: JsNumber,
    /// `firstAt`.
    #[serde(rename = "firstAt", default)]
    pub first_at: Option<JsDate>,
    /// `lastSeq`.
    #[serde(
        rename = "lastSeq",
        default = "default_dashboard_activity_daily_last_seq"
    )]
    pub last_seq: JsNumber,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewDashboardActivityDaily {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `day`.
    #[serde(rename = "day")]
    pub day: JsDate,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: DashboardActivityDailyKindValue,
    /// `key`.
    #[serde(rename = "key", skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `label`.
    #[serde(rename = "label", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `count`.
    #[serde(rename = "count", skip_serializing_if = "Option::is_none")]
    pub count: Option<JsNumber>,
    /// `firstAt`.
    #[serde(rename = "firstAt", skip_serializing_if = "Option::is_none")]
    pub first_at: Option<JsDate>,
    /// `lastSeq`.
    #[serde(rename = "lastSeq", skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<JsNumber>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("day", 1), ("kind", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("day"),
    Rule::required("kind"),
    Rule::one_of("kind", &["command", "emote", "coverage"]),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("day"),
    ReadNeed::value("kind"),
    ReadNeed::not_null("count"),
    ReadNeed::not_null("lastSeq"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "dashboard_activity_daily",
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
    decode: decode_boxed::<DashboardActivityDaily>,
};
impl NewDashboardActivityDaily {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
