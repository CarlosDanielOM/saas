//! Twitch EventSub notifications to journal events (`domain_events/twitch_eventsub_events.ts`).
//!
//! The ingress (`bot/eventsub.twitch.ts`) verifies the signature and the timestamp, then calls
//! [`normalize`] and, when it gives an event, [`super::Ingest::twitch`]. What the reference
//! answers Twitch:
//!
//! | outcome | answer |
//! |---|---|
//! | [`normalize`] fails ([`ContractError`]) | 400 |
//! | not journaled type (`Ok(None)`) | 204 after the in-memory message claim (not this crate) |
//! | journaled, `inserted: false` (already recorded) | 204, the inline handlers do **not** run again |
//! | journaled, `inserted: true` | 204, then the inline handlers run |
//! | the ingest fails (contract, validation, store) | 503: Twitch delivers it again |

use crate::contracts::{
    ContractError, JournalInput, OccurredAt, SHORT_RETENTION_PREFIXES,
    SHORT_TWITCH_RETENTION_SECONDS, SubjectInput, SubjectKind, Topic, sources, twitch_type,
};
use crate::value::{Object, Value};
use dima_text::trim;

/// `NormalizeTwitchEventsubInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct TwitchNotification {
    /// `Twitch-Eventsub-Message-Id`.
    pub message_id: String,
    /// `Twitch-Eventsub-Message-Timestamp`.
    pub message_timestamp: Option<String>,
    /// `Twitch-Eventsub-Message-Retry` as a number (`parseInt(…) || 0` at the ingress).
    pub message_retry: Option<f64>,
    /// The ingress accepted an old timestamp because it is a retry.
    pub stale_retry: Option<bool>,
    /// `subscription`, as Twitch sent it.
    pub subscription: Object,
    /// `event`, as Twitch sent it.
    pub event: Value,
    /// `twitch-eventsub` (default) or `twitch-eventsub-test`.
    pub source: Option<String>,
    /// The ingress hands chat effects to the durable consumer.
    pub durable_chat_handled: bool,
    /// The ingress hands follow-defense effects to the durable consumer.
    pub durable_defense_handled: bool,
}

/// `firstString(...values)`: the first value whose `String(value || '').trim()` is not empty.
fn first_string(values: &[&Value]) -> String {
    for value in values {
        let normalized = value.or_empty_string();
        let normalized = trim(&normalized);
        if !normalized.is_empty() {
            return normalized.to_owned();
        }
    }
    String::new()
}

/// `isForeignSharedChatEvent(type, event)` (`utils/shared_chat_origin.ts`): a chat message or
/// notice copied from another channel of a shared chat session.
pub fn is_foreign_shared_chat_event(kind: &str, event: &Value) -> bool {
    matches!(kind, "channel.chat.message" | "channel.chat.notification")
        && matches!(event.at("source_broadcaster_user_id"), Value::String(source)
            if !source.is_empty() && Some(source.as_str()) != event.at("broadcaster_user_id").as_str())
}

/// `isDurableTwitchEventsubType(type)`.
pub fn is_durable_type(kind: &str) -> bool {
    twitch_type(trim(kind)).is_some()
}

/// `normalizeTwitchEventsubDomainEvent(input)`: the event to journal, `None` for a type that is
/// not journaled (and for a shared-chat copy from another channel).
pub fn normalize(input: &TwitchNotification) -> Result<Option<JournalInput>, ContractError> {
    let raw_type = input.subscription.at("type");
    if !matches!(raw_type, Value::String(text) if !trim(text).is_empty()) {
        return Err(ContractError::new("Twitch subscription.type is required"));
    }
    let original = first_string(&[raw_type]);
    let Some(normalized_type) = twitch_type(&original) else {
        return Ok(None);
    };
    if trim(&input.message_id).is_empty() {
        return Err(ContractError::new("Twitch messageId is required"));
    }
    if let Some(source) = &input.source
        && source != sources::TWITCH
        && source != sources::TWITCH_TEST
    {
        return Err(ContractError::new("Invalid Twitch producer source"));
    }
    if !matches!(
        input.event,
        Value::Object(_) | Value::Date(_) | Value::ObjectId(_) | Value::Other
    ) {
        return Err(ContractError::new("Twitch event must be a record"));
    }
    let event = &input.event;
    if is_foreign_shared_chat_event(&original, event) {
        return Ok(None);
    }
    let raid = original == "channel.raid";
    let outgoing = raid
        && crate::contracts::validate_outgoing_raid(input.subscription.at("condition"));
    let channel_value = if raid {
        if outgoing {
            event.at("from_broadcaster_user_id")
        } else {
            event.at("to_broadcaster_user_id")
        }
    } else {
        event.at("broadcaster_user_id")
    };
    let channel_id = first_string(&[channel_value]);
    if channel_id.is_empty() {
        return Err(ContractError(format!(
            "Durable Twitch event {original} is missing a channel ID"
        )));
    }
    let stream_id = (original == "stream.online").then(|| first_string(&[event.at("id")]));
    let source = input
        .source
        .clone()
        .filter(|source| !source.is_empty())
        .unwrap_or_else(|| sources::TWITCH.to_owned());
    let message_timestamp = input
        .message_timestamp
        .as_deref()
        .map_or(Value::Undefined, Value::from);
    let occurred_at = match original.as_str() {
        "channel.follow" => first_string(&[event.at("followed_at"), &message_timestamp]),
        "stream.online" => first_string(&[event.at("started_at"), &message_timestamp]),
        _ => first_string(&[&message_timestamp]),
    };
    let mut payload = Object::new();
    payload.insert("subscription", Value::Object(input.subscription.clone()));
    payload.insert("event", event.clone());
    let mut metadata = Object::new();
    if input.durable_chat_handled {
        metadata.insert("durableChatHandled", Value::Bool(true));
    }
    if input.durable_defense_handled
        && source == sources::TWITCH
        && (original == "channel.follow" || (raid && !outgoing))
    {
        metadata.insert("durableDefenseHandled", Value::Bool(true));
    }
    metadata.insert("originalEventType", Value::from(original.as_str()));
    metadata.insert(
        "subscriptionID",
        Value::from(first_string(&[input.subscription.at("id")])),
    );
    metadata.insert(
        "subscriptionVersion",
        Value::from(first_string(&[input.subscription.at("version")])),
    );
    metadata.insert(
        "messageTimestamp",
        Value::from(first_string(&[&message_timestamp])),
    );
    metadata.insert(
        "messageRetry",
        Value::Number(input.message_retry.unwrap_or(0.0)),
    );
    metadata.insert(
        "staleRetry",
        Value::Bool(input.stale_retry.unwrap_or(false)),
    );
    let short = SHORT_RETENTION_PREFIXES
        .iter()
        .any(|prefix| original.starts_with(prefix));
    Ok(Some(JournalInput {
        source,
        source_event_id: first_string(&[&Value::from(input.message_id.as_str())]),
        kind: if outgoing {
            "channel.raid.sent".to_owned()
        } else {
            normalized_type.to_owned()
        },
        topic: Topic::Channel,
        schema_version: Some(1.0),
        owner_user_id: None,
        subject: Some(SubjectInput::new(
            "twitch",
            SubjectKind::StreamingAccount,
            channel_id.as_str(),
        )),
        channel_id: Some(channel_id),
        stream_id,
        occurred_at: (!occurred_at.is_empty()).then_some(OccurredAt::Text(occurred_at)),
        payload,
        metadata: Some(metadata),
        retention_seconds: short.then_some(SHORT_TWITCH_RETENTION_SECONDS),
    }))
}
