//! Reader for the slice-4a data oracle plus the BSON comparison helpers used by
//! `tests/stream_timeline_data.rs`.
//!
//! The oracle is produced by `tests/fixtures/stream-timeline-data-reference.cjs`
//! from the actual TypeScript sources. This module only consumes it:
//!
//! * recorded driver documents are decoded with the real BSON codec, so Int32
//!   versus Double, dates, ObjectIds and document field order survive intact;
//! * object key order is canonicalised for comparison, because MongoDB update
//!   and query documents are key-order-insensitive while the native schema
//!   constructor emits declaration order and Mongoose appends defaults;
//! * recorded outputs are `JSON.stringify` text and are compared through
//!   `utils::bson_js_json`, the existing JSON.stringify view of BSON.
//!
//! No value encoder, number rule or date formatter is reimplemented here.

#![allow(dead_code)]

use mongodb::bson::{Bson, Document};
use serde_json::Value;
use std::path::PathBuf;

#[path = "sha256.rs"]
mod digest;

pub const FILE: &str = "stream-timeline-data-reference.json";

/// Loads the externally written oracle and verifies its independent digest.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_STREAM_TIMELINE_DATA_FIXTURE_DIR")
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
    let expected = std::env::var("DIMA_STREAM_TIMELINE_DATA_FIXTURE_SHA256").expect("fixture digest");
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
    assert_eq!(digest::sha256_hex(&bytes), expected, "fixture digest mismatch");
    serde_json::from_slice(&bytes).expect("fixture JSON")
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

pub fn calls(case: &Value) -> &Vec<Value> {
    case["calls"].as_array().expect("calls array")
}

pub fn call_roles(case: &Value) -> Vec<String> {
    calls(case)
        .iter()
        .map(|call| call["role"].as_str().expect("call role").to_owned())
        .collect()
}

/// The single recorded call for this role, when the case recorded one.
pub fn optional_call<'a>(case: &'a Value, role: &str) -> Option<&'a Value> {
    let mut matching = calls(case).iter().filter(|call| call["role"] == role);
    let first = matching.next();
    assert!(
        matching.next().is_none(),
        "{}: expected at most one recorded {role} call",
        case["name"]
    );
    first
}

/// The single recorded call for this role.
pub fn call<'a>(case: &'a Value, role: &str) -> &'a Value {
    let mut matching = calls(case).iter().filter(|call| call["role"] == role);
    let first = matching
        .next()
        .unwrap_or_else(|| panic!("{}: recorded call {role}", case["name"]));
    assert!(
        matching.next().is_none(),
        "{}: expected one recorded {role} call",
        case["name"]
    );
    first
}

pub fn call_document(call: &Value, field: &str) -> Document {
    document(call[field].as_str().expect("recorded BSON hex"))
}

pub fn call_documents(call: &Value) -> Vec<Document> {
    call["docsHex"]
        .as_array()
        .expect("recorded BSON hex array")
        .iter()
        .map(|hex| document(hex.as_str().expect("recorded BSON hex")))
        .collect()
}

/// The document a stubbed read returned, when the case recorded one.
pub fn returned_document(call: &Value) -> Option<Document> {
    call["docHex"].as_str().map(document)
}

pub fn document(hex: &str) -> Document {
    let bytes = hex_bytes(hex);
    Document::from_reader(bytes.as_slice()).expect("recorded BSON document")
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
/// Arrays keep their order: element order is meaningful, object key order is not.
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

/// Asserts the `JSON.stringify` view of a native result against the recorded text.
pub fn assert_json(actual: &Bson, expected: &str, context: &str) {
    let view = dima_rust::utils::bson_js_json::bson_js_json(actual).expect("JSON view");
    assert_eq!(view.to_json_string(), expected, "{context}");
}

pub fn output<'a>(case: &'a Value) -> &'a str {
    case["output"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: recorded output", case["name"]))
}

/// A recorded JavaScript number, including the `-0`/`NaN`/`Infinity` markers.
pub fn number(node: &Value) -> Option<f64> {
    if let Some(value) = node.as_f64() {
        return Some(value);
    }
    let text = node.get("$javascriptNumber")?.as_str()?;
    Some(match text {
        "-0" => -0.0,
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        other => other.parse().ok()?,
    })
}

pub fn optional_number(node: &Value) -> Option<f64> {
    if node.is_null() { None } else { number(node) }
}

pub fn text(node: &Value) -> Option<&str> {
    node.as_str()
}

// ---------------------------------------------------------------------------
// Shared disposable MongoDB harness
// ---------------------------------------------------------------------------

pub const MONGO_DATABASE_PREFIX: &str = "rust_stream_timeline_fixture_";
pub type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct DisposableDatabase {
    pub database: mongodb::Database,
    pub name: String,
}

impl DisposableDatabase {
    /// Drops only this task's database.
    pub async fn drop_database(self) {
        self.database.drop().await.ok();
    }
}

/// Requires the explicit acknowledgement, a prefixed database name and an empty
/// database. The suffix keeps parallel suites in separate databases.
pub async fn disposable_database(suffix: &str) -> TestResult<DisposableDatabase> {
    assert_eq!(
        std::env::var("STREAM_TIMELINE_TEST_MONGO_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("STREAM_TIMELINE_TEST_MONGO_URI")
        .expect("explicit task-owned MongoDB URI required");
    let base = std::env::var("STREAM_TIMELINE_TEST_MONGO_DATABASE")
        .expect("explicit task-owned MongoDB database required");
    assert!(
        base.starts_with(MONGO_DATABASE_PREFIX),
        "task database must use the fixture prefix"
    );
    let name = format!("{base}_{suffix}");
    assert!(
        name.starts_with(MONGO_DATABASE_PREFIX),
        "derived fixture database keeps the prefix"
    );
    let client = mongodb::Client::with_uri_str(&uri).await?;
    let database = client.database(&name);
    assert!(
        database.list_collection_names().await?.is_empty(),
        "task database must be fresh"
    );
    Ok(DisposableDatabase { database, name })
}
