//! `channelaipersonalities`: a channel's AI chat persona (profiles, rules, known viewers,
//! learning and memory policy, context window).
//!
//! Reference: `dimabot/src/schemas/channel_ai_personality.schema.ts` (model
//! `ChannelAIPersonality`). No timestamps option (hand-written `createdAt` and `updatedAt` with
//! `Date.now` defaults; the callers set `updatedAt` themselves), `__v`, no index. Creates
//! (`Model.create`: `ai_personality.service.ts`, `openrouter/ai.ts`, `messages.ai.ts`) and saves
//! of loaded documents (`ai_personality.service.ts:521`, `aiPersonality.route.ts:194`) go through
//! this module; updates (the feature-flag migration's `updateMany`) have no hook.
//!
//! Hooks, ported as [`NewChannelAiPersonality::prepare`] and [`prepare_save`]:
//!
//! - `pre('validate')`, before validation: `ensureProfiles` ([`ensure_profiles`]): with no
//!   profile, one is built from the legacy top-level persona (a new profile id); an
//!   `activeProfileId` that names no profile becomes the first one's; the top-level persona
//!   fields are copied from the active profile.
//! - `pre('save')`, after validation: `ensureProfiles` again; the owner is the user
//!   `findOne({'accounts.type': 'twitch', 'accounts.id': channelID})` (the caller passes its
//!   `plan_tier`, `None` when there is none: "User not found for channel"); the plan's profile
//!   limit (pro 3, premium 2, otherwise 1); every profile's `createdAt` kept and `updatedAt` set
//!   to the write time; `contextWindow` 35, 15 or 7, with the rule and known-user limits of
//!   premium (5, 10) and free (3, 3). A refusal is [`ModelError::Refused`] with the reference's
//!   message.
//!
//! Legacy shapes accepted: 15 documents from before profiles (no `profiles`, persona,
//! `voiceProfile`, `learningConfig` or `memoryPolicy`: read with the defaults), 17 known users
//! with an `_id` (the schema declares none; ignored), `language` stored as `null` (53),
//! `learningConfig.semanticChatHistoryLimit` stored as `null` (41: the plan's default).
//! `knownUsers` (descriptions of real viewers) is private.
//!
//! Intended differences (`crate::shape`): the write helpers refuse a value of the wrong BSON
//! type, and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of
//! the production copy shows none stored there, so Mongoose's acceptance of them is not
//! reproduced. The element `required` of `rules` (an array of strings) is not checked.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, yes};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::loaded::LoadedForSave;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::writes::{create_with_hooks, document_after, save_with_hooks};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "channelaipersonalities";

/// The default persona text.
pub const DEFAULT_PERSONALITY: &str = "You are a friendly Twitch chat moderator who speaks in Spanish by default but can adapt to other languages. You have a good sense of humor and can be playful with chat users.";
/// The default profile name.
pub const DEFAULT_PROFILE_NAME: &str = "Default Personality";
const DEFAULT_TONE: &str = "friendly and playful";
const DEFAULT_CADENCE: &str = "short and dynamic";
const DEFAULT_STYLE: &str = "chat-native and expressive";

str_enum! {
    /// `personaMode`.
    pub enum PersonaMode {
        /// Its own persona (the default).
        Original = "original",
        /// Inspired by a character.
        Inspired = "inspired",
        /// Plays a character strictly.
        StrictRoleplay = "strict_roleplay",
    }
}

str_enum! {
    /// `tonePreset`.
    pub enum TonePreset {
        /// For every audience.
        FamilyFriendly = "family_friendly",
        /// Balanced (the default).
        Balanced = "balanced",
        /// Dark humor.
        DarkHumor = "dark_humor",
    }
}

str_enum! {
    /// `language`.
    pub enum PersonaLanguage {
        /// English.
        En = "en",
        /// Spanish.
        Es = "es",
    }
}

static KNOWN_USER: Schema = Schema::subdocument(&[
    Field::string("username").default(D::Str("")),
    Field::string("description").default(D::Str("")),
    Field::date("lastInteraction").default_fn(D::Now),
    Field::string("relationship").default(D::Str("")),
])
.no_id();

static VOICE_PROFILE: Schema = Schema::subdocument(&[
    Field::string("tone").default(D::Str(DEFAULT_TONE)),
    Field::string("cadence").default(D::Str(DEFAULT_CADENCE)),
    Field::string("style").default(D::Str(DEFAULT_STYLE)),
    Field::array("catchphrases", ValueType::String).default(D::EmptyArray),
])
.no_id();

/// The default voice profile (`default: () => ({...})`).
fn default_voice(_now_ms: i64) -> Bson {
    Bson::Document(voice_document(
        DEFAULT_TONE,
        DEFAULT_CADENCE,
        DEFAULT_STYLE,
        Vec::new(),
    ))
}

fn voice_document(tone: &str, cadence: &str, style: &str, catchphrases: Vec<Bson>) -> Document {
    doc! { "tone": tone, "cadence": cadence, "style": style, "catchphrases": catchphrases }
}

