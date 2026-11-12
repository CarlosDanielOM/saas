//! Custom goal contributions (`goal.add` in the command language) to journal events
//! (`domain_events/goal_custom_events.ts`).
//!
//! What the reference's caller (`utils/ast_parser/functions/goals.functions.ts`) does with the
//! outcome: [`GoalIngestError::Invalid`], [`GoalIngestError::Conflict`] and a contract error are
//! permanent (`Error: goal_contribution_failed`); any other failure is retried when the command
//! runs from a configured Twitch event (`RequiredGoalContributionError`), and reported as
//! `goal_contribution_failed` otherwise.

use crate::contracts::{
    ContractError, JournalInput, OccurredAt, SubjectInput, SubjectKind, Topic, sources,
};
use crate::identity::goal_contribution_id;
use crate::value::{Object, Value};
use dima_text::utf16_len;

/// `CustomGoalContribution`.
#[derive(Clone, Debug, PartialEq)]
pub struct CustomGoalContribution {
    /// The channel (`/^\d{1,30}$/`).
    pub channel_id: String,
    /// Stable trusted origin and configuration path, or an explicit receipt and action scope
    /// (JSON text built by the caller).
    pub receipt_identity: String,
    /// The goal item (`/^[a-z0-9_]{1,48}$/`).
    pub item_key: String,
    /// How many (1 to 1,000,000,000).
    pub quantity: f64,
    /// When it happened: a `Date` in epoch milliseconds (`NaN` when invalid).
    pub occurred_at_ms: f64,
}

/// `GoalError` (`goals/model.ts`), as raised here.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum GoalError {
    /// `GoalError('invalid', 'Invalid custom goal contribution')`, status 400.
    #[error("Invalid custom goal contribution")]
    Invalid,
    /// `GoalError('conflict', …, 409)`: the receipt was used with another item or quantity.
    #[error("{0}")]
    Conflict(String),
}

/// `/^\d{1,30}$/`.
fn is_channel_id(text: &str) -> bool {
    (1..=30).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

/// `customGoalProducer.normalize(input)`.
pub fn normalize(input: &CustomGoalContribution) -> Result<JournalInput, GoalError> {
    let quantity = input.quantity;
    if !is_channel_id(&input.channel_id)
        || input.receipt_identity.is_empty()
        || utf16_len(&input.receipt_identity) > 1000
        || !crate::contracts::validate_goal_item_key(&input.item_key)
        || !crate::contracts::validate_is_safe_integer(quantity)
        || !(1.0..=1_000_000_000.0).contains(&quantity)
        || !input.occurred_at_ms.is_finite()
    {
        return Err(GoalError::Invalid);
    }
    let mut payload = Object::new();
    payload.insert("itemKey", Value::from(input.item_key.as_str()));
    payload.insert("quantity", Value::Number(quantity));
    Ok(JournalInput {
        source: sources::GOALS_CUSTOM.to_owned(),
        source_event_id: goal_contribution_id(&input.channel_id, &input.receipt_identity),
        kind: "goal.item.added".to_owned(),
        topic: Topic::Domain,
        schema_version: Some(1.0),
        owner_user_id: None,
        subject: Some(SubjectInput::new(
            sources::GOALS_CUSTOM,
            SubjectKind::StreamingAccount,
            input.channel_id.as_str(),
        )),
        channel_id: Some(input.channel_id.clone()),
        stream_id: None,
        occurred_at: Some(OccurredAt::Date(input.occurred_at_ms)),
        payload,
        metadata: Some(Object::new()),
        retention_seconds: None,
    })
}

/// A custom goal contribution that was not journaled.
#[derive(Debug, thiserror::Error)]
pub enum GoalIngestError {
    /// The contribution is invalid (permanent).
    #[error(transparent)]
    Goal(#[from] GoalError),
    /// The journal refused or failed (see [`super::IngestError`]).
    #[error(transparent)]
    Ingest(#[from] super::IngestError),
    /// The goals service's receipt check failed (its own error, kept as text).
    #[error("{0}")]
    Check(String),
}

impl From<ContractError> for GoalIngestError {
    fn from(error: ContractError) -> Self {
        Self::Ingest(super::IngestError::Contract(error))
    }
}

/// The goals service's admission check (`assertCustomGoalReceiptCompatible(channel, eventKey,
/// itemKey, quantity)`, `goals/service.ts`): fails when the receipt was already used with another
/// item or quantity. The goals package implements it.
pub trait ReceiptCheck {
    /// Checks the receipt before anything is journaled.
    fn check(
        &self,
        channel_id: &str,
        event_key: &str,
        item_key: &str,
        quantity: f64,
    ) -> impl std::future::Future<Output = Result<(), GoalIngestError>> + Send;
}
