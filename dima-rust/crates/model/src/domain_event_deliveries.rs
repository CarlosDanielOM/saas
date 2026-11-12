//! `domain_event_deliveries`: the delivery of one journaled domain event to one consumer, with
//! its lease, retries, dead-lettering and replays.
//!
//! Reference: `dimabot/src/schemas/domain_event_delivery.schema.ts`. Camel-case timestamps, no
//! `__v`, no hooks. Unique `{consumer, eventKey}`; TTL on `expiresAt`. The status vocabulary and
//! the lease fields are ported exactly (`MIGRATION.md` data rule 8); the error code and
//! prerequisite kind enumerations include the empty string.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "domain_event_deliveries";

str_enum! {
    /// `status`.
    pub enum DeliveryStatus {
        /// Waiting for its first attempt (the default).
        Pending = "pending",
        /// Leased by a worker.
        Processing = "processing",
        /// Waiting for a retry.
        Retry = "retry",
        /// Done.
        Succeeded = "succeeded",
        /// Not applicable to this consumer.
        Skipped = "skipped",
        /// Dead-lettered.
        Dead = "dead",
    }
}

str_enum! {
    /// `lastErrorCode`.
    pub enum DeliveryErrorCode {
        /// No error (the default).
        None = "",
        /// Something the handler needs does not exist yet.
        PrerequisiteMissing = "prerequisite_missing",
        /// The event does not match its contract.
        ContractInvalid = "contract_invalid",
        /// The handler threw.
        HandlerFailed = "handler_failed",
        /// The attempt was interrupted (lease expired).
        Interrupted = "interrupted",
        /// The journaled event is gone.
        JournalMissing = "journal_missing",
        /// A policy refused the event.
        PolicyRejected = "policy_rejected",
    }
}

str_enum! {
    /// `lastPrerequisiteKind`.
    pub enum PrerequisiteKind {
        /// None (the default).
        None = "",
        /// The owning user.
        Owner = "owner",
        /// The subject.
        Subject = "subject",
        /// A metric.
        Metric = "metric",
        /// Anything else.
        Other = "other",
    }
}