/// `() => new Types.ObjectId().toString()`: random, as in the reference (the hooks use the
/// write context's ids instead, see [`ensure_profiles`]).
fn new_profile_id(_now_ms: i64) -> Bson {
    Bson::String(ObjectId::new().to_hex())
}

static PROFILE: Schema = Schema::subdocument(&[
    Field::string("profileID").default_fn(D::With(new_profile_id)),
    Field::string("name").default(D::Str(DEFAULT_PROFILE_NAME)),
    Field::string("personality").default(D::Str(DEFAULT_PERSONALITY)),
    Field::string("personaMode").default(D::Str("original")),
    Field::string("personaReference").default(D::Str("")),
    Field::string("tonePreset").default(D::Str("balanced")),
    Field::subdocument("voiceProfile", &VOICE_PROFILE).default_fn(D::With(default_voice)),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("updatedAt").default_fn(D::Now),
])
.no_id();

static LEARNING_CONFIG: Schema = Schema::subdocument(&[
    Field::boolean("enabled").default(D::Bool(true)),
    Field::boolean("autoConfirmEnabled").default(D::Bool(true)),
    Field::number("autoConfirmThreshold").default(D::Double(0.82)),
    Field::number("minMessageLength").default(D::Int(12)),
    Field::number("maxPendingMemories").default(D::Int(250)),
    Field::number("maxConfirmedMemories").default(D::Int(2000)),
    Field::boolean("postStreamSummaryEnabled").default(D::Bool(true)),
    Field::boolean("weeklyMaintenanceEnabled").default(D::Bool(true)),
    Field::boolean("monthlyMaintenanceEnabled").default(D::Bool(true)),
    Field::boolean("autoApplyCreates").default(D::Bool(true)),
    Field::boolean("autoApplyEdits").default(D::Bool(true)),
    Field::boolean("autoApplyArchives").default(D::Bool(true)),
    Field::boolean("autoApplyPermanentDeletes").default(D::Bool(true)),
    Field::number("summaryMinDurationMinutes").default(D::Int(20)),
    Field::number("summaryMinChatMessages").default(D::Int(30)),
    Field::number("createMinConfidence").default(D::Double(0.72)),
    Field::number("editMinConfidence").default(D::Double(0.74)),
    Field::number("archiveMinConfidence").default(D::Double(0.8)),
    Field::number("deleteMinConfidence").default(D::Double(0.88)),
    Field::number("maxActionsPerRun").default(D::Int(20)),
    Field::number("maxDeletesPerRun").default(D::Int(5)),
    Field::number("minMemoryAgeDaysForDelete").default(D::Int(30)),
    Field::number("minUnusedDaysForDelete").default(D::Int(21)),
    Field::boolean("semanticChatHistoryEnabled").default(D::Bool(true)),
    Field::number("semanticChatHistoryLimit").default(D::Null),
    Field::number("semanticChatHistoryPrimaryMinScore").default(D::Double(0.75)),
    Field::number("semanticChatHistoryFallbackMinScore").default(D::Double(0.69)),
])
.no_id();

/// The default learning configuration (`default: () => ({...})`, cast to the sub-document).
fn default_learning(_now_ms: i64) -> Bson {
    Bson::Document(
        doc! { "enabled": true, "autoConfirmEnabled": true, "autoConfirmThreshold": 0.82_f64, "minMessageLength": 12_i32, "maxPendingMemories": 250_i32, "maxConfirmedMemories": 2000_i32, "postStreamSummaryEnabled": true, "weeklyMaintenanceEnabled": true, "monthlyMaintenanceEnabled": true, "autoApplyCreates": true, "autoApplyEdits": true, "autoApplyArchives": true, "autoApplyPermanentDeletes": true, "summaryMinDurationMinutes": 20_i32, "summaryMinChatMessages": 30_i32, "createMinConfidence": 0.72_f64, "editMinConfidence": 0.74_f64, "archiveMinConfidence": 0.8_f64, "deleteMinConfidence": 0.88_f64, "maxActionsPerRun": 20_i32, "maxDeletesPerRun": 5_i32, "minMemoryAgeDaysForDelete": 30_i32, "minUnusedDaysForDelete": 21_i32, "semanticChatHistoryEnabled": true, "semanticChatHistoryLimit": Bson::Null, "semanticChatHistoryPrimaryMinScore": 0.75_f64, "semanticChatHistoryFallbackMinScore": 0.69_f64 },
    )
}

static MEMORY_POLICY: Schema = Schema::subdocument(&[
    Field::boolean("prioritizeRecentChat").default(D::Bool(true)),
    Field::boolean("allowSensitiveMemories").default(D::Bool(false)),
    Field::boolean("allowUserPreferenceMemories").default(D::Bool(true)),
    Field::boolean("allowRunningJokes").default(D::Bool(true)),
])
.no_id();

