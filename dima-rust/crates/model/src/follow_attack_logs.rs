//! Follow attack audit records. Reference: `dimabot/src/schemas/follow_attack_log.schema.ts`.
//! Camel-case timestamps, __v, no hooks or runValidators calls. Client-fed null paths: none:
//! utils/follow_defense.ts:313 constructs the record from normalized queue events;
//! utils/follow_defense_actions.ts:186 updates ban outcomes from the executor, not request bodies.
//! Legacy: trackedFollows banStatus/banMessage are absent in the census; missing optional raidInfo
//! is accepted. Server-only nulls/removals in READ_NEEDS are intentionally refused.
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
str_enum! { /// `modeTriggered`.
pub enum Modetriggered {/// `silent`.
Silent="silent",/// `protection`.
Protection="protection",/// `attack`.
Attack="attack"}}
str_enum! { /// `triggeredBy`.
pub enum Triggeredby {/// `threshold`.
Threshold="threshold",/// `manual`.
Manual="manual"}}
fn default_target_channel_login() -> String {
    String::new()
}
fn default_target_channel_name() -> String {
    String::new()
}
fn default_total_follows() -> JsNumber {
    JsNumber(0.0)
}
fn default_velocity() -> JsNumber {
    JsNumber(0.0)
}
fn default_duration_seconds() -> JsNumber {
    JsNumber(0.0)
}
fn default_is_raid() -> bool {
    false
}
fn default_raid_info_raider_channel_login() -> String {
    String::new()
}
fn default_raid_info_raider_channel_name() -> String {
    String::new()
}
fn default_raid_info_raid_viewers() -> JsNumber {
    JsNumber(0.0)
}
static SCHEMA_RAID_INFO: Schema = Schema::subdocument(&[
    Field::string("raiderChannelID"),
    Field::string("raiderChannelLogin").default(D::Str("")),
    Field::string("raiderChannelName").default(D::Str("")),
    Field::number("raidViewers").default(D::Int(0)),
])
.no_id();
fn default_tracked_follows_follower_login() -> String {
    String::new()
}
fn default_tracked_follows_follower_name() -> String {
    String::new()
}
fn default_tracked_follows_banned() -> bool {
    false
}
static SCHEMA_TRACKED_FOLLOWS: Schema = Schema::subdocument(&[
    Field::string("followerID"),
    Field::string("followerLogin").default(D::Str("")),
    Field::string("followerName").default(D::Str("")),
    Field::date("followedAt"),
    Field::string("eventID"),
    Field::boolean("banned").default(D::Bool(false)),
    Field::number("banStatus"),
    Field::string("banMessage"),
])
.no_id();
fn default_tracked_follows() -> Vec<FollowAttackLogTrackedFollows> {
    Vec::new()
}
fn default_is_hate_raid() -> bool {
    false
}
/// Hydrated FollowAttackLogRaidInfo.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowAttackLogRaidInfo {
    /// `raidInfo.raiderChannelID`.
    #[serde(rename = "raiderChannelID")]
    pub raider_channel_id: String,
    /// `raidInfo.raiderChannelLogin`.
    #[serde(
        rename = "raiderChannelLogin",
        default = "default_raid_info_raider_channel_login"
    )]
    pub raider_channel_login: String,
    /// `raidInfo.raiderChannelName`.
    #[serde(
        rename = "raiderChannelName",
        default = "default_raid_info_raider_channel_name"
    )]
    pub raider_channel_name: String,
    /// `raidInfo.raidViewers`.
    #[serde(rename = "raidViewers", default = "default_raid_info_raid_viewers")]
    pub raid_viewers: JsNumber,
}
/// Input FollowAttackLogRaidInfo.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowAttackLogRaidInfo {
    /// `raidInfo.raiderChannelID`.
    #[serde(rename = "raiderChannelID")]
    pub raider_channel_id: String,
    /// `raidInfo.raiderChannelLogin`.
    #[serde(rename = "raiderChannelLogin", skip_serializing_if = "Option::is_none")]
    pub raider_channel_login: Option<String>,
    /// `raidInfo.raiderChannelName`.
    #[serde(rename = "raiderChannelName", skip_serializing_if = "Option::is_none")]
    pub raider_channel_name: Option<String>,
    /// `raidInfo.raidViewers`.
    #[serde(rename = "raidViewers", skip_serializing_if = "Option::is_none")]
    pub raid_viewers: Option<JsNumber>,
}
/// Hydrated FollowAttackLogTrackedFollows.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowAttackLogTrackedFollows {
    /// `trackedFollows.$.followerID`.
    #[serde(rename = "followerID")]
    pub follower_id: String,
    /// `trackedFollows.$.followerLogin`.
    #[serde(
        rename = "followerLogin",
        default = "default_tracked_follows_follower_login"
    )]
    pub follower_login: String,
    /// `trackedFollows.$.followerName`.
    #[serde(
        rename = "followerName",
        default = "default_tracked_follows_follower_name"
    )]
    pub follower_name: String,
    /// `trackedFollows.$.followedAt`.
    #[serde(rename = "followedAt")]
    pub followed_at: JsDate,
    /// `trackedFollows.$.eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `trackedFollows.$.banned`.
    #[serde(rename = "banned", default = "default_tracked_follows_banned")]
    pub banned: bool,
    /// `trackedFollows.$.banStatus`.
    #[serde(rename = "banStatus", default)]
    pub ban_status: Option<JsNumber>,
    /// `trackedFollows.$.banMessage`.
    #[serde(rename = "banMessage", default)]
    pub ban_message: Option<String>,
}
/// Input FollowAttackLogTrackedFollows.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowAttackLogTrackedFollows {
    /// `trackedFollows.$.followerID`.
    #[serde(rename = "followerID")]
    pub follower_id: String,
    /// `trackedFollows.$.followerLogin`.
    #[serde(rename = "followerLogin", skip_serializing_if = "Option::is_none")]
    pub follower_login: Option<String>,
    /// `trackedFollows.$.followerName`.
    #[serde(rename = "followerName", skip_serializing_if = "Option::is_none")]
    pub follower_name: Option<String>,
    /// `trackedFollows.$.followedAt`.
    #[serde(rename = "followedAt")]
    pub followed_at: JsDate,
    /// `trackedFollows.$.eventID`.
    #[serde(rename = "eventID")]
    pub event_id: String,
    /// `trackedFollows.$.banned`.
    #[serde(rename = "banned", skip_serializing_if = "Option::is_none")]
    pub banned: Option<bool>,
    /// `trackedFollows.$.banStatus`.
    #[serde(rename = "banStatus", skip_serializing_if = "Option::is_none")]
    pub ban_status: Option<JsNumber>,
    /// `trackedFollows.$.banMessage`.
    #[serde(rename = "banMessage", skip_serializing_if = "Option::is_none")]
    pub ban_message: Option<String>,
}
/// Hydrated FollowAttackLog.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowAttackLog {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `targetChannelID`.
    #[serde(rename = "targetChannelID")]
    pub target_channel_id: String,
    /// `targetChannelLogin`.
    #[serde(
        rename = "targetChannelLogin",
        default = "default_target_channel_login"
    )]
    pub target_channel_login: String,
    /// `targetChannelName`.
    #[serde(rename = "targetChannelName", default = "default_target_channel_name")]
    pub target_channel_name: String,
    /// `modeTriggered`.
    #[serde(rename = "modeTriggered")]
    pub mode_triggered: Open<Modetriggered>,
    /// `triggeredBy`.
    #[serde(rename = "triggeredBy")]
    pub triggered_by: Open<Triggeredby>,
    /// `totalFollows`.
    #[serde(rename = "totalFollows", default = "default_total_follows")]
    pub total_follows: JsNumber,
    /// `velocity`.
    #[serde(rename = "velocity", default = "default_velocity")]
    pub velocity: JsNumber,
    /// `durationSeconds`.
    #[serde(rename = "durationSeconds", default = "default_duration_seconds")]
    pub duration_seconds: JsNumber,
    /// `isRaid`.
    #[serde(rename = "isRaid", default = "default_is_raid")]
    pub is_raid: bool,
    /// `raidInfo`.
    #[serde(rename = "raidInfo", default)]
    pub raid_info: Option<FollowAttackLogRaidInfo>,
    /// `trackedFollows`.
    #[serde(rename = "trackedFollows", default = "default_tracked_follows")]
    pub tracked_follows: Vec<FollowAttackLogTrackedFollows>,
    /// `isHateRaid`.
    #[serde(rename = "isHateRaid", default = "default_is_hate_raid")]
    pub is_hate_raid: bool,
    /// `createdAt`.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}
