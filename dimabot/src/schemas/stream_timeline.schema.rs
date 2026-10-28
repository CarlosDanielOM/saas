use super::{Field, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    participant_schema()
}
pub fn participant_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "stream_participant",
        collection: "stream_participants",
        string_id: false,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("session_id", T::ObjectId).required(),
            Field::new("bucket", T::Number).required(),
            Field::new("user_id", T::String).required(),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"bucket":1,"user_id":1}).unique(),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
pub fn marker_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "stream_marker",
        collection: "stream_markers",
        string_id: false,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("session_id", T::ObjectId).required(),
            Field::new("key", T::String).required(),
            Field::new("kind", T::String)
                .enumeration(&[
                    "note",
                    "redemption",
                    "follow",
                    "sub",
                    "gift",
                    "bits",
                    "raid",
                ])
                .required(),
            Field::new("label", T::String).required().max_utf16(120),
            Field::new("value", T::Number),
            Field::new("rewardID", T::String),
            Field::new("cost", T::Number),
            Field::new("status", T::String),
            Field::new("occurredAt", T::Date).required(),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"key":1}).unique(),
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"kind":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
