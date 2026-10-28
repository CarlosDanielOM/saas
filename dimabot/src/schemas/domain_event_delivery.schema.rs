use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
pub type DomainEventDelivery = Document;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DomainEventDeliveryStatus {
    Pending,
    Processing,
    Retry,
    Succeeded,
    Skipped,
    Dead,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainEventDeliveryErrorCode {
    #[serde(rename = "")]
    None,
    PrerequisiteMissing,
    ContractInvalid,
    HandlerFailed,
    Interrupted,
    JournalMissing,
    PolicyRejected,
}
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "domain_event_delivery",
        collection: "domain_event_deliveries",
        string_id: false,
        version_key: false,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        fields: vec![
            Field::new("consumer", T::String).required(),
            Field::new("topic", T::String).required(),
            Field::new("eventID", T::ObjectId).required(),
            Field::new("eventKey", T::String).required(),
            Field::new("status", T::String)
                .enumeration(&[
                    "pending",
                    "processing",
                    "retry",
                    "succeeded",
                    "skipped",
                    "dead",
                ])
                .default(D::String("pending"))
                .required(),
            Field::new("attempts", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("nextAttemptAt", T::Date).default(D::Null),
            Field::new("lockedUntil", T::Date).default(D::Null),
            Field::new("leaseToken", T::String).default(D::Null),
            Field::new("lastError", T::String).default(D::String("")),
            Field::new("lastErrorCode", T::String)
                .enumeration(&[
                    "",
                    "prerequisite_missing",
                    "contract_invalid",
                    "handler_failed",
                    "interrupted",
                    "journal_missing",
                    "policy_rejected",
                ])
                .default(D::String("")),
            Field::new("lastPrerequisiteKind", T::String)
                .enumeration(&["", "owner", "subject", "metric", "other"])
                .default(D::String("")),
            Field::new("lastAttemptDurationMs", T::Number)
                .min(0.0)
                .default(D::Null),
            Field::new("lastDeadLetterError", T::String).default(D::String("")),
            Field::new("firstAttemptAt", T::Date).default(D::Null),
            Field::new("completedAt", T::Date).default(D::Null),
            Field::new("skipReason", T::String).default(D::String("")),
            Field::new("deadLetteredAt", T::Date).default(D::Null),
            Field::new("replayCount", T::Number)
                .default(D::Number(0.0))
                .required(),
            Field::new("lastReplayedAt", T::Date).default(D::Null),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"consumer":1}),
            SchemaIndex::new(doc! {"topic":1}),
            SchemaIndex::new(doc! {"status":1}),
            SchemaIndex::new(doc! {"consumer":1,"eventKey":1}).unique(),
            SchemaIndex::new(doc! {"consumer":1,"status":1,"nextAttemptAt":1}),
            SchemaIndex::new(doc! {"consumer":1,"status":1,"lockedUntil":1}),
            SchemaIndex::new(doc! {"consumer":1,"status":1,"updatedAt":1,"_id":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
