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
