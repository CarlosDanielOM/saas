//! Readers that reproduce, exactly, each way the TypeScript reads `process.env`.
//!
//! Every function takes the raw value as `Option<&str>` (`None` is `undefined`: the variable is
//! not set) and returns what the JavaScript expression evaluates to. Numbers are `f64` because
//! they are JavaScript numbers: NaN, infinities and `-0` come through as JavaScript produces them,
//! and the caller converts at the point of use (see [`timer_delay_ms`] for Node's timers).
//! Text-to-number conversion is `dima_text::parse_number` (`Number()`), so `Number('')` is 0,
//! `Number(undefined)` is NaN, and `' 0x10 '` is 16.
//!
//! | JavaScript (verbatim) | Function |
//! |---|---|
//! | `Number(x)` | [`number`] |
//! | `Number(x \|\| def)` | [`number_or`] |
//! | `Number(x) \|\| def` | [`number_or_else`] |
//! | `Number(x ?? def)` | [`number_nullish`] |
//! | `Math.max(min, Number(x \|\| def))` | [`max_number_or`] |
//! | `Math.max(min, Number(x) \|\| def)` | [`max_number_or_else`] |
//! | `Math.max(min, Math.floor(Number(x) \|\| def))` | [`max_floor_number_or_else`] |
//! | `Math.max(min, Math.min(max, Number(x \|\| def)))` and `Math.min(max, Math.max(min, …))` | [`clamp_number_or`] |
//! | `n = Number(x ?? def); Number.isFinite(n) ? Math.max(min, n) : def` (`readNumberSetting`) | [`finite_max_nullish`] |
//! | `n = Number(x \|\| def); Number.isFinite(n) ? Math.max(min, n) : def` (cron restart delay) | [`finite_max_or`] |
//! | `Number.isFinite(Number(x)) ? Number(x) : def` | [`finite_number`] |
//! | `setting(name, def, min, max)`: `Number(x ?? def)`, safe integer in range, else throw | [`safe_integer_setting`] |
//! | `parseInt(x, 10)` | [`parse_int_decimal`] (compose with [`nan_or`] for a fallback) |
//! | `Math.max(a, b)`, `Math.min(a, b)` | [`math_max`], [`math_min`] |
//! | `x === 'true'` | [`is_true`] |
//! | `x !== 'false'` | [`not_false`] |
//! | `x?.toLowerCase() !== 'false'` | [`not_false_ignore_case`] |
//! | `!!x`, `Boolean(x)`, `if (x)` | [`truthy`] |
//! | `x \|\| def`, `String(x \|\| def)` | [`string_or`] |
//! | `x ?? def` | [`string_nullish`] |
//! | `x \|\| null`, `x \|\| undefined` | [`non_empty`] |
//! | `x?.trim()` | [`trimmed`] |
//! | `x?.trim() \|\| def` | [`trimmed_or`] |
//! | `` `${x!}` `` (non-null assertion into text) | [`or_undefined_text`] |
//! | `.replace(/\/+$/, '')` | [`strip_trailing_slashes`] |
//! | `.replace(/\/$/, '')` | [`strip_one_trailing_slash`] |
//! | `x === 'literal'` (`NODE_ENV === 'production'`, `POLARSH_ENVIRONMENT === 'sandbox'`) | `raw == Some("literal")` |
//! | `(x \|\| def).split(',').map(v => v.trim())` (add `.filter(\|s\| !s.is_empty())` for `.filter(Boolean)`) | [`comma_list`] |
//! | `JSON.parse(x)` inside `try`, falling back on error | [`json_value`] |
//! | `setTimeout`/`setInterval` coercion of the delay | [`timer_delay_ms`] |

use crate::env::EnvError;
use serde_json::Value;

/// `Number(x)`.
pub fn number(raw: Option<&str>) -> f64 {
    raw.map_or(f64::NAN, dima_text::parse_number)
}

/// `Number(x || def)`: unset or empty gives `def`; anything else is converted (non-numeric is NaN).
pub fn number_or(raw: Option<&str>, def: f64) -> f64 {
    match raw {
        Some(text) if !text.is_empty() => dima_text::parse_number(text),
        _ => def,
    }
}

/// `Number(x) || def`: NaN and zero (from unset, empty, `0`, garbage) give `def`.
pub fn number_or_else(raw: Option<&str>, def: f64) -> f64 {
    or_falsy(number(raw), def)
}

/// `Number(x ?? def)`: unset gives `def`; empty is 0.
pub fn number_nullish(raw: Option<&str>, def: f64) -> f64 {
    raw.map_or(def, dima_text::parse_number)
}

/// `Math.max(a, b)`: NaN if either is NaN; `+0` beats `-0`.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; `-0` beats `+0`.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(min, Number(x || def))`: non-numeric text gives NaN, which `Math.max` propagates.
pub fn max_number_or(raw: Option<&str>, min: f64, def: f64) -> f64 {
    math_max(min, number_or(raw, def))
}