/// The default memory policy (`default: () => ({...})`).
fn default_memory_policy(_now_ms: i64) -> Bson {
    Bson::Document(doc! {
        "prioritizeRecentChat": true, "allowSensitiveMemories": false,
        "allowUserPreferenceMemories": true, "allowRunningJokes": true,
    })
}

/// The schema, field by field as `channel_ai_personality.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel"),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::boolean("streamSummariesEnabled").default(D::Bool(true)),
    Field::boolean("recommendationsEnabled").default(D::Bool(true)),
    Field::document_array("profiles", &PROFILE).default(D::EmptyArray),
    Field::string("activeProfileId").default(D::Str("")),
    Field::string("personality").default(D::Str(DEFAULT_PERSONALITY)),
    Field::string("personaMode").default(D::Str("original")),
    Field::string("personaReference").default(D::Str("")),
    Field::string("tonePreset").default(D::Str("balanced")),
    Field::string("language").default(D::Null),
    Field::subdocument("voiceProfile", &VOICE_PROFILE).default_fn(D::With(default_voice)),
    Field::subdocument("learningConfig", &LEARNING_CONFIG).default_fn(D::With(default_learning)),
    Field::subdocument("memoryPolicy", &MEMORY_POLICY).default_fn(D::With(default_memory_policy)),
    Field::array("rules", ValueType::String),
    Field::document_array("knownUsers", &KNOWN_USER),
    Field::number("contextWindow").default(D::Int(7)),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("updatedAt").default_fn(D::Now),
]);

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("profiles.$.profileID"),
    Rule::required("profiles.$.name"),
    Rule::required("profiles.$.personality"),
    Rule::one_of("profiles.$.personaMode", PersonaMode::STRINGS),
    Rule::one_of("profiles.$.tonePreset", TonePreset::STRINGS),
    Rule::required("personality"),
    Rule::one_of("personaMode", PersonaMode::STRINGS),
    Rule::one_of("tonePreset", TonePreset::STRINGS),
    Rule::one_of("language", PersonaLanguage::STRINGS),
    Rule::required("contextWindow"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["knownUsers"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("channel"),
    ReadNeed::not_null("enabled"),
    ReadNeed::not_null("streamSummariesEnabled"),
    ReadNeed::not_null("recommendationsEnabled"),
    ReadNeed::not_null("profiles"),
    ReadNeed::not_null("profiles.$.name"),
    ReadNeed::not_null("profiles.$.personality"),
    ReadNeed::not_null("profiles.$.personaMode"),
    ReadNeed::not_null("profiles.$.personaReference"),
    ReadNeed::not_null("profiles.$.tonePreset"),
    ReadNeed::not_null("profiles.$.voiceProfile"),
    ReadNeed::not_null("profiles.$.voiceProfile.tone"),
    ReadNeed::not_null("profiles.$.voiceProfile.cadence"),
    ReadNeed::not_null("profiles.$.voiceProfile.style"),
    ReadNeed::not_null("profiles.$.voiceProfile.catchphrases"),
    ReadNeed::not_null("activeProfileId"),
    ReadNeed::not_null("personality"),
    ReadNeed::not_null("personaMode"),
    ReadNeed::not_null("personaReference"),
    ReadNeed::not_null("tonePreset"),
    ReadNeed::not_null("voiceProfile"),
    ReadNeed::not_null("voiceProfile.tone"),
    ReadNeed::not_null("voiceProfile.cadence"),
    ReadNeed::not_null("voiceProfile.style"),
    ReadNeed::not_null("voiceProfile.catchphrases"),
    ReadNeed::not_null("learningConfig"),
    ReadNeed::not_null("learningConfig.enabled"),
    ReadNeed::not_null("learningConfig.autoConfirmEnabled"),
    ReadNeed::not_null("learningConfig.autoConfirmThreshold"),
    ReadNeed::not_null("learningConfig.minMessageLength"),
    ReadNeed::not_null("learningConfig.maxPendingMemories"),
    ReadNeed::not_null("learningConfig.maxConfirmedMemories"),
    ReadNeed::not_null("learningConfig.postStreamSummaryEnabled"),
    ReadNeed::not_null("learningConfig.weeklyMaintenanceEnabled"),
    ReadNeed::not_null("learningConfig.monthlyMaintenanceEnabled"),
    ReadNeed::not_null("learningConfig.autoApplyCreates"),
    ReadNeed::not_null("learningConfig.autoApplyEdits"),
    ReadNeed::not_null("learningConfig.autoApplyArchives"),
    ReadNeed::not_null("learningConfig.autoApplyPermanentDeletes"),
    ReadNeed::not_null("learningConfig.summaryMinDurationMinutes"),
    ReadNeed::not_null("learningConfig.summaryMinChatMessages"),
    ReadNeed::not_null("learningConfig.createMinConfidence"),
    ReadNeed::not_null("learningConfig.editMinConfidence"),
    ReadNeed::not_null("learningConfig.archiveMinConfidence"),
    ReadNeed::not_null("learningConfig.deleteMinConfidence"),
    ReadNeed::not_null("learningConfig.maxActionsPerRun"),
    ReadNeed::not_null("learningConfig.maxDeletesPerRun"),
    ReadNeed::not_null("learningConfig.minMemoryAgeDaysForDelete"),
    ReadNeed::not_null("learningConfig.minUnusedDaysForDelete"),
    ReadNeed::not_null("learningConfig.semanticChatHistoryEnabled"),
    ReadNeed::not_null("learningConfig.semanticChatHistoryPrimaryMinScore"),
    ReadNeed::not_null("learningConfig.semanticChatHistoryFallbackMinScore"),
    ReadNeed::not_null("memoryPolicy"),
    ReadNeed::not_null("memoryPolicy.prioritizeRecentChat"),
    ReadNeed::not_null("memoryPolicy.allowSensitiveMemories"),
    ReadNeed::not_null("memoryPolicy.allowUserPreferenceMemories"),
    ReadNeed::not_null("memoryPolicy.allowRunningJokes"),
    ReadNeed::not_null("rules"),
    ReadNeed::not_null("knownUsers"),
    ReadNeed::not_null("knownUsers.$.username"),
    ReadNeed::not_null("knownUsers.$.description"),
    ReadNeed::not_null("knownUsers.$.relationship"),
    ReadNeed::not_null("contextWindow"),
];

/// The registry entry. Creates and saves go through this module (the two hooks).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ChannelAIPersonality",
    source: "dimabot/src/schemas/channel_ai_personality.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[],
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::Save,
    private: PRIVATE,
    decode: decode_boxed::<ChannelAiPersonality>,
};

