//! The parsers the contract validator runs on polls, predictions, hype trains, ad breaks and
//! Twitch goals, reduced to what the validator uses from them: whether they throw, and the
//! message (it becomes the contract error's text).
//!
//! References: `parseInteraction` (`overlays/interaction-model.ts`), `parseHypeTrain` and
//! `parseAdBreak` (`overlays/live-events-model.ts`), `parseTwitchGoalEvent` (`goals/twitch.ts`).
//! The overlay and goal packages own the parsed values; checks run in the reference's
//! evaluation order so the first failure is the same. The length limits (`value.length <= max`)
//! count UTF-16 units: they decide whether an event is journaled (identity row of section 4).

use crate::value::{Object, Value};
use dima_text::{parse_date, utf16_len};

type Check = Result<(), String>;

/// `String(value)`, with `Date.prototype.toString` in UTC for a date.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Date(ms) => date_to_string(*ms),
        other => other.to_js_string(),
    }
}

/// `new Date(ms).toString()` on a server in UTC: `Sat Sep 05 2026 12:00:00 GMT+0000 (Coordinated
/// Universal Time)`.
fn date_to_string(ms: f64) -> String {
    if !ms.is_finite() {
        return "Invalid Date".into();
    }
    let Some(day) = dima_text::to_date_string_utc(ms.trunc() as i64) else {
        return "Invalid Date".into();
    };
    let Some(fields) = dima_text::utc_fields(ms.trunc() as i64) else {
        return "Invalid Date".into();
    };
    format!(
        "{day} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        fields.hour, fields.minute, fields.second
    )
}

/// `new Date(value).getTime()` for a date or date text; `None` for `NaN`.
pub(crate) fn date_of(value: &Value) -> Option<f64> {
    match value {
        Value::Date(ms) => ms.is_finite().then_some(*ms),
        Value::String(text) => parse_date(text).map(|ms| ms as f64),
        Value::Number(ms) => ms.is_finite().then_some(ms.trunc()),
        _ => None,
    }
}

fn starts_with_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 11
        && bytes.iter().take(4).all(u8::is_ascii_digit)
        && bytes.get(4) == Some(&b'-')
        && bytes.get(5..7).is_some_and(|d| d.iter().all(u8::is_ascii_digit))
        && bytes.get(7) == Some(&b'-')
        && bytes.get(8..10).is_some_and(|d| d.iter().all(u8::is_ascii_digit))
        && bytes.get(10) == Some(&b'T')
}

fn safe_count(value: &Value) -> bool {
    matches!(value, Value::Number(n) if super::validate::is_safe_integer(*n) && *n >= 0.0)
}

// --- polls and predictions -------------------------------------------------------------------

fn interaction_text(value: &Value, max: usize) -> Result<&str, String> {
    match value {
        Value::String(text) if !dima_text::trim(text).is_empty() && utf16_len(text) <= max => Ok(text),
        _ => Err("Invalid interaction text".into()),
    }
}

fn interaction_time(value: &Value) -> Check {
    let text = interaction_text(value, 40)?;
    if starts_with_date(text) && parse_date(text).is_some() {
        Ok(())
    } else {
        Err("Invalid interaction timestamp".into())
    }
}

fn interaction_count(value: &Value) -> Result<f64, String> {
    if safe_count(value) {
        Ok(value.as_number().unwrap_or_default())
    } else {
        Err("Invalid interaction count".into())
    }
}

/// `value ?? fallback`.
fn or<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    if value.is_nullish() { fallback } else { value }
}

