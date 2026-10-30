use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CountdownTimer = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Countdowntimer",
        collection: "countdowntimers",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("startTime", T::Number).required(),
            Field::new("resumedAt", T::Date),
            Field::new("pausedAt", T::Date),
            Field::new("time", T::Number).default(D::Number(0.0)),
            Field::new("paused", T::Boolean).default(D::Boolean(false)),
            Field::new("active", T::Boolean).default(D::Boolean(true)),
        ],
    })
}

use crate::utils::js_string::JsString;

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICountdownTimer {
    pub id: mongodb::bson::oid::ObjectId,
    pub channel: JsString,
    pub channel_id: JsString,
    pub start_time: f64,
    pub resumed_at: mongodb::bson::DateTime,
    pub paused_at: mongodb::bson::DateTime,
    pub time: f64,
    pub paused: bool,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICountdownTimerBson {
    #[serde(rename = "_id")]
    id: mongodb::bson::oid::ObjectId,
    channel: String,
    #[serde(rename = "channelID")]
    channel_id: String,
    start_time: f64,
    resumed_at: mongodb::bson::DateTime,
    paused_at: mongodb::bson::DateTime,
    time: f64,
    paused: bool,
    active: bool,
}

impl From<&ICountdownTimer> for ICountdownTimerBson {
    fn from(value: &ICountdownTimer) -> Self {
        Self {
            id: value.id,
            channel: value.channel.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            start_time: value.start_time,
            resumed_at: value.resumed_at,
            paused_at: value.paused_at,
            time: value.time,
            paused: value.paused,
            active: value.active,
        }
    }
}

impl From<ICountdownTimerBson> for ICountdownTimer {
    fn from(value: ICountdownTimerBson) -> Self {
        Self {
            id: value.id,
            channel: value.channel.into(),
            channel_id: value.channel_id.into(),
            start_time: value.start_time,
            resumed_at: value.resumed_at,
            paused_at: value.paused_at,
            time: value.time,
            paused: value.paused,
            active: value.active,
        }
    }
}

impl ICountdownTimer {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICountdownTimerBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICountdownTimerBson>(document).map(Into::into)
    }
}
