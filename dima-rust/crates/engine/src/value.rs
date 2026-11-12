//! The values the command language computes with.
//!
//! Almost every value is text. The others come from JSON: an item of a stored list
//! (`%(list[0])` of `[1,null,{"a":2}]` is the number 1, then `null`, then an object), and what a
//! host function hands back. [`Value`] is that JSON data model plus `undefined` and the
//! non-finite numbers a host may produce, so that the language's conversions (`String()`,
//! `Number()`, truthiness, `JSON.stringify`) give what the reference gives for the same data.
//!
//! Objects keep JavaScript's enumeration order: array-index keys (`"0"`, `"10"`) first in
//! numeric order, then the other keys in insertion order. [`Value::object`] and the JSON reader
//! apply it, so every object in the engine is already in that order.

use dima_text::number_to_string;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use std::borrow::Cow;
use std::fmt;

/// A value of the command language.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Value {
    /// `undefined`: a missing value.
    #[default]
    Undefined,
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number (any double, including NaN and the infinities a host may return).
    Number(f64),
    /// Text: what nearly every expression produces.
    Text(String),
    /// A list (`%[a, b]`, a stored list, a nested JSON array).
    List(Vec<Value>),
    /// An object, keys unique and in JavaScript enumeration order (see [`Value::object`]).
    Object(Vec<(String, Value)>),
}

