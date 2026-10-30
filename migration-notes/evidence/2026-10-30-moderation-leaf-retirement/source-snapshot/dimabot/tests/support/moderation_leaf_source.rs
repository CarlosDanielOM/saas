// Test-only verification of the three frozen moderation leaf sources.
use std::path::{Path, PathBuf};
#[path = "sha256.rs"]
pub mod digest;

pub fn path(root: &Path, logical: &str) -> PathBuf {
    let expected = match logical {
        "src/utils/moderation/normalize.ts" => {
            "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab"
        }
        "src/utils/moderation/rules/links.rule.ts" => {
            "802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0"
        }
        "src/utils/moderation/spam_categories.ts" => {
            "29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088"
        }
        _ => return root.join(logical),
    };
    let archive_root = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28");
    let archive = archive_root.join(logical);
    match std::fs::symlink_metadata(root.join(logical)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => panic!("retired source must not be shadowed"),
    }
    assert!(
        std::fs::symlink_metadata(&archive)
            .unwrap()
            .file_type()
            .is_file()
    );
    let manifest = archive_root.join("manifest.json");
    assert!(
        std::fs::symlink_metadata(&manifest)
            .unwrap()
            .file_type()
            .is_file()
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    let entries = manifest["files"].as_array().expect("archive files");
    let matches: Vec<_> = entries
        .iter()
        .filter(|entry| entry["source"].as_str() == Some(logical))
        .collect();
    assert_eq!(matches.len(), 1, "one exact archive entry required");
    assert_eq!(
        matches[0]["sha256"].as_str(),
        Some(expected),
        "archive baseline"
    );
    assert_eq!(
        digest::sha256_hex(&std::fs::read(&archive).unwrap()),
        expected,
        "archive bytes"
    );
    archive
}
