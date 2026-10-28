use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type RaidSession = Document;
pub fn schema() -> &'static SchemaDefinition {
    session_schema()
}
pub fn session_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_session",
        collection: "raid_sessions",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("eventID", T::String).required(),
            Field::new("raiderID", T::String).required(),
            Field::new("raiderLogin", T::String).default(D::String("")),
            Field::new("raiderName", T::String).default(D::String("")),
            Field::new("viewers", T::Number).default(D::Number(0.0)),
            Field::new("startedAt", T::Date).required(),
            Field::new("endedAt", T::Date).default(D::Null),
            Field::new("captureUntil", T::Date).required(),
            Field::new("retentionHours", T::Number).required(),
            Field::new("expiresAt", T::Date).required(),
            Field::new("purgeAt", T::Date).required(),
            Field::new("backfillUntil", T::Date).required(),
            Field::new("backfillCursor", T::String).default(D::String("")),
            Field::new("backfillDone", T::Boolean).default(D::Boolean(false)),
            Field::new("manualRequestID", T::String).default(D::String("")),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"channelID":1,"startedAt":-1}),
            SchemaIndex::new(doc! {"purgeAt":1}).ttl(0),
        ],
    })
}
pub fn follower_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_follower",
        collection: "raid_followers",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("sessionID", T::String).required(),
            Field::new("eventID", T::String).required(),
            Field::new("userID", T::String).required(),
            Field::new("login", T::String).default(D::String("")),
            Field::new("name", T::String).default(D::String("")),
            Field::new("followedAt", T::Date).required(),
            Field::new("recordedAt", T::Date).default(D::Now),
            Field::new("queuedRequestIDs", T::Array(Box::new(T::String))).default(D::Array),
            Field::new("eligibleRequestIDs", T::Array(Box::new(T::String))).default(D::Array),
            Field::new("purgeAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"sessionID":1,"followedAt":1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"followedAt":1}),
            SchemaIndex::new(doc! {"sessionID":1,"userID":1}),
            SchemaIndex::new(doc! {"purgeAt":1}).ttl(0),
        ],
    })
}
pub fn request_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "raid_moderation_request",
        collection: "raid_moderation_requests",
        string_id: true,
        version_key: false,
        write_concern_journaled: true,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("sessionID", T::String).required(),
            Field::new("actorID", T::String).required(),
            Field::new("userID", T::String).default(D::String("")),
            Field::new("origin", T::String)
                .enumeration(&["history", "live"])
                .default(D::String("history")),
            Field::new("includeFuture", T::Boolean).default(D::Boolean(false)),
            Field::new("requestedAt", T::Date).required(),
            Field::new("expiresAt", T::Date).required(),
            Field::new("purgeAt", T::Date).required(),
            Field::new("status", T::String)
                .enumeration(&[
                    "authorizing",
                    "pending",
                    "active",
                    "completed",
                    "cancelled",
                    "expired",
                ])
                .default(D::String("pending")),
            Field::new("lockedUntil", T::Date).default(D::Epoch),
            Field::new("leaseToken", T::String).default(D::String("")),
            Field::new("nextAttemptAt", T::Date).default(D::Epoch),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"status":1,"nextAttemptAt":1}),
            SchemaIndex::new(doc! {"purgeAt":1}).ttl(0),
        ],
    })
}
