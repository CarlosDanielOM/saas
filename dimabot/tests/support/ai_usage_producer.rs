#[allow(dead_code)]
#[path = "ai_usage_source.rs"]
mod ai_usage_source;

use dima_rust::utils::{
    ai_usage_producer::*,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};

pub fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    value
        .get(key)
        .unwrap_or_else(|| panic!("missing fixture field {key}"))
}
pub fn array(value: &JsonValue) -> &[JsonValue] {
    match value {
        JsonValue::Array(a) => a,
        _ => panic!("expected fixture array"),
    }
}
pub fn string(value: &JsonValue) -> &JsString {
    match value {
        JsonValue::String(s) => s,
        _ => panic!("expected fixture string"),
    }
}
pub fn text(value: &JsonValue) -> &str {
    string(value).as_str().expect("fixture ASCII/UTF8")
}
pub fn number(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Number(n) => *n,
        _ => panic!("expected number"),
    }
}
pub fn yes(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Bool(true))
}
pub fn bits(value: &JsonValue) -> f64 {
    let hex = text(value);
    assert_eq!(hex.len(), 16);
    f64::from_bits(u64::from_str_radix(hex, 16).expect("binary64 hex"))
}
pub fn hex64(value: &JsonValue) -> bool {
    matches!(value, JsonValue::String(s) if s.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))))
}
pub fn fixture() -> JsonValue {
    let dir = std::env::var("DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR")
        .expect("required actual-source fixture directory");
    let raw = std::fs::read_to_string(
        std::path::Path::new(&dir).join("ai_usage_producer_reference.json"),
    )
    .expect("required source fixture");
    let f = parse_json(&raw).expect("lossless source fixture");
    let meta = field(&f, "metadata");
    assert_eq!(number(field(meta, "format")), 2.0);
    for (key, value) in [
        ("node", "v24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(text(field(meta, key)), value);
    }
    let hashes = field(meta, "hashes");
    for name in [
        "src/utils/ai_usage_ledger.ts",
        "src/utils/ai_usage_classification.ts",
        "src/utils/ai_usage_event.ts",
        "src/utils/ai_usage_receipts.ts",
        "src/schemas/ai_usage_receipt.schema.ts",
        "src/utils/ai_usage.rs",
        "src/utils/credit_policy.rs",
        "src/utils/js_string.rs",
        "src/utils/lossless_json.rs",
        "src/utils/json_number.rs",
        "src/utils/js_compat.rs",
        "src/utils/ai_usage_receipts/values.rs",
        "src/utils/ai_usage_receipts/queue.rs",
        "src/utils/ai_usage_receipts.rs",
        "package.json",
        "package-lock.json",
        "tests/ai_usage_producer.rs",
        "tests/ai_usage_producer_redis.rs",
        "tests/support/ai_usage_producer.rs",
        "src/utils/ai_usage_producer.rs",
        "reader",
        "loader",
        "node",
        "typescript",
        "typescriptPackage",
    ] {
        assert!(hex64(field(hashes, name)), "strict SHA256 for {name}");
    }
    assert_eq!(
        text(field(hashes, ai_usage_source::LOGICAL)),
        ai_usage_source::SHA256
    );
    let _ = ai_usage_source::path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        ai_usage_source::LOGICAL,
    );
    assert!(hex64(field(meta, "extractedSha256")));
    let ast = field(meta, "ast");
    let declarations = array(field(ast, "declarations"));
    let names = [
        "AI_USAGE_RECEIPT_QUEUE_KEY",
        "AI_USAGE_RECEIPT_PROCESSING_KEY",
        "RETENTION_DAYS",
        "VALID_CATEGORIES",
        "validTier",
        "safeCategory",
        "finiteNumber",
        "getAiUsageRetentionDays",
        "buildQueuedAiUsageReceipt",
        "enqueueAiUsageReceipt",
        "QueuedAiUsageReceipt",
    ];
    assert_eq!(declarations.len(), names.len());
    for name in names {
        let d = declarations
            .iter()
            .find(|d| text(field(d, "name")) == name)
            .expect("AST declaration evidence");
        assert!(hex64(field(d, "sha256")));
        assert!(!text(field(d, "text")).is_empty());
        let private = [
            "RETENTION_DAYS",
            "VALID_CATEGORIES",
            "validTier",
            "safeCategory",
            "finiteNumber",
        ]
        .contains(&name);
        assert_eq!(yes(field(d, "exported")), !private);
    }
    let q = declarations
        .iter()
        .find(|d| text(field(d, "name")) == "QueuedAiUsageReceipt")
        .unwrap();
    assert!(text(field(q, "text")).contains("extends AiUsageTransaction"));
    let types = array(field(ast, "types"));
    assert_eq!(types.len(), 9);
    for name in [
        "AiUsageContext",
        "AiUsageContextInput",
        "AiUsageEntryKind",
        "AiUsageCategory",
        "AiUsageUnit",
        "AiUsageResourceType",
        "AiUsageTransaction",
        "AiUsageReceiptCategory",
        "AiUsageRetentionTier",
    ] {
        let t = types
            .iter()
            .find(|t| text(field(t, "name")) == name)
            .expect("AST type evidence");
        assert!(hex64(field(t, "sha256")));
        assert!(text(field(t, "text")).contains(name));
    }
    let modules = array(field(ast, "sourceModules"));
    assert_eq!(modules.len(), 2);
    for (file, count) in [
        ("src/utils/ai_usage_classification.ts", 2),
        ("src/utils/ai_usage_event.ts", 6),
    ] {
        let m = modules
            .iter()
            .find(|m| text(field(m, "file")) == file)
            .expect("actual classification/event AST evidence");
        let declarations = array(field(m, "declarations"));
        assert_eq!(declarations.len(), count);
        for d in declarations {
            assert!(hex64(field(d, "sha256")));
            assert!(!text(field(d, "text")).is_empty());
        }
    }
    assert!(array(field(ast, "imports")).len() >= 8);
    assert_eq!(text(field(&f, "queue")), AI_USAGE_RECEIPT_QUEUE_KEY);
    assert_eq!(
        text(field(&f, "processing")),
        AI_USAGE_RECEIPT_PROCESSING_KEY
    );
    assert_eq!(
        array(field(&f, "cases"))
            .iter()
            .filter(|c| c.get("integrationRole").is_some())
            .count(),
        9
    );
    assert!(array(field(&f, "cases")).len() >= 300);
    assert!(array(field(&f, "tiers")).len() >= 20);
    assert_eq!(
        number(field(meta, "caseCount")) as usize,
        array(field(&f, "cases")).len()
    );
    assert_eq!(
        number(field(meta, "tierCount")) as usize,
        array(field(&f, "tiers")).len()
    );
    assert!(number(field(meta, "assertionCount")) >= 2000.0);
    f
}
pub fn context(input: &JsonValue) -> JsonValue {
    let mut c = parse_json(text(field(input, "contextJson"))).expect("context JSON");
    let JsonValue::Object(fields) = &mut c else {
        panic!("context object")
    };
    if let Some(b) = input.get("quantityBits") {
        fields.retain(|(key, _)| key.as_str() != Some("quantity"));
        fields.push(("quantity".into(), JsonValue::Number(bits(b))));
    }
    if let Some(keys) = input.get("undefinedKeys") {
        fields.retain(|(key, _)| !array(keys).iter().any(|k| key == string(k)));
    }
    c
}
pub fn occurred(input: &JsonValue) -> Option<JsDate> {
    let d = field(input, "occurredAt");
    yes(field(d, "present")).then(|| JsDate::from_millis(bits(field(d, "bits"))))
}
#[allow(dead_code)] // shared helper is used only by the Redis integration target
pub fn build_case(case: &JsonValue, now: JsDate) -> Option<QueuedAiUsageReceipt> {
    let i = field(case, "input");
    build_queued_ai_usage_receipt_at(
        string(field(i, "channelID")).clone(),
        string(field(i, "customerId")).clone(),
        occurred(i),
        now,
        &context(i),
        bits(field(i, "creditsBits")),
    )
}
