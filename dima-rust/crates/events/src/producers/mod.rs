//! Producers: outside notifications to events, and the journal append.
//!
//! References: `domain_events/domain_event_producers.ts` (`ingestDomainEvent`),
//! `utils/domain_events.ts` (`journalDomainEvent`), and the three mappers ([`twitch`],
//! [`polar`], [`goals`]).
//!
//! # Exactly once
//!
//! The append is **one** write: an `insertOne` of the whole event with `{w: 1, j: true}` and
//! `dispatchPending: true`. The unique index on `eventKey` (a function of source, the provider's
//! id and the type, [`crate::identity::event_key`]) decides which of several deliveries of the
//! same notification is the one: the first insert wins, every other one gets a duplicate key and
//! reads the stored event back (`inserted: false`). There is nothing to roll back: a process that
//! dies before the insert has written nothing, one that dies after it has written the whole event,
//! and the provider's redelivery then finds it. The deliveries are created afterwards by the
//! dispatcher ([`crate::dispatch`]) from the `dispatchPending` marker, which it clears only once
//! every delivery exists. The wakeup ([`crate::wakeups`]) is a hint published after the write; the
//! dispatcher's one-second sweep finds the event without it.
//!
//! Index readiness: the reference awaits `DomainEventSchema.init()` before every insert, so a
//! duplicate key can be trusted. [`Journal::new`] takes the startup [`IndexReport`] of
//! `domain_events` and refuses to build a journal whose unique indexes are not there.

pub mod goals;
pub mod polar;
pub mod twitch;

use crate::contracts::{Check, ContractError, JournalInput, OccurredAt, Topic, retention_seconds};
use crate::envelope::{Envelope, EnvelopeError};
use crate::identity::{event_key, is_user_id, resolve_owner};
use crate::store::{StoreError, bounded, bounded_write, duplicate_key};
use crate::value::{Object, Value};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::Clock;
use dima_model::domain_events::{COLLECTION, INFO, journal_write_concern};
use dima_model::index::RequiredIndexError;
use dima_model::{IndexReport, ModelError, StrEnum};
use dima_store::mongo::{MongoStore, WriteContext};
use dima_text::trim;
use std::sync::Arc;
use std::time::Duration;

/// The trace context the reference adds to `metadata.observability` (`telemetryContext()`):
/// `{traceId, spanId, sampled, channel}` and `outcome` once one is set. The caller takes it from
/// its telemetry context; `None` when there is none (the key is then left out).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observability {
    /// 32 lower-case hex digits.
    pub trace_id: String,
    /// 16 lower-case hex digits.
    pub span_id: String,
    /// Whether the trace is sampled.
    pub sampled: bool,
    /// The bound channel (`""` when none).
    pub channel: String,
    /// The outcome, when one was set.
    pub outcome: Option<String>,
}

impl Observability {
    fn to_object(&self) -> Object {
        let mut object = Object::new();
        object.insert("traceId", Value::from(self.trace_id.as_str()));
        object.insert("spanId", Value::from(self.span_id.as_str()));
        object.insert("sampled", Value::Bool(self.sampled));
        object.insert("channel", Value::from(self.channel.as_str()));
        if let Some(outcome) = &self.outcome {
            object.insert("outcome", Value::from(outcome.as_str()));
        }
        object
    }
}

/// Tells consumers there is work ([`crate::wakeups::Publisher`]); a hint, never awaited.
pub trait WakeHint: Send + Sync + std::fmt::Debug {
    /// Publishes a hint (coalesced, dropped on failure).
    fn publish(&self);
}

/// The result of an append (`JournalDomainEventResult`).
#[derive(Clone, Debug, PartialEq)]
pub struct Journaled {
    /// The event as stored (the one inserted, or the one already there).
    pub event: Envelope,
    /// `false` when the event was already journaled: the notification is a duplicate.
    pub inserted: bool,
}

impl Journaled {
    /// The lifecycle metric the reference observes for a newly journaled stream start or end
    /// (`observe('lifecycle', type, 0, 'ok', channelID)`); the caller's telemetry records it.
    pub fn lifecycle_metric(&self) -> Option<&str> {
        (self.inserted && matches!(self.event.kind.as_str(), "stream.started" | "stream.ended"))
            .then_some(self.event.kind.as_str())
    }
}

