//! `channel_goals`.
//! Reference: goals/service.ts:20. String channel _id, no timestamps, __v, hooks or hidden paths.
//! Writers checked: goals/service.ts:137,145 (changeGoal),169,170 (changeTwitchGoalRule);
//! goals/completion.ts:35,45,57,72,96,111,120 (outcomes and monthly cursors).
//! Routes goals.route.ts and site_agent/tools/write/settings/goals.ts call changeGoal;
//! newGoal/goalLabel/goalInteger/goalActions/twitchGoalRule validate each client value.
//! No unchecked client-fed writes, saves or runValidators. Server-generated revisions/outcomes.
//! Legacy: outcomes, monthlyCursors and twitchActions absent; goal timestamps double, target int32.
//! Mixed goal/action/outcome/cursor content stays raw, private (names, action text and errors).
//! Reference imposes no Mixed size/depth validator; HTTP uses Express default 100 KiB JSON limit,
//! no explicit depth limit, and MongoDB's 16 MiB document ceiling. No new raw-field limit.
//! Server-only null/removal of READ_NEEDS paths is refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `goals`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelGoalsGoalsContent(pub Bson);
/// Raw `outcomes`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelGoalsOutcomesContent(pub Bson);
/// Raw `monthlyCursors`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelGoalsMonthlyCursorsContent(pub Bson);
/// Raw `twitchActions`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelGoalsTwitchActionsContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "channel_goals";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision"),
    Field::mixed_array("goals").default(D::EmptyArray),
    Field::mixed("outcomes").default_fn(D::EmptyDocument),
    Field::mixed("monthlyCursors").default_fn(D::EmptyDocument),
    Field::mixed_array("twitchActions").no_default(),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["goals", "outcomes", "monthlyCursors", "twitchActions"];
/// Declared indexes; best effort (identity uses built-in `_id_`).
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::value("_id"), ReadNeed::not_null("goals")];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ChannelGoals",
    source: "dimabot/src/goals/service.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ChannelGoals>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelGoals {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision", default)]
    pub revision: Option<JsNumber>,
    /// `goals`.
    #[serde(rename = "goals", default)]
    pub goals: Private<Vec<Option<ChannelGoalsGoalsContent>>>,
    /// `outcomes`.
    #[serde(rename = "outcomes", default)]
    pub outcomes: Option<Private<ChannelGoalsOutcomesContent>>,
    /// `monthlyCursors`.
    #[serde(rename = "monthlyCursors", default)]
    pub monthly_cursors: Option<Private<ChannelGoalsMonthlyCursorsContent>>,
    /// `twitchActions`.
    #[serde(rename = "twitchActions", default)]
    pub twitch_actions: Option<Private<Vec<Option<ChannelGoalsTwitchActionsContent>>>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelGoals {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision", skip_serializing_if = "Option::is_none")]
    pub revision: Option<JsNumber>,
    /// `goals`.
    #[serde(rename = "goals", skip_serializing_if = "Option::is_none")]
    pub goals: Option<Private<Vec<Option<ChannelGoalsGoalsContent>>>>,
    /// `outcomes`.
    #[serde(rename = "outcomes", skip_serializing_if = "Option::is_none")]
    pub outcomes: Option<Private<ChannelGoalsOutcomesContent>>,
    /// `monthlyCursors`.
    #[serde(rename = "monthlyCursors", skip_serializing_if = "Option::is_none")]
    pub monthly_cursors: Option<Private<ChannelGoalsMonthlyCursorsContent>>,
    /// `twitchActions`.
    #[serde(rename = "twitchActions", skip_serializing_if = "Option::is_none")]
    pub twitch_actions: Option<Private<Vec<Option<ChannelGoalsTwitchActionsContent>>>>,
}
impl NewChannelGoals {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
