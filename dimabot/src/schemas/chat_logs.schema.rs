use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type ChatLog = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Chat_Log",
        collection: "chat_logs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String),
            Field::new("message", T::String),
            Field::new("username", T::String),
            Field::new("timestamp", T::Date).default(D::Now),
        ],
    })
}
