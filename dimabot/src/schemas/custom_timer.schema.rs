use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type CustomTimer = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "custom_timer",
        collection: "custom_timers",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("name", T::String)
                .trim()
                .required()
                .max_utf16(30),
            Field::new("message", T::String)
                .trim()
                .required()
                .max_utf16(350),
            Field::new("frequency", T::Number)
                .required()
                .min(1.0)
                .max(1440.0)
                .integer(),
            Field::new("frequencyUnit", T::String).enumeration(&["minutes"]),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("active", T::Boolean).default(D::Boolean(true)),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"channelID":1,"name":1}).unique(),
        ],
    })
}
