//! The JavaScript coercions the reference applies to request values (`String(x)`, `Number(x)`,
//! truthiness, `x ?? y`, `decodeURIComponent`, `split(/\s+/)`), on parsed JSON values.
//!
//! Request bodies are parsed into `serde_json::Value` the way `JSON.parse` would hold them
//! ([`parse_json`]); `undefined` (an absent property) is `None` throughout.

use serde_json::Value;

/// `Boolean(value)`: `false`, `0`, `-0`, `NaN`, `""`, `null` and `undefined` are falsy.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(value)`; `undefined` is `"undefined"`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => dima_text::string_of(value),
    }
}

/// `String(value || '')`.
pub fn string_or_empty(value: Option<&Value>) -> String {
    if truthy(value) {
        string(value)
    } else {
        String::new()
    }
}

/// `String(value ?? '')`.
pub fn string_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => dima_text::string_of(value),
    }
}

/// `Number(value)`.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => dima_text::parse_number(text),
        // ToPrimitive: arrays join their items, objects are "[object Object]" (NaN).
        Some(other @ (Value::Array(_) | Value::Object(_))) => {
            dima_text::parse_number(&dima_text::string_of(other))
        }
    }
}

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// `decodeURIComponent(text)`: `None` where JavaScript throws `URIError: URI malformed` (a `%`
/// not followed by two hex digits, or escapes that are not UTF-8).
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    percent_encoding::percent_decode_str(text)
        .decode_utf8()
        .ok()
        .map(std::borrow::Cow::into_owned)
}

/// `text.trim().split(/\s+/)` with JavaScript's whitespace set (which includes U+FEFF).
pub fn split_whitespace(text: &str) -> Vec<String> {
    let trimmed = dima_text::trim(text);
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_space = false;
    for ch in trimmed.chars() {
        if dima_text::is_js_whitespace(ch) {
            if !in_space {
                parts.push(std::mem::take(&mut current));
                in_space = true;
            }
        } else {
            in_space = false;
            current.push(ch);
        }
    }
    parts.push(current);
    parts
}

/// 2^53: integers up to this magnitude are exact as doubles.
const MAX_EXACT_INTEGER: u64 = 1 << 53;

/// Deepest nesting `serde_json` reads; `JSON.parse` has no limit (see the package report).
pub const MAX_JSON_DEPTH: usize = 128;

/// `JSON.parse(text)`, holding what JavaScript holds: lone surrogate escapes become U+FFFD
/// (text rule 3), keys enumerate in JavaScript order (array indices first), integers beyond
/// 2^53 are rounded to doubles and integral doubles are integers. `None` where `JSON.parse`
/// throws (and for numbers beyond the double range, which JavaScript reads as `Infinity`).
pub fn parse_json(text: &[u8]) -> Option<Value> {
    let text = dima_text::sanitize_lone_surrogates(text);
    let mut value: Value = serde_json::from_slice(&text).ok()?;
    dima_text::js_key_order(&mut value);
    javascript_numbers(&mut value);
    Some(value)
}

fn javascript_numbers(value: &mut Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(number) => {
                if let Some(replacement) = javascript_number(number) {
                    *number = replacement;
                }
            }
            Value::Array(items) => pending.extend(items.iter_mut()),
            Value::Object(map) => pending.extend(map.values_mut()),
            _ => {}
        }
    }
}

#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "rounding to the nearest double is what JSON.parse does"
)]
fn javascript_number(number: &serde_json::Number) -> Option<serde_json::Number> {
    if let Some(integer) = number.as_i64() {
        return (integer.unsigned_abs() > MAX_EXACT_INTEGER)
            .then(|| serde_json::Number::from_f64(integer as f64))
            .flatten();
    }
    if let Some(integer) = number.as_u64() {
        return (integer > MAX_EXACT_INTEGER)
            .then(|| serde_json::Number::from_f64(integer as f64))
            .flatten();
    }
    let double = number.as_f64()?;
    let integral = double.fract() == 0.0 && double.abs() <= MAX_EXACT_INTEGER as f64;
    if !integral || (double == 0.0 && double.is_sign_negative()) {
        return None;
    }
    Some(serde_json::Number::from(double as i64))
}

/// A JSON number for a JavaScript number (`NaN` and infinities are `null`, as `JSON.stringify`
/// writes them). Integral values within 2^53 are integers so they print without a fraction.
#[expect(
    clippy::cast_possible_truncation,
    reason = "only integral values within 2^53 are converted"
)]
pub fn number_value(n: f64) -> Value {
    if is_integer(n) && n.abs() <= 9_007_199_254_740_992.0 && !(n == 0.0 && n.is_sign_negative()) {
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coercions() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!([]))));
        assert_eq!(string(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(string(Some(&json!({}))), "[object Object]");
        assert_eq!(string(None), "undefined");
        assert_eq!(string_nullish(Some(&json!(null))), "");
        assert_eq!(string_or_empty(Some(&json!(0))), "");
        assert_eq!(number(Some(&json!("  12 "))), 12.0);
        assert_eq!(number(Some(&json!(true))), 1.0);
        assert_eq!(number(Some(&json!([7]))), 7.0);
        assert!(number(Some(&json!({}))).is_nan());
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert_eq!(number(Some(&json!("0x10"))), 16.0);
    }

    #[test]
    fn decode_uri_component_throws_like_javascript() {
        assert_eq!(
            decode_uri_component("env%3Adragonfly").as_deref(),
            Some("env:dragonfly")
        );
        assert_eq!(decode_uri_component("%F0%9F%8D%95").as_deref(), Some("🍕"));
        assert_eq!(decode_uri_component("a+b").as_deref(), Some("a+b"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(decode_uri_component("ключ").as_deref(), Some("ключ"));
    }

    #[test]
    fn splits_on_javascript_whitespace() {
        assert_eq!(split_whitespace("  get   a  "), ["get", "a"]);
        assert_eq!(split_whitespace(""), [""]);
        assert_eq!(
            split_whitespace("a\u{feff}b\u{a0}c\u{2028}d"),
            ["a", "b", "c", "d"]
        );
        assert_eq!(split_whitespace("set k 🍕"), ["set", "k", "🍕"]);
    }

    #[test]
    fn json_parse_holds_javascript_values() -> Result<(), String> {
        let value =
            parse_json(br#"{"b":1.0,"2":9007199254740993,"z":-0,"s":"\ud83d"}"#).ok_or("parse")?;
        assert_eq!(
            dima_text::to_js_json(&value),
            r#"{"2":9007199254740992,"b":1,"z":0,"s":"�"}"#
        );
        assert!(parse_json(b"{bad").is_none());
        assert!(parse_json(b" ").is_none());
        assert_eq!(parse_json(b"\"x\""), Some(json!("x")));
        assert!(
            number_value(-0.0)
                .as_f64()
                .is_some_and(f64::is_sign_negative)
        );
        assert_eq!(number_value(f64::NAN), Value::Null);
        assert_eq!(number_value(3.0), json!(3));
        Ok(())
    }
}
