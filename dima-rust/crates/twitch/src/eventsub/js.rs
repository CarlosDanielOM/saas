#![allow(dead_code)] // The rest is used by the create and reconcile paths (part 2).
//! Stored BSON as a `.lean()` read shows it to JavaScript (`String(x || '')`, `Number(x || 0)`,
//! `Boolean(x)`), through `dima-text`'s readings.

use bson::Bson;
use dima_text::Js;

/// What `typeof` sees.
pub(crate) fn js(value: &Bson) -> Js<'_, Bson> {
    match value {
        Bson::Null => Js::Null,
        Bson::Undefined => Js::Undefined,
        Bson::Boolean(flag) => Js::Bool(*flag),
        Bson::Int32(number) => Js::Number(f64::from(*number)),
        // The driver reads an int64 as a JavaScript number (`promoteLongs`).
        #[allow(clippy::cast_precision_loss)]
        Bson::Int64(number) => Js::Number(*number as f64),
        Bson::Double(number) => Js::Number(*number),
        Bson::String(text) => Js::String(text),
        Bson::Array(items) => Js::Array(items),
        Bson::Document(_) => Js::Object,
        _ => Js::Other,
    }
}

/// `Boolean(value)` (a missing value is `undefined`: false).
pub(crate) fn truthy(value: Option<&Bson>) -> bool {
    value.is_some_and(|value| dima_text::js_truthy_with(value, js))
}

/// `String(value || '')`.
pub(crate) fn string_or_empty(value: Option<&Bson>) -> String {
    match value {
        Some(value) if truthy(Some(value)) => dima_text::js_string_with(value, js),
        _ => String::new(),
    }
}

/// `Number(value || 0)`.
pub(crate) fn number_or_zero(value: Option<&Bson>) -> f64 {
    match value {
        Some(value) if truthy(Some(value)) => dima_text::js_number_with(value, js),
        _ => 0.0,
    }
}

/// `typeof value === 'number'` with its value.
pub(crate) fn number(value: Option<&Bson>) -> Option<f64> {
    match value.map(js) {
        Some(Js::Number(number)) => Some(number),
        _ => None,
    }
}

/// A JavaScript number as JSON (`JSON.stringify` writes `NaN` and infinities as `null`).
pub(crate) fn json_number(number: f64) -> serde_json::Value {
    dima_text::js_number_value(number)
}

/// Stored BSON as the JSON `JSON.stringify` writes for a `.lean()` value (ObjectIds as hex,
/// dates as ISO text, numbers as JavaScript numbers).
pub(crate) fn to_json(value: &Bson) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Boolean(flag) => Value::Bool(*flag),
        Bson::Int32(number) => Value::from(*number),
        Bson::Int64(number) => json_number({
            #[allow(clippy::cast_precision_loss)]
            let n = *number as f64;
            n
        }),
        Bson::Double(number) => json_number(*number),
        Bson::String(text) => Value::String(text.clone()),
        Bson::Array(items) => Value::Array(items.iter().map(to_json).collect()),
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect(),
        ),
        Bson::ObjectId(id) => Value::String(id.to_hex()),
        Bson::DateTime(date) => {
            dima_text::to_iso_string(date.timestamp_millis()).map_or(Value::Null, Value::String)
        }
        other => other.clone().into_relaxed_extjson(),
    }
}

/// JSON as the Node driver writes it to BSON: what `$set` of a value from `response.json()`
/// stores (numbers are typed later by the write helpers, as Node types them).
pub(crate) fn from_json(value: &serde_json::Value) -> Bson {
    use serde_json::Value;
    match value {
        Value::Null => Bson::Null,
        Value::Bool(flag) => Bson::Boolean(*flag),
        Value::Number(number) => number.as_i64().map_or_else(
            || Bson::Double(number.as_f64().unwrap_or(f64::NAN)),
            Bson::Int64,
        ),
        Value::String(text) => Bson::String(text.clone()),
        Value::Array(items) => Bson::Array(items.iter().map(from_json).collect()),
        Value::Object(map) => Bson::Document(
            map.iter()
                .map(|(key, value)| (key.clone(), from_json(value)))
                .collect(),
        ),
    }
}
