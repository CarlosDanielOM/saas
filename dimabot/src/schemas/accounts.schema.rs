use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "Account",
        collection: "accounts",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("user_id", T::String).default(D::Null),
            Field::new("user_login", T::String).default(D::Null),
            Field::new("user_email", T::String).default(D::Null),
            Field::new("channelID", T::String).default(D::Null),
            Field::new("channelName", T::String).default(D::Null),
            Field::new("user_type", T::String).default(D::String("")),
            Field::new(
                "user_token",
                T::Object(vec![
                    Field::new("iv", T::String),
                    Field::new("content", T::String),
                ]),
            ),
            Field::new(
                "user_refresh_token",
                T::Object(vec![
                    Field::new("iv", T::String),
                    Field::new("content", T::String),
                ]),
            ),
            Field::new("createdAt", T::Date).default(D::Now),
        ],
    })
}
