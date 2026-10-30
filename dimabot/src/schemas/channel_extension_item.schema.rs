//! `ChannelExtensionItem` collection contract.

use super::media_extension_schema_values::{
    insert_or_null_datetime, insert_or_null_object_id, nullable_datetime, nullable_document,
    nullable_object_id, parsed_enum,
};
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_datetime, insert_f64, insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub use super::media_asset::{MEDIA_ASSET_TYPES, MediaAssetType};

pub const MODEL_NAME: &str = "ChannelExtensionItem";
pub const COLLECTION_NAME: &str = "channelextensionitems";
pub const EXPORT_NAME: &str = "ChannelExtensionItemSchema";
pub const CHANNEL_EXTENSION_ITEM_CATEGORIES: &[&str] = &["video", "audio", "gif", "tts"];
pub const CHANNEL_EXTENSION_ITEM_TTS_MODES: &[&str] = &["fixed", "custom"];
pub const CHANNEL_EXTENSION_ITEM_TTS_LANGUAGES: &[&str] = &["en", "es"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelExtensionItemCategory {
    Video,
    Audio,
    Gif,
    Tts,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelExtensionItemTtsMode {
    Fixed,
    Custom,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelExtensionItemTtsLanguage {
    En,
    Es,
}

macro_rules! string_enum {
    ($ty:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        impl $ty {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }
            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}
string_enum!(ChannelExtensionItemCategory {
    Video => "video",
    Audio => "audio",
    Gif => "gif",
    Tts => "tts",
});
string_enum!(ChannelExtensionItemTtsMode { Fixed => "fixed", Custom => "custom" });
string_enum!(ChannelExtensionItemTtsLanguage { En => "en", Es => "es" });

fn tts_fields() -> Vec<Field> {
    vec![
        Field::new("mode", T::String)
            .enumeration(CHANNEL_EXTENSION_ITEM_TTS_MODES)
            .default(D::String(ChannelExtensionItemTtsMode::Custom.as_str())),
        Field::new("text", T::String)
            .default(D::String(""))
            .trim()
            .max_utf16(500),
        Field::new("voice", T::String)
            .default(D::String(""))
            .trim()
            .max_utf16(120),
        Field::new("language", T::String)
            .enumeration(CHANNEL_EXTENSION_ITEM_TTS_LANGUAGES)
            .default(D::String(ChannelExtensionItemTtsLanguage::En.as_str())),
    ]
}

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! { "channelID": 1 }),
            SchemaIndex::new(doc! { "createdByUserID": 1 }),
            SchemaIndex::new(doc! { "assetID": 1 }),
            SchemaIndex::new(doc! { "category": 1 }),
            SchemaIndex::new(doc! { "mediaType": 1 }),
            SchemaIndex::new(doc! { "sku": 1 }),
            SchemaIndex::new(doc! { "isEnabled": 1 }),
            SchemaIndex::new(doc! { "sortOrder": 1 }),
            SchemaIndex::new(doc! { "deletedAt": 1 }),
            SchemaIndex::new(doc! { "channelID": 1, "isEnabled": 1, "deletedAt": 1 }),
            SchemaIndex::new(doc! { "channelID": 1, "sortOrder": 1 }),
        ],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channelName", T::String).required(),
            Field::new("createdByUserID", T::String).required(),
            Field::new("assetID", T::ObjectId)
                .default(D::Null)
                .required_unless("category", "tts"),
            Field::new("name", T::String)
                .required()
                .trim()
                .max_utf16(80),
            Field::new("description", T::String)
                .default(D::String(""))
                .trim()
                .max_utf16(500),
            Field::new("category", T::String)
                .required()
                .enumeration(CHANNEL_EXTENSION_ITEM_CATEGORIES)
                .default(D::String(ChannelExtensionItemCategory::Video.as_str())),
            Field::new("mediaType", T::String)
                .required()
                .enumeration(MEDIA_ASSET_TYPES),
            Field::new("thumbnailUrl", T::String).default(D::String("")),
            Field::new("durationMs", T::Number)
                .default(D::Number(0.0))
                .min(0.0),
            Field::new("bitsPrice", T::Number).required().min(0.0),
            Field::new("sku", T::String).required(),
            Field::new("volume", T::Number)
                .default(D::Number(100.0))
                .min(0.0)
                .max(100.0),
            Field::new("isEnabled", T::Boolean).default(D::Boolean(true)),
            Field::new("sortOrder", T::Number).default(D::Number(0.0)),
            Field::new(
                "tts",
                T::Subdocument {
                    fields: tts_fields(),
                    generate_id: false,
                },
            )
            .default(D::Null),
            Field::new("deletedAt", T::Date).default(D::Null),
        ],
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelExtensionItemTtsConfig {
    pub mode: ChannelExtensionItemTtsMode,
    pub text: JsString,
    pub voice: JsString,
    pub language: ChannelExtensionItemTtsLanguage,
}

/// Source `IChannelExtensionItem`.
#[derive(Clone, Debug, PartialEq)]
pub struct IChannelExtensionItem {
    pub id: ObjectId,
    pub channel_id: JsString,
    pub channel_name: JsString,
    pub created_by_user_id: JsString,
    pub asset_id: Option<ObjectId>,
    pub name: JsString,
    pub description: JsString,
    pub category: ChannelExtensionItemCategory,
    pub media_type: MediaAssetType,
    pub thumbnail_url: JsString,
    pub duration_ms: f64,
    pub bits_price: f64,
    pub sku: JsString,
    pub volume: f64,
    pub is_enabled: bool,
    pub sort_order: f64,
    pub tts: Option<ChannelExtensionItemTtsConfig>,
    pub deleted_at: Option<DateTime>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl ChannelExtensionItemTtsConfig {
    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            mode: parsed_enum(reader, "mode", ChannelExtensionItemTtsMode::parse)?,
            text: reader.require_string("text")?,
            voice: reader.require_string("voice")?,
            language: parsed_enum(reader, "language", ChannelExtensionItemTtsLanguage::parse)?,
        })
    }

    fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("mode", self.mode.as_str());
        insert_string(&mut document, "text", &self.text);
        insert_string(&mut document, "voice", &self.voice);
        document.insert("language", self.language.as_str());
        document
    }
}

