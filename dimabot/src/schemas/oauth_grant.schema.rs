use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "OAuthGrant",
        collection: "oauth_grants",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"user_id":1}),
            SchemaIndex::new(doc! {"user_id":1,"client_id":1,"channel_id":1}).unique(),
        ],
        fields: vec![
            Field::new("user_id", T::ObjectId).required(),
            Field::new("client_id", T::String).required(),
            Field::new("channel_id", T::String).required(),
            Field::new("scopes", T::Array(Box::new(T::String)))
                .default(D::Array)
                .required(),
            Field::new("revoked_at", T::Date).default(D::Null),
        ],
    })
}