impl Value {
    /// Text.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(text.into())
    }

    /// The empty text, what most statements evaluate to.
    pub fn empty() -> Self {
        Self::Text(String::new())
    }

    /// `"true"` or `"false"`, as the language's tests and comparisons answer.
    pub fn flag(value: bool) -> Self {
        Self::text(if value { "true" } else { "false" })
    }

    /// An object from entries in insertion order: a repeated key keeps its first position and
    /// its last value (as assigning the key again does), and array-index keys move to the front.
    pub fn object(entries: Vec<(String, Value)>) -> Self {
        let mut unique: Vec<(String, Value)> = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            if let Some(slot) = unique.iter_mut().find(|(existing, _)| *existing == key) {
                slot.1 = value;
            } else {
                unique.push((key, value));
            }
        }
        js_key_order(&mut unique);
        Self::Object(unique)
    }

    /// `value === undefined || value === null`.
    pub fn is_nullish(&self) -> bool {
        matches!(self, Self::Undefined | Self::Null)
    }

    /// `Array.isArray(value)`.
    pub fn is_list(&self) -> bool {
        matches!(self, Self::List(_))
    }

    /// The text, when this is text.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    /// An own property of an object (`value[key]` for an object; `None` for anything else).
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// `String(value)`.
    pub fn to_text(&self) -> Cow<'_, str> {
        match self {
            Self::Text(text) => Cow::Borrowed(text),
            Self::Undefined => Cow::Borrowed("undefined"),
            Self::Null => Cow::Borrowed("null"),
            Self::Bool(true) => Cow::Borrowed("true"),
            Self::Bool(false) => Cow::Borrowed("false"),
            Self::Number(number) => Cow::Owned(number_to_string(*number)),
            Self::Object(_) => Cow::Borrowed("[object Object]"),
            Self::List(items) => {
                let mut out = String::new();
                join_list(items, &mut out);
                Cow::Owned(out)
            }
        }
    }

    /// `String(value ?? '')`: `undefined` and `null` are empty.
    pub fn to_text_or_empty(&self) -> Cow<'_, str> {
        if self.is_nullish() {
            Cow::Borrowed("")
        } else {
            self.to_text()
        }
    }

    /// Converts into text (`String(value)`), reusing the text's buffer.
    pub fn into_text(self) -> String {
        match self {
            Self::Text(text) => text,
            other => other.to_text().into_owned(),
        }
    }

    /// JavaScript truthiness (`if (value)`): `""`, `0`, NaN, `false`, `null` and `undefined` are
    /// false, everything else (any list or object included) is true.
    pub fn js_truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(flag) => *flag,
            Self::Number(number) => *number != 0.0 && !number.is_nan(),
            Self::Text(text) => !text.is_empty(),
            Self::List(_) | Self::Object(_) => true,
        }
    }

    /// `Number(value)`.
    pub fn to_number(&self) -> f64 {
        match self {
            Self::Undefined => f64::NAN,
            Self::Null => 0.0,
            Self::Bool(flag) => f64::from(u8::from(*flag)),
            Self::Number(number) => *number,
            Self::Text(text) => dima_text::parse_number(text),
            other => dima_text::parse_number(&other.to_text()),
        }
    }

    /// `JSON.parse(text)`, or `None` where it throws. Lone surrogate escapes become U+FFFD (text
    /// rule 3). Differences from V8, all on input no writer of this system produces: nesting
    /// deeper than 127 containers and numbers beyond the double range (`1e400`) are rejected.
    pub fn parse_json(text: &str) -> Option<Value> {
        let clean = dima_text::sanitize_lone_surrogates(text.as_bytes());
        serde_json::from_slice(&clean).ok()
    }

    /// `JSON.stringify(value)`; `None` for `undefined` (JavaScript returns `undefined`).
    pub fn to_json(&self) -> Option<String> {
        if matches!(self, Self::Undefined) {
            return None;
        }
        let mut out = String::new();
        write_json(self, &mut out);
        Some(out)
    }

    /// `JSON.stringify` of a list of values (never `undefined`).
    pub fn list_to_json(items: &[Value]) -> String {
        let mut out = String::new();
        write_list_json(items, &mut out);
        out
    }

    /// The approximate number of bytes this value holds, for the evaluator's size limits.
    pub(crate) fn weight(&self) -> usize {
        let mut total = 0usize;
        let mut pending = vec![self];
        while let Some(value) = pending.pop() {
            total = total.saturating_add(match value {
                Self::Text(text) => text.len(),
                Self::List(items) => {
                    pending.extend(items.iter());
                    items.len()
                }
                Self::Object(entries) => {
                    pending.extend(entries.iter().map(|(_, value)| value));
                    entries.iter().map(|(key, _)| key.len() + 1).sum()
                }
                _ => 8,
            });
        }
        total
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<serde_json::Value> for Value {
    fn from(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(flag) => Self::Bool(flag),
            serde_json::Value::Number(number) => Self::Number(number.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(text) => Self::Text(text),
            serde_json::Value::Array(items) => {
                Self::List(items.into_iter().map(Self::from).collect())
            }
            serde_json::Value::Object(map) => {
                Self::object(map.into_iter().map(|(k, v)| (k, Self::from(v))).collect())
            }
        }
    }
}

/// `Array.prototype.join(',')`, as `String(list)` does: `null` and `undefined` items are empty,
/// nested lists are joined the same way.
fn join_list(items: &[Value], out: &mut String) {
    enum Step<'a> {
        Item(&'a Value),
        Comma,
    }
    let mut steps: Vec<Step<'_>> = Vec::new();
    for (index, item) in items.iter().enumerate().rev() {
        steps.push(Step::Item(item));
        if index > 0 {
            steps.push(Step::Comma);
        }
    }
    while let Some(step) = steps.pop() {
        match step {
            Step::Comma => out.push(','),
            Step::Item(Value::List(inner)) => {
                for (index, item) in inner.iter().enumerate().rev() {
                    steps.push(Step::Item(item));
                    if index > 0 {
                        steps.push(Step::Comma);
                    }
                }
            }
            Step::Item(item) if item.is_nullish() => {}
            Step::Item(item) => out.push_str(&item.to_text()),
        }
    }
}

/// Whether `key` is an array index (`"0"` to `"4294967294"`, no leading zeros), and its value.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// JavaScript's enumeration order: array-index keys ascending, then the rest as they are.
fn js_key_order(entries: &mut [(String, Value)]) {
    if entries.iter().any(|(key, _)| array_index(key).is_some()) {
        entries.sort_by_key(|(key, _)| array_index(key).map_or((1, 0), |index| (0, index)));
    }
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Undefined | Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) if number.is_finite() => out.push_str(&number_to_string(*number)),
        Value::Number(_) => out.push_str("null"),
        Value::Text(text) => write_json_string(text, out),
        Value::List(items) => write_list_json(items, out),
        Value::Object(entries) => {
            out.push('{');
            let mut first = true;
            for (key, value) in entries {
                if matches!(value, Value::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_json_string(key, out);
                out.push(':');
                write_json(value, out);
            }
            out.push('}');
        }
    }
}

fn write_list_json(items: &[Value], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json(item, out);
    }
    out.push(']');
}

/// `JSON.stringify` of a string: `"` `\` and control characters escaped, everything else literal.
pub(crate) fn write_json_string(text: &str, out: &mut String) {
    out.push('"');
    let mut start = 0;
    for (at, byte) in text.bytes().enumerate() {
        let escape: Option<&str> = match byte {
            b'"' => Some("\\\""),
            b'\\' => Some("\\\\"),
            b'\n' => Some("\\n"),
            b'\r' => Some("\\r"),
            b'\t' => Some("\\t"),
            0x08 => Some("\\b"),
            0x0c => Some("\\f"),
            0x00..=0x1f => None,
            _ => continue,
        };
        out.push_str(text.get(start..at).unwrap_or_default());
        match escape {
            Some(escape) => out.push_str(escape),
            None => out.push_str(&format!("\\u{byte:04x}")),
        }
        start = at + 1;
    }
    out.push_str(text.get(start..).unwrap_or_default());
    out.push('"');
}

