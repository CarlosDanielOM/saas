use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use std::sync::OnceLock;
pub const ADMIN_ROLES: &[&str] = &["creator", "super", "support", "billing", "channel"];
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "Admin",
        collection: "admins",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: Some("updatedAt"),
        indexes: vec![],
        fields: vec![
            Field::new("adminName", T::String).default(D::String("")),
            Field::new("adminID", T::String).default(D::String("")),
            Field::new("channelName", T::String).default(D::String("")),
            Field::new("channelID", T::String).default(D::String("")),
            Field::new("role", T::String)
                .default(D::String("channel"))
                .enumeration(ADMIN_ROLES),
            Field::new("actived", T::Boolean).default(D::Boolean(true)),
            Field::new("permissions", T::Array(Box::new(T::String))).default(D::Array),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new("updatedAt", T::Date).default(D::Now),
        ],
    })
}
