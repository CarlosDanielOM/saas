use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "app_config",
        collection: "app_configs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: Some("refreshed_at"),
        indexes: vec![],
        fields: vec![
            Field::new("name", T::String),
            Field::new(
                "access_token",
                T::Object(vec![
                    Field::new("iv", T::String),
                    Field::new("content", T::String),
                ]),
            ),
            Field::new("refreshed_at", T::Date).default(D::Now),
        ],
    })
}
