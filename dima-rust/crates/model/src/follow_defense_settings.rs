//! `follow_defense_settings`: reference `dimabot/src/schemas/follow_defense_settings.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Reference quirk: buildSettingsPatch accepts zero for silentThresholdX, silentWindowYSeconds,
//! protectionThresholdB and silentDurationSeconds despite schema min 1; bare updates do not run
//! validators, so this stays writable/readable. attackThreshold has a separate positive check.
//! Writers: server/services/follow_defense_settings.service.ts:88,196,237 use defaults and buildSettingsPatch: booleans are type checked, numbers normalized, language validated. Nullable attackThreshold/baselineFollowsPerHour are explicit normalized values. Legacy resetAttackOnNewRaid missing on 12 records defaults true. Camel-case timestamps and __v.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_channel() -> String {
    "".into()
}
fn default_enabled() -> bool {
    true
}
fn default_silent_mode_enabled() -> bool {
    true
}
fn default_protection_mode_enabled() -> bool {
    true
}
fn default_attack_mode_enabled() -> bool {
    true
}
fn default_reset_attack_on_new_raid() -> bool {
    true
}
fn default_silent_threshold_x() -> JsNumber {
    JsNumber(10.0)
}
fn default_silent_window_y_seconds() -> JsNumber {
    JsNumber(5.0)
}
fn default_protection_threshold_b() -> JsNumber {
    JsNumber(100.0)
}
fn default_silent_duration_seconds() -> JsNumber {
    JsNumber(60.0)
}
str_enum! { /// `language`.
pub enum LanguageKind {/// `en`.
En = "en",/// `es`.
Es = "es"} }
fn default_language() -> Open<LanguageKind> {
    LanguageKind::En.into()
}
fn default_settings_version() -> JsNumber {
    JsNumber(1.0)
}
/// Collection name.
pub const COLLECTION: &str = "follow_defense_settings";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("")),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::boolean("silentModeEnabled").default(D::Bool(true)),
    Field::boolean("protectionModeEnabled").default(D::Bool(true)),
    Field::boolean("attackModeEnabled").default(D::Bool(true)),
    Field::boolean("resetAttackOnNewRaid").default(D::Bool(true)),
    Field::number("silentThresholdX").default(D::Int(10)),
    Field::number("silentWindowYSeconds").default(D::Int(5)),
    Field::number("protectionThresholdB").default(D::Int(100)),
    Field::number("attackThreshold").default(D::Null),
    Field::number("silentDurationSeconds").default(D::Int(60)),
    Field::number("baselineFollowsPerHour").default(D::Null),
    Field::string("language").default(D::Str("en")),
    Field::number("settingsVersion").default(D::Int(1)),
])
.timestamps(Timestamps::CAMEL);
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1)]).unique()];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::min("silentThresholdX", 1.0),
    Rule::min("silentWindowYSeconds", 1.0),
    Rule::min("protectionThresholdB", 1.0),
    Rule::min("attackThreshold", 1.0),
    Rule::min("silentDurationSeconds", 1.0),
    Rule::one_of("language", LanguageKind::STRINGS),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::not_null("enabled"),
    ReadNeed::not_null("silentModeEnabled"),
    ReadNeed::not_null("protectionModeEnabled"),
    ReadNeed::not_null("attackModeEnabled"),
    ReadNeed::not_null("resetAttackOnNewRaid"),
    ReadNeed::not_null("silentThresholdX"),
    ReadNeed::not_null("silentWindowYSeconds"),
    ReadNeed::not_null("protectionThresholdB"),
    ReadNeed::not_null("silentDurationSeconds"),
    ReadNeed::not_null("language"),
    ReadNeed::not_null("settingsVersion"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_defense_settings",
    source: "dimabot/src/schemas/follow_defense_settings.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<FollowDefenseSettings>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowDefenseSettings {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", default = "default_channel")]
    pub channel: String,
    /// `enabled`.
    #[serde(rename = "enabled", default = "default_enabled")]
    pub enabled: bool,
    /// `silentModeEnabled`.
    #[serde(rename = "silentModeEnabled", default = "default_silent_mode_enabled")]
    pub silent_mode_enabled: bool,
    /// `protectionModeEnabled`.
    #[serde(
        rename = "protectionModeEnabled",
        default = "default_protection_mode_enabled"
    )]
    pub protection_mode_enabled: bool,
    /// `attackModeEnabled`.
    #[serde(rename = "attackModeEnabled", default = "default_attack_mode_enabled")]
    pub attack_mode_enabled: bool,
    /// `resetAttackOnNewRaid`.
    #[serde(
        rename = "resetAttackOnNewRaid",
        default = "default_reset_attack_on_new_raid"
    )]
    pub reset_attack_on_new_raid: bool,
    /// `silentThresholdX`.
    #[serde(rename = "silentThresholdX", default = "default_silent_threshold_x")]
    pub silent_threshold_x: JsNumber,
    /// `silentWindowYSeconds`.
    #[serde(
        rename = "silentWindowYSeconds",
        default = "default_silent_window_y_seconds"
    )]
    pub silent_window_y_seconds: JsNumber,
    /// `protectionThresholdB`.
    #[serde(
        rename = "protectionThresholdB",
        default = "default_protection_threshold_b"
    )]
    pub protection_threshold_b: JsNumber,
    /// `attackThreshold`.
    #[serde(rename = "attackThreshold", default)]
    pub attack_threshold: Option<JsNumber>,
    /// `silentDurationSeconds`.
    #[serde(
        rename = "silentDurationSeconds",
        default = "default_silent_duration_seconds"
    )]
    pub silent_duration_seconds: JsNumber,
    /// `baselineFollowsPerHour`.
    #[serde(rename = "baselineFollowsPerHour", default)]
    pub baseline_follows_per_hour: Option<JsNumber>,
    /// `language`.
    #[serde(rename = "language", default = "default_language")]
    pub language: Open<LanguageKind>,
    /// `settingsVersion`.
    #[serde(rename = "settingsVersion", default = "default_settings_version")]
    pub settings_version: JsNumber,
    /// `createdAt`.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowDefenseSettings {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// `enabled`.
    #[serde(rename = "enabled", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `silentModeEnabled`.
    #[serde(rename = "silentModeEnabled", skip_serializing_if = "Option::is_none")]
    pub silent_mode_enabled: Option<bool>,
    /// `protectionModeEnabled`.
    #[serde(
        rename = "protectionModeEnabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub protection_mode_enabled: Option<bool>,
    /// `attackModeEnabled`.
    #[serde(rename = "attackModeEnabled", skip_serializing_if = "Option::is_none")]
    pub attack_mode_enabled: Option<bool>,
    /// `resetAttackOnNewRaid`.
    #[serde(
        rename = "resetAttackOnNewRaid",
        skip_serializing_if = "Option::is_none"
    )]
    pub reset_attack_on_new_raid: Option<bool>,
    /// `silentThresholdX`.
    #[serde(rename = "silentThresholdX", skip_serializing_if = "Option::is_none")]
    pub silent_threshold_x: Option<JsNumber>,
    /// `silentWindowYSeconds`.
    #[serde(
        rename = "silentWindowYSeconds",
        skip_serializing_if = "Option::is_none"
    )]
    pub silent_window_y_seconds: Option<JsNumber>,
    /// `protectionThresholdB`.
    #[serde(
        rename = "protectionThresholdB",
        skip_serializing_if = "Option::is_none"
    )]
    pub protection_threshold_b: Option<JsNumber>,
    /// `attackThreshold`.
    #[serde(rename = "attackThreshold", skip_serializing_if = "Option::is_none")]
    pub attack_threshold: Option<JsNumber>,
    /// `silentDurationSeconds`.
    #[serde(
        rename = "silentDurationSeconds",
        skip_serializing_if = "Option::is_none"
    )]
    pub silent_duration_seconds: Option<JsNumber>,
    /// `baselineFollowsPerHour`.
    #[serde(
        rename = "baselineFollowsPerHour",
        skip_serializing_if = "Option::is_none"
    )]
    pub baseline_follows_per_hour: Option<JsNumber>,
    /// `language`.
    #[serde(rename = "language", skip_serializing_if = "Option::is_none")]
    pub language: Option<LanguageKind>,
    /// `settingsVersion`.
    #[serde(rename = "settingsVersion", skip_serializing_if = "Option::is_none")]
    pub settings_version: Option<JsNumber>,
}
impl NewFollowDefenseSettings {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
