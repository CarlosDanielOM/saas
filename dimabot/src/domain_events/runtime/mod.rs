//! Explicit native ingestion and durable journal. Constructors receive native
//! clients/database handles; importing this module opens no connection.

#[path = "../domain_event_identity.rs"]
pub mod identity;
pub mod journal;
#[path = "../polar_events.rs"]
pub mod polar;
pub mod producers;
pub mod telemetry;
#[path = "../twitch_eventsub_events.rs"]
pub mod twitch;
pub mod wakeups;

use mongodb::bson::DateTime;
use serde_json::Value;

/// Producer JSON plus the native Date identity that a Polar SDK input owns.
/// It is separate from a string that merely looks like a date.
#[derive(Debug, Clone)]
pub struct NormalizedDomainEvent {
    pub input: Value,
    pub native_occurred_at: Option<DateTime>,
}

pub use journal::{DomainEventJournal, JournalConfig, JournalError, NativeJournalResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomainEventProducerKind {
    Twitch,
    Polar,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomainEventProducerRegistration {
    pub provider: &'static str,
    pub kind: DomainEventProducerKind,
}
pub const DOMAIN_EVENT_PRODUCERS: [DomainEventProducerRegistration; 2] = [
    DomainEventProducerRegistration {
        provider: "twitch",
        kind: DomainEventProducerKind::Twitch,
    },
    DomainEventProducerRegistration {
        provider: "polar",
        kind: DomainEventProducerKind::Polar,
    },
];
pub enum DomainEventProducerInput<'a> {
    Twitch(&'a Value),
    Polar(&'a polar::NormalizePolarWebhookInput),
}

pub async fn ingest_domain_event(
    journal: &DomainEventJournal,
    producer: DomainEventProducerRegistration,
    input: DomainEventProducerInput<'_>,
) -> Result<Option<NativeJournalResult>, JournalError> {
    let event = match (producer.kind, input) {
        (DomainEventProducerKind::Twitch, DomainEventProducerInput::Twitch(input)) => {
            twitch::normalize_twitch_eventsub_domain_event(input)?
        }
        (DomainEventProducerKind::Polar, DomainEventProducerInput::Polar(input)) => {
            Some(polar::normalize_polar_domain_event(input)?)
        }
        _ => {
            return Err(JournalError::Invalid(
                "Domain event producer/input mismatch",
            ));
        }
    };
    let Some(event) = event else { return Ok(None) };
    ingest_normalized_domain_event(journal, producer.provider, event)
        .await
        .map(Some)
}

pub fn validate_normalized_event(
    event: &NormalizedDomainEvent,
) -> Result<(), crate::domain_event_contracts::DomainEventContractError> {
    if let Some(occurred) = event.native_occurred_at {
        crate::domain_event_contracts::validate_native_ingest_contract(
            &event.input,
            occurred.timestamp_millis(),
        )
    } else {
        crate::domain_event_contracts::validate_domain_event_contract(
            &event.input,
            crate::domain_event_contracts::ContractMode::Ingest,
        )
    }
}

/// Ingest a normalized provider event using concrete Mongo ownership and
/// journal adapters. Unresolved ownership is retained for later consumers.
pub async fn ingest_normalized_domain_event(
    journal: &DomainEventJournal,
    provider: &str,
    mut event: NormalizedDomainEvent,
) -> Result<NativeJournalResult, JournalError> {
    let subject = event
        .input
        .get("subject")
        .and_then(Value::as_object)
        .filter(|s| s.get("provider").and_then(Value::as_str) == Some(provider))
        .ok_or_else(|| {
            JournalError::Contract(
                crate::domain_event_contracts::DomainEventContractError::new(format!(
                    "Producer {provider} must supply its own provider subject"
                )),
            )
        })?;
    validate_normalized_event(&event)?;
    let subject: crate::domain_event_contracts::DomainEventSubject =
        serde_json::from_value(Value::Object(subject.clone()))
            .map_err(|_| JournalError::Invalid("Producer subject is not an identity"))?;
    let metadata = event.input.get("metadata");
    let external = metadata
        .and_then(|m| m.get("externalCustomerId"))
        .and_then(Value::as_str);
    let legacy = metadata
        .and_then(|m| m.get("legacyTwitchChannelId"))
        .and_then(Value::as_str);
    if let Some(owner) =
        identity::resolve_domain_event_owner(journal.database(), &subject, external, legacy).await?
    {
        event.input["ownerUserId"] = Value::String(owner);
    }
    journal.journal(&event).await
}

pub async fn ingest_twitch_domain_event(
    journal: &DomainEventJournal,
    input: &Value,
) -> Result<Option<NativeJournalResult>, JournalError> {
    let Some(event) = twitch::normalize_twitch_eventsub_domain_event(input)? else {
        return Ok(None);
    };
    ingest_normalized_domain_event(journal, "twitch", event)
        .await
        .map(Some)
}

pub async fn ingest_polar_domain_event(
    journal: &DomainEventJournal,
    input: &polar::NormalizePolarWebhookInput,
) -> Result<NativeJournalResult, JournalError> {
    ingest_normalized_domain_event(
        journal,
        "polar",
        polar::normalize_polar_domain_event(input)?,
    )
    .await
}
