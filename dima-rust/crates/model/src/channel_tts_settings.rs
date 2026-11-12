//! `channel_tts_settings`: a channel's text-to-speech settings (provider, voices, message
//! filters, the expressive tags Fish may use, the queue size).
//!
//! Reference: `dimabot/src/schemas/channel_tts_settings.schema.ts` (model `channel_tts_settings`).
//! Camel-case timestamps, `__v`, no hooks. Unique `channelID` (field level), best effort (the
//! reference's create retries on a duplicate key, and nothing awaits the index). Writes: a whole
//! `doc.set(normalized)` and `save()` (`upsertChannelTtsSettings`), `Model.create` and a guarded
//! `$set` of the changed paths (`tts_settings.service.ts`), the Fish voice upsert, and the alias
//! move of `channel_fish_voice_favorites.schema.ts`.
//!
//! `filters.expressiveTags` declares one boolean per expressive tag ([`EXPRESSIVE_TAGS`], 75 of
//! them, `true` by default); the read type keeps them as [`ExpressiveTags`].
//!
//! Legacy shapes accepted: one document has the old `filters.expressiveTags.inline` and
//! `.wrapping` objects (kept, the reference still reads them), one has no `expressiveTags`, 11
//! have no `voices.kokoroDefault`; fields of the removed AI provider (`aiProvider`,
//! `providerSettings`, `voices.aiDefault` stored as `null`, `voices.aiVoices`,
//! `voices.aiVoicesByProvider`) are not in the schema and are ignored.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, yes};
use crate::enums::{Open, StrEnum, str_enum};
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
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// The collection name.
pub const COLLECTION: &str = "channel_tts_settings";

str_enum! {
    /// `provider`.
    pub enum TtsProvider {
        /// Piper, local (the default).
        Piper = "piper",
        /// Fish Audio (paid).
        Fish = "fish",
        /// Kokoro, local.
        Kokoro = "kokoro",
    }
}

str_enum! {
    /// `defaultLanguage`.
    pub enum TtsLanguage {
        /// English.
        En = "en",
        /// Spanish (the default).
        Es = "es",
    }
}

/// The expressive tags (`EXPRESSIVE_TTS_TAGS`: emotions, delivery, sounds, effects), in the
/// reference's order.
pub const EXPRESSIVE_TAGS: &[&str] = &[
    "happy",
    "sad",
    "angry",
    "excited",
    "calm",
    "nervous",
    "confident",
    "surprised",
    "scared",
    "worried",
    "disappointed",
    "curious",
    "sarcastic",
    "satisfied",
    "delighted",
    "upset",
    "frustrated",
    "depressed",
    "empathetic",
    "embarrassed",
    "disgusted",
    "moved",
    "proud",
    "relaxed",
    "grateful",
    "disdainful",
    "unhappy",
    "anxious",
    "hysterical",
    "indifferent",
    "uncertain",
    "doubtful",
    "confused",
    "regretful",
    "guilty",
    "ashamed",
    "jealous",
    "envious",
    "hopeful",
    "optimistic",
    "pessimistic",
    "nostalgic",
    "lonely",
    "bored",
    "contemptuous",
    "sympathetic",
    "compassionate",
    "determined",
    "resigned",
    "whisper",
    "shouting",
    "soft",
    "singing",
    "slow",
    "fast",
    "emphasis",
    "screaming",
    "laugh",
    "chuckle",
    "giggle",
    "cry",
    "sigh",
    "gasp",
    "inhale",
    "exhale",
    "sobbing",
    "groaning",
    "panting",
    "yawning",
    "snoring",
    "clear throat",
    "pause",
    "long-pause",
    "audience laughing",
    "background laughter",
];

