#![cfg(feature = "ai-usage-receipt-parser")]

//! Author-only: parent must wire the opt-in modules/features before compiling.
//! No fixture/test/oracle ran in this task.
#[allow(dead_code)]
#[path = "support/ai_usage_source.rs"]
mod ai_usage_source;

use dima_rust::utils::{
    ai_usage::EntryKind,
    ai_usage_receipt_parser::{ParsedAiUsageReceipt, RetentionTier, parse_queued_ai_usage_receipt},
    js_string::JsString,
    lossless_json::{
        JsonValue, JsonValueRef, fields_to_json_string, parse_json, write_json_fields,
    },
    lossless_json_view::{JsonDocument, JsonView, js_number as view_number},
};
use mongodb::bson::{Bson, Document};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn parse(patch: &str) -> Option<ParsedAiUsageReceipt> {
    // JSON duplicate names deliberately apply the last patch value.
    parse_queued_ai_usage_receipt(&format!(
        r#"{{"channelID":"c","customerId":"u","id":"e","occurredAt":"1970-01-01T00:00:00Z","credits":1,{patch}}}"#
    ))
}
fn string_field(receipt: &ParsedAiUsageReceipt, key: &str) -> JsString {
    match receipt.get(key).expect("field") {
        JsonValue::String(value) => value,
        _ => panic!("expected string {key}"),
    }
}

