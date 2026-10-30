//! `eventsub` collection contract.
//!
//! `condition`, `transport`, and `cheerTiers` are Mixed storage. The exported
//! interfaces are stricter views over that storage. Empty Mixed objects are
//! minimized after validation, so a required `{}` can be absent from the
//! constructed document. The strict view then reports the key as missing;
//! the repository still round-trips whatever BSON was stored, including
//! unknown keys. This module does not use `utils::eventsub::Condition`.
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_f64, insert_nullable_datetime, insert_optional_string,
    insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "eventsub";
pub const COLLECTION_NAME: &str = "eventsubs";
pub const EXPORT_NAME: &str = "default";

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"channelID": 1, "type": 1}),
            SchemaIndex::new(doc! {"id": 1}),
        ],
        fields: vec![
            Field::new("id", T::String).required(),
            Field::new("status", T::String).required(),
            Field::new("type", T::String).required(),
            Field::new("version", T::String).required(),
            Field::new("condition", T::Mixed).required().minimize(),
            Field::new("created_at", T::String).required(),
            Field::new("transport", T::Mixed).required().minimize(),
            Field::new("cost", T::Number).required(),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("enabled", T::Boolean).default(D::Boolean(true)),
            Field::new("message", T::String).default(D::String("")),
            Field::new("watchStreakEnabled", T::Boolean).default(D::Boolean(true)),
            Field::new("modiversaryMessage", T::String).default(D::String("")),
            Field::new("modiversaryEnabled", T::Boolean).default(D::Boolean(true)),
            Field::new("endMessage", T::String).default(D::String("")),
            Field::new("endEnabled", T::Boolean).default(D::Boolean(false)),
            Field::new("minViewers", T::Number).default(D::Number(2.0)),
            Field::new("temporalBanMessage", T::String).default(D::String("")),
            Field::new("clipEnabled", T::Boolean).default(D::Boolean(false)),
            Field::new("delay", T::Number).default(D::Number(0.0)),
            Field::new("cheerTiers", T::Array(Box::new(T::Mixed)))
                .default(D::Array)
                .minimize(),
            Field::new("todayFollows", T::Boolean).default(D::Boolean(false)),
            Field::new("remote_missing_since", T::Date).default(D::Null),
        ],
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source `ICondition`. Every field is optional. Unknown keys are ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ICondition {
    pub broadcaster_user_id: Option<JsString>,
    pub user_id: Option<JsString>,
    pub moderator_user_id: Option<JsString>,
    pub from_broadcaster_user_id: Option<JsString>,
    pub to_broadcaster_user_id: Option<JsString>,
}

/// Source `ITransport`. Both fields are required.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ITransport {
    pub method: JsString,
    pub callback: JsString,
}

/// Source `ICheerTiers`. Every field is required.
#[derive(Clone, Debug, PartialEq)]
pub struct ICheerTiers {
    pub id: JsString,
    pub name: JsString,
    pub message: JsString,
    pub min_amount: f64,
    pub max_amount: f64,
}

/// Source `IEventsub`. The interface has no `_id`; Mongoose still generates one.
/// `created_at` is the Twitch string, not a timestamp.
#[derive(Clone, Debug, PartialEq)]
pub struct IEventsub {
    pub id: JsString,
    pub status: JsString,
    pub event_type: JsString,
    pub version: JsString,
    pub condition: ICondition,
    pub created_at: JsString,
    pub transport: ITransport,
    pub cost: f64,
    pub channel: JsString,
    pub channel_id: JsString,
    pub enabled: bool,
    pub message: JsString,
    pub watch_streak_enabled: Option<bool>,
    pub modiversary_message: Option<JsString>,
    pub modiversary_enabled: Option<bool>,
    pub end_message: JsString,
    pub end_enabled: bool,
    pub min_viewers: f64,
    pub temporal_ban_message: JsString,
    pub clip_enabled: bool,
    pub delay: f64,
    pub cheer_tiers: Vec<ICheerTiers>,
    pub today_follows: Option<bool>,
    pub remote_missing_since: Option<Option<DateTime>>,
}

pub fn condition_view(value: &Bson) -> Result<ICondition, StrictDecodeError> {
    let Bson::Document(document) = value else {
        return Err(StrictDecodeError {
            path: "condition".to_owned(),
            kind: "type",
        });
    };
    let reader = Reader::with_prefix(document, "condition");
    Ok(ICondition {
        broadcaster_user_id: reader.optional_string("broadcaster_user_id")?,
        user_id: reader.optional_string("user_id")?,
        moderator_user_id: reader.optional_string("moderator_user_id")?,
        from_broadcaster_user_id: reader.optional_string("from_broadcaster_user_id")?,
        to_broadcaster_user_id: reader.optional_string("to_broadcaster_user_id")?,
    })
}

pub fn transport_view(value: &Bson) -> Result<ITransport, StrictDecodeError> {
    let Bson::Document(document) = value else {
        return Err(StrictDecodeError {
            path: "transport".to_owned(),
            kind: "type",
        });
    };
    let reader = Reader::with_prefix(document, "transport");
    Ok(ITransport {
        method: reader.require_string("method")?,
        callback: reader.require_string("callback")?,
    })
}

pub fn cheer_tier_view(value: &Bson, path: &str) -> Result<ICheerTiers, StrictDecodeError> {
    let Bson::Document(document) = value else {
        return Err(StrictDecodeError {
            path: path.to_owned(),
            kind: "type",
        });
    };
    let reader = Reader::with_prefix(document, path);
    Ok(ICheerTiers {
        id: reader.require_string("id")?,
        name: reader.require_string("name")?,
        message: reader.require_string("message")?,
        min_amount: reader.require_f64("min_amount")?,
        max_amount: reader.require_f64("max_amount")?,
    })
}