const EXPRESSIVE_TAG_FIELDS: &[Field] = &[
    Field::boolean("happy").default(D::Bool(true)),
    Field::boolean("sad").default(D::Bool(true)),
    Field::boolean("angry").default(D::Bool(true)),
    Field::boolean("excited").default(D::Bool(true)),
    Field::boolean("calm").default(D::Bool(true)),
    Field::boolean("nervous").default(D::Bool(true)),
    Field::boolean("confident").default(D::Bool(true)),
    Field::boolean("surprised").default(D::Bool(true)),
    Field::boolean("scared").default(D::Bool(true)),
    Field::boolean("worried").default(D::Bool(true)),
    Field::boolean("disappointed").default(D::Bool(true)),
    Field::boolean("curious").default(D::Bool(true)),
    Field::boolean("sarcastic").default(D::Bool(true)),
    Field::boolean("satisfied").default(D::Bool(true)),
    Field::boolean("delighted").default(D::Bool(true)),
    Field::boolean("upset").default(D::Bool(true)),
    Field::boolean("frustrated").default(D::Bool(true)),
    Field::boolean("depressed").default(D::Bool(true)),
    Field::boolean("empathetic").default(D::Bool(true)),
    Field::boolean("embarrassed").default(D::Bool(true)),
    Field::boolean("disgusted").default(D::Bool(true)),
    Field::boolean("moved").default(D::Bool(true)),
    Field::boolean("proud").default(D::Bool(true)),
    Field::boolean("relaxed").default(D::Bool(true)),
    Field::boolean("grateful").default(D::Bool(true)),
    Field::boolean("disdainful").default(D::Bool(true)),
    Field::boolean("unhappy").default(D::Bool(true)),
    Field::boolean("anxious").default(D::Bool(true)),
    Field::boolean("hysterical").default(D::Bool(true)),
    Field::boolean("indifferent").default(D::Bool(true)),
    Field::boolean("uncertain").default(D::Bool(true)),
    Field::boolean("doubtful").default(D::Bool(true)),
    Field::boolean("confused").default(D::Bool(true)),
    Field::boolean("regretful").default(D::Bool(true)),
    Field::boolean("guilty").default(D::Bool(true)),
    Field::boolean("ashamed").default(D::Bool(true)),
    Field::boolean("jealous").default(D::Bool(true)),
    Field::boolean("envious").default(D::Bool(true)),
    Field::boolean("hopeful").default(D::Bool(true)),
    Field::boolean("optimistic").default(D::Bool(true)),
    Field::boolean("pessimistic").default(D::Bool(true)),
    Field::boolean("nostalgic").default(D::Bool(true)),
    Field::boolean("lonely").default(D::Bool(true)),
    Field::boolean("bored").default(D::Bool(true)),
    Field::boolean("contemptuous").default(D::Bool(true)),
    Field::boolean("sympathetic").default(D::Bool(true)),
    Field::boolean("compassionate").default(D::Bool(true)),
    Field::boolean("determined").default(D::Bool(true)),
    Field::boolean("resigned").default(D::Bool(true)),
    Field::boolean("whisper").default(D::Bool(true)),
    Field::boolean("shouting").default(D::Bool(true)),
    Field::boolean("soft").default(D::Bool(true)),
    Field::boolean("singing").default(D::Bool(true)),
    Field::boolean("slow").default(D::Bool(true)),
    Field::boolean("fast").default(D::Bool(true)),
    Field::boolean("emphasis").default(D::Bool(true)),
    Field::boolean("screaming").default(D::Bool(true)),
    Field::boolean("laugh").default(D::Bool(true)),
    Field::boolean("chuckle").default(D::Bool(true)),
    Field::boolean("giggle").default(D::Bool(true)),
    Field::boolean("cry").default(D::Bool(true)),
    Field::boolean("sigh").default(D::Bool(true)),
    Field::boolean("gasp").default(D::Bool(true)),
    Field::boolean("inhale").default(D::Bool(true)),
    Field::boolean("exhale").default(D::Bool(true)),
    Field::boolean("sobbing").default(D::Bool(true)),
    Field::boolean("groaning").default(D::Bool(true)),
    Field::boolean("panting").default(D::Bool(true)),
    Field::boolean("yawning").default(D::Bool(true)),
    Field::boolean("snoring").default(D::Bool(true)),
    Field::boolean("clear throat").default(D::Bool(true)),
    Field::boolean("pause").default(D::Bool(true)),
    Field::boolean("long-pause").default(D::Bool(true)),
    Field::boolean("audience laughing").default(D::Bool(true)),
    Field::boolean("background laughter").default(D::Bool(true)),
];