// ------------------------------------------------------------------------------------- reading

/// A stored personality, defaults filled in as a hydrated Mongoose document shows them.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelAiPersonality {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// Mention-based AI chat answers (`$(ai)` commands work either way).
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Post-stream summaries.
    #[serde(default = "yes", rename = "streamSummariesEnabled")]
    pub stream_summaries_enabled: bool,
    /// AI recommendations.
    #[serde(default = "yes", rename = "recommendationsEnabled")]
    pub recommendations_enabled: bool,
    /// The persona profiles.
    #[serde(default)]
    pub profiles: Vec<PersonaProfile>,
    /// The active profile (`''`: the first).
    #[serde(default = "empty", rename = "activeProfileId")]
    pub active_profile_id: String,
    /// The active persona's text (copied from the active profile on save).
    #[serde(default = "default_personality")]
    pub personality: String,
    /// The active persona's mode.
    #[serde(default = "original", rename = "personaMode")]
    pub persona_mode: Open<PersonaMode>,
    /// The character the persona is based on.
    #[serde(default = "empty", rename = "personaReference")]
    pub persona_reference: String,
    /// The active tone.
    #[serde(default = "balanced", rename = "tonePreset")]
    pub tone_preset: Open<TonePreset>,
    /// The answer language (`null`: follow chat).
    #[serde(default)]
    pub language: Option<Open<PersonaLanguage>>,
    /// The active voice profile.
    #[serde(default, rename = "voiceProfile")]
    pub voice_profile: VoiceProfile,
    /// Learning settings.
    #[serde(default, rename = "learningConfig")]
    pub learning_config: LearningConfig,
    /// Memory policy.
    #[serde(default, rename = "memoryPolicy")]
    pub memory_policy: MemoryPolicy,
    /// The persona's rules.
    #[serde(default)]
    pub rules: Vec<String>,
    /// Viewers the persona knows.
    #[serde(default, rename = "knownUsers")]
    pub known_users: Private<Vec<KnownUser>>,
    /// Chat messages of context (set from the plan on save).
    #[serde(default = "seven", rename = "contextWindow")]
    pub context_window: JsNumber,
    /// Creation time (`default: Date.now`, not applied on read).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn default_personality() -> String {
    DEFAULT_PERSONALITY.to_owned()
}

fn original() -> Open<PersonaMode> {
    Open::Known(PersonaMode::Original)
}

fn balanced() -> Open<TonePreset> {
    Open::Known(TonePreset::Balanced)
}

fn seven() -> JsNumber {
    JsNumber(7.0)
}

fn no() -> bool {
    false
}

/// `profiles[]`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PersonaProfile {
    /// The profile id (an ObjectId as hex; random by default, not applied on read).
    #[serde(default, rename = "profileID")]
    pub profile_id: Option<String>,
    /// Name.
    #[serde(default = "profile_name")]
    pub name: String,
    /// Persona text.
    #[serde(default = "default_personality")]
    pub personality: String,
    /// Mode.
    #[serde(default = "original", rename = "personaMode")]
    pub persona_mode: Open<PersonaMode>,
    /// The character it is based on.
    #[serde(default = "empty", rename = "personaReference")]
    pub persona_reference: String,
    /// Tone.
    #[serde(default = "balanced", rename = "tonePreset")]
    pub tone_preset: Open<TonePreset>,
    /// Voice.
    #[serde(default, rename = "voiceProfile")]
    pub voice_profile: VoiceProfile,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn profile_name() -> String {
    DEFAULT_PROFILE_NAME.to_owned()
}

