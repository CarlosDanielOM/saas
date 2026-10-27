//! Domain-event key and envelope helpers shared by
//! `dimabot/src/utils/domain_events.ts` and
//! `dimabot/src/utils/domain_event_consumer.ts`.
//!
//! Those two files each define an identical private `toEnvelope` projection of a
//! journal document, plus `domain_events.ts` builds the unique event key. This
//! module provides the reusable core; it deliberately does not port the journal
//! write, delivery, lease, retry, or dispatch runtime.
//!
//! ## Envelope projection contract
//!
//! [`DomainEventEnvelope`] copies exactly the fields the TypeScript
//! `toEnvelope` functions name, in a fixed field set:
//!
//! - required by the schema: `_id`, `eventKey`, `source`, `sourceEventId`,
//!   `type`, `topic`, `schemaVersion`, `occurredAt`, `journaledAt`, `payload`,
//!   `metadata`, `expiresAt`;
//! - conditional: `channelID` is required when `topic` is `channel`;
//! - optional: `ownerUserId`, `subject`, `streamID`.
//!
//! Like the source, projection does not validate values and does not throw for
//! a missing required field; use [`DomainEventEnvelope::missing_required_fields`]
//! to check completeness. Absent fields stay absent, `null` stays `null`, and
//! unknown document fields are dropped. Values are copied verbatim, so a BSON
//! ObjectId or date that reached JSON as `{"$oid": ...}` or `{"$date": ...}`
//! keeps that exact representation. The JSON object is serialized through
//! `serde_json`'s map, so key order is its map order (alphabetical by default)
//! rather than the TypeScript insertion order; field identity and values are
//! unchanged.
//!
//! With the `mongo` feature, `project_envelope_bson` does the same projection
//! over a native BSON document and keeps `ObjectId`/`DateTime` as BSON values,
//! so a Mongo consumer never round-trips through a lossy JSON encoding.
//!
//! ## Event key contract
//!
//! [`build_domain_event_key`] joins the three components with `:`, each
//! percent-encoded with `encodeURIComponent` semantics, after a
//! `String(value || '').trim()` normalization. Components that normalize to an
//! empty string are rejected. Because JavaScript `String.prototype.trim` has a
//! smaller whitespace set than Rust `str::trim` (it excludes U+0085 and
//! includes U+FEFF), the helper implements the ECMAScript whitespace set so
//! keys match byte for byte. Rust callers pass `&str`, so the source's
//! `String(value)` coercion is not reproduced; format non-strings first.

use super::js_compat::trim as js_trim;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

/// Envelope fields copied by both TypeScript `toEnvelope` functions.
pub const DOMAIN_EVENT_ENVELOPE_FIELDS: [&str; 16] = [
    "_id",
    "eventKey",
    "source",
    "sourceEventId",
    "type",
    "topic",
    "schemaVersion",
    "ownerUserId",
    "subject",
    "channelID",
    "streamID",
    "occurredAt",
    "journaledAt",
    "payload",
    "metadata",
    "expiresAt",
];

/// Unconditionally required envelope fields in `domain_event.schema.ts`.
pub const DOMAIN_EVENT_REQUIRED_FIELDS: [&str; 12] = [
    "_id",
    "eventKey",
    "source",
    "sourceEventId",
    "type",
    "topic",
    "schemaVersion",
    "occurredAt",
    "journaledAt",
    "payload",
    "metadata",
    "expiresAt",
];

/// Domain-event topic values from `domain_event.types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomainEventTopic {
    Channel,
    Activity,
    Telemetry,
    Domain,
}

impl DomainEventTopic {
    /// Parses a topic string, returning `None` for unknown values.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "channel" => Some(Self::Channel),
            "activity" => Some(Self::Activity),
            "telemetry" => Some(Self::Telemetry),
            "domain" => Some(Self::Domain),
            _ => None,
        }
    }

    /// The stored topic string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Activity => "activity",
            Self::Telemetry => "telemetry",
            Self::Domain => "domain",
        }
    }
}

impl std::fmt::Display for DomainEventTopic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Error returned when a document cannot be read as an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    /// The JSON input was malformed.
    InvalidJson(String),
    /// The JSON input was not an object.
    NotAnObject,
}

impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson(reason) => write!(
                formatter,
                "domain event document is not valid JSON: {reason}"
            ),
            Self::NotAnObject => formatter.write_str("domain event document must be a JSON object"),
        }
    }
}

impl std::error::Error for EnvelopeError {}

/// Error returned when an event-key component is blank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomainEventKeyError;

impl std::fmt::Display for DomainEventKeyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Domain event key component is required")
    }
}

impl std::error::Error for DomainEventKeyError {}

/// Projection of a journal document into the domain-event envelope.
///
/// Field values are copied verbatim; see the module documentation for the
/// absent/`null`/BSON-identity contract.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainEventEnvelope {
    fields: Map<String, Value>,
}

impl DomainEventEnvelope {
    /// Projects an already-parsed JSON object.
    pub fn from_document(document: &Map<String, Value>) -> Self {
        Self {
            fields: project_envelope(document),
        }
    }

    /// Projects a JSON value, requiring an object.
    pub fn from_value(document: &Value) -> Result<Self, EnvelopeError> {
        match document {
            Value::Object(map) => Ok(Self::from_document(map)),
            _ => Err(EnvelopeError::NotAnObject),
        }
    }

    /// Parses and projects a JSON document string.
    pub fn from_json_str(document: &str) -> Result<Self, EnvelopeError> {
        let value: Value = serde_json::from_str(document)
            .map_err(|error| EnvelopeError::InvalidJson(error.to_string()))?;
        Self::from_value(&value)
    }

