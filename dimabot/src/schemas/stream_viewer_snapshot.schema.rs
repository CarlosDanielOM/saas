use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type StreamViewerSnapshot = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "StreamViewerSnapshot",
        collection: "streamviewersnapshots",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("session_id", T::ObjectId).required(),
            Field::new("stream_id", T::String).required(),
            Field::new("captured_at", T::Date).required(),
            Field::new("viewers", T::Number).required().min(0.0),
            Field::new("title", T::String).default(D::String("")),
            Field::new("game_name", T::String).default(D::String("")),
            Field::new("messages", T::Number)
                .default(D::Number(0.0))
                .min(0.0),
            Field::new("commands", T::Number)
                .default(D::Number(0.0))
                .min(0.0),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"session_id":1}),
            SchemaIndex::new(doc! {"stream_id":1}),
            SchemaIndex::new(doc! {"captured_at":1}),
            SchemaIndex::new(doc! {"channelID":1,"captured_at":-1}),
            SchemaIndex::new(doc! {"session_id":1,"captured_at":1}),
        ],
    })
}
