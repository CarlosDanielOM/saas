use super::{Field, FieldType as T, SchemaDefinition};
use mongodb::bson::Document;
use std::sync::OnceLock;
pub type CountdownTimerConfig = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "Countdowntimerconfig",
        collection: "countdowntimerconfigs",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("channel", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("bits", T::Number).required(),
            Field::new("tier1", T::Number).required(),
            Field::new("tier2", T::Number).required(),
            Field::new("tier3", T::Number).required(),
            Field::new("follows", T::Number).required(),
            Field::new("raids", T::Number).required(),
            Field::new("viewers", T::Number).required(),
            Field::new("donations", T::Number).required(),
        ],
    })
}
