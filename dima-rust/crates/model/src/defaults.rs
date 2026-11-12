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
