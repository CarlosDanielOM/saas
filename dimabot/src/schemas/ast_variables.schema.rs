use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type AstVariables = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "AstVariables",
        collection: "astvariables",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("scopeType", T::String)
                .default(D::String("command"))
                .required(),
            Field::new("scopeName", T::String)
                .default(D::String("default"))
                .required(),
            Field::new("userId", T::String)
                .default(D::String(""))
                .required(),
            Field::new("userLogin", T::String)
                .default(D::String(""))
                .required(),
            Field::new("variables", T::Map(Box::new(T::String))).default(D::Object),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"channelID":1,"scopeType":1,"scopeName":1,"userId":1}).unique(),
            SchemaIndex::new(doc! {"channelID":1,"scopeType":1,"scopeName":1,"userLogin":1})
                .unique(),
        ],
    })
}