const VOICES: &[Field] = &[
    Field::string("en").default(D::Str("en_US-ryan-medium")),
    Field::string("es").default(D::Str("es_MX-ald-medium")),
    Field::string("cloneDefault").default(D::Str("gojo")),
    Field::string("kokoroDefault").default(D::Str("ef_dora")),
];

const FILTERS: &[Field] = &[
    Field::boolean("skipEmotes").default(D::Bool(true)),
    Field::boolean("stripLinks").default(D::Bool(true)),
    Field::boolean("normalizeWhitespace").default(D::Bool(true)),
    Field::number("maxLength").default(D::Int(280)),
    Field::nested("expressiveTags", EXPRESSIVE_TAG_FIELDS),
];

const QUEUE: &[Field] = &[Field::number("maxItems").default(D::Int(5))];

/// The schema, field by field as `channel_tts_settings.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("")),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::string("provider").default(D::Str("piper")),
    Field::string("defaultLanguage").default(D::Str("es")),
    Field::nested("voices", VOICES),
    Field::nested("filters", FILTERS),
    Field::nested("queue", QUEUE),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1)]).unique()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::one_of("provider", TtsProvider::STRINGS),
    Rule::one_of("defaultLanguage", TtsLanguage::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::not_null("enabled"),
    ReadNeed::not_null("provider"),
    ReadNeed::not_null("defaultLanguage"),
    ReadNeed::not_null("voices"),
    ReadNeed::not_null("voices.en"),
    ReadNeed::not_null("voices.es"),
    ReadNeed::not_null("voices.cloneDefault"),
    ReadNeed::not_null("voices.kokoroDefault"),
    ReadNeed::not_null("filters"),
    ReadNeed::not_null("filters.skipEmotes"),
    ReadNeed::not_null("filters.stripLinks"),
    ReadNeed::not_null("filters.normalizeWhitespace"),
    ReadNeed::not_null("filters.maxLength"),
    ReadNeed::not_null("filters.expressiveTags"),
    ReadNeed::not_null("filters.expressiveTags.happy"),
    ReadNeed::not_null("filters.expressiveTags.sad"),
    ReadNeed::not_null("filters.expressiveTags.angry"),
    ReadNeed::not_null("filters.expressiveTags.excited"),
    ReadNeed::not_null("filters.expressiveTags.calm"),
    ReadNeed::not_null("filters.expressiveTags.nervous"),
    ReadNeed::not_null("filters.expressiveTags.confident"),
    ReadNeed::not_null("filters.expressiveTags.surprised"),
    ReadNeed::not_null("filters.expressiveTags.scared"),
    ReadNeed::not_null("filters.expressiveTags.worried"),
    ReadNeed::not_null("filters.expressiveTags.disappointed"),
    ReadNeed::not_null("filters.expressiveTags.curious"),
    ReadNeed::not_null("filters.expressiveTags.sarcastic"),
    ReadNeed::not_null("filters.expressiveTags.satisfied"),
    ReadNeed::not_null("filters.expressiveTags.delighted"),
    ReadNeed::not_null("filters.expressiveTags.upset"),
    ReadNeed::not_null("filters.expressiveTags.frustrated"),
    ReadNeed::not_null("filters.expressiveTags.depressed"),
    ReadNeed::not_null("filters.expressiveTags.empathetic"),
    ReadNeed::not_null("filters.expressiveTags.embarrassed"),
    ReadNeed::not_null("filters.expressiveTags.disgusted"),
    ReadNeed::not_null("filters.expressiveTags.moved"),
    ReadNeed::not_null("filters.expressiveTags.proud"),
    ReadNeed::not_null("filters.expressiveTags.relaxed"),
    ReadNeed::not_null("filters.expressiveTags.grateful"),
    ReadNeed::not_null("filters.expressiveTags.disdainful"),
    ReadNeed::not_null("filters.expressiveTags.unhappy"),
    ReadNeed::not_null("filters.expressiveTags.anxious"),
    ReadNeed::not_null("filters.expressiveTags.hysterical"),
    ReadNeed::not_null("filters.expressiveTags.indifferent"),
    ReadNeed::not_null("filters.expressiveTags.uncertain"),
    ReadNeed::not_null("filters.expressiveTags.doubtful"),
    ReadNeed::not_null("filters.expressiveTags.confused"),
    ReadNeed::not_null("filters.expressiveTags.regretful"),
    ReadNeed::not_null("filters.expressiveTags.guilty"),
    ReadNeed::not_null("filters.expressiveTags.ashamed"),
    ReadNeed::not_null("filters.expressiveTags.jealous"),
    ReadNeed::not_null("filters.expressiveTags.envious"),
    ReadNeed::not_null("filters.expressiveTags.hopeful"),
    ReadNeed::not_null("filters.expressiveTags.optimistic"),
    ReadNeed::not_null("filters.expressiveTags.pessimistic"),
    ReadNeed::not_null("filters.expressiveTags.nostalgic"),
    ReadNeed::not_null("filters.expressiveTags.lonely"),
    ReadNeed::not_null("filters.expressiveTags.bored"),
    ReadNeed::not_null("filters.expressiveTags.contemptuous"),
    ReadNeed::not_null("filters.expressiveTags.sympathetic"),
    ReadNeed::not_null("filters.expressiveTags.compassionate"),
    ReadNeed::not_null("filters.expressiveTags.determined"),
    ReadNeed::not_null("filters.expressiveTags.resigned"),
    ReadNeed::not_null("filters.expressiveTags.whisper"),
    ReadNeed::not_null("filters.expressiveTags.shouting"),
    ReadNeed::not_null("filters.expressiveTags.soft"),
    ReadNeed::not_null("filters.expressiveTags.singing"),
    ReadNeed::not_null("filters.expressiveTags.slow"),
    ReadNeed::not_null("filters.expressiveTags.fast"),
    ReadNeed::not_null("filters.expressiveTags.emphasis"),
    ReadNeed::not_null("filters.expressiveTags.screaming"),
    ReadNeed::not_null("filters.expressiveTags.laugh"),
    ReadNeed::not_null("filters.expressiveTags.chuckle"),
    ReadNeed::not_null("filters.expressiveTags.giggle"),
    ReadNeed::not_null("filters.expressiveTags.cry"),
    ReadNeed::not_null("filters.expressiveTags.sigh"),
    ReadNeed::not_null("filters.expressiveTags.gasp"),
    ReadNeed::not_null("filters.expressiveTags.inhale"),
    ReadNeed::not_null("filters.expressiveTags.exhale"),
    ReadNeed::not_null("filters.expressiveTags.sobbing"),
    ReadNeed::not_null("filters.expressiveTags.groaning"),
    ReadNeed::not_null("filters.expressiveTags.panting"),
    ReadNeed::not_null("filters.expressiveTags.yawning"),
    ReadNeed::not_null("filters.expressiveTags.snoring"),
    ReadNeed::not_null("filters.expressiveTags.clear throat"),
    ReadNeed::not_null("filters.expressiveTags.pause"),
    ReadNeed::not_null("filters.expressiveTags.long-pause"),
    ReadNeed::not_null("filters.expressiveTags.audience laughing"),
    ReadNeed::not_null("filters.expressiveTags.background laughter"),
    ReadNeed::not_null("queue"),
    ReadNeed::not_null("queue.maxItems"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "channel_tts_settings",
    source: "dimabot/src/schemas/channel_tts_settings.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<ChannelTtsSettings>,
};

/// A channel's stored settings, defaults filled in as a hydrated Mongoose document shows them.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelTtsSettings {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(default = "empty")]
    pub channel: String,
    /// TTS is on.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The provider.
    #[serde(default = "piper")]
    pub provider: Open<TtsProvider>,
    /// The language of messages without a language tag.
    #[serde(default = "spanish", rename = "defaultLanguage")]
    pub default_language: Open<TtsLanguage>,
    /// The voices.
    #[serde(default)]
    pub voices: TtsVoices,
    /// Message filters.
    #[serde(default)]
    pub filters: TtsFilters,
    /// The queue.
    #[serde(default)]
    pub queue: TtsQueue,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn piper() -> Open<TtsProvider> {
    Open::Known(TtsProvider::Piper)
}

fn spanish() -> Open<TtsLanguage> {
    Open::Known(TtsLanguage::Es)
}

fn text(value: &str) -> String {
    value.to_owned()
}

/// `voices`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TtsVoices {
    /// The Piper voice for English.
    #[serde(default = "voice_en")]
    pub en: String,
    /// The Piper voice for Spanish.
    #[serde(default = "voice_es")]
    pub es: String,
    /// The Fish voice (a built-in name, a favorite's alias or a model id).
    #[serde(default = "voice_clone", rename = "cloneDefault")]
    pub clone_default: String,
    /// The Kokoro voice.
    #[serde(default = "voice_kokoro", rename = "kokoroDefault")]
    pub kokoro_default: String,
}

