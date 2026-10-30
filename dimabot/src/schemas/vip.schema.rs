//! `vip` collection contract. `date.month` follows `Date#getMonth` (zero-based).
//! `expireDate` has no defaults; callers store the month they compute.
use super::ordinary_model_values::{CalendarDate, Reader, StrictDecodeError, insert_string};
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaRepository};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "vip";
pub const COLLECTION_NAME: &str = "vips";
pub const EXPORT_NAME: &str = "VipSchema";

fn calendar(name: &'static str, month: D) -> Field {
    Field::new(
        name,
        T::Object(vec![
            Field::new("day", T::Number).default(D::LocalDay),
            Field::new("month", T::Number).default(month),
            Field::new("year", T::Number).default(D::LocalYear),
        ]),
    )
}

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
            Field::new("username", T::String).required(),
            Field::new("userID", T::String).required(),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("duration", T::Number).required(),
            Field::new("vip", T::Boolean).default(D::Boolean(true)),
            calendar("date", D::LocalMonthZero),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new(
                "expireDate",
                T::Object(vec![
                    Field::new("day", T::Number).required(),
                    Field::new("month", T::Number).required(),
                    Field::new("year", T::Number).required(),
                ]),
            ),
            Field::new("expireTimestamp", T::Date).required(),
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

/// Source `IVip`.
#[derive(Clone, Debug, PartialEq)]
pub struct IVip {
    pub id: ObjectId,
    pub username: JsString,
    pub user_id: JsString,
    pub channel: JsString,
    pub channel_id: JsString,
    pub duration: f64,
    pub vip: bool,
    pub date: CalendarDate,
    pub created_at: DateTime,
    pub expire_date: CalendarDate,
    pub expire_timestamp: DateTime,
}

impl IVip {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            username: reader.require_string("username")?,
            user_id: reader.require_string("userID")?,
            channel: reader.require_string("channel")?,
            channel_id: reader.require_string("channelID")?,
            duration: reader.require_f64("duration")?,
            vip: reader.require_bool("vip")?,
            date: CalendarDate::from_reader(&reader.require_document("date")?)?,
            created_at: reader.require_datetime("createdAt")?,
            expire_date: CalendarDate::from_reader(&reader.require_document("expireDate")?)?,
            expire_timestamp: reader.require_datetime("expireTimestamp")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_string(&mut document, "username", &self.username);
        insert_string(&mut document, "userID", &self.user_id);
        insert_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "channelID", &self.channel_id);
        super::ordinary_model_values::insert_f64(&mut document, "duration", self.duration);
        document.insert("vip", self.vip);
        document.insert("date", self.date.to_document());
        document.insert("createdAt", self.created_at);
        document.insert("expireDate", self.expire_date.to_document());
        document.insert("expireTimestamp", self.expire_timestamp);
        document
    }
}
