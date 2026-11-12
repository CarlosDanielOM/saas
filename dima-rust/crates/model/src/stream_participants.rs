//! `stream_participants`: reference `dimabot/src/schemas/stream_timeline.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_timeline.ts:18. No unchecked client-fed paths: server builds
//! the event-derived bucket receipt. No saves or runValidators. No legacy null fields.
//! Unique channel/session/bucket/user is required to prevent double-counting distinct participants.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "stream_participants";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::object_id("session_id"),
    Field::number("bucket"),
    Field::string("user_id"),
    Field::date("expiresAt"),
])
.no_version_key();
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamParticipant {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `bucket`.
    #[serde(rename = "bucket")]
    pub bucket: JsNumber,
    /// `user_id`.
    #[serde(rename = "user_id")]
    pub user_id: String,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamParticipant {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `bucket`.
    #[serde(rename = "bucket")]
    pub bucket: JsNumber,
    /// `user_id`.
    #[serde(rename = "user_id")]
    pub user_id: String,
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
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("bucket", 1),
        ("user_id", 1),
    ])
    .unique(),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("session_id"),
    Rule::required("bucket"),
    Rule::required("user_id"),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("session_id"),
    ReadNeed::value("bucket"),
    ReadNeed::value("user_id"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_participant",
    source: "dimabot/src/schemas/stream_timeline.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<StreamParticipant>,
};
impl NewStreamParticipant {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