fn voice_en() -> String {
    text("en_US-ryan-medium")
}

fn voice_es() -> String {
    text("es_MX-ald-medium")
}

fn voice_clone() -> String {
    text("gojo")
}

fn voice_kokoro() -> String {
    text("ef_dora")
}

impl Default for TtsVoices {
    fn default() -> Self {
        Self {
            en: voice_en(),
            es: voice_es(),
            clone_default: voice_clone(),
            kokoro_default: voice_kokoro(),
        }
    }
}

/// `filters`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TtsFilters {
    /// Emotes are not read.
    #[serde(default = "yes", rename = "skipEmotes")]
    pub skip_emotes: bool,
    /// Links are not read.
    #[serde(default = "yes", rename = "stripLinks")]
    pub strip_links: bool,
    /// Runs of whitespace are collapsed.
    #[serde(default = "yes", rename = "normalizeWhitespace")]
    pub normalize_whitespace: bool,
    /// Longest message read, in characters.
    #[serde(default = "max_length", rename = "maxLength")]
    pub max_length: JsNumber,
    /// The expressive tags Fish may use.
    #[serde(default, rename = "expressiveTags")]
    pub expressive_tags: ExpressiveTags,
}

fn max_length() -> JsNumber {
    JsNumber(280.0)
}

impl Default for TtsFilters {
    fn default() -> Self {
        Self {
            skip_emotes: true,
            strip_links: true,
            normalize_whitespace: true,
            max_length: max_length(),
            expressive_tags: ExpressiveTags::default(),
        }
    }
}

