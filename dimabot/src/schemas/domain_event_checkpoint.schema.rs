use super::{Field, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type DomainEventCheckpoint = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "domain_event_checkpoint",
        collection: "domain_event_checkpoints",
        string_id: false,
        version_key: false,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("consumer", T::String).required(),
            Field::new("topic", T::String).required(),
            Field::new("lastEventID", T::ObjectId).required(),
        ],
        indexes: vec![SchemaIndex::new(doc! {"consumer":1,"topic":1}).unique()],
    })
}