impl IChannelExtensionItem {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            channel_id: reader.require_string("channelID")?,
            channel_name: reader.require_string("channelName")?,
            created_by_user_id: reader.require_string("createdByUserID")?,
            asset_id: nullable_object_id(&reader, "assetID")?,
            name: reader.require_string("name")?,
            description: reader.require_string("description")?,
            category: parsed_enum(&reader, "category", ChannelExtensionItemCategory::parse)?,
            media_type: parsed_enum(&reader, "mediaType", MediaAssetType::parse)?,
            thumbnail_url: reader.require_string("thumbnailUrl")?,
            duration_ms: reader.require_f64("durationMs")?,
            bits_price: reader.require_f64("bitsPrice")?,
            sku: reader.require_string("sku")?,
            volume: reader.require_f64("volume")?,
            is_enabled: reader.require_bool("isEnabled")?,
            sort_order: reader.require_f64("sortOrder")?,
            tts: nullable_document(&reader, "tts")?
                .map(|reader| ChannelExtensionItemTtsConfig::from_reader(&reader))
                .transpose()?,
            deleted_at: nullable_datetime(&reader, "deletedAt")?,
            created_at: reader.require_datetime("createdAt")?,
            updated_at: reader.require_datetime("updatedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "channelName", &self.channel_name);
        insert_string(&mut document, "createdByUserID", &self.created_by_user_id);
        insert_or_null_object_id(&mut document, "assetID", self.asset_id);
        insert_string(&mut document, "name", &self.name);
        insert_string(&mut document, "description", &self.description);
        document.insert("category", self.category.as_str());
        document.insert("mediaType", self.media_type.as_str());
        insert_string(&mut document, "thumbnailUrl", &self.thumbnail_url);
        insert_f64(&mut document, "durationMs", self.duration_ms);
        insert_f64(&mut document, "bitsPrice", self.bits_price);
        insert_string(&mut document, "sku", &self.sku);
        insert_f64(&mut document, "volume", self.volume);
        document.insert("isEnabled", self.is_enabled);
        insert_f64(&mut document, "sortOrder", self.sort_order);
        document.insert(
            "tts",
            self.tts
                .as_ref()
                .map(ChannelExtensionItemTtsConfig::to_document)
                .map(Bson::Document)
                .unwrap_or(Bson::Null),
        );
        insert_or_null_datetime(&mut document, "deletedAt", self.deleted_at);
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
