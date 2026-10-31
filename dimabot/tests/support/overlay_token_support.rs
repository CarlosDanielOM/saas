//! Reader and comparison helpers for the overlay-token source oracle.
//!
//! The oracle is produced outside the workspace by
//! `tests/fixtures/overlay_token_reference.cjs` from the actual
//! `src/utils/overlay-token.ts`, the preserved archived `utils/crypto.ts`, and
//! the live roulette `fail`. This module only consumes it. It never fetches,
//! seeds or derives an expectation.

#![allow(dead_code)]

use serde_json::Value;
use std::path::PathBuf;

#[path = "sha256.rs"]
mod digest;

pub const FILE: &str = "overlay-token-reference.json";
pub const ORACLE: &str = "tests/fixtures/overlay_token_reference.cjs";
pub const MONGO_DATABASE_PREFIX: &str = "rust_overlay_token_fixture_";

/// Loads the externally written oracle and verifies the fixture digest, the
/// oracle writer digest and every source digest the writer pinned.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_OVERLAY_TOKEN_FIXTURE_DIR").expect("external fixture directory"),
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
    let expected = std::env::var("DIMA_OVERLAY_TOKEN_FIXTURE_SHA256").expect("fixture digest");
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
    assert_eq!(fixture["provenance"]["node"], "24.22.1");
    assert_eq!(fixture["provenance"]["v8"], "13.6.233.17-node.58");
    assert_eq!(fixture["provenance"]["typescript"], "5.9.3");
    assert!(fixture["provenance"]["sources"].get("../archives/dimabot-typescript/2026-10-28/src/utils/crypto.ts").is_some(), "archived actual crypto source must be frozen");

    let oracle = root.join(ORACLE);
    let recorded = fixture["provenance"]["oracleSha256"]
        .as_str()
        .expect("oracle digest");
    assert_eq!(
        digest::sha256_hex(&std::fs::read(oracle).expect("oracle source")),
        recorded,
        "the oracle writer changed after the fixture was recorded"
    );
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
        std::env::var("OVERLAY_TOKEN_TEST_MONGO_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("OVERLAY_TOKEN_TEST_MONGO_URI")
        .expect("explicit task-owned MongoDB URI required");
    let base = std::env::var("OVERLAY_TOKEN_TEST_MONGO_DATABASE")
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
