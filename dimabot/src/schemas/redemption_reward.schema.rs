//! Native `redemptionreward` document contract.
//!
//! Collection `redemptionrewards` is Mongoose's pluralization of model
//! `redemptionreward`. The availability plugin keys off `isEnabled`.
//! Constructors do not connect or install indexes.
use super::command_schema_values;
pub use super::command_schema_values::RedemptionRewardRepository;
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_f64, insert_optional_string, insert_string,
};
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use crate::utils::availability::AvailabilityClock;
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Bson, Document, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "redemptionreward";
pub const COLLECTION_NAME: &str = "redemptionrewards";
pub const EXPORT_NAME: &str = "RedemptionRewardSchema";
pub const ENABLED_FIELD: &str = RedemptionRewardRepository::ENABLED_FIELD;

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut fields = vec![
            Field::new("eventsubID", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).required(),
            Field::new("rewardID", T::String).required(),
            Field::new("title", T::String).required(),
            Field::new("type", T::String).default(D::String("custom")),
            Field::new("prompt", T::String).default(D::String("")),
            Field::new("originalCost", T::Number).required(),
            Field::new("cost", T::Number).required(),
            Field::new("isEnabled", T::Boolean).default(D::Boolean(true)),
            Field::new("message", T::String).default(D::String("")),
            Field::new("costChange", T::Number).default(D::Number(0.0)),
            Field::new("returnToOriginalCost", T::Boolean).default(D::Boolean(false)),
            Field::new("duration", T::Number).default(D::Number(0.0)),
            Field::new("cooldown", T::Number).default(D::Number(0.0)),
            Field::new("backgroundColor", T::String),
            Field::new("createdFrom", T::String).default(D::String("domdimabot")),
            Field::new("createdFor", T::String).default(D::String("twitch")),
        ];
        fields.extend(command_schema_values::availability_fields());
        SchemaDefinition {
            model: MODEL_NAME,
            collection: COLLECTION_NAME,
            string_id: false,
            version_key: true,
            write_concern_journaled: false,
            timestamps: None,
            save_clock_field: None,
            fields,
            indexes: vec![command_schema_values::availability_index()],
        }
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> RedemptionRewardRepository {
    repository_with_clock(database, AvailabilityClock::live())
}

pub fn repository_with_clock(
    database: &Database,
    clock: AvailabilityClock,
) -> RedemptionRewardRepository {
    RedemptionRewardRepository::new(schema(), database, clock)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source `IRedemptionReward`. Hidden availability values stay raw BSON.
#[derive(Clone, Debug, PartialEq)]
pub struct IRedemptionReward {
    pub id: ObjectId,
    pub eventsub_id: JsString,
    pub channel_id: JsString,
    pub channel: JsString,
    pub reward_id: JsString,
    pub title: JsString,
    pub type_name: JsString,
    pub prompt: JsString,
    pub original_cost: f64,
    pub cost: f64,
    pub is_enabled: bool,
    pub message: JsString,
    pub cost_change: f64,
    pub return_to_original_cost: bool,
    pub duration: f64,
    pub cooldown: f64,
    pub background_color: Option<JsString>,
    pub created_from: JsString,
    pub created_for: JsString,
    pub availability: Option<Bson>,
    pub availability_lease: Option<Bson>,
}

impl IRedemptionReward {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            eventsub_id: reader.require_string("eventsubID")?,
            channel_id: reader.require_string("channelID")?,
            channel: reader.require_string("channel")?,
            reward_id: reader.require_string("rewardID")?,
            title: reader.require_string("title")?,
            type_name: reader.require_string("type")?,
            prompt: reader.require_string("prompt")?,
            original_cost: reader.require_f64("originalCost")?,
            cost: reader.require_f64("cost")?,
            is_enabled: reader.require_bool("isEnabled")?,
            message: reader.require_string("message")?,
            cost_change: reader.require_f64("costChange")?,
            return_to_original_cost: reader.require_bool("returnToOriginalCost")?,
            duration: reader.require_f64("duration")?,
            cooldown: reader.require_f64("cooldown")?,
            background_color: reader.optional_string("backgroundColor")?,
            created_from: reader.require_string("createdFrom")?,
            created_for: reader.require_string("createdFor")?,
            availability: document.get("availability").cloned(),
            availability_lease: document.get("availabilityLease").cloned(),
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "eventsubID", &self.eventsub_id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "rewardID", &self.reward_id);
        insert_string(&mut document, "title", &self.title);
        insert_string(&mut document, "type", &self.type_name);
        insert_string(&mut document, "prompt", &self.prompt);
        insert_f64(&mut document, "originalCost", self.original_cost);
        insert_f64(&mut document, "cost", self.cost);
        document.insert("isEnabled", self.is_enabled);
        insert_string(&mut document, "message", &self.message);
        insert_f64(&mut document, "costChange", self.cost_change);
        document.insert("returnToOriginalCost", self.return_to_original_cost);
        insert_f64(&mut document, "duration", self.duration);
        insert_f64(&mut document, "cooldown", self.cooldown);
        insert_optional_string(&mut document, "backgroundColor", &self.background_color);
        insert_string(&mut document, "createdFrom", &self.created_from);
        insert_string(&mut document, "createdFor", &self.created_for);
        if let Some(availability) = &self.availability {
            document.insert("availability", availability.clone());
        }
        if let Some(lease) = &self.availability_lease {
            document.insert("availabilityLease", lease.clone());
        }
        document
    }
}
