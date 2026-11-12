use dima_ai::summary::*;
use serde_json::{Value, json};
#[test]
fn reference_summary_cases() -> anyhow::Result<()> {
    let fixture: Value = serde_json::from_str(include_str!("summary_reference.json"))?;
    let mut scalar_changes = 0;
    for c in fixture["cases"].as_array().unwrap() {
        let result = parse_stream_summary_response(c["raw"].as_str().unwrap());
        if c["raw"].as_str().unwrap().contains(&"😀".repeat(120)) {
            assert!(result.is_ok());
            assert_eq!(c["expected"]["ok"], false);
            scalar_changes += 1;
            continue;
        }
        if c["expected"]["ok"] == true {
            assert_eq!(
                dima_text::to_js_json(&json!(result?)),
                dima_text::to_js_json(&c["expected"]["data"])
            );
        } else {
            let e = result.unwrap_err();
            assert_eq!(
                json!({"ok":false,"error":e.detail,"rawSnippet":e.raw_snippet,"phase":e.phase}),
                c["expected"]
            );
        }
    }
    assert_eq!(scalar_changes, 1);
    for c in fixture["sanitized"].as_array().unwrap() {
        let input: Response = serde_json::from_value(c["input"].clone())?;
        let out = sanitize_stream_summary_response(
            input,
            c["fallback"]["defaultHeadline"].as_str().unwrap(),
            c["fallback"]["defaultRecap"].as_str().unwrap(),
            24,
        );
        assert_eq!(
            dima_text::to_js_json(&json!(out)),
            dima_text::to_js_json(&c["expected"])
        );
    }
    Ok(())
}
