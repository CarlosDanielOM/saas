//! `DimafxPlayback` collection contract.
//!
//! `_id` is the caller-supplied string receipt. Payload stays Mixed; the queue
//! handler is not part of this schema. No TTL: unpaid work and completed
//! receipts must survive disconnects.
use super::media_extension_schema_values::parsed_enum;
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_datetime, insert_f64, insert_optional_string, insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "DimafxPlayback";
pub const COLLECTION_NAME: &str = "dimafxplaybacks";
pub const EXPORT_NAME: &str = "DimafxPlaybackSchema";
pub const DIMAFX_PLAYBACK_STATES: &[&str] =
    &["queued", "playing", "refunding", "completed", "refunded"];
pub const DIMAFX_QUEUE_SOURCES: &[&str] =
    &["bits_purchase", "credit_purchase", "redeem_saved", "test"];
pub const DIMAFX_QUEUE_LANGUAGES: &[&str] = &["en", "es"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DimafxPlaybackState {
    Queued,
    Playing,
    Refunding,
    Completed,
    Refunded,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DimafxQueueSource {
    BitsPurchase,
    CreditPurchase,
    RedeemSaved,
    Test,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DimafxQueueLanguage {
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
string_enum!(DimafxPlaybackState {
    Queued => "queued",
    Playing => "playing",
    Refunding => "refunding",
    Completed => "completed",
    Refunded => "refunded",
});
string_enum!(DimafxQueueSource {
    BitsPurchase => "bits_purchase",
    CreditPurchase => "credit_purchase",
    RedeemSaved => "redeem_saved",
    Test => "test",
});
string_enum!(DimafxQueueLanguage { En => "en", Es => "es" });

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: true,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(
            doc! { "channelID": 1, "state": 1, "createdAt": 1 },
        )],
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("payload", T::Mixed).required().minimize(),
            Field::new("state", T::String)
                .enumeration(DIMAFX_PLAYBACK_STATES)
                .default(D::String(DimafxPlaybackState::Queued.as_str())),
            Field::new("leaseOwner", T::String).default(D::String("")),
            Field::new("leaseUntil", T::Date).default(D::Epoch),
            Field::new("failure", T::String),
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

#[derive(Clone, Debug, PartialEq)]
pub struct DimafxQueueTts {
    pub text: JsString,
    pub voice: JsString,
    pub language: DimafxQueueLanguage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DimafxQueueRefund {
    pub user_id: JsString,
    pub price_bits: f64,
}

/// Strict view of source `DimafxQueueItem`. Unknown payload keys stay in BSON.
#[derive(Clone, Debug, PartialEq)]
pub struct DimafxQueueItem {
    pub trigger_id: JsString,
    pub channel_id: JsString,
    pub item_id: JsString,
    pub name: JsString,
    pub category: JsString,
    pub media_url: Option<JsString>,
    pub media_type: Option<JsString>,
    pub volume: f64,
    pub duration_ms: f64,
    pub tts: Option<DimafxQueueTts>,
    pub refund_on_failure: Option<DimafxQueueRefund>,
    pub source: DimafxQueueSource,
    pub enqueued_at: f64,
}

/// Source `IDimafxPlayback`.
#[derive(Clone, Debug, PartialEq)]
pub struct IDimafxPlayback {
    pub id: JsString,
    pub channel_id: JsString,
    pub payload: DimafxQueueItem,
    pub state: DimafxPlaybackState,
    pub lease_owner: JsString,
    pub lease_until: DateTime,
    pub failure: Option<JsString>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl DimafxQueueTts {
    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            text: reader.require_string("text")?,
            voice: reader.require_string("voice")?,
            language: parsed_enum(reader, "language", DimafxQueueLanguage::parse)?,
        })
    }

    fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "text", &self.text);
        insert_string(&mut document, "voice", &self.voice);
        document.insert("language", self.language.as_str());
        document
    }
}

impl DimafxQueueRefund {
    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            user_id: reader.require_string("userID")?,
            price_bits: reader.require_f64("priceBits")?,
        })
    }

    fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "userID", &self.user_id);
        insert_f64(&mut document, "priceBits", self.price_bits);
        document
    }
}

impl DimafxQueueItem {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        Self::from_reader(&Reader::new(document))
    }

    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            trigger_id: reader.require_string("triggerID")?,
            channel_id: reader.require_string("channelID")?,
            item_id: reader.require_string("itemID")?,
            name: reader.require_string("name")?,
            category: reader.require_string("category")?,
            media_url: reader.optional_string("mediaUrl")?,
            media_type: reader.optional_string("mediaType")?,
            volume: reader.require_f64("volume")?,
            duration_ms: reader.require_f64("durationMs")?,
            tts: reader
                .optional_document("tts")?
                .map(|reader| DimafxQueueTts::from_reader(&reader))
                .transpose()?,
            refund_on_failure: reader
                .optional_document("refundOnFailure")?
                .map(|reader| DimafxQueueRefund::from_reader(&reader))
                .transpose()?,
            source: parsed_enum(reader, "source", DimafxQueueSource::parse)?,
            enqueued_at: reader.require_f64("enqueuedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "triggerID", &self.trigger_id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "itemID", &self.item_id);
        insert_string(&mut document, "name", &self.name);
        insert_string(&mut document, "category", &self.category);
        insert_optional_string(&mut document, "mediaUrl", &self.media_url);
        insert_optional_string(&mut document, "mediaType", &self.media_type);
        insert_f64(&mut document, "volume", self.volume);
        insert_f64(&mut document, "durationMs", self.duration_ms);
        if let Some(tts) = &self.tts {
            document.insert("tts", tts.to_document());
        }
        if let Some(refund) = &self.refund_on_failure {
            document.insert("refundOnFailure", refund.to_document());
        }
        document.insert("source", self.source.as_str());
        insert_f64(&mut document, "enqueuedAt", self.enqueued_at);
        document
    }
}

impl IDimafxPlayback {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_string("_id")?,
            channel_id: reader.require_string("channelID")?,
            payload: DimafxQueueItem::from_reader(&reader.require_document("payload")?)?,
            state: parsed_enum(&reader, "state", DimafxPlaybackState::parse)?,
            lease_owner: reader.require_string("leaseOwner")?,
            lease_until: reader.require_datetime("leaseUntil")?,
            failure: reader.optional_string("failure")?,
            created_at: reader.require_datetime("createdAt")?,
            updated_at: reader.require_datetime("updatedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "_id", &self.id);
        insert_string(&mut document, "channelID", &self.channel_id);
        document.insert("payload", self.payload.to_document());
        document.insert("state", self.state.as_str());
        insert_string(&mut document, "leaseOwner", &self.lease_owner);
        insert_datetime(&mut document, "leaseUntil", self.lease_until);
        insert_optional_string(&mut document, "failure", &self.failure);
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