/// Why an event was not journaled.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    /// The event breaks its contract (permanent: the same input fails the same way).
    #[error(transparent)]
    Contract(#[from] ContractError),
    /// The reference's own input errors (`Domain event … is required`...), permanent.
    #[error("{0}")]
    Invalid(String),
    /// The model's validation refused the document (permanent).
    #[error(transparent)]
    Refused(ModelError),
    /// MongoDB failed or timed out: nothing is known to be journaled; answer so that the
    /// provider delivers again (503 to Twitch, 500 to Polar).
    #[error(transparent)]
    Store(#[from] StoreError),
    /// A stored event with the same key could not be read as an event.
    #[error(transparent)]
    Stored(#[from] EnvelopeError),
}

impl IngestError {
    /// `true` for errors the same input will hit again.
    pub fn is_permanent(&self) -> bool {
        matches!(
            self,
            Self::Contract(_) | Self::Invalid(_) | Self::Refused(_) | Self::Stored(_)
        )
    }
}

/// Where the owner of an event comes from.
#[derive(Clone, Debug)]
pub enum Owners {
    /// `resolveDomainEventOwner` against `users` (production).
    Lookup,
    /// A fixed answer (the reference's `dependencies.resolveOwner`, for tests).
    Fixed(Option<String>),
}

/// The journal: appends events to `domain_events`.
#[derive(Clone, Debug)]
pub struct Journal {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    deadline: Duration,
    owners: Owners,
    wakeups: Option<Arc<dyn WakeHint>>,
}

impl Journal {
    /// A journal on `store`, writable once the unique indexes of `domain_events` exist
    /// (`indexes` is the startup report of [`dima_model::ensure_indexes`] for it).
    pub fn new(
        store: MongoStore,
        clock: Arc<dyn Clock>,
        config: &crate::config::EventsConfig,
        indexes: &IndexReport,
    ) -> Result<Self, RequiredIndexError> {
        if indexes.collection != COLLECTION {
            return Err(RequiredIndexError {
                collection: COLLECTION,
                missing: vec![format!("no index report (got {})", indexes.collection)],
            });
        }
        indexes.require()?;
        Ok(Self {
            store,
            clock,
            deadline: config.store_deadline,
            owners: Owners::Lookup,
            wakeups: None,
        })
    }

    /// Publishes a wakeup after every append.
    pub fn with_wakeups(mut self, wakeups: Arc<dyn WakeHint>) -> Self {
        self.wakeups = Some(wakeups);
        self
    }

    /// Replaces the owner lookup.
    pub fn with_owners(mut self, owners: Owners) -> Self {
        self.owners = owners;
        self
    }

    /// The store.
    pub fn store(&self) -> &MongoStore {
        &self.store
    }

    /// The clock.
    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    /// The bound on each store call.
    pub fn deadline(&self) -> Duration {
        self.deadline
    }

    /// `ingestDomainEvent(twitchEventsubProducer, notification)`: `None` when the type is not
    /// journaled. [`twitch::normalize`] errors are the caller's 400; everything after it 503.
    pub async fn ingest_twitch(
        &self,
        notification: &twitch::TwitchNotification,
        observability: Option<&Observability>,
    ) -> Result<Option<Journaled>, IngestError> {
        let Some(mut event) = twitch::normalize(notification)? else {
            return Ok(None);
        };
        self.check_producer("twitch", &event)?;
        event.validate(Check::ingest(self.clock.now_ms()))?;
        if let Some(subject) = event.subject.clone() {
            let owner = self
                .owner(&subject.provider, &subject.kind, &subject.id, None, None)
                .await?;
            if owner.is_some() {
                event.owner_user_id = owner;
            }
        }
        self.append(&event, observability).await.map(Some)
    }

    /// `ingestDomainEvent(polarWebhookProducer, webhook)`.
    pub async fn ingest_polar(
        &self,
        webhook: &polar::PolarWebhook,
        observability: Option<&Observability>,
    ) -> Result<Journaled, IngestError> {
        let mut event = polar::normalize(webhook, self.clock.now_ms())?;
        self.check_producer("polar", &event)?;
        event.validate(Check::ingest(self.clock.now_ms()))?;
        if let (Some(subject), Some((external, legacy))) =
            (event.subject.clone(), polar::owner_hints(&event))
        {
            let owner = self
                .owner(
                    &subject.provider,
                    &subject.kind,
                    &subject.id,
                    external.as_deref(),
                    legacy.as_deref(),
                )
                .await?;
            if owner.is_some() {
                event.owner_user_id = owner;
            }
        }
        self.append(&event, observability).await
    }

    /// `ingestCustomGoalContribution(input)`: the goals service's receipt check, then the
    /// journal; a stored event with another channel, item or quantity is a conflict.
    pub async fn ingest_goal<C: goals::ReceiptCheck>(
        &self,
        contribution: &goals::CustomGoalContribution,
        check: &C,
        observability: Option<&Observability>,
    ) -> Result<Journaled, goals::GoalIngestError> {
        let event = goals::normalize(contribution)?;
        let key = event_key(&event.source, &event.source_event_id, &event.kind)
            .map_err(|error| IngestError::Invalid(error.to_string()))?;
        check
            .check(&contribution.channel_id, &key, &contribution.item_key, contribution.quantity)
            .await?;
        self.check_producer("goals-custom", &event)?;
        event.validate(Check::ingest(self.clock.now_ms()))?;
        let result = self.append(&event, observability).await?;
        let stored = &result.event;
        if stored.channel_id.as_deref() != Some(contribution.channel_id.as_str())
            || stored.payload.at("itemKey").as_str() != Some(contribution.item_key.as_str())
            || stored.payload.at("quantity").as_number() != Some(contribution.quantity)
        {
            return Err(goals::GoalError::Conflict(
                "Custom goal receipt conflicts with an existing contribution".into(),
            )
            .into());
        }
        Ok(result)
    }

    fn check_producer(&self, provider: &str, event: &JournalInput) -> Result<(), IngestError> {
        if event.subject.as_ref().is_none_or(|s| s.provider != provider) {
            return Err(ContractError(format!(
                "Producer {provider} must supply its own provider subject"
            ))
            .into());
        }
        Ok(())
    }

    async fn owner(
        &self,
        provider: &str,
        kind: &str,
        id: &str,
        external: Option<&str>,
        legacy: Option<&str>,
    ) -> Result<Option<String>, IngestError> {
        match &self.owners {
            Owners::Fixed(owner) => Ok(owner.clone()),
            Owners::Lookup => Ok(resolve_owner(
                &self.store,
                self.deadline,
                provider,
                kind,
                id,
                external,
                legacy,
            )
            .await?),
        }
    }

    /// `journalDomainEvent(input)`: validates, writes the event once, publishes a wakeup.
    pub async fn append(
        &self,
        input: &JournalInput,
        observability: Option<&Observability>,
    ) -> Result<Journaled, IngestError> {
        let prepared = self.prepare(input, observability)?;
        let key = prepared.event_key.clone();
        let mut writes = self
            .store
            .writes(COLLECTION)
            .write_concern(journal_write_concern());
        let insert = bounded_write("journal the event", self.deadline, writes.insert_one(&prepared.insert)).await;
        let (document, inserted) = match insert {
            Ok(()) => (prepared.insert.document, true),
            Err(error) if duplicate_key(&error).is_some() => {
                let found = bounded(
                    "read the journaled event",
                    self.deadline,
                    self.store
                        .documents(COLLECTION)
                        .find_one(doc! { "eventKey": key.as_str() }),
                )
                .await?;
                // A duplicate on another index (an `_id` collision) with no event of this key:
                // the reference rethrows the insert error.
                let Some(found) = found else {
                    return Err(error.into());
                };
                (found, false)
            }
            Err(error) => return Err(error.into()),
        };
        let event = Envelope::from_document(&document)?;
        if let Some(wakeups) = &self.wakeups {
            wakeups.publish();
        }
        Ok(Journaled { event, inserted })
    }

    /// The document `journalDomainEvent` inserts for `input` (validated), with its key.
    pub fn prepare(
        &self,
        input: &JournalInput,
        observability: Option<&Observability>,
    ) -> Result<PreparedEvent, IngestError> {
        let now = self.clock.now_ms();
        input.validate(Check::ingest(now))?;
        let required = |value: &str, field: &str| {
            let value = trim(value);
            if value.is_empty() {
                Err(IngestError::Invalid(format!("Domain event {field} is required")))
            } else {
                Ok(value.to_owned())
            }
        };
        let source = required(&input.source, "source")?;
        let source_event_id = required(&input.source_event_id, "sourceEventId")?;
        let kind = required(&input.kind, "type")?;
        let channel_id = if input.topic == Topic::Channel {
            Some(required(input.channel_id.as_deref().unwrap_or(""), "channelID")?)
        } else {
            input
                .channel_id
                .as_deref()
                .map(trim)
                .filter(|c| !c.is_empty())
                .map(str::to_owned)
        };
        let owner_user_id = input
            .owner_user_id
            .as_deref()
            .map(trim)
            .filter(|o| !o.is_empty())
            .map(str::to_owned);
        if let Some(owner) = &owner_user_id
            && !is_user_id(owner)
        {
            return Err(IngestError::Invalid(
                "Domain event ownerUserId must be an internal user ObjectId".into(),
            ));
        }
        let subject = match &input.subject {
            Some(subject) => {
                let provider = required(&subject.provider, "subject.provider")?;
                let id = required(&subject.id, "subject.id")?;
                if dima_model::domain_events::SubjectKind::parse(&subject.kind).is_none() {
                    return Err(IngestError::Invalid("Domain event subject.kind is invalid".into()));
                }
                Some(doc! { "provider": provider, "kind": subject.kind.as_str(), "id": id })
            }
            None => None,
        };
        if input.topic != Topic::Channel && subject.is_none() && owner_user_id.is_none() {
            return Err(IngestError::Invalid(
                "Domain event requires a subject or owner identity".into(),
            ));
        }
        let key = event_key(&source, &source_event_id, &kind)
            .map_err(|_| IngestError::Invalid("Domain event key component is required".into()))?;
        // `normalizeDate`: missing or empty means now.
        let occurred_at = match &input.occurred_at {
            None => now,
            Some(OccurredAt::Text(text)) if text.is_empty() => now,
            Some(OccurredAt::Text(text)) => dima_text::parse_date(text).ok_or_else(|| {
                IngestError::Invalid("Domain event occurredAt must be a valid date".into())
            })?,
            Some(OccurredAt::Date(ms)) if ms.is_finite() => ms.trunc() as i64,
            Some(OccurredAt::Date(_)) => {
                return Err(IngestError::Invalid(
                    "Domain event occurredAt must be a valid date".into(),
                ));
            }
        };
        let journaled_at = self.clock.now_ms();
        let retention = input
            .retention_seconds
            .unwrap_or_else(|| retention_seconds(input.topic));
        let version = input.schema_version.unwrap_or(1.0);
        if !retention.is_finite() || !version.is_finite() {
            return Err(IngestError::Invalid(
                "Domain event retentionSeconds and schemaVersion must be finite numbers".into(),
            ));
        }
        let retention = retention.max(60.0);
        // `new Date(journaledAt + retention * 1000)`: the time value is truncated.
        let expires_at = (journaled_at as f64 + retention * 1000.0).trunc() as i64;
        let stream_id = input
            .stream_id
            .as_deref()
            .map(trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let mut metadata = input.metadata.clone().unwrap_or_default();
        if let Some(observability) = observability {
            metadata.insert("observability", Value::Object(observability.to_object()));
        }
        let payload = input
            .payload
            .to_bson()
            .map_err(|error| IngestError::Invalid(error.to_string()))?;
        let metadata = metadata
            .to_bson()
            .map_err(|error| IngestError::Invalid(error.to_string()))?;

        let mut given = Document::new();
        given.insert("_id", ObjectId::new());
        given.insert("eventKey", key.as_str());
        given.insert("source", source);
        given.insert("sourceEventId", source_event_id);
        given.insert("type", kind);
        given.insert("topic", input.topic.as_str());
        given.insert("schemaVersion", Bson::Double(version.floor().max(1.0)));
        if let Some(owner) = owner_user_id {
            given.insert("ownerUserId", owner);
        }
        if let Some(subject) = subject {
            given.insert("subject", subject);
        }
        if let Some(channel) = channel_id {
            given.insert("channelID", channel);
        }
        if let Some(stream) = stream_id {
            given.insert("streamID", stream);
        }
        given.insert("occurredAt", bson::DateTime::from_millis(occurred_at));
        given.insert("journaledAt", bson::DateTime::from_millis(journaled_at));
        given.insert("payload", payload);
        given.insert("metadata", metadata);
        given.insert("dispatchPending", true);
        given.insert("expiresAt", bson::DateTime::from_millis(expires_at));
        let mut ctx = WriteContext::new(journaled_at);
        let insert = INFO
            .prepare_create(&given, &mut ctx)
            .map_err(IngestError::Refused)?;
        Ok(PreparedEvent {
            event_key: key,
            insert,
        })
    }
}

/// A validated event ready to insert.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedEvent {
    /// Its key.
    pub event_key: String,
    /// The insert (run it with the journal's write concern).
    pub insert: dima_store::mongo::insert::PreparedInsert,
}
