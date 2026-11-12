//! `site_analytics`: the one snapshot of the public site's counters (registered users, live
//! channels and their viewers, messages and commands), rewritten every few minutes.
//!
//! Reference: `dimabot/src/schemas/site_analytics.schema.ts` (model `site_analytics`). Snake-case
//! timestamps, `__v`, no hooks. Unique `singletonKey` (field level, default `global`): the
//! persistence worker upserts on it (`utils/siteanalytics.ts:442`), so a missing index would only
//! let two snapshots exist; best effort, like the reference (nothing awaits it). `liveChannels`
//! elements have no `_id`.
//!
//! Intended differences (`crate::shape`): the write helpers refuse a value of the wrong BSON
//! type, and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of
//! the production copy shows none stored there, so Mongoose's acceptance of them is not
//! reproduced. The `enum` of each `liveChannels[].botPlatforms` element is not checked on create
//! or save (the validators here have no element rules for arrays of values; the reference only
//! writes the snapshot with an update, which does not validate).

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::users::PlanTier;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "site_analytics";

/// The key of the one snapshot.
pub const SINGLETON_KEY: &str = "global";

str_enum! {
    /// `liveChannels[].botPlatforms[]`.
    pub enum BotPlatform {
        /// Twitch.
        Twitch = "twitch",
        /// Kick.
        Kick = "kick",
    }
}

static LIVE_CHANNEL: Schema = Schema::subdocument(&[
    Field::string("channelID").default(D::Str("")),
    Field::string("channel").default(D::Str("")),
    Field::string("streamId").default(D::Str("")),
    Field::string("title").default(D::Str("")),
    Field::string("gameName").default(D::Str("")),
    Field::number("viewers").default(D::Int(0)),
    Field::string("profileImageUrl").default(D::Str("")),
    Field::string("startedAt").default(D::Str("")),
    Field::string("fetchedAt").default(D::Str("")),
    Field::array("botPlatforms", ValueType::String).default(D::EmptyArray),
    Field::string("planTier").default(D::Str("free")),
])
.no_id();

