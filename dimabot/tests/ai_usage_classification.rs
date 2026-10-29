#![cfg(all(feature = "ai-usage", feature = "tts-utilities"))]
//! Replay generated externally by the actual TypeScript source oracle. No Node
//! process, network, or application service is started by these tests.
use dima_rust::utils::{
    ai_usage::{ADJUSTMENT_TYPES, classify_adjustment, classify_adjustment_json},
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use serde_json::{Value, json};

#[test]
#[ignore = "external pinned actual-source corpus required"]
fn replay_actual_source_oracle() {
    let dir = std::env::var("DIMA_AI_CLASSIFICATION_REFERENCE_DIR")
        .expect("external source oracle directory is required");
    let raw = std::fs::read_to_string(
        std::path::Path::new(&dir).join("ai_usage_classification_reference.json"),
    )
    .expect("source oracle is required");
    let fixture: Value = serde_json::from_str(&raw).expect("valid oracle JSON");
    let meta = &fixture["metadata"];
    assert_eq!(meta["schema"], 1);
    assert_eq!(meta["node"], "v24.22.1");
    assert_eq!(meta["v8"], "13.6.233.17-node.58");
    assert_eq!(meta["typescript"], "5.9.3");
    assert_eq!(
        meta["hashes"]["source"],
        "00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36"
    );
    assert_eq!(
        meta["exports"],
        json!(["ADJUSTMENT_TYPES", "classifyAdjustment"])
    );
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(meta["total"].as_u64().unwrap() as usize, cases.len());
    assert!(cases.len() >= 100, "incomplete corpus");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let input =
            parse_json(case["raw"].as_str().unwrap()).unwrap_or_else(|e| panic!("{id}: {e}"));
        let actual = classify_adjustment_json(&input);
        if let Some(error) = case["result"]["error"].as_str() {
            assert_eq!(actual.unwrap_err().name(), error, "{id}");
        } else {
            assert_eq!(actual.unwrap(), case["result"]["value"].as_str(), "{id}");
        }
    }
}

#[test]
fn direct_nonfinite_and_duplicate_values() {
    let input = |source| {
        JsonValue::Object(vec![
            (
                JsString::from("entryKind"),
                JsonValue::String(JsString::from("adjustment")),
            ),
            (
                JsString::from("source"),
                JsonValue::String(JsString::from("activation")),
            ),
            (JsString::from("source"), source),
        ])
    };
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0] {
        assert_eq!(
            classify_adjustment_json(&input(JsonValue::Number(number))),
            Ok(Some("other"))
        );
    }
    assert_eq!(
        classify_adjustment_json(&input(JsonValue::String(JsString::from("activation")))),
        Ok(Some("activation"))
    );
    assert_eq!(
        classify_adjustment_json(&input(JsonValue::String(JsString::from_units(vec![
            0xd800
        ])))),
        Ok(Some("other"))
    );
}

#[test]
fn legacy_entry_point_and_explicit_short_circuit_remain_stable() {
    for kind in ADJUSTMENT_TYPES {
        let input =
            json!({"entryKind":"adjustment", "adjustmentType":kind, "source":{"toString":null}});
        assert_eq!(classify_adjustment(&input), Some(kind));
        assert_eq!(
            classify_adjustment_json(&parse_json(&input.to_string()).unwrap()),
            Ok(Some(kind))
        );
    }
    let input = json!({"entryKind":"adjustment", "source":{"toString":null}, "operation":"refund"});
    assert_eq!(classify_adjustment(&input), Some("refund"));
    assert_eq!(
        classify_adjustment_json(&parse_json(&input.to_string()).unwrap())
            .unwrap_err()
            .name(),
        "TypeError"
    );
}
