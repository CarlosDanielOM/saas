use super::super::value::to_number;
use super::{JsString, JsValue, PureFunction, number_string, whitespace};

pub(super) fn apply(function: PureFunction, event: &JsValue) -> JsString {
    use PureFunction::*;
    match function {
        Modiversary => safe_count(&event.get("modiversary"), "months"),
        WatchStreak => safe_count(&event.get("watch_streak"), "streak_count"),
        RaidChannel => {
            let keys = if outgoing(event) {
                ["to_broadcaster_user_name", "to_broadcaster_user_login"]
            } else {
                ["from_broadcaster_user_name", "from_broadcaster_user_login"]
            };
            or_unknown(string_field(event, &keys))
        }
        RaidLogin => or_unknown(string_field(
            event,
            &[if outgoing(event) {
                "to_broadcaster_user_login"
            } else {
                "from_broadcaster_user_login"
            }],
        )),
        RaidViewers => number_field(event, &["viewers"]),
        CheerAmount => {
            if let JsValue::Number(bits) = event.get("cheer").get("bits") {
                // Source typeof number deliberately permits NaN and infinities.
                number_string(bits).into()
            } else {
                number_field(event, &["bits"])
            }
        }
        CheerMessage => {
            if let JsValue::String(text) = event.get("message").get("text") {
                text
            } else {
                string_field(event, &["message"])
            }
        }
        SubTier => tier(event),
        SubMonths => number_field(event, &["cumulative_months", "streak_months", "months"]),
        GiftedUser => or_unknown(string_field(
            event,
            &[
                "recipient_user_name",
                "recipient_user_login",
                "user_name",
                "user_login",
            ],
        )),
        HypeTrainProgress => number_field(event, &["progress", "total", "goal"]),
        HypeTrainLevel => number_field(event, &["level"]),
        HypeTrainEnd => or_unknown(string_field(
            event,
            &["ends_at", "ended_at", "cooldown_ends_at"],
        )),
        ShoutoutChannel => or_unknown(string_field(
            event,
            &[
                "from_broadcaster_user_name",
                "from_broadcaster_user_login",
                "broadcaster_user_name",
                "broadcaster_user_login",
            ],
        )),
        RewardInput => string_field(event, &["user_input", "reward_input"]),
        _ => unreachable!("EventSub family dispatch"),
    }
}
fn outgoing(event: &JsValue) -> bool {
    matches!(event.get("raid_direction"), JsValue::String(text) if text.units().iter().copied().eq("outgoing".encode_utf16()))
}
fn or_unknown(text: JsString) -> JsString {
    if text.is_empty() {
        "unknown".into()
    } else {
        text
    }
}
fn string_field(event: &JsValue, keys: &[&str]) -> JsString {
    for key in keys {
        if let JsValue::String(text) = event.get(key)
            && text.units().iter().any(|unit| !whitespace(*unit))
        {
            return text;
        }
    }
    JsString::default()
}
fn number_field(event: &JsValue, keys: &[&str]) -> JsString {
    for key in keys {
        let value = event.get(key);
        let number = match &value {
            JsValue::Number(number) => *number,
            JsValue::String(_) => to_number(&value),
            _ => continue,
        };
        if number.is_finite() {
            return number_string(number).into();
        }
    }
    "0".into()
}
fn boolean_field(event: &JsValue, keys: &[&str]) -> bool {
    for key in keys {
        match event.get(key) {
            JsValue::Boolean(value) => return value,
            JsValue::String(text) => {
                let text = text.trim().lower();
                if text.units().iter().copied().eq("true".encode_utf16()) {
                    return true;
                }
                if text.units().iter().copied().eq("false".encode_utf16()) {
                    return false;
                }
            }
            _ => {}
        }
    }
    false
}
fn safe_count(object: &JsValue, key: &str) -> JsString {
    if matches!(object, JsValue::Object(_))
        && let JsValue::Number(number) = object.get(key)
        && number.is_finite()
        && (0.0..=9007199254740991.0).contains(&number)
        && number.fract() == 0.0
    {
        return number_string(number).into();
    }
    "0".into()
}
fn tier(event: &JsValue) -> JsString {
    let raw = string_field(event, &["tier", "sub_tier", "subscription_tier"]);
    let normalized = JsString::from_units(
        raw.trim()
            .lower()
            .units()
            .iter()
            .copied()
            .filter(|unit| !whitespace(*unit) && !matches!(unit, 95 | 45))
            .collect(),
    );
    let plan = string_field(
        event,
        &["sub_plan_name", "plan_name", "subscription_plan_name"],
    )
    .trim()
    .lower();
    let prime = [112, 114, 105, 109, 101];
    if boolean_field(event, &["is_prime", "prime", "is_prime_sub"])
        || normalized.units() == prime
        || plan.units().windows(prime.len()).any(|part| part == prime)
    {
        return "Prime".into();
    }
    match normalized.to_utf8().as_deref() {
        Ok("1000" | "tier1") => "Tier 1".into(),
        Ok("2000" | "tier2") => "Tier 2".into(),
        Ok("3000" | "tier3") => "Tier 3".into(),
        _ => or_unknown(raw),
    }
}
