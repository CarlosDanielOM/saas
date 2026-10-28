use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "channelconfig",
        collection: "channelconfigs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel_id", T::ObjectId),
            Field::new("channel", T::String),
            Field::new("commands", T::Array(Box::new(T::Mixed))).default(D::Array),
            Field::new("createdAt", T::Date),
            Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::String),
                    Field::new("month", T::String),
                    Field::new("year", T::String),
                ]),
            ),
        ],
    })
}