pub fn cheer_tiers_view(value: &Bson) -> Result<Vec<ICheerTiers>, StrictDecodeError> {
    let Bson::Array(values) = value else {
        return Err(StrictDecodeError {
            path: "cheerTiers".to_owned(),
            kind: "type",
        });
    };
    values
        .iter()
        .enumerate()
        .map(|(index, value)| cheer_tier_view(value, &format!("cheerTiers.{index}")))
        .collect()
}

impl ICondition {
    pub fn to_bson(&self) -> Bson {
        let mut document = Document::new();
        insert_optional_string(
            &mut document,
            "broadcaster_user_id",
            &self.broadcaster_user_id,
        );
        insert_optional_string(&mut document, "user_id", &self.user_id);
        insert_optional_string(&mut document, "moderator_user_id", &self.moderator_user_id);
        insert_optional_string(
            &mut document,
            "from_broadcaster_user_id",
            &self.from_broadcaster_user_id,
        );
        insert_optional_string(
            &mut document,
            "to_broadcaster_user_id",
            &self.to_broadcaster_user_id,
        );
        Bson::Document(document)
    }
}

impl ITransport {
    pub fn to_bson(&self) -> Bson {
        let mut document = Document::new();
        insert_string(&mut document, "method", &self.method);
        insert_string(&mut document, "callback", &self.callback);
        Bson::Document(document)
    }
}

impl ICheerTiers {
    pub fn to_bson(&self) -> Bson {
        let mut document = Document::new();
        insert_string(&mut document, "id", &self.id);
        insert_string(&mut document, "name", &self.name);
        insert_string(&mut document, "message", &self.message);
        insert_f64(&mut document, "min_amount", self.min_amount);
        insert_f64(&mut document, "max_amount", self.max_amount);
        Bson::Document(document)
    }
}

impl IEventsub {
    /// Strict declared shape. Generated `_id` and raw Mixed extras are ignored.
    /// A minimized empty `condition` or `transport` fails here even though
    /// construct accepted `{}`.
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        let condition = reader.require_document("condition")?;
        let transport = reader.require_document("transport")?;
        let tiers = reader.require_array("cheerTiers")?;
        Ok(Self {
            id: reader.require_string("id")?,
            status: reader.require_string("status")?,
            event_type: reader.require_string("type")?,
            version: reader.require_string("version")?,
            condition: condition_view(&Bson::Document(condition.document().clone()))?,
            created_at: reader.require_string("created_at")?,
            transport: transport_view(&Bson::Document(transport.document().clone()))?,
            cost: reader.require_f64("cost")?,
            channel: reader.require_string("channel")?,
            channel_id: reader.require_string("channelID")?,
            enabled: reader.require_bool("enabled")?,
            message: reader.require_string("message")?,
            watch_streak_enabled: reader.optional_bool("watchStreakEnabled")?,
            modiversary_message: reader.optional_string("modiversaryMessage")?,
            modiversary_enabled: reader.optional_bool("modiversaryEnabled")?,
            end_message: reader.require_string("endMessage")?,
            end_enabled: reader.require_bool("endEnabled")?,
            min_viewers: reader.require_f64("minViewers")?,
            temporal_ban_message: reader.require_string("temporalBanMessage")?,
            clip_enabled: reader.require_bool("clipEnabled")?,
            delay: reader.require_f64("delay")?,
            cheer_tiers: tiers
                .iter()
                .enumerate()
                .map(|(index, value)| cheer_tier_view(value, &format!("cheerTiers.{index}")))
                .collect::<Result<Vec<_>, _>>()?,
            today_follows: reader.optional_bool("todayFollows")?,
            remote_missing_since: reader.nullable_datetime("remote_missing_since")?,
        })
    }

    /// Owned BSON for the declared fields. Omitted options stay omitted.
    /// This does not write Mixed keys that the strict view never stored.
    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "id", &self.id);
        insert_string(&mut document, "status", &self.status);
        insert_string(&mut document, "type", &self.event_type);
        insert_string(&mut document, "version", &self.version);
        document.insert("condition", self.condition.to_bson());
        insert_string(&mut document, "created_at", &self.created_at);
        document.insert("transport", self.transport.to_bson());
        insert_f64(&mut document, "cost", self.cost);
        insert_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "channelID", &self.channel_id);
        document.insert("enabled", self.enabled);
        insert_string(&mut document, "message", &self.message);
        if let Some(value) = self.watch_streak_enabled {
            document.insert("watchStreakEnabled", value);
        }
        insert_optional_string(
            &mut document,
            "modiversaryMessage",
            &self.modiversary_message,
        );
        if let Some(value) = self.modiversary_enabled {
            document.insert("modiversaryEnabled", value);
        }
        insert_string(&mut document, "endMessage", &self.end_message);
        document.insert("endEnabled", self.end_enabled);
        insert_f64(&mut document, "minViewers", self.min_viewers);
        insert_string(
            &mut document,
            "temporalBanMessage",
            &self.temporal_ban_message,
        );
        document.insert("clipEnabled", self.clip_enabled);
        insert_f64(&mut document, "delay", self.delay);
        document.insert(
            "cheerTiers",
            Bson::Array(self.cheer_tiers.iter().map(ICheerTiers::to_bson).collect()),
        );
        if let Some(value) = self.today_follows {
            document.insert("todayFollows", value);
        }
        insert_nullable_datetime(
            &mut document,
            "remote_missing_since",
            self.remote_missing_since,
        );
        document
    }
}

/// The schema still generates an ObjectId. The interface does not declare it.
pub fn document_id(document: &Document) -> Option<ObjectId> {
    document.get_object_id("_id").ok()
}
