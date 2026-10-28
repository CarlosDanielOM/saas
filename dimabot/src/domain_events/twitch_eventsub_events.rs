//! Native Twitch EventSub normalization; authenticated transport remains the
//! caller's boundary. Normalization alone does not perform account lookups.

use super::NormalizedDomainEvent;
use crate::{
    domain_event_contracts::{DomainEventContractError, twitch_domain_event_type},
    utils::{
        chat_message::is_foreign_shared_chat_event,
        eventsub::{Condition, RaidDirection, raid_direction},
        js_compat::trim,
    },
};
use serde_json::{Value, json};

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            crate::utils::json_number::number_string(n.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn first_string(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .flatten()
        .find_map(|value| {
            let value = if truthy(value) {
                string(value)
            } else {
                String::new()
            };
            let value = trim(&value);
            (!value.is_empty()).then(|| value.to_owned())
        })
        .unwrap_or_default()
}

pub fn is_durable_twitch_eventsub_type(event_type: &str) -> bool {
    twitch_domain_event_type(trim(event_type)).is_some()
}

pub fn normalize_twitch_eventsub_domain_event(
    input: &Value,
) -> Result<Option<NormalizedDomainEvent>, DomainEventContractError> {
    let subscription = input.get("subscription");
    let original = subscription
        .and_then(|s| s.get("type"))
        .and_then(Value::as_str)
        .filter(|s| !trim(s).is_empty())
        .ok_or_else(|| DomainEventContractError::new("Twitch subscription.type is required"))?;
    let original = trim(original);
    let Some(normalized) = twitch_domain_event_type(original) else {
        return Ok(None);
    };
    let message_id = input
        .get("messageId")
        .and_then(Value::as_str)
        .filter(|s| !trim(s).is_empty())
        .ok_or_else(|| DomainEventContractError::new("Twitch messageId is required"))?;
    if let Some(source) = input.get("source")
        && !source
            .as_str()
            .is_some_and(|s| ["twitch-eventsub", "twitch-eventsub-test"].contains(&s))
    {
        return Err(DomainEventContractError::new(
            "Invalid Twitch producer source",
        ));
    }
    let event = input
        .get("event")
        .filter(|event| event.is_object())
        .ok_or_else(|| DomainEventContractError::new("Twitch event must be a record"))?;
    if is_foreign_shared_chat_event(original, event, None) {
        return Ok(None);
    };
    let mut condition = Condition::default();
    for field in ["from_broadcaster_user_id", "to_broadcaster_user_id"] {
        if subscription
            .and_then(|s| s.get("condition"))
            .and_then(|c| c.get(field))
            .is_some_and(truthy)
        {
            condition.insert(field, "present");
        }
    }
    let outgoing =
        original == "channel.raid" && raid_direction(&condition) == RaidDirection::Outgoing;
    let channel = first_string(&[event.get(if original == "channel.raid" {
        if outgoing {
            "from_broadcaster_user_id"
        } else {
            "to_broadcaster_user_id"
        }
    } else {
        "broadcaster_user_id"
    })]);
    if channel.is_empty() {
        return Err(DomainEventContractError::new(format!(
            "Durable Twitch event {original} is missing a channel ID"
        )));
    };
    let source = input
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("twitch-eventsub");
    let mut metadata = json!({"originalEventType":original,"subscriptionID":first_string(&[subscription.and_then(|s|s.get("id"))]),
        "subscriptionVersion":first_string(&[subscription.and_then(|s|s.get("version"))]),"messageTimestamp":first_string(&[input.get("messageTimestamp")]),
        "messageRetry":input.get("messageRetry").filter(|v|!v.is_null()).cloned().unwrap_or(json!(0)),
        "staleRetry":input.get("staleRetry").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false))});
    if input.get("durableChatHandled").is_some_and(truthy) {
        metadata["durableChatHandled"] = json!(true)
    };
    if input.get("durableDefenseHandled").is_some_and(truthy)
        && source == "twitch-eventsub"
        && (original == "channel.follow" || original == "channel.raid" && !outgoing)
    {
        metadata["durableDefenseHandled"] = json!(true)
    };
    let occurred = first_string(&[
        if original == "channel.follow" {
            event.get("followed_at")
        } else if original == "stream.online" {
            event.get("started_at")
        } else {
            None
        },
        input.get("messageTimestamp"),
    ]);
    let mut output = json!({"source":source,"sourceEventId":trim(message_id),"type":if outgoing{"channel.raid.sent"}else{normalized},"topic":"channel","schemaVersion":1,
        "subject":{"provider":"twitch","kind":"streaming-account","id":channel},"channelID":channel,
        "payload":{"subscription":subscription.expect("type was present"),"event":event},"metadata":metadata});
    if original.starts_with("channel.poll.") || original.starts_with("channel.prediction.") {
        output["retentionSeconds"] = json!(86400)
    };
    if original == "stream.online" {
        output["streamID"] = json!(first_string(&[event.get("id")]))
    };
    if !occurred.is_empty() {
        output["occurredAt"] = json!(occurred)
    };
    Ok(Some(NormalizedDomainEvent {
        input: output,
        native_occurred_at: None,
    }))
}
