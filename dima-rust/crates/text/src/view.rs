//! A read-only view of an untyped value as JavaScript sees it: `typeof`, `Array.isArray`,
//! `String(value)`, `Number(value)`, truthiness and `Object.keys` order.
//!
//! [`JsView`] is implemented here for `serde_json::Value`. A crate whose untyped values are of a
//! type it does not own (raw BSON in `dima-commands`) cannot implement this trait for that type
//! (Rust's orphan rule), so every function also has a `_with` form that takes the reading as a
//! function: the same rules, one implementation.

use crate::json::index_first;
use crate::number::number_to_string;
use crate::parse::parse_number;
use serde_json::Value;

/// What a value is, as `typeof` and `Array.isArray` tell it.
#[derive(Debug)]
pub enum Js<'a, V> {
    /// `undefined`.
    Undefined,
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number.
    Number(f64),
    /// A string.
    String(&'a str),
    /// An array.
    Array(&'a [V]),
    /// A plain object; read its keys with [`JsView::keys`].
    Object,
    /// Any other object (for BSON: ObjectId, Date, binary data...). It reads as an object
    /// (`[object Object]`, truthy, `Number()` is NaN).
    Other,
}

/// A JavaScript reading of an untyped value.
pub trait JsView: Sized {
    /// The kind of value.
    fn js(&self) -> Js<'_, Self>;
    /// The keys of a plain object in stored order (empty for anything else).
    fn keys(&self) -> Vec<&str>;
    /// A property of a plain object.
    fn get(&self, key: &str) -> Option<&Self>;
}

impl JsView for Value {
    fn js(&self) -> Js<'_, Self> {
        match self {
            Value::Null => Js::Null,
            Value::Bool(flag) => Js::Bool(*flag),
            // `as_f64` rounds integers beyond 2^53 to the nearest double, as JavaScript holds them.
            Value::Number(number) => Js::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => Js::String(text),
            Value::Array(items) => Js::Array(items),
            Value::Object(_) => Js::Object,
        }
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            Value::Object(map) => map.keys().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }
}

/// `String(value)`: arrays comma-joined with `null` and `undefined` items as empty text (nested
/// arrays likewise), objects `[object Object]`, numbers as [`number_to_string`] writes them.
pub fn js_string<V: JsView>(value: &V) -> String {
    js_string_with(value, V::js)
}

/// `Number(value)`: strings through [`parse_number`], booleans 0 or 1, `null` 0, arrays through
/// their text, other objects and `undefined` NaN.
pub fn js_number<V: JsView>(value: &V) -> f64 {
    js_number_with(value, V::js)
}

/// JavaScript truthiness (`!value` is false): `false`, `0`, `-0`, `NaN`, `""`, `null` and
/// `undefined` are falsy.
pub fn js_truthy<V: JsView>(value: &V) -> bool {
    js_truthy_with(value, V::js)
}

/// `Object.keys(value)`: array-index keys first in ascending order, then the rest in stored
/// order (JavaScript's own property order). Empty for anything but a plain object.
pub fn js_object_keys<V: JsView>(value: &V) -> Vec<&str> {
    js_property_order(value.keys())
}

/// [`js_string`] with the reading given as a function. Iterative, so a deeply nested array
/// cannot exhaust the stack.
pub fn js_string_with<V>(value: &V, js: impl Fn(&V) -> Js<'_, V>) -> String {
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
        match js(value) {
            Js::Undefined => out.push_str("undefined"),
            Js::Null => out.push_str("null"),
            Js::Bool(flag) => out.push_str(if flag { "true" } else { "false" }),
            Js::Number(number) => out.push_str(&number_to_string(number)),
            Js::String(text) => out.push_str(text),
            Js::Object | Js::Other => out.push_str("[object Object]"),
            Js::Array(items) => {
                for (index, item) in items.iter().enumerate().rev() {
                    if !matches!(js(item), Js::Null | Js::Undefined) {
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

/// [`js_number`] with the reading given as a function.
pub fn js_number_with<V>(value: &V, js: impl Fn(&V) -> Js<'_, V>) -> f64 {
    match js(value) {
        Js::Number(number) => number,
        Js::Null => 0.0,
        Js::Bool(flag) => f64::from(u8::from(flag)),
        Js::String(text) => parse_number(text),
        // ToPrimitive of an array is its text.
        Js::Array(_) => parse_number(&js_string_with(value, js)),
        Js::Undefined | Js::Object | Js::Other => f64::NAN,
    }
}

/// [`js_truthy`] with the reading given as a function.
pub fn js_truthy_with<V>(value: &V, js: impl Fn(&V) -> Js<'_, V>) -> bool {
    match js(value) {
        Js::Undefined | Js::Null => false,
        Js::Bool(flag) => flag,
        Js::Number(number) => number != 0.0 && !number.is_nan(),
        Js::String(text) => !text.is_empty(),
        Js::Array(_) | Js::Object | Js::Other => true,
    }
}

/// Puts an object's keys (in stored order) into JavaScript's property order: array-index keys
/// (`"0"` to `"4294967294"`, no leading zeros) first in numeric order, then the rest as they were.
pub fn js_property_order(mut keys: Vec<&str>) -> Vec<&str> {
    // A stable sort keeps stored order among the non-index keys.
    keys.sort_by(|left, right| index_first(left, right));
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_follow_javascript_property_order() {
        let value = json!({"role": 1, "10": 2, "b": 3, "2": 4, "01": 5});
        assert_eq!(js_object_keys(&value), ["2", "10", "role", "b", "01"]);
        assert!(js_object_keys(&json!([1])).is_empty());
    }

    #[test]
    fn string_number_and_truthiness_match_javascript() {
        assert_eq!(js_string(&json!([1, null, [2, null], "x"])), "1,,2,,x");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        let deep = (0..100_000).fold(json!(1), |inner, _| Value::Array(vec![inner]));
        assert_eq!(js_string(&deep), "1");
        assert_eq!(js_number(&json!(["0x1F"])), 31.0);
        assert!(js_number(&json!({})).is_nan());
        assert!(!js_truthy(&json!(-0.0)));
        assert!(js_truthy(&json!("0")));
        // Taken apart by hand: `serde_json::Value` drops recursively.
        let mut deep = deep;
        while let Value::Array(mut items) = deep {
            deep = items.pop().unwrap_or_default();
        }
    }
}
