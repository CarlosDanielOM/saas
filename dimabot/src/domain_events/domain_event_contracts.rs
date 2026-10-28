//! Source- and identity-aware domain-event validation with a bounded JSON walk.

use super::{
    retention_seconds,
    time::{parse_contract_time, valid_native_millis},
};
use crate::utils::{
    domain_events::{DomainEventTopic, build_domain_event_key},
    js_compat,
};
use serde_json::{Map, Value};

pub const DOMAIN_EVENT_MAX_JSON_BYTES: usize = 256 * 1024;

pub const TWITCH_DOMAIN_EVENT_TYPES: [(&str, &str); 19] = [
    ("channel.poll.begin", "channel.poll.began"),
    ("channel.poll.progress", "channel.poll.updated"),
    ("channel.poll.end", "channel.poll.ended"),
    ("channel.prediction.begin", "channel.prediction.began"),
    ("channel.prediction.progress", "channel.prediction.updated"),
    ("channel.prediction.lock", "channel.prediction.locked"),
    ("channel.prediction.end", "channel.prediction.ended"),
    ("channel.bits.use", "channel.bits.received"),
    ("channel.cheer", "channel.bits.received"),
    ("channel.bit.use", "channel.bits.received"),
    ("channel.follow", "channel.follow.received"),
    ("channel.raid", "channel.raid.received"),
    ("channel.chat.notification", "channel.chat.notification"),
    ("channel.subscribe", "channel.subscription.received"),
    (
        "channel.subscription.message",
        "channel.subscription.received",
    ),
    ("channel.subscription.gift", "channel.subscription.gifted"),
    ("channel.subscription.end", "channel.subscription.ended"),
    ("stream.online", "stream.started"),
    ("stream.offline", "stream.ended"),
];

pub fn twitch_domain_event_type(original: &str) -> Option<&'static str> {
    TWITCH_DOMAIN_EVENT_TYPES
        .iter()
        .find_map(|(source, target)| (*source == original).then_some(*target))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainEventContractError {
    pub message: String,
}
impl DomainEventContractError {
    pub const PERMANENT: bool = true;
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
    pub fn permanent(&self) -> bool {
        Self::PERMANENT
    }
}
impl std::fmt::Display for DomainEventContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Domain event contract: {}", self.message)
    }
}
impl std::error::Error for DomainEventContractError {}
type Result<T> = std::result::Result<T, DomainEventContractError>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ContractMode {
    Ingest,
    #[default]
    Retained,
}

/// Native retained date/ObjectId identity. JSON cannot claim this legacy path
/// by passing an object with `_bsontype`, `$oid`, or `$date` keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeRetainedContract {
    pub object_id: [u8; 12],
    pub occurred_at_millis: i64,
    pub journaled_at_millis: i64,
    pub expires_at_millis: i64,
}

