//! Durable, idempotent MongoDB journal using the existing collections/indexes.
//! A duplicate receipt returns the original native envelope; Redis failure
//! cannot change acknowledgement, durability, ownership or persisted content.

use super::{
    NormalizedDomainEvent,
    telemetry::{JournalTelemetry, telemetry_context},
    validate_normalized_event,
    wakeups::DomainEventWakeups,
};
use crate::{
    domain_event_contracts::{
        DomainEventContractError, DomainEventTopic, retention_seconds,
        time::{parse_contract_time, valid_native_millis},
    },
    utils::{
        bson_compat::js_number,
        domain_events::{build_domain_event_key, project_envelope_bson},
    },
};
use mongodb::{
    Collection, Database, IndexModel,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::ErrorKind,
    options::{Acknowledgment, CollectionOptions, IndexOptions, WriteConcern},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::OnceCell;

#[derive(Debug)]
pub enum JournalError {
    Contract(DomainEventContractError),
    Mongo(mongodb::error::Error),
    Invalid(&'static str),
}
impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(e) => e.fmt(f),
            Self::Mongo(_) => f.write_str("Domain event journal storage operation failed"),
            Self::Invalid(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for JournalError {}
impl From<DomainEventContractError> for JournalError {
    fn from(e: DomainEventContractError) -> Self {
        Self::Contract(e)
    }
}
impl From<mongodb::error::Error> for JournalError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Mongo(e)
    }
}

#[derive(Clone, Default)]
pub struct JournalConfig {
    pub wakeups: Option<Arc<DomainEventWakeups>>,
    pub telemetry: Option<JournalTelemetry>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct NativeJournalResult {
    pub event: Document,
    pub inserted: bool,
}
#[derive(Clone)]
pub struct DomainEventJournal {
    database: Database,
    events: Collection<Document>,
    initialized: Arc<OnceCell<()>>,
    config: JournalConfig,
}
impl DomainEventJournal {
    pub fn new(database: Database, config: JournalConfig) -> Self {
        let options = CollectionOptions::builder()
            .write_concern(
                WriteConcern::builder()
                    .w(Acknowledgment::Nodes(1))
                    .journal(true)
                    .build(),
            )
            .build();
        let events = database.collection_with_options("domain_events", options);
        Self {
            database,
            events,
            initialized: Arc::new(OnceCell::new()),
            config,
        }
    }
    pub fn database(&self) -> &Database {
        &self.database
    }
    pub fn collection(&self) -> &Collection<Document> {
        &self.events
    }
    /// Retryable initialization: a failure does not poison this instance. The
    /// exact Mongoose index shapes are preserved, including unique receipt and
    /// provider triplet fences, dispatch partial index and expiry TTL.
    pub async fn initialize(&self) -> Result<(), JournalError> {
        self.initialized
            .get_or_try_init(|| async {
                self.events.create_indexes(journal_indexes()).await?;
                Ok::<(), mongodb::error::Error>(())
            })
            .await?;
        Ok(())
    }
    pub async fn journal(
        &self,
        event: &NormalizedDomainEvent,
    ) -> Result<NativeJournalResult, JournalError> {
        self.journal_at(event, DateTime::now()).await
    }
    pub async fn journal_at(
        &self,
        event: &NormalizedDomainEvent,
        now: DateTime,
    ) -> Result<NativeJournalResult, JournalError> {
        // Validation and document preparation precede the first I/O. Contract
        // failures never create indexes, resolve users or enqueue hints.
        let document = prepare_journal_document(event, now)?;
        let key = document
            .get_str("eventKey")
            .map_err(|_| JournalError::Invalid("Domain event key is missing"))?
            .to_owned();
        self.initialize().await?;
        let (inserted, stored) = match self.events.insert_one(&document).await {
            Ok(_) => (true, document),
            Err(error) if duplicate_key(&error) => {
                // Unique index rejection waits for the winning insert. Read
                // after that fence rather than overwriting its original row.
                let Some(original) = self.events.find_one(doc! {"eventKey":&key}).await? else {
                    return Err(JournalError::Mongo(error));
                };
                (false, original)
            }
            Err(error) => return Err(error.into()),
        };
        let envelope = project_envelope_bson(&stored);
        if inserted
            && matches!(
                envelope.get_str("type").ok(),
                Some("stream.started" | "stream.ended")
            )
            && let Some(telemetry) = &self.config.telemetry
        {
            telemetry.observe_lifecycle(
                envelope.get_str("type").unwrap_or(""),
                envelope.get_str("channelID").ok(),
                DateTime::now().timestamp_millis(),
            );
        }
        if let Some(wakeups) = &self.config.wakeups {
            wakeups.publish();
        }
        Ok(NativeJournalResult {
            event: envelope,
            inserted,
        })
    }
}

pub fn journal_indexes() -> Vec<IndexModel> {
    let regular = [
        doc! {"type":1},
        doc! {"topic":1},
        doc! {"ownerUserId":1},
        doc! {"channelID":1},
        doc! {"topic":1,"_id":1},
        doc! {"topic":1,"source":1,"_id":1},
        doc! {"channelID":1,"source":1,"type":1,"occurredAt":1,"_id":1},
    ];
    let mut indexes: Vec<_> = regular
        .into_iter()
        .map(|keys| IndexModel::builder().keys(keys).build())
        .collect();
    for keys in [
        doc! {"eventKey":1},
        doc! {"source":1,"sourceEventId":1,"type":1},
    ] {
        indexes.push(
            IndexModel::builder()
                .keys(keys)
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        );
    }
    indexes.push(
        IndexModel::builder()
            .keys(doc! {"dispatchPending":1,"_id":1})
            .options(
                IndexOptions::builder()
                    .partial_filter_expression(doc! {"dispatchPending":true})
                    .build(),
            )
            .build(),
    );
    indexes.push(
        IndexModel::builder()
            .keys(doc! {"topic":1,"metadata.durableChatHandled":1,"_id":1})
            .options(
                IndexOptions::builder()
                    .partial_filter_expression(doc! {"metadata.durableChatHandled":true})
                    .build(),
            )
            .build(),
    );
    indexes.push(
        IndexModel::builder()
            .keys(doc! {"expiresAt":1})
            .options(IndexOptions::builder().expire_after(Duration::ZERO).build())
            .build(),
    );
    indexes
}

fn duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(mongodb::error::WriteFailure::WriteError(e)) => e.code == 11000,
        ErrorKind::Command(e) => e.code == 11000,
        _ => false,
    }
}