/// The schema, field by field as `domain_event_delivery.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("consumer"),
    Field::string("topic"),
    Field::object_id("eventID"),
    Field::string("eventKey"),
    Field::string("status").default(D::Str("pending")),
    Field::number("attempts").default(D::Int(0)),
    Field::date("nextAttemptAt").default(D::Null),
    Field::date("lockedUntil").default(D::Null),
    Field::string("leaseToken").default(D::Null),
    Field::string("lastError").default(D::Str("")),
    Field::string("lastErrorCode").default(D::Str("")),
    Field::string("lastPrerequisiteKind").default(D::Str("")),
    Field::number("lastAttemptDurationMs").default(D::Null),
    Field::string("lastDeadLetterError").default(D::Str("")),
    Field::date("firstAttemptAt").default(D::Null),
    Field::date("completedAt").default(D::Null),
    Field::string("skipReason").default(D::Str("")),
    Field::date("deadLetteredAt").default(D::Null),
    Field::number("replayCount").default(D::Int(0)),
    Field::date("lastReplayedAt").default(D::Null),
    Field::date("expiresAt"),
])
.timestamps(Timestamps::CAMEL)
.no_version_key();

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("consumer", 1)]),
    IndexSpec::on(&[("topic", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("consumer", 1), ("eventKey", 1)]).unique(),
    IndexSpec::on(&[("consumer", 1), ("status", 1), ("nextAttemptAt", 1)]),
    IndexSpec::on(&[("consumer", 1), ("status", 1), ("lockedUntil", 1)]),
    IndexSpec::on(&[("consumer", 1), ("status", 1), ("updatedAt", 1), ("_id", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("consumer"),
    Rule::required("topic"),
    Rule::required("eventID"),
    Rule::required("eventKey"),
    Rule::required("status"),
    Rule::one_of("status", DeliveryStatus::STRINGS),
    Rule::required("attempts"),
    Rule::one_of("lastErrorCode", DeliveryErrorCode::STRINGS),
    Rule::one_of("lastPrerequisiteKind", PrerequisiteKind::STRINGS),
    Rule::min("lastAttemptDurationMs", 0.0),
    Rule::required("replayCount"),
    Rule::required("expiresAt"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("consumer"),
    ReadNeed::value("topic"),
    ReadNeed::value("eventID"),
    ReadNeed::value("eventKey"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("attempts"),
    ReadNeed::not_null("lastError"),
    ReadNeed::not_null("lastErrorCode"),
    ReadNeed::not_null("lastPrerequisiteKind"),
    ReadNeed::not_null("lastDeadLetterError"),
    ReadNeed::not_null("skipReason"),
    ReadNeed::not_null("replayCount"),
    ReadNeed::value("expiresAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "domain_event_delivery",
    source: "dimabot/src/schemas/domain_event_delivery.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<Delivery>,
};

/// A stored delivery.
#[derive(Clone, Debug, Deserialize)]
pub struct Delivery {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The consumer name.
    pub consumer: String,
    /// The event's topic.
    pub topic: String,
    /// The event (`domain_events._id`).
    #[serde(rename = "eventID")]
    pub event_id: ObjectId,
    /// The event's idempotency key.
    #[serde(rename = "eventKey")]
    pub event_key: String,
    /// Delivery state.
    #[serde(default = "pending")]
    pub status: Open<DeliveryStatus>,
    /// Attempts made.
    #[serde(default = "zero")]
    pub attempts: JsNumber,
    /// When the next attempt is due.
    #[serde(default, rename = "nextAttemptAt")]
    pub next_attempt_at: Option<JsDate>,
    /// End of the current lease.
    #[serde(default, rename = "lockedUntil")]
    pub locked_until: Option<JsDate>,
    /// The current lease's fence token.
    #[serde(default, rename = "leaseToken")]
    pub lease_token: Option<String>,
    /// The last error text.
    #[serde(default = "empty", rename = "lastError")]
    pub last_error: String,
    /// The last error's class (`''` on success and on documents older than the field).
    #[serde(default = "no_error", rename = "lastErrorCode")]
    pub last_error_code: Open<DeliveryErrorCode>,
    /// The missing prerequisite's kind.
    #[serde(default = "no_prerequisite", rename = "lastPrerequisiteKind")]
    pub last_prerequisite_kind: Open<PrerequisiteKind>,
    /// Duration of the last attempt.
    #[serde(default, rename = "lastAttemptDurationMs")]
    pub last_attempt_duration_ms: Option<JsNumber>,
    /// The error that dead-lettered it.
    #[serde(default = "empty", rename = "lastDeadLetterError")]
    pub last_dead_letter_error: String,
    /// First attempt.
    #[serde(default, rename = "firstAttemptAt")]
    pub first_attempt_at: Option<JsDate>,
    /// Completion.
    #[serde(default, rename = "completedAt")]
    pub completed_at: Option<JsDate>,
    /// Why it was skipped.
    #[serde(default = "empty", rename = "skipReason")]
    pub skip_reason: String,
    /// When it was dead-lettered.
    #[serde(default, rename = "deadLetteredAt")]
    pub dead_lettered_at: Option<JsDate>,
    /// Replays requested.
    #[serde(default = "zero", rename = "replayCount")]
    pub replay_count: JsNumber,
    /// Last replay.
    #[serde(default, rename = "lastReplayedAt")]
    pub last_replayed_at: Option<JsDate>,
    /// Expiry (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn pending() -> Open<DeliveryStatus> {
    Open::Known(DeliveryStatus::Pending)
}

fn no_error() -> Open<DeliveryErrorCode> {
    Open::Known(DeliveryErrorCode::None)
}

fn no_prerequisite() -> Open<PrerequisiteKind> {
    Open::Known(PrerequisiteKind::None)
}

/// A new delivery (the consumer usually upserts it; `create` is used by tests and tooling).
#[derive(Clone, Debug, Serialize)]
pub struct NewDelivery {
    /// The consumer name.
    pub consumer: String,
    /// The event's topic.
    pub topic: String,
    /// The event.
    #[serde(rename = "eventID")]
    pub event_id: ObjectId,
    /// The event's idempotency key.
    #[serde(rename = "eventKey")]
    pub event_key: String,
    /// State (default `pending`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<DeliveryStatus>,
    /// Expiry (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

impl NewDelivery {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