/// `parseInteraction(type, event, occurredAt, receipt)`.
pub fn parse_interaction(kind: &str, event: &Object, occurred_at: &str, receipt: &str) -> Check {
    if !super::INTERACTION_TYPES.iter().any(|(from, _)| *from == kind) {
        return Err("Invalid interaction event".into());
    }
    let poll = kind.starts_with("channel.poll.");
    let ending = kind.ends_with(".end");
    let beginning = kind.ends_with(".begin");
    let status = event.at("status").to_js_string();
    let statuses: &[&str] = if poll {
        &["completed", "terminated", "archived"]
    } else {
        &["resolved", "canceled"]
    };
    if ending && !statuses.contains(&status.as_str()) {
        return Err("Invalid interaction status".into());
    }
    let phase = if ending {
        status.as_str()
    } else if kind.ends_with(".lock") {
        "locked"
    } else {
        "active"
    };
    let raw = event.at(if poll { "choices" } else { "outcomes" });
    let Value::Array(raw) = raw else {
        return Err("Invalid interaction choices".into());
    };
    if raw.len() < 2 || raw.len() > if poll { 5 } else { 10 } {
        return Err("Invalid interaction choices".into());
    }
    let zero = Value::Number(0.0);
    let missing = Value::Undefined;
    let begin_default = if beginning { &zero } else { &missing };
    let mut ids: Vec<&str> = Vec::with_capacity(raw.len());
    for choice in raw {
        if !choice.truthy() || !is_object_like(choice) {
            return Err("Invalid interaction choice".into());
        }
        let votes = if poll {
            interaction_count(or(choice.at("votes"), begin_default))?
        } else {
            0.0
        };
        let channel_points_votes = if poll {
            interaction_count(or(choice.at("channel_points_votes"), &zero))?
        } else {
            0.0
        };
        if channel_points_votes > votes {
            return Err("Channel Points votes exceed total votes".into());
        }
        ids.push(interaction_text(choice.at("id"), 100)?);
        interaction_text(choice.at("title"), 200)?;
        if !poll {
            interaction_count(or(choice.at("users"), begin_default))?;
            interaction_count(or(choice.at("channel_points"), begin_default))?;
        }
    }
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != ids.len() {
        return Err("Duplicate interaction choices".into());
    }
    if !poll && phase == "resolved" {
        let winner = interaction_text(event.at("winning_outcome_id"), 100)?;
        if !ids.contains(&winner) {
            return Err("Invalid winning outcome".into());
        }
    }
    if phase == "locked" {
        interaction_time(event.at("locked_at"))?;
    }
    interaction_text(event.at("id"), 100)?;
    interaction_text(event.at("title"), 200)?;
    interaction_time(event.at("started_at"))?;
    let terminal = phase != "active" && phase != "locked";
    if !(terminal || phase == "locked") {
        interaction_time(event.at(if poll { "ends_at" } else { "locks_at" }))?;
    }
    if ending {
        interaction_time(event.at("ended_at"))?;
    }
    interaction_time(&Value::from(occurred_at))?;
    interaction_text(&Value::from(receipt), 200)?;
    Ok(())
}

/// `typeof value === 'object' && !Array.isArray(value)` (after the truthiness check).
fn is_object_like(value: &Value) -> bool {
    matches!(
        value,
        Value::Object(_) | Value::Date(_) | Value::ObjectId(_) | Value::Other
    )
}

// --- hype trains and ad breaks ----------------------------------------------------------------

fn live_text(value: &Value, max: usize) -> Result<&str, String> {
    match value {
        Value::String(text) if !dima_text::trim(text).is_empty() && utf16_len(text) <= max => Ok(text),
        _ => Err("Invalid live event text".into()),
    }
}

fn live_time(value: &Value) -> Check {
    let text = live_text(value, 40)?;
    if starts_with_date(text) && parse_date(text).is_some() {
        Ok(())
    } else {
        Err("Invalid live event timestamp".into())
    }
}

fn is_optional(value: &Value) -> bool {
    value.is_nullish() || matches!(value, Value::String(text) if text.is_empty())
}

fn optional_live_time(value: &Value) -> Result<bool, String> {
    if is_optional(value) {
        return Ok(false);
    }
    live_time(value)?;
    Ok(true)
}

