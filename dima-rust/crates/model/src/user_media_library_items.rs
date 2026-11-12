//! `usermedialibraryitems`: a media asset in a channel's library (its own upload or a public
//! asset it added), with the storage quota it is charged.
//!
//! Reference: `dimabot/src/schemas/user_media_library_item.schema.ts` (model
//! `UserMediaLibraryItem`), written by `server/routes/trigger.route.ts` (`Model.create` on upload
//! and on adding a public asset, `doc.save()` to rename, promote or remove) and a migration
//! script. Camel-case timestamps, `__v`, no hooks. Indexes: six field-level ones and the unique
//! partial `{channelID, assetID, isActive}` over active items (one active entry per asset and
//! channel; best effort like the reference, which checks for an existing entry first and awaits
//! nothing). `localAlias` and `deletedAt` are `null` by default and stored so.
//!
//! Client-fed writes (`null` from a request body): none. `server/routes/trigger.route.ts:794`
//! stores `localAlias` as `typeof ... === 'string' ? trimmed : ''` and then `|| null` (a server
//! `null`, an `Option` here); the rest is server-built.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::channel_extension_items::MediaType;
use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::yes;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::values::Nullable;
use bson::oid::ObjectId;
use bson::{Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "usermedialibraryitems";

str_enum! {
    /// `relationType`.
    pub enum RelationType {
        /// The channel uploaded it.
        OwnerUpload = "owner_upload",
        /// Added from the public library.
        PublicLibraryAdd = "public_library_add",
    }
}

str_enum! {
    /// `assetScope`.
    pub enum LibraryAssetScope {
        /// A public asset.
        Public = "public",
        /// A private asset.
        Private = "private",
    }
}

/// The schema, field by field as `user_media_library_item.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channelName"),
    Field::string("addedByUserID"),
    Field::object_id("assetID"),
    Field::string("relationType"),
    Field::string("localAlias").default(D::Null),
    Field::number("quotaBytesCharged"),
    Field::string("assetScope"),
    Field::string("mediaType"),
    Field::boolean("isActive").default(D::Bool(true)),
    Field::date("deletedAt").default(D::Null),
])
.timestamps(Timestamps::CAMEL);

fn active_only() -> Document {
    doc! { "isActive": true }
}

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("assetID", 1)]),
    IndexSpec::on(&[("assetScope", 1)]),
    IndexSpec::on(&[("mediaType", 1)]),
    IndexSpec::on(&[("isActive", 1)]),
    IndexSpec::on(&[("deletedAt", 1)]),
    IndexSpec::on(&[("channelID", 1), ("assetID", 1), ("isActive", 1)])
        .unique()
        .partial(active_only),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channelName"),
    Rule::required("addedByUserID"),
    Rule::required("assetID"),
    Rule::required("relationType"),
    Rule::one_of("relationType", RelationType::STRINGS),
    Rule::required("quotaBytesCharged"),
    Rule::required("assetScope"),
    Rule::one_of("assetScope", LibraryAssetScope::STRINGS),
    Rule::required("mediaType"),
    Rule::one_of("mediaType", MediaType::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("channelName"),
    ReadNeed::value("addedByUserID"),
    ReadNeed::value("assetID"),
    ReadNeed::value("relationType"),
    ReadNeed::value("quotaBytesCharged"),
    ReadNeed::value("assetScope"),
    ReadNeed::value("mediaType"),
    ReadNeed::not_null("isActive"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "UserMediaLibraryItem",
    source: "dimabot/src/schemas/user_media_library_item.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<UserMediaLibraryItem>,
};

/// A stored library item.
#[derive(Clone, Debug, Deserialize)]
pub struct UserMediaLibraryItem {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(rename = "channelName")]
    pub channel_name: String,
    /// Who added it.
    #[serde(rename = "addedByUserID")]
    pub added_by_user_id: String,
    /// The asset (`mediaassets._id`).
    #[serde(rename = "assetID")]
    pub asset_id: ObjectId,
    /// How it got there.
    #[serde(rename = "relationType")]
    pub relation_type: Open<RelationType>,
    /// The channel's name for it.
    #[serde(default, rename = "localAlias")]
    pub local_alias: Option<String>,
    /// Storage quota charged, in bytes.
    #[serde(rename = "quotaBytesCharged")]
    pub quota_bytes_charged: JsNumber,
    /// The asset's scope.
    #[serde(rename = "assetScope")]
    pub asset_scope: Open<LibraryAssetScope>,
    /// The asset's media type.
    #[serde(rename = "mediaType")]
    pub media_type: Open<MediaType>,
    /// Still in the library.
    #[serde(default = "yes", rename = "isActive")]
    pub is_active: bool,
    /// When it was removed.
    #[serde(default, rename = "deletedAt")]
    pub deleted_at: Option<JsDate>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new library item (`UserMediaLibraryItemSchema.create` in `trigger.route.ts:604,716`): the
/// reference passes `localAlias: null` and `deletedAt: null`.
#[derive(Clone, Debug, Serialize)]
pub struct NewUserMediaLibraryItem {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(rename = "channelName")]
    pub channel_name: String,
    /// Who added it.
    #[serde(rename = "addedByUserID")]
    pub added_by_user_id: String,
    /// The asset.
    #[serde(rename = "assetID")]
    pub asset_id: ObjectId,
    /// How it got there.
    #[serde(rename = "relationType")]
    pub relation_type: RelationType,
    /// The channel's name for it.
    #[serde(rename = "localAlias", skip_serializing_if = "Nullable::is_unset")]
    pub local_alias: Nullable<String>,
    /// Storage quota charged.
    #[serde(rename = "quotaBytesCharged")]
    pub quota_bytes_charged: JsNumber,
    /// The asset's scope.
    #[serde(rename = "assetScope")]
    pub asset_scope: LibraryAssetScope,
    /// The asset's media type.
    #[serde(rename = "mediaType")]
    pub media_type: MediaType,
    /// Still in the library.
    #[serde(rename = "isActive", skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    /// When it was removed.
    #[serde(rename = "deletedAt", skip_serializing_if = "Nullable::is_unset")]
    pub deleted_at: Nullable<JsDate>,
}

impl NewUserMediaLibraryItem {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
