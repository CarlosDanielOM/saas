//! Durable first-observation marker; no retained chat content or TTL index.
use super::{Field, FieldType, SchemaDefinition, SchemaRepository};
use mongodb::Database;
use std::sync::OnceLock;

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "moderation_chatter",
        collection: "moderation_chatters",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("_id", FieldType::String).required(),
            Field::new("firstSeenAt", FieldType::Date).required(),
        ],
    })
}
pub fn get_moderation_chatter_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
