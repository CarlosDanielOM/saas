#![cfg(feature = "js-unicode17")]
use dima_rust::utils::{js_string::JsString, js_unicode::normalize_nfc};
use serde_json::Value;
use std::{borrow::Cow, path::PathBuf};

#[test]
fn nfc_composition_reordering_hangul_and_borrowing() {
    for (input, expected) in [
        ("e\u{301}", "é"),
        ("A\u{30a}\u{301}", "Ǻ"),
        ("A\u{315}\u{300}", "À\u{315}"),
        ("\u{344}", "\u{308}\u{301}"),
        ("\u{1100}\u{1161}\u{11a8}", "각"),
        ("가\u{11a8}", "각"),
    ] {
        assert_eq!(
            normalize_nfc(&JsString::from(input)).as_str(),
            Some(expected)
        );
    }
    let ascii = JsString::from_static("ASCII 123");
    assert!(matches!(normalize_nfc(&ascii), Cow::Borrowed(_)));
    let already = JsString::from_static("é각😀");
    assert!(matches!(normalize_nfc(&already), Cow::Borrowed(_)));
}
#[test]
fn nfc_keeps_surrogate_and_unicode17_unassigned_barriers() {
    assert_eq!(unicode_normalization::UNICODE_VERSION, (18, 0, 0));
    for cp in ['\u{1ade}', '\u{1adf}'] {
        assert_ne!(
            unicode_normalization::char::canonical_combining_class(cp),
            0
        );
        let input = JsString::from(format!("A\u{301}{cp}\u{327}"));
        assert_eq!(
            normalize_nfc(&input).as_str(),
            Some(format!("Á{cp}\u{327}").as_str())
        );
    }
    let s = JsString::from_units(vec![0xd800, 0x0041, 0x0301, 0xdc00]);
    assert_eq!(normalize_nfc(&s).units(), vec![0xd800, 0x00c1, 0xdc00]);
    let s = JsString::from_units(vec![0xd800, 0x0301, 0xdc00]);
    assert_eq!(normalize_nfc(&s).units(), vec![0xd800, 0x0301, 0xdc00]);
}

#[path = "support/sha256.rs"]
mod digest;
use digest::sha256_hex;

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
        .collect()
}
fn point_units(cp: u32) -> Vec<u16> {
    if (0xd800..=0xdfff).contains(&cp) {
        vec![cp as u16]
    } else {
        char::from_u32(cp)
            .unwrap()
            .encode_utf16(&mut [0; 2])
            .to_vec()
    }
}
#[test]
#[ignore = "requires independently pinned external Node NFC reference"]
fn replay_all_codepoints_and_contexts_from_pinned_node() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_JS_NFC_DIR").expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    let canonical = dir.canonicalize().unwrap();
    assert_eq!(dir, canonical);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!canonical.starts_with(root.parent().unwrap()));
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let bytes = std::fs::read(dir.join("js-unicode-nfc-reference.json")).unwrap();
    let pin = std::env::var("DIMA_JS_NFC_SHA256").expect("fixture SHA-256 pin required");
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(sha256_hex(&bytes), pin);
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["format"], 1);
    assert_eq!(fixture["algorithm"], "Node String.prototype.normalize NFC");
    assert_eq!(
        fixture["versions"],
        serde_json::json!({"node":"24.22.1","v8":"13.6.233.17-node.58","icu":"78.3","unicode":"17.0"})
    );
    assert_eq!(
        fixture["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (path, contents) in [
        (
            "src/utils/js_unicode.rs",
            &include_bytes!("../src/utils/js_unicode.rs")[..],
        ),
        (
            "src/utils/js_unicode_data.rs",
            &include_bytes!("../src/utils/js_unicode_data.rs")[..],
        ),
        (
            "src/utils/moderation/variations.rs",
            &include_bytes!("../src/utils/moderation/variations.rs")[..],
        ),
        (
            "tests/js_unicode_nfc.rs",
            &include_bytes!("js_unicode_nfc.rs")[..],
        ),
        (
            "tests/support/sha256.rs",
            &include_bytes!("support/sha256.rs")[..],
        ),
        (
            "tests/fixtures/js_unicode_nfc_reference.cjs",
            &include_bytes!("fixtures/js_unicode_nfc_reference.cjs")[..],
        ),
        ("Cargo.lock", &include_bytes!("../Cargo.lock")[..]),
        (
            "rust-toolchain.toml",
            &include_bytes!("../rust-toolchain.toml")[..],
        ),
    ] {
        assert_eq!(
            fixture["sourceSha256"][path],
            sha256_hex(contents),
            "source {path}"
        );
    }
    assert_eq!(fixture["fixedCount"], 20);
    assert_eq!(fixture["fragmentCount"], 16);
    assert_eq!(fixture["caseCount"], 4116);
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 4116);
    for (i, case) in cases.iter().enumerate() {
        let input = units(&case["input"]);
        assert_eq!(
            normalize_nfc(&JsString::from_units(input.clone())).units(),
            units(&case["output"]),
            "case {i}: {input:04x?}"
        );
    }
    assert_eq!(fixture["scalar"]["count"], 0x110000);
    assert_eq!(
        fixture["scalar"]["encoding"],
        "ascending u32be codepoint, u32be UTF-16 length, u16be output units"
    );
    let mut stream = Vec::with_capacity(0x110000 * 12);
    let mut changed = 0u64;
    for cp in 0..=0x10ffffu32 {
        let input = point_units(cp);
        let output = normalize_nfc(&JsString::from_units(input.clone())).units();
        if input != output {
            changed += 1;
        }
        stream.extend(cp.to_be_bytes());
        stream.extend((output.len() as u32).to_be_bytes());
        for unit in output {
            stream.extend(unit.to_be_bytes());
        }
    }
    assert_eq!(fixture["scalar"]["changed"].as_u64(), Some(changed));
    assert_eq!(
        fixture["scalar"]["bytes"].as_u64(),
        Some(stream.len() as u64)
    );
    assert_eq!(fixture["scalar"]["sha256"], sha256_hex(&stream));
}
