//! `titleConfig` collection contract. The live title command lookup is
//! commented out; account deletion still deletes by `channelID`.
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_optional_string, insert_string,
};
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaRepository};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Document, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "titleConfig";
pub const COLLECTION_NAME: &str = "titleconfigs";
pub const EXPORT_NAME: &str = "TitleConfigSchema";

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
        indexes: vec![],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).required(),
            Field::new("pretitle", T::String),
            Field::new("posttitle", T::String),
            Field::new("active", T::Boolean).default(D::Boolean(true)),
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

/// Source `ITitleConfig`. Absent `pretitle` / `posttitle` stay absent; the
/// schema does not default them.
#[derive(Clone, Debug, PartialEq)]
pub struct ITitleConfig {
    pub id: ObjectId,
    pub channel_id: JsString,
    pub channel: JsString,
    pub pretitle: Option<JsString>,
    pub posttitle: Option<JsString>,
    pub active: bool,
}

impl ITitleConfig {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            channel_id: reader.require_string("channelID")?,
            channel: reader.require_string("channel")?,
            pretitle: reader.optional_string("pretitle")?,
            posttitle: reader.optional_string("posttitle")?,
            active: reader.require_bool("active")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "channel", &self.channel);
        insert_optional_string(&mut document, "pretitle", &self.pretitle);
        insert_optional_string(&mut document, "posttitle", &self.posttitle);
        document.insert("active", self.active);
        document
    }
}
