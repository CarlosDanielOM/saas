//! `eventsub.functions.ts` and `ad.time`: reads of the triggering event's data.

use crate::context::Context;
use crate::value::Value;
use dima_text::{
    is_js_whitespace, math_round, number_to_string, parse_date, parse_number, to_lower, trim,
};

/// `getEventData(ctx)`: `ctx.eventData || {}`; a field of anything but an object is missing.
fn field<'a>(context: &'a Context, key: &str) -> Option<&'a Value> {
    context.event_data.get(key)
}

/// `getStringField`: the first field that is text with something besides whitespace (returned
/// untrimmed).
fn string_field(context: &Context, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| field(context, key).and_then(Value::as_str))
        .find(|text| !trim(text).is_empty())
        .map(str::to_owned)
        .unwrap_or_default()
}

/// `getNumberField`: the first finite number, or text that `Number()` reads as one.
fn number_field(context: &Context, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| match field(context, key) {
        Some(Value::Number(number)) if number.is_finite() => Some(*number),
        Some(Value::Text(text)) => Some(parse_number(text)).filter(|n| n.is_finite()),
        _ => None,
    })
}

/// `getBooleanField`: the first boolean, or `true`/`false` text.
fn boolean_field(context: &Context, keys: &[&str]) -> bool {
    for key in keys {
        match field(context, key) {
            Some(Value::Bool(flag)) => return *flag,
            Some(Value::Text(text)) => match to_lower(trim(text)).as_str() {
                "true" => return true,
                "false" => return false,
                _ => {}
            },
            _ => {}
        }
    }
    false
}

fn number_or_zero(number: Option<f64>) -> String {
    number_to_string(number.unwrap_or(0.0))
}

fn or_unknown(text: String) -> String {
    if text.is_empty() {
        "unknown".into()
    } else {
        text
    }
}

/// `$(raid.viewers)`.
pub(crate) fn raid_viewers(context: &Context) -> String {
    number_or_zero(number_field(context, &["viewers"]))
}

fn outgoing(context: &Context) -> bool {
    field(context, "raid_direction").and_then(Value::as_str) == Some("outgoing")
}

/// `$(raid.channel)`.
pub(crate) fn raid_channel(context: &Context) -> String {
    let keys: &[&str] = if outgoing(context) {
        &["to_broadcaster_user_name", "to_broadcaster_user_login"]
    } else {
        &["from_broadcaster_user_name", "from_broadcaster_user_login"]
    };
    or_unknown(string_field(context, keys))
}

/// `$(raid.login)`.
pub(crate) fn raid_login(context: &Context) -> String {
    let key = if outgoing(context) {
        "to_broadcaster_user_login"
    } else {
        "from_broadcaster_user_login"
    };
    or_unknown(string_field(context, &[key]))
}

/// `$(cheer.amount)`: `cheer.bits` when it is a number (any number), else `bits`.
pub(crate) fn cheer_amount(context: &Context) -> String {
    let from_cheer = field(context, "cheer")
        .filter(|cheer| cheer.js_truthy())
        .and_then(|cheer| match cheer.get("bits") {
            Some(Value::Number(bits)) => Some(*bits),
            _ => None,
        });
    number_or_zero(from_cheer.or_else(|| number_field(context, &["bits"])))
}

/// `$(cheer.message)`: `message.text` when it is text, else a non-blank `message`.
pub(crate) fn cheer_message(context: &Context) -> String {
    let text = field(context, "message")
        .filter(|message| message.js_truthy())
        .and_then(|message| message.get("text"))
        .and_then(Value::as_str);
    match text {
        Some(text) => text.to_owned(),
        None => string_field(context, &["message"]),
    }
}

/// `formatSubscriptionTier`.
pub(crate) fn sub_tier(context: &Context) -> String {
    let raw = string_field(context, &["tier", "sub_tier", "subscription_tier"]);
    let normalized: String = to_lower(trim(&raw))
        .chars()
        .filter(|ch| !(is_js_whitespace(*ch) || matches!(ch, '_' | '-')))
        .collect();
    let plan = to_lower(trim(&string_field(
        context,
        &["sub_plan_name", "plan_name", "subscription_plan_name"],
    )));
    let prime = boolean_field(context, &["is_prime", "prime", "is_prime_sub"])
        || normalized == "prime"
        || plan.contains("prime");
    if prime {
        return "Prime".into();
    }
    match normalized.as_str() {
        "1000" | "tier1" => "Tier 1".into(),
        "2000" | "tier2" => "Tier 2".into(),
        "3000" | "tier3" => "Tier 3".into(),
        _ if raw.is_empty() => "unknown".into(),
        _ => raw,
    }
}

/// `$(sub.months)`.
pub(crate) fn sub_months(context: &Context) -> String {
    number_or_zero(number_field(
        context,
        &["cumulative_months", "streak_months", "months"],
    ))
}

/// `Number.isSafeInteger(n) && n >= 0`.
fn safe_count(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n))
            if n.trunc() == *n && n.abs() <= 9_007_199_254_740_991.0 && *n >= 0.0 =>
        {
            number_to_string(*n)
        }
        _ => "0".into(),
    }
}

