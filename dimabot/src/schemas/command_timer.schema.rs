use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CommandTimer = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "timer_command",
        collection: "timer_commands",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("command", T::String).required(),
            Field::new("timer", T::Number).required(),
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::Number).default(D::LocalDay),
                    Field::new("month", T::Number).default(D::LocalMonth),
                    Field::new("year", T::Number).default(D::LocalYear),
                ]),
            ),
        ],
    })
}
