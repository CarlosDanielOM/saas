//! Native `ai_usage_daily.schema.ts` persistence contract.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type AiUsageDaily = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "ai_usage_daily",
        collection: "ai_usage_dailies",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("customerId", T::String).required(),
            Field::new("date", T::String).required(),
            Field::new("dayStart", T::Date).required(),
            Field::new("spentCredits", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("grantedCredits", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("netConsumedCredits", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("transactionCount", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("categories", T::Mixed)
                .default(D::Object)
                .required(),
            Field::new("retentionTier", T::String)
                .enumeration(super::ai_usage_receipt::RETENTION_TIERS)
                .required(),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"customerId":1,"date":1}).unique(),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
