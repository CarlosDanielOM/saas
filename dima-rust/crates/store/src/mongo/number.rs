//! Numbers as the Node driver writes and reads them (ledger `mongo.md`, rules 20 to 23).
//!
//! A Mongoose `Number` is a JavaScript number. The Node BSON writer stores an integral value in
//! the int32 range as int32 and everything else (fractions, larger integers, `-0`, NaN,
//! infinities) as double. Rust writers have also stored int64 and integral doubles, so 26 field
//! paths in the real data already mix int32, int64 and double: every reader here accepts all
//! three.
//!
//! **int64 above 2^53 on read.** Node has two behaviours. A hydrated Mongoose read casts the
//! value to a JavaScript number, rounding to the nearest double (`Long.toNumber()`, one
//! correctly rounded step). A `.lean()` or raw driver read keeps magnitudes above 2^53 as a
//! `Long` object (see [`crate::mongo::json`] for how that reaches HTTP clients). The readers in
//! this module are for typed model fields, so they mirror the hydrated read: the value is
//! rounded to the nearest `f64` (`i64 as f64`), exactly what Mongoose would hand the TypeScript.

use bson::{Bson, Document};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Largest magnitude the Node driver promotes from int64 to a JavaScript number on a raw read
/// (2^53, inclusive at both ends).
pub const JS_MAX_PROMOTED_LONG: i64 = 9_007_199_254_740_992;

/// Largest integer a JavaScript number holds exactly (`Number.MAX_SAFE_INTEGER`, 2^53 - 1).
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `value` as the Node BSON writer stores a JavaScript number: int32 when it is integral and in
/// the int32 range (and not `-0`), double otherwise.
pub fn js_number(value: f64) -> Bson {
    if value.fract() == 0.0
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value)
        && !(value == 0.0 && value.is_sign_negative())
    {
        // In range and integral, so the conversion is exact.
        Bson::Int32(value as i32)
    } else {
        Bson::Double(value)
    }
}

/// An integer as Node stores it once it has been a JavaScript number: int32 in range, double
/// otherwise (above 2^53 the double is the nearest one, as in JavaScript).
pub fn js_int(value: i64) -> Bson {
    match i32::try_from(value) {
        Ok(small) => Bson::Int32(small),
        Err(_) => Bson::Double(value as f64),
    }
}

/// Reads a BSON number the way a hydrated Mongoose `Number` path does: int32 and double as
/// they are, int64 rounded to the nearest double. `None` for every other type.
pub fn read_number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(v) => Some(f64::from(*v)),
        Bson::Int64(v) => Some(*v as f64),
        Bson::Double(v) => Some(*v),
        _ => None,
    }
}

/// Reads a BSON number that the code treats as an integer (a count, epoch milliseconds stored
/// as a number). Accepts int32, int64 and integral doubles within the `i64` range; `None` for
/// fractions, NaN, infinities and other types. int64 values above 2^53 are rounded the way
/// Node reads them (see the module notes).
pub fn read_int(value: &Bson) -> Option<i64> {
    match value {
        Bson::Int32(v) => Some(i64::from(*v)),
        Bson::Int64(v) if (-JS_MAX_PROMOTED_LONG..=JS_MAX_PROMOTED_LONG).contains(v) => Some(*v),
        Bson::Int64(v) => float_to_i64(*v as f64),
        Bson::Double(v) => float_to_i64(*v),
        _ => None,
    }
}

fn float_to_i64(value: f64) -> Option<i64> {
    // 2^63 is exactly representable; every integral double below it fits an i64.
    const LIMIT: f64 = 9_223_372_036_854_775_808.0;
    (value.fract() == 0.0 && (-LIMIT..LIMIT).contains(&value)).then_some(value as i64)
}

/// Rewrites every number in `document` (recursively, arrays included) as Node would store it
/// after the value had been a JavaScript number: int32 stays, int64 and double go through
/// [`js_number`]. Other types are untouched. Use it on a document that a TypeScript writer would
/// have produced from JavaScript values.
pub fn normalize_js_numbers(document: &mut Document) {
    for (_, value) in document.iter_mut() {
        normalize_value(value);
    }
}

/// [`normalize_js_numbers`] for a single value.
pub fn normalize_js_value(value: &mut Bson) {
    normalize_value(value);
}

