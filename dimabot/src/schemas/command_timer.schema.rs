use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CommandTimer = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "timer_command",
        collection: "timer_commands",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("command", T::String).required(),
            Field::new("timer", T::Number).required(),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::Number).default(D::LocalDay),
                    Field::new("month", T::Number).default(D::LocalMonth),
                    Field::new("year", T::Number).default(D::LocalYear),
                ]),
            ),
        ],
    })
}

use crate::utils::js_string::JsString;

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandTimerDate {
    pub day: f64,
    pub month: f64,
    pub year: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandTimerDateBson {
    day: f64,
    month: f64,
    year: f64,
}

impl From<&CommandTimerDate> for CommandTimerDateBson {
    fn from(value: &CommandTimerDate) -> Self {
        Self {
            day: value.day,
            month: value.month,
            year: value.year,
        }
    }
}

impl From<CommandTimerDateBson> for CommandTimerDate {
    fn from(value: CommandTimerDateBson) -> Self {
        Self {
            day: value.day,
            month: value.month,
            year: value.year,
        }
    }
}

impl CommandTimerDate {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&CommandTimerDateBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<CommandTimerDateBson>(document).map(Into::into)
    }
}

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICommandTimer {
    pub id: mongodb::bson::oid::ObjectId,
    pub command: JsString,
    pub timer: f64,
    pub channel: JsString,
    pub channel_id: JsString,
    pub created_at: mongodb::bson::DateTime,
    pub date: CommandTimerDate,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICommandTimerBson {
    #[serde(rename = "_id")]
    id: mongodb::bson::oid::ObjectId,
    command: String,
    timer: f64,
    channel: String,
    #[serde(rename = "channelID")]
    channel_id: String,
    created_at: mongodb::bson::DateTime,
    date: CommandTimerDateBson,
}

impl From<&ICommandTimer> for ICommandTimerBson {
    fn from(value: &ICommandTimer) -> Self {
        Self {
            id: value.id,
            command: value.command.to_utf8_lossy(),
            timer: value.timer,
            channel: value.channel.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            created_at: value.created_at,
            date: (&value.date).into(),
        }
    }
}

impl From<ICommandTimerBson> for ICommandTimer {
    fn from(value: ICommandTimerBson) -> Self {
        Self {
            id: value.id,
            command: value.command.into(),
            timer: value.timer,
            channel: value.channel.into(),
            channel_id: value.channel_id.into(),
            created_at: value.created_at,
            date: value.date.into(),
        }
    }
}

impl ICommandTimer {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICommandTimerBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICommandTimerBson>(document).map(Into::into)
    }
}
