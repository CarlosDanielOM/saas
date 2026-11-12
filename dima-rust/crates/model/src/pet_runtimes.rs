//! `pet_runtimes`: reference `dimabot/src/schemas/pet_runtime.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! pets/state.ts:18 awaits init before :19 upsert; :65 invalidation uses a pipeline
//! (increment generation, clear lease/request/claim, max notBefore), covered by write-then-read.
//! pets/socket.ts:195,203 builds lease changes after peer validation; pets/tokens.ts:14 writes
//! server-encrypted tokens. No dashboard body reaches a runtime row, hence no unchecked client-fed
//! paths (0), saves or runValidators. Legacy overlayToken null/missing; lease, activeRequestId,
//! lastAcceptedAt, admissionClaimId and ttsReservation null/missing accepted. Required unique tokenHash
//! partial index: awaited init, prevents ambiguous capability lookup. notBefore epoch default retained.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "pet_runtimes";
fn read_default_pet_runtime_generation() -> JsNumber {
    JsNumber(1.0)
}
fn read_default_pet_runtime_not_before() -> JsDate {
    JsDate(0)
}
static SCHEMA_LEASE: Schema = Schema::subdocument(&[
    Field::string("leaseId"),
    Field::string("holderPeerId"),
    Field::date("expiresAt"),
])
.no_id();
static SCHEMA_TTS_RESERVATION: Schema = Schema::subdocument(&[
    Field::string("speechId"),
    Field::string("token"),
    Field::date("expiresAt"),
])
.no_id();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelId"),
    Field::number("generation").default(D::Int(1)),
    Field::string("activeRequestId").default(D::Null),
    Field::subdocument("lease", &SCHEMA_LEASE).default(D::Null),
    Field::date("notBefore").default_fn(D::DateMs(0)),
    Field::date("lastAcceptedAt").default(D::Null),
    Field::string("admissionClaimId").default(D::Null),
    Field::subdocument("ttsReservation", &SCHEMA_TTS_RESERVATION).default(D::Null),
    Field::string("tokenHash").default(D::Null),
    Field::nested(
        "overlayToken",
        &[Field::string("iv"), Field::string("content")],
    ),
])
.declared_id()
.no_version_key();
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRuntimeLease {
    /// `lease.leaseId`.
    #[serde(rename = "leaseId", default)]
    pub lease_id: Option<String>,
    /// `lease.holderPeerId`.
    #[serde(rename = "holderPeerId", default)]
    pub holder_peer_id: Option<String>,
    /// `lease.expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRuntimeLease {
    /// `lease.leaseId`.
    #[serde(rename = "leaseId", skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    /// `lease.holderPeerId`.
    #[serde(rename = "holderPeerId", skip_serializing_if = "Option::is_none")]
    pub holder_peer_id: Option<String>,
    /// `lease.expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRuntimeTtsReservation {
    /// `ttsReservation.speechId`.
    #[serde(rename = "speechId", default)]
    pub speech_id: Option<String>,
    /// `ttsReservation.token`.
    #[serde(rename = "token", default)]
    pub token: Option<Private<String>>,
    /// `ttsReservation.expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRuntimeTtsReservation {
    /// `ttsReservation.speechId`.
    #[serde(rename = "speechId", skip_serializing_if = "Option::is_none")]
    pub speech_id: Option<String>,
    /// `ttsReservation.token`.
    #[serde(rename = "token", skip_serializing_if = "Option::is_none")]
    pub token: Option<Private<String>>,
    /// `ttsReservation.expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRuntimeOverlayToken {
    /// `overlayToken.iv`.
    #[serde(rename = "iv", default)]
    pub iv: Option<String>,
    /// `overlayToken.content`.
    #[serde(rename = "content", default)]
    pub content: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRuntimeOverlayToken {
    /// `overlayToken.iv`.
    #[serde(rename = "iv", skip_serializing_if = "Option::is_none")]
    pub iv: Option<String>,
    /// `overlayToken.content`.
    #[serde(rename = "content", skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct PetRuntime {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelId`.
    #[serde(rename = "channelId", default)]
    pub channel_id: Option<String>,
    /// `generation`.
    #[serde(rename = "generation", default = "read_default_pet_runtime_generation")]
    pub generation: JsNumber,
    /// `activeRequestId`.
    #[serde(rename = "activeRequestId", default)]
    pub active_request_id: Option<String>,
    /// `lease`.
    #[serde(rename = "lease", default)]
    pub lease: Option<PetRuntimeLease>,
    /// `notBefore`.
    #[serde(rename = "notBefore", default = "read_default_pet_runtime_not_before")]
    pub not_before: JsDate,
    /// `lastAcceptedAt`.
    #[serde(rename = "lastAcceptedAt", default)]
    pub last_accepted_at: Option<JsDate>,
    /// `admissionClaimId`.
    #[serde(rename = "admissionClaimId", default)]
    pub admission_claim_id: Option<String>,
    /// `ttsReservation`.
    #[serde(rename = "ttsReservation", default)]
    pub tts_reservation: Option<PetRuntimeTtsReservation>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", default)]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", default)]
    pub overlay_token: Option<Private<PetRuntimeOverlayToken>>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewPetRuntime {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelId`.
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `generation`.
    #[serde(rename = "generation", skip_serializing_if = "Option::is_none")]
    pub generation: Option<JsNumber>,
    /// `activeRequestId`.
    #[serde(rename = "activeRequestId", skip_serializing_if = "Nullable::is_unset")]
    pub active_request_id: Nullable<String>,
    /// `lease`.
    #[serde(rename = "lease", skip_serializing_if = "Nullable::is_unset")]
    pub lease: Nullable<NewPetRuntimeLease>,
    /// `notBefore`.
    #[serde(rename = "notBefore", skip_serializing_if = "Option::is_none")]
    pub not_before: Option<JsDate>,
    /// `lastAcceptedAt`.
    #[serde(rename = "lastAcceptedAt", skip_serializing_if = "Nullable::is_unset")]
    pub last_accepted_at: Nullable<JsDate>,
    /// `admissionClaimId`.
    #[serde(
        rename = "admissionClaimId",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub admission_claim_id: Nullable<String>,
    /// `ttsReservation`.
    #[serde(rename = "ttsReservation", skip_serializing_if = "Nullable::is_unset")]
    pub tts_reservation: Nullable<NewPetRuntimeTtsReservation>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", skip_serializing_if = "Nullable::is_unset")]
    pub token_hash: Nullable<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", skip_serializing_if = "Nullable::is_unset")]
    pub overlay_token: Nullable<Private<NewPetRuntimeOverlayToken>>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["tokenHash", "overlayToken", "ttsReservation.token"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("tokenHash",1)]).unique().partial(|| match Bson::Document(bson::doc!{"tokenHash":Bson::Document(bson::doc!{"$type":Bson::String("string".into())})}) { Bson::Document(d) => d, _ => Document::new() }),IndexSpec::on(&[("lease.expiresAt",1)])];
/// Schema validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("generation"),
    ReadNeed::not_null("notBefore"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "PetRuntime",
    source: "dimabot/src/schemas/pet_runtime.schema.ts",
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
    decode: decode_boxed::<PetRuntime>,
};
impl NewPetRuntime {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
