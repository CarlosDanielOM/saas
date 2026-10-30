use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type ChatLog = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Chat_Log",
        collection: "chat_logs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String),
            Field::new("message", T::String),
            Field::new("username", T::String),
            Field::new("timestamp", T::Date).default(D::Now),
        ],
    })
}

use crate::utils::js_string::JsString;

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct IChatLog {
    pub id: mongodb::bson::oid::ObjectId,
    pub channel: JsString,
    pub message: JsString,
    pub username: JsString,
    pub timestamp: mongodb::bson::DateTime,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IChatLogBson {
    #[serde(rename = "_id")]
    id: mongodb::bson::oid::ObjectId,
    channel: String,
    message: String,
    username: String,
    timestamp: mongodb::bson::DateTime,
}

impl From<&IChatLog> for IChatLogBson {
    fn from(value: &IChatLog) -> Self {
        Self {
            id: value.id,
            channel: value.channel.to_utf8_lossy(),
            message: value.message.to_utf8_lossy(),
            username: value.username.to_utf8_lossy(),
            timestamp: value.timestamp,
        }
    }
}

impl From<IChatLogBson> for IChatLog {
    fn from(value: IChatLogBson) -> Self {
        Self {
            id: value.id,
            channel: value.channel.into(),
            message: value.message.into(),
            username: value.username.into(),
            timestamp: value.timestamp,
        }
    }
}

impl IChatLog {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&IChatLogBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<IChatLogBson>(document).map(Into::into)
    }
}
