//! `TriggerFile` collection contract. `date.month` follows `getMonth() + 1`.
use super::ordinary_model_values::{CalendarDate, Reader, StrictDecodeError, insert_string};
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaRepository};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "TriggerFile";
pub const COLLECTION_NAME: &str = "triggerfiles";
pub const EXPORT_NAME: &str = "TriggerFileSchema";

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
            Field::new("name", T::String).required(),
            Field::new("fileName", T::String).required(),
            Field::new("fileSize", T::Number).required(),
            Field::new("fileType", T::String).required(),
            Field::new("fileUrl", T::String).required(),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::Number).default(D::LocalDay),
                    Field::new("month", T::Number).default(D::LocalMonth),
                    Field::new("year", T::Number).default(D::LocalYear),
                ]),
            ),
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

/// Source `ITriggerFile`.
#[derive(Clone, Debug, PartialEq)]
pub struct ITriggerFile {
    pub id: ObjectId,
    pub name: JsString,
    pub file_name: JsString,
    pub file_size: f64,
    pub file_type: JsString,
    pub file_url: JsString,
    pub channel: JsString,
    pub channel_id: JsString,
    pub created_at: DateTime,
    pub date: CalendarDate,
}

impl ITriggerFile {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            name: reader.require_string("name")?,
            file_name: reader.require_string("fileName")?,
            file_size: reader.require_f64("fileSize")?,
            file_type: reader.require_string("fileType")?,
            file_url: reader.require_string("fileUrl")?,
            channel: reader.require_string("channel")?,
            channel_id: reader.require_string("channelID")?,
            created_at: reader.require_datetime("createdAt")?,
            date: CalendarDate::from_reader(&reader.require_document("date")?)?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "name", &self.name);
        insert_string(&mut document, "fileName", &self.file_name);
        super::ordinary_model_values::insert_f64(&mut document, "fileSize", self.file_size);
        insert_string(&mut document, "fileType", &self.file_type);
        insert_string(&mut document, "fileUrl", &self.file_url);
        insert_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "channelID", &self.channel_id);
        document.insert("createdAt", self.created_at);
        document.insert("date", self.date.to_document());
        document
    }
}
