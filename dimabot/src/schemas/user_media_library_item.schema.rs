//! `UserMediaLibraryItem` collection contract. Asset refs are not populated.
use super::media_asset::{MEDIA_ASSET_TYPES, MediaAssetType};
use super::media_extension_schema_values::{
    insert_or_null_datetime, insert_or_null_string, nullable_datetime, nullable_string, parsed_enum,
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
    bson::{DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "UserMediaLibraryItem";
pub const COLLECTION_NAME: &str = "usermedialibraryitems";
pub const EXPORT_NAME: &str = "UserMediaLibraryItemSchema";
pub const USER_MEDIA_LIBRARY_RELATION_TYPES: &[&str] = &["owner_upload", "public_library_add"];
pub const USER_MEDIA_LIBRARY_ASSET_SCOPES: &[&str] = &["public", "private"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserMediaLibraryRelationType {
    OwnerUpload,
    PublicLibraryAdd,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserMediaLibraryAssetScope {
    Public,
    Private,
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
string_enum!(UserMediaLibraryRelationType {
    OwnerUpload => "owner_upload",
    PublicLibraryAdd => "public_library_add",
});
string_enum!(UserMediaLibraryAssetScope { Public => "public", Private => "private" });

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
            SchemaIndex::new(doc! { "assetID": 1 }),
            SchemaIndex::new(doc! { "assetScope": 1 }),
            SchemaIndex::new(doc! { "mediaType": 1 }),
            SchemaIndex::new(doc! { "isActive": 1 }),
            SchemaIndex::new(doc! { "deletedAt": 1 }),
            SchemaIndex::new(doc! { "channelID": 1, "assetID": 1, "isActive": 1 })
                .unique()
                .partial(doc! { "isActive": true }),
        ],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channelName", T::String).required(),
            Field::new("addedByUserID", T::String).required(),
            Field::new("assetID", T::ObjectId).required(),
            Field::new("relationType", T::String)
                .required()
                .enumeration(USER_MEDIA_LIBRARY_RELATION_TYPES),
            Field::new("localAlias", T::String).default(D::Null),
            Field::new("quotaBytesCharged", T::Number).required(),
            Field::new("assetScope", T::String)
                .required()
                .enumeration(USER_MEDIA_LIBRARY_ASSET_SCOPES),
            Field::new("mediaType", T::String)
                .required()
                .enumeration(MEDIA_ASSET_TYPES),
            Field::new("isActive", T::Boolean).default(D::Boolean(true)),
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

/// Source `IUserMediaLibraryItem`. `assetScope` does not include `system`.
#[derive(Clone, Debug, PartialEq)]
pub struct IUserMediaLibraryItem {
    pub id: ObjectId,
    pub channel_id: JsString,
    pub channel_name: JsString,
    pub added_by_user_id: JsString,
    pub asset_id: ObjectId,
    pub relation_type: UserMediaLibraryRelationType,
    pub local_alias: Option<JsString>,
    pub quota_bytes_charged: f64,
    pub asset_scope: UserMediaLibraryAssetScope,
    pub media_type: MediaAssetType,
    pub is_active: bool,
    pub deleted_at: Option<DateTime>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl IUserMediaLibraryItem {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            channel_id: reader.require_string("channelID")?,
            channel_name: reader.require_string("channelName")?,
            added_by_user_id: reader.require_string("addedByUserID")?,
            asset_id: reader.require_object_id("assetID")?,
            relation_type: parsed_enum(
                &reader,
                "relationType",
                UserMediaLibraryRelationType::parse,
            )?,
            local_alias: nullable_string(&reader, "localAlias")?,
            quota_bytes_charged: reader.require_f64("quotaBytesCharged")?,
            asset_scope: parsed_enum(&reader, "assetScope", UserMediaLibraryAssetScope::parse)?,
            media_type: parsed_enum(&reader, "mediaType", MediaAssetType::parse)?,
            is_active: reader.require_bool("isActive")?,
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
        insert_string(&mut document, "addedByUserID", &self.added_by_user_id);
        document.insert("assetID", self.asset_id);
        document.insert("relationType", self.relation_type.as_str());
        insert_or_null_string(&mut document, "localAlias", &self.local_alias);
        insert_f64(&mut document, "quotaBytesCharged", self.quota_bytes_charged);
        document.insert("assetScope", self.asset_scope.as_str());
        document.insert("mediaType", self.media_type.as_str());
        document.insert("isActive", self.is_active);
        insert_or_null_datetime(&mut document, "deletedAt", self.deleted_at);
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
