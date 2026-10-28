use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type AiUsageLedgerState = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "ai_usage_ledger_states",
        collection: "ai_usage_ledger_states",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("customerId", T::String).required(),
            Field::new("coverageStart", T::Date).required(),
            Field::new("backfilledAt", T::Date).required(),
            Field::new("reportVersion", T::Number).default(D::Number(0.0)),
        ],
        indexes: vec![SchemaIndex::new(doc! {"channelID":1,"customerId":1}).unique()],
    })
}
