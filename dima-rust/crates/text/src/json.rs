//! `JSON.stringify` bytes and inbound JSON repair.
//!
//! The workspace builds `serde_json` with `preserve_order`, so a `Value` keeps its keys in
//! insertion order, as a JavaScript object does for non-index keys.

use crate::number::number_to_string;
use crate::order::cmp_utf16;
use serde_json::{Map, Number, Value};
use std::borrow::Cow;
use std::cmp::Ordering;

/// `JSON.stringify(value)`: exactly the bytes Node writes for the same value, keys in stored order.
///
/// Numbers use JavaScript's text (`1`, not `1.0`; `1e+21`; `-0` as `0`); integers beyond 2^53
/// are written as the double JavaScript would hold. Strings escape `"`, `\` and controls only
/// (U+2028/U+2029 and non-ASCII stay literal). A `Value` cannot hold NaN or infinities, which
/// JavaScript would write as `null`. For a value built in Rust whose keys must enumerate the way
/// a JavaScript object's do, call [`js_key_order`] first.
pub fn to_js_json(value: &Value) -> String {
    write(value, None)
}

/// [`to_js_json`] bytes for any serialisable value, written in one pass with no intermediate tree.
///
/// Object keys go out in the order the type serialises them, so a struct declares its fields in
/// the order the TypeScript builds the object, and skips absent optional fields itself
/// (`#[serde(skip_serializing_if = "Option::is_none")]`). Array-index keys are not moved to the
/// front: build a `Value` and use [`js_key_order`] with [`to_js_json`] where a map has such keys.
pub fn to_js_json_from<T: serde::Serialize + ?Sized>(
    value: &T,
) -> Result<Vec<u8>, serde_json::Error> {
    let mut out = Vec::with_capacity(256);
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
    value.serialize(&mut serializer)?;
    Ok(out)
}

/// `serde_json` output with JavaScript number text. Its string escaping already matches
/// `JSON.stringify` (the vector tests compare both writers with Node).
struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
    fn write_i64<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: i64,
    ) -> std::io::Result<()> {
        writer.write_all(number_text(&Number::from(value)).as_bytes())
    }

    fn write_u64<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: u64,
    ) -> std::io::Result<()> {
        writer.write_all(number_text(&Number::from(value)).as_bytes())
    }

    fn write_f64<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: f64,
    ) -> std::io::Result<()> {
        writer.write_all(number_to_string(value).as_bytes())
    }
}

/// How [`to_js_json_sorted`] orders each object's keys; both sort with the default `sort()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SortedKeys {
    /// The sorted list itself, as when the JSON text is assembled from `Object.keys(o).sort()`
    /// (`stableJson` in the site agent tools).
    Plain,
    /// An object rebuilt from the sorted keys (`Object.fromEntries(Object.keys(o).sort()…)` in a
    /// `JSON.stringify` replacer): JavaScript then lists array-index keys first, numerically.
    Rebuilt,
}

/// `to_js_json` with every object's keys sorted like the TypeScript's canonical writers.
pub fn to_js_json_sorted(value: &Value, order: SortedKeys) -> String {
    write(value, Some(order))
}

/// Reorders every object's keys (recursively) the way a JavaScript object enumerates them:
/// array-index keys (`"0"` to `"4294967294"`, no leading zeros) first in numeric order, then the
/// others in their current order.
pub fn js_key_order(value: &mut Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(items) => pending.extend(items.iter_mut()),
            Value::Object(map) => {
                if map.keys().any(|key| array_index(key).is_some()) {
                    let mut entries: Vec<(String, Value)> =
                        std::mem::take(map).into_iter().collect();
                    entries.sort_by(|(left, _), (right, _)| index_first(left, right));
                    map.extend(entries);
                }
                pending.extend(map.values_mut());
            }
            _ => {}
        }
    }
}

