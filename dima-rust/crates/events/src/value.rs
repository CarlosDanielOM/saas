//! Values as the reference's JavaScript sees them: what a producer receives (parsed JSON, or the
//! Polar SDK's objects with `Date`s in them), what the contract validator checks, and what the
//! journal stores in the `Mixed` paths `payload` and `metadata`.
//!
//! A [`Value`] is a JavaScript value restricted to what reaches the journal: JSON values, `Date`
//! (an invalid date is `NaN`), `undefined` (only as an object property the SDK set to
//! `undefined`), and, for documents read back from MongoDB, `ObjectId` and the BSON types JSON
//! has no form for ([`Value::Other`]).
//!
//! Objects keep JavaScript's property order: integer-like keys (`"0"`, `"42"`, below 2^32 - 1)
//! first in numeric order, then the others in insertion order ([`Object::insert`] does it), so a
//! payload parsed in Rust enumerates, serialises and is stored in the order `JSON.parse` would
//! have given it.
//!
//! Conversions follow the reference exactly:
//!
//! - [`Value::from_json`]: `JSON.parse` (numbers as doubles; `-0` stays `-0`).
//! - [`Value::to_json`]: `JSON.stringify` then `JSON.parse` (dates become their ISO text,
//!   `undefined` properties disappear, `undefined` array items, `NaN` and infinities become
//!   `null`, `-0` becomes `0`): `serializeDomainEventProviderData`.
//! - [`Value::to_bson`]: what the Node driver stores for the value (`int32` for an integral
//!   number in range, otherwise a double; dates as BSON dates; `undefined` properties left out,
//!   which `toObject()` and the BSON writer do for every path the journal writes).
//! - [`Value::from_bson`]: what a hydrated or lean read gives JavaScript.

use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_text::{number_to_string, to_iso_string};
use serde_json::Value as Json;

/// A JavaScript value (see the module documentation).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// `undefined`: an object property that exists with no value.
    Undefined,
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number (always a double, as in JavaScript).
    Number(f64),
    /// A string.
    String(String),
    /// A `Date` in epoch milliseconds; `NaN` for an invalid date.
    Date(f64),
    /// An `ObjectId` (read from MongoDB).
    ObjectId(ObjectId),
    /// An array.
    Array(Vec<Value>),
    /// A plain object.
    Object(Object),
    /// A BSON value that is neither JSON nor a date (binary, regex, decimal...). It fails every
    /// JSON check, as the corresponding JavaScript object does.
    Other,
}

/// A plain object: properties in JavaScript's enumeration order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    entries: Vec<(String, Value)>,
}

/// An array index key in JavaScript's sense: a canonical decimal below 2^32 - 1. Such keys
/// enumerate first, in numeric order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

impl Object {
    /// An empty object.
    pub fn new() -> Self {
        Self::default()
    }

    /// The number of properties (`Object.keys(o).length`, `undefined` ones included).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` when there are no properties.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The property `key`, `None` when it does not exist (an `undefined` property exists).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The property `key` for writing.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `o[key]` as JavaScript reads it: `undefined` when missing.
    pub fn at(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&Value::Undefined)
    }

    /// `key in o`.
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// `o[key] = value`: replaces in place, or appends in JavaScript's order.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        if let Some(slot) = self.get_mut(&key) {
            *slot = value;
            return;
        }
        match array_index(&key) {
            Some(index) => {
                let at = self
                    .entries
                    .iter()
                    .position(|(k, _)| array_index(k).is_none_or(|other| other > index))
                    .unwrap_or(self.entries.len());
                self.entries.insert(at, (key, value));
            }
            None => self.entries.push((key, value)),
        }
    }

    /// `delete o[key]`.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(at).1)
    }

    /// The properties in enumeration order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// `{...a, ...b}`: the properties of `other` added or replaced, in place.
    pub fn extend(&mut self, other: &Object) {
        for (key, value) in other.iter() {
            self.insert(key, value.clone());
        }
    }

    /// The object as BSON (see [`Value::to_bson`]).
    pub fn to_bson(&self) -> Result<Document, ValueError> {
        let mut document = Document::new();
        for (key, value) in self.iter() {
            if matches!(value, Value::Undefined) {
                continue;
            }
            document.insert(key, value.to_bson()?);
        }
        Ok(document)
    }

    /// A BSON document as JavaScript reads it.
    pub fn from_bson(document: &Document) -> Self {
        let mut object = Object::new();
        for (key, value) in document {
            object.insert(key.as_str(), Value::from_bson(value));
        }
        object
    }

    /// The object as JSON (see [`Value::to_json`]).
    pub fn to_json(&self) -> serde_json::Map<String, Json> {
        let mut map = serde_json::Map::new();
        for (key, value) in self.iter() {
            if let Some(json) = value.to_json_property() {
                map.insert(key.to_owned(), json);
            }
        }
        map
    }
}

