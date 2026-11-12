//! `eventsubs`: one Twitch EventSub subscription of a channel, with the bot's settings for the
//! event it delivers (messages, toggles, cheer tiers).
//!
//! Reference: `dimabot/src/schemas/eventsub.schema.ts`. No timestamps (`created_at` is Twitch's
//! text), `__v`, no hooks. Indexes `{channelID, type}` and `{id}`.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::defaults::{empty, yes, zero};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "eventsubs";

/// The schema, field by field as `eventsub.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("id"),
    Field::string("status"),
    Field::string("type"),
    Field::string("version"),
    Field::mixed("condition"),
    Field::string("created_at"),
    Field::mixed("transport"),
    Field::number("cost"),
    Field::string("channel"),
    Field::string("channelID"),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::string("message").default(D::Str("")),
    Field::boolean("watchStreakEnabled").default(D::Bool(true)),
    Field::string("modiversaryMessage").default(D::Str("")),
    Field::boolean("modiversaryEnabled").default(D::Bool(true)),
    Field::string("endMessage").default(D::Str("")),
    Field::boolean("endEnabled").default(D::Bool(false)),
    Field::number("minViewers").default(D::Int(2)),
    Field::string("temporalBanMessage").default(D::Str("")),
    Field::boolean("clipEnabled").default(D::Bool(false)),
    Field::number("delay").default(D::Int(0)),
    Field::mixed_array("cheerTiers"),
    Field::boolean("todayFollows").default(D::Bool(false)),
    Field::date("remote_missing_since").default(D::Null),
]);

/// The `select: false` paths (none).
pub const HIDDEN: &[&str] = &[];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("type", 1)]),
    IndexSpec::on(&[("id", 1)]),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("id"),
    Rule::required("status"),
    Rule::required("type"),
    Rule::required("version"),
    Rule::required("condition"),
    Rule::required("created_at"),
    Rule::required("transport"),
    Rule::required("cost"),
    Rule::required("channel"),
    Rule::required("channelID"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "eventsub",
    source: "dimabot/src/schemas/eventsub.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    hooks: Hooks::None,
    decode: |raw: &RawDocument| decode::<Eventsub>(raw).map(drop),
};

/// A stored subscription, defaults filled in as a hydrated Mongoose document shows them.
#[derive(Clone, Debug, Deserialize)]
pub struct Eventsub {
    /// `_id`.
    #[serde(rename = "_id")]
    pub object_id: ObjectId,
    /// Twitch's subscription id.
    pub id: String,
    /// Twitch's status (`enabled`, `webhook_callback_verification_pending`...).
    pub status: String,
    /// The subscription type (`channel.follow`...).
    #[serde(rename = "type")]
    pub kind: String,
    /// The subscription version.
    pub version: String,
    /// Twitch's condition object.
    pub condition: EventsubCondition,
    /// Twitch's creation time, as Twitch's text.
    pub created_at: String,
    /// Twitch's transport object.
    pub transport: EventsubTransport,
    /// Twitch's cost.
    pub cost: JsNumber,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The bot reacts to the event.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The chat message for the event.
    #[serde(default = "empty")]
    pub message: String,
    /// Watch-streak messages on.
    #[serde(default = "yes", rename = "watchStreakEnabled")]
    pub watch_streak_enabled: bool,
    /// The moderator-anniversary message.
    #[serde(default = "empty", rename = "modiversaryMessage")]
    pub modiversary_message: String,
    /// Moderator-anniversary messages on.
    #[serde(default = "yes", rename = "modiversaryEnabled")]
    pub modiversary_enabled: bool,
    /// The message when the event ends.
    #[serde(default = "empty", rename = "endMessage")]
    pub end_message: String,
    /// End messages on.
    #[serde(default, rename = "endEnabled")]
    pub end_enabled: bool,
    /// Minimum viewers for the event to count.
    #[serde(default = "two", rename = "minViewers")]
    pub min_viewers: JsNumber,
    /// The message of a temporary ban.
    #[serde(default = "empty", rename = "temporalBanMessage")]
    pub temporal_ban_message: String,
    /// Clip on the event.
    #[serde(default, rename = "clipEnabled")]
    pub clip_enabled: bool,
    /// Delay before reacting.
    #[serde(default = "zero")]
    pub delay: JsNumber,
    /// Cheer tiers, as the site stored them.
    #[serde(default, rename = "cheerTiers")]
    pub cheer_tiers: CheerTiers,
    /// Count today's follows.
    #[serde(default, rename = "todayFollows")]
    pub today_follows: bool,
    /// When Twitch stopped listing the subscription.
    #[serde(default)]
    pub remote_missing_since: Option<JsDate>,
}

fn two() -> JsNumber {
    JsNumber(2.0)
}

/// Twitch's `condition` object (`broadcaster_user_id`, `reward_id`...), kept as stored until the
/// EventSub package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct EventsubCondition(pub Bson);

impl EventsubCondition {
    /// A string field of the condition (`broadcaster_user_id`).
    pub fn get_str(&self, key: &str) -> Option<&str> {
        match &self.0 {
            Bson::Document(document) => document.get_str(key).ok(),
            _ => None,
        }
    }
}

/// Twitch's `transport` object (`{method, callback}`), kept as stored.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct EventsubTransport(pub Bson);

/// The cheer tiers (`{id, name, message, minAmount, maxAmount}` objects as the site writes them;
/// the TypeScript interface's snake-case names are not what is stored), kept as stored.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CheerTiers(pub Vec<Bson>);

/// A new subscription record. The required fields are the constructor's; the rest default.
#[derive(Clone, Debug, Serialize)]
pub struct NewEventsub {
    /// Twitch's subscription id.
    pub id: String,
    /// Twitch's status.
    pub status: String,
    /// The subscription type.
    #[serde(rename = "type")]
    pub kind: String,
    /// The subscription version.
    pub version: String,
    /// Twitch's condition.
    pub condition: Document,
    /// Twitch's creation time text.
    pub created_at: String,
    /// Twitch's transport.
    pub transport: Document,
    /// Twitch's cost.
    pub cost: JsNumber,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// Enabled (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The chat message (default empty).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl NewEventsub {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
