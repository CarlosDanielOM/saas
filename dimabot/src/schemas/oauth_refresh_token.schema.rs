use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "OAuthRefreshToken",
        collection: "oauth_refresh_tokens",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"token_hash":1}).unique(),
            SchemaIndex::new(doc! {"session_id":1}),
            SchemaIndex::new(doc! {"expires_at":1}).ttl(0),
        ],
        fields: vec![
            Field::new("token_hash", T::String).required(),
            Field::new("session_id", T::ObjectId).required(),
            Field::new("used_at", T::Date).default(D::Null),
            Field::new("expires_at", T::Date).required(),
        ],
    })
}
