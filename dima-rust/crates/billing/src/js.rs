//! The few JavaScript value rules the billing decisions depend on, in one place.
//!
//! Polar answers and stored meter snapshots are loosely typed, and the reference reads them with
//! `Number(value)`, `new Date(value)`, `Math.max` and truthiness. These helpers reproduce exactly
//! those reads over `serde_json::Value` (Polar JSON) and `bson::Bson` (stored snapshots), so a
//! decision sees the number JavaScript saw. Date text goes through [`dima_text::parse_date`]
//! (ISO 8601 and HTTP dates; V8's lenient legacy forms are refused, an allowed difference of the
//! decision log).

use serde_json::Value;

/// `Number(value)` for a JSON value; `None` is `undefined` (a missing property).
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => dima_text::parse_number(text),
        // `Number([x])` is `Number(String([x]))`.
        Some(array @ Value::Array(_)) => dima_text::parse_number(&dima_text::string_of(array)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `toFiniteNumber(value, fallback)` (`billing.ts`): `typeof value === 'number' ? value :
/// Number(value)`, then the fallback when not finite.
pub fn finite_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = number(value);
    if number.is_finite() { number } else { fallback }
}

/// `typeof value === 'number'` (any number, `NaN` excluded only because JSON has none).
pub fn as_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    }
}

/// `Math.max(a, b)`: `NaN` wins, `+0` is above `-0`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: `NaN` wins, `-0` is below `+0`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.round`.
pub fn round(x: f64) -> f64 {
    dima_text::math_round(x)
}

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `new Date(value).getTime()` for a JSON value, `None` for an invalid date: a string is parsed,
/// a number is a time value, `null` is 0, anything else is invalid.
pub fn date_ms(value: Option<&Value>) -> Option<i64> {
    let ms = match value? {
        Value::String(text) => return dima_text::parse_date(text),
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64()?,
        Value::Array(_) | Value::Object(_) => return None,
    };
    time_clip(ms)
}

/// ECMAScript `TimeClip`: the integer part of a finite time value within ±8.64e15, else invalid.
pub fn time_clip(ms: f64) -> Option<i64> {
    if !ms.is_finite() || ms.abs() > dima_text::MAX_TIME_MS as f64 {
        return None;
    }
    // Within ±8.64e15 the truncation is exact.
    #[allow(clippy::cast_possible_truncation)]
    Some(ms.trunc() as i64)
}

/// A stored BSON value as the JSON JavaScript would have seen on a lean read (numbers of every
/// width as numbers, dates as their time value for numeric reads, the rest structurally).
pub fn bson_to_json(value: &bson::Bson) -> Value {
    use bson::Bson;
    match value {
        Bson::Double(x) => serde_json::Number::from_f64(*x).map_or(Value::Null, Value::Number),
        Bson::Int32(x) => Value::from(*x),
        Bson::Int64(x) => Value::from(*x),
        Bson::String(text) => Value::String(text.clone()),
        Bson::Boolean(flag) => Value::Bool(*flag),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Array(items) => Value::Array(items.iter().map(bson_to_json).collect()),
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(key, value)| (key.clone(), bson_to_json(value)))
                .collect(),
        ),
        Bson::DateTime(date) => Value::from(date.timestamp_millis()),
        Bson::Decimal128(decimal) => Value::String(decimal.to_string()),
        Bson::ObjectId(id) => Value::String(id.to_hex()),
        other => Value::String(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_follows_javascript() {
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(number(Some(&json!(""))), 0.0);
        assert_eq!(number(Some(&json!([7]))), 7.0);
        assert_eq!(number(Some(&json!([]))), 0.0);
        assert!(number(Some(&json!([1, 2]))).is_nan());
        assert!(number(Some(&json!({}))).is_nan());
        assert_eq!(number(Some(&json!(true))), 1.0);
        assert_eq!(finite_or(Some(&json!("abc")), 5.0), 5.0);
    }

    #[test]
    fn max_and_min_follow_javascript() {
        assert!(max(f64::NAN, 1.0).is_nan());
        assert!(max(-0.0, 0.0).is_sign_positive());
        assert!(min(0.0, -0.0).is_sign_negative());
        assert_eq!(max(2.0, 3.0), 3.0);
    }

    #[test]
    fn dates_follow_javascript() {
        assert_eq!(
            date_ms(Some(&json!("1970-01-01T00:00:01.000Z"))),
            Some(1000)
        );
        assert_eq!(date_ms(Some(&json!(null))), Some(0));
        assert_eq!(date_ms(Some(&json!(1.9))), Some(1));
        assert_eq!(date_ms(Some(&json!(8.64e15 + 1.0))), None);
        assert_eq!(date_ms(Some(&json!("nope"))), None);
        assert_eq!(date_ms(None), None);
    }
}