fn require(ok: bool, message: impl Into<String>) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(DomainEventContractError::new(message))
    }
}
fn record<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a Map<String, Value>> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| DomainEventContractError::new(format!("{field} must be a plain record")))
}
fn text<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && js_compat::trim(s) == *s)
        .ok_or_else(|| {
            DomainEventContractError::new(format!(
                "{field} is required and must be a nonblank string"
            ))
        })
}
fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
fn count(value: Option<&Value>, field: &str, minimum: u64) -> Result<()> {
    require(
        number(value).is_some_and(|n| is_safe_integer(n) && n >= minimum as f64),
        format!("{field} must be a safe integer >= {minimum}"),
    )
}
fn date(value: Option<&Value>, field: &str) -> Result<i64> {
    value
        .and_then(Value::as_str)
        .and_then(parse_contract_time)
        .ok_or_else(|| DomainEventContractError::new(format!("{field} must be a valid date")))
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// Validate JSON with no recursion beyond the source's depth limit. JSON values
/// cannot contain cycles, accessors, prototypes, holes, undefined or functions;
/// those JavaScript-only hazards are unrepresentable, not silently coerced.
pub fn check_domain_event_json(value: &Value) -> Result<()> {
    walk_json(value, 0, &mut 0)
}

fn json_string_bytes(value: &str) -> usize {
    2 + value
        .chars()
        .map(|ch| match ch {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            '\u{00}'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        })
        .sum::<usize>()
}

fn walk_json_fields(fields: &Map<String, Value>, depth: usize, bytes: &mut usize) -> Result<()> {
    require(depth <= 32, "JSON nesting exceeds 32 levels")?;
    *bytes += 2;
    for (key, item) in fields {
        require(
            !["__proto__", "prototype", "constructor"].contains(&key.as_str()),
            "JSON contains an unsafe property",
        )?;
        require(
            key.encode_utf16().count() <= DOMAIN_EVENT_MAX_JSON_BYTES,
            "JSON exceeds 256 KiB",
        )?;
        *bytes += json_string_bytes(key) + 2;
        walk_json(item, depth + 1, bytes)?;
    }
    require(
        *bytes <= DOMAIN_EVENT_MAX_JSON_BYTES,
        "JSON exceeds 256 KiB",
    )
}

fn walk_json(value: &Value, depth: usize, bytes: &mut usize) -> Result<()> {
    require(depth <= 32, "JSON nesting exceeds 32 levels")?;
    match value {
        Value::Null | Value::Bool(_) => *bytes += 5,
        Value::String(s) => {
            require(
                s.encode_utf16().count() <= DOMAIN_EVENT_MAX_JSON_BYTES,
                "JSON exceeds 256 KiB",
            )?;
            *bytes += json_string_bytes(s);
        }
        Value::Number(n) => {
            let n = n.as_f64().unwrap_or(f64::NAN);
            require(
                n.is_finite() && (n.fract() != 0.0 || is_safe_integer(n)),
                "JSON numbers must be finite and integers must be safe",
            )?;
            *bytes += crate::utils::json_number::number_string(n).len();
        }
        Value::Array(items) => {
            *bytes += 2;
            for item in items {
                *bytes += 1;
                walk_json(item, depth + 1, bytes)?;
            }
        }
        Value::Object(fields) => walk_json_fields(fields, depth, bytes)?,
    }
    require(
        *bytes <= DOMAIN_EVENT_MAX_JSON_BYTES,
        "JSON exceeds 256 KiB",
    )
}

/// Provider data already in native JSON. SDK-only Date/undefined conversion
/// uses `serialize_domain_event_sdk_data`; ordinary JSON is cloned only after
/// the entire bounded validation succeeds.
pub fn serialize_domain_event_provider_data(value: &Value) -> Result<Value> {
    record(Some(value), "providerData")?;
    check_domain_event_json(value)?;
    Ok(value.clone())
}

/// Native SDK values distinguish Date and omitted object properties without
/// importing a JavaScript runtime. Unsafe JS prototypes/accessors/functions
/// are intentionally not constructible in this enum.
#[derive(Debug, Clone, PartialEq)]
pub enum DomainEventSdkValue {
    Json(Value),
    Date(i64),
    Undefined,
    Array(Vec<DomainEventSdkValue>),
    Object(Vec<(String, DomainEventSdkValue)>),
}

pub fn serialize_domain_event_sdk_data(value: &DomainEventSdkValue) -> Result<Value> {
    fn convert(
        value: &DomainEventSdkValue,
        depth: usize,
        bytes: &mut usize,
        omit: bool,
    ) -> Result<Option<Value>> {
        require(depth <= 32, "JSON nesting exceeds 32 levels")?;
        let value = match value {
            DomainEventSdkValue::Json(value) => {
                walk_json(value, depth, bytes)?;
                value.clone()
            }
            DomainEventSdkValue::Date(timestamp) => {
                require(
                    valid_native_millis(*timestamp),
                    "SDK date must be a valid date",
                )?;
                *bytes += 26;
                Value::String(super::time::native_date_iso(*timestamp))
            }
            DomainEventSdkValue::Undefined if omit => return Ok(None),
            DomainEventSdkValue::Undefined => {
                return Err(DomainEventContractError::new(
                    "payload and metadata must be JSON-safe",
                ));
            }
            DomainEventSdkValue::Array(items) => {
                *bytes += 2;
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    *bytes += 1;
                    out.push(
                        convert(item, depth + 1, bytes, false)?
                            .expect("array values are not omitted"),
                    );
                }
                Value::Array(out)
            }
            DomainEventSdkValue::Object(fields) => {
                *bytes += 2;
                let mut out = Map::new();
                for (key, value) in fields {
                    require(
                        !["__proto__", "prototype", "constructor"].contains(&key.as_str()),
                        "JSON contains an unsafe property",
                    )?;
                    require(
                        key.encode_utf16().count() <= DOMAIN_EVENT_MAX_JSON_BYTES,
                        "JSON exceeds 256 KiB",
                    )?;
                    if matches!(value, DomainEventSdkValue::Undefined) {
                        continue;
                    }
                    // Native map construction must not silently overwrite a
                    // duplicate key or undercount its serialized budget.
                    require(
                        !out.contains_key(key),
                        "JSON contains duplicate object keys",
                    )?;
                    *bytes += json_string_bytes(key) + 2;
                    out.insert(
                        key.clone(),
                        convert(value, depth + 1, bytes, true)?
                            .expect("non-undefined object value"),
                    );
                }
                Value::Object(out)
            }
        };
        require(
            *bytes <= DOMAIN_EVENT_MAX_JSON_BYTES,
            "JSON exceeds 256 KiB",
        )?;
        Ok(Some(value))
    }
    require(
        matches!(value, DomainEventSdkValue::Object(_))
            || matches!(value, DomainEventSdkValue::Json(Value::Object(_))),
        "providerData must be a plain record",
    )?;
    convert(value, 0, &mut 0, false)?
        .ok_or_else(|| DomainEventContractError::new("providerData must be a plain record"))
}

