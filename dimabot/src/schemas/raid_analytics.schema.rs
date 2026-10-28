use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    history_schema()
}
pub fn history_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_analytics_history",
        collection: "raid_analytics_histories",
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
            Field::new("peerID", T::String),
            Field::new("peerLogin", T::String),
            Field::new("peerName", T::String),
            Field::new("viewers", T::Number),
            Field::new("occurredAt", T::Date).required(),
            Field::new("followsAfter", T::Number).default(D::Null),
            Field::new("followsComputedAt", T::Date).default(D::Null),
            Field::new("followWindowEnd", T::Date),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"occurredAt":-1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"direction":1,"peerID":1,"occurredAt":-1}),
            SchemaIndex::new(
                doc! {"channelID":1,"direction":1,"followsComputedAt":1,"occurredAt":1},
            ),
            SchemaIndex::new(doc! {"channelID":1,"direction":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
pub fn summary_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_analytics_summary",
        collection: "raid_analytics_summaries",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("dirtyAt", T::Date),
            Field::new("nextRefreshAt", T::Date),
            Field::new("leaseUntil", T::Date).default(D::Epoch),
            Field::new("owner", T::String),
            Field::new("updatedAt", T::Date),
            Field::new("payload", T::Mixed),
            Field::new("error", T::Boolean).default(D::Boolean(false)),
        ],
        indexes: vec![SchemaIndex::new(doc! {"nextRefreshAt":1,"leaseUntil":1})],
    })
}
