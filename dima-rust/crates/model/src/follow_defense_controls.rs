//! `follow_defense_controls`: reference `dimabot/src/schemas/follow_defense_action.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/follow_defense_actions.ts cancellation, pacing and lease updates build dates and tokens. No unchecked body reaches writes. No __v or timestamps. Legacy ratePerSecond and successStreak are missing and read their literal defaults. No TTL: cancellation boundary is durable.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_cancelled_through() -> JsDate {
    JsDate(0)
}
fn default_pending_until() -> JsDate {
    JsDate(0)
}
fn default_next_allowed_at() -> JsDate {
    JsDate(0)
}
fn default_last_served_at() -> JsDate {
    JsDate(0)
}
fn default_rate_per_second() -> JsNumber {
    JsNumber(5.0)
}
fn default_success_streak() -> JsNumber {
    JsNumber(0.0)
}
fn default_locked_until() -> JsDate {
    JsDate(0)
}
fn default_lease_token() -> Private<String> {
    Private::new("".into())
}
/// Collection name.
pub const COLLECTION: &str = "follow_defense_controls";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::date("cancelledThrough").default_fn(D::DateMs(0)),
    Field::date("pendingUntil").default_fn(D::DateMs(0)),
    Field::date("nextAllowedAt").default_fn(D::DateMs(0)),
    Field::date("lastServedAt").default_fn(D::DateMs(0)),
    Field::number("ratePerSecond").default(D::Int(5)),
    Field::number("successStreak").default(D::Int(0)),
    Field::date("lockedUntil").default_fn(D::DateMs(0)),
    Field::string("leaseToken").default(D::Str("")),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["leaseToken"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("nextAllowedAt", 1), ("lastServedAt", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("_id")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("cancelledThrough"),
    ReadNeed::not_null("pendingUntil"),
    ReadNeed::not_null("nextAllowedAt"),
    ReadNeed::not_null("lastServedAt"),
    ReadNeed::not_null("ratePerSecond"),
    ReadNeed::not_null("successStreak"),
    ReadNeed::not_null("lockedUntil"),
    ReadNeed::not_null("leaseToken"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_defense_control",
    source: "dimabot/src/schemas/follow_defense_action.schema.ts",
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
    decode: decode_boxed::<FollowDefenseControl>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowDefenseControl {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `cancelledThrough`.
    #[serde(rename = "cancelledThrough", default = "default_cancelled_through")]
    pub cancelled_through: JsDate,
    /// `pendingUntil`.
    #[serde(rename = "pendingUntil", default = "default_pending_until")]
    pub pending_until: JsDate,
    /// `nextAllowedAt`.
    #[serde(rename = "nextAllowedAt", default = "default_next_allowed_at")]
    pub next_allowed_at: JsDate,
    /// `lastServedAt`.
    #[serde(rename = "lastServedAt", default = "default_last_served_at")]
    pub last_served_at: JsDate,
    /// `ratePerSecond`.
    #[serde(rename = "ratePerSecond", default = "default_rate_per_second")]
    pub rate_per_second: JsNumber,
    /// `successStreak`.
    #[serde(rename = "successStreak", default = "default_success_streak")]
    pub success_streak: JsNumber,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", default = "default_locked_until")]
    pub locked_until: JsDate,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", default = "default_lease_token")]
    pub lease_token: Private<String>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowDefenseControl {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `cancelledThrough`.
    #[serde(rename = "cancelledThrough", skip_serializing_if = "Option::is_none")]
    pub cancelled_through: Option<JsDate>,
    /// `pendingUntil`.
    #[serde(rename = "pendingUntil", skip_serializing_if = "Option::is_none")]
    pub pending_until: Option<JsDate>,
    /// `nextAllowedAt`.
    #[serde(rename = "nextAllowedAt", skip_serializing_if = "Option::is_none")]
    pub next_allowed_at: Option<JsDate>,
    /// `lastServedAt`.
    #[serde(rename = "lastServedAt", skip_serializing_if = "Option::is_none")]
    pub last_served_at: Option<JsDate>,
    /// `ratePerSecond`.
    #[serde(rename = "ratePerSecond", skip_serializing_if = "Option::is_none")]
    pub rate_per_second: Option<JsNumber>,
    /// `successStreak`.
    #[serde(rename = "successStreak", skip_serializing_if = "Option::is_none")]
    pub success_streak: Option<JsNumber>,
    /// `lockedUntil`.
    #[serde(rename = "lockedUntil", skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<JsDate>,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<Private<String>>,
}
impl NewFollowDefenseControl {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
