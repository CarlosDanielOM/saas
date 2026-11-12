//! `admins`: who may manage a channel besides its owner (an editor's permissions), and the site's
//! staff roles.
//!
//! Reference: `dimabot/src/schemas/admin.schema.ts` (model `Admin`). No timestamps option:
//! hand-written `createdAt` and `updatedAt` with `Date.now` defaults, and a `pre('save')` hook
//! that sets `updatedAt = new Date()` on every save (creates included). Updates do not run the
//! hook, so `updateOne` leaves `updatedAt` alone, as in the reference. `__v`, no index.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::yes;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::hooks::{save_stamping, stamp_insert};
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "admins";

str_enum! {
    /// `role`.
    pub enum AdminRole {
        /// The site's creator.
        Creator = "creator",
        /// Site super-administrator.
        Super = "super",
        /// Support staff.
        Support = "support",
        /// Billing staff.
        Billing = "billing",
        /// A channel's editor (the default).
        Channel = "channel",
    }
}

static SCHEMA: Schema = Schema::new(&[
    Field::string("adminName").default(D::Str("")),
    Field::string("adminID").default(D::Str("")),
    Field::string("channelName").default(D::Str("")),
    Field::string("channelID").default(D::Str("")),
    Field::string("role").default(D::Str("channel")),
    Field::boolean("actived").default(D::Bool(true)),
    Field::array("permissions", ValueType::String).default(D::EmptyArray),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("updatedAt").default_fn(D::Now),
]);

/// The validators.
pub const RULES: &[Rule] = &[Rule::one_of("role", AdminRole::STRINGS)];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("adminName"),
    ReadNeed::not_null("adminID"),
    ReadNeed::not_null("channelName"),
    ReadNeed::not_null("channelID"),
    ReadNeed::not_null("role"),
    ReadNeed::not_null("actived"),
    ReadNeed::not_null("permissions"),
];

/// The registry entry. Saves go through [`prepare_save`] (the `updatedAt` hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Admin",
    source: "dimabot/src/schemas/admin.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[] as &[IndexSpec],
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::Save,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<Admin>,
};

/// A stored admin.
#[derive(Clone, Debug, Deserialize)]
pub struct Admin {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The admin's login.
    #[serde(default, rename = "adminName")]
    pub admin_name: String,
    /// The admin's Twitch id.
    #[serde(default, rename = "adminID")]
    pub admin_id: String,
    /// The channel's login.
    #[serde(default, rename = "channelName")]
    pub channel_name: String,
    /// The channel's id.
    #[serde(default, rename = "channelID")]
    pub channel_id: String,
    /// The role (missing on older documents: `channel`).
    #[serde(default = "channel")]
    pub role: Open<AdminRole>,
    /// Active.
    #[serde(default = "yes")]
    pub actived: bool,
    /// Dashboard permissions (`*` for all).
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last save.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn channel() -> Open<AdminRole> {
    Open::Known(AdminRole::Channel)
}

/// A new admin (`new AdminSchema({...}).save()` in `admin.route.ts`).
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewAdmin {
    /// The channel's id.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The channel's login.
    #[serde(rename = "channelName", skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    /// The admin's Twitch id.
    #[serde(rename = "adminID", skip_serializing_if = "Option::is_none")]
    pub admin_id: Option<String>,
    /// The admin's login.
    #[serde(rename = "adminName", skip_serializing_if = "Option::is_none")]
    pub admin_name: Option<String>,
    /// The role (default `channel`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<AdminRole>,
    /// Permissions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<String>>,
    /// Active (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actived: Option<bool>,
}

impl NewAdmin {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends (the hook stamps `updatedAt`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        let mut prepared = INFO.prepare_create(&self.to_document()?, ctx)?;
        stamp_insert(&mut prepared.document, "updatedAt", ctx);
        Ok(prepared)
    }
}

/// `doc.save()` of a loaded admin after `changes`, with the hook's `updatedAt = new Date()`.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    save_stamping(&INFO, loaded, changes, "updatedAt", ctx)
}