/// `voiceProfile`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct VoiceProfile {
    /// Tone.
    #[serde(default = "tone")]
    pub tone: String,
    /// Cadence.
    #[serde(default = "cadence")]
    pub cadence: String,
    /// Style.
    #[serde(default = "style")]
    pub style: String,
    /// Catchphrases.
    #[serde(default)]
    pub catchphrases: Vec<String>,
}

fn tone() -> String {
    DEFAULT_TONE.to_owned()
}

fn cadence() -> String {
    DEFAULT_CADENCE.to_owned()
}

fn style() -> String {
    DEFAULT_STYLE.to_owned()
}

impl Default for VoiceProfile {
    fn default() -> Self {
        Self {
            tone: tone(),
            cadence: cadence(),
            style: style(),
            catchphrases: Vec::new(),
        }
    }
}

/// `learningConfig`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LearningConfig {
    /// `enabled`.
    #[serde(default = "yes", rename = "enabled")]
    pub enabled: bool,
    /// `autoConfirmEnabled`.
    #[serde(default = "yes", rename = "autoConfirmEnabled")]
    pub auto_confirm_enabled: bool,
    /// `autoConfirmThreshold`.
    #[serde(default = "auto_confirm_threshold", rename = "autoConfirmThreshold")]
    pub auto_confirm_threshold: JsNumber,
    /// `minMessageLength`.
    #[serde(default = "min_message_length", rename = "minMessageLength")]
    pub min_message_length: JsNumber,
    /// `maxPendingMemories`.
    #[serde(default = "max_pending_memories", rename = "maxPendingMemories")]
    pub max_pending_memories: JsNumber,
    /// `maxConfirmedMemories`.
    #[serde(default = "max_confirmed_memories", rename = "maxConfirmedMemories")]
    pub max_confirmed_memories: JsNumber,
    /// `postStreamSummaryEnabled`.
    #[serde(default = "yes", rename = "postStreamSummaryEnabled")]
    pub post_stream_summary_enabled: bool,
    /// `weeklyMaintenanceEnabled`.
    #[serde(default = "yes", rename = "weeklyMaintenanceEnabled")]
    pub weekly_maintenance_enabled: bool,
    /// `monthlyMaintenanceEnabled`.
    #[serde(default = "yes", rename = "monthlyMaintenanceEnabled")]
    pub monthly_maintenance_enabled: bool,
    /// `autoApplyCreates`.
    #[serde(default = "yes", rename = "autoApplyCreates")]
    pub auto_apply_creates: bool,
    /// `autoApplyEdits`.
    #[serde(default = "yes", rename = "autoApplyEdits")]
    pub auto_apply_edits: bool,
    /// `autoApplyArchives`.
    #[serde(default = "yes", rename = "autoApplyArchives")]
    pub auto_apply_archives: bool,
    /// `autoApplyPermanentDeletes`.
    #[serde(default = "yes", rename = "autoApplyPermanentDeletes")]
    pub auto_apply_permanent_deletes: bool,
    /// `summaryMinDurationMinutes`.
    #[serde(
        default = "summary_min_duration_minutes",
        rename = "summaryMinDurationMinutes"
    )]
    pub summary_min_duration_minutes: JsNumber,
    /// `summaryMinChatMessages`.
    #[serde(
        default = "summary_min_chat_messages",
        rename = "summaryMinChatMessages"
    )]
    pub summary_min_chat_messages: JsNumber,
    /// `createMinConfidence`.
    #[serde(default = "create_min_confidence", rename = "createMinConfidence")]
    pub create_min_confidence: JsNumber,
    /// `editMinConfidence`.
    #[serde(default = "edit_min_confidence", rename = "editMinConfidence")]
    pub edit_min_confidence: JsNumber,
    /// `archiveMinConfidence`.
    #[serde(default = "archive_min_confidence", rename = "archiveMinConfidence")]
    pub archive_min_confidence: JsNumber,
    /// `deleteMinConfidence`.
    #[serde(default = "delete_min_confidence", rename = "deleteMinConfidence")]
    pub delete_min_confidence: JsNumber,
    /// `maxActionsPerRun`.
    #[serde(default = "max_actions_per_run", rename = "maxActionsPerRun")]
    pub max_actions_per_run: JsNumber,
    /// `maxDeletesPerRun`.
    #[serde(default = "max_deletes_per_run", rename = "maxDeletesPerRun")]
    pub max_deletes_per_run: JsNumber,
    /// `minMemoryAgeDaysForDelete`.
    #[serde(
        default = "min_memory_age_days_for_delete",
        rename = "minMemoryAgeDaysForDelete"
    )]
    pub min_memory_age_days_for_delete: JsNumber,
    /// `minUnusedDaysForDelete`.
    #[serde(
        default = "min_unused_days_for_delete",
        rename = "minUnusedDaysForDelete"
    )]
    pub min_unused_days_for_delete: JsNumber,
    /// `semanticChatHistoryEnabled`.
    #[serde(default = "yes", rename = "semanticChatHistoryEnabled")]
    pub semantic_chat_history_enabled: bool,
    /// `semanticChatHistoryLimit` (`null`: the plan's default).
    #[serde(default, rename = "semanticChatHistoryLimit")]
    pub semantic_chat_history_limit: Option<JsNumber>,
    /// `semanticChatHistoryPrimaryMinScore`.
    #[serde(
        default = "semantic_chat_history_primary_min_score",
        rename = "semanticChatHistoryPrimaryMinScore"
    )]
    pub semantic_chat_history_primary_min_score: JsNumber,
    /// `semanticChatHistoryFallbackMinScore`.
    #[serde(
        default = "semantic_chat_history_fallback_min_score",
        rename = "semanticChatHistoryFallbackMinScore"
    )]
    pub semantic_chat_history_fallback_min_score: JsNumber,
}

