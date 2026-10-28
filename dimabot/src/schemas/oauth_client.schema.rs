use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "OAuthClient",
        collection: "oauth_clients",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! {"client_id":1}).unique()],
        fields: vec![
            Field::new("client_id", T::String).required(),
            Field::new("name", T::String).required(),
            Field::new("type", T::String)
                .enumeration(&["public"])
                .required(),
            Field::new("redirect_uris", T::Array(Box::new(T::String)))
                .default(D::Array)
                .required(),
            Field::new("allowed_scopes", T::Array(Box::new(T::String)))
                .default(D::Array)
                .required(),
            Field::new("enabled", T::Boolean).default(D::Boolean(true)),
        ],
    })
}
