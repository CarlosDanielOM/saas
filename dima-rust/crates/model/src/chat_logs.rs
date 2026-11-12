//! `chat_logs`: reference `dimabot/src/schemas/chat_logs.schema.ts`.
//! Unused: no process imports it, no code writes it, and no collection in the production copy.
//! Modeled from the frozen schema and real Mongoose recordings alone; startup must not create it.
//! No hooks, timestamps, indexes, required fields, client-fed writes or runValidators.
//! All fields are optional; timestamp's Date.now is never invented by a read. __v on new writes.
//! Chat message and username are private. There are no observed legacy shapes.
use crate::Private;
use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "chat_logs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channel"),
    Field::string("message"),
    Field::string("username"),
    Field::date("timestamp").default_fn(D::Now),
]);
/// Hidden fields.
pub const HIDDEN: &[&str] = &[];
/// Private fields.
pub const PRIVATE: &[&str] = &["message", "username"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Chat_Log",
    source: "dimabot/src/schemas/chat_logs.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: false,
    private: PRIVATE,
    decode: decode_boxed::<ChatLog>,
};
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChatLog {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channel`.
    #[serde(rename = "channel", default)]
    pub channel: Option<String>,
    /// `message`.
    #[serde(rename = "message", default)]
    pub message: Option<Private<String>>,
    /// `username`.
    #[serde(rename = "username", default)]
    pub username: Option<Private<String>>,
    /// `timestamp`.
    #[serde(rename = "timestamp", default)]
    pub timestamp: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChatLog {
    /// `channel`.
    #[serde(rename = "channel", skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// `message`.
    #[serde(rename = "message", skip_serializing_if = "Option::is_none")]
    pub message: Option<Private<String>>,
    /// `username`.
    #[serde(rename = "username", skip_serializing_if = "Option::is_none")]
    pub username: Option<Private<String>>,
    /// `timestamp`.
    #[serde(rename = "timestamp", skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<JsDate>,
}
impl NewChatLog {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
