//! `pet_requests`: reference `dimabot/src/schemas/pet_runtime.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! pets/admission.ts:29 checks input text/origin/actor identity and :151 spreads the trusted
//! internal action constructed by desktop_ai/execution.ts:128 and command/event engines.
//! pets/read_tts.ts:337 builds TTS requests; pets/state.ts:44 and runtime.ts write typed transitions.
//! server/routes/pet.route.ts only cancels by validated command identity; it does not accept a row.
//! No unchecked client-fed paths (0), runValidators or document saves. Legacy optional audio null,
//! missing startBefore/outputText/emoteNames, optional chat/badges and lifecycle flags accepted.
//! Unique origin/action index is required: admission.ts:49 awaits init and duplicates must not speak twice.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::Open;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "pet_requests";
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetRequestStatusValue {/// queued
Queued = "queued",/// accepted
Accepted = "accepted",/// generating
Generating = "generating",/// synthesizing
Synthesizing = "synthesizing",/// ready
Ready = "ready",/// playing
Playing = "playing",/// completed
Completed = "completed",/// cancelled
Cancelled = "cancelled",/// failed
Failed = "failed",/// expired
Expired = "expired"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum PetRequestLaneValue {/// independent
Independent = "independent",/// tts
Tts = "tts"}}
fn read_default_pet_request_actor_chat_badges() -> Vec<PetRequestActorChatBadges> {
    vec![]
}
fn read_default_pet_request_admitted() -> bool {
    false
}
static SCHEMA_ACTOR_CHAT_BADGES: Schema = Schema::subdocument(&[
    Field::string("set_id"),
    Field::string("id"),
    Field::string("info"),
])
.no_id();
static SCHEMA_AUDIO: Schema = Schema::subdocument(&[
    Field::string("path"),
    Field::string("mimeType"),
    Field::number("durationMs"),
])
.no_id();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("ownerId"),
    Field::string("channelId"),
    Field::string("operation"),
    Field::string("text"),
    Field::nested(
        "origin",
        &[
            Field::string("kind"),
            Field::string("id"),
            Field::string("occurredAt"),
            Field::string("sessionId"),
        ],
    ),
    Field::string("actionKey"),
    Field::nested(
        "actor",
        &[
            Field::string("userId"),
            Field::string("displayName"),
            Field::nested(
                "chat",
                &[
                    Field::string("login"),
                    Field::string("message"),
                    Field::document_array("badges", &SCHEMA_ACTOR_CHAT_BADGES)
                        .default(D::EmptyArray),
                ],
            ),
        ],
    ),
    Field::string("payloadHash"),
    Field::boolean("admitted").default(D::Bool(false)),
    Field::date("startBefore"),
    Field::number("generation"),
    Field::number("settingsRevision"),
    Field::string("status"),
    Field::number("version"),
    Field::boolean("deliveryAttempted"),
    Field::boolean("audioFetched"),
    Field::boolean("playbackStarted"),
    Field::string("lane"),
    Field::string("ttsSpeechId"),
    Field::string("privateDir"),
    Field::string("outputText"),
    Field::string("errorCode"),
    Field::date("phaseDeadline"),
    Field::array("emoteNames", ValueType::String).no_default(),
    Field::string("mood"),
    Field::string("moodText"),
    Field::subdocument("audio", &SCHEMA_AUDIO).default(D::Null),
    Field::date("createdAt"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequestOrigin {
    /// `origin.kind`.
    #[serde(rename = "kind", default)]
    pub kind: Option<String>,
    /// `origin.id`.
    #[serde(rename = "id", default)]
    pub id: Option<String>,
    /// `origin.occurredAt`.
    #[serde(rename = "occurredAt", default)]
    pub occurred_at: Option<String>,
    /// `origin.sessionId`.
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequestOrigin {
    /// `origin.kind`.
    #[serde(rename = "kind", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `origin.id`.
    #[serde(rename = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// `origin.occurredAt`.
    #[serde(rename = "occurredAt", skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    /// `origin.sessionId`.
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequestActorChatBadges {
    /// `actor.chat.badges.$.set_id`.
    #[serde(rename = "set_id", default)]
    pub set_id: Option<String>,
    /// `actor.chat.badges.$.id`.
    #[serde(rename = "id", default)]
    pub id: Option<String>,
    /// `actor.chat.badges.$.info`.
    #[serde(rename = "info", default)]
    pub info: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequestActorChatBadges {
    /// `actor.chat.badges.$.set_id`.
    #[serde(rename = "set_id", skip_serializing_if = "Option::is_none")]
    pub set_id: Option<String>,
    /// `actor.chat.badges.$.id`.
    #[serde(rename = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// `actor.chat.badges.$.info`.
    #[serde(rename = "info", skip_serializing_if = "Option::is_none")]
    pub info: Option<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequestActorChat {
    /// `actor.chat.login`.
    #[serde(rename = "login", default)]
    pub login: Option<String>,
    /// `actor.chat.message`.
    #[serde(rename = "message", default)]
    pub message: Option<Private<String>>,
    /// `actor.chat.badges`.
    #[serde(
        rename = "badges",
        default = "read_default_pet_request_actor_chat_badges"
    )]
    pub badges: Vec<PetRequestActorChatBadges>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequestActorChat {
    /// `actor.chat.login`.
    #[serde(rename = "login", skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// `actor.chat.message`.
    #[serde(rename = "message", skip_serializing_if = "Option::is_none")]
    pub message: Option<Private<String>>,
    /// `actor.chat.badges`.
    #[serde(rename = "badges", skip_serializing_if = "Option::is_none")]
    pub badges: Option<Vec<NewPetRequestActorChatBadges>>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequestActor {
    /// `actor.userId`.
    #[serde(rename = "userId", default)]
    pub user_id: Option<String>,
    /// `actor.displayName`.
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
    /// `actor.chat`.
    #[serde(rename = "chat", default)]
    pub chat: Option<PetRequestActorChat>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequestActor {
    /// `actor.userId`.
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// `actor.displayName`.
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// `actor.chat`.
    #[serde(rename = "chat", skip_serializing_if = "Option::is_none")]
    pub chat: Option<NewPetRequestActorChat>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequestAudio {
    /// `audio.path`.
    #[serde(rename = "path", default)]
    pub path: Option<Private<String>>,
    /// `audio.mimeType`.
    #[serde(rename = "mimeType", default)]
    pub mime_type: Option<String>,
    /// `audio.durationMs`.
    #[serde(rename = "durationMs", default)]
    pub duration_ms: Option<JsNumber>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequestAudio {
    /// `audio.path`.
    #[serde(rename = "path", skip_serializing_if = "Option::is_none")]
    pub path: Option<Private<String>>,
    /// `audio.mimeType`.
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// `audio.durationMs`.
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRequest {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `ownerId`.
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    /// `channelId`.
    #[serde(rename = "channelId", default)]
    pub channel_id: Option<String>,
    /// `operation`.
    #[serde(rename = "operation", default)]
    pub operation: Option<String>,
    /// `text`.
    #[serde(rename = "text", default)]
    pub text: Option<Private<String>>,
    /// `origin`.
    #[serde(rename = "origin", default)]
    pub origin: Option<PetRequestOrigin>,
    /// `actionKey`.
    #[serde(rename = "actionKey", default)]
    pub action_key: Option<String>,
    /// `actor`.
    #[serde(rename = "actor", default)]
    pub actor: Option<PetRequestActor>,
    /// `payloadHash`.
    #[serde(rename = "payloadHash", default)]
    pub payload_hash: Option<String>,
    /// `admitted`.
    #[serde(rename = "admitted", default = "read_default_pet_request_admitted")]
    pub admitted: bool,
    /// `startBefore`.
    #[serde(rename = "startBefore", default)]
    pub start_before: Option<JsDate>,
    /// `generation`.
    #[serde(rename = "generation", default)]
    pub generation: Option<JsNumber>,
    /// `settingsRevision`.
    #[serde(rename = "settingsRevision", default)]
    pub settings_revision: Option<JsNumber>,
    /// `status`.
    #[serde(rename = "status", default)]
    pub status: Option<Open<PetRequestStatusValue>>,
    /// `version`.
    #[serde(rename = "version", default)]
    pub version: Option<JsNumber>,
    /// `deliveryAttempted`.
    #[serde(rename = "deliveryAttempted", default)]
    pub delivery_attempted: Option<bool>,
    /// `audioFetched`.
    #[serde(rename = "audioFetched", default)]
    pub audio_fetched: Option<bool>,
    /// `playbackStarted`.
    #[serde(rename = "playbackStarted", default)]
    pub playback_started: Option<bool>,
    /// `lane`.
    #[serde(rename = "lane", default)]
    pub lane: Option<Open<PetRequestLaneValue>>,
    /// `ttsSpeechId`.
    #[serde(rename = "ttsSpeechId", default)]
    pub tts_speech_id: Option<String>,
    /// `privateDir`.
    #[serde(rename = "privateDir", default)]
    pub private_dir: Option<Private<String>>,
    /// `outputText`.
    #[serde(rename = "outputText", default)]
    pub output_text: Option<Private<String>>,
    /// `errorCode`.
    #[serde(rename = "errorCode", default)]
    pub error_code: Option<String>,
    /// `phaseDeadline`.
    #[serde(rename = "phaseDeadline", default)]
    pub phase_deadline: Option<JsDate>,
    /// `emoteNames`.
    #[serde(rename = "emoteNames", default)]
    pub emote_names: Option<Vec<Option<String>>>,
    /// `mood`.
    #[serde(rename = "mood", default)]
    pub mood: Option<String>,
    /// `moodText`.
    #[serde(rename = "moodText", default)]
    pub mood_text: Option<Private<String>>,
    /// `audio`.
    #[serde(rename = "audio", default)]
    pub audio: Option<PetRequestAudio>,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRequest {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `ownerId`.
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    /// `channelId`.
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `operation`.
    #[serde(rename = "operation", skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// `text`.
    #[serde(rename = "text", skip_serializing_if = "Option::is_none")]
    pub text: Option<Private<String>>,
    /// `origin`.
    #[serde(rename = "origin", skip_serializing_if = "Option::is_none")]
    pub origin: Option<NewPetRequestOrigin>,
    /// `actionKey`.
    #[serde(rename = "actionKey", skip_serializing_if = "Option::is_none")]
    pub action_key: Option<String>,
    /// `actor`.
    #[serde(rename = "actor", skip_serializing_if = "Option::is_none")]
    pub actor: Option<NewPetRequestActor>,
    /// `payloadHash`.
    #[serde(rename = "payloadHash", skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
    /// `admitted`.
    #[serde(rename = "admitted", skip_serializing_if = "Option::is_none")]
    pub admitted: Option<bool>,
    /// `startBefore`.
    #[serde(rename = "startBefore", skip_serializing_if = "Option::is_none")]
    pub start_before: Option<JsDate>,
    /// `generation`.
    #[serde(rename = "generation", skip_serializing_if = "Option::is_none")]
    pub generation: Option<JsNumber>,
    /// `settingsRevision`.
    #[serde(rename = "settingsRevision", skip_serializing_if = "Option::is_none")]
    pub settings_revision: Option<JsNumber>,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<PetRequestStatusValue>,
    /// `version`.
    #[serde(rename = "version", skip_serializing_if = "Option::is_none")]
    pub version: Option<JsNumber>,
    /// `deliveryAttempted`.
    #[serde(rename = "deliveryAttempted", skip_serializing_if = "Option::is_none")]
    pub delivery_attempted: Option<bool>,
    /// `audioFetched`.
    #[serde(rename = "audioFetched", skip_serializing_if = "Option::is_none")]
    pub audio_fetched: Option<bool>,
    /// `playbackStarted`.
    #[serde(rename = "playbackStarted", skip_serializing_if = "Option::is_none")]
    pub playback_started: Option<bool>,
    /// `lane`.
    #[serde(rename = "lane", skip_serializing_if = "Option::is_none")]
    pub lane: Option<PetRequestLaneValue>,
    /// `ttsSpeechId`.
    #[serde(rename = "ttsSpeechId", skip_serializing_if = "Option::is_none")]
    pub tts_speech_id: Option<String>,
    /// `privateDir`.
    #[serde(rename = "privateDir", skip_serializing_if = "Option::is_none")]
    pub private_dir: Option<Private<String>>,
    /// `outputText`.
    #[serde(rename = "outputText", skip_serializing_if = "Option::is_none")]
    pub output_text: Option<Private<String>>,
    /// `errorCode`.
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// `phaseDeadline`.
    #[serde(rename = "phaseDeadline", skip_serializing_if = "Option::is_none")]
    pub phase_deadline: Option<JsDate>,
    /// `emoteNames`.
    #[serde(rename = "emoteNames", skip_serializing_if = "Option::is_none")]
    pub emote_names: Option<Vec<Option<String>>>,
    /// `mood`.
    #[serde(rename = "mood", skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    /// `moodText`.
    #[serde(rename = "moodText", skip_serializing_if = "Option::is_none")]
    pub mood_text: Option<Private<String>>,
    /// `audio`.
    #[serde(rename = "audio", skip_serializing_if = "Nullable::is_unset")]
    pub audio: Nullable<NewPetRequestAudio>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[
    "text",
    "actor.chat.message",
    "outputText",
    "moodText",
    "privateDir",
    "audio.path",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[
        ("ownerId", 1),
        ("origin.kind", 1),
        ("origin.id", 1),
        ("actionKey", 1),
    ])
    .unique(),
    IndexSpec::on(&[("status", 1), ("phaseDeadline", 1)]),
    IndexSpec::on(&[("ownerId", 1), ("status", 1), ("createdAt", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("ownerId"),
    Rule::one_of(
        "status",
        &[
            "queued",
            "accepted",
            "generating",
            "synthesizing",
            "ready",
            "playing",
            "completed",
            "cancelled",
            "failed",
            "expired",
        ],
    ),
    Rule::one_of("lane", &["independent", "tts"]),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("ownerId"),
    ReadNeed::not_null("actor.chat.badges"),
    ReadNeed::not_null("admitted"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "PetRequest",
    source: "dimabot/src/schemas/pet_runtime.schema.ts",
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
    decode: decode_boxed::<PetRequest>,
};
impl NewPetRequest {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