pub fn validate_domain_event_contract(input: &Value, mode: ContractMode) -> Result<()> {
    validate(input, mode, None, None)
}

pub fn validate_native_retained_contract(
    input: &Value,
    native: &NativeRetainedContract,
) -> Result<()> {
    validate(input, ContractMode::Retained, Some(native), None)
}

/// A native SDK occurrence Date does not confer retained ObjectId/journal
/// identity or permit the legacy subject exception at an ingest boundary.
pub fn validate_native_ingest_contract(input: &Value, occurred_at_millis: i64) -> Result<()> {
    validate(input, ContractMode::Ingest, None, Some(occurred_at_millis))
}

fn validate(
    input: &Value,
    mode: ContractMode,
    native: Option<&NativeRetainedContract>,
    native_occurred_at: Option<i64>,
) -> Result<()> {
    let input = input
        .as_object()
        .ok_or_else(|| DomainEventContractError::new("input must be an envelope"))?;
    let source = text(input.get("source"), "source")?;
    let source_id = text(input.get("sourceEventId"), "sourceEventId")?;
    let event_type = text(input.get("type"), "type")?;
    let topic = input
        .get("topic")
        .and_then(Value::as_str)
        .and_then(DomainEventTopic::parse)
        .ok_or_else(|| DomainEventContractError::new("topic is invalid"))?;
    if input.contains_key("schemaVersion") {
        count(input.get("schemaVersion"), "schemaVersion", 1)?;
    }
    let version = input
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    if let Some(retention) = input.get("retentionSeconds") {
        let retention = number(Some(retention))
            .filter(|n| n.is_finite())
            .ok_or_else(|| {
                DomainEventContractError::new("retentionSeconds must be finite numbers")
            })?;
        require(
            retention > 0.0 && retention <= retention_seconds(topic) as f64,
            "retentionSeconds exceeds the topic retention limit or is not positive",
        )?;
    }
    if input.contains_key("channelID") || topic == DomainEventTopic::Channel {
        text(input.get("channelID"), "channelID")?;
    }
    if input.contains_key("streamID") {
        text(input.get("streamID"), "streamID")?;
    }
    if let Some(owner) = input.get("ownerUserId") {
        require(
            owner
                .as_str()
                .is_some_and(|s| s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit())),
            "ownerUserId must be an internal user ObjectId",
        )?;
    }
    let subject = if let Some(subject) = input.get("subject") {
        let subject = subject
            .as_object()
            .ok_or_else(|| DomainEventContractError::new("subject must be an identity"))?;
        text(subject.get("provider"), "subject.provider")?;
        text(subject.get("id"), "subject.id")?;
        require(
            subject
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|s| {
                    [
                        "streaming-account",
                        "integration-account",
                        "customer",
                        "resource",
                    ]
                    .contains(&s)
                }),
            "subject.kind is invalid",
        )?;
        Some(subject)
    } else {
        None
    };
    require(
        topic == DomainEventTopic::Channel || subject.is_some() || truthy(input.get("ownerUserId")),
        "requires a subject or owner identity",
    )?;
    let occurred = if let Some(native) = native {
        for (field, timestamp) in [
            ("occurredAt", native.occurred_at_millis),
            ("journaledAt", native.journaled_at_millis),
            ("expiresAt", native.expires_at_millis),
        ] {
            require(
                valid_native_millis(timestamp),
                format!("{field} must be a valid date"),
            )?;
        }
        Some(native.occurred_at_millis)
    } else if let Some(native_occurrence) = native_occurred_at {
        require(
            valid_native_millis(native_occurrence),
            "occurredAt must be a valid date",
        )?;
        Some(native_occurrence)
    } else {
        if input.contains_key("occurredAt") {
            Some(date(input.get("occurredAt"), "occurredAt")?)
        } else {
            None
        }
    };
    if input.contains_key("eventKey") {
        text(input.get("eventKey"), "eventKey")?;
        require(occurred.is_some(), "occurredAt must be a valid date")?;
    }
    if native.is_none() {
        for field in ["journaledAt", "expiresAt"] {
            if input.contains_key(field) {
                date(input.get(field), field)?;
            }
        }
    }
    let payload = record(input.get("payload"), "payload")?;
    let empty = Map::new();
    let metadata = if input.contains_key("metadata") {
        record(input.get("metadata"), "metadata")?
    } else {
        &empty
    };
    // Match source depth and byte accounting across both objects together.
    let mut bytes = 2 + json_string_bytes("payload") + 2;
    walk_json_fields(payload, 1, &mut bytes)?;
    bytes += json_string_bytes("metadata") + 2;
    walk_json_fields(metadata, 1, &mut bytes)?;
    let twitch = source == "twitch-eventsub" || source == "twitch-eventsub-test";
    if !twitch && source != "polar-webhook" {
        return Ok(());
    }
    require(
        version == 1.0,
        format!("unsupported schemaVersion for {source}"),
    )?;
    let original = text(
        metadata.get("originalEventType"),
        "metadata.originalEventType",
    )?;
    if twitch {
        validate_twitch(
            input, source, source_id, event_type, topic, payload, metadata, subject, original,
            occurred, mode, native,
        )
    } else {
        validate_polar(
            input, event_type, topic, payload, metadata, subject, original, occurred,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_twitch(
    input: &Map<String, Value>,
    source: &str,
    source_id: &str,
    event_type: &str,
    topic: DomainEventTopic,
    payload: &Map<String, Value>,
    metadata: &Map<String, Value>,
    subject: Option<&Map<String, Value>>,
    original: &str,
    occurred: Option<i64>,
    mode: ContractMode,
    native: Option<&NativeRetainedContract>,
) -> Result<()> {
    let channel = input.get("channelID");
    let condition_value = payload
        .get("subscription")
        .and_then(Value::as_object)
        .and_then(|s| s.get("condition"));
    let empty_condition = Map::new();
    let condition = condition_value
        .and_then(Value::as_object)
        .unwrap_or(&empty_condition);
    let mut raid_condition = crate::utils::eventsub::Condition::default();
    for field in ["from_broadcaster_user_id", "to_broadcaster_user_id"] {
        if truthy(condition.get(field)) {
            raid_condition.insert(field, "present");
        }
    }
    let outgoing = original == "channel.raid"
        && crate::utils::eventsub::raid_direction(&raid_condition)
            == crate::utils::eventsub::RaidDirection::Outgoing;
    let expected = if outgoing {
        Some("channel.raid.sent")
    } else {
        twitch_domain_event_type(original)
    };
    require(
        expected == Some(event_type) && topic == DomainEventTopic::Channel,
        "Twitch source/type/topic/originalEventType mismatch",
    )?;
    let legacy = mode == ContractMode::Retained
        && native.is_some()
        && subject.is_none()
        && !input.contains_key("ownerUserId")
        && original != "channel.raid"
        && !metadata.contains_key("durableChatHandled")
        && !metadata.contains_key("durableDefenseHandled")
        && number(input.get("schemaVersion")) == Some(1.0)
        && build_domain_event_key(source, source_id, event_type)
            .ok()
            .as_deref()
            == input.get("eventKey").and_then(Value::as_str)
        && ["subscriptionID", "subscriptionVersion", "messageTimestamp"]
            .iter()
            .all(|field| metadata.get(*field).is_some_and(Value::is_string));
    require(
        legacy
            || subject.is_some_and(|s| {
                s.get("provider").and_then(Value::as_str) == Some("twitch")
                    && s.get("kind").and_then(Value::as_str) == Some("streaming-account")
                    && s.get("id") == channel
            }),
        "Twitch subject/channelID mismatch",
    )?;
    let subscription = record(payload.get("subscription"), "payload.subscription")?;
    let event = record(payload.get("event"), "payload.event")?;
    require(
        subscription.get("type").and_then(Value::as_str) == Some(original),
        "Twitch subscription.type/originalEventType mismatch",
    )?;
    if subscription.contains_key("id") {
        text(subscription.get("id"), "subscription.id")?;
    }
    if let Some(version) = subscription.get("version") {
        require(
            version.as_str()
                == Some(if original == "channel.follow" {
                    "2"
                } else {
                    "1"
                }),
            "unsupported Twitch subscription.version",
        )?;
    }
    if subscription.contains_key("cost") {
        count(subscription.get("cost"), "subscription.cost", 0)?;
    }
    if subscription.contains_key("created_at") {
        date(subscription.get("created_at"), "subscription.created_at")?;
    }
    if let Some(condition) = subscription.get("condition") {
        let condition = record(Some(condition), "subscription.condition")?;
        for field in [
            "broadcaster_user_id",
            "to_broadcaster_user_id",
            "from_broadcaster_user_id",
        ] {
            if original == "channel.raid"
                && field != "broadcaster_user_id"
                && condition.get(field).and_then(Value::as_str) == Some("")
            {
                let opposite = if field == "from_broadcaster_user_id" {
                    "to_broadcaster_user_id"
                } else {
                    "from_broadcaster_user_id"
                };
                if condition
                    .get(opposite)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    && condition.get(opposite) == event.get(opposite)
                {
                    continue;
                }
            }
            if let Some(value) = condition.get(field) {
                require(
                    Some(value)
                        == if field == "from_broadcaster_user_id" {
                            event.get(field)
                        } else {
                            channel
                        },
                    format!("subscription.condition.{field} mismatch"),
                )?;
            }
        }
        if original == "channel.raid" {
            require(
                !(truthy(condition.get("from_broadcaster_user_id"))
                    && truthy(condition.get("to_broadcaster_user_id"))),
                "raid condition must specify one direction",
            )?;
        }
    }
    for (field, subfield) in [("subscriptionID", "id"), ("subscriptionVersion", "version")] {
        if let Some(value) = metadata.get(field) {
            require(
                value
                    == subscription
                        .get(subfield)
                        .unwrap_or(&Value::String(String::new())),
                format!("metadata.{field} mismatch"),
            )?;
        }
    }
    let channel_field = if original == "channel.raid" {
        if outgoing {
            "from_broadcaster_user_id"
        } else {
            "to_broadcaster_user_id"
        }
    } else {
        "broadcaster_user_id"
    };
    text(event.get(channel_field), &format!("event.{channel_field}"))?;
    require(
        event.get(channel_field) == channel,
        "Twitch payload/channelID mismatch",
    )?;
    if event.contains_key("broadcaster_user_id") {
        require(
            event.get("broadcaster_user_id") == channel,
            "Twitch broadcaster/channelID mismatch",
        )?;
    }
    if original == "channel.chat.notification" {
        validate_chat_notification(event)?;
    }
    if super::interaction::interaction_domain_event_type(original).is_some() {
        let timestamp = if truthy(metadata.get("messageTimestamp")) {
            metadata.get("messageTimestamp").and_then(Value::as_str)
        } else {
            input.get("occurredAt").and_then(Value::as_str)
        };
        // A native Date is stringified by JS here; parseInteraction only accepts
        // ISO text, so retained native interaction rows must carry message time.
        super::interaction::parse_interaction(
            original,
            event,
            timestamp.unwrap_or("undefined"),
            source_id,
        )
        .map_err(|e| DomainEventContractError::new(e.message))?;
    }
    if original == "channel.raid" {
        text(
            event.get("from_broadcaster_user_id"),
            "event.from_broadcaster_user_id",
        )?;
        count(event.get("viewers"), "event.viewers", 0)?;
    }
    if [
        "channel.follow",
        "channel.subscribe",
        "channel.subscription.message",
        "channel.subscription.end",
    ]
    .contains(&original)
    {
        text(event.get("user_id"), "event.user_id")?;
    }
    if event_type == "channel.bits.received" {
        count(event.get("bits"), "event.bits", 1)?;
    }
    if original == "stream.online" {
        text(event.get("id"), "event.id")?;
        require(
            input.get("streamID") == event.get("id"),
            "Twitch streamID/event.id mismatch",
        )?;
    }
    for field in ["total", "cumulative_months", "duration_months", "months"] {
        if event.contains_key(field) {
            count(
                event.get(field),
                &format!("event.{field}"),
                u64::from(field == "total"),
            )?;
        }
    }
    for field in ["cumulative_total", "streak_months"] {
        if nullish(event.get(field)).is_some() {
            count(event.get(field), &format!("event.{field}"), 0)?;
        }
    }
    for field in ["is_anonymous", "is_gift"] {
        if let Some(value) = event.get(field) {
            require(value.is_boolean(), format!("event.{field} must be boolean"))?;
        }
    }
    for field in ["tier", "sub_tier", "subscription_tier"] {
        if let Some(value) = event.get(field) {
            require(
                value
                    .as_str()
                    .is_some_and(|s| ["1000", "2000", "3000", "Prime"].contains(&s)),
                format!("event.{field} is invalid"),
            )?;
        }
    }
    for field in [
        "user_id",
        "user_login",
        "user_name",
        "broadcaster_user_login",
        "broadcaster_user_name",
        "to_broadcaster_user_login",
        "to_broadcaster_user_name",
        "from_broadcaster_user_login",
        "from_broadcaster_user_name",
    ] {
        if let Some(value) = nullish(event.get(field)) {
            require(value.is_string(), format!("event.{field} must be a string"))?;
        }
    }
    for field in ["followed_at", "started_at", "subscribed_at", "ended_at"] {
        if event.contains_key(field) {
            date(event.get(field), &format!("event.{field}"))?;
        }
    }
    if metadata.contains_key("messageTimestamp")
        && metadata.get("messageTimestamp").and_then(Value::as_str) != Some("")
    {
        date(
            metadata.get("messageTimestamp"),
            "metadata.messageTimestamp",
        )?;
    }
    let provider_time = match original {
        "channel.follow" => {
            nullish(event.get("followed_at")).or_else(|| metadata.get("messageTimestamp"))
        }
        "stream.online" => {
            nullish(event.get("started_at")).or_else(|| metadata.get("messageTimestamp"))
        }
        _ => metadata.get("messageTimestamp"),
    };
    if truthy(provider_time) {
        require(
            occurred.is_some()
                && occurred
                    == provider_time
                        .and_then(Value::as_str)
                        .and_then(parse_contract_time),
            "Twitch occurredAt/payload timestamp mismatch",
        )?;
    }
    if metadata.contains_key("messageRetry") {
        count(metadata.get("messageRetry"), "metadata.messageRetry", 0)?;
    }
    for field in ["staleRetry", "durableChatHandled", "durableDefenseHandled"] {
        if let Some(value) = metadata.get(field) {
            require(
                value.is_boolean(),
                format!("metadata.{field} must be boolean"),
            )?;
        }
    }
    if metadata.get("durableDefenseHandled") == Some(&Value::Bool(true)) {
        require(
            source == "twitch-eventsub"
                && !outgoing
                && ["channel.follow", "channel.raid"].contains(&original),
            "invalid durableDefenseHandled scope",
        )?;
    }
    Ok(())
}

fn validate_chat_notification(event: &Map<String, Value>) -> Result<()> {
    let notice = text(event.get("notice_type"), "event.notice_type")?;
    text(event.get("message_id"), "event.message_id")?;
    require(
        event
            .get("chatter_is_anonymous")
            .is_some_and(Value::is_boolean),
        "event.chatter_is_anonymous must be boolean",
    )?;
    for field in [
        "chatter_user_id",
        "chatter_user_login",
        "chatter_user_name",
        "system_message",
    ] {
        require(
            event.get(field).is_some_and(Value::is_string),
            format!("event.{field} must be a string"),
        )?;
    }
    if event.get("chatter_is_anonymous") == Some(&Value::Bool(false)) {
        text(event.get("chatter_user_id"), "event.chatter_user_id")?;
    }
    let message = record(event.get("message"), "event.message")?;
    require(
        message.get("text").is_some_and(Value::is_string)
            && message.get("fragments").is_some_and(Value::is_array),
        "event.message must contain text and fragments",
    )?;
    if notice == "watch_streak" {
        let streak = record(event.get("watch_streak"), "event.watch_streak")?;
        count(
            streak.get("streak_count"),
            "event.watch_streak.streak_count",
            1,
        )?;
        count(
            streak.get("channel_points_awarded"),
            "event.watch_streak.channel_points_awarded",
            0,
        )?;
    }
    if notice == "modiversary" {
        let anniversary = record(event.get("modiversary"), "event.modiversary")?;
        count(anniversary.get("months"), "event.modiversary.months", 1)?;
    }
    Ok(())
}

fn polar_type(original: &str) -> Option<&'static str> {
    match original {
        "order.paid" => Some("billing.order.paid"),
        "subscription.updated" => Some("billing.subscription.updated"),
        "customer.state_changed" => Some("billing.customer.state.changed"),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_polar(
    input: &Map<String, Value>,
    event_type: &str,
    topic: DomainEventTopic,
    payload: &Map<String, Value>,
    metadata: &Map<String, Value>,
    subject: Option<&Map<String, Value>>,
    original: &str,
    occurred: Option<i64>,
) -> Result<()> {
    let mapped = polar_type(original);
    require(
        event_type
            == mapped
                .map(str::to_owned)
                .unwrap_or_else(|| format!("provider.polar.{original}"))
            && topic == DomainEventTopic::Domain,
        "Polar source/type/topic/originalEventType mismatch",
    )?;
    require(
        !input.contains_key("channelID") && !input.contains_key("streamID"),
        "Polar events must not fabricate Twitch channel/stream identity",
    )?;
    require(
        subject.is_some_and(|s| s.get("provider").and_then(Value::as_str) == Some("polar")),
        "Polar subject provider mismatch",
    )?;
    let subject = subject.expect("required subject");
    require(occurred.is_some(), "Polar occurredAt is required")?;
    for field in ["externalCustomerId", "legacyTwitchChannelId"] {
        if metadata.contains_key(field) {
            text(metadata.get(field), &format!("metadata.{field}"))?;
        }
    }
    if mapped.is_none() {
        require(
            metadata.get("unmapped") == Some(&Value::Bool(true)),
            "Polar provider events require unmapped=true",
        )?;
        let data = record(payload.get("providerData"), "payload.providerData")?;
        text(data.get("id"), "providerData.id")?;
        let customer = if let Some(customer) = nullish(data.get("customer")) {
            Some(record(Some(customer), "providerData.customer")?)
        } else {
            None
        };
        let customer_id = customer.and_then(|c| c.get("id"));
        if nullish(data.get("customerId")).is_some() && nullish(customer_id).is_some() {
            require(
                data.get("customerId") == customer_id,
                "Polar providerData customer identities mismatch",
            )?;
        }
        let customer_id = if original.starts_with("customer.") {
            data.get("id")
        } else {
            nullish(data.get("customerId")).or(customer_id)
        };
        if nullish(customer_id).is_some() {
            text(customer_id, "providerData.customerId")?;
        }
        require(
            subject.get("kind").and_then(Value::as_str)
                == Some(if truthy(customer_id) {
                    "customer"
                } else {
                    "resource"
                })
                && subject.get("id") == nullish(customer_id).or_else(|| data.get("id")),
            "Polar providerData/subject mismatch",
        )?;
        return Ok(());
    }
    require(
        !metadata.contains_key("unmapped") || metadata.get("unmapped") == Some(&Value::Bool(false)),
        "mapped Polar event cannot be unmapped",
    )?;
    text(payload.get("customerId"), "payload.customerId")?;
    require(
        subject.get("kind").and_then(Value::as_str) == Some("customer")
            && subject.get("id") == payload.get("customerId"),
        "Polar customerId/subject mismatch",
    )?;
    for field in ["orderId", "subscriptionId", "productId", "status"] {
        if payload.contains_key(field) {
            text(payload.get(field), &format!("payload.{field}"))?;
        }
    }
    if let Some(cadence) = payload.get("cadence") {
        require(
            cadence
                .as_str()
                .is_some_and(|s| ["monthly", "yearly"].contains(&s)),
            "payload.cadence is invalid",
        )?;
    }
    if nullish(payload.get("periodEnd")).is_some() {
        date(payload.get("periodEnd"), "payload.periodEnd")?;
    }
    if let Some(paid) = payload.get("paid") {
        require(paid.is_boolean(), "payload.paid must be boolean")?;
    }
    if let Some(amount) = payload.get("totalAmount") {
        require(
            number(Some(amount)).is_some_and(|n| is_safe_integer(n) && n >= 0.0),
            "payload.totalAmount must be nonnegative cents",
        )?;
    }
    if original == "order.paid" {
        text(payload.get("orderId"), "payload.orderId")?;
        text(payload.get("status"), "payload.status")?;
        require(
            payload.get("paid") == Some(&Value::Bool(true)),
            "Polar order.paid requires paid=true",
        )?;
        if payload.contains_key("subscriptionId") {
            require(
                payload.contains_key("cadence"),
                "Polar subscription order requires cadence",
            )?;
        }
    } else if original == "subscription.updated" {
        for field in ["subscriptionId", "productId", "status", "cadence"] {
            text(payload.get(field), &format!("payload.{field}"))?;
        }
    }
    if payload.contains_key("activeSubscriptions") || payload.contains_key("grantedBenefits") {
        require(
            original == "customer.state_changed",
            "entitlement snapshots require customer.state_changed",
        )?;
        require(
            payload
                .get("activeSubscriptions")
                .is_some_and(Value::is_array)
                && payload.get("grantedBenefits").is_some_and(Value::is_array),
            "both entitlement arrays are required",
        )?;
        for subscription in payload["activeSubscriptions"]
            .as_array()
            .expect("checked array")
        {
            let subscription = record(Some(subscription), "entitlement subscription")?;
            for field in ["id", "productId", "status"] {
                text(subscription.get(field), &format!("subscription.{field}"))?;
            }
            for field in ["currentPeriodEnd", "endsAt", "trialStart", "trialEnd"] {
                if nullish(subscription.get(field)).is_some() {
                    date(subscription.get(field), &format!("subscription.{field}"))?;
                }
            }
        }
        for grant in payload["grantedBenefits"]
            .as_array()
            .expect("checked array")
        {
            let grant = record(Some(grant), "entitlement grant")?;
            text(grant.get("id"), "grant.id")?;
            text(grant.get("benefitId"), "grant.benefitId")?;
        }
    }
    if original == "customer.state_changed" || payload.contains_key("meters") {
        let meters = payload
            .get("meters")
            .and_then(Value::as_array)
            .ok_or_else(|| DomainEventContractError::new("payload.meters must be an array"))?;
        for meter in meters {
            let meter = record(Some(meter), "meter")?;
            text(meter.get("meter_id"), "meter.meter_id")?;
            for field in ["consumed_units", "credited_units", "balance"] {
                if let Some(value) = meter.get(field) {
                    require(
                        number(Some(value)).is_some_and(f64::is_finite),
                        format!("meter.{field} must be finite"),
                    )?;
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct TwitchEventsubPayload<'a> {
    pub subscription: &'a Map<String, Value>,
    pub event: &'a Map<String, Value>,
}
pub type PolarBillingPayload<'a> = &'a Map<String, Value>;

pub fn get_twitch_eventsub_payload(input: &Value) -> Result<TwitchEventsubPayload<'_>> {
    validate_domain_event_contract(input, ContractMode::Retained)?;
    require(
        input
            .get("source")
            .and_then(Value::as_str)
            .is_some_and(|s| ["twitch-eventsub", "twitch-eventsub-test"].contains(&s)),
        "expected a Twitch event",
    )?;
    let payload = input["payload"].as_object().expect("validated payload");
    Ok(TwitchEventsubPayload {
        subscription: payload["subscription"]
            .as_object()
            .expect("validated subscription"),
        event: payload["event"].as_object().expect("validated event"),
    })
}

pub fn get_polar_billing_payload(input: &Value) -> Result<PolarBillingPayload<'_>> {
    validate_domain_event_contract(input, ContractMode::Retained)?;
    require(
        input.get("source").and_then(Value::as_str) == Some("polar-webhook")
            && input.get("type").and_then(Value::as_str).is_some_and(|s| {
                [
                    "billing.order.paid",
                    "billing.subscription.updated",
                    "billing.customer.state.changed",
                ]
                .contains(&s)
            }),
        "expected a mapped Polar billing event",
    )?;
    Ok(input["payload"].as_object().expect("validated payload"))
}
