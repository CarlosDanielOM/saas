//! Native equivalents of domain_event.types.ts; no database connection needed.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{future::Future, pin::Pin};

pub use crate::utils::domain_events::{DomainEventEnvelope, DomainEventTopic};

pub const DOMAIN_EVENT_RETENTION_SECONDS: [(&str, u64); 4] = [
    ("channel", 90 * 24 * 60 * 60),
    ("activity", 3 * 24 * 60 * 60),
    ("telemetry", 7 * 24 * 60 * 60),
    ("domain", 90 * 24 * 60 * 60),
];

pub fn retention_seconds(topic: DomainEventTopic) -> u64 {
    match topic {
        DomainEventTopic::Channel | DomainEventTopic::Domain => 90 * 24 * 60 * 60,
        DomainEventTopic::Activity => 3 * 24 * 60 * 60,
        DomainEventTopic::Telemetry => 7 * 24 * 60 * 60,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DomainEventSubjectKind {
    StreamingAccount,
    IntegrationAccount,
    Customer,
    Resource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomainEventSubject {
    pub provider: String,
    pub kind: DomainEventSubjectKind,
    pub id: String,
}

/// A producer/write value. JSON dates are RFC3339 strings. Use
/// `NativeRetainedContract` when a native journal read holds Date/ObjectId
/// values rather than JSON values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDomainEventInput {
    pub source: String,
    pub source_event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<DomainEventSubject>,
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(rename = "streamID", skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    pub payload: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalDomainEventResult {
    pub event: DomainEventEnvelope,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainEventPrerequisiteMissingError {
    pub prerequisite: String,
}

impl DomainEventPrerequisiteMissingError {
    pub const OUTCOME: &'static str = "prerequisite-missing";

    pub fn new(prerequisite: impl Into<String>) -> Self {
        Self {
            prerequisite: prerequisite.into(),
        }
    }

    pub fn outcome(&self) -> &'static str {
        Self::OUTCOME
    }
}

impl std::fmt::Display for DomainEventPrerequisiteMissingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Missing prerequisite: {}", self.prerequisite)
    }
}

impl std::error::Error for DomainEventPrerequisiteMissingError {}

pub type DomainEventFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, Box<dyn std::error::Error + Send + Sync>>> + Send + 'a>>;
pub type DomainEventHandler =
    dyn for<'a> Fn(&'a DomainEventEnvelope) -> DomainEventFuture<'a, ()> + Send + Sync;
pub type DomainEventOwnerResolver = dyn for<'a> Fn(&'a JournalDomainEventInput) -> DomainEventFuture<'a, Option<String>>
    + Send
    + Sync;

/// A producer description; transport verification and concrete owner lookup
/// belong to the application adapter. This equivalent type is not an adapter.
pub struct DomainEventProducer<Input> {
    pub provider: String,
    pub normalize:
        fn(Input) -> Result<Option<JournalDomainEventInput>, super::DomainEventContractError>,
    pub resolve_owner: Option<Box<DomainEventOwnerResolver>>,
}