impl Serialize for Value {
    /// As `JSON.stringify` writes the value: `undefined` properties omitted, `undefined` list
    /// items and non-finite numbers as `null`, whole numbers without a fraction.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Undefined | Self::Null => serializer.serialize_unit(),
            Self::Bool(flag) => serializer.serialize_bool(*flag),
            Self::Number(number) if !number.is_finite() => serializer.serialize_unit(),
            Self::Number(number)
                if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 =>
            {
                // Exact: whole and below 2^53.
                serializer.serialize_i64(*number as i64)
            }
            Self::Number(number) => serializer.serialize_f64(*number),
            Self::Text(text) => serializer.serialize_str(text),
            Self::List(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(entries) => {
                let present = entries
                    .iter()
                    .filter(|(_, value)| !matches!(value, Self::Undefined));
                let mut map = serializer.serialize_map(Some(present.clone().count()))?;
                for (key, value) in present {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    /// As `JSON.parse` reads JSON: numbers are doubles, a repeated key keeps its first position
    /// and its last value, array-index keys enumerate first.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value as f64))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(Value::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::Text(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::Text(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        Deserialize::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(4096));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::List(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut entries: Vec<(String, Value)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            entries.push((key, value));
        }
        Ok(Value::object(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_conversion_matches_javascript() {
        let list = Value::List(vec![
            Value::Number(1.0),
            Value::Null,
            Value::List(vec![Value::text("a"), Value::Undefined, Value::Bool(true)]),
            Value::Object(vec![]),
        ]);
        assert_eq!(list.to_text(), "1,,a,,true,[object Object]");
        assert_eq!(Value::Number(-0.0).to_text(), "0");
        assert_eq!(Value::Number(1e21).to_text(), "1e+21");
        assert_eq!(Value::Undefined.to_text(), "undefined");
        assert_eq!(Value::Undefined.to_text_or_empty(), "");
    }

    #[test]
    fn json_round_trip_keeps_javascript_key_order() {
        let parsed = Value::parse_json(r#"[{"b":1,"10":10,"2":2,"a":3,"b":4},1.0,1e2,"😀"]"#);
        let parsed = parsed.unwrap_or_default();
        assert_eq!(
            parsed.to_json().as_deref(),
            Some(r#"[{"2":2,"10":10,"b":4,"a":3},1,100,"😀"]"#)
        );
        assert_eq!(
            Value::parse_json("[\"\\ud800\"]")
                .and_then(|v| v.to_json())
                .as_deref(),
            Some("[\"\u{fffd}\"]")
        );
        assert!(Value::parse_json("not json").is_none());
        assert_eq!(
            Value::text("a\"\n\u{1}").to_json().as_deref(),
            Some("\"a\\\"\\n\\u0001\"")
        );
        assert_eq!(Value::Undefined.to_json(), None);
        let object = Value::object(vec![
            ("x".into(), Value::Undefined),
            ("y".into(), Value::Number(f64::NAN)),
        ]);
        assert_eq!(object.to_json().as_deref(), Some(r#"{"y":null}"#));
    }

    #[test]
    fn number_and_truthiness() {
        assert_eq!(Value::text(" 0x10 ").to_number(), 16.0);
        assert!(Value::Null.to_number() == 0.0);
        assert!(Value::Undefined.to_number().is_nan());
        assert_eq!(Value::List(vec![Value::text("5")]).to_number(), 5.0);
        assert!(!Value::Number(f64::NAN).js_truthy());
        assert!(Value::List(vec![]).js_truthy());
        assert!(!Value::empty().js_truthy());
    }

    #[test]
    fn serializes_like_json_stringify() {
        let value = Value::object(vec![
            ("n".into(), Value::Number(3.0)),
            ("f".into(), Value::Number(0.5)),
            ("u".into(), Value::Undefined),
            (
                "l".into(),
                Value::List(vec![Value::Undefined, Value::Number(f64::INFINITY)]),
            ),
        ]);
        let text = dima_text::to_js_json_from(&value).map(String::from_utf8);
        assert_eq!(
            text.ok().and_then(Result::ok).as_deref(),
            Some(r#"{"n":3,"f":0.5,"l":[null,null]}"#)
        );
    }
}