impl FromIterator<(String, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut object = Object::new();
        for (key, value) in iter {
            object.insert(key, value);
        }
        object
    }
}

/// A value that cannot be stored.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ValueError {
    /// An invalid `Date` (`NaN`): the BSON writer cannot store it.
    #[error("an invalid date cannot be stored")]
    InvalidDate,
    /// A value JSON and BSON have no form for.
    #[error("a value of this type cannot be stored")]
    Unsupported,
}

/// A number as the Node BSON writer stores it: `int32` when integral and in range (not `-0`),
/// a double otherwise ([`dima_store::mongo::number::js_number`]).
fn number_to_bson(number: f64) -> Bson {
    dima_store::mongo::number::js_number(number)
}

impl Value {
    /// `JSON.parse` of an already parsed JSON value.
    pub fn from_json(json: &Json) -> Self {
        match json {
            Json::Null => Value::Null,
            Json::Bool(flag) => Value::Bool(*flag),
            Json::Number(number) => Value::Number(number.as_f64().unwrap_or(f64::NAN)),
            Json::String(text) => Value::String(text.clone()),
            Json::Array(items) => Value::Array(items.iter().map(Value::from_json).collect()),
            Json::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), Value::from_json(v)))
                    .collect(),
            ),
        }
    }

    /// `JSON.parse(JSON.stringify(value))`. `None` for `undefined` (and for anything
    /// `JSON.stringify` returns `undefined` for).
    pub fn to_json(&self) -> Option<Json> {
        match self {
            Value::Undefined | Value::Other => None,
            Value::Null => Some(Json::Null),
            Value::Bool(flag) => Some(Json::Bool(*flag)),
            Value::Number(number) => Some(json_number(*number)),
            Value::String(text) => Some(Json::String(text.clone())),
            Value::Date(ms) => Some(date_json(*ms)),
            Value::ObjectId(id) => Some(Json::String(id.to_hex())),
            Value::Array(items) => Some(Json::Array(
                items
                    .iter()
                    .map(|item| item.to_json().unwrap_or(Json::Null))
                    .collect(),
            )),
            Value::Object(object) => Some(Json::Object(object.to_json())),
        }
    }

    fn to_json_property(&self) -> Option<Json> {
        self.to_json()
    }

    /// What the Node driver stores for this value. `undefined` (only meaningful as a property)
    /// becomes BSON `null` here; [`Object::to_bson`] leaves such properties out.
    pub fn to_bson(&self) -> Result<Bson, ValueError> {
        Ok(match self {
            Value::Undefined | Value::Null => Bson::Null,
            Value::Bool(flag) => Bson::Boolean(*flag),
            Value::Number(number) => number_to_bson(*number),
            Value::String(text) => Bson::String(text.clone()),
            Value::Date(ms) => {
                if !ms.is_finite() {
                    return Err(ValueError::InvalidDate);
                }
                Bson::DateTime(bson::DateTime::from_millis(ms.trunc() as i64))
            }
            Value::ObjectId(id) => Bson::ObjectId(*id),
            Value::Array(items) => Bson::Array(
                items
                    .iter()
                    .map(Value::to_bson)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Value::Object(object) => Bson::Document(object.to_bson()?),
            Value::Other => return Err(ValueError::Unsupported),
        })
    }

    /// A stored BSON value as JavaScript reads it (numbers of every width as doubles, dates as
    /// `Date`s).
    pub fn from_bson(value: &Bson) -> Self {
        match value {
            Bson::Null | Bson::Undefined => Value::Null,
            Bson::Boolean(flag) => Value::Bool(*flag),
            Bson::Int32(number) => Value::Number(f64::from(*number)),
            Bson::Int64(number) => Value::Number(*number as f64),
            Bson::Double(number) => Value::Number(*number),
            Bson::String(text) => Value::String(text.clone()),
            Bson::DateTime(date) => Value::Date(date.timestamp_millis() as f64),
            Bson::ObjectId(id) => Value::ObjectId(*id),
            Bson::Array(items) => Value::Array(items.iter().map(Value::from_bson).collect()),
            Bson::Document(document) => Value::Object(Object::from_bson(document)),
            _ => Value::Other,
        }
    }

    /// The string, when this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    /// The number, when this is one.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    /// The object, when this is a plain object.
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// The object for writing.
    pub fn as_object_mut(&mut self) -> Option<&mut Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// `value[key]` for an object, `undefined` otherwise (the reference reads properties of
    /// values it has not checked; on `null`/`undefined` that would throw, and every such read in
    /// the ported code is guarded first).
    pub fn at(&self, key: &str) -> &Value {
        match self {
            Value::Object(object) => object.at(key),
            _ => &Value::Undefined,
        }
    }

    /// `value === undefined`.
    pub fn is_undefined(&self) -> bool {
        matches!(self, Value::Undefined)
    }

    /// `value == null` (`null` or `undefined`).
    pub fn is_nullish(&self) -> bool {
        matches!(self, Value::Undefined | Value::Null)
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(number) => *number != 0.0 && !number.is_nan(),
            Value::String(text) => !text.is_empty(),
            _ => true,
        }
    }

    /// `String(value)`.
    pub fn to_js_string(&self) -> String {
        match self {
            Value::Undefined => "undefined".into(),
            Value::Null => "null".into(),
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number_to_string(*number),
            Value::String(text) => text.clone(),
            // `Date.prototype.toString` (UTC on the servers); never reached with a valid input
            // by the ported code, which only stringifies identifiers.
            Value::Date(ms) => {
                if ms.is_finite() {
                    dima_text::to_date_string_utc(*ms as i64)
                        .unwrap_or_else(|| "Invalid Date".into())
                } else {
                    "Invalid Date".into()
                }
            }
            Value::ObjectId(id) => id.to_hex(),
            Value::Array(items) => items
                .iter()
                .map(|item| {
                    if item.is_nullish() {
                        String::new()
                    } else {
                        item.to_js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Value::Object(_) | Value::Other => "[object Object]".into(),
        }
    }

    /// `String(value || '')`: the reference's normalisation of identifiers before `trim()`.
    pub fn or_empty_string(&self) -> String {
        if self.truthy() {
            self.to_js_string()
        } else {
            String::new()
        }
    }
}

/// A JSON number for `JSON.stringify`: `NaN` and infinities are `null`, `-0` is `0`.
fn json_number(number: f64) -> Json {
    if !number.is_finite() {
        return Json::Null;
    }
    let number = if number == 0.0 { 0.0 } else { number };
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        return Json::Number(serde_json::Number::from(number as i64));
    }
    serde_json::Number::from_f64(number).map_or(Json::Null, Json::Number)
}

/// `Date.prototype.toJSON`: the ISO text, `null` for an invalid date.
fn date_json(ms: f64) -> Json {
    if !ms.is_finite() {
        return Json::Null;
    }
    to_iso_string(ms.trunc() as i64).map_or(Json::Null, Json::String)
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Value::String(text.to_owned())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Value::String(text)
    }
}

