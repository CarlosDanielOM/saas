#![cfg(feature = "tts-utilities")]
//! Binary64 wire parity against an explicit pinned Node/TypeScript oracle.
//! The ignored replay fails for absent, empty or stale fixtures; it never skips.

use dima_rust::utils::{json_number::number_string, lossless_json::JsonValue};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[test]
fn ordinary_fixed_point_and_notation_boundaries_keep_their_wire() {
    for (number, expected) in [
        (0.0, "0"),
        (-0.0, "0"),
        (0.5, "0.5"),
        (1.25, "1.25"),
        (3.25, "3.25"),
        (17.0, "17"),
        (1200.0, "1200"),
        (0.000001, "0.000001"),
        (0.0000001, "1e-7"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (9_007_199_254_740_991.0, "9007199254740991"),
        (0.1 + 0.2, "0.30000000000000004"),
    ] {
        assert_eq!(number_string(number), expected, "{number:?}");
        assert_eq!(JsonValue::Number(number).to_json_string(), expected);
        if number != 0.0 {
            let negative = format!("-{expected}");
            assert_eq!(number_string(-number), negative);
            assert_eq!(JsonValue::Number(-number).to_json_string(), negative);
        }
    }
}

#[test]
fn nonfinite_string_and_json_policies_stay_distinct() {
    for (number, expected) in [
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "-Infinity"),
    ] {
        assert_eq!(number_string(number), expected);
        assert_eq!(JsonValue::Number(number).to_json_string(), "null");
        assert_eq!(JsonValue::Number(number).pretty(), "null");
    }
}

fn text(value: &Value) -> &str {
    value.as_str().expect("required fixture string")
}

fn digest(value: &Value) -> &str {
    let value = text(value);
    assert_eq!(value.len(), 64, "required SHA-256 provenance");
    assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    value
}

fn fixture() -> Value {
    let directory = std::env::var_os("DIMA_JSON_NUMBER_REFERENCE_DIR")
        .expect("set DIMA_JSON_NUMBER_REFERENCE_DIR to the explicit task-owned oracle directory");
    let path = std::path::Path::new(&directory).join("json-number-reference.json");
    let bytes = std::fs::read(path).expect("required binary64 oracle fixture");
    assert!(!bytes.is_empty(), "empty binary64 oracle fixture");
    let fixture: Value = serde_json::from_slice(&bytes).expect("valid binary64 oracle fixture");
    let metadata = &fixture["metadata"];
    assert_eq!(metadata["schema"], 1);
    assert_eq!(
        metadata["oracle"],
        "actual String(binary64) and JSON.stringify(binary64)"
    );
    assert_eq!(metadata["node"]["version"], "v24.22.1");
    assert_eq!(metadata["node"]["v8"], "13.6.233.17-node.58");
    assert!(!text(&metadata["node"]["executable"]).is_empty());
    digest(&metadata["node"]["sha256"]);
    assert_eq!(metadata["typescript"]["version"], "5.9.3");
    for field in ["packagePath", "compilerPath"] {
        assert!(!text(&metadata["typescript"][field]).is_empty());
    }
    let package: Value = serde_json::from_str(text(&metadata["typescript"]["packageSource"]))
        .expect("complete TypeScript package provenance");
    assert_eq!(package["version"], "5.9.3");
    digest(&metadata["typescript"]["packageSha256"]);
    digest(&metadata["typescript"]["compilerSha256"]);
    for field in ["source", "emitted"] {
        assert!(!text(&metadata["reference"][field]).is_empty());
    }
    digest(&metadata["reference"]["sourceSha256"]);
    digest(&metadata["reference"]["emittedSha256"]);
    assert_eq!(metadata["reference"]["diagnostics"], serde_json::json!([]));
    assert_eq!(metadata["generator"]["seed"], "9e3779b97f4a7c15");
    assert_eq!(metadata["generator"]["algorithm"], "xorshift64-13-7-17");
    assert_eq!(metadata["generator"]["randomCount"], 8192);
    assert_eq!(
        metadata["generator"]["decimalExponents"],
        serde_json::json!([-323, 308])
    );
    assert_eq!(
        metadata["generator"]["binaryExponents"],
        serde_json::json!([-1074, 1023])
    );

    // Exact compile-time source bytes avoid adding a hashing dependency to the
    // existing tts-utilities profile. Parent --check recomputes every SHA-256,
    // Node/TypeScript identity and engine wire before and after native replay.
    let sources = fixture["sources"]
        .as_object()
        .expect("full source provenance");
    let hashes = metadata["hashes"].as_object().expect("all source hashes");
    let native_hashes = metadata["nativeHashes"]
        .as_object()
        .expect("native source hashes");
    macro_rules! source {
        ($path:literal) => {
            assert_eq!(
                text(&sources[$path]),
                include_str!(concat!("../", $path)),
                "stale source {}",
                $path
            );
            digest(&hashes[$path]);
            if $path.ends_with(".rs") {
                assert_eq!(native_hashes[$path], hashes[$path], "native hash {}", $path);
            }
        };
    }
    source!("Cargo.toml");
    source!("Cargo.lock");
    source!("rust-toolchain.toml");
    source!("package.json");
    source!("package-lock.json");
    source!("src/lib.rs");
    source!("src/utils/mod.rs");
    source!("src/utils/js_compat.rs");
    source!("src/utils/js_string.rs");
    source!("src/utils/json_number.rs");
    source!("src/utils/lossless_json.rs");
    source!("tests/json_number_parity.rs");
    source!("tests/fixtures/json_number_reference.cjs");
    assert_eq!(sources.len(), 13);
    assert_eq!(hashes.len(), sources.len());
    assert_eq!(native_hashes.len(), 7);
    fixture
}

