#![cfg(feature = "tts-utilities")]
use dima_rust::utils::js_string::JsString;
use serde_json::Value;

#[test]
fn utf16_string_matches_node_and_bson() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/js_string_cases.json")).unwrap();
    let cases = fixture
        .as_array()
        .or_else(|| fixture["cases"].as_array())
        .unwrap();
    for case in cases {
        let values = |value: &Value| -> Vec<u16> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect()
        };
        let bytes = |value: &Value| -> Vec<u8> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect()
        };
        let input = JsString::from_units(values(&case["inputUnits"]));
        let expected = &case["expected"];
        assert_eq!(
            input.len(),
            expected["length"].as_u64().unwrap() as usize,
            "{case}"
        );
        assert_eq!(input.is_empty(), expected["length"] == 0, "{case}");
        assert_eq!(
            input.code_units().collect::<Vec<_>>(),
            values(&expected["units"]),
            "{case}"
        );
        assert_eq!(
            input.trim().code_units().collect::<Vec<_>>(),
            values(&expected["trimUnits"]),
            "{case}"
        );
        let slice = input.slice(
            case["start"].as_i64().unwrap(),
            case["end"].as_i64().unwrap(),
        );
        assert_eq!(
            slice.code_units().collect::<Vec<_>>(),
            values(&expected["sliceUnits"]),
            "{case}"
        );
        assert_eq!(
            slice.to_json_string(),
            expected["sliceJson"].as_str().unwrap(),
            "{case}"
        );
        assert_eq!(
            slice.to_utf8_lossy().as_bytes(),
            bytes(&expected["sliceUtf8"]),
            "{case}"
        );
        assert_eq!(
            slice.to_utf8_lossy().as_bytes(),
            bytes(&expected["sliceBson"]),
            "{case}"
        );
    }
}
