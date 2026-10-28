use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_subscription_preference",
        collection: "raid_subscription_preferences",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String).required(),
            Field::new("direction", T::String)
                .enumeration(&["incoming", "outgoing"])
                .required(),
            Field::new("deleted", T::Boolean).default(D::Boolean(false)),
            Field::new("operation", T::String),
            Field::new("updatedAt", T::Date),
        ],
        indexes: vec![SchemaIndex::new(doc! {"channelID":1,"direction":1}).unique()],
    })
}
