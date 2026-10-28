//! Generic producer/dependency composition in addition to the concrete
//! Twitch/Polar registry. Optional adapters preserve test/integration hooks;
//! the default journal is the concrete durable MongoDB implementation.

use super::{
    DomainEventJournal, JournalError, NativeJournalResult, NormalizedDomainEvent,
    validate_normalized_event,
};
use crate::domain_event_contracts::DomainEventContractError;
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

pub type OwnerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<String>, JournalError>> + Send + 'a>>;
pub type JournalFuture<'a> =
    Pin<Box<dyn Future<Output = Result<NativeJournalResult, JournalError>> + Send + 'a>>;
pub type OwnerResolver = dyn for<'a> Fn(&'a NormalizedDomainEvent) -> OwnerFuture<'a> + Send + Sync;
pub type JournalWriter =
    dyn for<'a> Fn(&'a NormalizedDomainEvent) -> JournalFuture<'a> + Send + Sync;
pub struct NativeDomainEventProducer<Input> {
    pub provider: String,
    pub normalize: Arc<
        dyn Fn(Input) -> Result<Option<NormalizedDomainEvent>, DomainEventContractError>
            + Send
            + Sync,
    >,
    pub resolve_owner: Option<Arc<OwnerResolver>>,
}
#[derive(Default)]
pub struct IngestionDependencies<'a> {
    pub journal: Option<&'a JournalWriter>,
    pub resolve_owner: Option<&'a OwnerResolver>,
}

pub async fn ingest_custom_domain_event<Input>(
    journal: &DomainEventJournal,
    producer: &NativeDomainEventProducer<Input>,
    input: Input,
    dependencies: IngestionDependencies<'_>,
) -> Result<Option<NativeJournalResult>, JournalError> {
    let Some(mut event) = (producer.normalize)(input)? else {
        return Ok(None);
    };
    if event
        .input
        .get("subject")
        .and_then(|s| s.get("provider"))
        .and_then(Value::as_str)
        != Some(producer.provider.as_str())
    {
        return Err(DomainEventContractError::new(format!(
            "Producer {} must supply its own provider subject",
            producer.provider
        ))
        .into());
    }
    validate_normalized_event(&event)?;
    if let Some(resolver) = dependencies
        .resolve_owner
        .or(producer.resolve_owner.as_deref())
        && let Some(owner) = resolver(&event).await?
    {
        event.input["ownerUserId"] = Value::String(owner);
    }
    match dependencies.journal {
        Some(write) => write(&event).await.map(Some),
        None => journal.journal(&event).await.map(Some),
    }
}
