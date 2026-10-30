// Test-only source archive guard. The pinned hash uses the existing std-only helper.
use std::path::Path;
#[path = "sha256.rs"]
mod digest;

pub const PINS: [(&str, &str); 5] = [
    (
        "src/schemas/oauth_client.schema.ts",
        "48e796d493fbbc16466e50c2e6dd9f2c46558c76854b900c8b1d585f20b71dc8",
    ),
    (
        "src/schemas/oauth_grant.schema.ts",
        "b82f455eeb977def6100a19e3d190acfed616d6fa9ad7501cc3c1f3523c00df1",
    ),
    (
        "src/schemas/oauth_refresh_token.schema.ts",
        "21568d96d49bc49ee0bc94e0c1b6715cc626368ed736522eeb3ce04152ae54ae",
    ),
    (
        "src/schemas/oauth_session.schema.ts",
        "d383f6bb4c900cfa8323c32719f1b04c8aec0f468d6cfb0fedae7416d6251556",
    ),
    (
        "src/schemas/moderation_action_log.schema.ts",
        "637955d22fc1c7e0ba953ec410a15a2bb324b0340062bd17bc08c13cd975e28b",
    ),
];
pub fn sha256(bytes: &[u8]) -> String {
    digest::sha256_hex(bytes)
}
pub fn provenance(logical: &str) -> String {
    format!("archives/dimabot-typescript/2026-10-28/{logical}")
}
pub fn archived(root: &Path, logical: &str) -> Vec<u8> {
    let pin = PINS
        .iter()
        .find(|(id, _)| *id == logical)
        .expect("allowlisted source")
        .1;
    let live = root.join(logical);
    match std::fs::symlink_metadata(live) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => panic!("retired source must not exist at live path"),
    }
    let archive_root = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28");
    let archive = archive_root.join(logical);
    assert!(
        std::fs::symlink_metadata(&archive)
            .unwrap()
            .file_type()
            .is_file(),
        "archive must be regular"
    );
    let manifest = archive_root.join("manifest.json");
    assert!(
        std::fs::symlink_metadata(&manifest)
            .unwrap()
            .file_type()
            .is_file(),
        "manifest must be regular"
    );
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    let entries: Vec<_> = data["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["source"] == logical)
        .collect();
    assert_eq!(entries.len(), 1, "unique manifest source");
    assert_eq!(entries[0]["sha256"], pin);
    let bytes = std::fs::read(archive).unwrap();
    assert_eq!(sha256(&bytes), pin, "archive source bytes");
    bytes
}
