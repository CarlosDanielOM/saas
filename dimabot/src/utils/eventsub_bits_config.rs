//! Merge canonical and legacy Bits notification settings without persistence.
//!
//! The input is the same JSON object shape as `Partial<IEventsub>`; absent
//! properties and explicit nulls stay distinct. Each field chooses its first
//! customized legacy value only when the canonical value is still a default.

use super::js_compat::trim as js_trim;
use serde_json::{Map, Value};

const CONFIG_FIELDS: [&str; 8] = [
    "enabled",
    "message",
    "endMessage",
    "endEnabled",
    "clipEnabled",
    "minViewers",
    "delay",
    "cheerTiers",
];

/// Complete JSON equivalent of `buildBitsEventsubConfig`.
///
/// This borrows all candidates and clones only the eight selected values;
/// unlike the source, it allocates no intermediate legacy arrays per field.
pub fn build_bits_eventsub_config(
    canonical: Option<&Value>,
    legacy: &[Value],
) -> Map<String, Value> {
    CONFIG_FIELDS
        .into_iter()
        .filter_map(|key| {
            let canonical_value = canonical.and_then(|value| value.get(key));
            let legacy_custom = legacy
                .iter()
                .filter_map(|value| value.get(key))
                .find(|value| is_custom_value(key, value));
            let selected = if canonical_value.is_some_and(|value| is_custom_value(key, value)) {
                canonical_value
            } else if legacy_custom.is_some() {
                legacy_custom
            } else {
                canonical_value
                    .filter(|value| !value.is_null())
                    .or_else(|| legacy.iter().find_map(|value| value.get(key)))
            };
            selected.map(|value| (key.to_owned(), value.clone()))
        })
        .collect()
}

fn is_custom_value(key: &str, value: &Value) -> bool {
    match key {
        "enabled" => value == &Value::Bool(false),
        "message" | "endMessage" => value
            .as_str()
            .is_some_and(|value| !js_trim(value).is_empty()),
        "endEnabled" | "clipEnabled" => value == &Value::Bool(true),
        "minViewers" => value
            .as_f64()
            .is_some_and(|value| value.is_finite() && value != 2.0),
        "delay" => value
            .as_f64()
            .is_some_and(|value| value.is_finite() && value != 0.0),
        "cheerTiers" => value.as_array().is_some_and(|value| !value.is_empty()),
        _ => false,
    }
}
