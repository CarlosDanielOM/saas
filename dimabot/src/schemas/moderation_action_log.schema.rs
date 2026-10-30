//! Moderation action audit records. Schema validation follows Mongoose rather
//! than the narrower TypeScript interface.
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Database,
    bson::{DateTime, doc},
};
use std::sync::OnceLock;

pub use super::channel_moderation_settings::ModerationAction;
#[derive(Clone, Debug, PartialEq)]
pub struct IModerationActionLog {
    pub channel_id: JsString,
    pub user_id: JsString,
    pub username: JsString,
    pub rule_id: JsString,
    pub rule_type: JsString,
    pub action: ModerationAction,
    pub offense_number: f64,
    pub reason: JsString,
    pub message_id: JsString,
    pub message_excerpt: JsString,
    pub success: bool,
    pub error_message: Option<JsString>,
    pub created_at: DateTime,
}

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "moderation_action_log",
        collection: "moderation_action_logs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("userID", T::String).required(),
            Field::new("username", T::String).default(D::String("")),
            Field::new("ruleID", T::String).required(),
            Field::new("ruleType", T::String).required(),
            Field::new("action", T::String)
                .enumeration(&["off", "warn", "delete", "timeout", "ban"])
                .required(),
            Field::new("offenseNumber", T::Number).default(D::Number(1.0)),
            Field::new("reason", T::String).default(D::String("")),
            Field::new("messageID", T::String).default(D::String("")),
            Field::new("messageExcerpt", T::String)
                .default(D::String(""))
                .max_utf16(200),
            Field::new("success", T::Boolean).default(D::Boolean(false)),
            Field::new("errorMessage", T::String).default(D::Null),
            Field::new("createdAt", T::Date).default(D::Now),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID": 1}),
            SchemaIndex::new(doc! {"createdAt": 1}).ttl(2_592_000),
        ],
    })
}
pub fn get_moderation_action_log_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
