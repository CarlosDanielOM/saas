//! Pet settings schema; caller explicitly installs indexes and owns updates.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository};
use mongodb::{bson::{doc, Document}, Collection, Database};
use std::sync::OnceLock;

pub fn schema() -> &'static SchemaDefinition {
    static SCHEMA: OnceLock<SchemaDefinition> = OnceLock::new();
    SCHEMA.get_or_init(|| SchemaDefinition { model: "pet_settings", collection: "pet_settings", string_id: false, version_key: false, write_concern_journaled: false, timestamps: None, save_clock_field: None,
        fields: vec![Field::new("userId", T::ObjectId).required(),
            Field::new("settings", T::Subdocument { generate_id: false, fields: vec![
                Field::new("appearance", T::Object(vec![Field::new("kind", T::String).enumeration(&["png", "vts"]), Field::new("idleAssetId", T::String).default(D::Null), Field::new("talkingAssetId", T::String).default(D::Null)])),
                Field::new("playback", T::Object(vec![Field::new("target", T::String).enumeration(&["browser", "desktop"]), Field::new("desktopSessionId", T::String).default(D::Null), Field::new("vtsSessionId", T::String).default(D::Null)])),
                Field::new("sources", T::Object(vec![Field::new("independent", T::Boolean).default(D::Boolean(true)), Field::new("readTts", T::Boolean).default(D::Boolean(false))])),
                Field::new("ttsAudio", T::String).enumeration(&["pet", "overlay"]).default(D::String("pet")),
                Field::new("enabled", T::Boolean).required(), Field::new("name", T::String).required().max_utf16(40),
                Field::new("tts", T::Object(vec![Field::new("enabled", T::Boolean).required(), Field::new("provider", T::String).required().enumeration(&["piper", "kokoro", "fish"]), Field::new("language", T::String).required().enumeration(&["en", "es"]), Field::new("voice", T::String).required().max_utf16(100)])),
                Field::new("personality", T::Object(vec![Field::new("source", T::String).required().enumeration(&["custom", "profile"]), Field::new("profileId", T::String).default(D::String("")), Field::new("prompt", T::String).default(D::String("")).max_utf16(4000)])),
                Field::new("rules", T::Array(Box::new(T::String))).default(D::Array),
                Field::new("behavior", T::Object(vec![Field::new("respondToChat", T::Boolean).required(), Field::new("respondToEvents", T::Boolean).required(), Field::new("cooldownSeconds", T::Number).required().min(0.0).max(3600.0), Field::new("maxReplyLength", T::Number).required().min(30.0).max(500.0), Field::new("queueSize", T::Number).default(D::Number(5.0)).min(1.0).max(10.0), Field::new("askLane", T::String).enumeration(&["independent", "tts"]).default(D::String("independent"))]))
            ] }).required(), Field::new("revision", T::Number).required().min(1.0), Field::new("updatedAt", T::Date).required()],
        indexes: vec![SchemaIndex::new(doc! {"userId":1}).unique()] })
}
pub fn collection(db: &Database) -> Collection<Document> { schema().native_collection(db) }
pub fn repository(db: &Database) -> SchemaRepository { schema().repository(db) }
pub async fn install_indexes(db: &Database) -> mongodb::error::Result<()> { schema().install_indexes(db).await }
