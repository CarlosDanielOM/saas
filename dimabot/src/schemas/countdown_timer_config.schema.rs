use super::{Field, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CountdownTimerConfig = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Countdowntimerconfig",
        collection: "countdowntimerconfigs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("bits", T::Number).required(),
            Field::new("tier1", T::Number).required(),
            Field::new("tier2", T::Number).required(),
            Field::new("tier3", T::Number).required(),
            Field::new("follows", T::Number).required(),
            Field::new("raids", T::Number).required(),
            Field::new("viewers", T::Number).required(),
            Field::new("donations", T::Number).required(),
        ],
    })
}

use crate::utils::js_string::JsString;

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICountdownTimerConfig {
    pub id: mongodb::bson::oid::ObjectId,
    pub channel: JsString,
    pub channel_id: JsString,
    pub bits: f64,
    pub tier1: f64,
    pub tier2: f64,
    pub tier3: f64,
    pub follows: f64,
    pub raids: f64,
    pub viewers: f64,
    pub donations: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICountdownTimerConfigBson {
    #[serde(rename = "_id")]
    id: mongodb::bson::oid::ObjectId,
    channel: String,
    #[serde(rename = "channelID")]
    channel_id: String,
    bits: f64,
    tier1: f64,
    tier2: f64,
    tier3: f64,
    follows: f64,
    raids: f64,
    viewers: f64,
    donations: f64,
}

impl From<&ICountdownTimerConfig> for ICountdownTimerConfigBson {
    fn from(value: &ICountdownTimerConfig) -> Self {
        Self {
            id: value.id,
            channel: value.channel.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            bits: value.bits,
            tier1: value.tier1,
            tier2: value.tier2,
            tier3: value.tier3,
            follows: value.follows,
            raids: value.raids,
            viewers: value.viewers,
            donations: value.donations,
        }
    }
}

impl From<ICountdownTimerConfigBson> for ICountdownTimerConfig {
    fn from(value: ICountdownTimerConfigBson) -> Self {
        Self {
            id: value.id,
            channel: value.channel.into(),
            channel_id: value.channel_id.into(),
            bits: value.bits,
            tier1: value.tier1,
            tier2: value.tier2,
            tier3: value.tier3,
            follows: value.follows,
            raids: value.raids,
            viewers: value.viewers,
            donations: value.donations,
        }
    }
}

impl ICountdownTimerConfig {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICountdownTimerConfigBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICountdownTimerConfigBson>(document)
            .map(Into::into)
    }
}
