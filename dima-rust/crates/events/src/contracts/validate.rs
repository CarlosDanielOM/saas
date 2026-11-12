//! `validateDomainEventContract` and the JSON walk behind it (`domain_event_contracts.ts`),
//! check for check and in the reference's order, so the first failing check, and its message,
//! are the reference's.
//!
//! The validator reads an envelope as an [`Object`]: a new input ([`super::JournalInput::to_object`],
//! [`Mode::Ingest`]) or a stored event ([`Object::from_bson`] of the document, [`Mode::Retained`]).
//! `'field' in input` is a property that exists; `input.field === undefined` is a missing one.
//!
//! Lengths: the 256 KiB budget counts what the reference counts: UTF-8 bytes of the JSON text of
//! each string and key (`Buffer.byteLength(JSON.stringify(…))`) and, for the per-value cap, UTF-16
//! units (`value.length`, `dima_text::utf16_len`). Both decide whether an event is accepted, so
//! they are identity rows of `MIGRATION.md` section 4.

use super::live;
use super::{TWITCH_TYPES, polar_type, retention_seconds, twitch_type};
use crate::identity::encode_uri_component;
use crate::value::{Object, Value};
use dima_model::StrEnum;
use dima_model::domain_events::{SubjectKind, Topic};
use dima_text::{parse_date, trim, utf16_len};

/// `DOMAIN_EVENT_MAX_JSON_BYTES`: the budget of `payload` and `metadata` together.
pub const MAX_JSON_BYTES: usize = 256 * 1024;

/// `DomainEventContractError`: permanent (retrying the same input fails the same way). The
/// message is the reference's (`Domain event contract: …`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Domain event contract: {0}")]
pub struct ContractError(pub String);

impl ContractError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    /// The message without the `Domain event contract: ` prefix.
    pub fn reason(&self) -> &str {
        &self.0
    }
}

/// Which boundary validates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A producer or the journal write: every new event.
    Ingest,
    /// A trusted journal read (consumers, replay): also accepts the legacy Twitch rows journaled
    /// before subjects existed.
    Retained,
}

/// How to validate: the mode, and the time `Date.now()` reads (only the hype train check of an
/// input without `occurredAt` uses it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Check {
    /// The boundary.
    pub mode: Mode,
    /// `Date.now()`.
    pub now_ms: i64,
}

impl Check {
    /// An ingest check at `now_ms`.
    pub fn ingest(now_ms: i64) -> Self {
        Self {
            mode: Mode::Ingest,
            now_ms,
        }
    }

    /// A retained check at `now_ms`.
    pub fn retained(now_ms: i64) -> Self {
        Self {
            mode: Mode::Retained,
            now_ms,
        }
    }
}

type Result<T = ()> = std::result::Result<T, ContractError>;

fn require(condition: bool, message: impl FnOnce() -> String) -> Result {
    if condition {
        Ok(())
    } else {
        Err(ContractError(message()))
    }
}

/// `record(value, field)`: a plain object.
fn record<'a>(value: &'a Value, field: &str) -> Result<&'a Object> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(ContractError(format!("{field} must be a plain record"))),
    }
}

/// `text(value, field)`: a nonblank string without surrounding whitespace.
fn text(value: &Value, field: &str) -> Result {
    require(
        matches!(value, Value::String(s) if !trim(s).is_empty() && trim(s) == s),
        || format!("{field} is required and must be a nonblank string"),
    )
}