pub fn prepare_journal_document(
    event: &NormalizedDomainEvent,
    now: DateTime,
) -> Result<Document, JournalError> {
    validate_normalized_event(event)?;
    if !valid_native_millis(now.timestamp_millis()) {
        return Err(JournalError::Invalid(
            "Domain event journaledAt must be a valid date",
        ));
    };
    let input = &event.input;
    let source = input["source"]
        .as_str()
        .ok_or(JournalError::Invalid("Domain event source is required"))?;
    let source_id = input["sourceEventId"]
        .as_str()
        .ok_or(JournalError::Invalid(
            "Domain event sourceEventId is required",
        ))?;
    let event_type = input["type"]
        .as_str()
        .ok_or(JournalError::Invalid("Domain event type is required"))?;
    let topic = DomainEventTopic::parse(input["topic"].as_str().unwrap_or(""))
        .ok_or(JournalError::Invalid("Domain event topic is invalid"))?;
    let occurred = if let Some(occurred) = event.native_occurred_at {
        occurred
    } else if let Some(occurred) = input.get("occurredAt") {
        DateTime::from_millis(occurred.as_str().and_then(parse_contract_time).ok_or(
            JournalError::Invalid("Domain event occurredAt must be a valid date"),
        )?)
    } else {
        now
    };
    let requested = input
        .get("retentionSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(retention_seconds(topic) as f64)
        .max(60.0);
    let expiry = now.timestamp_millis() as f64 + requested * 1000.;
    if !expiry.is_finite() || expiry.abs() > 8_640_000_000_000_000. {
        return Err(JournalError::Invalid(
            "Domain event expiresAt must be a valid date",
        ));
    };
    let key = build_domain_event_key(source, source_id, event_type)
        .map_err(|_| JournalError::Invalid("Domain event key component is required"))?;
    let mut metadata = input
        .get("metadata")
        .map(json_document)
        .transpose()?
        .unwrap_or_default();
    if let Some(context) = telemetry_context() {
        metadata.insert(
            "observability",
            json_bson(&serde_json::to_value(context).map_err(|_| {
                JournalError::Invalid("Domain event telemetry context is invalid")
            })?)?,
        );
    }
    let mut document = doc! {"_id":ObjectId::new(),"eventKey":key,"source":source,"sourceEventId":source_id,"type":event_type,"topic":topic.as_str(),
    "schemaVersion":js_number(input.get("schemaVersion").and_then(Value::as_f64).unwrap_or(1.).floor().max(1.)),
    "occurredAt":occurred,"journaledAt":now,"payload":json_document(&input["payload"])? ,"metadata":metadata,"dispatchPending":true,
    "expiresAt":DateTime::from_millis(expiry.trunc()as i64)};
    for field in ["ownerUserId", "channelID", "streamID"] {
        if let Some(value) = input.get(field).and_then(Value::as_str) {
            let value = crate::utils::js_compat::trim(value);
            if !value.is_empty() {
                document.insert(field, value);
            }
        }
    }
    if let Some(subject) = input.get("subject") {
        let mut identity = Document::new();
        for field in ["provider", "kind", "id"] {
            identity.insert(
                field,
                subject
                    .get(field)
                    .and_then(Value::as_str)
                    .ok_or(JournalError::Invalid("Domain event subject is invalid"))?,
            );
        }
        document.insert("subject", identity);
    }
    Ok(document)
}

fn json_document(value: &Value) -> Result<Document, JournalError> {
    let fields = value.as_object().ok_or(JournalError::Invalid(
        "Domain event JSON field must be an object",
    ))?;
    fields
        .iter()
        .map(|(key, value)| Ok((key.clone(), json_bson(value)?)))
        .collect()
}
fn json_bson(value: &Value) -> Result<Bson, JournalError> {
    Ok(match value {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::String(s) => Bson::String(s.clone()),
        Value::Number(n) => js_number(
            n.as_f64()
                .ok_or(JournalError::Invalid("Domain event JSON number is invalid"))?,
        ),
        Value::Array(items) => Bson::Array(items.iter().map(json_bson).collect::<Result<_, _>>()?),
        Value::Object(_) => Bson::Document(json_document(value)?),
    })
}