/// `$(twitch.streak)`: `watch_streak.streak_count`.
pub(crate) fn watch_streak(context: &Context) -> String {
    match field(context, "watch_streak") {
        Some(object @ Value::Object(_)) => safe_count(object.get("streak_count")),
        _ => "0".into(),
    }
}

/// `$(twitch.modiversary)`: `modiversary.months`.
pub(crate) fn modiversary(context: &Context) -> String {
    match field(context, "modiversary") {
        Some(object @ Value::Object(_)) => safe_count(object.get("months")),
        _ => "0".into(),
    }
}

/// `$(ban.time)`: a timeout's length in seconds (`ends_at - banned_at`), 0 for a permanent ban
/// or missing or invalid times. `Date.parse` reads ISO 8601 and HTTP dates (decision log).
pub(crate) fn ban_time(context: &Context) -> String {
    if field(context, "is_permanent") != Some(&Value::Bool(false)) {
        return "0".into();
    }
    let start = string_field(context, &["banned_at"]);
    let end = string_field(context, &["ends_at"]);
    if start.is_empty() || end.is_empty() {
        return "0".into();
    }
    let (Some(start), Some(end)) = (parse_date(&start), parse_date(&end)) else {
        return "0".into();
    };
    let millis = (end as f64) - (start as f64);
    if !millis.is_finite() || millis <= 0.0 {
        return "0".into();
    }
    let seconds = math_round(millis / 1000.0);
    if seconds.abs() <= 9_007_199_254_740_991.0 {
        number_to_string(seconds)
    } else {
        "0".into()
    }
}

/// `$(gifted.user)`.
pub(crate) fn gifted_user(context: &Context) -> String {
    or_unknown(string_field(
        context,
        &[
            "recipient_user_name",
            "recipient_user_login",
            "user_name",
            "user_login",
        ],
    ))
}

/// `$(hypetrain.progress)`.
pub(crate) fn hype_train_progress(context: &Context) -> String {
    number_or_zero(number_field(context, &["progress", "total", "goal"]))
}

/// `$(hypetrain.level)`.
pub(crate) fn hype_train_level(context: &Context) -> String {
    number_or_zero(number_field(context, &["level"]))
}

/// `$(hypetrain.end)`.
pub(crate) fn hype_train_end(context: &Context) -> String {
    or_unknown(string_field(
        context,
        &["ends_at", "ended_at", "cooldown_ends_at"],
    ))
}

/// `$(shoutout.channel)`.
pub(crate) fn shoutout_channel(context: &Context) -> String {
    or_unknown(string_field(
        context,
        &[
            "from_broadcaster_user_name",
            "from_broadcaster_user_login",
            "broadcaster_user_name",
            "broadcaster_user_login",
        ],
    ))
}

/// `$(reward.input)`.
pub(crate) fn reward_input(context: &Context) -> String {
    string_field(context, &["user_input", "reward_input"])
}

/// `$(ad.time)` (`adHandler` in `channel.functions.ts`): `duration_seconds` when truthy.
pub(crate) fn ad_time(context: &Context) -> String {
    match field(context, "duration_seconds").filter(|value| value.js_truthy()) {
        Some(value) => {
            let text = value.to_text();
            if text.is_empty() {
                "0".into()
            } else {
                text.into_owned()
            }
        }
        None => "0".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(entries: Vec<(&str, Value)>) -> Context {
        Context {
            event_data: Value::object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), v))
                    .collect(),
            ),
            ..Context::default()
        }
    }

    #[test]
    fn event_accessors() {
        assert_eq!(
            raid_viewers(&with(vec![("viewers", Value::text(" 42 "))])),
            "42"
        );
        assert_eq!(raid_channel(&with(vec![])), "unknown");
        assert_eq!(
            raid_channel(&with(vec![
                ("raid_direction", Value::text("outgoing")),
                ("to_broadcaster_user_login", Value::text("x"))
            ])),
            "x"
        );
        assert_eq!(
            sub_tier(&with(vec![("tier", Value::text("1000"))])),
            "Tier 1"
        );
        assert_eq!(
            sub_tier(&with(vec![("tier", Value::text("Tier_2"))])),
            "Tier 2"
        );
        assert_eq!(
            sub_tier(&with(vec![("sub_plan_name", Value::text("Prime Gaming"))])),
            "Prime"
        );
        assert_eq!(sub_tier(&with(vec![("tier", Value::text("gold"))])), "gold");
        assert_eq!(
            cheer_amount(&with(vec![(
                "cheer",
                Value::object(vec![("bits".into(), Value::Number(7.0))])
            )])),
            "7"
        );
        assert_eq!(
            watch_streak(&with(vec![(
                "watch_streak",
                Value::object(vec![("streak_count".into(), Value::Number(3.0))])
            )])),
            "3"
        );
        assert_eq!(
            ban_time(&with(vec![
                ("is_permanent", Value::Bool(false)),
                ("banned_at", Value::text("2026-01-01T00:00:00Z")),
                ("ends_at", Value::text("2026-01-01T00:10:00.400Z")),
            ])),
            "600"
        );
        assert_eq!(
            ban_time(&with(vec![("is_permanent", Value::Bool(true))])),
            "0"
        );
        assert_eq!(
            ad_time(&with(vec![("duration_seconds", Value::Number(90.0))])),
            "90"
        );
    }
}
