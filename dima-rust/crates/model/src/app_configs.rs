//! `app_configs`: the bot application's own encrypted Twitch token.
//!
//! Reference: `dimabot/src/schemas/app_config.schema.ts` (model `app_config`). No timestamps,
//! `__v`, no index; a `pre('save')` hook sets `refreshed_at = new Date()` on every save. The
//! reference no longer uses the model (one legacy document exists); it is ported so the document
//! stays readable and writable the same way.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::error::ModelError;
use crate::hooks::{save_stamping, stamp_insert};
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::users::EncryptedToken;
use bson::oid::ObjectId;
use bson::{Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "app_configs";

static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::nested(
        "access_token",
        &[Field::string("iv"), Field::string("content")],
    ),
    Field::date("refreshed_at").default_fn(D::Now),
]);

/// The registry entry. Saves go through [`prepare_save`] (the `refreshed_at` hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "app_config",
    source: "dimabot/src/schemas/app_config.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[] as &[IndexSpec],
    rules: &[],
    hooks: Hooks::Save,
    decode: |raw: &RawDocument| decode::<AppConfig>(raw).map(drop),
};

/// The stored configuration.
#[derive(Clone, Debug, Deserialize)]
pub struct AppConfig {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The bot's login.
    #[serde(default)]
    pub name: Option<String>,
    /// The encrypted app token.
    #[serde(default)]
    pub access_token: EncryptedToken,
    /// Last save (`default: Date.now`, not applied on read).
    #[serde(default)]
    pub refreshed_at: Option<JsDate>,
}

/// A new configuration.
#[derive(Clone, Debug, Serialize)]
pub struct NewAppConfig {
    /// The bot's login.
    pub name: String,
    /// The encrypted app token.
    pub access_token: EncryptedToken,
}

impl NewAppConfig {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends (the hook stamps `refreshed_at`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        let mut prepared = INFO.prepare_create(&self.to_document()?, ctx)?;
        stamp_insert(&mut prepared.document, "refreshed_at", ctx);
        Ok(prepared)
    }
}

/// `doc.save()` after `changes`, with the hook's `refreshed_at = new Date()`.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    save_stamping(&INFO, loaded, changes, "refreshed_at", ctx)
}
