//! `pet_readiness`.
//! Reference: pets/readiness.schema.ts. No timestamps, __v, hooks or hidden paths.
//! Writers checked: pets/readiness.ts:19 api-instance upsert,52 owner upsert,
//! 20 reset/deleteMany,48 fenced delete; pets/state.ts:87 fenced deleteOne.
//! Key: ownerId or sentinel api-instance. Repeat refresh overwrites the same owner
//! snapshot; generation, settingsRevision, sessionId and apiInstanceId identify the
//! proof, peer validation/expiry refresh it; deletes fence instance and generation.
//! All values come from runtime/settings/validated controller; no unchecked client
//! body, document save or runValidators. sessionId=settings playback ?? null, so read
//! accepts null. No raw fields. TTL15s, refresh5s; no scheduler is ported here.
//! Legacy: sentinel only has _id/apiInstanceId; all other fields absent there.
//! Owner fields use BSON numbers/dates, with nullable sessionId. TTL index best
//! effort for writes (init is awaited but expiry does not fence event counting).
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "pet_readiness";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("generation"),
    Field::number("settingsRevision"),
    Field::string("sessionId"),
    Field::string("peerId"),
    Field::string("apiInstanceId"),
    Field::date("validatedAt"),
    Field::date("authorizationExpiresAt"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["sessionId", "peerId"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0)];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::value("_id"), ReadNeed::value("apiInstanceId")];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "PetReadiness",
    source: "dimabot/src/pets/readiness.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<PetReadiness>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct PetReadiness {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `generation`.
    #[serde(rename = "generation", default)]
    pub generation: Option<JsNumber>,
    /// `settingsRevision`.
    #[serde(rename = "settingsRevision", default)]
    pub settings_revision: Option<JsNumber>,
    /// `sessionId`.
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<Private<String>>,
    /// `peerId`.
    #[serde(rename = "peerId", default)]
    pub peer_id: Option<Private<String>>,
    /// `apiInstanceId`.
    #[serde(rename = "apiInstanceId")]
    pub api_instance_id: String,
    /// `validatedAt`.
    #[serde(rename = "validatedAt", default)]
    pub validated_at: Option<JsDate>,
    /// `authorizationExpiresAt`.
    #[serde(rename = "authorizationExpiresAt", default)]
    pub authorization_expires_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetReadiness {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `generation`.
    #[serde(rename = "generation", skip_serializing_if = "Option::is_none")]
    pub generation: Option<JsNumber>,
    /// `settingsRevision`.
    #[serde(rename = "settingsRevision", skip_serializing_if = "Option::is_none")]
    pub settings_revision: Option<JsNumber>,
    /// `sessionId`.
    #[serde(rename = "sessionId", skip_serializing_if = "Nullable::is_unset")]
    pub session_id: Nullable<Private<String>>,
    /// `peerId`.
    #[serde(rename = "peerId", skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<Private<String>>,
    /// `apiInstanceId`.
    #[serde(rename = "apiInstanceId")]
    pub api_instance_id: String,
    /// `validatedAt`.
    #[serde(rename = "validatedAt", skip_serializing_if = "Option::is_none")]
    pub validated_at: Option<JsDate>,
    /// `authorizationExpiresAt`.
    #[serde(
        rename = "authorizationExpiresAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub authorization_expires_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
impl NewPetReadiness {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
