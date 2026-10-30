// Test-only source archive guard. The pinned hash uses the existing std-only helper.
use std::path::Path;
#[path = "sha256.rs"]
mod digest;

pub const PINS: [(&str, &str); 9] = [
    (
        "src/schemas/temporary_moderator.schema.ts",
        "1eeab71be86ccb0df0ff7c8404cce8580d27fd280853293175433e72155ef146",
    ),
    (
        "src/schemas/vip.schema.ts",
        "b68e2689c7cd4598b2719a2305d7e42ec504e15868808c26b7e8615806e78f85",
    ),
    (
        "src/schemas/title_config.schema.ts",
        "5a2886025ab6ca4bd75c54f623ec732a13c392185945a967e372360e4ccb9a97",
    ),
    (
        "src/schemas/trigger_file.schema.ts",
        "4ce0751c6232be1088ef05707dee271efea1157e93821c431c01bfb3a0545bd4",
    ),
    (
        "src/schemas/eventsub.schema.ts",
        "9d641eb036d2dba0907ab5b70bfb58265bbd7174915ddfd8f87b676319d75bf3",
    ),
    (
        "src/schemas/site_analytics.schema.ts",
        "6a187e768b8a246143a9ea04b8000583b60090639b0a904fc265bed22b6090d3",
    ),
    (
        "src/schemas/follow_attack_log.schema.ts",
        "418077f7dae3dbfbea4e800eb1444920de2c202828dbe97b87c3e074cea0b032",
    ),
    (
        "src/schemas/follow_defense_action.schema.ts",
        "0b56200c8aa2ad0c29668c82da87354517774c2e523e448868daf4c7fafc9cf4",
    ),
    (
        "src/schemas/follow_hate_raid_source.schema.ts",
        "8b2321fcf3eed917304bd3d2e03bf975b5351a3a37494cbe1e8ad54947c1215e",
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
