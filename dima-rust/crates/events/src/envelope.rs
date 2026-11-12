//! `DomainEventEnvelope`: a journaled event as producers get it back and consumers read it
//! (`toEnvelope` in `utils/domain_events.ts` and `utils/domain_event_consumer.ts`).

use crate::contracts::{Check, ContractError, validate_contract};
use crate::value::{Object, Value};
use bson::{Bson, Document, oid::ObjectId};

/// `subject`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    /// The provider.
    pub provider: String,
    /// The kind (as stored).
    pub kind: String,
    /// The provider's id.
    pub id: String,
}

/// A journaled event. Times are epoch milliseconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Envelope {
    /// `_id` (also the journal order).
    pub id: ObjectId,
    /// `eventKey`.
    pub event_key: String,
    /// `source`.
    pub source: String,
    /// `sourceEventId`.
    pub source_event_id: String,
    /// `type`.
    pub kind: String,
    /// `topic` (as stored).
    pub topic: String,
    /// `schemaVersion`.
    pub schema_version: f64,
    /// `ownerUserId`.
    pub owner_user_id: Option<String>,
    /// `subject`.
    pub subject: Option<Subject>,
    /// `channelID`.
    pub channel_id: Option<String>,
    /// `streamID`.
    pub stream_id: Option<String>,
    /// `occurredAt`.
    pub occurred_at_ms: i64,
    /// `journaledAt` (always present in the journal; `None` only for a document without it).
    pub journaled_at_ms: Option<i64>,
    /// `payload` (`{}` when it was journaled empty and so not stored).
    pub payload: Object,
    /// `metadata` (`{}` when missing).
    pub metadata: Object,
    /// `expiresAt`.
    pub expires_at_ms: i64,
}

/// A stored document that is not a journal event.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("domain event document: {field} is missing or has the wrong type")]
pub struct EnvelopeError {
    /// The field.
    pub field: &'static str,
}

fn text(document: &Document, field: &'static str) -> Result<String, EnvelopeError> {
    match document.get(field) {
        Some(Bson::String(text)) => Ok(text.clone()),
        _ => Err(EnvelopeError { field }),
    }
}

fn optional_text(
    document: &Document,
    field: &'static str,
) -> Result<Option<String>, EnvelopeError> {
    match document.get(field) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::String(text)) => Ok(Some(text.clone())),
        _ => Err(EnvelopeError { field }),
    }
}

fn date(document: &Document, field: &'static str) -> Result<i64, EnvelopeError> {
    match document.get(field) {
        Some(Bson::DateTime(date)) => Ok(date.timestamp_millis()),
        _ => Err(EnvelopeError { field }),
    }
}

impl Envelope {
    /// The envelope of a stored journal document.
    pub fn from_document(document: &Document) -> Result<Self, EnvelopeError> {
        let id = match document.get("_id") {
            Some(Bson::ObjectId(id)) => *id,
            _ => return Err(EnvelopeError { field: "_id" }),
        };
        let schema_version = match document.get("schemaVersion") {
            None => 1.0,
            Some(value) => dima_store::mongo::number::read_number(value).ok_or(EnvelopeError {
                field: "schemaVersion",
            })?,
        };
        let subject = match document.get("subject") {
            None | Some(Bson::Null) => None,
            Some(Bson::Document(subject)) => Some(Subject {
                provider: text(subject, "provider").map_err(|_| EnvelopeError {
                    field: "subject.provider",
                })?,
                kind: text(subject, "kind").map_err(|_| EnvelopeError {
                    field: "subject.kind",
                })?,
                id: text(subject, "id").map_err(|_| EnvelopeError {
                    field: "subject.id",
                })?,
            }),
            Some(_) => return Err(EnvelopeError { field: "subject" }),
        };
        let object = |field: &'static str| match document.get(field) {
            None => Ok(Object::new()),
            Some(Bson::Document(inner)) => Ok(Object::from_bson(inner)),
            Some(_) => Err(EnvelopeError { field }),
        };
        Ok(Self {
            id,
            event_key: text(document, "eventKey")?,
            source: text(document, "source")?,
            source_event_id: text(document, "sourceEventId")?,
            kind: text(document, "type")?,
            topic: text(document, "topic")?,
            schema_version,
            owner_user_id: optional_text(document, "ownerUserId")?,
            subject,
            channel_id: optional_text(document, "channelID")?,
            stream_id: optional_text(document, "streamID")?,
            occurred_at_ms: date(document, "occurredAt")?,
            journaled_at_ms: match document.get("journaledAt") {
                None => None,
                Some(_) => Some(date(document, "journaledAt")?),
            },
            payload: object("payload")?,
            metadata: object("metadata")?,
            expires_at_ms: date(document, "expiresAt")?,
        })
    }

    /// The envelope as the validator reads it in `retained` mode (the reference validates
    /// `toEnvelope(event)` before handing a Twitch or Polar event to a consumer).
    pub fn contract_object(&self) -> Object {
        let mut object = Object::new();
        object.insert("_id", Value::ObjectId(self.id));
        object.insert("eventKey", Value::from(self.event_key.as_str()));
        object.insert("source", Value::from(self.source.as_str()));
        object.insert("sourceEventId", Value::from(self.source_event_id.as_str()));
        object.insert("type", Value::from(self.kind.as_str()));
        object.insert("topic", Value::from(self.topic.as_str()));
        object.insert("schemaVersion", Value::Number(self.schema_version));
        if let Some(owner) = &self.owner_user_id {
            object.insert("ownerUserId", Value::from(owner.as_str()));
        }
        if let Some(subject) = &self.subject {
            let mut inner = Object::new();
            inner.insert("provider", Value::from(subject.provider.as_str()));
            inner.insert("kind", Value::from(subject.kind.as_str()));
            inner.insert("id", Value::from(subject.id.as_str()));
            object.insert("subject", Value::Object(inner));
        }
        if let Some(channel) = &self.channel_id {
            object.insert("channelID", Value::from(channel.as_str()));
        }
        if let Some(stream) = &self.stream_id {
            object.insert("streamID", Value::from(stream.as_str()));
        }
        object.insert("occurredAt", Value::Date(self.occurred_at_ms as f64));
        // `journaledAt: event.journaledAt`: the key exists even when the value is undefined.
        object.insert(
            "journaledAt",
            self.journaled_at_ms
                .map_or(Value::Undefined, |ms| Value::Date(ms as f64)),
        );
        object.insert("payload", Value::Object(self.payload.clone()));
        object.insert("metadata", Value::Object(self.metadata.clone()));
        object.insert("expiresAt", Value::Date(self.expires_at_ms as f64));
        object
    }

    /// `validateDomainEventContract(envelope)` (`retained` mode).
    pub fn validate_retained(&self, now_ms: i64) -> Result<(), ContractError> {
        validate_contract(&self.contract_object(), Check::retained(now_ms))
    }
}
