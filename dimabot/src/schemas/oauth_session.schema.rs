use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "OAuthSession",
        collection: "oauth_sessions",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"grant_id":1}),
            SchemaIndex::new(doc! {"user_id":1}),
            SchemaIndex::new(doc! {"expires_at":1}).ttl(0),
        ],
        fields: vec![
            Field::new("grant_id", T::ObjectId).required(),
            Field::new("user_id", T::ObjectId).required(),
            Field::new("client_id", T::String).required(),
            Field::new("channel_id", T::String).required(),
            Field::new("device_name", T::String)
                .max_utf16(80)
                .required(),
            Field::new("scopes", T::Array(Box::new(T::String)))
                .default(D::Array)
                .required(),
            Field::new("current_refresh_hash", T::String)
                .required()
                .hidden(),
            Field::new("last_used_at", T::Date).required(),
            Field::new("idle_expires_at", T::Date).required(),
            Field::new("expires_at", T::Date).required(),
            Field::new("revoked_at", T::Date).default(D::Null),
            Field::new("revoke_reason", T::String).default(D::Null),
        ],
    })
}
