//! Follow-attack records using the shared concrete schema repository.
pub use super::follow_defense_schema_values::{
    FollowDefenseMode, FollowDefenseTriggerSource, IFollowAttackLog, IFollowAttackRaidInfo,
    IFollowAttackTrackedFollow,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use mongodb::{Database, bson::doc};
use std::sync::OnceLock;

fn tracked_fields() -> Vec<Field> {
    vec![
        Field::new("followerID", T::String).required(),
        Field::new("followerLogin", T::String).default(D::String("")),
        Field::new("followerName", T::String).default(D::String("")),
        Field::new("followedAt", T::Date).required(),
        Field::new("eventID", T::String).required(),
        Field::new("banned", T::Boolean).default(D::Boolean(false)),
        Field::new("banStatus", T::Number),
        Field::new("banMessage", T::String),
    ]
}
fn raid_fields() -> Vec<Field> {
    vec![
        Field::new("raiderChannelID", T::String).required(),
        Field::new("raiderChannelLogin", T::String).default(D::String("")),
        Field::new("raiderChannelName", T::String).default(D::String("")),
        Field::new("raidViewers", T::Number).default(D::Number(0.0)),
    ]
}
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "follow_attack_log",
        collection: "follow_attack_logs",
        string_id: false,
        version_key: true,
        write_concern_journaled: true,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("targetChannelID", T::String).required(),
            Field::new("targetChannelLogin", T::String).default(D::String("")),
            Field::new("targetChannelName", T::String).default(D::String("")),
            Field::new("modeTriggered", T::String)
                .enumeration(&["silent", "protection", "attack"])
                .required(),
            Field::new("triggeredBy", T::String)
                .enumeration(&["threshold", "manual"])
                .required(),
            Field::new("totalFollows", T::Number).default(D::Number(0.0)),
            Field::new("velocity", T::Number).default(D::Number(0.0)),
            Field::new("durationSeconds", T::Number).default(D::Number(0.0)),
            Field::new("isRaid", T::Boolean).default(D::Boolean(false)),
            Field::new(
                "raidInfo",
                T::Subdocument {
                    fields: raid_fields(),
                    generate_id: false,
                },
            ),
            Field::new(
                "trackedFollows",
                T::Array(Box::new(T::Subdocument {
                    fields: tracked_fields(),
                    generate_id: false,
                })),
            )
            .default(D::Array),
            Field::new("isHateRaid", T::Boolean).default(D::Boolean(false)),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"targetChannelID":1}),
            SchemaIndex::new(doc! {"modeTriggered":1}),
            SchemaIndex::new(doc! {"isRaid":1}),
            SchemaIndex::new(doc! {"isHateRaid":1}),
            SchemaIndex::new(doc! {"targetChannelID":1,"createdAt":-1}),
            SchemaIndex::new(doc! {"raidInfo.raiderChannelID":1,"isHateRaid":1}),
        ],
    })
}
pub fn get_follow_attack_log_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