/// `/^\d{1,15}$/`.
fn integer_text(text: &str) -> bool {
    (1..=15).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

/// The live-event and goal `count`: integers and integer strings.
fn quoted_count(value: &Value) -> bool {
    match value {
        Value::String(text) if integer_text(text) => true,
        other => safe_count(other),
    }
}

fn live_count(value: &Value) -> Check {
    if quoted_count(value) {
        Ok(())
    } else {
        Err("Invalid live event count".into())
    }
}

fn optional_live_count(value: &Value) -> Result<bool, String> {
    if is_optional(value) {
        return Ok(false);
    }
    live_count(value)?;
    Ok(true)
}

/// `list(raw)`.
fn list(raw: &Value) -> Vec<&Value> {
    match raw {
        Value::Undefined | Value::Null => Vec::new(),
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

/// `parseHypeTrain(type, event, occurredAt)`.
pub fn parse_hype_train(kind: &str, event: &Object, occurred_at: &str) -> Check {
    if !super::HYPE_TRAIN_TYPES.iter().any(|(from, _)| *from == kind) {
        return Err("Invalid hype train event".into());
    }
    let ended = kind == "channel.hype_train.end";
    for raw in list(event.at("top_contributions")).into_iter().take(10) {
        // `raw && typeof raw === 'object' ? raw : {}`: a primitive reads as an empty record.
        let total = if raw.truthy() && !matches!(raw, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
            raw.at("total")
        } else {
            &Value::Undefined
        };
        optional_live_count(total)?;
    }
    let high = optional_live_count(event.at("all_time_high_level"))?;
    live_text(event.at("id"), 100)?;
    live_count(event.at("level"))?;
    live_count(event.at("total"))?;
    if !ended {
        optional_live_count(event.at("progress"))?;
        optional_live_count(event.at("goal"))?;
    }
    if high {
        optional_live_count(event.at("all_time_high_total"))?;
    }
    live_time(event.at("started_at"))?;
    if ended {
        if !optional_live_time(event.at("ended_at"))? {
            live_time(&Value::from(occurred_at))?;
        }
        optional_live_time(event.at("cooldown_ends_at"))?;
    } else {
        optional_live_time(event.at("expires_at"))?;
    }
    Ok(())
}

/// `parseAdBreak(event)`.
pub fn parse_ad_break(event: &Object) -> Check {
    live_time(event.at("started_at"))?;
    live_count(event.at("duration_seconds"))
}

// --- Twitch goals -----------------------------------------------------------------------------

/// `parseTwitchGoalEvent(subscriptionType, event)`.
pub fn parse_twitch_goal_event(kind: &str, event: &Object) -> Check {
    if !super::TWITCH_GOAL_TYPES.iter().any(|(from, _)| *from == kind) {
        return Err("Invalid Twitch goal event".into());
    }
    let id_ok = event.at("id").as_str().is_some_and(|id| {
        (1..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    if !id_ok {
        return Err("Invalid Twitch goal id".into());
    }
    let goal_type = match event.at("type").as_str() {
        Some("follower") => Some("follow"),
        other => other,
    };
    if !goal_type.is_some_and(|t| {
        matches!(
            t,
            "follow"
                | "subscription"
                | "subscription_count"
                | "new_subscription"
                | "new_subscription_count"
                | "new_bit"
                | "new_cheerer"
        )
    }) {
        return Err("Unknown Twitch goal type".into());
    }
    let goal_count = |value: &Value| {
        if quoted_count(value) {
            Ok(())
        } else {
            Err("Invalid Twitch goal amount".to_owned())
        }
    };
    let goal_time = |value: &Value| match value {
        Value::String(text)
            if utf16_len(text) <= 40 && starts_with_date(text) && parse_date(text).is_some() =>
        {
            Ok(())
        }
        _ => Err("Invalid Twitch goal time".to_owned()),
    };
    goal_count(event.at("current_amount"))?;
    goal_count(event.at("target_amount"))?;
    goal_time(event.at("started_at"))?;
    if kind == "channel.goal.end" && !is_optional(event.at("ended_at")) {
        goal_time(event.at("ended_at"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(json: serde_json::Value) -> Object {
        match Value::from_json(&json) {
            Value::Object(object) => object,
            _ => Object::new(),
        }
    }

    const T: &str = "2026-09-05T12:00:00Z";

    #[test]
    fn polls() {
        let poll = object(json!({
            "id": "p", "title": "Best?", "started_at": T, "ends_at": T,
            "choices": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}]
        }));
        assert_eq!(parse_interaction("channel.poll.begin", &poll, T, "r"), Ok(()));
        assert_eq!(
            parse_interaction("channel.poll.progress", &poll, T, "r"),
            Err("Invalid interaction count".into())
        );
        let mut duplicate = poll.clone();
        duplicate.insert(
            "choices",
            Value::from_json(&json!([{"id": "a", "title": "A"}, {"id": "a", "title": "B"}])),
        );
        assert_eq!(
            parse_interaction("channel.poll.begin", &duplicate, T, "r"),
            Err("Duplicate interaction choices".into())
        );
        assert_eq!(
            parse_interaction("channel.poll.begin", &poll, "undefined", "r"),
            Err("Invalid interaction timestamp".into())
        );
        assert_eq!(
            parse_interaction("channel.poll.begin", &poll, &date_to_string(0.0), "r"),
            Err("Invalid interaction text".into()),
            "a Date's toString() is longer than 40 units"
        );
    }

    #[test]
    fn hype_trains_and_goals() {
        let train = object(json!({"id": "t", "level": "2", "total": 5, "started_at": T, "top_contributions": {"total": "x"}}));
        assert_eq!(
            parse_hype_train("channel.hype_train.begin", &train, T),
            Err("Invalid live event count".into())
        );
        let train = object(json!({"id": "t", "level": "2", "total": 5, "started_at": T}));
        assert_eq!(parse_hype_train("channel.hype_train.end", &train, T), Ok(()));
        assert_eq!(
            parse_hype_train("channel.hype_train.end", &train, "nope"),
            Err("Invalid live event timestamp".into())
        );
        let goal = object(json!({"id": "g-1", "type": "follower", "current_amount": "3", "target_amount": 10, "started_at": T}));
        assert_eq!(parse_twitch_goal_event("channel.goal.progress", &goal, ), Ok(()));
        assert_eq!(date_to_string(1_788_609_600_000.0), "Sat Sep 05 2026 12:00:00 GMT+0000 (Coordinated Universal Time)");
    }
}