/// `filters.expressiveTags`: one boolean per tag of [`EXPRESSIVE_TAGS`] (missing reads as
/// `true`, the default), in stored order, and the legacy `inline` and `wrapping` objects older
/// documents hold (the reference still reads them as a fallback).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExpressiveTags {
    /// The stored tags.
    pub stored: Vec<(String, bool)>,
    /// The legacy `inline` object, as stored.
    pub legacy_inline: Option<Bson>,
    /// The legacy `wrapping` object, as stored.
    pub legacy_wrapping: Option<Bson>,
}

impl ExpressiveTags {
    /// Whether `tag` may be used, as a hydrated document shows it (`true` when not stored).
    pub fn enabled(&self, tag: &str) -> bool {
        self.stored
            .iter()
            .find(|(name, _)| name == tag)
            .is_none_or(|(_, on)| *on)
    }
}

impl<'de> Deserialize<'de> for ExpressiveTags {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Tags;
        impl<'de> Visitor<'de> for Tags {
            type Value = ExpressiveTags;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a document of booleans")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ExpressiveTags, A::Error> {
                let mut tags = ExpressiveTags::default();
                while let Some(key) = map.next_key::<String>()? {
                    let value: Bson = map.next_value()?;
                    match (key.as_str(), value) {
                        ("inline", value) => tags.legacy_inline = Some(value),
                        ("wrapping", value) => tags.legacy_wrapping = Some(value),
                        (_, Bson::Boolean(on)) => tags.stored.push((key, on)),
                        (name, other) if EXPRESSIVE_TAGS.contains(&name) => {
                            return Err(de::Error::custom(format!(
                                "expressive tag `{name}` is not a boolean: {other}"
                            )));
                        }
                        // Not a schema path: Mongoose would not have written it; ignored.
                        _ => {}
                    }
                }
                Ok(tags)
            }
        }
        deserializer.deserialize_map(Tags)
    }
}

