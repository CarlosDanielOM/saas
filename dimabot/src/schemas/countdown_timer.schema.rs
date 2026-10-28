use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CountdownTimer = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Countdowntimer",
        collection: "countdowntimers",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("startTime", T::Number).required(),
            Field::new("resumedAt", T::Date),
            Field::new("pausedAt", T::Date),
            Field::new("time", T::Number).default(D::Number(0.0)),
            Field::new("paused", T::Boolean).default(D::Boolean(false)),
            Field::new("active", T::Boolean).default(D::Boolean(true)),
        ],
    })
}
