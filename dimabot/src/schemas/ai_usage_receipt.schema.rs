use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
pub type AiUsageReceipt = Document;
pub const RETENTION_TIERS: &[&str] = &["free", "premium", "pro"];
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiUsageRetentionTier {
    Free,
    Premium,
    Pro,
}
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut indexes = vec![
            SchemaIndex::new(doc! {"channelID":1,"customerId":1,"entryId":1}).unique(),
            SchemaIndex::new(doc! {"channelID":1,"customerId":1,"occurredAt":-1,"entryId":-1}),
            SchemaIndex::new(
                doc! {"channelID":1,"customerId":1,"category":1,"occurredAt":-1,"entryId":-1},
            ),
        ];
        for field in [
            "source",
            "resourceId",
            "requestId",
            "entryKind",
            "adjustmentType",
        ] {
            let mut keys = doc! {"channelID":1,"customerId":1};
            keys.insert(field, 1);
            keys.insert("occurredAt", -1);
            keys.insert("entryId", -1);
            indexes.push(SchemaIndex::new(keys));
        }
        indexes.push(SchemaIndex::new(doc! {"expiresAt":1}).ttl(0));
        SchemaDefinition {
            model: "ai_usage_receipts",
            collection: "ai_usage_receipts",
            string_id: false,
            version_key: true,
            write_concern_journaled: false,
            timestamps: Some(("created_at", "updated_at")),
            save_clock_field: None,
            indexes,
            fields: vec![
                Field::new("channelID", T::String).required(),
                Field::new("customerId", T::String).required(),
                Field::new("entryId", T::String).required(),
                Field::new("requestId", T::String).default(D::Null),
                Field::new("occurredAt", T::Date).required(),
                Field::new("entryKind", T::String)
                    .enumeration(&["usage", "adjustment"])
                    .required(),
                Field::new("category", T::String).required(),
                Field::new("operation", T::String).required(),
                Field::new("source", T::String).default(D::Null),
                Field::new("adjustmentType", T::String).default(D::Null),
                Field::new("provider", T::String).required(),
                Field::new("model", T::String).default(D::Null),
                Field::new("quantity", T::Number).default(D::Null),
                Field::new("unit", T::String).default(D::Null),
                Field::new("credits", T::Number).required(),
                Field::new("resourceType", T::String).default(D::Null),
                Field::new("resourceId", T::String).default(D::Null),
                Field::new("itemized", T::Boolean).required(),
                Field::new("retentionTier", T::String)
                    .enumeration(RETENTION_TIERS)
                    .required(),
                Field::new("expiresAt", T::Date).required(),
            ],
        }
    })
}
