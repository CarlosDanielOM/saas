//! `pet_settings`: reference `dimabot/src/schemas/pet_settings.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! server/services/pet_settings.service.ts:145-187 validates the entire dashboard body via
//! validatePetSettings (:73-106), shared by the site assistant. bool/text/integer, enum checks,
//! nullableId, session validation and validatePetMoods build typed settings. No unchecked client-fed
//! paths (0); four explicit nullable asset/session IDs survive (appearance idle/talking and playback
//! desktop/vts). :184 awaits init: unique userId required for revision CAS. :187 passes runValidators
//! (recorded valid/invalid). No saves. Legacy optional moods and newer settings defaults accepted.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::Open;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "pet_settings";
/// Raw `settings.moods` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PetSettingsRecordSettingsMoods(pub Bson);
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsAppearanceKindValue {/// png
Png = "png",/// vts
Vts = "vts"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsPlaybackTargetValue {/// browser
Browser = "browser",/// desktop
Desktop = "desktop"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsTtsAudioValue {/// pet
Pet = "pet",/// overlay
Overlay = "overlay"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsTtsProviderValue {/// piper
Piper = "piper",/// kokoro
Kokoro = "kokoro",/// fish
Fish = "fish"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsTtsLanguageValue {/// en
En = "en",/// es
Es = "es"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsPersonalitySourceValue {/// custom
Custom = "custom",/// profile
Profile = "profile"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetSettingsRecordSettingsBehaviorAskLaneValue {/// independent
Independent = "independent",/// tts
Tts = "tts"}}
fn read_default_pet_settings_record_settings_sources_independent() -> bool {
    true
}
fn read_default_pet_settings_record_settings_sources_read_tts() -> bool {
    false
}
fn read_default_pet_settings_record_settings_tts_audio()
-> Open<PetSettingsRecordSettingsTtsAudioValue> {
    Open::from(PetSettingsRecordSettingsTtsAudioValue::Pet)
}
fn read_default_pet_settings_record_settings_personality_profile_id() -> String {
    "".into()
}
fn read_default_pet_settings_record_settings_personality_prompt() -> Private<String> {
    Private::new("".into())
}
fn read_default_pet_settings_record_settings_rules() -> Private<Vec<Option<String>>> {
    Private::new(vec![])
}
fn read_default_pet_settings_record_settings_behavior_queue_size() -> JsNumber {
    JsNumber(5.0)
}
fn read_default_pet_settings_record_settings_behavior_ask_lane()
-> Open<PetSettingsRecordSettingsBehaviorAskLaneValue> {
    Open::from(PetSettingsRecordSettingsBehaviorAskLaneValue::Independent)
}
static SCHEMA_SETTINGS: Schema = Schema::subdocument(&[
    Field::mixed("moods"),
    Field::nested(
        "appearance",
        &[
            Field::string("kind"),
            Field::string("idleAssetId").default(D::Null),
            Field::string("talkingAssetId").default(D::Null),
        ],
    ),
    Field::nested(
        "playback",
        &[
            Field::string("target"),
            Field::string("desktopSessionId").default(D::Null),
            Field::string("vtsSessionId").default(D::Null),
        ],
    ),
    Field::nested(
        "sources",
        &[
            Field::boolean("independent").default(D::Bool(true)),
            Field::boolean("readTts").default(D::Bool(false)),
        ],
    ),
    Field::string("ttsAudio").default(D::Str("pet")),
    Field::boolean("enabled"),
    Field::string("name"),
    Field::nested(
        "tts",
        &[
            Field::boolean("enabled"),
            Field::string("provider"),
            Field::string("language"),
            Field::string("voice"),
        ],
    ),
    Field::nested(
        "personality",
        &[
            Field::string("source"),
            Field::string("profileId").default(D::Str("")),
            Field::string("prompt").default(D::Str("")),
        ],
    ),
    Field::array("rules", ValueType::String).default(D::EmptyArray),
    Field::nested(
        "behavior",
        &[
            Field::boolean("respondToChat"),
            Field::boolean("respondToEvents"),
            Field::number("cooldownSeconds"),
            Field::number("maxReplyLength"),
            Field::number("queueSize").default(D::Int(5)),
            Field::string("askLane").default(D::Str("independent")),
        ],
    ),
])
.no_id();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("userId"),
    Field::subdocument("settings", &SCHEMA_SETTINGS),
    Field::number("revision"),
    Field::date("updatedAt"),
])
.no_version_key();
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsAppearance {
    /// `settings.appearance.kind`.
    #[serde(rename = "kind", default)]
    pub kind: Option<Open<PetSettingsRecordSettingsAppearanceKindValue>>,
    /// `settings.appearance.idleAssetId`.
    #[serde(rename = "idleAssetId", default)]
    pub idle_asset_id: Option<String>,
    /// `settings.appearance.talkingAssetId`.
    #[serde(rename = "talkingAssetId", default)]
    pub talking_asset_id: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsAppearance {
    /// `settings.appearance.kind`.
    #[serde(rename = "kind", skip_serializing_if = "Option::is_none")]
    pub kind: Option<PetSettingsRecordSettingsAppearanceKindValue>,
    /// `settings.appearance.idleAssetId`.
    #[serde(rename = "idleAssetId", skip_serializing_if = "Nullable::is_unset")]
    pub idle_asset_id: Nullable<String>,
    /// `settings.appearance.talkingAssetId`.
    #[serde(rename = "talkingAssetId", skip_serializing_if = "Nullable::is_unset")]
    pub talking_asset_id: Nullable<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsPlayback {
    /// `settings.playback.target`.
    #[serde(rename = "target", default)]
    pub target: Option<Open<PetSettingsRecordSettingsPlaybackTargetValue>>,
    /// `settings.playback.desktopSessionId`.
    #[serde(rename = "desktopSessionId", default)]
    pub desktop_session_id: Option<String>,
    /// `settings.playback.vtsSessionId`.
    #[serde(rename = "vtsSessionId", default)]
    pub vts_session_id: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsPlayback {
    /// `settings.playback.target`.
    #[serde(rename = "target", skip_serializing_if = "Option::is_none")]
    pub target: Option<PetSettingsRecordSettingsPlaybackTargetValue>,
    /// `settings.playback.desktopSessionId`.
    #[serde(
        rename = "desktopSessionId",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub desktop_session_id: Nullable<String>,
    /// `settings.playback.vtsSessionId`.
    #[serde(rename = "vtsSessionId", skip_serializing_if = "Nullable::is_unset")]
    pub vts_session_id: Nullable<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsSources {
    /// `settings.sources.independent`.
    #[serde(
        rename = "independent",
        default = "read_default_pet_settings_record_settings_sources_independent"
    )]
    pub independent: bool,
    /// `settings.sources.readTts`.
    #[serde(
        rename = "readTts",
        default = "read_default_pet_settings_record_settings_sources_read_tts"
    )]
    pub read_tts: bool,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsSources {
    /// `settings.sources.independent`.
    #[serde(rename = "independent", skip_serializing_if = "Option::is_none")]
    pub independent: Option<bool>,
    /// `settings.sources.readTts`.
    #[serde(rename = "readTts", skip_serializing_if = "Option::is_none")]
    pub read_tts: Option<bool>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsTts {
    /// `settings.tts.enabled`.
    #[serde(rename = "enabled")]
    pub enabled: bool,
    /// `settings.tts.provider`.
    #[serde(rename = "provider")]
    pub provider: Open<PetSettingsRecordSettingsTtsProviderValue>,
    /// `settings.tts.language`.
    #[serde(rename = "language")]
    pub language: Open<PetSettingsRecordSettingsTtsLanguageValue>,
    /// `settings.tts.voice`.
    #[serde(rename = "voice")]
    pub voice: String,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsTts {
    /// `settings.tts.enabled`.
    #[serde(rename = "enabled")]
    pub enabled: bool,
    /// `settings.tts.provider`.
    #[serde(rename = "provider")]
    pub provider: PetSettingsRecordSettingsTtsProviderValue,
    /// `settings.tts.language`.
    #[serde(rename = "language")]
    pub language: PetSettingsRecordSettingsTtsLanguageValue,
    /// `settings.tts.voice`.
    #[serde(rename = "voice")]
    pub voice: String,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsPersonality {
    /// `settings.personality.source`.
    #[serde(rename = "source")]
    pub source: Open<PetSettingsRecordSettingsPersonalitySourceValue>,
    /// `settings.personality.profileId`.
    #[serde(
        rename = "profileId",
        default = "read_default_pet_settings_record_settings_personality_profile_id"
    )]
    pub profile_id: String,
    /// `settings.personality.prompt`.
    #[serde(
        rename = "prompt",
        default = "read_default_pet_settings_record_settings_personality_prompt"
    )]
    pub prompt: Private<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsPersonality {
    /// `settings.personality.source`.
    #[serde(rename = "source")]
    pub source: PetSettingsRecordSettingsPersonalitySourceValue,
    /// `settings.personality.profileId`.
    #[serde(rename = "profileId", skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// `settings.personality.prompt`.
    #[serde(rename = "prompt", skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Private<String>>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettingsBehavior {
    /// `settings.behavior.respondToChat`.
    #[serde(rename = "respondToChat")]
    pub respond_to_chat: bool,
    /// `settings.behavior.respondToEvents`.
    #[serde(rename = "respondToEvents")]
    pub respond_to_events: bool,
    /// `settings.behavior.cooldownSeconds`.
    #[serde(rename = "cooldownSeconds")]
    pub cooldown_seconds: JsNumber,
    /// `settings.behavior.maxReplyLength`.
    #[serde(rename = "maxReplyLength")]
    pub max_reply_length: JsNumber,
    /// `settings.behavior.queueSize`.
    #[serde(
        rename = "queueSize",
        default = "read_default_pet_settings_record_settings_behavior_queue_size"
    )]
    pub queue_size: JsNumber,
    /// `settings.behavior.askLane`.
    #[serde(
        rename = "askLane",
        default = "read_default_pet_settings_record_settings_behavior_ask_lane"
    )]
    pub ask_lane: Open<PetSettingsRecordSettingsBehaviorAskLaneValue>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettingsBehavior {
    /// `settings.behavior.respondToChat`.
    #[serde(rename = "respondToChat")]
    pub respond_to_chat: bool,
    /// `settings.behavior.respondToEvents`.
    #[serde(rename = "respondToEvents")]
    pub respond_to_events: bool,
    /// `settings.behavior.cooldownSeconds`.
    #[serde(rename = "cooldownSeconds")]
    pub cooldown_seconds: JsNumber,
    /// `settings.behavior.maxReplyLength`.
    #[serde(rename = "maxReplyLength")]
    pub max_reply_length: JsNumber,
    /// `settings.behavior.queueSize`.
    #[serde(rename = "queueSize", skip_serializing_if = "Option::is_none")]
    pub queue_size: Option<JsNumber>,
    /// `settings.behavior.askLane`.
    #[serde(rename = "askLane", skip_serializing_if = "Option::is_none")]
    pub ask_lane: Option<PetSettingsRecordSettingsBehaviorAskLaneValue>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecordSettings {
    /// `settings.moods`.
    #[serde(rename = "moods", default)]
    pub moods: Option<Private<PetSettingsRecordSettingsMoods>>,
    /// `settings.appearance`.
    #[serde(rename = "appearance", default)]
    pub appearance: Option<PetSettingsRecordSettingsAppearance>,
    /// `settings.playback`.
    #[serde(rename = "playback", default)]
    pub playback: Option<PetSettingsRecordSettingsPlayback>,
    /// `settings.sources`.
    #[serde(rename = "sources", default)]
    pub sources: Option<PetSettingsRecordSettingsSources>,
    /// `settings.ttsAudio`.
    #[serde(
        rename = "ttsAudio",
        default = "read_default_pet_settings_record_settings_tts_audio"
    )]
    pub tts_audio: Open<PetSettingsRecordSettingsTtsAudioValue>,
    /// `settings.enabled`.
    #[serde(rename = "enabled")]
    pub enabled: bool,
    /// `settings.name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `settings.tts`.
    #[serde(rename = "tts", default)]
    pub tts: Option<PetSettingsRecordSettingsTts>,
    /// `settings.personality`.
    #[serde(rename = "personality", default)]
    pub personality: Option<PetSettingsRecordSettingsPersonality>,
    /// `settings.rules`.
    #[serde(
        rename = "rules",
        default = "read_default_pet_settings_record_settings_rules"
    )]
    pub rules: Private<Vec<Option<String>>>,
    /// `settings.behavior`.
    #[serde(rename = "behavior", default)]
    pub behavior: Option<PetSettingsRecordSettingsBehavior>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecordSettings {
    /// `settings.moods`.
    #[serde(rename = "moods", skip_serializing_if = "Option::is_none")]
    pub moods: Option<Private<PetSettingsRecordSettingsMoods>>,
    /// `settings.appearance`.
    #[serde(rename = "appearance", skip_serializing_if = "Option::is_none")]
    pub appearance: Option<NewPetSettingsRecordSettingsAppearance>,
    /// `settings.playback`.
    #[serde(rename = "playback", skip_serializing_if = "Option::is_none")]
    pub playback: Option<NewPetSettingsRecordSettingsPlayback>,
    /// `settings.sources`.
    #[serde(rename = "sources", skip_serializing_if = "Option::is_none")]
    pub sources: Option<NewPetSettingsRecordSettingsSources>,
    /// `settings.ttsAudio`.
    #[serde(rename = "ttsAudio", skip_serializing_if = "Option::is_none")]
    pub tts_audio: Option<PetSettingsRecordSettingsTtsAudioValue>,
    /// `settings.enabled`.
    #[serde(rename = "enabled")]
    pub enabled: bool,
    /// `settings.name`.
    #[serde(rename = "name")]
    pub name: String,
    /// `settings.tts`.
    #[serde(rename = "tts", skip_serializing_if = "Option::is_none")]
    pub tts: Option<NewPetSettingsRecordSettingsTts>,
    /// `settings.personality`.
    #[serde(rename = "personality", skip_serializing_if = "Option::is_none")]
    pub personality: Option<NewPetSettingsRecordSettingsPersonality>,
    /// `settings.rules`.
    #[serde(rename = "rules", skip_serializing_if = "Option::is_none")]
    pub rules: Option<Private<Vec<Option<String>>>>,
    /// `settings.behavior`.
    #[serde(rename = "behavior", skip_serializing_if = "Option::is_none")]
    pub behavior: Option<NewPetSettingsRecordSettingsBehavior>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetSettingsRecord {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: bson::oid::ObjectId,
    /// `userId`.
    #[serde(rename = "userId")]
    pub user_id: bson::oid::ObjectId,
    /// `settings`.
    #[serde(rename = "settings")]
    pub settings: PetSettingsRecordSettings,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetSettingsRecord {
    /// `userId`.
    #[serde(rename = "userId")]
    pub user_id: bson::oid::ObjectId,
    /// `settings`.
    #[serde(rename = "settings")]
    pub settings: NewPetSettingsRecordSettings,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `updatedAt`.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[
    "settings.personality.prompt",
    "settings.rules",
    "settings.moods",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("userId", 1)]).unique()];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("userId"),
    Rule::required("settings"),
    Rule::one_of("settings.appearance.kind", &["png", "vts"]),
    Rule::one_of("settings.playback.target", &["browser", "desktop"]),
    Rule::one_of("settings.ttsAudio", &["pet", "overlay"]),
    Rule::required("settings.enabled"),
    Rule::required("settings.name"),
    Rule::max_length("settings.name", 40),
    Rule::required("settings.tts.enabled"),
    Rule::required("settings.tts.provider"),
    Rule::one_of("settings.tts.provider", &["piper", "kokoro", "fish"]),
    Rule::required("settings.tts.language"),
    Rule::one_of("settings.tts.language", &["en", "es"]),
    Rule::required("settings.tts.voice"),
    Rule::max_length("settings.tts.voice", 100),
    Rule::required("settings.personality.source"),
    Rule::one_of("settings.personality.source", &["custom", "profile"]),
    Rule::max_length("settings.personality.prompt", 4000),
    Rule::required("settings.behavior.respondToChat"),
    Rule::required("settings.behavior.respondToEvents"),
    Rule::required("settings.behavior.cooldownSeconds"),
    Rule::min("settings.behavior.cooldownSeconds", 0.0),
    Rule::max("settings.behavior.cooldownSeconds", 3600.0),
    Rule::required("settings.behavior.maxReplyLength"),
    Rule::min("settings.behavior.maxReplyLength", 30.0),
    Rule::max("settings.behavior.maxReplyLength", 500.0),
    Rule::min("settings.behavior.queueSize", 1.0),
    Rule::max("settings.behavior.queueSize", 10.0),
    Rule::one_of("settings.behavior.askLane", &["independent", "tts"]),
    Rule::required("revision"),
    Rule::min("revision", 1.0),
    Rule::required("updatedAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("userId"),
    ReadNeed::not_null("settings.sources.independent"),
    ReadNeed::not_null("settings.sources.readTts"),
    ReadNeed::not_null("settings.ttsAudio"),
    ReadNeed::value("settings.enabled"),
    ReadNeed::value("settings.name"),
    ReadNeed::value("settings.tts.enabled"),
    ReadNeed::value("settings.tts.provider"),
    ReadNeed::value("settings.tts.language"),
    ReadNeed::value("settings.tts.voice"),
    ReadNeed::value("settings.personality.source"),
    ReadNeed::not_null("settings.personality.profileId"),
    ReadNeed::not_null("settings.personality.prompt"),
    ReadNeed::not_null("settings.rules"),
    ReadNeed::value("settings.behavior.respondToChat"),
    ReadNeed::value("settings.behavior.respondToEvents"),
    ReadNeed::value("settings.behavior.cooldownSeconds"),
    ReadNeed::value("settings.behavior.maxReplyLength"),
    ReadNeed::not_null("settings.behavior.queueSize"),
    ReadNeed::not_null("settings.behavior.askLane"),
    ReadNeed::value("settings"),
    ReadNeed::value("revision"),
    ReadNeed::value("updatedAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "pet_settings",
    source: "dimabot/src/schemas/pet_settings.schema.ts",
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
    decode: decode_boxed::<PetSettingsRecord>,
};
impl NewPetSettingsRecord {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