impl From<bool> for Value {
    fn from(flag: bool) -> Self {
        Value::Bool(flag)
    }
}

impl From<f64> for Value {
    fn from(number: f64) -> Self {
        Value::Number(number)
    }
}

impl From<Object> for Value {
    fn from(object: Object) -> Self {
        Value::Object(object)
    }
}

/// Builds an [`Object`] from `key => value` pairs, in order.
#[macro_export]
macro_rules! object {
    () => { $crate::value::Object::new() };
    ($($key:expr => $value:expr),+ $(,)?) => {{
        let mut object = $crate::value::Object::new();
        $( object.insert($key, $crate::value::Value::from($value)); )+
        object
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integer_keys_enumerate_first() {
        let value = Value::from_json(&json!({"b": 1, "10": 2, "a": 3, "2": 4, "01": 5}));
        let Value::Object(object) = value else {
            panic!("object")
        };
        let keys: Vec<&str> = object.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn json_round_trip_is_stringify_then_parse() {
        let mut object = Object::new();
        object.insert("date", Value::Date(1_700_000_000_123.0));
        object.insert("gone", Value::Undefined);
        object.insert("negative_zero", Value::Number(-0.0));
        object.insert(
            "items",
            Value::Array(vec![Value::Undefined, Value::Number(f64::NAN)]),
        );
        let json = Value::Object(object).to_json();
        assert_eq!(
            json,
            Some(json!({"date": "2023-11-14T22:13:20.123Z", "negative_zero": 0, "items": [null, null]}))
        );
    }

    #[test]
    fn bson_numbers_are_node_numbers() -> Result<(), ValueError> {
        assert_eq!(Value::Number(5.0).to_bson()?, Bson::Int32(5));
        assert_eq!(Value::Number(5.5).to_bson()?, Bson::Double(5.5));
        assert_eq!(
            Value::Number(3_000_000_000.0).to_bson()?,
            Bson::Double(3_000_000_000.0)
        );
        assert_eq!(Value::Date(f64::NAN).to_bson(), Err(ValueError::InvalidDate));
        Ok(())
    }

    #[test]
    fn js_strings() {
        assert_eq!(Value::Number(12.0).or_empty_string(), "12");
        assert_eq!(Value::Number(0.0).or_empty_string(), "");
        assert_eq!(Value::Null.or_empty_string(), "");
        assert_eq!(
            Value::Array(vec![Value::from("a"), Value::Null, Value::Number(1.0)]).to_js_string(),
            "a,,1"
        );
        assert_eq!(Value::Object(Object::new()).to_js_string(), "[object Object]");
    }
}
