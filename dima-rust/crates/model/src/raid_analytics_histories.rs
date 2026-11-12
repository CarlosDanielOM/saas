//! `raid_analytics_histories`: reference `dimabot/src/schemas/raid_analytics.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/raid_analytics.ts:21,44 build event-derived inserts and follow counts. No direct body copy. Legacy: followsAfter/followsComputedAt may be null, followWindowEnd may be missing. No timestamps or __v; TTL expiresAt.
//! A string _id is required by the read guard: omitted/minimized ids would let MongoDB
//! generate an ObjectId, outside this collection's identifier contract.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
str_enum! { /// `direction`.
pub enum DirectionKind {/// `incoming`.
Incoming = "incoming",/// `outgoing`.
Outgoing = "outgoing"} }
/// Collection name.
pub const COLLECTION: &str = "raid_analytics_histories";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("direction"),
    Field::string("peerID"),
    Field::string("peerLogin"),
    Field::string("peerName"),
    Field::number("viewers"),
    Field::date("occurredAt"),
    Field::number("followsAfter").default(D::Null),
    Field::date("followsComputedAt").default(D::Null),
    Field::date("followWindowEnd"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("occurredAt", -1), ("_id", 1)]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("direction", 1),
        ("peerID", 1),
        ("occurredAt", -1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("direction", 1),
        ("followsComputedAt", 1),
        ("occurredAt", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("direction", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("direction"),
    Rule::one_of("direction", DirectionKind::STRINGS),
    Rule::required("occurredAt"),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("direction"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_analytics_history",
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
    decode: decode_boxed::<RaidAnalyticsHistory>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidAnalyticsHistory {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `direction`.
    #[serde(rename = "direction")]
    pub direction: Open<DirectionKind>,
    /// `peerID`.
    #[serde(rename = "peerID", default)]
    pub peer_id: Option<String>,
    /// `peerLogin`.
    #[serde(rename = "peerLogin", default)]
    pub peer_login: Option<String>,
    /// `peerName`.
    #[serde(rename = "peerName", default)]
    pub peer_name: Option<String>,
    /// `viewers`.
    #[serde(rename = "viewers", default)]
    pub viewers: Option<JsNumber>,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `followsAfter`.
    #[serde(rename = "followsAfter", default)]
    pub follows_after: Option<JsNumber>,
    /// `followsComputedAt`.
    #[serde(rename = "followsComputedAt", default)]
    pub follows_computed_at: Option<JsDate>,
    /// `followWindowEnd`.
    #[serde(rename = "followWindowEnd", default)]
    pub follow_window_end: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidAnalyticsHistory {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `direction`.
    #[serde(rename = "direction")]
    pub direction: DirectionKind,
    /// `peerID`.
    #[serde(rename = "peerID", skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    /// `peerLogin`.
    #[serde(rename = "peerLogin", skip_serializing_if = "Option::is_none")]
    pub peer_login: Option<String>,
    /// `peerName`.
    #[serde(rename = "peerName", skip_serializing_if = "Option::is_none")]
    pub peer_name: Option<String>,
    /// `viewers`.
    #[serde(rename = "viewers", skip_serializing_if = "Option::is_none")]
    pub viewers: Option<JsNumber>,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `followsAfter`.
    #[serde(rename = "followsAfter", skip_serializing_if = "Option::is_none")]
    pub follows_after: Option<JsNumber>,
    /// `followsComputedAt`.
    #[serde(rename = "followsComputedAt", skip_serializing_if = "Option::is_none")]
    pub follows_computed_at: Option<JsDate>,
    /// `followWindowEnd`.
    #[serde(rename = "followWindowEnd", skip_serializing_if = "Option::is_none")]
    pub follow_window_end: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
impl NewRaidAnalyticsHistory {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