/// Makes JSON text that `JSON.parse` accepts acceptable to `serde_json`: every `\uD800`–`\uDFFF`
/// escape that is not part of a valid surrogate pair becomes `\ufffd` (text rule 3). Valid pairs
/// and everything else are untouched; borrows when nothing changes.
///
/// Only escapes are repaired. Raw bytes that are not UTF-8 are left for the parser to reject.
pub fn sanitize_lone_surrogates(json: &[u8]) -> Cow<'_, [u8]> {
    let mut repaired: Option<Vec<u8>> = None;
    let mut at = 0;
    while let Some(offset) = json
        .get(at..)
        .and_then(|rest| rest.iter().position(|byte| *byte == b'\\'))
    {
        let escape = at + offset;
        let Some(unit) = unicode_escape(json, escape) else {
            // `\\`, `\"`, `\n`… : skip the escaped character so `\\uD800` is not read as an escape.
            at = escape + 2;
            continue;
        };
        at = escape + 6;
        match unit {
            0xd800..=0xdbff => {
                if unicode_escape(json, at).is_some_and(|low| (0xdc00..=0xdfff).contains(&low)) {
                    at += 6;
                    continue;
                }
            }
            0xdc00..=0xdfff => {}
            _ => continue,
        }
        let buffer = repaired.get_or_insert_with(|| json.to_vec());
        if let Some(lone) = buffer.get_mut(escape..at) {
            lone.copy_from_slice(b"\\ufffd");
        }
    }
    repaired.map_or(Cow::Borrowed(json), Cow::Owned)
}

/// The code unit of a `\uXXXX` escape starting at `at`.
fn unicode_escape(json: &[u8], at: usize) -> Option<u32> {
    match json.get(at..at + 6)? {
        [b'\\', b'u', hex @ ..] => hex.iter().try_fold(0, |unit, byte| {
            char::from(*byte)
                .to_digit(16)
                .map(|digit| (unit << 4) | digit)
        }),
        _ => None,
    }
}

