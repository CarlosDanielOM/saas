//! Persistent hate-raid counters and hidden deduplication receipts.
pub use super::follow_defense_schema_values::IFollowHateRaidSource;
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use mongodb::{Database, bson::doc};
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "follow_hate_raid_source",
        collection: "follow_hate_raid_sources",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("targetChannelID", T::String).required(),
            Field::new("targetChannelLogin", T::String).default(D::String("")),
            Field::new("targetChannelName", T::String).default(D::String("")),
            Field::new("raiderChannelID", T::String).required(),
            Field::new("raiderChannelLogin", T::String).default(D::String("")),
            Field::new("raiderChannelName", T::String).default(D::String("")),
            Field::new("count", T::Number).default(D::Number(1.0)),
            Field::new("appliedLogIDs", T::Array(Box::new(T::ObjectId))).hidden(),
            Field::new("firstSeenAt", T::Date).required(),
            Field::new("lastSeenAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"targetChannelID":1}),
            SchemaIndex::new(doc! {"raiderChannelID":1}),
            SchemaIndex::new(doc! {"targetChannelID":1,"raiderChannelID":1}).unique(),
            SchemaIndex::new(doc! {"targetChannelID":1,"count":-1}),
        ],
    })
}
pub fn get_follow_hate_raid_source_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
