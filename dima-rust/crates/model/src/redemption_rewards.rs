//! `redemptionrewards`: a channel-points reward the bot created on Twitch, with what happens when
//! it is redeemed (message, cost changes, cooldown).
//!
//! Reference: `dimabot/src/schemas/redemption_reward.schema.ts` (model `redemptionreward`) plus
//! the availability fields and hooks on `isEnabled` (`crate::availability`). No timestamps,
//! `__v`. Writes go through this module ([`prepare_update`], [`prepare_find_one_and_update`],
//! [`prepare_save`], [`NewRedemptionReward::prepare`]).
//!
//! Client-fed writes: `server/routes/reward.route.ts:363` (`PATCH /rewards/:channelID/:id`) and
//! the site assistant's reward edit (`site_agent/tools/stream.ts:335`) pass the request body to
//! `findOneAndUpdate` as given (only the cooldown and limits are range-checked, and `null` passes
//! them); `server/routes/trigger.route.ts:1448` copies ten fields `!== undefined`, `null`
//! included. Any path, the identity fields included, can therefore be `null`: every field of the
//! read type is an `Option` (a path with a default reads the default when missing and `None`
//! when `null`), [`READ_NEEDS`] is empty, and the accessors give what the reference's checks saw.
//! The create path (`server/services/reward_creation.service.ts:222`) builds every value from
//! Twitch's reply or with `||` defaults. No client write removes a path.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type
//! (Mongoose would cast it; the API casts before it writes).

use crate::availability::{self, AvailabilityLease, AvailabilityState, Writer};
use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;

use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::writes::{find_and_update_after_hooks, save_with_hooks, update_after_hooks};
use bson::Document;
use bson::oid::ObjectId;
use dima_core::Random;
use dima_store::mongo::WriteContext;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::update::{PreparedFindAndModify, PreparedUpdate, Returned};
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

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["availability", "availabilityLease"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[];

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
    client_nulls: ClientNulls::Every,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<RedemptionReward>,
};

/// A stored reward.
#[derive(Clone, Debug, Deserialize)]
pub struct RedemptionReward {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The EventSub subscription that delivers its redemptions.
    #[serde(default, rename = "eventsubID")]
    pub eventsub_id: Option<String>,
    /// The channel id.
    #[serde(default, rename = "channelID")]
    pub channel_id: Option<String>,
    /// The channel login.
    #[serde(default)]
    pub channel: Option<String>,
    /// Twitch's reward id.
    #[serde(default, rename = "rewardID")]
    pub reward_id: Option<String>,
    /// The title.
    #[serde(default)]
    pub title: Option<String>,
    /// The bot's reward kind (default `custom`).
    #[serde(default = "custom", rename = "type")]
    pub kind: Option<String>,
    /// The prompt shown to viewers (default empty).
    #[serde(default = "crate::defaults::some_empty")]
    pub prompt: Option<String>,
    /// The cost it returns to.
    #[serde(default, rename = "originalCost")]
    pub original_cost: Option<JsNumber>,
    /// The current cost.
    #[serde(default)]
    pub cost: Option<JsNumber>,
    /// Enabled on Twitch (default `true`).
    #[serde(default = "crate::defaults::some_yes", rename = "isEnabled")]
    pub is_enabled: Option<bool>,
    /// The chat message on redemption (default empty).
    #[serde(default = "crate::defaults::some_empty")]
    pub message: Option<String>,
    /// Cost change per redemption (default 0).
    #[serde(default = "crate::defaults::some_zero", rename = "costChange")]
    pub cost_change: Option<JsNumber>,
    /// Return to the original cost afterwards (default `false`).
    #[serde(default = "crate::defaults::some_no", rename = "returnToOriginalCost")]
    pub return_to_original_cost: Option<bool>,
    /// Effect duration (default 0).
    #[serde(default = "crate::defaults::some_zero")]
    pub duration: Option<JsNumber>,
    /// Cooldown (default 0).
    #[serde(default = "crate::defaults::some_zero")]
    pub cooldown: Option<JsNumber>,
    /// Background colour.
    #[serde(default, rename = "backgroundColor")]
    pub background_color: Option<String>,
    /// Who created it on Twitch (missing on older documents: `domdimabot`).
    #[serde(default = "domdimabot", rename = "createdFrom")]
    pub created_from: Option<String>,
    /// The platform (missing on older documents: `twitch`).
    #[serde(default = "twitch", rename = "createdFor")]
    pub created_for: Option<String>,
    /// Scheduled availability (`select: false`).
    #[serde(default)]
    pub availability: Option<Private<AvailabilityState>>,
    /// Availability synchronisation lease (`select: false`).
    #[serde(default, rename = "availabilityLease")]
    pub availability_lease: Option<Private<AvailabilityLease>>,
}

fn custom() -> Option<String> {
    Some("custom".to_owned())
}

fn domdimabot() -> Option<String> {
    Some("domdimabot".to_owned())
}

fn twitch() -> Option<String> {
    Some("twitch".to_owned())
}

/// What the reference's checks see (`null` is falsy, `Number(null)` is 0).
impl RedemptionReward {
    /// `reward.isEnabled` as a condition.
    pub fn is_enabled_now(&self) -> bool {
        self.is_enabled.unwrap_or(false)
    }

    /// `reward.message || ''`.
    pub fn message_text(&self) -> &str {
        self.message.as_deref().unwrap_or("")
    }

    /// `reward.returnToOriginalCost` as a condition.
    pub fn returns_to_original_cost(&self) -> bool {
        self.return_to_original_cost.unwrap_or(false)
    }

    /// `reward.cost` in arithmetic.
    pub fn cost_number(&self) -> f64 {
        crate::defaults::js_number(self.cost.as_ref())
    }

    /// `reward.originalCost` in arithmetic.
    pub fn original_cost_number(&self) -> f64 {
        crate::defaults::js_number(self.original_cost.as_ref())
    }

    /// `reward.costChange` in arithmetic.
    pub fn cost_change_number(&self) -> f64 {
        crate::defaults::js_number(self.cost_change.as_ref())
    }

    /// `reward.duration` in arithmetic.
    pub fn duration_number(&self) -> f64 {
        crate::defaults::js_number(self.duration.as_ref())
    }

    /// `reward.cooldown` in arithmetic.
    pub fn cooldown_number(&self) -> f64 {
        crate::defaults::js_number(self.cooldown.as_ref())
    }
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
    options: impl Into<crate::UpdateOptions>,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedUpdate, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    update_after_hooks(&INFO, filter, update.into(), options.into(), ctx)
}

/// `Model.findOneAndUpdate` with the availability hook (unless `writer` is internal).
pub fn prepare_find_one_and_update(
    filter: &Document,
    mut update: Document,
    options: impl Into<crate::UpdateOptions>,
    returned: Returned,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedFindAndModify, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    find_and_update_after_hooks(&INFO, filter, update.into(), options.into(), returned, ctx)
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
