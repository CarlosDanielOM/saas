//! A read-only view of an untyped stored value as JavaScript would see it.
//!
//! Permission expressions and some settings are stored as Mongoose `Mixed` values, so the
//! reference inspects them with `typeof`, `Array.isArray` and `Object.keys`. They reach Rust as
//! JSON (API bodies, fixtures) or as raw BSON (`dima-model` keeps `Mixed` paths as [`bson::Bson`]).
//! [`JsView`] gives both the same JavaScript reading, so one validator serves both.
//!
//! BSON values that are JavaScript objects but not plain documents (ObjectId, Date, Binary,
//! Decimal128, regular expressions and the rest) read as [`Js::Other`]. JavaScript would see an
//! object with no recognised operator key there; this crate treats them the same way: they are
//! never valid expression nodes.

use dima_text::number_to_string;

/// What a value is, as `typeof` and `Array.isArray` tell it.
#[derive(Debug)]
pub enum Js<'a, V> {
    /// `undefined` (BSON's deprecated undefined).
    Undefined,
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number (BSON int32, int64 and double all read as JavaScript numbers).
    Number(f64),
    /// A string.
    String(&'a str),
    /// An array.
    Array(&'a [V]),
    /// A plain object; read its keys with [`JsView::keys`].
    Object,
    /// Any other object (ObjectId, Date, binary data...).
    Other,
}

/// A JavaScript reading of an untyped value. Implemented for [`serde_json::Value`] and
/// [`bson::Bson`].
pub trait JsView: Sized {
    /// The kind of value.
    fn js(&self) -> Js<'_, Self>;
    /// The keys of a plain object in stored order (empty for anything else).
    fn keys(&self) -> Vec<&str>;
    /// A property of a plain object.
    fn get(&self, key: &str) -> Option<&Self>;
}

impl JsView for serde_json::Value {
    fn js(&self) -> Js<'_, Self> {
        use serde_json::Value;
        match self {
            Value::Null => Js::Null,
            Value::Bool(flag) => Js::Bool(*flag),
            Value::Number(number) => Js::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => Js::String(text),
            Value::Array(items) => Js::Array(items),
            Value::Object(_) => Js::Object,
        }
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            serde_json::Value::Object(map) => map.keys().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            serde_json::Value::Object(map) => map.get(key),
            _ => None,
        }
    }
}

impl JsView for bson::Bson {
    fn js(&self) -> Js<'_, Self> {
        use bson::Bson;
        match self {
            Bson::Undefined => Js::Undefined,
            Bson::Null => Js::Null,
            Bson::Boolean(flag) => Js::Bool(*flag),
            Bson::Int32(n) => Js::Number(f64::from(*n)),
            // Mongoose reads int64 with `promoteLongs`: a JavaScript number, rounded.
            Bson::Int64(n) => Js::Number(*n as f64),
            Bson::Double(n) => Js::Number(*n),
            Bson::String(text) | Bson::Symbol(text) => Js::String(text),
            Bson::Array(items) => Js::Array(items),
            Bson::Document(_) => Js::Object,
            _ => Js::Other,
        }
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            bson::Bson::Document(document) => document.keys().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            bson::Bson::Document(document) => document.get(key),
            _ => None,
        }
    }
}

/// `Object.keys(value)`: integer-like keys first in ascending order, then the rest in stored
/// order (JavaScript's own property order).
pub(crate) fn js_object_keys<V: JsView>(value: &V) -> Vec<&str> {
    let mut keys = value.keys();
    // A stable sort keeps stored order among the non-index keys.
    keys.sort_by_key(|key| array_index(key).map_or((1, 0), |index| (0, index)));
    keys
}

/// A canonical array index (`"0"`, `"17"`, not `"01"`), below 2^32 - 1.
fn array_index(key: &str) -> Option<u64> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|index| *index < u64::from(u32::MAX))
}

/// `String(value)`. Objects read `[object Object]`; `null` and `undefined` inside an array
/// read as empty text. Iterative, so a deeply nested array cannot exhaust the stack.
pub(crate) fn js_string<V: JsView>(value: &V) -> String {
    enum Step<'a, V> {
        Value(&'a V),
        Comma,
    }
    let mut out = String::new();
    let mut steps = vec![Step::Value(value)];
    while let Some(step) = steps.pop() {
        let value = match step {
            Step::Comma => {
                out.push(',');
                continue;
            }
            Step::Value(value) => value,
        };
        match value.js() {
            Js::Undefined => out.push_str("undefined"),
            Js::Null => out.push_str("null"),
            Js::Bool(flag) => out.push_str(if flag { "true" } else { "false" }),
            Js::Number(number) => out.push_str(&number_to_string(number)),
            Js::String(text) => out.push_str(text),
            Js::Object | Js::Other => out.push_str("[object Object]"),
            Js::Array(items) => {
                for (index, item) in items.iter().enumerate().rev() {
                    if !matches!(item.js(), Js::Null | Js::Undefined) {
                        steps.push(Step::Value(item));
                    }
                    if index > 0 {
                        steps.push(Step::Comma);
                    }
                }
            }
        }
    }
    out
}

/// `Number(value)`: strings through [`dima_text::parse_number`], booleans 0 or 1, `null` 0,
/// arrays through their text, other objects and `undefined` NaN.
pub(crate) fn js_number<V: JsView>(value: &V) -> f64 {
    match value.js() {
        Js::Number(number) => number,
        Js::Null => 0.0,
        Js::Bool(flag) => f64::from(u8::from(flag)),
        Js::String(text) => dima_text::parse_number(text),
        Js::Array(_) => dima_text::parse_number(&js_string(value)),
        Js::Undefined | Js::Object | Js::Other => f64::NAN,
    }
}

/// JavaScript truthiness (`!value` is false).
pub(crate) fn js_truthy<V: JsView>(value: &V) -> bool {
    match value.js() {
        Js::Undefined | Js::Null => false,
        Js::Bool(flag) => flag,
        Js::Number(number) => number != 0.0 && !number.is_nan(),
        Js::String(text) => !text.is_empty(),
        Js::Array(_) | Js::Object | Js::Other => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_follow_javascript_property_order() {
        let value = json!({"role": 1, "10": 2, "b": 3, "2": 4, "01": 5});
        assert_eq!(js_object_keys(&value), ["2", "10", "role", "b", "01"]);
    }

    #[test]
    fn string_of_matches_javascript() {
        assert_eq!(js_string(&json!([1, null, [2, null], "x"])), "1,,2,,x");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&bson::Bson::Undefined), "undefined");
        let deep = (0..1_000).fold(json!(1), |inner, _| json!([inner]));
        assert_eq!(js_string(&deep), "1");
    }

    #[test]
    fn bson_numbers_read_as_javascript_numbers() {
        assert!(matches!(bson::Bson::Int32(7).js(), Js::Number(n) if n == 7.0));
        assert!(matches!(bson::Bson::Int64(7).js(), Js::Number(n) if n == 7.0));
        assert!(matches!(
            bson::Bson::ObjectId(bson::oid::ObjectId::new()).js(),
            Js::Other
        ));
    }
}
