use std::path::PathBuf;
#[path = "sha256.rs"] mod digest;
pub fn fixture() -> serde_json::Value {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap().parent().unwrap().to_path_buf();
    let dir = PathBuf::from(std::env::var_os("DIMA_AUTH_AUTHORIZE_FIXTURE_DIR").expect("fixture directory"));
    assert!(dir.is_absolute() && dir.canonicalize().unwrap() == dir && !dir.starts_with(workspace));
    let path = dir.join("auth-authorize-route-reference.json"); assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_file());
    let bytes = std::fs::read(path).unwrap(); assert_eq!(digest::sha256_hex(&bytes), std::env::var("DIMA_AUTH_AUTHORIZE_FIXTURE_SHA256").expect("fixture hash"));
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["metadata"]["node"], "24.22.1");
    assert_eq!(value["metadata"]["v8"], "13.6.233.17-node.58");
    assert_eq!(value["metadata"]["typescript"], "5.9.3");
    value
}
