//! `MediaAsset` collection contract. `ref` paths are not populated here.
use super::media_extension_schema_values::{
    insert_or_null_datetime, insert_or_null_object_id, insert_or_null_string, nullable_datetime,
    nullable_object_id, nullable_string, parsed_enum,
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

pub const MODEL_NAME: &str = "MediaAsset";
pub const COLLECTION_NAME: &str = "mediaassets";
pub const EXPORT_NAME: &str = "MediaAssetSchema";
pub const MEDIA_ASSET_TYPES: &[&str] = &["video", "audio", "image", "gif"];
pub const MEDIA_ASSET_SCOPES: &[&str] = &["public", "private", "system"];
pub const MEDIA_ASSET_MARKETPLACE_STATUSES: &[&str] = &[
    "not_listed",
    "published",
    "pending_review",
    "hidden",
    "removed",
];
pub const MEDIA_ASSET_THUMBNAIL_STATUSES: &[&str] = &["pending", "ready", "failed", "skipped"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaAssetType {
    Video,
    Audio,
    Image,
    Gif,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaAssetScope {
    Public,
    Private,
    System,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaAssetMarketplaceStatus {
    NotListed,
    Published,
    PendingReview,
    Hidden,
    Removed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaAssetThumbnailStatus {
    Pending,
    Ready,
    Failed,
    Skipped,
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
string_enum!(MediaAssetType { Video => "video", Audio => "audio", Image => "image", Gif => "gif" });
string_enum!(MediaAssetScope { Public => "public", Private => "private", System => "system" });
string_enum!(MediaAssetMarketplaceStatus {
    NotListed => "not_listed",
    Published => "published",
    PendingReview => "pending_review",
    Hidden => "hidden",
    Removed => "removed",
});
string_enum!(MediaAssetThumbnailStatus {
    Pending => "pending",
    Ready => "ready",
    Failed => "failed",
    Skipped => "skipped",
});

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
            SchemaIndex::new(doc! { "legacyTriggerFileID": 1 }),
            SchemaIndex::new(doc! { "ownerUserID": 1 }),
            SchemaIndex::new(doc! { "ownerChannelID": 1 }),
            SchemaIndex::new(doc! { "mediaType": 1 }),
            SchemaIndex::new(doc! { "s3Key": 1 }).unique(),
            SchemaIndex::new(doc! { "scope": 1 }),
            SchemaIndex::new(doc! { "marketplaceStatus": 1 }),
            SchemaIndex::new(doc! { "thumbnailAssetID": 1 }),
            SchemaIndex::new(doc! { "thumbnailStatus": 1 }),
            SchemaIndex::new(doc! { "deletedAt": 1 }),
            SchemaIndex::new(doc! {
                "scope": 1,
                "marketplaceStatus": 1,
                "mediaType": 1,
                "createdAt": -1
            }),
        ],
        fields: vec![
            Field::new("legacyTriggerFileID", T::ObjectId).default(D::Null),
            Field::new("ownerUserID", T::String).required(),
            Field::new("ownerChannelID", T::String).required(),
            Field::new("ownerChannelName", T::String).required(),
            Field::new("uploadedByUserID", T::String).required(),
            Field::new("originalName", T::String).required(),
            Field::new("displayName", T::String).required(),
            Field::new("fileName", T::String).required(),
            Field::new("extension", T::String).required(),
            Field::new("mimeType", T::String).required(),
            Field::new("mediaType", T::String)
                .required()
                .enumeration(MEDIA_ASSET_TYPES),
            Field::new("bytes", T::Number).required(),
            Field::new("bucket", T::String).required(),
            Field::new("s3Key", T::String).required(),
            Field::new("storageUrl", T::String).required(),
            Field::new("proxyPath", T::String).default(D::Null),
            Field::new("scope", T::String)
                .required()
                .enumeration(MEDIA_ASSET_SCOPES),
            Field::new("marketplaceStatus", T::String)
                .required()
                .enumeration(MEDIA_ASSET_MARKETPLACE_STATUSES)
                .default(D::String(MediaAssetMarketplaceStatus::NotListed.as_str())),
            Field::new("checksumSha256", T::String).default(D::Null),
            Field::new("thumbnailAssetID", T::ObjectId).default(D::Null),
            Field::new("thumbnailStatus", T::String)
                .required()
                .enumeration(MEDIA_ASSET_THUMBNAIL_STATUSES)
                .default(D::String(MediaAssetThumbnailStatus::Pending.as_str())),
            Field::new("thumbnailAttempts", T::Number).default(D::Number(0.0)),
            Field::new("thumbnailLastError", T::String).default(D::Null),
            Field::new("libraryCount", T::Number).default(D::Number(0.0)),
            Field::new("triggerReferenceCount", T::Number).default(D::Number(0.0)),
            Field::new("alertReferenceCount", T::Number).default(D::Number(0.0)),
            Field::new("extensionReferenceCount", T::Number).default(D::Number(0.0)),
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

/// Source `IMediaAsset`.
#[derive(Clone, Debug, PartialEq)]
pub struct IMediaAsset {
    pub id: ObjectId,
    pub legacy_trigger_file_id: Option<ObjectId>,
    pub owner_user_id: JsString,
    pub owner_channel_id: JsString,
    pub owner_channel_name: JsString,
    pub uploaded_by_user_id: JsString,
    pub original_name: JsString,
    pub display_name: JsString,
    pub file_name: JsString,
    pub extension: JsString,
    pub mime_type: JsString,
    pub media_type: MediaAssetType,
    pub bytes: f64,
    pub bucket: JsString,
    pub s3_key: JsString,
    pub storage_url: JsString,
    pub proxy_path: Option<JsString>,
    pub scope: MediaAssetScope,
    pub marketplace_status: MediaAssetMarketplaceStatus,
    pub checksum_sha256: Option<JsString>,
    pub thumbnail_asset_id: Option<ObjectId>,
    pub thumbnail_status: MediaAssetThumbnailStatus,
    pub thumbnail_attempts: f64,
    pub thumbnail_last_error: Option<JsString>,
    pub library_count: f64,
    pub trigger_reference_count: f64,
    pub alert_reference_count: f64,
    pub extension_reference_count: f64,
    pub deleted_at: Option<DateTime>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl IMediaAsset {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            legacy_trigger_file_id: nullable_object_id(&reader, "legacyTriggerFileID")?,
            owner_user_id: reader.require_string("ownerUserID")?,
            owner_channel_id: reader.require_string("ownerChannelID")?,
            owner_channel_name: reader.require_string("ownerChannelName")?,
            uploaded_by_user_id: reader.require_string("uploadedByUserID")?,
            original_name: reader.require_string("originalName")?,
            display_name: reader.require_string("displayName")?,
            file_name: reader.require_string("fileName")?,
            extension: reader.require_string("extension")?,
            mime_type: reader.require_string("mimeType")?,
            media_type: parsed_enum(&reader, "mediaType", MediaAssetType::parse)?,
            bytes: reader.require_f64("bytes")?,
            bucket: reader.require_string("bucket")?,
            s3_key: reader.require_string("s3Key")?,
            storage_url: reader.require_string("storageUrl")?,
            proxy_path: nullable_string(&reader, "proxyPath")?,
            scope: parsed_enum(&reader, "scope", MediaAssetScope::parse)?,
            marketplace_status: parsed_enum(
                &reader,
                "marketplaceStatus",
                MediaAssetMarketplaceStatus::parse,
            )?,
            checksum_sha256: nullable_string(&reader, "checksumSha256")?,
            thumbnail_asset_id: nullable_object_id(&reader, "thumbnailAssetID")?,
            thumbnail_status: parsed_enum(
                &reader,
                "thumbnailStatus",
                MediaAssetThumbnailStatus::parse,
            )?,
            thumbnail_attempts: reader.require_f64("thumbnailAttempts")?,
            thumbnail_last_error: nullable_string(&reader, "thumbnailLastError")?,
            library_count: reader.require_f64("libraryCount")?,
            trigger_reference_count: reader.require_f64("triggerReferenceCount")?,
            alert_reference_count: reader.require_f64("alertReferenceCount")?,
            extension_reference_count: reader.require_f64("extensionReferenceCount")?,
            deleted_at: nullable_datetime(&reader, "deletedAt")?,
            created_at: reader.require_datetime("createdAt")?,
            updated_at: reader.require_datetime("updatedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_or_null_object_id(
            &mut document,
            "legacyTriggerFileID",
            self.legacy_trigger_file_id,
        );
        insert_string(&mut document, "ownerUserID", &self.owner_user_id);
        insert_string(&mut document, "ownerChannelID", &self.owner_channel_id);
        insert_string(&mut document, "ownerChannelName", &self.owner_channel_name);
        insert_string(&mut document, "uploadedByUserID", &self.uploaded_by_user_id);
        insert_string(&mut document, "originalName", &self.original_name);
        insert_string(&mut document, "displayName", &self.display_name);
        insert_string(&mut document, "fileName", &self.file_name);
        insert_string(&mut document, "extension", &self.extension);
        insert_string(&mut document, "mimeType", &self.mime_type);
        document.insert("mediaType", self.media_type.as_str());
        insert_f64(&mut document, "bytes", self.bytes);
        insert_string(&mut document, "bucket", &self.bucket);
        insert_string(&mut document, "s3Key", &self.s3_key);
        insert_string(&mut document, "storageUrl", &self.storage_url);
        insert_or_null_string(&mut document, "proxyPath", &self.proxy_path);
        document.insert("scope", self.scope.as_str());
        document.insert("marketplaceStatus", self.marketplace_status.as_str());
        insert_or_null_string(&mut document, "checksumSha256", &self.checksum_sha256);
        insert_or_null_object_id(&mut document, "thumbnailAssetID", self.thumbnail_asset_id);
        document.insert("thumbnailStatus", self.thumbnail_status.as_str());
        insert_f64(&mut document, "thumbnailAttempts", self.thumbnail_attempts);
        insert_or_null_string(
            &mut document,
            "thumbnailLastError",
            &self.thumbnail_last_error,
        );
        insert_f64(&mut document, "libraryCount", self.library_count);
        insert_f64(
            &mut document,
            "triggerReferenceCount",
            self.trigger_reference_count,
        );
        insert_f64(
            &mut document,
            "alertReferenceCount",
            self.alert_reference_count,
        );
        insert_f64(
            &mut document,
            "extensionReferenceCount",
            self.extension_reference_count,
        );
        insert_or_null_datetime(&mut document, "deletedAt", self.deleted_at);
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
