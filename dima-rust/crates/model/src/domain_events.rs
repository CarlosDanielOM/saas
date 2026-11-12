//! `domain_events`: the durable journal of things that happened (Twitch notifications, Polar
//! billing events, internal domain events), read by the journal consumers.
//!
//! Reference: `dimabot/src/schemas/domain_event.schema.ts` (model `domain_event`). No timestamps,
//! no `__v`, no hooks; every field except `dispatchPending` is immutable. Unique `eventKey` (the
//! idempotency signal: a duplicate key means "already journaled") and
//! `{source, sourceEventId, type}`; TTL on `expiresAt`; partial indexes on `dispatchPending` and
//! `metadata.durableChatHandled`.
//!
//! The reference journals an event by validating a Mongoose document and inserting its
//! `toObject()` with the raw driver and `{w: 1, j: true}` (`utils/domain_events.ts:101-129`):
//! [`NewDomainEvent::prepare_journal`] builds that document and [`journal_write_concern`] is the
//! write concern. An empty `payload` or `metadata` is not stored at all (`minimize`).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.
//! `metadata` (`Mixed`) is read as raw BSON ([`DomainEventMetadata`]).

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use mongodb::options::{Acknowledgment, WriteConcern};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "domain_events";

str_enum! {
    /// `topic`.
    pub enum Topic {
        /// Channel events (a `channelID` is required).
        Channel = "channel",
        /// Activity events.
        Activity = "activity",
        /// Telemetry.
        Telemetry = "telemetry",
        /// Domain events (billing...).
        Domain = "domain",
    }
}

str_enum! {
    /// `subject.kind`.
    pub enum SubjectKind {
        /// A streaming platform account.
        StreamingAccount = "streaming-account",
        /// An integration account.
        IntegrationAccount = "integration-account",
        /// A billing customer.
        Customer = "customer",
        /// Another resource.
        Resource = "resource",
    }
}

static SUBJECT: Schema = Schema::subdocument(&[
    Field::string("provider"),
    Field::string("kind"),
    Field::string("id"),
])
.no_id();

/// The schema, field by field as `domain_event.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("eventKey").immutable(),
    Field::string("source").immutable(),
    Field::string("sourceEventId").immutable(),
    Field::string("type").immutable(),
    Field::string("topic").immutable(),
    Field::number("schemaVersion")
        .default(D::Int(1))
        .immutable(),
    Field::string("ownerUserId").immutable(),
    Field::subdocument("subject", &SUBJECT).immutable(),
    Field::string("channelID").immutable(),
    Field::string("streamID").immutable(),
    Field::date("occurredAt").immutable(),
    Field::date("journaledAt").default_fn(D::Now).immutable(),
    Field::mixed("payload").immutable(),
    // `default: {}`: Mongoose turns an object literal on a Mixed path into a function.
    Field::mixed("metadata")
        .default_fn(D::EmptyDocument)
        .immutable(),
    Field::date("expiresAt").immutable(),
    Field::boolean("dispatchPending"),
])
.no_version_key();

fn dispatch_pending() -> Document {
    doc! { "dispatchPending": true }
}

fn durable_chat_handled() -> Document {
    doc! { "metadata.durableChatHandled": true }
}

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("type", 1)]),
    IndexSpec::on(&[("topic", 1)]),
    IndexSpec::on(&[("ownerUserId", 1)]),
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("eventKey", 1)]).unique(),
    IndexSpec::on(&[("source", 1), ("sourceEventId", 1), ("type", 1)]).unique(),
    IndexSpec::on(&[("topic", 1), ("_id", 1)]),
    IndexSpec::on(&[("topic", 1), ("source", 1), ("_id", 1)]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("source", 1),
        ("type", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[("dispatchPending", 1), ("_id", 1)]).partial(dispatch_pending),
    IndexSpec::on(&[("topic", 1), ("metadata.durableChatHandled", 1), ("_id", 1)])
        .partial(durable_chat_handled),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];

