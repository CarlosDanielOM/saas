//! A read-only view of an untyped stored value as JavaScript would see it.
//!
//! Permission expressions and some settings are stored as Mongoose `Mixed` values, so the
//! reference inspects them with `typeof`, `Array.isArray` and `Object.keys`. They reach Rust as
//! JSON (API bodies, fixtures) or as raw BSON (`dima-model` keeps `Mixed` paths as [`bson::Bson`]).
//! [`JsView`] gives both the same JavaScript reading, so one validator serves both.
//!
//! The rules themselves (`String()`, `Number()`, truthiness, property order) and the [`Js`] kinds
//! are `dima-text`'s. This crate keeps its own [`JsView`] trait only because Rust's orphan rule
//! forbids implementing `dima_text::JsView` for `bson::Bson` here; the functions below apply the
//! shared rules through `dima-text`'s `_with` forms.
//!
//! BSON values that are JavaScript objects but not plain documents (ObjectId, Date, Binary,
//! Decimal128, regular expressions and the rest) read as [`Js::Other`]. JavaScript would see an
//! object with no recognised operator key there; this crate treats them the same way: they are
//! never valid expression nodes.

pub use dima_text::Js;

/// A JavaScript reading of an untyped value. Implemented for [`serde_json::Value`] (through
/// `dima_text::JsView`) and [`bson::Bson`].
pub trait JsView: Sized {
    /// The kind of value.
    fn js(&self) -> Js<'_, Self>;
    /// The keys of a plain object in stored order (empty for anything else).
    fn keys(&self) -> Vec<&str>;
    /// A property of a plain object.
    fn get(&self, key: &str) -> Option<&Self>;
}

impl JsView for serde_json::Value {
    fn js(&self) -> Js<'_, Self> {
        dima_text::JsView::js(self)
    }

    fn keys(&self) -> Vec<&str> {
        dima_text::JsView::keys(self)
    }

    fn get(&self, key: &str) -> Option<&Self> {
        dima_text::JsView::get(self, key)
    }
}

impl JsView for bson::Bson {
    fn js(&self) -> Js<'_, Self> {
        use bson::Bson;
        match self {
            Bson::Undefined => Js::Undefined,
            Bson::Null => Js::Null,
            Bson::Boolean(flag) => Js::Bool(*flag),
            Bson::Int32(n) => Js::Number(f64::from(*n)),
            // Mongoose reads int64 with `promoteLongs`: a JavaScript number, rounded.
            Bson::Int64(n) => Js::Number(*n as f64),
            Bson::Double(n) => Js::Number(*n),
            Bson::String(text) | Bson::Symbol(text) => Js::String(text),
            Bson::Array(items) => Js::Array(items),
            Bson::Document(_) => Js::Object,
            _ => Js::Other,
        }
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            bson::Bson::Document(document) => document.keys().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            bson::Bson::Document(document) => document.get(key),
            _ => None,
        }
    }
}

/// `Object.keys(value)` ([`dima_text::js_property_order`]).
pub(crate) fn js_object_keys<V: JsView>(value: &V) -> Vec<&str> {
    dima_text::js_property_order(value.keys())
}

/// `String(value)` ([`dima_text::js_string_with`]).
pub(crate) fn js_string<V: JsView>(value: &V) -> String {
    dima_text::js_string_with(value, V::js)
}

/// `Number(value)` ([`dima_text::js_number_with`]).
pub(crate) fn js_number<V: JsView>(value: &V) -> f64 {
    dima_text::js_number_with(value, V::js)
}

/// JavaScript truthiness ([`dima_text::js_truthy_with`]).
pub(crate) fn js_truthy<V: JsView>(value: &V) -> bool {
    dima_text::js_truthy_with(value, V::js)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{Bson, doc};
    use serde_json::json;

    #[test]
    fn keys_follow_javascript_property_order() {
        let value = json!({"role": 1, "10": 2, "b": 3, "2": 4, "01": 5});
        assert_eq!(js_object_keys(&value), ["2", "10", "role", "b", "01"]);
        let stored = Bson::Document(doc! {"role": 1, "10": 2, "b": 3, "2": 4, "01": 5});
        assert_eq!(js_object_keys(&stored), ["2", "10", "role", "b", "01"]);
    }

    #[test]
    fn string_of_matches_javascript() {
        assert_eq!(js_string(&json!([1, null, [2, null], "x"])), "1,,2,,x");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&Bson::Undefined), "undefined");
        assert_eq!(
            js_string(&Bson::Array(vec![
                Bson::Undefined,
                Bson::Int64(7),
                Bson::Null
            ])),
            ",7,"
        );
        assert_eq!(
            js_string(&Bson::ObjectId(bson::oid::ObjectId::new())),
            "[object Object]"
        );
        let deep = (0..1_000).fold(json!(1), |inner, _| json!([inner]));
        assert_eq!(js_string(&deep), "1");
    }

    #[test]
    fn bson_numbers_read_as_javascript_numbers() {
        assert!(matches!(Bson::Int32(7).js(), Js::Number(n) if n == 7.0));
        assert!(matches!(Bson::Int64(7).js(), Js::Number(n) if n == 7.0));
        assert!(matches!(
            Bson::ObjectId(bson::oid::ObjectId::new()).js(),
            Js::Other
        ));
        assert_eq!(
            js_number(&Bson::Array(vec![Bson::String(" 7 ".into())])),
            7.0
        );
        assert!(js_number(&Bson::Undefined).is_nan());
        assert!(!js_truthy(&Bson::Undefined));
        assert!(js_truthy(&Bson::DateTime(bson::DateTime::now())));
    }
}
