#![cfg(feature = "js-regexp-unicode")]

#[path = "support/sha256.rs"]
mod digest;

use dima_rust::utils::js_regexp_unicode::{
    canonicalize, is_letter, is_letter_or_number, is_number, is_uppercase,
};
use serde_json::Value;
use std::path::{Component, Path};

#[test]
fn ordinary_cases() {
    for (source, expected) in [
        (0x41, 0x61), (0x5a, 0x7a), (0x61, 0x61), (0x30, 0x30),
        (0x03a3, 0x03c3), (0x03c2, 0x03c3), (0x03c3, 0x03c3),
        (0x212a, 0x006b), (0x017f, 0x0073), (0x00b5, 0x03bc),
        (0x0345, 0x03b9), (0x0049, 0x0069), (0x0130, 0x0130),
        (0x0131, 0x0131), (0x00df, 0x00df), (0x1e9e, 0x00df),
        (0xfb00, 0xfb00), (0x10400, 0x10428), (0x10428, 0x10428),
    ] {
        assert_eq!(canonicalize(source), expected, "U+{source:04X}");
    }
    for (cp, letter, number, uppercase) in [
        (0x41, true, false, true), (0x61, true, false, false),
        (0x30, false, true, false), (0x5f, false, false, false),
        (0x0345, false, false, false), (0x10400, true, false, true),
        (0x10428, true, false, false), (0x11db0, true, false, false),
        (0x11de1, false, true, false),
        (0xd800, false, false, false), (0xdfff, false, false, false),
        (0x110000, false, false, false), (u32::MAX, false, false, false),
    ] {
        assert_eq!(is_letter(cp), letter, "letter U+{cp:04X}");
        assert_eq!(is_number(cp), number, "number U+{cp:04X}");
        assert_eq!(is_uppercase(cp), uppercase, "uppercase U+{cp:04X}");
        assert_eq!(is_letter_or_number(cp), letter || number, "L/N U+{cp:04X}");
    }
    for cp in [0xd800, 0xdfff, 0x110000, u32::MAX] {
        assert_eq!(canonicalize(cp), cp);
    }
}

fn digest_string(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn checked_pairs(value: &Value, name: &str, ranges: bool) -> Vec<(u32, u32)> {
    let entries = value.as_array().unwrap_or_else(|| panic!("{name} must be an array"));
    assert!(!entries.is_empty(), "{name} must not be empty");
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let pair = entry.as_array().expect("entry must be an array");
        assert_eq!(pair.len(), 2, "{name} entry length");
        let a = pair[0].as_u64().expect("first element must be unsigned");
        let b = pair[1].as_u64().expect("second element must be unsigned");
        assert!(a <= 0x10ffff && b <= 0x10ffff, "{name} out of bounds");
        if ranges { assert!(a <= b, "{name} reversed range"); }
        let (a, b) = (a as u32, b as u32);
        if let Some(&(prev_a, prev_b)) = result.last() {
            assert!(if ranges { prev_b < a } else { prev_a < a }, "{name} not sorted or overlapping");
        }
        result.push((a, b));
    }
    result
}

fn in_ranges(ranges: &[(u32, u32)], cp: u32) -> bool {
    let index = ranges.partition_point(|&(start, _)| start <= cp);
    index != 0 && cp <= ranges[index - 1].1
}

#[test]
#[ignore = "requires independently hashed external Unicode replay fixture"]
fn exhaustive_external_reference_replay() {
    let dir = std::env::var_os("DIMA_JS_REGEXP_UNICODE_FIXTURE_DIR")
        .filter(|v| !v.is_empty()).expect("fixture directory required");
    let dir = Path::new(&dir);
    assert!(dir.is_absolute(), "fixture directory must be absolute");
    let canonical_dir = dir.canonicalize().expect("fixture directory must exist");
    assert_eq!(dir, canonical_dir, "fixture directory must already be canonical");
    assert!(canonical_dir.is_dir(), "fixture path must be a directory");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).canonicalize().expect("manifest root");
    assert!(!canonical_dir.starts_with(&root), "fixture must be outside the crate");
    let fixture_path = canonical_dir.join("js-regexp-unicode-reference.json");
    let bytes = std::fs::read(&fixture_path).expect("read reference fixture");
    assert!(!bytes.is_empty(), "reference fixture must not be empty");
    let fixture_hash = std::env::var("DIMA_JS_REGEXP_UNICODE_FIXTURE_SHA256")
        .expect("independent fixture SHA-256 required");
    assert!(digest_string(&fixture_hash), "fixture SHA-256 must be lowercase hex");
    assert_eq!(digest::sha256_hex(&bytes), fixture_hash, "fixture hash mismatch");
    let doc: Value = serde_json::from_slice(&bytes).expect("parse fixture JSON");
    assert_eq!(doc["format"].as_u64(), Some(1));
    assert_eq!(doc["nodeSha"].as_str(), Some("569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"));
    for (key, expected) in [("node", "24.22.1"), ("v8", "13.6.233.17-node.58"), ("icu", "78.3"), ("unicode", "17.0")] {
        assert_eq!(doc["versions"][key].as_str(), Some(expected), "version {key}");
    }
    for (key, expected) in [("scalarCount", 1_114_112), ("pairCount", 1512), ("boundaryScalarCount", 1_114_112)] {
        assert_eq!(doc["checks"][key].as_u64(), Some(expected), "check {key}");
    }
    let hashes = doc["hashes"].as_object().expect("source hashes object");
    assert!(!hashes.is_empty(), "source hashes must not be empty");
    for (logical, expected) in hashes {
        let path = Path::new(logical);
        assert!(!logical.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_))), "invalid source path {logical}");
        let resolved = root.join(path).canonicalize().expect("source must exist");
        assert!(resolved.starts_with(&root) && resolved.is_file(), "source escapes manifest root");
        let expected = expected.as_str().expect("source hash string");
        assert!(digest_string(expected), "invalid source hash");
        assert_eq!(digest::sha256_hex(&std::fs::read(resolved).expect("read source")), expected, "source {logical}");
    }
    let generated_hash = doc["generatedRustSha256"].as_str().expect("generated Rust hash");
    assert!(digest_string(generated_hash), "invalid generated Rust hash");
    let generated = std::fs::read(root.join("src/utils/js_regexp_unicode_data.rs")).expect("read generated Rust");
    assert_eq!(digest::sha256_hex(&generated), generated_hash, "generated Rust hash mismatch");

    let letters = checked_pairs(&doc["letterRanges"], "letterRanges", true);
    let uppercase = checked_pairs(&doc["uppercaseRanges"], "uppercaseRanges", true);
    let numbers = checked_pairs(&doc["numberRanges"], "numberRanges", true);
    let mappings = checked_pairs(&doc["simpleFoldMappings"], "simpleFoldMappings", false);
    assert_eq!(mappings.len(), 1512);
    for cp in 0..=0x10ffff {
        let letter = in_ranges(&letters, cp);
        let number = in_ranges(&numbers, cp);
        let expected_fold = mappings.binary_search_by_key(&cp, |&(source, _)| source)
            .map(|index| mappings[index].1).unwrap_or(cp);
        assert_eq!(is_letter(cp), letter, "letter U+{cp:04X}");
        assert_eq!(is_number(cp), number, "number U+{cp:04X}");
        assert_eq!(is_uppercase(cp), in_ranges(&uppercase, cp), "uppercase U+{cp:04X}");
        assert_eq!(is_letter_or_number(cp), letter || number, "L/N U+{cp:04X}");
        assert_eq!(canonicalize(cp), expected_fold, "fold U+{cp:04X}");
    }
}
