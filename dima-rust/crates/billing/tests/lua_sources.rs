//! The debit script is the TypeScript template literal plus stated additions (charter data
//! rule 7, item 4 of P2-BILLING-01b and item 1 of P2-BILLING-01c). Reads the frozen reference
//! under `dimabot/src`; needs no store.

use dima_billing::plans::balance::{DEBIT_GUARD_LINES, DEBIT_HOLD_LINES, HOLD_PRELUDE};
use dima_billing::plans::credits_cache::APPLY_AI_CREDIT_USAGE;

#[test]
fn apply_ai_credit_usage_is_the_typescript_text_with_the_hold() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dimabot/src/utils/billing.ts");
    let source = std::fs::read_to_string(path).unwrap_or_default();
    let marker = "const APPLY_AI_CREDIT_USAGE_SCRIPT = `";
    let text = source
        .find(marker)
        .and_then(|start| source.get(start + marker.len()..))
        .and_then(|rest| rest.find("`;").and_then(|end| rest.get(..end)));
    // Intended differences: the shared hold functions and a type check of the revision come
    // first; before the reference's logic reads the snapshot, the debit takes its generation
    // (a balance without its revision is deleted) and, when no queued event holds it, is held
    // against Polar's figures. Nothing else of the text changes.
    let rust = APPLY_AI_CREDIT_USAGE.source();
    let without_additions = rust
        .strip_prefix(HOLD_PRELUDE)
        .and_then(|rest| rest.strip_prefix(DEBIT_GUARD_LINES))
        .map(|rest| rest.replacen(DEBIT_HOLD_LINES, "", 1));
    assert_eq!(text, without_additions.as_deref());
    assert!(rust.contains(DEBIT_HOLD_LINES));
    assert_eq!(APPLY_AI_CREDIT_USAGE.name(), "APPLY_AI_CREDIT_USAGE_HELD");
}
