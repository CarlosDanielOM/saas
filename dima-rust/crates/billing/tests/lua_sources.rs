//! The debit script is the TypeScript template literal plus one stated addition (charter data
//! rule 7 and item 4 of P2-BILLING-01b). Reads the frozen reference under `dimabot/src`; needs
//! no store.

use dima_billing::plans::balance::DEBIT_REVISION_LINES;
use dima_billing::plans::credits_cache::APPLY_AI_CREDIT_USAGE;

#[test]
fn apply_ai_credit_usage_is_the_typescript_text_with_the_revision() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dimabot/src/utils/billing.ts");
    let source = std::fs::read_to_string(path).unwrap_or_default();
    let marker = "const APPLY_AI_CREDIT_USAGE_SCRIPT = `";
    let text = source
        .find(marker)
        .and_then(|start| source.get(start + marker.len()..))
        .and_then(|rest| rest.find("`;").and_then(|end| rest.get(..end)));
    // Intended difference: every debit advances the usage revision before the reference's
    // logic reads the snapshot; nothing else of the text changes.
    let without_revision = APPLY_AI_CREDIT_USAGE
        .source()
        .replacen(DEBIT_REVISION_LINES, "", 1);
    assert_eq!(text, Some(without_revision.as_str()));
    assert_ne!(without_revision, APPLY_AI_CREDIT_USAGE.source());
    assert_eq!(
        APPLY_AI_CREDIT_USAGE.name(),
        "APPLY_AI_CREDIT_USAGE_REVISED"
    );
}