fn auto_confirm_threshold() -> JsNumber {
    JsNumber(0.82)
}

fn min_message_length() -> JsNumber {
    JsNumber(12.0)
}

fn max_pending_memories() -> JsNumber {
    JsNumber(250.0)
}

fn max_confirmed_memories() -> JsNumber {
    JsNumber(2000.0)
}

fn summary_min_duration_minutes() -> JsNumber {
    JsNumber(20.0)
}

fn summary_min_chat_messages() -> JsNumber {
    JsNumber(30.0)
}

fn create_min_confidence() -> JsNumber {
    JsNumber(0.72)
}

fn edit_min_confidence() -> JsNumber {
    JsNumber(0.74)
}

fn archive_min_confidence() -> JsNumber {
    JsNumber(0.8)
}

fn delete_min_confidence() -> JsNumber {
    JsNumber(0.88)
}

fn max_actions_per_run() -> JsNumber {
    JsNumber(20.0)
}

fn max_deletes_per_run() -> JsNumber {
    JsNumber(5.0)
}

fn min_memory_age_days_for_delete() -> JsNumber {
    JsNumber(30.0)
}

fn min_unused_days_for_delete() -> JsNumber {
    JsNumber(21.0)
}

fn semantic_chat_history_primary_min_score() -> JsNumber {
    JsNumber(0.75)
}

fn semantic_chat_history_fallback_min_score() -> JsNumber {
    JsNumber(0.69)
}

impl Default for LearningConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_confirm_enabled: true,
            auto_confirm_threshold: auto_confirm_threshold(),
            min_message_length: min_message_length(),
            max_pending_memories: max_pending_memories(),
            max_confirmed_memories: max_confirmed_memories(),
            post_stream_summary_enabled: true,
            weekly_maintenance_enabled: true,
            monthly_maintenance_enabled: true,
            auto_apply_creates: true,
            auto_apply_edits: true,
            auto_apply_archives: true,
            auto_apply_permanent_deletes: true,
            summary_min_duration_minutes: summary_min_duration_minutes(),
            summary_min_chat_messages: summary_min_chat_messages(),
            create_min_confidence: create_min_confidence(),
            edit_min_confidence: edit_min_confidence(),
            archive_min_confidence: archive_min_confidence(),
            delete_min_confidence: delete_min_confidence(),
            max_actions_per_run: max_actions_per_run(),
            max_deletes_per_run: max_deletes_per_run(),
            min_memory_age_days_for_delete: min_memory_age_days_for_delete(),
            min_unused_days_for_delete: min_unused_days_for_delete(),
            semantic_chat_history_enabled: true,
            semantic_chat_history_limit: None,
            semantic_chat_history_primary_min_score: semantic_chat_history_primary_min_score(),
            semantic_chat_history_fallback_min_score: semantic_chat_history_fallback_min_score(),
        }
    }
}

/// `memoryPolicy`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MemoryPolicy {
    /// Recent chat weighs more than memories.
    #[serde(default = "yes", rename = "prioritizeRecentChat")]
    pub prioritize_recent_chat: bool,
    /// Sensitive memories may be kept.
    #[serde(default = "no", rename = "allowSensitiveMemories")]
    pub allow_sensitive_memories: bool,
    /// Viewer preferences may be kept.
    #[serde(default = "yes", rename = "allowUserPreferenceMemories")]
    pub allow_user_preference_memories: bool,
    /// Running jokes may be kept.
    #[serde(default = "yes", rename = "allowRunningJokes")]
    pub allow_running_jokes: bool,
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            prioritize_recent_chat: true,
            allow_sensitive_memories: false,
            allow_user_preference_memories: true,
            allow_running_jokes: true,
        }
    }
}