#[test]
#[ignore = "requires explicit pinned engine oracle; parent isolated execution only"]
fn replay_every_binary64_engine_wire() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("required engine cases");
    assert!(
        cases.len() > 30_000,
        "broad binary64 corpus must not be empty or truncated"
    );
    assert_eq!(
        fixture["metadata"]["count"].as_u64(),
        Some(cases.len() as u64)
    );
    let mut unique = HashSet::new();
    let mut groups = BTreeMap::<&str, usize>::new();
    let mut mismatches = 0;
    let mut ordinary_mismatches = 0;
    let mut fallback_mismatches = 0;
    let mut ordinary_details = Vec::new();
    let mut fallback_details = Vec::new();
    for case in cases {
        let input = text(&case["input"]);
        assert_eq!(input.len(), 16, "raw binary64 hex required");
        assert!(
            input
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert!(unique.insert(input), "duplicate binary64 input {input}");
        let number = f64::from_bits(u64::from_str_radix(input, 16).unwrap());
        let labels = case["groups"].as_array().expect("input coverage labels");
        assert!(!labels.is_empty());
        let mut seen = HashSet::new();
        for label in labels {
            let label = text(label);
            assert!(seen.insert(label), "duplicate coverage label for {input}");
            *groups.entry(label).or_default() += 1;
            if label == "seeded-ordinary" {
                assert!((1e-6..1e21).contains(&number.abs()));
            }
        }
        let expected_string = text(&case["string"]);
        let expected_json = text(&case["json"]);
        assert!(!expected_string.is_empty() && !expected_json.is_empty());
        let actual_string = number_string(number);
        let value = JsonValue::Number(number);
        let actual_json = value.to_json_string();
        let mut appended = String::from("prefix:");
        value.write_json_string(&mut appended);
        assert_eq!(appended.strip_prefix("prefix:"), Some(actual_json.as_str()));
        assert_eq!(
            value.pretty(),
            actual_json,
            "scalar pretty wire for {input}"
        );
        if actual_string != expected_string || actual_json != expected_json {
            mismatches += 1;
            let (interval, details) = if (1e-6..1e21).contains(&number.abs()) {
                ordinary_mismatches += 1;
                ("ordinary fixed-point interval", &mut ordinary_details)
            } else {
                fallback_mismatches += 1;
                (
                    "special/scientific fallback interval",
                    &mut fallback_details,
                )
            };
            if details.len() < 12 {
                details.push(format!(
                    "bits={input} {interval}; String actual={actual_string:?} expected={expected_string:?}; JSON actual={actual_json:?} expected={expected_json:?}"
                ));
            }
        }
    }
    let counts = fixture["metadata"]["groupCounts"]
        .as_object()
        .expect("coverage counts");
    assert_eq!(counts.len(), groups.len());
    for (group, count) in &groups {
        assert_eq!(
            counts[*group].as_u64(),
            Some(*count as u64),
            "coverage {group}"
        );
    }
    for (group, minimum) in [
        ("special", 16),
        ("notation-boundary", 36),
        ("ordinary-scalar", 100),
        ("shortest-stress", 180),
        ("decimal-power", 6000),
        ("binary-power", 12000),
        ("seeded-finite", 8192),
        ("seeded-ordinary", 8192),
    ] {
        assert!(
            groups.get(group).copied().unwrap_or(0) >= minimum,
            "coverage {group}"
        );
    }
    for center in [1e-6_f64, 1e21] {
        for delta in -4_i64..=4 {
            let raw = center.to_bits().checked_add_signed(delta).unwrap();
            for bits in [raw, raw | (1_u64 << 63)] {
                let input = format!("{bits:016x}");
                assert!(
                    unique.contains(input.as_str()),
                    "missing threshold neighbor {input}"
                );
            }
        }
    }
    ordinary_details.extend(fallback_details);
    assert_eq!(
        mismatches,
        0,
        "{mismatches} exact engine-wire mismatches ({ordinary_mismatches} ordinary, {fallback_mismatches} fallback; first {} below); report existing Display/V8 differences instead of filtering cases:\n{}",
        ordinary_details.len(),
        ordinary_details.join("\n")
    );
}