/// The schema, field by field as `site_analytics.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("singletonKey").default(D::Str(SINGLETON_KEY)),
    Field::number("registeredUsers").default(D::Int(0)),
    Field::number("liveUsers").default(D::Int(0)),
    Field::number("totalLiveViewers").default(D::Int(0)),
    Field::number("authorizedAccounts").default(D::Int(0)),
    Field::number("totalMessages").default(D::Int(0)),
    Field::number("totalCommands").default(D::Int(0)),
    Field::document_array("liveChannels", &LIVE_CHANNEL).default(D::EmptyArray),
])
.timestamps(Timestamps::SNAKE);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("singletonKey", 1)]).unique()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("singletonKey"),
    Rule::one_of("liveChannels.$.planTier", PlanTier::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("singletonKey"),
    ReadNeed::not_null("registeredUsers"),
    ReadNeed::not_null("liveUsers"),
    ReadNeed::not_null("totalLiveViewers"),
    ReadNeed::not_null("authorizedAccounts"),
    ReadNeed::not_null("totalMessages"),
    ReadNeed::not_null("totalCommands"),
    ReadNeed::not_null("liveChannels"),
    ReadNeed::not_null("liveChannels.$.channelID"),
    ReadNeed::not_null("liveChannels.$.channel"),
    ReadNeed::not_null("liveChannels.$.streamId"),
    ReadNeed::not_null("liveChannels.$.title"),
    ReadNeed::not_null("liveChannels.$.gameName"),
    ReadNeed::not_null("liveChannels.$.viewers"),
    ReadNeed::not_null("liveChannels.$.profileImageUrl"),
    ReadNeed::not_null("liveChannels.$.startedAt"),
    ReadNeed::not_null("liveChannels.$.fetchedAt"),
    ReadNeed::not_null("liveChannels.$.botPlatforms"),
    ReadNeed::not_null("liveChannels.$.planTier"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "site_analytics",
    source: "dimabot/src/schemas/site_analytics.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<SiteAnalytics>,
};

/// The stored snapshot.
#[derive(Clone, Debug, Deserialize)]
pub struct SiteAnalytics {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// Always `global`.
    #[serde(default = "global", rename = "singletonKey")]
    pub singleton_key: String,
    /// Registered users.
    #[serde(default = "zero", rename = "registeredUsers")]
    pub registered_users: JsNumber,
    /// Users live now.
    #[serde(default = "zero", rename = "liveUsers")]
    pub live_users: JsNumber,
    /// Viewers of the live channels.
    #[serde(default = "zero", rename = "totalLiveViewers")]
    pub total_live_viewers: JsNumber,
    /// Accounts that authorised the bot.
    #[serde(default = "zero", rename = "authorizedAccounts")]
    pub authorized_accounts: JsNumber,
    /// Messages handled.
    #[serde(default = "zero", rename = "totalMessages")]
    pub total_messages: JsNumber,
    /// Commands run.
    #[serde(default = "zero", rename = "totalCommands")]
    pub total_commands: JsNumber,
    /// The live channels shown on the site.
    #[serde(default, rename = "liveChannels")]
    pub live_channels: Vec<LiveChannel>,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

fn global() -> String {
    SINGLETON_KEY.to_owned()
}

/// `liveChannels[]`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LiveChannel {
    /// The channel id.
    #[serde(default = "empty", rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(default = "empty")]
    pub channel: String,
    /// The Twitch stream id.
    #[serde(default = "empty", rename = "streamId")]
    pub stream_id: String,
    /// The stream title.
    #[serde(default = "empty")]
    pub title: String,
    /// The category.
    #[serde(default = "empty", rename = "gameName")]
    pub game_name: String,
    /// Viewers.
    #[serde(default = "zero")]
    pub viewers: JsNumber,
    /// The avatar URL.
    #[serde(default = "empty", rename = "profileImageUrl")]
    pub profile_image_url: String,
    /// Stream start (ISO text, as Twitch sent it).
    #[serde(default = "empty", rename = "startedAt")]
    pub started_at: String,
    /// When the entry was fetched (ISO text).
    #[serde(default = "empty", rename = "fetchedAt")]
    pub fetched_at: String,
    /// The platforms the bot runs on for the channel.
    #[serde(default, rename = "botPlatforms")]
    pub bot_platforms: Vec<Open<BotPlatform>>,
    /// The owner's plan.
    #[serde(default = "free", rename = "planTier")]
    pub plan_tier: Open<PlanTier>,
}

fn free() -> Open<PlanTier> {
    Open::Known(PlanTier::Free)
}

/// A new snapshot (the reference upserts it; kept for the tests and the rig). Unset fields take
/// the schema defaults.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewSiteAnalytics {
    /// The key (default `global`).
    #[serde(rename = "singletonKey", skip_serializing_if = "Option::is_none")]
    pub singleton_key: Option<String>,
    /// Registered users.
    #[serde(rename = "registeredUsers", skip_serializing_if = "Option::is_none")]
    pub registered_users: Option<JsNumber>,
    /// Users live now.
    #[serde(rename = "liveUsers", skip_serializing_if = "Option::is_none")]
    pub live_users: Option<JsNumber>,
    /// Viewers of the live channels.
    #[serde(rename = "totalLiveViewers", skip_serializing_if = "Option::is_none")]
    pub total_live_viewers: Option<JsNumber>,
    /// Accounts that authorised the bot.
    #[serde(rename = "authorizedAccounts", skip_serializing_if = "Option::is_none")]
    pub authorized_accounts: Option<JsNumber>,
    /// Messages handled.
    #[serde(rename = "totalMessages", skip_serializing_if = "Option::is_none")]
    pub total_messages: Option<JsNumber>,
    /// Commands run.
    #[serde(rename = "totalCommands", skip_serializing_if = "Option::is_none")]
    pub total_commands: Option<JsNumber>,
    /// The live channels.
    #[serde(rename = "liveChannels", skip_serializing_if = "Option::is_none")]
    pub live_channels: Option<Vec<NewLiveChannel>>,
}

/// A live channel of a new snapshot. Unset fields take the schema defaults.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewLiveChannel {
    /// The channel id.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The channel login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// The Twitch stream id.
    #[serde(rename = "streamId", skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    /// The stream title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The category.
    #[serde(rename = "gameName", skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    /// Viewers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewers: Option<JsNumber>,
    /// The avatar URL.
    #[serde(rename = "profileImageUrl", skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
    /// Stream start (ISO text).
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// When the entry was fetched (ISO text).
    #[serde(rename = "fetchedAt", skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    /// The platforms the bot runs on.
    #[serde(rename = "botPlatforms", skip_serializing_if = "Option::is_none")]
    pub bot_platforms: Option<Vec<BotPlatform>>,
    /// The owner's plan.
    #[serde(rename = "planTier", skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<PlanTier>,
}

impl NewSiteAnalytics {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
