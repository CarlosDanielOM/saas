//! `channelextensionitems`: the items a channel sells in its DimaFX Twitch extension (a media
//! asset or a TTS message, at a Bits price).
//!
//! Reference: `dimabot/src/schemas/channel_extension_item.schema.ts` (model
//! `ChannelExtensionItem`), written by `server/routes/dimafx.route.ts` (`Model.create`, and
//! `doc.save()` on edit and on delete, which sets `isEnabled: false` and `deletedAt`) and two
//! migration scripts (`updateMany`). Camel-case timestamps, `__v`, no hooks. Nine field-level
//! indexes and two compound ones; no unique index. `name`, `description`, `tts.text` and
//! `tts.voice` are trimmed; `assetID` is required unless the item is a TTS item (`null` for those,
//! stored as `null`); lengths count characters (Mongoose counts UTF-16 units).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, yes, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::values::Nullable;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "channelextensionitems";

str_enum! {
    /// `category`.
    pub enum ItemCategory {
        /// A video (the default).
        Video = "video",
        /// A sound.
        Audio = "audio",
        /// A GIF.
        Gif = "gif",
        /// A spoken message, synthesized at playback.
        Tts = "tts",
    }
}

str_enum! {
    /// `mediaType` (also `mediaassets.mediaType`).
    pub enum MediaType {
        /// Video.
        Video = "video",
        /// Audio.
        Audio = "audio",
        /// A still image.
        Image = "image",
        /// A GIF.
        Gif = "gif",
    }
}

str_enum! {
    /// `tts.mode`.
    pub enum TtsMode {
        /// Always the broadcaster's text.
        Fixed = "fixed",
        /// The viewer's text (the default).
        Custom = "custom",
    }
}

str_enum! {
    /// `tts.language`.
    pub enum TtsLanguage {
        /// English (the default).
        En = "en",
        /// Spanish.
        Es = "es",
    }
}

/// Longest name, in characters.
pub const NAME_MAX_CHARS: usize = 80;
/// Longest description, in characters.
pub const DESCRIPTION_MAX_CHARS: usize = 500;
/// Longest fixed TTS text, in characters.
pub const TTS_TEXT_MAX_CHARS: usize = 500;
/// Longest TTS voice id, in characters.
pub const TTS_VOICE_MAX_CHARS: usize = 120;

static TTS: Schema = Schema::subdocument(&[
    Field::string("mode").default(D::Str("custom")),
    Field::string("text").default(D::Str("")).trim(),
    Field::string("voice").default(D::Str("")).trim(),
    Field::string("language").default(D::Str("en")),
])
.no_id();

/// The schema, field by field as `channel_extension_item.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channelName"),
    Field::string("createdByUserID"),
    Field::object_id("assetID").default(D::Null),
    Field::string("name").trim(),
    Field::string("description").default(D::Str("")).trim(),
    Field::string("category").default(D::Str("video")),
    Field::string("mediaType"),
    Field::string("thumbnailUrl").default(D::Str("")),
    Field::number("durationMs").default(D::Int(0)),
    Field::number("bitsPrice"),
    Field::string("sku"),
    Field::number("volume").default(D::Int(100)),
    Field::boolean("isEnabled").default(D::Bool(true)),
    Field::number("sortOrder").default(D::Int(0)),
    Field::subdocument("tts", &TTS).default(D::Null),
    Field::date("deletedAt").default(D::Null),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes (field-level `index: true` first, in schema order).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("createdByUserID", 1)]),
    IndexSpec::on(&[("assetID", 1)]),
    IndexSpec::on(&[("category", 1)]),
    IndexSpec::on(&[("mediaType", 1)]),
    IndexSpec::on(&[("sku", 1)]),
    IndexSpec::on(&[("isEnabled", 1)]),
    IndexSpec::on(&[("sortOrder", 1)]),
    IndexSpec::on(&[("deletedAt", 1)]),
    IndexSpec::on(&[("channelID", 1), ("isEnabled", 1), ("deletedAt", 1)]),
    IndexSpec::on(&[("channelID", 1), ("sortOrder", 1)]),
];

