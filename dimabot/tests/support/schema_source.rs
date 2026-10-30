// Test-only source archive guard. The pinned hash uses the existing std-only helper.
use std::path::Path;
#[path = "sha256.rs"]
mod digest;

pub const PINS: [(&str, &str); 18] = [
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
    (
        "src/schemas/admin.schema.ts",
        "b45fef05b1b176cac11283df5ec7d1d09b1fc327bae98e4e7ca4447f43baa2e0",
    ),
    (
        "src/schemas/accounts.schema.ts",
        "7eab86b048cb05d44e9b17c7498c18b713e4c722b71f58f545158fde040431f1",
    ),
    (
        "src/schemas/credit_gift.schema.ts",
        "f76f4472354751b42587baa1271214c198aac40b86b5fcb85fd046e4de9c0607",
    ),
    (
        "src/schemas/credit_transaction.schema.ts",
        "14017b20e83ec2eebf7a10475b5ade495554cc9043685af3dd5045350a9e985f",
    ),
    (
        "src/schemas/command_timer.schema.ts",
        "db42c5b989f6e154551c714f51736585b0230fa743f6bc51fe935b54530af4f5",
    ),
    (
        "src/schemas/countdown_timer.schema.ts",
        "5d6ab4812c726b2aab0a8fee4a3ca060c6dacc97f59b8aee66c46b669766b990",
    ),
    (
        "src/schemas/countdown_timer_config.schema.ts",
        "b4cf0d5f8cfe85dc1e04f11970aac8bbab48a27c86fc9fab43d935cdbb1ada8a",
    ),
    (
        "src/schemas/custom_timer.schema.ts",
        "6c59b38b43615325f87c870dcbd5dfe2cd0b50e91822dbe884d3c32dd45f387f",
    ),
    (
        "src/schemas/chat_logs.schema.ts",
        "732abc7b27b820fa6ded0d62b1dc3bf3aed8539c7fd636a47f47d98f70b63433",
    ),
    (
        "src/schemas/channel_fish_voice_favorites.schema.ts",
        "30b6361cdcc62f66716183d19bcf9a2bb3269507f2c705ea059cb19de44e60e2",
    ),
    (
        "src/schemas/channel_fish_voice_favorites.schema.test.ts",
        "4fb11013883efd0d99ba9125711c18d78517f87e401b5193722b6c79d616d02f",
    ),
    (
        "src/schemas/channel_tts_settings.schema.ts",
        "5e943f59906bdf4f63dbb52497ccc8607c6fb069cf8b9af0521a4652245c64c2",
    ),
    (
        "src/schemas/moderation_chatter.schema.ts",
        "71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e",
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