/// `knownUsers[]`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct KnownUser {
    /// The viewer's login.
    #[serde(default = "empty")]
    pub username: String,
    /// Who they are.
    #[serde(default = "empty")]
    pub description: String,
    /// Last interaction (`default: Date.now`, not applied on read).
    #[serde(default, rename = "lastInteraction")]
    pub last_interaction: Option<JsDate>,
    /// Their relationship to the channel.
    #[serde(default = "empty")]
    pub relationship: String,
}

// --------------------------------------------------------------------------------------- hooks

/// The owner the save hook needs: the `plan_tier` of the user owning the channel, as stored,
/// or `None` when no user has a Twitch account with the channel's id.
pub type OwnerPlan<'a> = Option<&'a str>;

fn text_or<'a>(document: &'a Document, key: &str, fallback: &'a str) -> &'a str {
    match document.get(key) {
        Some(Bson::String(text)) if !text.is_empty() => text,
        _ => fallback,
    }
}

/// The voice profile `ensureProfiles` copies: each text or its default, the catchphrases when
/// they are an array.
fn voice_from(voice: Option<&Bson>) -> Document {
    let empty_doc = Document::new();
    let voice = match voice {
        Some(Bson::Document(voice)) => voice,
        _ => &empty_doc,
    };
    let catchphrases = match voice.get("catchphrases") {
        Some(Bson::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    voice_document(
        text_or(voice, "tone", DEFAULT_TONE),
        text_or(voice, "cadence", DEFAULT_CADENCE),
        text_or(voice, "style", DEFAULT_STYLE),
        catchphrases,
    )
}

fn profiles_of(document: &Document) -> Vec<Document> {
    match document.get("profiles") {
        Some(Bson::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_document().cloned())
            .collect(),
        _ => Vec::new(),
    }
}

/// `ensureProfiles(doc)` on a hydrated document: the paths it sets, in its order. A new profile
/// (when there is none) takes its id from `ctx` and the write time.
pub fn ensure_profiles(document: &Document, ctx: &mut WriteContext) -> Vec<(String, Bson)> {
    let mut sets = Vec::new();
    let mut profiles = profiles_of(document);
    if profiles.is_empty() {
        let now = Bson::DateTime(ctx.now());
        let fallback = doc! {
            "profileID": ctx.new_object_id().to_hex(),
            "name": DEFAULT_PROFILE_NAME,
            "personality": text_or(document, "personality", DEFAULT_PERSONALITY),
            "personaMode": text_or(document, "personaMode", "original"),
            "personaReference": text_or(document, "personaReference", ""),
            "tonePreset": text_or(document, "tonePreset", "balanced"),
            "voiceProfile": voice_from(document.get("voiceProfile")),
            "createdAt": now.clone(),
            "updatedAt": now,
        };
        profiles.push(fallback.clone());
        sets.push(("profiles".to_owned(), Bson::Array(vec![fallback.into()])));
    }
    let id_of = |profile: &Document| profile.get_str("profileID").ok().map(str::to_owned);
    let first_id = profiles.first().and_then(id_of);
    let mut active_id = document.get_str("activeProfileId").unwrap_or("").to_owned();
    if active_id.is_empty()
        || !profiles
            .iter()
            .any(|p| id_of(p).as_deref() == Some(&active_id))
    {
        active_id = first_id.clone().unwrap_or_default();
        sets.push((
            "activeProfileId".to_owned(),
            first_id.map_or(Bson::Null, Bson::String),
        ));
    }
    let active = profiles
        .iter()
        .find(|p| id_of(p).as_deref() == Some(&active_id))
        .or(profiles.first());
    if let Some(active) = active {
        let field = |key: &str, fallback: &str| {
            active
                .get(key)
                .cloned()
                .unwrap_or_else(|| Bson::String(fallback.to_owned()))
        };
        sets.push((
            "personality".to_owned(),
            field("personality", DEFAULT_PERSONALITY),
        ));
        sets.push(("personaMode".to_owned(), field("personaMode", "original")));
        sets.push((
            "personaReference".to_owned(),
            Bson::String(text_or(active, "personaReference", "").to_owned()),
        ));
        sets.push((
            "tonePreset".to_owned(),
            Bson::String(text_or(active, "tonePreset", "balanced").to_owned()),
        ));
        sets.push((
            "voiceProfile".to_owned(),
            Bson::Document(voice_from(active.get("voiceProfile"))),
        ));
    }
    sets
}

fn refused(message: impl Into<String>) -> ModelError {
    ModelError::Refused {
        collection: COLLECTION,
        message: message.into(),
    }
}

fn array_len(document: &Document, key: &str) -> usize {
    match document.get(key) {
        Some(Bson::Array(items)) => items.len(),
        _ => 0,
    }
}

/// The `pre('save')` hook on the document as validated: what it sets, or its refusal.
fn pre_save(
    document: &Document,
    owner: OwnerPlan<'_>,
    ctx: &mut WriteContext,
) -> Result<Vec<(String, Bson)>, ModelError> {
    let mut document = document.clone();
    let mut sets = ensure_profiles(&document, ctx);
    for (path, value) in &sets {
        document.insert(path.clone(), value.clone());
    }
    let Some(plan) = owner else {
        return Err(refused("User not found for channel"));
    };
    let limit = match plan {
        "pro" => 3,
        "premium" => 2,
        _ => 1,
    };
    let profiles = profiles_of(&document);
    if profiles.len() > limit {
        return Err(refused(format!(
            "Current plan allows up to {limit} personality profile{}",
            if limit > 1 { "s" } else { "" }
        )));
    }
    if profiles.is_empty() {
        return Err(refused("At least one personality profile is required"));
    }
    let now = Bson::DateTime(ctx.now());
    let stamped: Vec<Bson> = profiles
        .into_iter()
        .map(|mut profile| {
            // `{...profile, createdAt, updatedAt}`: both land after the other fields.
            let created = match profile.remove("createdAt") {
                Some(Bson::DateTime(date)) => Bson::DateTime(date),
                _ => now.clone(),
            };
            profile.remove("updatedAt");
            profile.insert("createdAt", created);
            profile.insert("updatedAt", now.clone());
            Bson::Document(profile)
        })
        .collect();
    sets.push(("profiles".to_owned(), Bson::Array(stamped)));
    let rules = array_len(&document, "rules");
    let known = array_len(&document, "knownUsers");
    let window = match plan {
        "pro" => 35,
        "premium" => {
            if rules > 5 {
                return Err(refused("Premium channels can only have up to 5 rules"));
            }
            if known > 10 {
                return Err(refused(
                    "Premium channels can only have up to 10 known users",
                ));
            }
            15
        }
        _ => {
            if rules > 3 {
                return Err(refused("Free channels can only have up to 3 rules"));
            }
            if known > 3 {
                return Err(refused("Free channels can only have up to 3 known users"));
            }
            7
        }
    };
    sets.push(("contextWindow".to_owned(), Bson::Int32(window)));
    Ok(sets)
}

/// `doc.save()` of a loaded personality after `changes`, with both hooks: `ensureProfiles` is
/// applied before validation, the `pre('save')` hook after it. `owner` is the plan of the user
/// the hook finds (see [`OwnerPlan`]).
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    owner: OwnerPlan<'_>,
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    let after = document_after(&INFO, loaded.document(), changes, ctx)?;
    let mut all: Vec<Change> = changes.to_vec();
    all.extend(
        ensure_profiles(&after, ctx)
            .into_iter()
            .map(|(path, value)| Change::set(path, value)),
    );
    save_with_hooks(
        &INFO,
        loaded,
        &all,
        |loaded, changes, ctx| {
            let after = document_after(&INFO, loaded, changes, ctx)?;
            Ok(pre_save(&after, owner, ctx)?
                .into_iter()
                .map(|(path, value)| Change::set(path, value))
                .collect())
        },
        ctx,
    )
}

// ------------------------------------------------------------------------------------- writing

/// A new personality (`ChannelAIPersonalitySchema.create({...})`). Unset fields take the schema
/// defaults.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewChannelAiPersonality {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// Mention answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Post-stream summaries.
    #[serde(
        rename = "streamSummariesEnabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub stream_summaries_enabled: Option<bool>,
    /// Recommendations.
    #[serde(
        rename = "recommendationsEnabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub recommendations_enabled: Option<bool>,
    /// Profiles (as `sanitizeProfiles` builds them).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<Document>>,
    /// The active profile.
    #[serde(rename = "activeProfileId", skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    /// Persona text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
    /// Rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// Known viewers.
    #[serde(rename = "knownUsers", skip_serializing_if = "Option::is_none")]
    pub known_users: Option<Private<Vec<NewKnownUser>>>,
    /// Context window.
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    pub context_window: Option<JsNumber>,
}

/// A known viewer of a new personality.
#[derive(Clone, Debug, Serialize)]
pub struct NewKnownUser {
    /// Login.
    pub username: String,
    /// Who they are.
    pub description: String,
    /// Relationship.
    pub relationship: String,
    /// Last interaction.
    #[serde(rename = "lastInteraction")]
    pub last_interaction: JsDate,
}

impl NewChannelAiPersonality {
    /// The values given to the constructor (before defaults and hooks).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends: defaults, `ensureProfiles`, validation, then the save hook
    /// with the owner's plan (`None`: refused, no user owns the channel).
    pub fn prepare(
        &self,
        owner: OwnerPlan<'_>,
        ctx: &mut WriteContext,
    ) -> Result<PreparedInsert, ModelError> {
        create_with_hooks(
            &INFO,
            &self.to_document()?,
            |document, ctx| {
                for (path, value) in ensure_profiles(document, ctx) {
                    document.insert(path, value);
                }
                Ok(())
            },
            |document, ctx| {
                for (path, value) in pre_save(document, owner, ctx)? {
                    document.insert(path, value);
                }
                Ok(())
            },
            ctx,
        )
    }
}
