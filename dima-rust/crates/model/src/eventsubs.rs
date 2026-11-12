//! `eventsubs`: one Twitch EventSub subscription of a channel, with the bot's settings for the
//! event it delivers (messages, toggles, cheer tiers).
//!
//! Reference: `dimabot/src/schemas/eventsub.schema.ts`. No timestamps (`created_at` is Twitch's
//! text), `__v`, no hooks. Indexes `{channelID, type}` and `{id}`.
//!
//! Client-fed writes: `server/services/eventsub_config.service.ts:477` (`PATCH
//! /eventsubs/:channelID/:id` and the site assistant's event tools) passes the request body to
//! `findOneAndUpdate` as given (only `type` and the cheer tiers are normalised): any path, the
//! identity fields included, can be set to `null` (also through a dotted key). Every field of
//! the read type is therefore an `Option` (a path with a default reads the default when missing
//! and `None` when `null`), [`READ_NEEDS`] is empty, and the accessors give what the reference's
//! truthiness checks saw (`if (!eventsub.enabled)`). No client write removes a path.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type
//! (Mongoose would cast it; the API casts before it writes).

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{js_number, some_empty, some_no, some_yes, some_zero};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document};
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

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[];

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
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::Every,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<Eventsub>,
};

/// A stored subscription, defaults filled in as a hydrated Mongoose document shows them.
#[derive(Clone, Debug, Deserialize)]
pub struct Eventsub {
    /// `_id`.
    #[serde(rename = "_id")]
    pub object_id: ObjectId,
    /// Twitch's subscription id.
    #[serde(default)]
    pub id: Option<String>,
    /// Twitch's status (`enabled`, `webhook_callback_verification_pending`...).
    #[serde(default)]
    pub status: Option<String>,
    /// The subscription type (`channel.follow`...).
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// The subscription version.
    #[serde(default)]
    pub version: Option<String>,
    /// Twitch's condition object.
    #[serde(default)]
    pub condition: EventsubCondition,
    /// Twitch's creation time, as Twitch's text.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Twitch's transport object.
    #[serde(default)]
    pub transport: EventsubTransport,
    /// Twitch's cost.
    #[serde(default)]
    pub cost: Option<JsNumber>,
    /// The channel login.
    #[serde(default)]
    pub channel: Option<String>,
    /// The channel id.
    #[serde(default, rename = "channelID")]
    pub channel_id: Option<String>,
    /// The bot reacts to the event (default `true`).
    #[serde(default = "some_yes")]
    pub enabled: Option<bool>,
    /// The chat message for the event (default empty).
    #[serde(default = "some_empty")]
    pub message: Option<String>,
    /// Watch-streak messages on (default `true`).
    #[serde(default = "some_yes", rename = "watchStreakEnabled")]
    pub watch_streak_enabled: Option<bool>,
    /// The moderator-anniversary message (default empty).
    #[serde(default = "some_empty", rename = "modiversaryMessage")]
    pub modiversary_message: Option<String>,
    /// Moderator-anniversary messages on (default `true`).
    #[serde(default = "some_yes", rename = "modiversaryEnabled")]
    pub modiversary_enabled: Option<bool>,
    /// The message when the event ends (default empty).
    #[serde(default = "some_empty", rename = "endMessage")]
    pub end_message: Option<String>,
    /// End messages on (default `false`).
    #[serde(default = "some_no", rename = "endEnabled")]
    pub end_enabled: Option<bool>,
    /// Minimum viewers for the event to count (default 2).
    #[serde(default = "some_two", rename = "minViewers")]
    pub min_viewers: Option<JsNumber>,
    /// The message of a temporary ban (default empty).
    #[serde(default = "some_empty", rename = "temporalBanMessage")]
    pub temporal_ban_message: Option<String>,
    /// Clip on the event (default `false`).
    #[serde(default = "some_no", rename = "clipEnabled")]
    pub clip_enabled: Option<bool>,
    /// Delay before reacting (default 0).
    #[serde(default = "some_zero")]
    pub delay: Option<JsNumber>,
    /// Cheer tiers, as the site stored them (missing: empty).
    #[serde(default = "no_tiers", rename = "cheerTiers")]
    pub cheer_tiers: Option<CheerTiers>,
    /// Count today's follows (default `false`).
    #[serde(default = "some_no", rename = "todayFollows")]
    pub today_follows: Option<bool>,
    /// When Twitch stopped listing the subscription.
    #[serde(default)]
    pub remote_missing_since: Option<JsDate>,
}

fn some_two() -> Option<JsNumber> {
    Some(JsNumber(2.0))
}

fn no_tiers() -> Option<CheerTiers> {
    Some(CheerTiers::default())
}

/// What the reference's truthiness checks see (`null` is falsy, `Number(null)` is 0).
impl Eventsub {
    /// `eventsub.enabled` as a condition.
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(false)
    }

    /// `eventsub.message || ''`.
    pub fn message_text(&self) -> &str {
        self.message.as_deref().unwrap_or("")
    }

    /// `eventsub.watchStreakEnabled` as a condition.
    pub fn is_watch_streak_enabled(&self) -> bool {
        self.watch_streak_enabled.unwrap_or(false)
    }

    /// `eventsub.modiversaryMessage || ''`.
    pub fn modiversary_message_text(&self) -> &str {
        self.modiversary_message.as_deref().unwrap_or("")
    }

    /// `eventsub.modiversaryEnabled` as a condition.
    pub fn is_modiversary_enabled(&self) -> bool {
        self.modiversary_enabled.unwrap_or(false)
    }

    /// `eventsub.endMessage || ''`.
    pub fn end_message_text(&self) -> &str {
        self.end_message.as_deref().unwrap_or("")
    }

    /// `eventsub.endEnabled` as a condition.
    pub fn is_end_enabled(&self) -> bool {
        self.end_enabled.unwrap_or(false)
    }

    /// `eventsub.temporalBanMessage || ''`.
    pub fn temporal_ban_message_text(&self) -> &str {
        self.temporal_ban_message.as_deref().unwrap_or("")
    }

    /// `eventsub.clipEnabled` as a condition.
    pub fn is_clip_enabled(&self) -> bool {
        self.clip_enabled.unwrap_or(false)
    }

    /// `eventsub.todayFollows` as a condition.
    pub fn is_today_follows(&self) -> bool {
        self.today_follows.unwrap_or(false)
    }

    /// `eventsub.minViewers` in a comparison (`null` is 0).
    pub fn min_viewers_number(&self) -> f64 {
        js_number(self.min_viewers.as_ref())
    }

    /// `eventsub.delay` in arithmetic (`null` is 0).
    pub fn delay_number(&self) -> f64 {
        js_number(self.delay.as_ref())
    }

    /// The cheer tiers (`null`: none).
    pub fn cheer_tier_list(&self) -> &[Bson] {
        self.cheer_tiers
            .as_ref()
            .map_or(&[], |tiers| tiers.0.as_slice())
    }
}

/// Twitch's `condition` object (`broadcaster_user_id`, `reward_id`...), kept as stored until the
/// EventSub package types it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
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
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
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
