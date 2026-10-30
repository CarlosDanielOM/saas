use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type CustomTimer = Document;
pub const FREQUENCY_UNITS: &[&str] = &["minutes"];
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "custom_timer",
        collection: "custom_timers",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("name", T::String)
                .trim()
                .required()
                .max_utf16(30),
            Field::new("message", T::String)
                .trim()
                .required()
                .max_utf16(350),
            Field::new("frequency", T::Number)
                .required()
                .min(1.0)
                .max(1440.0)
                .integer(),
            Field::new("frequencyUnit", T::String).enumeration(FREQUENCY_UNITS),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("active", T::Boolean).default(D::Boolean(true)),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"channelID":1,"name":1}).unique(),
        ],
    })
}

use crate::utils::js_string::JsString;

/// The literal union declared by `ICustomTimer.frequencyUnit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FrequencyUnit {
    #[serde(rename = "minutes")]
    Minutes,
}
impl FrequencyUnit {
    pub const ALL: [Self; 1] = [Self::Minutes];
    pub const fn as_str(self) -> &'static str {
        FREQUENCY_UNITS[0]
    }
}
impl std::str::FromStr for FrequencyUnit {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|unit| unit.as_str() == value)
            .ok_or(())
    }
}
fn present_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Source-declared type; JavaScript strings preserve all UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICustomTimer {
    pub id: Option<mongodb::bson::oid::ObjectId>,
    pub name: JsString,
    pub message: JsString,
    pub frequency: f64,
    pub frequency_unit: Option<FrequencyUnit>,
    pub channel: JsString,
    pub channel_id: JsString,
    pub active: bool,
    pub created_at: Option<mongodb::bson::DateTime>,
    pub updated_at: Option<mongodb::bson::DateTime>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICustomTimerBson {
    #[serde(rename = "_id")]
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    id: Option<mongodb::bson::oid::ObjectId>,
    name: String,
    message: String,
    frequency: f64,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    frequency_unit: Option<FrequencyUnit>,
    channel: String,
    #[serde(rename = "channelID")]
    channel_id: String,
    active: bool,
    #[serde(rename = "created_at")]
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    created_at: Option<mongodb::bson::DateTime>,
    #[serde(rename = "updated_at")]
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    updated_at: Option<mongodb::bson::DateTime>,
}

impl From<&ICustomTimer> for ICustomTimerBson {
    fn from(value: &ICustomTimer) -> Self {
        Self {
            id: value.id,
            name: value.name.to_utf8_lossy(),
            message: value.message.to_utf8_lossy(),
            frequency: value.frequency,
            frequency_unit: value.frequency_unit,
            channel: value.channel.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            active: value.active,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<ICustomTimerBson> for ICustomTimer {
    fn from(value: ICustomTimerBson) -> Self {
        Self {
            id: value.id,
            name: value.name.into(),
            message: value.message.into(),
            frequency: value.frequency,
            frequency_unit: value.frequency_unit,
            channel: value.channel.into(),
            channel_id: value.channel_id.into(),
            active: value.active,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl ICustomTimer {
    /// BSON strings replace unpaired UTF-16 units, matching the Node BSON boundary.
    pub fn to_bson_document(&self) -> Result<Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICustomTimerBson::from(self))
    }
    /// Read a declared value; missing required fields and optional nulls are rejected.
    pub fn from_bson_document(document: Document) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICustomTimerBson>(document).map(Into::into)
    }
}