#[test]
fn utf16_is_retained_through_trim_slice_and_wire_until_bson() {
    let long = format!(" {}😀tail ", "a".repeat(127));
    let patch = format!(
        r#""id":"e\ud800","provider":{},"source":"\ufeff\udc00 \u3000""#,
        serde_json::to_string(&long).unwrap()
    );
    let receipt = parse(&patch).unwrap();
    assert_eq!(receipt.id().units(), vec![b'e' as u16, 0xd800]);
    let provider = string_field(&receipt, "provider");
    assert_eq!(provider.len(), 128);
    assert_eq!(provider.code_units().last(), Some(0xd83d));
    assert_eq!(string_field(&receipt, "source").units(), vec![0xdc00]);
    assert!(receipt.json().contains(r#""id":"e\ud800""#));
    assert!(receipt.try_utf8_fields().is_none());
    let document = receipt.to_bson_document(RetentionTier::Free).unwrap();
    assert_eq!(document.get_str("entryId").unwrap(), "e�");
    assert_eq!(
        document.get_str("provider").unwrap(),
        format!("{}�", "a".repeat(127))
    );
    assert_eq!(
        document.get_str("source").unwrap().as_bytes(),
        &[0xef, 0xbf, 0xbd]
    );
    assert_eq!(
        receipt.id().code_units().last(),
        Some(0xd800),
        "adapter cannot rewrite DTO"
    );
    let replacement_id = parse(r#""id":"e�""#).unwrap();
    assert_ne!(receipt.id(), replacement_id.id());
    assert_eq!(
        document.get_str("entryId").unwrap(),
        replacement_id
            .to_bson_document(RetentionTier::Free)
            .unwrap()
            .get_str("entryId")
            .unwrap(),
        "source BSON boundary can collapse distinct UTF16 IDs"
    );
    assert_eq!(
        document
            .get_datetime("expiresAt")
            .unwrap()
            .timestamp_millis(),
        30 * 86_400_000
    );
}

#[test]
fn own_noncallable_to_string_and_classifier_short_circuit() {
    assert!(parse(r#""id":{"toString":null}"#).is_none());
    assert!(parse(r#""quantity":[[{"toString":0}]]"#).is_none());
    assert!(parse(r#""entryKind":"adjustment","source":{"toString":null}"#).is_none());
    assert!(
        parse(r#""source":{"toString":null}"#).is_some(),
        "usage skips classifier coercion"
    );
    let receipt = parse(r#""entryKind":"adjustment","adjustmentType":"other","source":{"toString":null},"operation":{"toString":null}"#).unwrap();
    assert_eq!(
        string_field(&receipt, "adjustmentType").as_str(),
        Some("other")
    );
    let receipt = parse(r#""credits":-1,"entryKind":"usage","source":["polar_meter_credit"],"operation":["refund"]"#).unwrap();
    assert_eq!(receipt.entry_kind(), EntryKind::Adjustment);
    assert_eq!(
        string_field(&receipt, "adjustmentType").as_str(),
        Some("native_grant")
    );
    assert_eq!(receipt.get("source"), Some(JsonValue::Null));
    let receipt = parse(r#""entryKind":"adjustment","operation":" refund ""#).unwrap();
    assert_eq!(string_field(&receipt, "operation").as_str(), Some("refund"));
    assert_eq!(
        string_field(&receipt, "adjustmentType").as_str(),
        Some("other"),
        "classification precedes trim"
    );
}

#[test]
fn binary64_truthiness_missing_null_and_bson_number_boundaries() {
    let receipt =
        parse(r#""channelID":[],"id":[null,[],["a","b"]],"credits":-0,"quantity":null"#).unwrap();
    assert_eq!(
        receipt.channel_id().as_str(),
        Some(""),
        "[] is truthy before String([])"
    );
    assert_eq!(receipt.id().as_str(), Some(",,a,b"));
    assert_eq!(receipt.credits().to_bits(), (-0.0_f64).to_bits());
    let unicode_fields = receipt.try_utf8_fields().unwrap();
    assert_eq!(
        unicode_fields
            .iter()
            .find(|(key, _)| *key == "credits")
            .unwrap()
            .1
            .as_f64()
            .unwrap()
            .to_bits(),
        (-0.0_f64).to_bits(),
        "ordinary numeric access retains signed zero"
    );
    assert_eq!(receipt.quantity().unwrap().to_bits(), 0.0_f64.to_bits());
    assert_eq!(receipt.entry_kind(), EntryKind::Usage);
    assert!(
        matches!(receipt.to_bson_document(RetentionTier::Free).unwrap().get("credits"), Some(Bson::Double(n)) if n.to_bits() == (-0.0_f64).to_bits())
    );
    assert!(receipt.json().contains(r#""credits":0"#));
    for key in ["credits", "quantity"] {
        assert!(parse(&format!(r#""{key}":{{"toString":null}}"#)).is_none());
    }
    assert!(parse(r#""credits":1e309"#).is_none());
    assert_eq!(parse(r#""quantity":1e309"#).unwrap().quantity(), None);
    assert_eq!(parse(r#""unused":null"#).unwrap().quantity(), None);
    assert_eq!(
        parse(r#""credits":"0x20000000000003""#).unwrap().credits(),
        9_007_199_254_740_996.0
    );
    for (token, int32) in [
        ("2147483647", true),
        ("2147483648", false),
        ("-2147483648", true),
        ("-2147483649", false),
        ("0.5", false),
        ("-0", false),
    ] {
        let document = parse(&format!(r#""credits":{token}"#))
            .unwrap()
            .to_bson_document(RetentionTier::Free)
            .unwrap();
        assert_eq!(
            matches!(document.get("credits"), Some(Bson::Int32(_))),
            int32,
            "{token}"
        );
    }
    for raw in [
        "null",
        "[]",
        "{}",
        "true",
        r#"{"channelID":"c","customerId":"u","id":"e","occurredAt":"1970-01-01"}"#,
    ] {
        assert!(parse_queued_ai_usage_receipt(raw).is_none());
    }
}

#[test]
fn date_adapter_uses_timeclip_and_source_field_order() {
    let receipt = parse(r#""occurredAt":"+275760-09-13T00:00:00.000Z""#).unwrap();
    assert!(
        receipt.to_bson_document(RetentionTier::Free).is_err(),
        "Mongoose rejects invalid expiry Date"
    );
    assert!(parse(r#""occurredAt":"+275760-09-13T00:00:00.001Z""#).is_none());
    assert!(parse(r#""occurredAt":"2026-10-29\ud800""#).is_none());
    let receipt = parse(
        r#""occurredAt":"1970-01-01\u0000ignored","0":1,"2":3,"unknown":{},"itemized":"true""#,
    )
    .unwrap();
    assert_eq!(receipt.occurred_at().timestamp_millis(), Some(0));
    assert_eq!(receipt.get("itemized"), Some(JsonValue::Bool(false)));
    let keys: Vec<_> = receipt
        .ordered_fields()
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert_eq!(
        keys,
        [
            "channelID",
            "customerId",
            "id",
            "requestId",
            "occurredAt",
            "entryKind",
            "category",
            "operation",
            "source",
            "adjustmentType",
            "provider",
            "model",
            "quantity",
            "unit",
            "credits",
            "resourceType",
            "resourceId",
            "itemized"
        ]
    );
    let document = receipt.to_bson_document(RetentionTier::Pro).unwrap();
    assert_eq!(
        document.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "channelID",
            "customerId",
            "entryId",
            "requestId",
            "occurredAt",
            "entryKind",
            "category",
            "operation",
            "source",
            "adjustmentType",
            "provider",
            "model",
            "quantity",
            "unit",
            "credits",
            "resourceType",
            "resourceId",
            "itemized",
            "retentionTier",
            "expiresAt"
        ]
    );
    assert_eq!(
        receipt
            .try_utf8_fields()
            .unwrap()
            .iter()
            .map(|(k, _)| *k)
            .collect::<Vec<_>>(),
        keys
    );
}

#[test]
fn deep_input_is_borrowed_while_coerced_arrays_remain_lossless_and_strict() {
    for depth in [129, 256] {
        let nest = |leaf: &str| format!("{}{leaf}{}", "[".repeat(depth), "]".repeat(depth));
        let receipt = parse(&format!(r#""id":{},"credits":{},"quantity":{},"category":{},"unit":{},"resourceType":{},"requestId":{}"#,
            nest(r#"[null,[],["\ud800","x"]]"#), nest(r#""-0""#), nest(r#""0x20000000000003""#), nest(r#""tts""#), nest(r#""tokens""#), nest(r#""speech""#), nest(r#""request""#))).unwrap();
        assert_eq!(receipt.id().units(), vec![44, 44, 0xd800, 44, 120]);
        assert_eq!(receipt.credits().to_bits(), (-0.0_f64).to_bits());
        assert_eq!(receipt.quantity(), Some(9_007_199_254_740_996.0));
        assert_eq!(
            string_field(&receipt, "category").as_str(),
            Some("uncategorized")
        );
        for key in ["unit", "resourceType", "requestId"] {
            assert_eq!(receipt.get(key), Some(JsonValue::Null));
        }
        assert!(parse(&format!(r#""id":{}"#, nest(r#"{"toString":null}"#))).is_none());
        let receipt = parse(&format!(
            r#""entryKind":"adjustment","source":{},"operation":{}"#,
            nest(r#""activation""#),
            nest(r#""refund""#)
        ))
        .unwrap();
        assert_eq!(
            string_field(&receipt, "adjustmentType").as_str(),
            Some("refund")
        );
    }
    let ignored = format!("{}null{}", "[".repeat(4096), "]".repeat(4096));
    assert!(parse(&format!(r#""unknown":{ignored}"#)).is_some());
    let malformed = format!("{}[1,]{}", "[".repeat(4096), "]".repeat(4096));
    assert!(parse(&format!(r#""unknown":{malformed}"#)).is_none());
}

fn assert_owned_receipt_wire(receipt: &ParsedAiUsageReceipt) {
    let ordered = receipt.ordered_fields();
    let owned = receipt.as_value();
    let JsonValue::Object(fields) = &owned else {
        panic!("receipt object");
    };
    assert_eq!(ordered.len(), 18);
    assert_eq!(fields.len(), ordered.len());
    assert_eq!(receipt.json(), owned.to_json_string());
    for ((key, expected), (owned_key, value)) in ordered.iter().zip(fields) {
        assert_eq!(owned_key.as_str(), Some(*key));
        assert_eq!(value, expected);
        let named = receipt.get(key).unwrap();
        assert_eq!(&named, expected);
        if let JsonValue::Number(expected) = expected {
            for value in [value, &named] {
                let JsonValue::Number(value) = value else {
                    panic!("numeric field");
                };
                assert_eq!(value.to_bits(), expected.to_bits(), "{key}");
            }
        }
    }
    assert!(receipt.get("missing").is_none());
    assert!(receipt.get("__proto__").is_none());
    let utf8 = receipt.try_utf8_fields();
    assert_eq!(
        utf8.is_some(),
        ordered.iter().all(|(_, value)| match value {
            JsonValue::String(value) => value.as_str().is_some(),
            _ => true,
        })
    );
    if let Some(utf8) = utf8 {
        assert_eq!(utf8.len(), ordered.len());
        for ((key, value), (expected_key, expected)) in utf8.iter().zip(&ordered) {
            assert_eq!(key, expected_key);
            if let JsonValue::Number(expected) = expected {
                assert_eq!(
                    value.as_f64().unwrap().to_bits(),
                    expected.to_bits(),
                    "{key}"
                );
            } else {
                assert_eq!(&parse_json(&value.to_string()).unwrap(), expected);
            }
        }
    }
}

#[test]
fn borrowed_receipt_wire_and_owned_apis_share_all_eighteen_fields() {
    let receipt = parse(r#""channelID":"channel😀","customerId":"customer","id":"entry","requestId":" request ","occurredAt":"2026-10-29T01:02:03.004Z","entryKind":"adjustment","category":"credit_adjustment","operation":" manual ","source":" dashboard ","adjustmentType":"other","provider":" provider ","model":" model ","quantity":-0,"unit":"tokens","credits":-0,"resourceType":"llm_generation","resourceId":" resource ","itemized":true"#).unwrap();
    assert_owned_receipt_wire(&receipt);
    assert_eq!(
        receipt.json(),
        r#"{"channelID":"channel😀","customerId":"customer","id":"entry","requestId":"request","occurredAt":"2026-10-29T01:02:03.004Z","entryKind":"adjustment","category":"credit_adjustment","operation":"manual","source":"dashboard","adjustmentType":"other","provider":"provider","model":"model","quantity":0,"unit":"tokens","credits":0,"resourceType":"llm_generation","resourceId":"resource","itemized":true}"#
    );
    assert_eq!(receipt.credits().to_bits(), (-0.0_f64).to_bits());
    assert_eq!(receipt.quantity().unwrap().to_bits(), (-0.0_f64).to_bits());
    let owned = receipt.as_value();
    let fields = receipt.ordered_fields();
    let named = receipt.get("channelID").unwrap();
    let utf8 = receipt.try_utf8_fields().unwrap();
    drop(receipt);
    assert_eq!(owned.get("channelID"), Some(&named));
    assert_eq!(fields[0].1, named);
    assert_eq!(utf8[0].1.as_str(), Some("channel😀"));

    let receipt = parse(r#""unused":null"#).unwrap();
    assert_owned_receipt_wire(&receipt);
    assert_eq!(
        receipt.json(),
        r#"{"channelID":"c","customerId":"u","id":"e","requestId":null,"occurredAt":"1970-01-01T00:00:00.000Z","entryKind":"usage","category":"uncategorized","operation":"usage","source":null,"adjustmentType":null,"provider":"unknown","model":null,"quantity":null,"unit":null,"credits":1,"resourceType":null,"resourceId":null,"itemized":false}"#
    );
}

#[test]
fn borrowed_receipt_wire_keeps_lone_units_and_each_utf16_slice_boundary() {
    let receipt = parse(r#""channelID":"c\ud800","customerId":"u\udc00","id":"e\udc00\ud800","requestId":"\ud800","operation":"\udc00","source":"😀\ud800","provider":"\ud800😀","model":"\udc00\ud800","resourceId":"\ud800\u0000\udc00","credits":-0,"quantity":1e9999"#).unwrap();
    assert_owned_receipt_wire(&receipt);
    assert!(receipt.try_utf8_fields().is_none());
    assert!(receipt.json().contains(r#""id":"e\udc00\ud800""#));
    assert!(
        receipt
            .json()
            .contains(r#""resourceId":"\ud800\u0000\udc00""#)
    );
    assert_eq!(receipt.get("quantity"), Some(JsonValue::Null));
    for prefix in [126, 127, 128, 129] {
        let payload = format!("{}😀tail", "a".repeat(prefix));
        let quoted = serde_json::to_string(&format!(" {payload} ")).unwrap();
        let receipt = parse(&format!(r#""requestId":{quoted},"operation":{quoted},"source":{quoted},"provider":{quoted},"model":{quoted},"resourceId":{quoted},"credits":-0,"quantity":-0"#)).unwrap();
        assert_owned_receipt_wire(&receipt);
        let expected: Vec<_> = payload.encode_utf16().take(128).collect();
        for field in [
            "requestId",
            "operation",
            "source",
            "provider",
            "model",
            "resourceId",
        ] {
            assert_eq!(
                string_field(&receipt, field).units(),
                expected,
                "{prefix} {field}"
            );
        }
        assert_eq!(receipt.try_utf8_fields().is_none(), prefix == 127);
    }
}

#[test]
fn borrowed_json_fields_reuse_number_string_and_nested_value_policies() {
    let units = JsString::from_units(vec![0xd800, 0, 0xd83d, 0xde00, 0xdc00]);
    let nested =
        parse_json(r#"{"10":"ten","2":[-0,1e9999,"\ud800"],"\ud800":"lone-key"}"#).unwrap();
    let fields = [
        ("null", JsonValueRef::Null),
        ("false", JsonValueRef::Bool(false)),
        ("true", JsonValueRef::Bool(true)),
        ("zero", JsonValueRef::Number(-0.0)),
        ("finite", JsonValueRef::Number(1.5)),
        ("nan", JsonValueRef::Number(f64::NAN)),
        ("infinity", JsonValueRef::Number(f64::INFINITY)),
        ("negativeInfinity", JsonValueRef::Number(f64::NEG_INFINITY)),
        ("utf8", JsonValueRef::Utf8("é😀\n\"\\")),
        ("utf16", JsonValueRef::String(&units)),
        ("nested", JsonValueRef::Value(&nested)),
        ("\"\0\\", JsonValueRef::Bool(true)),
    ];
    let expected = r#"{"null":null,"false":false,"true":true,"zero":0,"finite":1.5,"nan":null,"infinity":null,"negativeInfinity":null,"utf8":"é😀\n\"\\","utf16":"\ud800\u0000😀\udc00","nested":{"2":[0,null,"\ud800"],"10":"ten","\ud800":"lone-key"},"\"\u0000\\":true}"#;
    assert_eq!(fields_to_json_string(&fields), expected);
    let mut appended = String::from("prefix");
    write_json_fields(&fields, &mut appended);
    assert_eq!(appended, format!("prefix{expected}"));
    assert_eq!(fields_to_json_string(&[]), "{}");
    assert_eq!(
        JsonValueRef::String(&units).into_owned(),
        JsonValue::String(units.clone())
    );
    assert_eq!(JsonValueRef::Value(&nested).into_owned(), nested);
    assert_eq!(
        JsonValueRef::Utf8("é😀").into_owned(),
        JsonValue::String("é😀".into())
    );
    for number in [
        -0.0,
        0.0,
        f64::from_bits(0x7ff8_0000_0000_0042),
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        let JsonValue::Number(owned) = JsonValueRef::Number(number).into_owned() else {
            panic!("number projection");
        };
        assert_eq!(owned.to_bits(), number.to_bits());
        let mut borrowed_wire = String::new();
        JsonValueRef::Number(number).write_json_string(&mut borrowed_wire);
        assert_eq!(borrowed_wire, JsonValue::Number(number).to_json_string());
    }
}

#[test]
fn borrowed_static_field_names_keep_stable_ecmascript_index_order() {
    let names = [
        "z",
        "4294967294",
        "10",
        "2",
        "0",
        "01",
        "2",
        "4294967295",
        "-0",
        "1e0",
        "00",
        "18446744073709551616",
    ];
    let fields: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(index, &key)| (key, JsonValueRef::Number(index as f64)))
        .collect();
    let owned = JsonValue::Object(
        names
            .iter()
            .enumerate()
            .map(|(index, &key)| (JsString::from_static(key), JsonValue::Number(index as f64)))
            .collect(),
    );
    let expected = r#"{"0":4,"2":3,"2":6,"10":2,"4294967294":1,"z":0,"01":5,"4294967295":7,"-0":8,"1e0":9,"00":10,"18446744073709551616":11}"#;
    assert_eq!(fields_to_json_string(&fields), expected);
    assert_eq!(fields_to_json_string(&fields), owned.to_json_string());
}

fn field<'a>(v: &'a JsonValue, k: &str) -> &'a JsonValue {
    v.get(k).unwrap_or_else(|| panic!("missing fixture {k}"))
}
fn text(v: &JsonValue) -> &str {
    match v {
        JsonValue::String(s) => s.as_str().expect("ASCII/Unicode fixture field"),
        _ => panic!("fixture string"),
    }
}
fn array(v: &JsonValue) -> &[JsonValue] {
    match v {
        JsonValue::Array(v) => v,
        _ => panic!("fixture array"),
    }
}
fn object(v: &JsonValue) -> &[(JsString, JsonValue)] {
    match v {
        JsonValue::Object(v) => v,
        _ => panic!("fixture object"),
    }
}
fn number(v: &JsonValue) -> f64 {
    match v {
        JsonValue::Number(v) => *v,
        _ => panic!("fixture number"),
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn valid_sha(value: &JsonValue) {
    assert!(
        text(value).len() == 64
            && text(value)
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
}
fn hash_file(root: &Path, relative: &str, expected: &JsonValue) {
    valid_sha(expected);
    assert_eq!(
        hash(
            &std::fs::read(ai_usage_source::path(root, relative))
                .unwrap_or_else(|e| panic!("provenance {relative}: {e}"))
        ),
        text(expected),
        "provenance {relative}"
    );
}
fn ordinary(value: &JsonValue) -> serde_json::Value {
    serde_json::from_str(&value.to_json_string()).expect("ordinary expected value")
}

fn describe_bson(value: &Bson) -> serde_json::Value {
    match value {
        Bson::Null => serde_json::json!({"type":"null"}),
        Bson::Boolean(v) => serde_json::json!({"type":"bool","value":v}),
        Bson::String(v) => serde_json::json!({"type":"string","value":v,"utf8":hex(v.as_bytes())}),
        Bson::DateTime(v) => {
            serde_json::json!({"type":"date","millis":v.timestamp_millis().to_string()})
        }
        Bson::Int32(v) => serde_json::json!({"type":"int32","value":v}),
        Bson::Int64(v) => serde_json::json!({"type":"int64","value":v.to_string()}),
        Bson::Double(v) => {
            serde_json::json!({"type":"double","bits":format!("{:016x}",v.to_bits())})
        }
        _ => panic!("unexpected receipt BSON {value:?}"),
    }
}

fn verify_provenance(fixture: &JsonValue) {
    let metadata = field(fixture, "metadata");
    assert_eq!(number(field(metadata, "format")), 2.0);
    for (k, v) in [
        ("node", "v24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(text(field(metadata, k)), v);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let hashes = object(field(metadata, "hashes"));
    assert_eq!(
        hashes.len(),
        33,
        "complete source/helper/package/lock/reader hashes required"
    );
    for (file, digest) in hashes {
        hash_file(root, file.as_str().expect("source path"), digest);
    }
    for file in [
        "src/utils/ai_usage_ledger.ts",
        "src/utils/ai_usage_classification.ts",
        "src/utils/ai_usage_event.ts",
        "src/utils/ai_usage_receipts.ts",
        "src/schemas/ai_usage_receipt.schema.ts",
        "src/utils/ai_usage_receipt_parser.rs",
        "src/utils/tts/settings.rs",
        "src/utils/tts/usage.rs",
        "src/utils/js_date/mod.rs",
        "src/utils/js_date/parser.rs",
        "src/utils/js_date/local_time.rs",
        "src/utils/ai_usage_receipts/values.rs",
        "src/utils/ai_usage_receipts/queue.rs",
        "src/utils/ai_usage_receipts.rs",
        "src/utils/ai_usage.rs",
        "src/utils/ai_usage_producer.rs",
        "src/utils/ai_credit_projection.rs",
        "src/utils/credit_policy.rs",
        "src/utils/js_string.rs",
        "src/utils/lossless_json.rs",
        "src/utils/js_compat.rs",
        "src/utils/json_number.rs",
        "src/utils/bson_compat.rs",
        "src/utils/lossless_json_view.rs",
        "src/utils/lossless_json_document.rs",
        "tests/lossless_json_view.rs",
        "src/utils/mod.rs",
        "Cargo.toml",
        "Cargo.lock",
        "package.json",
        "package-lock.json",
        "tests/fixtures/ai_usage_receipt_parser_reference.cjs",
        "tests/ai_usage_receipt_parser.rs",
    ] {
        valid_sha(field(field(metadata, "hashes"), file));
    }
    let node_root = PathBuf::from(
        std::env::var("DIMA_AI_RECEIPT_NODE_ROOT")
            .expect("read-only pinned Node snapshot root required"),
    );
    let dependencies = object(field(metadata, "dependencies"));
    assert!(
        dependencies.len() > 20,
        "actual installed dependency implementation hashes required"
    );
    for (file, digest) in dependencies {
        hash_file(&node_root, text_path(file), digest);
    }
    for (name, version) in [
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
        ("typescript", "5.9.3"),
    ] {
        let p = field(field(metadata, "packages"), name);
        assert_eq!(text(field(p, "version")), version);
    }
    let lock: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("package-lock.json")).unwrap())
            .unwrap();
    for (_, p) in object(field(metadata, "packages")) {
        for (path_key, hash_key) in [
            ("packagePath", "packageSha256"),
            ("entryPath", "entrySha256"),
        ] {
            hash_file(&node_root, text(field(p, path_key)), field(p, hash_key));
        }
        let package_path = text(field(p, "packagePath"));
        let folder = package_path
            .strip_suffix("/package.json")
            .expect("package path");
        assert_eq!(
            lock["packages"][folder]["version"].as_str(),
            Some(text(field(p, "version")))
        );
    }
    let node_binary = std::env::var("DIMA_AI_RECEIPT_NODE_BINARY")
        .expect("read-only exact oracle Node executable required");
    assert_eq!(
        hash(&std::fs::read(node_binary).unwrap()),
        text(field(metadata, "nodeSha256"))
    );
    let ast = field(metadata, "ast");
    let declarations = array(field(ast, "declarations"));
    assert!(declarations.len() >= 30);
    for declaration in declarations {
        let file = text(field(declaration, "file"));
        let source = std::fs::read_to_string(ai_usage_source::path(root, file)).unwrap();
        let snippet = text(field(declaration, "text"));
        assert!(
            !snippet.is_empty() && source.contains(snippet),
            "actual declaration {file}"
        );
        assert_eq!(hash(snippet.as_bytes()), text(field(declaration, "sha256")));
    }
    let selected = [
        "RETENTION_DAYS",
        "VALID_CATEGORIES",
        "validTier",
        "expiryFor",
        "safeCategory",
        "nullableString",
        "finiteNumber",
        "getAiUsageRetentionDays",
        "buildQueuedAiUsageReceipt",
        "parseQueuedAiUsageReceipt",
        "receiptDocument",
        "QueuedAiUsageReceipt",
    ];
    let mut extracted: Vec<String> = array(field(ast, "imports"))
        .iter()
        .map(|i| text(i).to_owned())
        .collect();
    for name in selected {
        let d = declarations
            .iter()
            .find(|d| {
                text(field(d, "file")) == "src/utils/ai_usage_ledger.ts"
                    && text(field(d, "name")) == name
            })
            .expect("required AST ledger declaration");
        let exported = matches!(field(d, "exported"), JsonValue::Bool(true));
        assert_eq!(
            exported,
            [
                "getAiUsageRetentionDays",
                "buildQueuedAiUsageReceipt",
                "parseQueuedAiUsageReceipt",
                "QueuedAiUsageReceipt"
            ]
            .contains(&name)
        );
        extracted.push(text(field(d, "text")).to_owned());
    }
    extracted.push("export { receiptDocument };".into());
    assert_eq!(
        hash(extracted.join("\n").as_bytes()),
        text(field(metadata, "extractedSha256"))
    );
    assert_eq!(
        array(field(metadata, "zones"))
            .iter()
            .map(text)
            .collect::<Vec<_>>(),
        [
            "UTC",
            "America/New_York",
            "Europe/Berlin",
            "Australia/Lord_Howe",
            "Pacific/Apia"
        ]
    );
}
fn text_path(s: &JsString) -> &str {
    let s = s.as_str().expect("dependency path");
    assert!(
        s.starts_with("node_modules/") && !s.split('/').any(|p| p == ".."),
        "dependency confined to snapshot"
    );
    s
}

fn expected_units(value: &JsonValue) -> Vec<u16> {
    array(value)
        .iter()
        .map(|unit| number(unit) as u16)
        .collect()
}

fn replay_view_observation(value: Option<JsonView<'_>>, expected: &JsonValue) {
    let scalar = value.and_then(JsonView::scalar);
    let kind = match (&value, &scalar) {
        (None, _) => "missing",
        (_, Some(JsonValue::Null)) => "null",
        (_, Some(JsonValue::Bool(_))) => "boolean",
        (_, Some(JsonValue::Number(_))) => "number",
        (_, Some(JsonValue::String(_))) => "string",
        (Some(value), None) if value.array().is_some() => "array",
        (Some(_), None) => "object",
        _ => unreachable!("scalar() never materializes containers"),
    };
    assert_eq!(kind, text(field(expected, "kind")));
    assert_eq!(
        value.is_some_and(JsonView::truthy),
        matches!(field(expected, "truthy"), JsonValue::Bool(true))
    );
    let string = field(expected, "string");
    match value.map_or_else(|| Ok(JsString::from("undefined")), JsonView::js_string) {
        Ok(actual) => {
            assert_eq!(field(string, "error"), &JsonValue::Null);
            assert_eq!(actual.units(), expected_units(field(string, "value")));
        }
        Err(error) => {
            assert_eq!(field(string, "value"), &JsonValue::Null);
            assert_eq!(error.name(), text(field(field(string, "error"), "name")));
            assert_eq!(
                error.to_string(),
                text(field(field(string, "error"), "message"))
            );
        }
    }
    let number_result = field(expected, "number");
    match view_number(value) {
        Ok(actual) => {
            assert_eq!(field(number_result, "error"), &JsonValue::Null);
            assert_eq!(
                format!("{:016x}", actual.to_bits()),
                text(field(number_result, "value"))
            );
        }
        Err(error) => {
            assert_eq!(field(number_result, "value"), &JsonValue::Null);
            assert_eq!(
                error.name(),
                text(field(field(number_result, "error"), "name"))
            );
            assert_eq!(
                error.to_string(),
                text(field(field(number_result, "error"), "message"))
            );
        }
    }
    let expected_scalar = field(expected, "scalar");
    match scalar {
        Some(JsonValue::String(value)) => assert_eq!(
            value.units(),
            expected_units(field(expected_scalar, "units"))
        ),
        Some(JsonValue::Number(value)) => assert_eq!(
            format!("{:016x}", value.to_bits()),
            text(field(expected_scalar, "bits"))
        ),
        Some(JsonValue::Bool(value)) => assert_eq!(
            value,
            matches!(field(expected_scalar, "value"), JsonValue::Bool(true))
        ),
        _ => assert_eq!(expected_scalar, &JsonValue::Null),
    }
}

fn replay_shared_views(selected: &JsonValue, metadata: &JsonValue) {
    let views = array(field(selected, "views"));
    assert!(
        views.len() >= 90,
        "nonempty complete shared-view oracle required"
    );
    assert_eq!(
        views.len(),
        number(field(metadata, "viewCaseCount")) as usize
    );
    let mut ids = std::collections::HashSet::new();
    for record in views {
        let id = text(field(record, "id"));
        assert!(ids.insert(id));
        let document = JsonDocument::parse(text(field(record, "raw")));
        if matches!(field(record, "valid"), JsonValue::Bool(false)) {
            assert_eq!(text(field(record, "parseError")), "SyntaxError");
            assert!(document.is_err(), "source-invalid shared view {id}");
            continue;
        }
        assert_eq!(field(record, "valid"), &JsonValue::Bool(true));
        let document =
            document.unwrap_or_else(|error| panic!("source-valid shared view {id}: {error}"));
        replay_view_observation(Some(document.root()), field(record, "root"));
        let keys = array(field(record, "keys"));
        let properties = array(field(record, "properties"));
        assert_eq!(keys.len(), properties.len());
        for (key, property) in keys.iter().zip(properties) {
            assert_eq!(key, field(property, "key"));
            let JsonValue::String(key) = key else {
                panic!("UTF16 oracle key")
            };
            replay_view_observation(document.root().get_key(key), field(property, "observation"));
        }
    }
    for id in [
        "duplicate-utf16-keys",
        "numeric-fields",
        "ignored:4096",
        "ignored-object:4096",
        "deep-own-toString:4096",
    ] {
        assert!(ids.contains(id), "required shared-view case {id}");
    }
    let boundary = field(selected, "resourceBoundary");
    assert_eq!(number(field(boundary, "depth")), 16384.0);
    let raw = text(field(boundary, "raw"));
    assert_eq!(
        raw,
        format!("{}\"x\"{}", "[".repeat(16384), "]".repeat(16384))
    );
    assert!(
        JsonDocument::parse(raw).is_ok(),
        "source JSON.parse accepted boundary input"
    );
    for key in ["string", "number"] {
        assert_eq!(field(field(boundary, key), "value"), &JsonValue::Null);
        assert_eq!(
            text(field(field(field(boundary, key), "error"), "name")),
            "RangeError",
            "pinned V8 resource observation changed: review boundary"
        );
        assert!(!text(field(field(field(boundary, key), "error"), "message")).is_empty());
    }
    assert_eq!(field(boundary, "receiptAccepted"), &JsonValue::Bool(false));
    assert_eq!(
        text(field(boundary, "policy")),
        "V8 resource observation only; no native coercion parity assertion at this depth"
    );
    // Deliberately do not compare native String/Number at this engine-resource
    // boundary. Every ordinary view/receipt case above/below is still replayed.
}

fn replay_document(receipt: &ParsedAiUsageReceipt, expected: &JsonValue) {
    let tier = RetentionTier::from_value(field(expected, "tier"));
    let result = receipt.to_bson_document(tier);
    let raw_fields = array(field(expected, "rawFields"));
    assert_eq!(raw_fields.len(), 20, "receiptDocument projection");
    // Independently replay every raw normalized field, before the UTF8 boundary.
    for raw in raw_fields {
        let key = text(field(raw, "key"));
        let actual = if key == "retentionTier" {
            JsonValue::String(tier.as_str().into())
        } else if key == "occurredAt" || key == "expiresAt" {
            let ms = if key == "occurredAt" {
                receipt.occurred_at().timestamp_millis()
            } else {
                dima_rust::utils::credit_policy::JsDate::from_millis(
                    receipt.occurred_at().timestamp_millis().unwrap() as f64
                        + (tier.days() * 86_400_000) as f64,
                )
                .timestamp_millis()
            };
            let expected_ms = field(raw, "millis");
            assert_eq!(
                ms.map(|v| v.to_string()),
                if matches!(expected_ms, JsonValue::Null) {
                    None
                } else {
                    Some(text(expected_ms).to_owned())
                }
            );
            continue;
        } else {
            receipt
                .get(if key == "entryId" { "id" } else { key })
                .expect("document field")
        };
        match actual {
            JsonValue::String(s) => {
                assert_eq!(text(field(raw, "type")), "string");
                assert_eq!(
                    s.units(),
                    array(field(raw, "units"))
                        .iter()
                        .map(|u| number(u) as u16)
                        .collect::<Vec<_>>()
                );
            }
            JsonValue::Number(n) => {
                assert_eq!(text(field(raw, "type")), "number");
                assert_eq!(format!("{:016x}", n.to_bits()), text(field(raw, "bits")));
            }
            JsonValue::Bool(b) => {
                assert_eq!(text(field(raw, "type")), "boolean");
                assert_eq!(matches!(field(raw, "value"), JsonValue::Bool(true)), b);
            }
            JsonValue::Null => assert_eq!(text(field(raw, "type")), "null"),
            _ => panic!("unexpected raw document field"),
        }
    }
    if !matches!(field(expected, "error"), JsonValue::Null) {
        assert!(result.is_err());
        return;
    }
    let document: Document = result.expect("source schema cast succeeded");
    let bytes = mongodb::bson::serialize_to_vec(&document).unwrap();
    assert_eq!(
        hex(&bytes),
        text(field(expected, "hex")),
        "exact Node BSON bytes/order/types"
    );
    let fields = array(field(expected, "fields"));
    assert_eq!(fields.len(), document.len());
    for ((key, value), expected_field) in document.iter().zip(fields) {
        assert_eq!(key, text(field(expected_field, "key")));
        let mut expected_field = ordinary(expected_field);
        expected_field.as_object_mut().unwrap().remove("key");
        assert_eq!(describe_bson(value), expected_field, "BSON field {key}");
    }
}

#[cfg(feature = "ai-usage-producer")]
fn replay_producer(record: &JsonValue) {
    use dima_rust::utils::{
        ai_usage::create_ai_usage_context, ai_usage_producer::build_queued_ai_usage_receipt_at,
        credit_policy::JsDate,
    };
    let recipe = field(record, "producer");
    if matches!(recipe, JsonValue::Null) {
        return;
    }
    let credits =
        f64::from_bits(u64::from_str_radix(text(field(recipe, "creditsBits")), 16).unwrap());
    let (context, channel, customer) = if text(field(recipe, "kind")) == "event" {
        let input = serde_json::from_str(&field(recipe, "input").to_json_string()).unwrap();
        let native = create_ai_usage_context(text(field(recipe, "reason")), input);
        let context = parse_json(&serde_json::to_string(&native).unwrap()).unwrap();
        (
            context,
            JsString::from("channel"),
            JsString::from("customer"),
        )
    } else {
        let context = {
            let mut c = parse_json(text(field(recipe, "contextWire"))).unwrap();
            let JsonValue::Object(fields) = &mut c else {
                panic!("context")
            };
            let (_, q) = fields
                .iter_mut()
                .find(|(k, _)| k.as_str() == Some("quantity"))
                .unwrap();
            *q = JsonValue::Number(f64::from_bits(
                u64::from_str_radix(text(field(recipe, "quantityBits")), 16).unwrap(),
            ));
            c
        };
        let channel = match field(recipe, "channelID") {
            JsonValue::String(s) => s.clone(),
            _ => panic!("channel"),
        };
        let customer = match field(recipe, "customerId") {
            JsonValue::String(s) => s.clone(),
            _ => panic!("customer"),
        };
        (context, channel, customer)
    };
    let receipt = build_queued_ai_usage_receipt_at(
        channel,
        customer,
        Some(JsDate::from_millis(0.0)),
        JsDate::invalid(),
        &context,
        credits,
    )
    .unwrap();
    assert_eq!(
        receipt.json(),
        text(field(record, "raw")),
        "actual producer generated wire"
    );
}

/// Run this entire replay in FIVE fresh test processes with TZ set before
/// startup. Never mutate process-global TZ from a test or concurrent thread.
#[test]
#[ignore = "requires exact pinned source+Mongoose+BSON oracle and read-only Node snapshot"]
fn replay_actual_source_parser_and_bson() {
    let zone = std::env::var("TZ").expect("set TZ before process startup");
    let dir = std::env::var("DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR")
        .expect("required fixture directory");
    let bytes =
        std::fs::read_to_string(Path::new(&dir).join("ai_usage_receipt_parser_reference.json"))
            .expect("required nonempty source fixture");
    let fixture = parse_json(&bytes).expect("lossless source fixture");
    verify_provenance(&fixture);
    let zones = array(field(&fixture, "results"));
    assert_eq!(zones.len(), 5);
    let selected = zones
        .iter()
        .find(|z| text(field(z, "zone")) == zone)
        .expect("supported source TZ");
    replay_shared_views(selected, field(&fixture, "metadata"));
    let records = array(field(selected, "records"));
    assert!(records.len() >= 250, "empty/partial fixture forbidden");
    assert_eq!(
        records.len(),
        number(field(field(&fixture, "metadata"), "caseCount")) as usize
    );
    let mut ids = std::collections::HashSet::new();
    let mut producer_count = 0;
    for record in records {
        let id = text(field(record, "id"));
        assert!(ids.insert(id));
        let raw = text(field(record, "raw"));
        let receipt = parse_queued_ai_usage_receipt(raw);
        let output = field(record, "output");
        if !matches!(field(record, "producer"), JsonValue::Null) {
            producer_count += 1;
        }
        #[cfg(feature = "ai-usage-producer")]
        replay_producer(record);
        if matches!(output, JsonValue::Null) {
            assert!(receipt.is_none(), "{zone} {id}");
            continue;
        }
        let receipt = receipt.unwrap_or_else(|| panic!("source accepted {zone} {id}: {raw}"));
        assert_eq!(
            receipt.json(),
            text(field(output, "wire")),
            "wire {zone} {id}"
        );
        assert_eq!(
            format!("{:016x}", receipt.credits().to_bits()),
            text(field(output, "creditsBits")),
            "credits {zone} {id}"
        );
        assert_eq!(
            receipt.quantity().map(|n| format!("{:016x}", n.to_bits())),
            if matches!(field(output, "quantityBits"), JsonValue::Null) {
                None
            } else {
                Some(text(field(output, "quantityBits")).to_owned())
            },
            "quantity {zone} {id}"
        );
        assert_eq!(
            receipt
                .ordered_fields()
                .iter()
                .map(|(k, _)| *k)
                .collect::<Vec<_>>(),
            array(field(output, "keys"))
                .iter()
                .map(text)
                .collect::<Vec<_>>()
        );
        for (key, units) in object(field(output, "stringUnits")) {
            assert_eq!(
                string_field(&receipt, key.as_str().unwrap()).units(),
                array(units)
                    .iter()
                    .map(|u| number(u) as u16)
                    .collect::<Vec<_>>(),
                "UTF16 {id}"
            );
        }
        let documents = array(field(output, "documents"));
        assert_eq!(documents.len(), 3);
        for document in documents {
            replay_document(&receipt, document);
        }
    }
    for id in [
        "deep-unknown:129",
        "deep-unknown:256",
        "deep-coercion:129",
        "deep-coercion:256",
        "deep-unknown:4096",
        "deep-unknown-object:4096",
    ] {
        assert!(ids.contains(id), "mandatory deep receipt guard {id}");
        let record = records
            .iter()
            .find(|record| text(field(record, "id")) == id)
            .unwrap();
        assert!(
            !matches!(field(record, "output"), JsonValue::Null),
            "source must accept {id}"
        );
    }
    assert!(producer_count >= 60, "producer coverage required");
}
