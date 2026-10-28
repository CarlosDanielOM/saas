#![cfg(feature = "keyword-store")]

use dima_rust::utils::keywords::native::{command_body_cache_value, command_body_from_document};
use mongodb::bson::{DateTime, Document};
use serde_json::Value;

fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|other| json_equal(value, other))
                })
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_equal(left, right))
        }
        _ => left == right,
    }
}
#[test]
fn command_schema_defaults_projection_maps_dates_and_minimization_match_source() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/keyword_native_cases.json")).unwrap();
    assert_eq!(
        fixture["timeZone"], "UTC",
        "run both source oracle and native tests with TZ=UTC"
    );
    let now = DateTime::from_millis(fixture["now"].as_i64().unwrap());
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for (index, case) in cases.iter().enumerate() {
        let row: Document = serde_json::from_value(case["input"].clone()).unwrap();
        let body = command_body_from_document(row, now).unwrap();
        assert!(
            json_equal(&body, &case["uncached"]),
            "uncached case {index}: {body} != {}",
            case["uncached"]
        );
        let cached = command_body_cache_value(&body);
        assert!(
            json_equal(&cached, &case["cached"]),
            "cached case {index}: {cached} != {}",
            case["cached"]
        );
    }
}