/// Input FollowAttackLog.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowAttackLog {
    /// Deterministic attack receipt id computed by utils/follow_defense.ts.
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    /// `targetChannelID`.
    #[serde(rename = "targetChannelID")]
    pub target_channel_id: String,
    /// `targetChannelLogin`.
    #[serde(rename = "targetChannelLogin", skip_serializing_if = "Option::is_none")]
    pub target_channel_login: Option<String>,
    /// `targetChannelName`.
    #[serde(rename = "targetChannelName", skip_serializing_if = "Option::is_none")]
    pub target_channel_name: Option<String>,
    /// `modeTriggered`.
    #[serde(rename = "modeTriggered")]
    pub mode_triggered: Modetriggered,
    /// `triggeredBy`.
    #[serde(rename = "triggeredBy")]
    pub triggered_by: Triggeredby,
    /// `totalFollows`.
    #[serde(rename = "totalFollows", skip_serializing_if = "Option::is_none")]
    pub total_follows: Option<JsNumber>,
    /// `velocity`.
    #[serde(rename = "velocity", skip_serializing_if = "Option::is_none")]
    pub velocity: Option<JsNumber>,
    /// `durationSeconds`.
    #[serde(rename = "durationSeconds", skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<JsNumber>,
    /// `isRaid`.
    #[serde(rename = "isRaid", skip_serializing_if = "Option::is_none")]
    pub is_raid: Option<bool>,
    /// `raidInfo`.
    #[serde(rename = "raidInfo", skip_serializing_if = "Option::is_none")]
    pub raid_info: Option<NewFollowAttackLogRaidInfo>,
    /// `trackedFollows`.
    #[serde(rename = "trackedFollows", skip_serializing_if = "Option::is_none")]
    pub tracked_follows: Option<Vec<NewFollowAttackLogTrackedFollows>>,
    /// `isHateRaid`.
    #[serde(rename = "isHateRaid", skip_serializing_if = "Option::is_none")]
    pub is_hate_raid: Option<bool>,
}
/// Collection name.
pub const COLLECTION: &str = "follow_attack_logs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("targetChannelID"),
    Field::string("targetChannelLogin").default(D::Str("")),
    Field::string("targetChannelName").default(D::Str("")),
    Field::string("modeTriggered"),
    Field::string("triggeredBy"),
    Field::number("totalFollows").default(D::Int(0)),
    Field::number("velocity").default(D::Int(0)),
    Field::number("durationSeconds").default(D::Int(0)),
    Field::boolean("isRaid").default(D::Bool(false)),
    Field::subdocument("raidInfo", &SCHEMA_RAID_INFO),
    Field::document_array("trackedFollows", &SCHEMA_TRACKED_FOLLOWS),
    Field::boolean("isHateRaid").default(D::Bool(false)),
])
.timestamps(Timestamps::CAMEL);
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("targetChannelID", 1)]),
    IndexSpec::on(&[("modeTriggered", 1)]),
    IndexSpec::on(&[("isRaid", 1)]),
    IndexSpec::on(&[("isHateRaid", 1)]),
    IndexSpec::on(&[("targetChannelID", 1), ("createdAt", -1)]),
    IndexSpec::on(&[("raidInfo.raiderChannelID", 1), ("isHateRaid", 1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("targetChannelID"),
    Rule::required("modeTriggered"),
    Rule::one_of("modeTriggered", Modetriggered::STRINGS),
    Rule::required("triggeredBy"),
    Rule::one_of("triggeredBy", Triggeredby::STRINGS),
    Rule::required("raidInfo.raiderChannelID"),
    Rule::required("trackedFollows.$.followerID"),
    Rule::required("trackedFollows.$.followedAt"),
    Rule::required("trackedFollows.$.eventID"),
];
/// Strict read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("targetChannelID"),
    ReadNeed::not_null("targetChannelLogin"),
    ReadNeed::not_null("targetChannelName"),
    ReadNeed::value("modeTriggered"),
    ReadNeed::value("triggeredBy"),
    ReadNeed::not_null("totalFollows"),
    ReadNeed::not_null("velocity"),
    ReadNeed::not_null("durationSeconds"),
    ReadNeed::not_null("isRaid"),
    ReadNeed::value("raidInfo.raiderChannelID"),
    ReadNeed::not_null("raidInfo.raiderChannelLogin"),
    ReadNeed::not_null("raidInfo.raiderChannelName"),
    ReadNeed::not_null("raidInfo.raidViewers"),
    ReadNeed::value("trackedFollows.$.followerID"),
    ReadNeed::not_null("trackedFollows.$.followerLogin"),
    ReadNeed::not_null("trackedFollows.$.followerName"),
    ReadNeed::value("trackedFollows.$.followedAt"),
    ReadNeed::value("trackedFollows.$.eventID"),
    ReadNeed::not_null("trackedFollows.$.banned"),
    ReadNeed::not_null("trackedFollows"),
    ReadNeed::not_null("isHateRaid"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_attack_log",
    source: "dimabot/src/schemas/follow_attack_log.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<FollowAttackLog>,
};
impl NewFollowAttackLog {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
