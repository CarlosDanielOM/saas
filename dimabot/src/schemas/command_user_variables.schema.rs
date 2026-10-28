use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type CommandUserVariables = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "CommandUserVariables",
        collection: "commanduservariables",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("commandId", T::ObjectId).required(),
            Field::new("channelID", T::String).required(),
            Field::new("userId", T::String).required(),
            Field::new("variables", T::Map(Box::new(T::String))).default(D::Object),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"userId":1}),
            SchemaIndex::new(doc! {"commandId":1,"userId":1}).unique(),
        ],
    })
}
