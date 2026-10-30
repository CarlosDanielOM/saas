// Shared test-only archive resolution for the retired AI-usage helper.
use dima_rust::utils::lossless_json::{JsonValue, parse_json};
use std::path::{Path, PathBuf};

#[path = "sha256.rs"]
mod digest;

pub const LOGICAL: &str = "src/utils/ai_usage_event.ts";
pub const SHA256: &str = "87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60";
pub const PROVENANCE: &str = "archives/dimabot-typescript/2026-10-28/src/utils/ai_usage_event.ts";

pub fn path(root: &Path, logical: &str) -> PathBuf {
    if logical != LOGICAL {
        return root.join(logical);
    }
    let live = root.join(LOGICAL);
    let archive = root.parent().unwrap().join(PROVENANCE);
    assert!(
        std::fs::symlink_metadata(&live).is_err(),
        "retired source must not be shadowed"
    );
    assert!(
        std::fs::symlink_metadata(&archive)
            .unwrap()
            .file_type()
            .is_file()
    );
    let manifest = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28/manifest.json");
    assert!(
        std::fs::symlink_metadata(&manifest)
            .unwrap()
            .file_type()
            .is_file()
    );
    let manifest = parse_json(&std::fs::read_to_string(manifest).unwrap()).unwrap();
    let JsonValue::Array(entries) = manifest.get("files").unwrap() else {
        panic!("archive files")
    };
    let matching: Vec<_> = entries.iter().filter(|e| matches!(e.get("source"), Some(JsonValue::String(s)) if s.as_str() == Some(LOGICAL))).collect();
    assert_eq!(matching.len(), 1, "one exact archive entry required");
    assert!(
        matches!(matching[0].get("sha256"), Some(JsonValue::String(s)) if s.as_str() == Some(SHA256)),
        "archive baseline"
    );
    assert_eq!(
        digest::sha256_hex(&std::fs::read(&archive).unwrap()),
        SHA256,
        "archive bytes"
    );
    archive
}
