//! BSON representation primitives for JavaScript-compatible ports.
//!
//! These do not coerce JSON values or validate application numbers. Callers
//! retain their own parsing, safe-integer checks, and payload policies.

use mongodb::bson::{Bson, Document};

/// Node promotes BSON Long values through inclusive +/-2^53 to JS Numbers.
/// This driver boundary differs from `Number.isSafeInteger`'s +/- (2^53 - 1).
const JS_MAX_PROMOTED_INTEGER: i64 = 9_007_199_254_740_992;

/// Serializes an already-coerced JavaScript Number like the Node BSON writer:
/// integral values within inclusive Int32 bounds become Int32; fractions,
/// larger values, negative zero, NaN, and infinities remain Double.
pub fn js_number(value: f64) -> Bson {
    let negative_zero = value == 0.0 && value.is_sign_negative();
    if !negative_zero
        && value.is_finite()
        && value.fract() == 0.0
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value)
    {
        Bson::Int32(value as i32)
    } else {
        Bson::Double(value)
    }
}

/// Normalizes document/array numbers as a Node read followed by a JS rewrite.
/// Promoted Longs use Number encoding, while larger Longs and other BSON types
/// retain their representation. Callers decide which payloads to rewrite.
pub fn normalize_document(document: &mut Document) {
    for (_, value) in document.iter_mut() {
        normalize_js_numbers(value);
    }
}

pub(crate) fn normalize_js_numbers(value: &mut Bson) {
    match value {
        Bson::Double(number) => *value = js_number(*number),
        Bson::Int64(number)
            if (-JS_MAX_PROMOTED_INTEGER..=JS_MAX_PROMOTED_INTEGER).contains(number) =>
        {
            *value = js_number(*number as f64);
        }
        Bson::Document(document) => normalize_document(document),
        Bson::Array(values) => values.iter_mut().for_each(normalize_js_numbers),
        // Int32 already has the representation js_number would produce.
        _ => {}
    }
}

/// Convert JSON values through JavaScript's binary64 Number boundary before
/// applying the Node BSON writer's number encoding recursively.
#[cfg(feature = "bits-rules")]
pub(crate) fn json_to_bson(value: &serde_json::Value) -> Result<Bson, &'static str> {
    use serde_json::Value;
    let converted = match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::String(value) => Bson::String(value.clone()),
        Value::Number(value) => {
            let mut number = Bson::Double(
                value
                    .as_f64()
                    .ok_or("JSON number is not representable as binary64")?,
            );
            normalize_js_numbers(&mut number);
            number
        }
        Value::Array(values) => {
            Bson::Array(values.iter().map(json_to_bson).collect::<Result<_, _>>()?)
        }
        Value::Object(values) => Bson::Document(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), json_to_bson(value)?)))
                .collect::<Result<_, &'static str>>()?,
        ),
    };
    Ok(converted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{DateTime, doc};

    #[test]
    fn number_encoding_preserves_int32_boundaries_and_special_doubles() {
        for number in [f64::from(i32::MIN), -1.0, 0.0, f64::from(i32::MAX)] {
            assert_eq!(js_number(number), Bson::Int32(number as i32));
        }
        for number in [
            f64::from(i32::MIN) - 1.0,
            f64::from(i32::MAX) + 1.0,
            -0.0,
            -0.5,
            0.5,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NAN,
        ] {
            let Bson::Double(encoded) = js_number(number) else {
                panic!("expected Double for {number}");
            };
            assert_eq!(encoded.to_bits(), number.to_bits());
        }
    }

    #[test]
    fn recursive_normalization_preserves_unpromoted_longs_and_other_bson_types() {
        let date = DateTime::from_millis(123);
        let decimal = Bson::Decimal128("123.450".parse().unwrap());
        let mut document = doc! {
            "nested": [{
                "int32": Bson::Int32(i32::MIN),
                "integralDouble": Bson::Double(4.0),
                "smallLong": Bson::Int64(7),
                "negativeZero": Bson::Double(-0.0),
                "nan": Bson::Double(f64::NAN),
                "date": date,
                "decimal": decimal.clone(),
                "text": "7",
                "null": Bson::Null,
            }],
            "longs": [
                Bson::Int64(-JS_MAX_PROMOTED_INTEGER),
                Bson::Int64(JS_MAX_PROMOTED_INTEGER),
                Bson::Int64(-JS_MAX_PROMOTED_INTEGER - 1),
                Bson::Int64(JS_MAX_PROMOTED_INTEGER + 1),
                Bson::Int64(i64::MIN),
                Bson::Int64(i64::MAX),
            ],
        };
        normalize_document(&mut document);
        let nested = document.get_array("nested").unwrap()[0]
            .as_document()
            .unwrap();
        assert_eq!(nested.get("int32"), Some(&Bson::Int32(i32::MIN)));
        assert_eq!(nested.get("integralDouble"), Some(&Bson::Int32(4)));
        assert_eq!(nested.get("smallLong"), Some(&Bson::Int32(7)));
        assert!(
            matches!(nested.get("negativeZero"), Some(Bson::Double(value)) if value.to_bits() == (-0.0_f64).to_bits())
        );
        assert!(matches!(nested.get("nan"), Some(Bson::Double(value)) if value.is_nan()));
        assert_eq!(nested.get("date"), Some(&Bson::DateTime(date)));
        assert_eq!(nested.get("decimal"), Some(&decimal));
        assert_eq!(nested.get_str("text").unwrap(), "7");
        assert_eq!(nested.get("null"), Some(&Bson::Null));
        assert_eq!(
            document.get_array("longs").unwrap().as_slice(),
            &[
                Bson::Double(-9_007_199_254_740_992.0),
                Bson::Double(9_007_199_254_740_992.0),
                Bson::Int64(-JS_MAX_PROMOTED_INTEGER - 1),
                Bson::Int64(JS_MAX_PROMOTED_INTEGER + 1),
                Bson::Int64(i64::MIN),
                Bson::Int64(i64::MAX),
            ]
        );
    }
}