/// `Math.max(min, Number(x) || def)`.
pub fn max_number_or_else(raw: Option<&str>, min: f64, def: f64) -> f64 {
    math_max(min, number_or_else(raw, def))
}

/// `Math.max(min, Math.floor(Number(x) || def))`.
pub fn max_floor_number_or_else(raw: Option<&str>, min: f64, def: f64) -> f64 {
    math_max(min, number_or_else(raw, def).floor())
}

/// `Math.max(min, Math.min(max, Number(x || def)))`; with `min <= max` this equals the other
/// nesting order, `Math.min(max, Math.max(min, …))`, for every input including NaN and `-0`.
pub fn clamp_number_or(raw: Option<&str>, min: f64, max: f64, def: f64) -> f64 {
    math_max(min, math_min(max, number_or(raw, def)))
}

/// `n = Number(x ?? def); Number.isFinite(n) ? Math.max(min, n) : def` (`readNumberSetting`).
pub fn finite_max_nullish(raw: Option<&str>, min: f64, def: f64) -> f64 {
    let n = number_nullish(raw, def);
    if n.is_finite() { math_max(min, n) } else { def }
}

/// `n = Number(x || def); Number.isFinite(n) ? Math.max(min, n) : def`.
pub fn finite_max_or(raw: Option<&str>, min: f64, def: f64) -> f64 {
    let n = number_or(raw, def);
    if n.is_finite() { math_max(min, n) } else { def }
}

/// `Number.isFinite(Number(x)) ? Number(x) : def`: unset gives `def`, but empty gives 0.
pub fn finite_number(raw: Option<&str>, def: f64) -> f64 {
    let n = number(raw);
    if n.is_finite() { n } else { def }
}

/// The domain-events `setting(name, def, min, max)`: `Number(x ?? def)` must be a safe integer
/// within `[min, max]`, otherwise the reference throws `Invalid <name>` at import.
pub fn safe_integer_setting(
    name: &str,
    raw: Option<&str>,
    def: f64,
    min: f64,
    max: f64,
) -> Result<i64, EnvError> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let n = number_nullish(raw, def);
    let safe = n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE;
    if !safe || n < min || n > max {
        return Err(EnvError::Invalid {
            name: name.to_owned(),
        });
    }
    // A safe integer converts exactly; -0 becomes 0.
    #[allow(clippy::cast_possible_truncation)]
    Ok(n as i64)
}

/// `parseInt(x, 10)`: unset is `parseInt(undefined, 10)`, which is NaN.
pub fn parse_int_decimal(raw: Option<&str>) -> f64 {
    raw.map_or(f64::NAN, |text| {
        dima_text::parse_int(text, dima_text::Radix::Decimal)
    })
}

/// `Number.isNaN(n) ? def : n`.
pub fn nan_or(n: f64, def: f64) -> f64 {
    if n.is_nan() { def } else { n }
}

/// `n || def` for a number: NaN, `0` and `-0` give `def`.
pub fn or_falsy(n: f64, def: f64) -> f64 {
    if n.is_nan() || n == 0.0 { def } else { n }
}

/// `x === 'true'`.
pub fn is_true(raw: Option<&str>) -> bool {
    raw == Some("true")
}

/// `x !== 'false'`: only the exact text `false` disables.
pub fn not_false(raw: Option<&str>) -> bool {
    raw != Some("false")
}

/// `x?.toLowerCase() !== 'false'`.
pub fn not_false_ignore_case(raw: Option<&str>) -> bool {
    raw.is_none_or(|text| dima_text::to_lower(text) != "false")
}

/// `!!x`: set and not empty.
pub fn truthy(raw: Option<&str>) -> bool {
    raw.is_some_and(|text| !text.is_empty())
}

/// `x || def` (and `String(x || def)`).
pub fn string_or<'a>(raw: Option<&'a str>, def: &'a str) -> &'a str {
    non_empty(raw).unwrap_or(def)
}

/// `x ?? def`: unset gives `def`; an empty value stays empty.
pub fn string_nullish<'a>(raw: Option<&'a str>, def: &'a str) -> &'a str {
    raw.unwrap_or(def)
}

/// `x || null`: the value when set and not empty.
pub fn non_empty(raw: Option<&str>) -> Option<&str> {
    raw.filter(|text| !text.is_empty())
}

/// `x?.trim()`: JavaScript whitespace trimmed; unset stays unset, so the result may be `""`.
pub fn trimmed(raw: Option<&str>) -> Option<&str> {
    raw.map(dima_text::trim)
}

/// `x?.trim() || def`.
pub fn trimmed_or<'a>(raw: Option<&'a str>, def: &'a str) -> &'a str {
    non_empty(trimmed(raw)).unwrap_or(def)
}

/// `` `${x!}` ``: an unset variable becomes the text `undefined`, as the reference sends it.
pub fn or_undefined_text(raw: Option<&str>) -> &str {
    raw.unwrap_or("undefined")
}

/// `text.replace(/\/+$/, '')`.
pub fn strip_trailing_slashes(text: &str) -> &str {
    text.trim_end_matches('/')
}

