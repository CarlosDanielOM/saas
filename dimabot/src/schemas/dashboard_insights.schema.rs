use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "dashboard_insights",
        collection: "dashboard_insights",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("nextRefreshAt", T::Date),
            Field::new("leaseUntil", T::Date).default(D::Epoch),
            Field::new("owner", T::String),
            Field::new("updatedAt", T::Date),
            Field::new("payload", T::Mixed),
            Field::new("error", T::Boolean).default(D::Boolean(false)),
            Field::new("expiresAt", T::Date),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"nextRefreshAt":1,"leaseUntil":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
