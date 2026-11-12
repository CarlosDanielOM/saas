//! The JavaScript coercions the reference applies to request values (`String(x)`, `Number(x)`,
//! truthiness, `x ?? y`, `decodeURIComponent`, `split(/\s+/)`), on parsed JSON values.
//!
//! Request bodies are parsed into `serde_json::Value` the way `JSON.parse` would hold them
//! ([`parse_json`]); `undefined` (an absent property) is `None` throughout.

use serde_json::Value;

/// `Boolean(value)` ([`dima_text::js_truthy`]); `undefined` is falsy.
pub fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(dima_text::js_truthy)
}

/// `String(value)` ([`dima_text::js_string`]); `undefined` is `"undefined"`.
pub fn string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), dima_text::js_string)
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
        Some(value) => dima_text::js_string(value),
    }
}

/// `Number(value)` ([`dima_text::js_number`]); `undefined` is NaN.
pub fn number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, dima_text::js_number)
}

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// `decodeURIComponent(text)`: `None` where JavaScript throws `URIError: URI malformed` (a `%`
/// not followed by two hex digits, or escapes that are not UTF-8).
pub fn decode_uri_component(text: &str) -> Option<String> {
    dima_text::decode_uri_component(text)
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

/// Deepest nesting read: the limit `serde_json` imposed when it parsed these texts (127 open
/// containers), kept so that nothing accepted or refused changes. `JSON.parse` has none.
pub const MAX_JSON_DEPTH: usize = 127;

/// `JSON.parse(text)`, holding what JavaScript holds ([`dima_text::parse_js_json`]): lone
/// surrogate escapes become U+FFFD (text rule 3), keys enumerate in JavaScript order (array
/// indices first), integers beyond 2^53 are rounded to doubles and integral doubles are integers.
/// `None` where `JSON.parse` throws (and for numbers beyond the double range, which JavaScript
/// reads as `Infinity`). The texts are request bodies, already bounded by the body limit, and
/// stored values, so no size limit is added here.
pub fn parse_json(text: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(text).ok()?;
    let limits = dima_text::JsonLimits {
        max_depth: MAX_JSON_DEPTH,
        max_bytes: usize::MAX,
    };
    dima_text::parse_js_json(text, limits).ok()
}

/// A JSON number for a JavaScript number ([`dima_text::js_number_value`]): `NaN` and infinities
/// are `null`, as `JSON.stringify` writes them; integral values within 2^53 are integers so they
/// print without a fraction.
pub fn number_value(n: f64) -> Value {
    dima_text::js_number_value(n)
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