    /// The projected fields.
    pub fn fields(&self) -> &Map<String, Value> {
        &self.fields
    }

    /// Consumes the envelope, returning its fields.
    pub fn into_fields(self) -> Map<String, Value> {
        self.fields
    }

    /// Consumes the envelope, returning a JSON object value.
    pub fn into_value(self) -> Value {
        Value::Object(self.fields)
    }

    /// Returns a field value, including an explicit `null`.
    pub fn get(&self, field: &str) -> Option<&Value> {
        self.fields.get(field)
    }

    /// The `eventKey` field when it is a string.
    pub fn event_key(&self) -> Option<&str> {
        self.get("eventKey").and_then(Value::as_str)
    }

    /// The `source` field when it is a string.
    pub fn source(&self) -> Option<&str> {
        self.get("source").and_then(Value::as_str)
    }

    /// The `sourceEventId` field when it is a string.
    pub fn source_event_id(&self) -> Option<&str> {
        self.get("sourceEventId").and_then(Value::as_str)
    }

    /// The `type` field when it is a string.
    pub fn event_type(&self) -> Option<&str> {
        self.get("type").and_then(Value::as_str)
    }

    /// The parsed `topic` field, or `None` when absent or unknown.
    pub fn topic(&self) -> Option<DomainEventTopic> {
        let topic = self.get("topic")?.as_str()?;
        DomainEventTopic::parse(topic)
    }

    /// The `occurredAt` field value, preserving its representation.
    pub fn occurred_at(&self) -> Option<&Value> {
        self.get("occurredAt")
    }

    /// The `journaledAt` field value, preserving its representation.
    pub fn journaled_at(&self) -> Option<&Value> {
        self.get("journaledAt")
    }

    /// The `payload` field value.
    pub fn payload(&self) -> Option<&Value> {
        self.get("payload")
    }

    /// The `metadata` field value.
    pub fn metadata(&self) -> Option<&Value> {
        self.get("metadata")
    }

    /// The `channelID` field value, including an explicit `null`.
    pub fn channel_id(&self) -> Option<&Value> {
        self.get("channelID")
    }

    /// Required fields absent from the projected document, including `channelID`
    /// for channel topics. This checks presence, not value validity.
    pub fn missing_required_fields(&self) -> Vec<&'static str> {
        let mut missing: Vec<_> = DOMAIN_EVENT_REQUIRED_FIELDS
            .iter()
            .copied()
            .filter(|field| !self.fields.contains_key(*field))
            .collect();
        if self.topic() == Some(DomainEventTopic::Channel) && !self.fields.contains_key("channelID")
        {
            missing.push("channelID");
        }
        missing
    }

    /// Whether every schema-required field is present.
    pub fn is_complete(&self) -> bool {
        self.missing_required_fields().is_empty()
    }

    /// Compact JSON for the projected envelope.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(&self.fields).expect("a JSON map always serializes to JSON")
    }
}

impl Serialize for DomainEventEnvelope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.fields.serialize(serializer)
    }
}

/// Copies the envelope fields from a JSON document, preserving absence and
/// `null` and dropping unknown fields.
pub fn project_envelope(document: &Map<String, Value>) -> Map<String, Value> {
    let mut envelope = Map::new();
    for field in DOMAIN_EVENT_ENVELOPE_FIELDS {
        if let Some(value) = document.get(field) {
            envelope.insert(field.to_owned(), value.clone());
        }
    }
    envelope
}

/// Builds the unique domain-event key `source:sourceEventId:type`.
///
/// Each component is trimmed with ECMAScript whitespace rules and
/// percent-encoded like `encodeURIComponent`, so delimiters inside a component
/// cannot collide with the join. Blank components are rejected.
pub fn build_domain_event_key(
    source: &str,
    source_event_id: &str,
    event_type: &str,
) -> Result<String, DomainEventKeyError> {
    let source = normalize_key_component(source)?;
    let source_event_id = normalize_key_component(source_event_id)?;
    let event_type = normalize_key_component(event_type)?;
    Ok(format!(
        "{}:{}:{}",
        encode_uri_component(source),
        encode_uri_component(source_event_id),
        encode_uri_component(event_type)
    ))
}

/// Projects the envelope fields from a native BSON document.
///
/// `ObjectId`, `DateTime`, and every other BSON value are copied unchanged, so
/// the result keeps the exact representation stored in MongoDB. Unknown fields
/// are dropped and absent optional fields stay absent, matching
/// [`project_envelope`].
#[cfg(feature = "mongo")]
pub fn project_envelope_bson(document: &mongodb::bson::Document) -> mongodb::bson::Document {
    let mut envelope = mongodb::bson::Document::new();
    for field in DOMAIN_EVENT_ENVELOPE_FIELDS {
        if let Some(value) = document.get(field) {
            envelope.insert(field.to_owned(), value.clone());
        }
    }
    envelope
}

fn normalize_key_component(value: &str) -> Result<&str, DomainEventKeyError> {
    let normalized = js_trim(value);
    if normalized.is_empty() {
        return Err(DomainEventKeyError);
    }
    Ok(normalized)
}

/// Characters `encodeURIComponent` leaves unescaped in addition to
/// `A-Za-z0-9`.
const URI_COMPONENT_PUNCTUATION: &[u8] = b"-_.!~*'()";

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || URI_COMPONENT_PUNCTUATION.contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0F));
        }
    }
    encoded
}

fn hex_digit(nibble: u8) -> char {
    char::from_digit(u32::from(nibble), 16)
        .expect("a nibble is a valid hex digit")
        .to_ascii_uppercase()
}
