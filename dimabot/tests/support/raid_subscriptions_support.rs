//! Reader and comparison helpers for the raid-subscriptions source oracle.
//!
//! The oracle is produced outside the workspace by
//! `tests/fixtures/raid_subscriptions_reference.cjs` from the actual
//! `src/utils/raid_subscriptions.ts`, the preserved archived `raid_direction.ts`
//! and `eventsub.schema.ts`, and the live preference schema. This module only
//! consumes it. It never fetches, seeds or derives an expectation.
//!
//! Recorded findings are plain JSON (strings, booleans, numbers), so BSON
//! comparison is a small recursive key/value check rather than a codec. Object
//! key order is ignored because MongoDB query documents are key-order
//! insensitive; value types are not.

#![allow(dead_code)]

use mongodb::bson::{Bson, Document, doc};
use serde_json::Value;
use std::path::PathBuf;

#[path = "sha256.rs"]
mod digest;

pub const FILE: &str = "raid-subscriptions-reference.json";
pub const ORACLE: &str = "tests/fixtures/raid_subscriptions_reference.cjs";

/// Loads the externally written oracle and verifies both digests: the one the
/// harness supplies for the fixture itself, and the oracle writer recorded in
/// its own provenance.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_RAID_SUBSCRIPTIONS_FIXTURE_DIR")
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
        std::env::var("DIMA_RAID_SUBSCRIPTIONS_FIXTURE_SHA256").expect("fixture digest");
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
    // The source digests the writer pinned must still describe this checkout.
    for (path, digest) in fixture["provenance"]["sources"]
        .as_object()
        .expect("source digests")
    {
        let bytes = std::fs::read(root.join(path))
            .unwrap_or_else(|error| panic!("source {path}: {error}"));
        assert_eq!(
            digest::sha256_hex(&bytes),
            digest.as_str().expect("digest text"),
            "source changed after the fixture was recorded: {path}"
        );
    }
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

/// Converts a recorded JSON document (the projection-equivalent subset written
/// by the oracle) into BSON. Only JSON scalars and objects occur.
pub fn document(value: &Value) -> Document {
    value
        .as_object()
        .unwrap_or_else(|| panic!("expected a JSON object, got {value}"))
        .iter()
        .map(|(key, value)| (key.clone(), bson_value(value)))
        .collect()
}

fn bson_value(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                // `doc!` spells small integers as Int32; match it so a recorded
                // projection and a native builder compare equal.
                i32::try_from(value)
                    .map(Bson::Int32)
                    .unwrap_or(Bson::Int64(value))
            } else if let Some(value) = value.as_f64() {
                Bson::Double(value)
            } else {
                panic!("unsupported JSON number {value}")
            }
        }
        Value::String(value) => Bson::String(value.clone()),
        Value::Array(values) => Bson::Array(values.iter().map(bson_value).collect()),
        Value::Object(_) => Bson::Document(document(value)),
    }
}

/// Compares the exact field set recorded by the oracle. Query documents are
/// key-order insensitive, but a missing or extra constraint is a real policy
/// difference.
pub fn assert_document(actual: &Document, recorded: &Document, label: &str) {
    assert_eq!(
        actual.keys().collect::<std::collections::BTreeSet<_>>(),
        recorded.keys().collect::<std::collections::BTreeSet<_>>(),
        "{label}: field set in {actual:?}"
    );
    for (key, expected) in recorded {
        assert_value(&actual[key], expected, &format!("{label}.{key}"));
    }
}

fn assert_value(actual: &Bson, expected: &Bson, label: &str) {
    match (actual, expected) {
        (Bson::Document(actual), Bson::Document(expected)) => {
            assert_eq!(
                actual.keys().collect::<std::collections::BTreeSet<_>>(),
                expected.keys().collect::<std::collections::BTreeSet<_>>(),
                "{label}: field set"
            );
            for (key, expected) in expected {
                assert_value(&actual[key], expected, &format!("{label}.{key}"));
            }
        }
        (Bson::Array(actual), Bson::Array(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{label}: array length");
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                assert_value(actual, expected, &format!("{label}[{index}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{label}: value"),
    }
}

/// A Mongo filter containing one equality field, for assertion messages.
pub fn filter(field: &str, value: &str) -> Document {
    doc! {field: value}
}

/// Shared disposable MongoDB harness. The names, prefix and acknowledgement are
/// deliberately different from every other suite.
pub const MONGO_DATABASE_PREFIX: &str = "rust_raid_subscriptions_fixture_";
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
        std::env::var("RAID_SUBSCRIPTIONS_TEST_MONGO_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("RAID_SUBSCRIPTIONS_TEST_MONGO_URI")
        .expect("explicit task-owned MongoDB URI required");
    let base = std::env::var("RAID_SUBSCRIPTIONS_TEST_MONGO_DATABASE")
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