/// `Number.isSafeInteger(value)`.
pub(crate) fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `count(value, field, minimum)`.
fn count(value: &Value, field: &str, minimum: f64) -> Result {
    require(
        matches!(value, Value::Number(n) if is_safe_integer(*n) && *n >= minimum),
        || format!("{field} must be a safe integer >= {}", minimum as i64),
    )
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/`.
pub(crate) fn is_strict_date_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|run| run.iter().all(u8::is_ascii_digit))
    };
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    if !(digits(0..4)
        && at(4, b'-')
        && digits(5..7)
        && at(7, b'-')
        && digits(8..10)
        && at(10, b'T')
        && digits(11..13)
        && at(13, b':')
        && digits(14..16)
        && at(16, b':')
        && digits(17..19))
    {
        return false;
    }
    let mut index = 19;
    if at(index, b'.') {
        let run = bytes
            .get(index + 1..)
            .map_or(0, |rest| rest.iter().take_while(|b| b.is_ascii_digit()).count());
        if !(1..=9).contains(&run) {
            return false;
        }
        index += 1 + run;
    }
    match bytes.get(index) {
        Some(b'Z') => index + 1 == bytes.len(),
        Some(b'+' | b'-') => {
            digits(index + 1..index + 3) && at(index + 3, b':') && digits(index + 4..index + 6)
                && index + 6 == bytes.len()
        }
        _ => false,
    }
}

fn ascii_number(text: &str) -> u32 {
    text.bytes()
        .fold(0_u32, |n, b| n.saturating_mul(10).saturating_add(u32::from(b - b'0')))
}

/// `date(value, field, allowDate)`.
fn date(value: &Value, field: &str, allow_date: bool) -> Result {
    let invalid = || format!("{field} must be a valid date");
    if allow_date && let Value::Date(ms) = value {
        return require(ms.is_finite(), invalid);
    }
    let Value::String(text) = value else {
        return Err(ContractError(invalid()));
    };
    require(
        is_strict_date_time(text) && parse_date(text).is_some(),
        invalid,
    )?;
    // The pattern matched, so the first 13 bytes are ASCII.
    let part = |range: std::ops::Range<usize>| text.get(range).map_or(0, ascii_number);
    let (year, month, day, hour) = (part(0..4), part(5..7), part(8..10), part(11..13));
    require(
        (1..=12).contains(&month)
            && day >= 1
            && day <= days_in_month(year, month)
            && hour < 24,
        invalid,
    )
}

/// `new Date(Date.UTC(year, month, 0)).getUTCDate()`.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// `Buffer.byteLength(JSON.stringify(text))`.
fn json_string_bytes(text: &str) -> usize {
    2 + text
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

/// The JSON walk (`checkJson`): rejects what `JSON.stringify` would silently change, bounded at
/// 32 levels and [`MAX_JSON_BYTES`]. `sdk` also accepts valid `Date`s and skips `undefined`
/// object properties (the Polar SDK's objects).
pub fn check_json(value: &Value, sdk: bool) -> Result {
    let mut bytes = 0_usize;
    visit(value, 0, sdk, &mut bytes)
}

fn visit(value: &Value, depth: usize, sdk: bool, bytes: &mut usize) -> Result {
    let too_big = || "JSON exceeds 256 KiB".to_owned();
    require(depth <= 32, || "JSON nesting exceeds 32 levels".to_owned())?;
    match value {
        Value::Null | Value::Bool(_) => *bytes += 5,
        Value::String(text) => {
            require(utf16_len(text) <= MAX_JSON_BYTES, too_big)?;
            *bytes += json_string_bytes(text);
        }
        Value::Number(number) => {
            require(
                number.is_finite() && (number.fract() != 0.0 || is_safe_integer(*number)),
                || "JSON numbers must be finite and integers must be safe".to_owned(),
            )?;
            *bytes += dima_text::number_to_string(*number).len();
        }
        Value::Date(ms) if sdk => {
            date(value, "SDK date", true)?;
            let _ = ms;
            *bytes += 26;
        }
        Value::Undefined => {
            return Err(ContractError::new("payload and metadata must be JSON-safe"));
        }
        Value::Array(items) => {
            *bytes += 2;
            for item in items {
                *bytes += 1;
                visit(item, depth + 1, sdk, bytes)?;
            }
        }
        Value::Object(object) => {
            *bytes += 2;
            for (key, child) in object.iter() {
                require(
                    !matches!(key, "__proto__" | "prototype" | "constructor"),
                    || "JSON contains an unsafe property".to_owned(),
                )?;
                require(utf16_len(key) <= MAX_JSON_BYTES, too_big)?;
                if sdk && child.is_undefined() {
                    continue;
                }
                *bytes += json_string_bytes(key) + 2;
                visit(child, depth + 1, sdk, bytes)?;
            }
        }
        // A `Date` outside SDK data, an ObjectId or another BSON value: an object whose
        // prototype is not `Object.prototype`.
        Value::Date(_) | Value::ObjectId(_) | Value::Other => {
            record(value, "JSON value")?;
        }
    }
    require(*bytes <= MAX_JSON_BYTES, too_big)
}

/// `serializeDomainEventProviderData(value)`: the Polar SDK's data checked, then made JSON
/// (`JSON.parse(JSON.stringify(value))`: dates become ISO text, `undefined` disappears).
pub fn serialize_provider_data(value: &Value) -> Result<Object> {
    record(value, "providerData")?;
    check_json(value, true)?;
    match value.to_json() {
        Some(serde_json::Value::Object(map)) => match Value::from_json(&serde_json::Value::Object(map)) {
            Value::Object(object) => Ok(object),
            _ => Err(ContractError::new("providerData must be a plain record")),
        },
        _ => Err(ContractError::new("providerData must be a plain record")),
    }
}

/// `value === other` for the values the validator compares (identifiers, never two references
/// to one object).
fn same(value: &Value, other: &Value) -> bool {
    match (value, other) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

fn is_str(value: &Value, expected: &str) -> bool {
    value.as_str() == Some(expected)
}


/// `raidDirection(condition) === 'outgoing'` (`utils/raid_direction.ts`): a truthy
/// `from_broadcaster_user_id` and a falsy `to_broadcaster_user_id`.
pub(crate) fn is_outgoing_raid_condition(condition: &Value) -> bool {
    condition.at("from_broadcaster_user_id").truthy() && !condition.at("to_broadcaster_user_id").truthy()
}

fn has_own<'a>(table: &'a [(&'a str, &'a str)], key: &str) -> bool {
    table.iter().any(|(from, _)| *from == key)
}

/// `validateDomainEventContract(input, mode)`. `Ok` when the reference returns, the reference's
/// [`ContractError`] when it throws one.
pub fn validate_contract(input: &Object, check: Check) -> Result {
    for field in ["source", "sourceEventId", "type"] {
        text(input.at(field), field)?;
    }
    let topic = input.at("topic").as_str().and_then(Topic::parse);
    let Some(topic) = topic else {
        return Err(ContractError::new("topic is invalid"));
    };
    let schema_version = input.at("schemaVersion");
    let version_or_one = if schema_version.is_undefined() {
        &Value::Number(1.0)
    } else {
        schema_version
    };
    count(version_or_one, "schemaVersion", 1.0)?;
    let retention = input.at("retentionSeconds");
    if !retention.is_undefined() {
        require(
            matches!(retention, Value::Number(n) if n.is_finite()),
            || "retentionSeconds must be finite numbers".to_owned(),
        )?;
        let seconds = retention.as_number().unwrap_or(f64::NAN);
        require(seconds > 0.0 && seconds <= retention_seconds(topic), || {
            "retentionSeconds exceeds the topic retention limit or is not positive".to_owned()
        })?;
    }
    let channel_id = input.at("channelID");
    if !channel_id.is_undefined() || topic == Topic::Channel {
        text(channel_id, "channelID")?;
    }
    let stream_id = input.at("streamID");
    if !stream_id.is_undefined() {
        text(stream_id, "streamID")?;
    }
    let owner = input.at("ownerUserId");
    if !owner.is_undefined() {
        require(
            owner.as_str().is_some_and(crate::identity::is_user_id),
            || "ownerUserId must be an internal user ObjectId".to_owned(),
        )?;
    }
    let subject = input.at("subject");
    if !subject.is_undefined() {
        // Retained envelopes can contain a hydrated Mongoose subject subdocument.
        require(matches!(subject, Value::Object(_)), || {
            "subject must be an identity".to_owned()
        })?;
        text(subject.at("provider"), "subject.provider")?;
        text(subject.at("id"), "subject.id")?;
        require(
            subject
                .at("kind")
                .as_str()
                .is_some_and(|kind| SubjectKind::parse(kind).is_some()),
            || "subject.kind is invalid".to_owned(),
        )?;
    }
    require(
        topic == Topic::Channel || subject.truthy() || owner.truthy(),
        || "requires a subject or owner identity".to_owned(),
    )?;
    let occurred_at = input.at("occurredAt");
    if !occurred_at.is_undefined() {
        date(occurred_at, "occurredAt", true)?;
    }
    if input.has("eventKey") {
        text(input.at("eventKey"), "eventKey")?;
        date(occurred_at, "occurredAt", true)?;
    }
    if input.has("journaledAt") {
        date(input.at("journaledAt"), "journaledAt", true)?;
    }
    if input.has("expiresAt") {
        date(input.at("expiresAt"), "expiresAt", true)?;
    }
    let payload = record(input.at("payload"), "payload")?;
    let metadata_value = input.at("metadata");
    if !metadata_value.is_undefined() {
        record(metadata_value, "metadata")?;
    }
    let empty = Object::new();
    let metadata = metadata_value.as_object().unwrap_or(&empty);
    let mut wrapper = Object::new();
    wrapper.insert("payload", Value::Object(payload.clone()));
    wrapper.insert("metadata", Value::Object(metadata.clone()));
    check_json(&Value::Object(wrapper), false)?;

    let source = input.at("source").as_str().unwrap_or_default();
    let kind = input.at("type").as_str().unwrap_or_default();
    let version_is_one = matches!(version_or_one, Value::Number(n) if *n == 1.0);
    if source == super::sources::GOALS_CUSTOM {
        return validate_goals(input, payload, topic, kind, version_is_one);
    }
    let twitch = source == super::sources::TWITCH || source == super::sources::TWITCH_TEST;
    let polar = source == super::sources::POLAR;
    if !twitch && !polar {
        return Ok(());
    }
    require(version_is_one, || format!("unsupported schemaVersion for {source}"))?;
    text(metadata.at("originalEventType"), "metadata.originalEventType")?;
    let original = metadata.at("originalEventType").as_str().unwrap_or_default();
    let parts = Parts {
        input,
        payload,
        metadata,
        topic,
        source,
        kind,
        original,
        check,
    };
    if twitch {
        validate_twitch(&parts)
    } else {
        validate_polar(&parts)
    }
}

struct Parts<'a> {
    input: &'a Object,
    payload: &'a Object,
    metadata: &'a Object,
    topic: Topic,
    source: &'a str,
    kind: &'a str,
    original: &'a str,
    check: Check,
}

/// `/^[a-z0-9_]{1,48}$/`.
pub(crate) fn is_goal_item_key(text: &str) -> bool {
    (1..=48).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn validate_goals(
    input: &Object,
    payload: &Object,
    topic: Topic,
    kind: &str,
    version_is_one: bool,
) -> Result {
    require(
        kind == "goal.item.added" && topic == Topic::Domain && version_is_one,
        || "invalid goals-custom envelope".to_owned(),
    )?;
    let channel = input.at("channelID");
    text(channel, "channelID")?;
    let subject = input.at("subject");
    require(
        is_str(subject.at("provider"), "goals-custom")
            && is_str(subject.at("kind"), "streaming-account")
            && same(subject.at("id"), channel),
        || "invalid goals-custom subject".to_owned(),
    )?;
    require(
        payload.at("itemKey").as_str().is_some_and(is_goal_item_key),
        || "invalid goal itemKey".to_owned(),
    )?;
    require(
        matches!(payload.at("quantity"), Value::Number(n) if is_safe_integer(*n) && *n >= 1.0 && *n <= 1_000_000_000.0),
        || "invalid goal quantity".to_owned(),
    )?;
    require(payload.len() == 2, || "invalid goals-custom payload".to_owned())
}

fn validate_twitch(parts: &Parts<'_>) -> Result {
    let Parts {
        input,
        payload,
        metadata,
        topic,
        source,
        kind,
        original,
        check,
    } = *parts;
    let channel_id = input.at("channelID");
    let raid = original == "channel.raid";
    let outgoing_raid = raid && is_outgoing_raid_condition(payload.at("subscription").at("condition"));
    let expected = if outgoing_raid {
        Some("channel.raid.sent")
    } else {
        twitch_type(original)
    };
    require(
        has_own(&TWITCH_TYPES, original) && expected == Some(kind) && topic == Topic::Channel,
        || "Twitch source/type/topic/originalEventType mismatch".to_owned(),
    )?;
    // Before 75e22ef, Twitch schema 1 used channelID without subject/owner or durable-effect
    // markers. Only that complete retained shape may omit the subject.
    let legacy_subject = check.mode == Mode::Retained
        && input.at("subject").is_undefined()
        && input.at("ownerUserId").is_undefined()
        && !raid
        && metadata.at("durableChatHandled").is_undefined()
        && metadata.at("durableDefenseHandled").is_undefined()
        && matches!(input.at("schemaVersion"), Value::Number(n) if *n == 1.0)
        && matches!(input.at("_id"), Value::ObjectId(_))
        && input.has("eventKey")
        && input.at("eventKey").as_str()
            == Some(
                [source, input.at("sourceEventId").as_str().unwrap_or_default(), kind]
                    .map(encode_uri_component)
                    .join(":")
                    .as_str(),
            )
        && matches!(input.at("occurredAt"), Value::Date(_))
        && matches!(input.at("journaledAt"), Value::Date(_))
        && matches!(input.at("expiresAt"), Value::Date(_))
        && matches!(metadata.at("subscriptionID"), Value::String(_))
        && matches!(metadata.at("subscriptionVersion"), Value::String(_))
        && matches!(metadata.at("messageTimestamp"), Value::String(_));
    let subject = input.at("subject");
    require(
        legacy_subject
            || (is_str(subject.at("provider"), "twitch")
                && is_str(subject.at("kind"), "streaming-account")
                && same(subject.at("id"), channel_id)),
        || "Twitch subject/channelID mismatch".to_owned(),
    )?;
    let subscription = record(payload.at("subscription"), "payload.subscription")?;
    let event = record(payload.at("event"), "payload.event")?;
    require(is_str(subscription.at("type"), original), || {
        "Twitch subscription.type/originalEventType mismatch".to_owned()
    })?;
    if !subscription.at("id").is_undefined() {
        text(subscription.at("id"), "subscription.id")?;
    }
    let version = subscription.at("version");
    if !version.is_undefined() {
        let expected = if original == "channel.follow" || original.starts_with("channel.hype_train.") {
            "2"
        } else {
            "1"
        };
        require(is_str(version, expected), || {
            "unsupported Twitch subscription.version".to_owned()
        })?;
    }
    if !subscription.at("cost").is_undefined() {
        count(subscription.at("cost"), "subscription.cost", 0.0)?;
    }
    if !subscription.at("created_at").is_undefined() {
        date(subscription.at("created_at"), "subscription.created_at", false)?;
    }
    let condition_value = subscription.at("condition");
    if !condition_value.is_undefined() {
        let condition = record(condition_value, "subscription.condition")?;
        for field in [
            "broadcaster_user_id",
            "to_broadcaster_user_id",
            "from_broadcaster_user_id",
        ] {
            // An unused raid direction may be empty, but the opposite filter must match.
            if raid && field != "broadcaster_user_id" && is_str(condition.at(field), "") {
                let opposite = if field == "from_broadcaster_user_id" {
                    "to_broadcaster_user_id"
                } else {
                    "from_broadcaster_user_id"
                };
                if let Value::String(other) = condition.at(opposite)
                    && !other.is_empty()
                    && same(condition.at(opposite), event.at(opposite))
                {
                    continue;
                }
            }
            if !condition.at(field).is_undefined() {
                let expected = if field == "from_broadcaster_user_id" {
                    event.at("from_broadcaster_user_id")
                } else {
                    channel_id
                };
                require(same(condition.at(field), expected), || {
                    format!("subscription.condition.{field} mismatch")
                })?;
            }
        }
    }
    for (field, value) in [
        ("subscriptionID", subscription.at("id")),
        ("subscriptionVersion", subscription.at("version")),
    ] {
        if !metadata.at(field).is_undefined() {
            let expected = if value.is_nullish() {
                &Value::String(String::new())
            } else {
                value
            };
            require(same(metadata.at(field), expected), || {
                format!("metadata.{field} mismatch")
            })?;
        }
    }
    if raid {
        let condition = subscription.at("condition");
        require(
            !(condition.at("from_broadcaster_user_id").truthy()
                && condition.at("to_broadcaster_user_id").truthy()),
            || "raid condition must specify one direction".to_owned(),
        )?;
    }
    let channel_field = if raid {
        if outgoing_raid {
            "from_broadcaster_user_id"
        } else {
            "to_broadcaster_user_id"
        }
    } else {
        "broadcaster_user_id"
    };
    text(event.at(channel_field), &format!("event.{channel_field}"))?;
    require(same(event.at(channel_field), channel_id), || {
        "Twitch payload/channelID mismatch".to_owned()
    })?;
    if !event.at("broadcaster_user_id").is_undefined() {
        require(same(event.at("broadcaster_user_id"), channel_id), || {
            "Twitch broadcaster/channelID mismatch".to_owned()
        })?;
    }
    if original == "channel.chat.notification" {
        validate_chat_notification(event)?;
    }
    if has_own(&super::INTERACTION_TYPES, original) {
        let at = metadata.at("messageTimestamp");
        let occurred = if at.truthy() { at } else { input.at("occurredAt") };
        live::parse_interaction(
            original,
            event,
            &live::js_string(occurred),
            input.at("sourceEventId").as_str().unwrap_or_default(),
        )
        .map_err(ContractError)?;
    }
    if has_own(&super::HYPE_TRAIN_TYPES, original) || has_own(&super::AD_BREAK_TYPES, original) {
        if original == "channel.ad_break.begin" {
            live::parse_ad_break(event).map_err(ContractError)?;
        } else {
            let at = metadata.at("messageTimestamp");
            let occurred = if at.truthy() {
                live::js_string(at)
            } else {
                // `new Date(input.occurredAt ?? Date.now()).toISOString()`, which throws a
                // RangeError (caught and rethrown as a contract error) for an invalid date.
                let occurred = input.at("occurredAt");
                let ms = if occurred.is_nullish() {
                    Some(check.now_ms as f64)
                } else {
                    live::date_of(occurred)
                };
                match ms.and_then(|ms| dima_text::to_iso_string(ms.trunc() as i64)) {
                    Some(iso) => iso,
                    None => return Err(ContractError::new("Invalid time value")),
                }
            };
            live::parse_hype_train(original, event, &occurred).map_err(ContractError)?;
        }
    }
    if has_own(&super::TWITCH_GOAL_TYPES, original) {
        live::parse_twitch_goal_event(original, event).map_err(ContractError)?;
    }
    if raid {
        text(event.at("from_broadcaster_user_id"), "event.from_broadcaster_user_id")?;
        count(event.at("viewers"), "event.viewers", 0.0)?;
    }
    if matches!(
        original,
        "channel.follow" | "channel.subscribe" | "channel.subscription.message" | "channel.subscription.end"
    ) {
        text(event.at("user_id"), "event.user_id")?;
    }
    if kind == "channel.bits.received" {
        count(event.at("bits"), "event.bits", 1.0)?;
    }
    if original == "stream.online" {
        text(event.at("id"), "event.id")?;
        require(same(input.at("streamID"), event.at("id")), || {
            "Twitch streamID/event.id mismatch".to_owned()
        })?;
    }
    for field in ["total", "cumulative_months", "duration_months", "months"] {
        if !event.at(field).is_undefined() {
            let minimum = if field == "total" && !original.starts_with("channel.hype_train.") {
                1.0
            } else {
                0.0
            };
            count(event.at(field), &format!("event.{field}"), minimum)?;
        }
    }
    for field in ["cumulative_total", "streak_months"] {
        if !event.at(field).is_nullish() {
            count(event.at(field), &format!("event.{field}"), 0.0)?;
        }
    }
    for field in ["is_anonymous", "is_gift"] {
        if !event.at(field).is_undefined() {
            require(matches!(event.at(field), Value::Bool(_)), || {
                format!("event.{field} must be boolean")
            })?;
        }
    }
    for field in ["tier", "sub_tier", "subscription_tier"] {
        if !event.at(field).is_undefined() {
            require(
                event
                    .at(field)
                    .as_str()
                    .is_some_and(|tier| matches!(tier, "1000" | "2000" | "3000" | "Prime")),
                || format!("event.{field} is invalid"),
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
        if !event.at(field).is_nullish() {
            require(matches!(event.at(field), Value::String(_)), || {
                format!("event.{field} must be a string")
            })?;
        }
    }
    for field in ["followed_at", "started_at", "subscribed_at", "ended_at"] {
        if !event.at(field).is_undefined() {
            date(event.at(field), &format!("event.{field}"), false)?;
        }
    }
    let message_timestamp = metadata.at("messageTimestamp");
    if !message_timestamp.is_undefined() && !is_str(message_timestamp, "") {
        date(message_timestamp, "metadata.messageTimestamp", false)?;
    }
    let provider_time = |field: &str| {
        let value = event.at(field);
        if value.is_nullish() { message_timestamp } else { value }
    };
    let occurred = match original {
        "channel.follow" => provider_time("followed_at"),
        "stream.online" => provider_time("started_at"),
        _ => message_timestamp,
    };
    if occurred.truthy() {
        let stored = input.at("occurredAt");
        let expected = occurred.as_str().and_then(parse_date);
        require(
            !stored.is_undefined()
                && live::date_of(stored).zip(expected).is_some_and(|(a, b)| a == b as f64),
            || "Twitch occurredAt/payload timestamp mismatch".to_owned(),
        )?;
    }
    if !metadata.at("messageRetry").is_undefined() {
        count(metadata.at("messageRetry"), "metadata.messageRetry", 0.0)?;
    }
    for field in ["staleRetry", "durableChatHandled", "durableDefenseHandled"] {
        if !metadata.at(field).is_undefined() {
            require(matches!(metadata.at(field), Value::Bool(_)), || {
                format!("metadata.{field} must be boolean")
            })?;
        }
    }
    if matches!(metadata.at("durableDefenseHandled"), Value::Bool(true)) {
        require(
            source == super::sources::TWITCH
                && !outgoing_raid
                && matches!(original, "channel.follow" | "channel.raid"),
            || "invalid durableDefenseHandled scope".to_owned(),
        )?;
    }
    Ok(())
}

fn validate_chat_notification(event: &Object) -> Result {
    text(event.at("notice_type"), "event.notice_type")?;
    text(event.at("message_id"), "event.message_id")?;
    require(matches!(event.at("chatter_is_anonymous"), Value::Bool(_)), || {
        "event.chatter_is_anonymous must be boolean".to_owned()
    })?;
    for field in [
        "chatter_user_id",
        "chatter_user_login",
        "chatter_user_name",
        "system_message",
    ] {
        require(matches!(event.at(field), Value::String(_)), || {
            format!("event.{field} must be a string")
        })?;
    }
    if !event.at("chatter_is_anonymous").truthy() {
        text(event.at("chatter_user_id"), "event.chatter_user_id")?;
    }
    let message = record(event.at("message"), "event.message")?;
    require(
        matches!(message.at("text"), Value::String(_)) && matches!(message.at("fragments"), Value::Array(_)),
        || "event.message must contain text and fragments".to_owned(),
    )?;
    if is_str(event.at("notice_type"), "watch_streak") {
        let streak = record(event.at("watch_streak"), "event.watch_streak")?;
        count(streak.at("streak_count"), "event.watch_streak.streak_count", 1.0)?;
        count(
            streak.at("channel_points_awarded"),
            "event.watch_streak.channel_points_awarded",
            0.0,
        )?;
    }
    if is_str(event.at("notice_type"), "modiversary") {
        let modiversary = record(event.at("modiversary"), "event.modiversary")?;
        count(modiversary.at("months"), "event.modiversary.months", 1.0)?;
    }
    Ok(())
}

fn validate_polar(parts: &Parts<'_>) -> Result {
    let Parts {
        input,
        payload,
        metadata,
        topic,
        kind,
        original,
        ..
    } = *parts;
    let mapped = polar_type(original);
    let expected = mapped.map_or_else(|| format!("provider.polar.{original}"), str::to_owned);
    require(kind == expected && topic == Topic::Domain, || {
        "Polar source/type/topic/originalEventType mismatch".to_owned()
    })?;
    require(
        input.at("channelID").is_undefined() && input.at("streamID").is_undefined(),
        || "Polar events must not fabricate Twitch channel/stream identity".to_owned(),
    )?;
    let subject = input.at("subject");
    require(is_str(subject.at("provider"), "polar"), || {
        "Polar subject provider mismatch".to_owned()
    })?;
    require(!input.at("occurredAt").is_undefined(), || {
        "Polar occurredAt is required".to_owned()
    })?;
    for field in ["externalCustomerId", "legacyTwitchChannelId"] {
        if !metadata.at(field).is_undefined() {
            text(metadata.at(field), &format!("metadata.{field}"))?;
        }
    }
    if mapped.is_none() {
        require(matches!(metadata.at("unmapped"), Value::Bool(true)), || {
            "Polar provider events require unmapped=true".to_owned()
        })?;
        let data = record(payload.at("providerData"), "payload.providerData")?;
        text(data.at("id"), "providerData.id")?;
        let customer = data.at("customer");
        if !customer.is_nullish() {
            record(customer, "providerData.customer")?;
        }
        if !data.at("customerId").is_nullish() && !customer.at("id").is_nullish() {
            require(same(data.at("customerId"), customer.at("id")), || {
                "Polar providerData customer identities mismatch".to_owned()
            })?;
        }
        let customer_id = if original.starts_with("customer.") {
            data.at("id")
        } else if !data.at("customerId").is_nullish() {
            data.at("customerId")
        } else {
            customer.at("id")
        };
        if !customer_id.is_nullish() {
            text(customer_id, "providerData.customerId")?;
        }
        let subject_id = if customer_id.is_nullish() {
            data.at("id")
        } else {
            customer_id
        };
        let subject_kind = if customer_id.truthy() { "customer" } else { "resource" };
        return require(
            is_str(subject.at("kind"), subject_kind) && same(subject.at("id"), subject_id),
            || "Polar providerData/subject mismatch".to_owned(),
        );
    }
    require(
        matches!(metadata.at("unmapped"), Value::Undefined | Value::Bool(false)),
        || "mapped Polar event cannot be unmapped".to_owned(),
    )?;
    text(payload.at("customerId"), "payload.customerId")?;
    require(
        is_str(subject.at("kind"), "customer") && same(subject.at("id"), payload.at("customerId")),
        || "Polar customerId/subject mismatch".to_owned(),
    )?;
    for field in ["orderId", "subscriptionId", "productId", "status"] {
        if !payload.at(field).is_undefined() {
            text(payload.at(field), &format!("payload.{field}"))?;
        }
    }
    if !payload.at("cadence").is_undefined() {
        require(
            is_str(payload.at("cadence"), "monthly") || is_str(payload.at("cadence"), "yearly"),
            || "payload.cadence is invalid".to_owned(),
        )?;
    }
    if !payload.at("periodEnd").is_nullish() {
        date(payload.at("periodEnd"), "payload.periodEnd", false)?;
    }
    if !payload.at("paid").is_undefined() {
        require(matches!(payload.at("paid"), Value::Bool(_)), || {
            "payload.paid must be boolean".to_owned()
        })?;
    }
    if !payload.at("totalAmount").is_undefined() {
        require(
            matches!(payload.at("totalAmount"), Value::Number(n) if is_safe_integer(*n) && *n >= 0.0),
            || "payload.totalAmount must be nonnegative cents".to_owned(),
        )?;
    }
    if original == "order.paid" {
        text(payload.at("orderId"), "payload.orderId")?;
        text(payload.at("status"), "payload.status")?;
        require(matches!(payload.at("paid"), Value::Bool(true)), || {
            "Polar order.paid requires paid=true".to_owned()
        })?;
        if !payload.at("subscriptionId").is_undefined() {
            require(!payload.at("cadence").is_undefined(), || {
                "Polar subscription order requires cadence".to_owned()
            })?;
        }
    } else if original == "subscription.updated" {
        for field in ["subscriptionId", "productId", "status", "cadence"] {
            text(payload.at(field), &format!("payload.{field}"))?;
        }
    }
    let subscriptions = payload.at("activeSubscriptions");
    let grants = payload.at("grantedBenefits");
    if !subscriptions.is_undefined() || !grants.is_undefined() {
        require(original == "customer.state_changed", || {
            "entitlement snapshots require customer.state_changed".to_owned()
        })?;
        let (Value::Array(subscriptions), Value::Array(grants)) = (subscriptions, grants) else {
            return Err(ContractError::new("both entitlement arrays are required"));
        };
        for subscription in subscriptions {
            let subscription = record(subscription, "entitlement subscription")?;
            for field in ["id", "productId", "status"] {
                text(subscription.at(field), &format!("subscription.{field}"))?;
            }
            for field in ["currentPeriodEnd", "endsAt", "trialStart", "trialEnd"] {
                if !subscription.at(field).is_nullish() {
                    date(subscription.at(field), &format!("subscription.{field}"), false)?;
                }
            }
        }
        for grant in grants {
            let grant = record(grant, "entitlement grant")?;
            text(grant.at("id"), "grant.id")?;
            text(grant.at("benefitId"), "grant.benefitId")?;
        }
    }
    if original == "customer.state_changed" || !payload.at("meters").is_undefined() {
        let Value::Array(meters) = payload.at("meters") else {
            return Err(ContractError::new("payload.meters must be an array"));
        };
        for meter in meters {
            let meter = record(meter, "meter")?;
            text(meter.at("meter_id"), "meter.meter_id")?;
            for field in ["consumed_units", "credited_units", "balance"] {
                if !meter.at(field).is_undefined() {
                    require(matches!(meter.at(field), Value::Number(n) if n.is_finite()), || {
                        format!("meter.{field} must be finite")
                    })?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_date_time_pattern() {
        for valid in [
            "2026-09-05T12:00:00Z",
            "2026-09-05T12:00:00.1Z",
            "2026-09-05T12:00:00.123456789Z",
            "2026-09-05T12:00:00+02:00",
            "2026-09-05T12:00:00.5-11:30",
        ] {
            assert!(is_strict_date_time(valid), "{valid}");
        }
        for invalid in [
            "2026-09-05T12:00Z",
            "2026-09-05T12:00:00.1234567890Z",
            "2026-09-05T12:00:00",
            "2026-09-05 12:00:00Z",
            "2026-09-05T12:00:00+0200",
            "2026-09-05T12:00:00.Z",
            "٢٠٢٦-09-05T12:00:00Z",
        ] {
            assert!(!is_strict_date_time(invalid), "{invalid}");
        }
    }

    #[test]
    fn dates_check_calendar_and_hours() {
        let check = |text: &str| date(&Value::from(text), "d", false);
        assert!(check("2024-02-29T00:00:00Z").is_ok());
        assert!(check("2026-02-29T00:00:00Z").is_err());
        assert!(check("2026-04-31T00:00:00Z").is_err());
        assert!(check("2026-13-01T00:00:00Z").is_err());
        assert!(check("2026-01-01T24:00:00Z").is_err());
        assert!(date(&Value::Date(f64::NAN), "d", true).is_err());
        assert!(date(&Value::Date(0.0), "d", false).is_err());
        assert!(date(&Value::Date(0.0), "d", true).is_ok());
    }

    #[test]
    fn json_walk_budgets() {
        let big = Value::String("é".repeat(MAX_JSON_BYTES / 2));
        assert!(check_json(&big, false).is_err(), "UTF-8 bytes of the JSON text count");
        let mut nested = Value::Null;
        for _ in 0..33 {
            nested = Value::Array(vec![nested]);
        }
        assert_eq!(
            check_json(&nested, false),
            Err(ContractError::new("JSON nesting exceeds 32 levels"))
        );
        assert_eq!(
            check_json(&Value::Number(9_007_199_254_740_992.0), false),
            Err(ContractError::new(
                "JSON numbers must be finite and integers must be safe"
            ))
        );
        assert!(check_json(&Value::Number(0.5), false).is_ok());
        let mut unsafe_key = Object::new();
        unsafe_key.insert("__proto__", Value::Null);
        assert!(check_json(&Value::Object(unsafe_key), false).is_err());
        let mut sdk = Object::new();
        sdk.insert("at", Value::Date(0.0));
        sdk.insert("gone", Value::Undefined);
        assert!(check_json(&Value::Object(sdk.clone()), true).is_ok());
        assert!(check_json(&Value::Object(sdk), false).is_err());
        assert_eq!(json_string_bytes("a\"\u{1}👋"), 2 + 1 + 2 + 6 + 4);
    }
}
