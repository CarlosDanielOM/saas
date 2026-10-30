//! Follow defense action and durable pacing control repositories.
pub use super::follow_defense_schema_values::{
    FollowDefenseAction, FollowDefenseActionKind, FollowDefenseActionMode,
    FollowDefenseActionStatus, FollowDefenseAuthorization,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use mongodb::{Database, bson::doc};
use std::sync::OnceLock;
pub fn action_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "follow_defense_action",
        collection: "follow_defense_actions",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("eventID", T::String).required(),
            Field::new("kind", T::String)
                .enumeration(&["ban", "announcement"])
                .required(),
            Field::new("followerID", T::String).default(D::String("")),
            Field::new("authorization", T::String)
                .enumeration(&["automatic", "manual"])
                .default(D::String("automatic")),
            Field::new("raidSessionID", T::String).default(D::String("")),
            Field::new("raidFollowerID", T::String).default(D::String("")),
            Field::new("raidRequestID", T::String).default(D::String("")),
            Field::new("reason", T::String).default(D::String("")),
            Field::new("message", T::String).default(D::String("")),
            Field::new("mode", T::String)
                .enumeration(&["protection", "attack"])
                .required(),
            Field::new("authorizedAt", T::Date).required(),
            Field::new("followedAt", T::Date),
            Field::new("status", T::String)
                .enumeration(&[
                    "pending",
                    "processing",
                    "succeeded",
                    "failed",
                    "cancelled",
                    "expired",
                ])
                .default(D::String("pending"))
                .required(),
            Field::new("nextAttemptAt", T::Date).required(),
            Field::new("lockedUntil", T::Date).default(D::Epoch),
            Field::new("leaseToken", T::String).default(D::String("")),
            Field::new("attempts", T::Number).default(D::Number(0.0)),
            Field::new("failures", T::Number).default(D::Number(0.0)),
            Field::new("lastStatus", T::Number).default(D::Number(0.0)),
            Field::new("lastMessage", T::String).default(D::String("")),
            Field::new("completedAt", T::Date).default(D::Null),
            Field::new("expiresAt", T::Date).required(),
            Field::new("purgeAt", T::Date).required(),
            Field::new("auditPending", T::Boolean).default(D::Boolean(false)),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"status":1,"nextAttemptAt":1,"createdAt":1}),
            SchemaIndex::new(doc! {"status":1,"expiresAt":1}),
            SchemaIndex::new(doc! {"auditPending":1}),
            SchemaIndex::new(doc! {"raidSessionID":1,"followerID":1,"status":1}),
            SchemaIndex::new(doc! {"purgeAt":1}).ttl(0),
        ],
    })
}
pub fn control_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "follow_defense_control",
        collection: "follow_defense_controls",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("cancelledThrough", T::Date).default(D::Epoch),
            Field::new("pendingUntil", T::Date).default(D::Epoch),
            Field::new("nextAllowedAt", T::Date).default(D::Epoch),
            Field::new("lastServedAt", T::Date).default(D::Epoch),
            Field::new("ratePerSecond", T::Number).default(D::Number(5.0)),
            Field::new("successStreak", T::Number).default(D::Number(0.0)),
            Field::new("lockedUntil", T::Date).default(D::Epoch),
            Field::new("leaseToken", T::String).default(D::String("")),
        ],
        indexes: vec![SchemaIndex::new(doc! {"nextAllowedAt":1,"lastServedAt":1})],
    })
}
pub fn get_follow_defense_action_model(database: &Database) -> SchemaRepository {
    action_schema().repository(database)
}
pub fn get_follow_defense_control_model(database: &Database) -> SchemaRepository {
    control_schema().repository(database)
}
