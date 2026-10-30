//! `temporary_moderator` collection contract. No TTL is declared on
//! `expireTimestamp`; callers query `$lte` and delete explicitly.
use super::ordinary_model_values::{Reader, StrictDecodeError, insert_string};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "temporary_moderator";
pub const COLLECTION_NAME: &str = "temporary_moderators";
pub const EXPORT_NAME: &str = "TemporaryModeratorSchema";

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"channelID": 1}),
            SchemaIndex::new(doc! {"userID": 1}),
            SchemaIndex::new(doc! {"expireTimestamp": 1}),
            SchemaIndex::new(doc! {"channelID": 1, "userID": 1}).unique(),
        ],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).required(),
            Field::new("userID", T::String).required(),
            Field::new("username", T::String).required(),
            Field::new("durationDays", T::Number).required(),
            Field::new("expireTimestamp", T::Date).required(),
            Field::new("createdAt", T::Date).default(D::Now),
        ],
    })
}

/// Concrete collection on a caller-owned database. This does not connect or
/// install indexes.
pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source `ITemporaryModerator`. Strings use [`JsString`]; BSON storage
/// replaces unpaired UTF-16 units.
#[derive(Clone, Debug, PartialEq)]
pub struct ITemporaryModerator {
    pub id: ObjectId,
    pub channel_id: JsString,
    pub channel: JsString,
    pub user_id: JsString,
    pub username: JsString,
    pub duration_days: f64,
    pub expire_timestamp: DateTime,
    pub created_at: DateTime,
}

impl ITemporaryModerator {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            channel_id: reader.require_string("channelID")?,
            channel: reader.require_string("channel")?,
            user_id: reader.require_string("userID")?,
            username: reader.require_string("username")?,
            duration_days: reader.require_f64("durationDays")?,
            expire_timestamp: reader.require_datetime("expireTimestamp")?,
            created_at: reader.require_datetime("createdAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "userID", &self.user_id);
        insert_string(&mut document, "username", &self.username);
        super::ordinary_model_values::insert_f64(&mut document, "durationDays", self.duration_days);
        document.insert("expireTimestamp", self.expire_timestamp);
        document.insert("createdAt", self.created_at);
        document
    }
}
