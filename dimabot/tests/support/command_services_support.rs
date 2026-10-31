//! Reader for the command-services source oracle plus the BSON/JSON comparison
//! helpers used by `tests/command_services.rs`.
//!
//! The oracle is produced outside the workspace by
//! `tests/fixtures/command_services_reference.cjs` from the actual TypeScript
//! services. This module only consumes it:
//!
//! * recorded command documents are BSON-serialized by the pinned driver, so
//!   ObjectId, Date and Int32/Double survive a round trip through the real
//!   codec;
//! * object key order is canonicalised for comparison, because MongoDB and the
//!   native schema constructor may emit the same fields in a different order;
//! * JSON payloads are compared as `serde_json::Value` trees, so key order is
//!   irrelevant but types (null versus absent, number spelling) are not.
//!
//! No value encoder, number rule or date formatter is reimplemented here.

#![allow(dead_code)]

use mongodb::bson::{Bson, Document};
use serde_json::Value;
use std::path::PathBuf;

#[path = "sha256.rs"]
mod digest;

pub const FILE: &str = "command-services-reference.json";
pub const ORACLE: &str = "tests/fixtures/command_services_reference.cjs";

/// Loads the externally written oracle and verifies both digests: the one the
/// harness supplies for the fixture itself, and the oracle writer recorded in
/// its own provenance.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_COMMAND_SERVICES_FIXTURE_DIR")
            .expect("external fixture directory"),
    );
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert_eq!(
        directory.canonicalize().expect("fixture directory"),
        directory
    );
    assert!(
        !directory.starts_with(&workspace),
        "fixture must live outside the workspace"
    );
    let expected =
        std::env::var("DIMA_COMMAND_SERVICES_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture digest must be lowercase hex"
    );
    let file = directory.join(FILE);
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file(),
        "fixture must be a regular file"
    );
    let bytes = std::fs::read(&file).expect("fixture bytes");
    assert_eq!(
        digest::sha256_hex(&bytes),
        expected,
        "fixture digest mismatch"
    );
    let fixture: Value = serde_json::from_slice(&bytes).expect("fixture JSON");

    let oracle = root.join(ORACLE);
    let recorded = fixture["provenance"]["oracleSha256"]
        .as_str()
        .expect("oracle digest");
    assert_eq!(
        digest::sha256_hex(&std::fs::read(oracle).expect("oracle source")),
        recorded,
        "the oracle writer changed after the fixture was recorded"
    );
    fixture
}

pub fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {name}"))
}

pub fn fixture_case_names(fixture: &Value) -> Vec<String> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .map(|case| case["name"].as_str().expect("case name").to_owned())
        .collect()
}

/// Every case whose `kind` field matches, in recorded order.
pub fn cases_of<'a>(fixture: &'a Value, kind: &str) -> Vec<&'a Value> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .filter(|case| case["kind"] == kind)
        .collect()
}

/// `true` when the native side can reproduce the recorded case.
pub fn replays_natively(case: &Value) -> bool {
    case["replay"].as_str() == Some("native")
}

pub fn input(case: &Value) -> &Value {
    &case["input"]
}

pub fn expected(case: &Value) -> &Value {
    &case["expect"]
}

/// Decodes one recorded BSON document.
pub fn document(hex: &str) -> Document {
    let bytes = hex_bytes(hex);
    Document::from_reader(bytes.as_slice()).expect("recorded BSON document")
}

/// Decodes a recorded hex array, preserving order.
pub fn documents(hexes: &Value) -> Vec<Document> {
    hexes
        .as_array()
        .expect("recorded BSON hex array")
        .iter()
        .map(|hex| document(hex.as_str().expect("recorded BSON hex")))
        .collect()
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    assert!(hex.len() % 2 == 0, "hex length must be even");
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("hex text");
            u8::from_str_radix(text, 16).expect("hex pair")
        })
        .collect()
}

/// Recursively sorts object keys and keeps every value and BSON type unchanged.
/// Arrays keep their order: element order is meaningful, key order is not.
pub fn canonical(document: &Document) -> Document {
    let mut pairs: Vec<(String, Bson)> = document
        .iter()
        .map(|(key, value)| (key.clone(), canonical_value(value)))
        .collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    let mut output = Document::new();
    for (key, value) in pairs {
        output.insert(key, value);
    }
    output
}

fn canonical_value(value: &Bson) -> Bson {
    match value {
        Bson::Document(document) => Bson::Document(canonical(document)),
        Bson::Array(values) => Bson::Array(values.iter().map(canonical_value).collect()),
        other => other.clone(),
    }
}

pub fn assert_document(actual: &Document, expected: &Document, context: &str) {
    assert_eq!(canonical(actual), canonical(expected), "{context}");
}

/// Compares two stored-document sets by `_id`, ignoring server return order.
pub fn assert_document_set(actual: &[Document], expected: &[Document], context: &str) {
    let key = |document: &Document| {
        document
            .get("_id")
            .map(|value| format!("{value:?}"))
            .unwrap_or_default()
    };
    let mut actual: Vec<Document> = actual.to_vec();
    let mut expected: Vec<Document> = expected.to_vec();
    actual.sort_by_key(key);
    expected.sort_by_key(key);
    assert_eq!(actual.len(), expected.len(), "{context}: document count");
    for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(
            canonical(actual),
            canonical(expected),
            "{context}: document {index}"
        );
    }
}

/// Compares a native JSON payload with the recorded source payload.
pub fn assert_json(actual: &Value, expected: &Value, context: &str) {
    assert_eq!(actual, expected, "{context}");
}