fn normalize_value(value: &mut Bson) {
    match value {
        Bson::Int64(v) => *value = js_number(*v as f64),
        Bson::Double(v) => *value = js_number(*v),
        Bson::Document(document) => normalize_js_numbers(document),
        Bson::Array(items) => items.iter_mut().for_each(normalize_value),
        _ => {}
    }
}

/// A Mongoose `Number` field: reads int32, int64 and double; writes like the Node BSON writer.
#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct JsNumber(pub f64);

impl JsNumber {
    /// The value as Node stores it ([`js_number`]).
    pub fn to_bson(self) -> Bson {
        js_number(self.0)
    }

    /// Reads a stored value ([`read_number`]).
    pub fn from_bson(value: &Bson) -> Option<Self> {
        read_number(value).map(Self)
    }

    /// The value as an `i64` when it is integral and a safe JavaScript integer.
    pub fn as_safe_int(self) -> Option<i64> {
        float_to_i64(self.0).filter(|v| (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(v))
    }
}

impl From<f64> for JsNumber {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

impl From<i32> for JsNumber {
    fn from(value: i32) -> Self {
        Self(f64::from(value))
    }
}

impl From<JsNumber> for Bson {
    fn from(value: JsNumber) -> Self {
        value.to_bson()
    }
}

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match js_number(self.0) {
            Bson::Int32(v) => serializer.serialize_i32(v),
            _ => serializer.serialize_f64(self.0),
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NumberVisitor).map(Self)
    }
}

/// An integer kept in a Mongoose `Number` field (a count, epoch milliseconds): reads int32,
/// int64 and integral doubles ([`read_int`]); writes like the Node BSON writer ([`js_int`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsInt(pub i64);

impl JsInt {
    /// The value as Node stores it ([`js_int`]).
    pub fn to_bson(self) -> Bson {
        js_int(self.0)
    }

    /// Reads a stored value ([`read_int`]).
    pub fn from_bson(value: &Bson) -> Option<Self> {
        read_int(value).map(Self)
    }
}

impl From<i64> for JsInt {
    fn from(value: i64) -> Self {
        Self(value)
    }
}

impl From<JsInt> for Bson {
    fn from(value: JsInt) -> Self {
        value.to_bson()
    }
}

impl Serialize for JsInt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match i32::try_from(self.0) {
            Ok(small) => serializer.serialize_i32(small),
            Err(_) => serializer.serialize_f64(self.0 as f64),
        }
    }
}

impl<'de> Deserialize<'de> for JsInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = deserializer.deserialize_any(NumberVisitor)?;
        float_to_i64(value)
            .map(Self)
            .ok_or_else(|| de::Error::invalid_value(de::Unexpected::Float(value), &"an integer"))
    }
}

/// Accepts the three BSON number types (and the integer widths other formats use).
struct NumberVisitor;