/// `queue`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TtsQueue {
    /// Most messages waiting.
    #[serde(default = "max_items", rename = "maxItems")]
    pub max_items: JsNumber,
}

fn max_items() -> JsNumber {
    JsNumber(5.0)
}

impl Default for TtsQueue {
    fn default() -> Self {
        Self {
            max_items: max_items(),
        }
    }
}

/// New settings (`new ChannelTtsSettingsSchema(normalized).save()` and `Model.create(next)`: the
/// reference always passes the whole normalized settings).
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelTtsSettings {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// TTS is on.
    pub enabled: bool,
    /// The provider.
    pub provider: TtsProvider,
    /// The default language.
    #[serde(rename = "defaultLanguage")]
    pub default_language: TtsLanguage,
    /// The voices.
    pub voices: NewTtsVoices,
    /// Message filters.
    pub filters: NewTtsFilters,
    /// The queue.
    pub queue: NewTtsQueue,
}

/// `voices` of new settings.
#[derive(Clone, Debug, Serialize)]
pub struct NewTtsVoices {
    /// Piper, English.
    pub en: String,
    /// Piper, Spanish.
    pub es: String,
    /// Fish.
    #[serde(rename = "cloneDefault")]
    pub clone_default: String,
    /// Kokoro.
    #[serde(rename = "kokoroDefault")]
    pub kokoro_default: String,
}

/// `filters` of new settings.
#[derive(Clone, Debug, Serialize)]
pub struct NewTtsFilters {
    /// Skip emotes.
    #[serde(rename = "skipEmotes")]
    pub skip_emotes: bool,
    /// Strip links.
    #[serde(rename = "stripLinks")]
    pub strip_links: bool,
    /// Collapse whitespace.
    #[serde(rename = "normalizeWhitespace")]
    pub normalize_whitespace: bool,
    /// Longest message.
    #[serde(rename = "maxLength")]
    pub max_length: JsNumber,
    /// Every expressive tag with its flag, in [`EXPRESSIVE_TAGS`] order.
    #[serde(rename = "expressiveTags")]
    pub expressive_tags: Document,
}

/// `queue` of new settings.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct NewTtsQueue {
    /// Most messages waiting.
    #[serde(rename = "maxItems")]
    pub max_items: JsNumber,
}

/// Every expressive tag set to `on` except `off` (what `normalizeExpressiveTtsTags` builds).
pub fn expressive_tags_document(off: &[&str]) -> Document {
    EXPRESSIVE_TAGS
        .iter()
        .map(|tag| ((*tag).to_owned(), Bson::Boolean(!off.contains(tag))))
        .collect()
}

impl NewChannelTtsSettings {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
