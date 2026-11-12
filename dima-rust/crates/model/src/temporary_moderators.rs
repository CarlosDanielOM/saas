//! `temporary_moderators`: reference `dimabot/src/schemas/temporary_moderator.schema.ts`.
//! AST moderation.functions.ts:552 builds its upsert from checked duration and Twitch account values. Required unique channelID/userID prevents duplicate role-expiry work.
//! No hooks, no runValidators calls; client-fed null paths: none.
//! Legacy: missing optional values and __v are accepted; numeric widths use JsNumber.
//! Intended difference: server-only nulls/removals in READ_NEEDS are refused.
//! No timestamps option; createdAt defaults to Date.now; version key __v.
//! The production copy is empty. Startup imports: API, bot and cron.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::{
    WriteContext,
    date::JsDate,
    id::IdType,
    insert::PreparedInsert,
    number::JsNumber,
    schema::{DefaultValue as D, Field, Schema},
};
use serde::{Deserialize, Serialize};

/// Collection name.
pub const COLLECTION: &str = "temporary_moderators";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel"),
    Field::string("userID"),
    Field::string("username"),
    Field::number("durationDays"),
    Field::date("expireTimestamp"),
    Field::date("createdAt").default_fn(D::Now),
]);
/// Hidden paths (none).
pub const HIDDEN: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("userID", 1)]),
    IndexSpec::on(&[("expireTimestamp", 1)]),
    IndexSpec::on(&[("channelID", 1), ("userID", 1)]).unique(),
];
/// Validators in schema order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("userID"),
    Rule::required("username"),
    Rule::required("durationDays"),
    Rule::required("expireTimestamp"),
];
/// Strict read requirements; server-only paths refuse null.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("channel"),
    ReadNeed::value("userID"),
    ReadNeed::value("username"),
    ReadNeed::value("durationDays"),
    ReadNeed::value("expireTimestamp"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "temporary_moderator",
    source: "dimabot/src/schemas/temporary_moderator.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<TemporaryModerator>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct TemporaryModerator {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `username`.
    #[serde(rename = "username")]
    pub username: String,
    /// `durationDays`.
    #[serde(rename = "durationDays")]
    pub duration_days: JsNumber,
    /// `expireTimestamp`.
    #[serde(rename = "expireTimestamp")]
    pub expire_timestamp: JsDate,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
}
/// New document. Optional values are omitted so defaults apply.
#[derive(Clone, Debug, Serialize)]
pub struct NewTemporaryModerator {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `username`.
    #[serde(rename = "username")]
    pub username: String,
    /// `durationDays`.
    #[serde(rename = "durationDays")]
    pub duration_days: JsNumber,
    /// `expireTimestamp`.
    #[serde(rename = "expireTimestamp")]
    pub expire_timestamp: JsDate,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
}
impl NewTemporaryModerator {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
