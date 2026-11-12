//! `redemptionrewards`: a channel-points reward the bot created on Twitch, with what happens when
//! it is redeemed (message, cost changes, cooldown).
//!
//! Reference: `dimabot/src/schemas/redemption_reward.schema.ts` (model `redemptionreward`) plus
//! the availability fields and hooks on `isEnabled` (`crate::availability`). No timestamps,
//! `__v`. Writes go through this module ([`prepare_update`], [`prepare_find_one_and_update`],
//! [`prepare_save`], [`NewRedemptionReward::prepare`]).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::availability::{self, AvailabilityLease, AvailabilityState, Writer};
use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::defaults::{empty, yes, zero};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::writes::{find_and_update_unchecked, save_with_hooks, update_unchecked};
use bson::oid::ObjectId;
use bson::{Document, RawDocument};
use dima_core::Random;
use dima_store::mongo::WriteContext;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::update::{PreparedFindAndModify, PreparedUpdate, Returned, UpdateOptions};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "redemptionrewards";

/// The enabled field the availability hook watches.
const ENABLED: &str = "isEnabled";

static SCHEMA: Schema = Schema::new(&[
    Field::string("eventsubID"),
    Field::string("channelID"),
    Field::string("channel"),
    Field::string("rewardID"),
    Field::string("title"),
    Field::string("type").default(D::Str("custom")),
    Field::string("prompt").default(D::Str("")),
    Field::number("originalCost"),
    Field::number("cost"),
    Field::boolean("isEnabled").default(D::Bool(true)),
    Field::string("message").default(D::Str("")),
    Field::number("costChange").default(D::Int(0)),
    Field::boolean("returnToOriginalCost").default(D::Bool(false)),
    Field::number("duration").default(D::Int(0)),
    Field::number("cooldown").default(D::Int(0)),
    Field::string("backgroundColor"),
    Field::string("createdFrom").default(D::Str("domdimabot")),
    Field::string("createdFor").default(D::Str("twitch")),
    availability::STATE_FIELD,
    availability::LEASE_FIELD,
]);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("availability.nextAt", 1)]).sparse()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("eventsubID"),
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("rewardID"),
    Rule::required("title"),
    Rule::required("originalCost"),
    Rule::required("cost"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("eventsubID"),
    ReadNeed::value("channelID"),
    ReadNeed::value("channel"),
    ReadNeed::value("rewardID"),
    ReadNeed::value("title"),
    ReadNeed::not_null("type"),
    ReadNeed::not_null("prompt"),
    ReadNeed::value("originalCost"),
    ReadNeed::value("cost"),
    ReadNeed::not_null("isEnabled"),
    ReadNeed::not_null("message"),
    ReadNeed::not_null("costChange"),
    ReadNeed::not_null("returnToOriginalCost"),
    ReadNeed::not_null("duration"),
    ReadNeed::not_null("cooldown"),
    ReadNeed::not_null("createdFrom"),
    ReadNeed::not_null("createdFor"),
];

/// The registry entry. Every write goes through this module (the availability hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "redemptionreward",
    source: "dimabot/src/schemas/redemption_reward.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: availability::HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::UpdatesAndSave,
    decode: |raw: &RawDocument| decode::<RedemptionReward>(raw).map(drop),
};

/// A stored reward.
#[derive(Clone, Debug, Deserialize)]
pub struct RedemptionReward {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The EventSub subscription that delivers its redemptions.
    #[serde(rename = "eventsubID")]
    pub eventsub_id: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// Twitch's reward id.
    #[serde(rename = "rewardID")]
    pub reward_id: String,
    /// The title.
    pub title: String,
    /// The bot's reward kind.
    #[serde(default = "custom", rename = "type")]
    pub kind: String,
    /// The prompt shown to viewers.
    #[serde(default = "empty")]
    pub prompt: String,
    /// The cost it returns to.
    #[serde(rename = "originalCost")]
    pub original_cost: JsNumber,
    /// The current cost.
    pub cost: JsNumber,
    /// Enabled on Twitch.
    #[serde(default = "yes", rename = "isEnabled")]
    pub is_enabled: bool,
    /// The chat message on redemption.
    #[serde(default = "empty")]
    pub message: String,
    /// Cost change per redemption.
    #[serde(default = "zero", rename = "costChange")]
    pub cost_change: JsNumber,
    /// Return to the original cost afterwards.
    #[serde(default, rename = "returnToOriginalCost")]
    pub return_to_original_cost: bool,
    /// Effect duration.
    #[serde(default = "zero")]
    pub duration: JsNumber,
    /// Cooldown.
    #[serde(default = "zero")]
    pub cooldown: JsNumber,
    /// Background colour.
    #[serde(default, rename = "backgroundColor")]
    pub background_color: Option<String>,
    /// Who created it on Twitch (missing on older documents: `domdimabot`).
    #[serde(default = "domdimabot", rename = "createdFrom")]
    pub created_from: String,
    /// The platform (missing on older documents: `twitch`).
    #[serde(default = "twitch", rename = "createdFor")]
    pub created_for: String,
    /// Scheduled availability (`select: false`).
    #[serde(default)]
    pub availability: Option<AvailabilityState>,
    /// Availability synchronisation lease (`select: false`).
    #[serde(default, rename = "availabilityLease")]
    pub availability_lease: Option<AvailabilityLease>,
}

fn custom() -> String {
    "custom".to_owned()
}

fn domdimabot() -> String {
    "domdimabot".to_owned()
}

fn twitch() -> String {
    "twitch".to_owned()
}

/// A new reward record.
#[derive(Clone, Debug, Serialize)]
pub struct NewRedemptionReward {
    /// The EventSub subscription.
    #[serde(rename = "eventsubID")]
    pub eventsub_id: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// Twitch's reward id.
    #[serde(rename = "rewardID")]
    pub reward_id: String,
    /// The title.
    pub title: String,
    /// The cost it returns to.
    #[serde(rename = "originalCost")]
    pub original_cost: JsNumber,
    /// The current cost.
    pub cost: JsNumber,
    /// The bot's reward kind (default `custom`).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The chat message (default empty).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Enabled (default `true`).
    #[serde(rename = "isEnabled", skip_serializing_if = "Option::is_none")]
    pub is_enabled: Option<bool>,
}

impl NewRedemptionReward {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

/// `Model.updateOne` / `updateMany` with the availability hook (unless `writer` is internal).
pub fn prepare_update(
    filter: &Document,
    mut update: Document,
    options: UpdateOptions,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedUpdate, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    update_unchecked(&INFO, filter, update.into(), options, ctx)
}

/// `Model.findOneAndUpdate` with the availability hook (unless `writer` is internal).
pub fn prepare_find_one_and_update(
    filter: &Document,
    mut update: Document,
    options: UpdateOptions,
    returned: Returned,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedFindAndModify, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    find_and_update_unchecked(&INFO, filter, update.into(), options, returned, ctx)
}

/// `doc.save()` of a loaded reward (read without projection) after `changes`, with the save hook.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedSave, ModelError> {
    save_with_hooks(
        &INFO,
        loaded,
        changes,
        |loaded, changes, ctx| {
            Ok(availability::guard_save(
                loaded,
                changes,
                ENABLED,
                ctx.now_ms(),
                random,
            )?)
        },
        ctx,
    )
}