fn is_channel_topic(document: &Document) -> bool {
    document
        .get_str("topic")
        .is_ok_and(|topic| topic == "channel")
}

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("eventKey"),
    Rule::required("source"),
    Rule::required("sourceEventId"),
    Rule::required("type"),
    Rule::required("topic"),
    Rule::one_of("topic", Topic::STRINGS),
    Rule::required("schemaVersion"),
    Rule::required("subject.provider"),
    Rule::required("subject.kind"),
    Rule::one_of("subject.kind", SubjectKind::STRINGS),
    Rule::required("subject.id"),
    Rule::required_when("channelID", is_channel_topic),
    Rule::required("occurredAt"),
    Rule::required("journaledAt"),
    Rule::required("payload"),
    Rule::required("metadata"),
    Rule::required("expiresAt"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["payload"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("eventKey"),
    ReadNeed::value("source"),
    ReadNeed::value("sourceEventId"),
    ReadNeed::value("type"),
    ReadNeed::value("topic"),
    ReadNeed::not_null("schemaVersion"),
    ReadNeed::value("subject.provider"),
    ReadNeed::value("subject.kind"),
    ReadNeed::value("subject.id"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("expiresAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "domain_event",
    source: "dimabot/src/schemas/domain_event.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: PRIVATE,
    decode: decode_boxed::<DomainEvent>,
};

/// A journaled event.
#[derive(Clone, Debug, Deserialize)]
pub struct DomainEvent {
    /// `_id` (also the journal order).
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The idempotency key (`source:sourceEventId:type`).
    #[serde(rename = "eventKey")]
    pub event_key: String,
    /// The producer.
    pub source: String,
    /// The producer's id for the event.
    #[serde(rename = "sourceEventId")]
    pub source_event_id: String,
    /// The event type.
    #[serde(rename = "type")]
    pub kind: String,
    /// The topic.
    pub topic: Open<Topic>,
    /// The payload's schema version.
    #[serde(default = "version_one", rename = "schemaVersion")]
    pub schema_version: JsNumber,
    /// The owning user (`users._id` as hex).
    #[serde(default, rename = "ownerUserId")]
    pub owner_user_id: Option<String>,
    /// What the event is about.
    #[serde(default)]
    pub subject: Option<Subject>,
    /// The channel, for channel events.
    #[serde(default, rename = "channelID")]
    pub channel_id: Option<String>,
    /// The stream, when known.
    #[serde(default, rename = "streamID")]
    pub stream_id: Option<String>,
    /// When it happened.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// When it was journaled.
    #[serde(default, rename = "journaledAt")]
    pub journaled_at: Option<JsDate>,
    /// The payload (missing when it was journaled as `{}`).
    #[serde(default)]
    pub payload: Option<Private<DomainEventPayload>>,
    /// Metadata (`{}` when missing, as Mongoose's default).
    #[serde(default)]
    pub metadata: DomainEventMetadata,
    /// Expiry (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// Still to be dispatched to the consumers.
    #[serde(default, rename = "dispatchPending")]
    pub dispatch_pending: Option<bool>,
}

fn version_one() -> JsNumber {
    JsNumber(1.0)
}

/// `subject`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Subject {
    /// The provider (`twitch`, `polar`).
    pub provider: String,
    /// The kind of subject.
    pub kind: Open<SubjectKind>,
    /// The provider's id.
    pub id: String,
}

/// An event payload, kept as stored until the domain events package types each event.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DomainEventPayload(pub Bson);

/// Event metadata (`originalEventType`, `durableChatHandled`, `observability`...), kept as
/// stored. The path is `Mixed`, so any value may be stored there; missing reads as the default
/// `{}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DomainEventMetadata(pub Bson);

impl Default for DomainEventMetadata {
    fn default() -> Self {
        Self(Bson::Document(Document::new()))
    }
}

impl DomainEventMetadata {
    /// `true` only when `key` is stored as `true` (the reference tests `=== true`).
    pub fn flag(&self, key: &str) -> bool {
        matches!(&self.0, Bson::Document(metadata) if matches!(metadata.get(key), Some(Bson::Boolean(true))))
    }
}

/// `{w: 1, j: true}`: the write concern of a journal insert.
pub fn journal_write_concern() -> WriteConcern {
    WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build()
}

/// An event to journal. The business rules (key building, retention, identity checks) are the
/// domain events package's; this is the document they produce.
#[derive(Clone, Debug, Serialize)]
pub struct NewDomainEvent {
    /// `_id` (the reference generates it before building the document).
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    /// The idempotency key.
    #[serde(rename = "eventKey")]
    pub event_key: String,
    /// The producer.
    pub source: String,
    /// The producer's id for the event.
    #[serde(rename = "sourceEventId")]
    pub source_event_id: String,
    /// The event type.
    #[serde(rename = "type")]
    pub kind: String,
    /// The topic.
    pub topic: Topic,
    /// The payload's schema version (default 1).
    #[serde(rename = "schemaVersion", skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<JsNumber>,
    /// The owning user.
    #[serde(rename = "ownerUserId", skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    /// What the event is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<NewSubject>,
    /// The channel (required for the channel topic).
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The stream.
    #[serde(rename = "streamID", skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    /// When it happened.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// When it was journaled (default: the write time).
    #[serde(rename = "journaledAt", skip_serializing_if = "Option::is_none")]
    pub journaled_at: Option<JsDate>,
    /// The payload.
    pub payload: Private<Document>,
    /// Metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Document>,
    /// Still to be dispatched.
    #[serde(rename = "dispatchPending", skip_serializing_if = "Option::is_none")]
    pub dispatch_pending: Option<bool>,
    /// Expiry (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

/// A new event's subject.
#[derive(Clone, Debug, Serialize)]
pub struct NewSubject {
    /// The provider.
    pub provider: String,
    /// The kind of subject.
    pub kind: SubjectKind,
    /// The provider's id.
    pub id: String,
}

impl NewDomainEvent {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The document the reference inserts: `new Model(input)`, validated, `toObject()` (defaults,
    /// `minimize`). Insert it with [`journal_write_concern`]; a duplicate key on `eventKey_1`
    /// means the event was already journaled.
    pub fn prepare_journal(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
