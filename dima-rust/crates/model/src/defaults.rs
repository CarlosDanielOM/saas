//! Serde default functions for the read types: the value a hydrated Mongoose document shows for a
//! path that is missing from the stored document (`#[serde(default = "crate::defaults::yes")]`).

use dima_store::mongo::number::JsNumber;

/// `default: true`.
pub(crate) fn yes() -> bool {
    true
}

/// `default: 0`.
pub(crate) fn zero() -> JsNumber {
    JsNumber(0.0)
}

/// `default: ''`.
pub(crate) fn empty() -> String {
    String::new()
}

/// `default: true` on a path a client may also set to `null` (read as `Option`).
pub(crate) fn some_yes() -> Option<bool> {
    Some(true)
}

/// `default: false` on a path a client may also set to `null`.
pub(crate) fn some_no() -> Option<bool> {
    Some(false)
}

/// `default: 0` on a path a client may also set to `null`.
pub(crate) fn some_zero() -> Option<JsNumber> {
    Some(zero())
}

/// `default: ''` on a path a client may also set to `null`.
pub(crate) fn some_empty() -> Option<String> {
    Some(String::new())
}

/// `null` as JavaScript's `Number(value)` and arithmetic see it: `0`.
pub(crate) fn js_number(value: Option<&JsNumber>) -> f64 {
    value.map_or(0.0, |n| n.0)
}

/// `() => new Date().getDate()` at `now_ms` (production runs in UTC).
pub(crate) fn utc_day(now_ms: i64) -> bson::Bson {
    bson::Bson::Int32(dima_text::utc_fields(now_ms).map_or(0, |f| f.day as i32))
}

/// `() => new Date().getMonth() + 1` at `now_ms`.
pub(crate) fn utc_month(now_ms: i64) -> bson::Bson {
    bson::Bson::Int32(dima_text::utc_fields(now_ms).map_or(0, |f| f.month as i32 + 1))
}

/// `() => new Date().getFullYear()` at `now_ms`.
pub(crate) fn utc_year(now_ms: i64) -> bson::Bson {
    bson::Bson::Int32(dima_text::utc_fields(now_ms).map_or(0, |f| f.year as i32))
}