/// `text.replace(/\/$/, '')`: at most one slash.
pub fn strip_one_trailing_slash(text: &str) -> &str {
    text.strip_suffix('/').unwrap_or(text)
}

/// `(x || def).split(',').map(v => v.trim())`.
pub fn comma_list<'a>(raw: Option<&'a str>, def: &'a str) -> Vec<&'a str> {
    string_or(raw, def)
        .split(',')
        .map(dima_text::trim)
        .collect()
}

/// `JSON.parse(x)` in a `try`: `None` when unset or not JSON (the caller's fallback applies).
///
/// Lone surrogate escapes become U+FFFD (text rule 3). Numbers and key order follow
/// `JSON.parse` through dima-text. Out-of-range doubles are rejected (allowed difference).
pub fn json_value(raw: Option<&str>) -> Option<Value> {
    dima_text::parse_js_json(
        raw?,
        dima_text::JsonLimits {
            max_depth: 127,
            max_bytes: usize::MAX,
        },
    )
    .ok()
}

/// The delay Node's `setTimeout`/`setInterval` actually use for `after`: values that are not in
/// `[1, 2147483647]` (including NaN) become 1 ms. A NaN interval from a non-numeric variable
/// therefore fires every millisecond, as it does in the reference.
pub fn timer_delay_ms(after: f64) -> f64 {
    if (1.0..=2_147_483_647.0).contains(&after) {
        after
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
    }

    #[test]
    fn json_shared_contract() {
        // Node rounds integers and enumerates index keys first; the old copy did neither.
        let value = json_value(Some(
            r#"{"b":1,"2":2,"b":3,"1":9007199254740993,"z":-0,"e":1e2}"#,
        ))
        .unwrap();
        assert_eq!(value["1"].as_u64(), Some(9007199254740992));
        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["1", "2", "b", "z", "e"]
        );
        assert!(json_value(Some(&format!("{}0{}", "[".repeat(127), "]".repeat(127)))).is_some());
        assert!(json_value(Some(&format!("{}0{}", "[".repeat(128), "]".repeat(128)))).is_none());
    }

    #[test]
    fn max_and_min_follow_javascript_for_zero_and_nan() {
        assert!(same(math_max(0.0, -0.0), 0.0));
        assert!(same(math_max(-0.0, 0.0), 0.0));
        assert!(same(math_min(0.0, -0.0), -0.0));
        assert!(math_max(1.0, f64::NAN).is_nan());
        assert!(math_min(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn number_idioms() {
        assert!(same(number_or(None, 50.0), 50.0));
        assert!(same(number_or(Some(""), 50.0), 50.0));
        assert!(number_or(Some("abc"), 50.0).is_nan());
        assert!(same(number_or_else(Some("0"), 7.0), 7.0));
        assert!(same(number_nullish(Some(""), 7.0), 0.0));
        assert!(same(finite_number(None, 2.0), 2.0));
        assert!(same(finite_number(Some(""), 2.0), 0.0));
        assert!(same(finite_max_or(Some("abc"), 1000.0, 5000.0), 5000.0));
        assert!(same(finite_max_or(Some("10"), 1000.0, 5000.0), 1000.0));
        assert!(max_number_or(Some("abc"), 1.0, 50.0).is_nan());
    }

    #[test]
    fn safe_integer_setting_throws_like_the_reference() {
        let max = 2_147_483_647.0;
        assert_eq!(
            safe_integer_setting("X", None, 1000.0, 250.0, max).ok(),
            Some(1000)
        );
        assert!(safe_integer_setting("X", Some(""), 1000.0, 250.0, max).is_err());
        assert!(safe_integer_setting("X", Some("1.5e3"), 1000.0, 250.0, max).is_ok());
        assert!(safe_integer_setting("X", Some("100.5"), 1000.0, 1.0, max).is_err());
        assert_eq!(
            safe_integer_setting("X", Some("1"), 1.0, 1.0, 500.0)
                .err()
                .map(|e| e.to_string()),
            None
        );
        assert_eq!(
            safe_integer_setting("DOMAIN_EVENTS_BATCH_SIZE", Some("501"), 100.0, 1.0, 500.0)
                .err()
                .map(|e| e.to_string()),
            Some("Invalid DOMAIN_EVENTS_BATCH_SIZE".to_owned())
        );
    }

    #[test]
    fn text_idioms() {
        assert_eq!(comma_list(None, "a.com, B.com"), vec!["a.com", "B.com"]);
        assert_eq!(comma_list(Some(" x ,,y"), "d"), vec!["x", "", "y"]);
        assert_eq!(trimmed_or(Some("  "), "def"), "def");
        assert_eq!(strip_trailing_slashes("https://x//"), "https://x");
        assert_eq!(or_undefined_text(None), "undefined");
        assert!(not_false_ignore_case(Some("FALSEY")));
        assert!(!not_false_ignore_case(Some("FaLsE")));
        assert!(same(timer_delay_ms(f64::NAN), 1.0));
        assert!(same(timer_delay_ms(2_147_483_648.0), 1.0));
    }
}
