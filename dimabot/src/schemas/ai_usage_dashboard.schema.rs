//! Native derived AI-usage report cache schema; never a billing authority.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "ai_usage_dashboards",
        collection: "ai_usage_dashboards",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("key", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("customerId", T::String).required(),
            Field::new("planTier", T::String).required(),
            Field::new("request", T::Mixed).required(),
            Field::new("data", T::Mixed).required(),
            Field::new("dirty", T::Boolean).default(D::Boolean(false)),
            Field::new("refreshedAt", T::Date).required(),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"key":1}).unique(),
            SchemaIndex::new(doc! {"channelID":1,"customerId":1}),
            SchemaIndex::new(doc! {"dirty":1,"refreshedAt":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