impl Visitor<'_> for NumberVisitor {
    type Value = f64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an int32, int64 or double")
    }

    fn visit_i32<E: de::Error>(self, value: i32) -> Result<f64, E> {
        Ok(f64::from(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<f64, E> {
        Ok(value as f64)
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<f64, E> {
        Ok(value as f64)
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<f64, E> {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn writer_rule_matches_node() {
        for v in [0.0, 1.0, -1.0, 2_147_483_647.0, -2_147_483_648.0] {
            assert_eq!(js_number(v), Bson::Int32(v as i32));
        }
        for v in [
            -0.0,
            0.5,
            -1.25,
            2_147_483_648.0,
            -2_147_483_649.0,
            1e21,
            f64::NAN,
            f64::INFINITY,
        ] {
            let Bson::Double(out) = js_number(v) else {
                panic!("{v} must stay a double");
            };
            assert_eq!(out.to_bits(), v.to_bits());
        }
        assert_eq!(js_int(7), Bson::Int32(7));
        assert_eq!(js_int(1_700_000_000_123), Bson::Double(1_700_000_000_123.0));
        assert_eq!(
            js_int(9_007_199_254_740_993),
            Bson::Double(9_007_199_254_740_992.0)
        );
    }

    #[test]
    fn readers_accept_every_numeric_width() {
        assert_eq!(read_number(&Bson::Int32(3)), Some(3.0));
        assert_eq!(read_number(&Bson::Int64(-165_973)), Some(-165_973.0));
        assert_eq!(read_number(&Bson::Double(27724.0)), Some(27724.0));
        assert_eq!(read_number(&Bson::String("1".into())), None);
        // Long.toNumber(): one correctly rounded step, ties to even.
        assert_eq!(
            read_number(&Bson::Int64(9_007_199_254_740_993)),
            Some(9_007_199_254_740_992.0)
        );
        assert_eq!(
            read_number(&Bson::Int64(-9_007_199_254_740_993)),
            Some(-9_007_199_254_740_992.0)
        );
        assert_eq!(
            read_number(&Bson::Int64(i64::MAX)),
            Some(9_223_372_036_854_775_808.0)
        );

        assert_eq!(read_int(&Bson::Double(27724.0)), Some(27724));
        assert_eq!(read_int(&Bson::Double(1.5)), None);
        assert_eq!(read_int(&Bson::Double(f64::NAN)), None);
        assert_eq!(read_int(&Bson::Double(1e300)), None);
        assert_eq!(read_int(&Bson::Int64(-1)), Some(-1));
        assert_eq!(
            read_int(&Bson::Int64(9_007_199_254_740_993)),
            Some(9_007_199_254_740_992)
        );
        assert_eq!(read_int(&Bson::Null), None);
    }

    #[test]
    fn safe_int_bounds() {
        assert_eq!(
            JsNumber(9_007_199_254_740_991.0).as_safe_int(),
            Some(JS_MAX_SAFE_INTEGER)
        );
        assert_eq!(
            JsNumber(-9_007_199_254_740_991.0).as_safe_int(),
            Some(-JS_MAX_SAFE_INTEGER)
        );
        assert_eq!(JsNumber(9_007_199_254_740_992.0).as_safe_int(), None);
        assert_eq!(JsNumber(-9_007_199_254_740_992.0).as_safe_int(), None);
        // -2^63 converts to i64::MIN, whose absolute value does not exist.
        assert_eq!(JsNumber(-9_223_372_036_854_775_808.0).as_safe_int(), None);
        assert_eq!(JsNumber(9_223_372_036_854_775_808.0).as_safe_int(), None);
        assert_eq!(JsNumber(1.5).as_safe_int(), None);
        assert_eq!(JsNumber(-0.0).as_safe_int(), Some(0));
    }

    #[test]
    fn serde_round_trip_through_bson() -> Result<(), Box<dyn std::error::Error>> {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct Row {
            a: JsNumber,
            b: JsNumber,
            c: JsInt,
            d: JsInt,
            e: Option<JsNumber>,
        }
        let stored = doc! { "a": 2_i64, "b": 2.5, "c": 3.0, "d": Bson::Int64(1_700_000_000_123), "e": Bson::Null };
        let row: Row = bson::deserialize_from_document(stored)?;
        assert_eq!(
            row,
            Row {
                a: JsNumber(2.0),
                b: JsNumber(2.5),
                c: JsInt(3),
                d: JsInt(1_700_000_000_123),
                e: None
            }
        );
        let written = bson::serialize_to_document(&row)?;
        assert_eq!(written.get("a"), Some(&Bson::Int32(2)));
        assert_eq!(written.get("b"), Some(&Bson::Double(2.5)));
        assert_eq!(written.get("c"), Some(&Bson::Int32(3)));
        assert_eq!(written.get("d"), Some(&Bson::Double(1_700_000_000_123.0)));
        let fraction: Result<Row, _> =
            bson::deserialize_from_document(doc! { "a": 1, "b": 1, "c": 1.5, "d": 1 });
        assert!(fraction.is_err());
        Ok(())
    }

    #[test]
    fn normalisation_rewrites_nested_numbers() {
        let mut document = doc! {
            "long": Bson::Int64(5),
            "big": Bson::Int64(1_700_000_000_123),
            "double": 4.0,
            "frac": 4.5,
            "nested": { "list": [Bson::Int64(1), 2.0, "x", { "n": -0.0 }] },
        };
        normalize_js_numbers(&mut document);
        assert_eq!(document.get("long"), Some(&Bson::Int32(5)));
        assert_eq!(
            document.get("big"),
            Some(&Bson::Double(1_700_000_000_123.0))
        );
        assert_eq!(document.get("double"), Some(&Bson::Int32(4)));
        assert_eq!(document.get("frac"), Some(&Bson::Double(4.5)));
        let expected = doc! { "list": [1, 2, "x", { "n": -0.0 }] };
        assert_eq!(document.get_document("nested").ok(), Some(&expected));
    }
}
