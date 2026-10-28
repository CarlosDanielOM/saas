//! Scalar dashboard projections reuse the worker collection/index contracts.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    daily_schema()
}
pub fn daily_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "dashboard_activity_daily",
        collection: "dashboard_activity_dailies",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String).required(),
            Field::new("day", T::Date).required(),
            Field::new("kind", T::String)
                .enumeration(&["command", "emote", "coverage"])
                .required(),
            Field::new("key", T::String),
            Field::new("label", T::String),
            Field::new("count", T::Number).default(D::Number(0.0)),
            Field::new("firstAt", T::Date),
            Field::new("lastSeq", T::Number).default(D::Number(0.0)),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"day":1,"kind":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
pub fn summary_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "dashboard_activity_summary",
        collection: "dashboard_activity_summaries",
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
