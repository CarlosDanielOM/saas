//! `raid_subscription_preferences`: reference `dimabot/src/schemas/raid_subscription_preference.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: server/services/eventsub_config.service.ts createChannelEventsub/deleteChannelEventsub construct operation ids and deletion flags after direction checks. No direct body copy. No timestamps or __v; unique channelID/direction is best effort (durable opt-out, no action execution).
//! A string _id is required by the read guard: omitted/minimized ids would let MongoDB
//! generate an ObjectId, outside this collection's identifier contract.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
str_enum! { /// `direction`.
pub enum DirectionKind {/// `incoming`.
Incoming = "incoming",/// `outgoing`.
Outgoing = "outgoing"} }
fn default_deleted() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "raid_subscription_preferences";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("direction"),
    Field::boolean("deleted").default(D::Bool(false)),
    Field::string("operation"),
    Field::date("updatedAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1), ("direction", 1)]).unique()];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("direction"),
    Rule::one_of("direction", DirectionKind::STRINGS),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("direction"),
    ReadNeed::not_null("deleted"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "raid_subscription_preference",
    source: "dimabot/src/schemas/raid_subscription_preference.schema.ts",
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
    decode: decode_boxed::<RaidSubscriptionPreference>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct RaidSubscriptionPreference {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `direction`.
    #[serde(rename = "direction")]
    pub direction: Open<DirectionKind>,
    /// `deleted`.
    #[serde(rename = "deleted", default = "default_deleted")]
    pub deleted: bool,
    /// `operation`.
    #[serde(rename = "operation", default)]
    pub operation: Option<String>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewRaidSubscriptionPreference {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `direction`.
    #[serde(rename = "direction")]
    pub direction: DirectionKind,
    /// `deleted`.
    #[serde(rename = "deleted", skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    /// `operation`.
    #[serde(rename = "operation", skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<JsDate>,
}
impl NewRaidSubscriptionPreference {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