fn needs_asset(document: &Document) -> bool {
    document.get_str("category").ok() != Some("tts")
}

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channelName"),
    Rule::required("createdByUserID"),
    Rule::required_when("assetID", needs_asset),
    Rule::required("name"),
    Rule::max_length("name", NAME_MAX_CHARS),
    Rule::max_length("description", DESCRIPTION_MAX_CHARS),
    Rule::required("category"),
    Rule::one_of("category", ItemCategory::STRINGS),
    Rule::required("mediaType"),
    Rule::one_of("mediaType", MediaType::STRINGS),
    Rule::min("durationMs", 0.0),
    Rule::required("bitsPrice"),
    Rule::min("bitsPrice", 0.0),
    Rule::required("sku"),
    Rule::min("volume", 0.0),
    Rule::max("volume", 100.0),
    Rule::one_of("tts.mode", TtsMode::STRINGS),
    Rule::max_length("tts.text", TTS_TEXT_MAX_CHARS),
    Rule::max_length("tts.voice", TTS_VOICE_MAX_CHARS),
    Rule::one_of("tts.language", TtsLanguage::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("channelName"),
    ReadNeed::value("createdByUserID"),
    ReadNeed::value("name"),
    ReadNeed::not_null("description"),
    ReadNeed::not_null("category"),
    ReadNeed::value("mediaType"),
    ReadNeed::not_null("thumbnailUrl"),
    ReadNeed::not_null("durationMs"),
    ReadNeed::value("bitsPrice"),
    ReadNeed::value("sku"),
    ReadNeed::not_null("volume"),
    ReadNeed::not_null("isEnabled"),
    ReadNeed::not_null("sortOrder"),
    ReadNeed::not_null("tts.mode"),
    ReadNeed::not_null("tts.text"),
    ReadNeed::not_null("tts.voice"),
    ReadNeed::not_null("tts.language"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ChannelExtensionItem",
    source: "dimabot/src/schemas/channel_extension_item.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<ChannelExtensionItem>,
};

/// A stored item.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelExtensionItem {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(rename = "channelName")]
    pub channel_name: String,
    /// Who created it.
    #[serde(rename = "createdByUserID")]
    pub created_by_user_id: String,
    /// The media asset (`null` for TTS items).
    #[serde(default, rename = "assetID")]
    pub asset_id: Option<ObjectId>,
    /// Display name.
    pub name: String,
    /// Description.
    #[serde(default = "empty")]
    pub description: String,
    /// The kind of item.
    #[serde(default = "video")]
    pub category: Open<ItemCategory>,
    /// The asset's media type.
    #[serde(rename = "mediaType")]
    pub media_type: Open<MediaType>,
    /// Thumbnail URL.
    #[serde(default = "empty", rename = "thumbnailUrl")]
    pub thumbnail_url: String,
    /// Duration in milliseconds.
    #[serde(default = "zero", rename = "durationMs")]
    pub duration_ms: JsNumber,
    /// The Bits price.
    #[serde(rename = "bitsPrice")]
    pub bits_price: JsNumber,
    /// The extension SKU of the price.
    pub sku: String,
    /// Playback volume (0 to 100).
    #[serde(default = "hundred")]
    pub volume: JsNumber,
    /// For sale.
    #[serde(default = "yes", rename = "isEnabled")]
    pub is_enabled: bool,
    /// Position in the store.
    #[serde(default = "zero", rename = "sortOrder")]
    pub sort_order: JsNumber,
    /// The TTS configuration of a TTS item.
    #[serde(default)]
    pub tts: Option<ItemTts>,
    /// When it was deleted.
    #[serde(default, rename = "deletedAt")]
    pub deleted_at: Option<JsDate>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn video() -> Open<ItemCategory> {
    Open::Known(ItemCategory::Video)
}

fn hundred() -> JsNumber {
    JsNumber(100.0)
}

/// `tts`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ItemTts {
    /// Whose text is spoken.
    #[serde(default = "custom")]
    pub mode: Open<TtsMode>,
    /// The broadcaster's text (fixed mode).
    #[serde(default = "empty")]
    pub text: String,
    /// The voice (empty: the channel's voice for the language).
    #[serde(default = "empty")]
    pub voice: String,
    /// The language.
    #[serde(default = "english")]
    pub language: Open<TtsLanguage>,
}

fn custom() -> Open<TtsMode> {
    Open::Known(TtsMode::Custom)
}

fn english() -> Open<TtsLanguage> {
    Open::Known(TtsLanguage::En)
}

/// A new item (`ChannelExtensionItemSchema.create` in `dimafx.route.ts:1157,1186`).
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelExtensionItem {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(rename = "channelName")]
    pub channel_name: String,
    /// Who created it.
    #[serde(rename = "createdByUserID")]
    pub created_by_user_id: String,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The Bits price.
    #[serde(rename = "bitsPrice")]
    pub bits_price: JsNumber,
    /// The SKU.
    pub sku: String,
    /// Volume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<JsNumber>,
    /// For sale.
    #[serde(rename = "isEnabled", skip_serializing_if = "Option::is_none")]
    pub is_enabled: Option<bool>,
    /// Position.
    #[serde(rename = "sortOrder", skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<JsNumber>,
    /// Display name.
    pub name: String,
    /// The asset (the TTS path passes `assetID: null`).
    #[serde(rename = "assetID", skip_serializing_if = "Nullable::is_unset")]
    pub asset_id: Nullable<ObjectId>,
    /// The kind of item.
    pub category: ItemCategory,
    /// The media type.
    #[serde(rename = "mediaType")]
    pub media_type: MediaType,
    /// Thumbnail URL.
    #[serde(rename = "thumbnailUrl", skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    /// Duration in milliseconds.
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<JsNumber>,
    /// The TTS configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts: Option<NewItemTts>,
}

/// `tts` of a new item.
#[derive(Clone, Debug, Serialize)]
pub struct NewItemTts {
    /// Whose text is spoken.
    pub mode: TtsMode,
    /// The broadcaster's text.
    pub text: String,
    /// The voice.
    pub voice: String,
    /// The language.
    pub language: TtsLanguage,
}

impl NewChannelExtensionItem {
    /// The values given to the constructor (before defaults and `trim`).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