/// `n` when `key` is an array index: the canonical decimal of an integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes.first() == Some(&b'0')) {
        return None;
    }
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// Array-index keys first in numeric order; the rest keep their relative order (stable sort).
fn index_first(left: &str, right: &str) -> Ordering {
    match (array_index(left), array_index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// The `JSON.stringify` writer: an explicit stack, so depth is limited by memory, not the call stack.
fn write(value: &Value, order: Option<SortedKeys>) -> String {
    enum Step<'a> {
        Value(&'a Value),
        Key(&'a str),
        Text(&'static str),
    }
    let mut out = String::new();
    let mut steps = vec![Step::Value(value)];
    while let Some(step) = steps.pop() {
        match step {
            Step::Text(text) => out.push_str(text),
            Step::Key(key) => {
                quote(key, &mut out);
                out.push(':');
            }
            Step::Value(Value::Null) => out.push_str("null"),
            Step::Value(Value::Bool(flag)) => out.push_str(if *flag { "true" } else { "false" }),
            Step::Value(Value::Number(number)) => out.push_str(&number_text(number)),
            Step::Value(Value::String(text)) => quote(text, &mut out),
            Step::Value(Value::Array(items)) => {
                out.push('[');
                steps.push(Step::Text("]"));
                for (index, item) in items.iter().enumerate().rev() {
                    steps.push(Step::Value(item));
                    if index > 0 {
                        steps.push(Step::Text(","));
                    }
                }
            }
            Step::Value(Value::Object(map)) => {
                out.push('{');
                steps.push(Step::Text("}"));
                for (index, (key, item)) in entries(map, order).into_iter().enumerate().rev() {
                    steps.push(Step::Value(item));
                    steps.push(Step::Key(key));
                    if index > 0 {
                        steps.push(Step::Text(","));
                    }
                }
            }
        }
    }
    out
}

/// An object's entries in the requested key order.
fn entries(map: &Map<String, Value>, order: Option<SortedKeys>) -> Vec<(&str, &Value)> {
    let mut entries: Vec<(&str, &Value)> = map
        .iter()
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    match order {
        None => {}
        Some(SortedKeys::Plain) => entries.sort_by(|(left, _), (right, _)| cmp_utf16(left, right)),
        Some(SortedKeys::Rebuilt) => {
            entries.sort_by(|(left, _), (right, _)| {
                index_first(left, right).then_with(|| cmp_utf16(left, right))
            });
        }
    }
    entries
}

fn number_text(number: &Number) -> String {
    const SAFE: u64 = 1 << 53;
    if let Some(unsigned) = number.as_u64().filter(|unsigned| *unsigned <= SAFE) {
        return unsigned.to_string();
    }
    if let Some(signed) = number
        .as_i64()
        .filter(|signed| signed.unsigned_abs() <= SAFE)
    {
        return signed.to_string();
    }
    match number.as_f64() {
        Some(double) if double.is_finite() => number_to_string(double),
        _ => "null".into(),
    }
}

/// `JSON.stringify` of a string: `\"`, `\\`, `\b \f \n \r \t`, other controls as `\u00xx`.
fn quote(text: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.reserve(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if control < ' ' => {
                let code = usize::from(control as u8);
                out.push_str("\\u00");
                out.push(char::from(HEX[code >> 4]));
                out.push(char::from(HEX[code & 15]));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from the evaluator's `json_order_rounding_and_deep_values` (duplicate keys keep the
    // first position with the last value; index keys come first).
    #[test]
    fn index_keys_come_first_and_duplicates_keep_their_position() {
        let mut value: Value =
            serde_json::from_str(r#"{"z":1,"10":2,"2":3,"a":4,"z":5}"#).unwrap_or_default();
        js_key_order(&mut value);
        assert_eq!(to_js_json(&value), r#"{"2":3,"10":2,"z":5,"a":4}"#);
        let raw = format!("{}0{}", "[".repeat(256), "]".repeat(256));
        let deep = (0..256).fold(json!(0), |inner, _| json!([inner]));
        assert_eq!(to_js_json(&deep), raw);
    }

    // Ported from `dashboard_activity::json_identity_preserves_lone_surrogates_and_js_escape_spellings`.
    #[test]
    fn escapes_match_javascript_spellings() {
        assert_eq!(
            to_js_json(&json!("\"\\\n\t\u{1}/é😀\u{2028}")),
            "\"\\\"\\\\\\n\\t\\u0001/é😀\u{2028}\""
        );
        assert_eq!(to_js_json(&json!(["a", "b"])), r#"["a","b"]"#);
        assert_eq!(
            to_js_json(&json!([1.0, -0.0, 1e21, 2.5])),
            "[1,0,1e+21,2.5]"
        );
        assert_eq!(to_js_json(&json!(u64::MAX)), "18446744073709552000");
    }

    #[test]
    fn sorted_variants_differ_only_for_index_keys() {
        let value = json!({"b": 1, "10": 2, "a": {"2": 3, "1": 4}, "9": 5});
        assert_eq!(
            to_js_json_sorted(&value, SortedKeys::Plain),
            r#"{"10":2,"9":5,"a":{"1":4,"2":3},"b":1}"#
        );
        assert_eq!(
            to_js_json_sorted(&value, SortedKeys::Rebuilt),
            r#"{"9":5,"10":2,"a":{"1":4,"2":3},"b":1}"#
        );
    }

    #[test]
    fn lone_surrogate_escapes_become_replacement_characters() {
        let fixed = |text: &str| {
            String::from_utf8_lossy(&sanitize_lone_surrogates(text.as_bytes())).into_owned()
        };
        assert_eq!(fixed(r#""\ud800""#), r#""\ufffd""#);
        assert_eq!(fixed(r#""\ud83d\ude00""#), r#""\ud83d\ude00""#);
        assert_eq!(fixed(r#""\uDE00\uD83D""#), r#""\ufffd\ufffd""#);
        assert_eq!(fixed(r#""\ud83d\ud83d\ude00""#), r#""\ufffd\ud83d\ude00""#);
        assert_eq!(fixed(r#""\\ud800""#), r#""\\ud800""#);
        assert_eq!(fixed(r#""\\\ud800""#), r#""\\\ufffd""#);
        assert_eq!(fixed(r#""end\ud8"#), r#""end\ud8"#);
        assert!(matches!(
            sanitize_lone_surrogates(br#"{"a":"\u00e9"}"#),
            Cow::Borrowed(_)
        ));
    }
}
