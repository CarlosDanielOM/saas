//! The embedded usage script is the TypeScript template literal, byte for byte (charter data
//! rule 7). Reads the frozen reference under `dimabot/src`; needs no store.

use dima_billing::plans::credits_cache::APPLY_AI_CREDIT_USAGE;

#[test]
fn apply_ai_credit_usage_is_the_typescript_text() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dimabot/src/utils/billing.ts");
    let source = std::fs::read_to_string(path).unwrap_or_default();
    let marker = "const APPLY_AI_CREDIT_USAGE_SCRIPT = `";
    let text = source
        .find(marker)
        .and_then(|start| source.get(start + marker.len()..))
        .and_then(|rest| rest.find("`;").and_then(|end| rest.get(..end)));
    assert_eq!(text, Some(APPLY_AI_CREDIT_USAGE.source()));
    assert_eq!(APPLY_AI_CREDIT_USAGE.name(), "APPLY_AI_CREDIT_USAGE_SCRIPT");
}
