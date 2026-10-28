//! Pure Twitch custom-reward field mapping and validation.
//!
//! Ordinary JSON object properties mirror the HTTP request body; missing fields
//! model undefined and explicit JSON null retains the source's separate rules.
//! Unknown fields are preserved. Nothing reads or changes reward storage.

use serde_json::{Map, Value};

pub const MAX_GLOBAL_COOLDOWN_SECONDS: u32 = 604_800;
pub const TWITCH_ONLY_REWARD_FIELDS: [&str; 7] = [
    "background_color",
    "backgroundColor",
    "isPaused",
    "maxPerStream",
    "maxPerUserPerStream",
    "skipQueue",
    "userInput",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TwitchRewardBodyMode {
    Create,
    #[default]
    Update,
}

/// Maps a borrowed request body, preserving caller-owned input.
pub fn to_twitch_reward_body(
    body: &Map<String, Value>,
    mode: TwitchRewardBodyMode,
) -> Map<String, Value> {
    to_twitch_reward_body_owned(body.clone(), mode)
}

/// Maps an owned body in place, avoiding a full request clone in HTTP handlers.
pub fn to_twitch_reward_body_owned(
    mut body: Map<String, Value>,
    mode: TwitchRewardBodyMode,
) -> Map<String, Value> {
    if let Some(value) = body.remove("isEnabled") {
        body.insert("is_enabled".into(), value);
    }
    if let Some(value) = body.remove("skipQueue").filter(Value::is_boolean) {
        body.insert("should_redemptions_skip_request_queue".into(), value);
    }
    if let Some(value) = body.remove("cooldown") {
        let seconds = to_limit(&value);
        if seconds > 0.0 {
            body.insert("is_global_cooldown_enabled".into(), Value::Bool(true));
            body.insert("global_cooldown_seconds".into(), Value::from(seconds));
        } else if !value.is_null() {
            body.insert("is_global_cooldown_enabled".into(), Value::Bool(false));
            body.insert("global_cooldown_seconds".into(), Value::from(0));
        }
    }
    if let Some(value) = body.remove("userInput") {
        body.insert("is_user_input_required".into(), value);
    }
    for (source, enabled, limit_key) in [
        (
            "maxPerStream",
            "is_max_per_stream_enabled",
            "max_per_stream",
        ),
        (
            "maxPerUserPerStream",
            "is_max_per_user_per_stream_enabled",
            "max_per_user_per_stream",
        ),
    ] {
        if let Some(value) = body.remove(source) {
            let limit = to_limit(&value);
            body.insert(enabled.into(), Value::Bool(limit > 0.0));
            if limit > 0.0 {
                body.insert(limit_key.into(), Value::from(limit));
            }
        }
    }
    if let Some(value) = body.remove("isPaused").filter(Value::is_boolean)
        && mode == TwitchRewardBodyMode::Update
    {
        body.insert("is_paused".into(), value);
    }
    body
}

fn to_limit(value: &Value) -> f64 {
    let value = super::json_number::to_number(value);
    // Only positive rounded results survive, so negative-half signed-zero
    // differences have no observable result here. Avoid x + 0.5 rounding up
    // an already integral 2^52..2^53 input.
    let rounded = if value.fract() >= 0.5 {
        value.ceil()
    } else {
        value.floor()
    };
    if rounded.is_finite() && rounded > 0.0 {
        rounded
    } else {
        0.0
    }
}

fn is_whole_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|value| {
        value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
    })
}

/// First invalid setting in the same validation order as TypeScript.
pub fn validate_reward_settings(body: &Map<String, Value>) -> Option<String> {
    if let Some(value) = body.get("cooldown").filter(|value| !value.is_null())
        && (!is_whole_number(value)
            || !value.as_f64().is_some_and(|value| {
                (0.0..=f64::from(MAX_GLOBAL_COOLDOWN_SECONDS)).contains(&value)
            }))
    {
        return Some(format!(
            "Cooldown must be a whole number of seconds from 0 to {MAX_GLOBAL_COOLDOWN_SECONDS} (7 days)"
        ));
    }
    for (key, label) in [
        ("maxPerStream", "Redeems per stream"),
        ("maxPerUserPerStream", "Redeems per viewer per stream"),
    ] {
        if let Some(value) = body.get(key).filter(|value| !value.is_null())
            && (!is_whole_number(value) || !value.as_f64().is_some_and(|value| value >= 0.0))
        {
            return Some(format!(
                "{label} must be a whole number (0 turns the limit off)"
            ));
        }
    }
    if body
        .get("isPaused")
        .is_some_and(|value| !value.is_boolean())
    {
        return Some("isPaused must be true or false".into());
    }
    None
}

pub fn is_twitch_only_reward_update(body: &Map<String, Value>) -> bool {
    !body.is_empty()
        && body
            .keys()
            .all(|key| TWITCH_ONLY_REWARD_FIELDS.contains(&key.as_str()))
}
