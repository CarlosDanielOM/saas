//! Pet request and runtime Mongo contracts. Construction performs no I/O.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository};
use mongodb::{bson::{doc, Document}, Collection, Database};
use std::sync::OnceLock;

pub const PET_STATUSES: &[&str] = &["queued", "accepted", "generating", "synthesizing", "ready", "playing", "completed", "cancelled", "failed", "expired"];
pub const PET_TERMINAL: &[&str] = &["completed", "cancelled", "failed", "expired"];
fn sub(fields: Vec<Field>) -> T { T::Subdocument { fields, generate_id: false } }
fn strings(names: &[&'static str]) -> Vec<Field> { names.iter().map(|name| Field::new(name, T::String)).collect() }

pub fn request_schema() -> &'static SchemaDefinition {
    static SCHEMA: OnceLock<SchemaDefinition> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut fields = strings(&["_id", "channelId", "operation", "text", "actionKey", "payloadHash", "ttsSpeechId", "privateDir", "outputText", "errorCode"]);
        fields.extend([
            Field::new("ownerId", T::String).required(),
            Field::new("origin", T::Object(strings(&["kind", "id", "occurredAt"]))),
            Field::new("actor", T::Object(strings(&["userId", "displayName"]))),
            Field::new("admitted", T::Boolean).default(D::Boolean(false)),
            Field::new("startBefore", T::Date), Field::new("generation", T::Number),
            Field::new("settingsRevision", T::Number), Field::new("version", T::Number),
            Field::new("status", T::String).enumeration(PET_STATUSES),
            Field::new("lane", T::String).enumeration(&["independent", "tts"]),
            Field::new("deliveryAttempted", T::Boolean), Field::new("audioFetched", T::Boolean),
            Field::new("phaseDeadline", T::Date), Field::new("createdAt", T::Date), Field::new("expiresAt", T::Date),
            Field::new("audio", sub(vec![Field::new("path", T::String), Field::new("mimeType", T::String), Field::new("durationMs", T::Number)])).default(D::Null),
        ]);
        SchemaDefinition { model: "PetRequest", collection: "pet_requests", fields, string_id: true, version_key: false, write_concern_journaled: false, timestamps: None, save_clock_field: None,
            indexes: vec![SchemaIndex::new(doc! {"ownerId":1,"origin.kind":1,"origin.id":1,"actionKey":1}).unique(), SchemaIndex::new(doc! {"status":1,"phaseDeadline":1}), SchemaIndex::new(doc! {"ownerId":1,"status":1,"createdAt":1}), SchemaIndex::new(doc! {"expiresAt":1}).ttl(0)] }
    })
}
pub fn runtime_schema() -> &'static SchemaDefinition {
    static SCHEMA: OnceLock<SchemaDefinition> = OnceLock::new();
    SCHEMA.get_or_init(|| SchemaDefinition { model: "PetRuntime", collection: "pet_runtimes", string_id: true, version_key: false, write_concern_journaled: false, timestamps: None, save_clock_field: None,
        fields: vec![Field::new("_id", T::String), Field::new("channelId", T::String), Field::new("generation", T::Number).default(D::Number(1.0)), Field::new("activeRequestId", T::String).default(D::Null),
            Field::new("lease", sub(vec![Field::new("leaseId", T::String), Field::new("holderPeerId", T::String), Field::new("expiresAt", T::Date)])).default(D::Null),
            Field::new("notBefore", T::Date).default(D::Epoch), Field::new("lastAcceptedAt", T::Date).default(D::Null), Field::new("admissionClaimId", T::String).default(D::Null),
            Field::new("ttsReservation", sub(vec![Field::new("speechId", T::String), Field::new("token", T::String), Field::new("expiresAt", T::Date)])).default(D::Null),
            Field::new("tokenHash", T::String).default(D::Null), Field::new("overlayToken", T::Object(strings(&["iv", "content"])))],
        indexes: vec![SchemaIndex::new(doc! {"tokenHash":1}).unique().partial(doc! {"tokenHash":{"$type":"string"}}), SchemaIndex::new(doc! {"lease.expiresAt":1})] })
}
pub fn request_collection(db: &Database) -> Collection<Document> { request_schema().native_collection(db) }
pub fn runtime_collection(db: &Database) -> Collection<Document> { runtime_schema().native_collection(db) }
pub fn request_repository(db: &Database) -> SchemaRepository { request_schema().repository(db) }
pub fn runtime_repository(db: &Database) -> SchemaRepository { runtime_schema().repository(db) }
pub async fn install_indexes(db: &Database) -> mongodb::error::Result<()> { request_schema().install_indexes(db).await?; runtime_schema().install_indexes(db).await }
