#![cfg(feature = "permissions")]
#[path = "support/sha256.rs"]
mod digest;

use dima_rust::utils::{
    js_string::JsString,
    permissions::error_rate_limit::{
        MAX_TRACKED, PermissionErrorLimiter, should_log_permission_error,
    },
};

fn key(s: &str) -> JsString {
    JsString::from(s)
}
#[test]
fn eviction_refresh_and_denial_order() {
    let mut l = PermissionErrorLimiter::new();
    for i in 0..MAX_TRACKED {
        assert!(l.should_log(&key(&format!("{i}")), 0.0, 10.0));
    }
    assert!(!l.should_log(&key("0"), 1.0, 10.0));
    assert!(l.should_log(&key("1"), 10.0, 10.0));
    assert!(l.should_log(&key("new"), 1.0, 10.0));
    let s = l.snapshot();
    assert_eq!(s.len(), MAX_TRACKED);
    assert_eq!(s[0].0, key("2"));
    assert_eq!(s[MAX_TRACKED - 2].0, key("1"));
    assert_eq!(s[MAX_TRACKED - 1].0, key("new"));
    assert!(l.should_log(&key("0"), 1.0, 10.0));
}
#[test]
fn numbers_and_raw_utf16() {
    let mut l = PermissionErrorLimiter::new();
    let a = JsString::from_units(vec![0xd800]);
    let b = JsString::from_units(vec![0xdc00]);
    assert!(l.should_log(&a, -0.0, 1.0));
    assert!(!l.should_log(&a, 0.0, 1.0));
    assert!(l.should_log(&b, 0.0, 1.0));
    assert!(!l.should_log(&a, -1.0, 1.0));
    assert!(l.should_log(&a, f64::NAN, 1.0));
    assert!(l.should_log(&a, 0.0, 1.0));
    assert!(l.should_log(&a, f64::INFINITY, f64::INFINITY));
    assert!(l.should_log(&a, f64::INFINITY, 1.0));
    assert!(!l.should_log(&b, 0.0, f64::INFINITY));
    assert!(l.should_log(&b, 0.0, f64::NAN));
}
#[test]
fn process_global_is_shared_and_serializes_competing_calls() {
    let key = key("permission-rate-limit-concurrent-test-unique-key");
    let threads: Vec<_> = (0..32)
        .map(|_| {
            let key = key.clone();
            std::thread::spawn(move || {
                should_log_permission_error(&key, Some(500.0), Some(300000.0))
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|v| *v)
            .count(),
        1
    );
    assert!(!should_log_permission_error(&key, Some(501.0), None));
    let clock_key = JsString::from("permission-rate-limit-default-clock-test-unique-key");
    assert!(should_log_permission_error(&clock_key, None, None));
    assert!(!should_log_permission_error(
        &clock_key,
        Some(0.0),
        Some(f64::INFINITY)
    ));
}
// Equivalent to the two SHA-pinned original node:test groups, using an owned
// limiter so test order and other process-global calls cannot affect the result.
#[test]
fn original_repeated_key_window_contract() {
    let mut limiter = PermissionErrorLimiter::new();
    let k = key("test:repeated:fixture");
    assert!(limiter.should_log(&k, 1_000.0, 60_000.0));
    assert!(!limiter.should_log(&k, 30_000.0, 60_000.0));
    assert!(limiter.should_log(&k, 61_000.0, 60_000.0));
}
#[test]
fn original_independent_keys_contract() {
    let mut limiter = PermissionErrorLimiter::new();
    assert!(limiter.should_log(&key("test:command:fixture"), 1_000.0, 60_000.0));
    assert!(limiter.should_log(&key("test:moderation:fixture"), 1_000.0, 60_000.0));
}
const SOURCE_PINS: &[(&str, &str)] = &[
    (
        "src/utils/permissions/error_rate_limit.ts",
        "4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56",
    ),
    (
        "src/utils/permissions/error_rate_limit.test.ts",
        "95bee599c425783a84f093c637624eb1ceed5713669c21da596557e95981f0fa",
    ),
];
const FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "src/lib.rs",
    "src/utils/mod.rs",
    "src/utils/js_compat.rs",
    "src/utils/js_string.rs",
    "src/utils/permissions/index.rs",
    "src/utils/permissions/error_rate_limit.rs",
    "tests/permission_error_rate_limit.rs",
    "tests/fixtures/permission_error_rate_limit_reference.cjs",
    "tests/fixtures/permission_error_rate_limit_source_resolver.cjs",
    "tests/support/sha256.rs",
];
fn regular(path: &std::path::Path) -> Option<Vec<u8>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            assert!(
                meta.file_type().is_file(),
                "regular file required: {}",
                path.display()
            );
            assert_eq!(path.canonicalize().unwrap(), path);
            Some(std::fs::read(path).unwrap())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => panic!("{}: {e}", path.display()),
    }
}
fn verify_bindings(root: &std::path::Path, metadata: &serde_json::Value) {
    let archive = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28");
    let manifest_bytes = regular(&archive.join("manifest.json")).expect("manifest");
    assert_eq!(
        digest::sha256_hex(&manifest_bytes),
        metadata["manifestSha256"].as_str().unwrap()
    );
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
    let entries = manifest["files"].as_array().unwrap();
    assert_eq!(
        metadata["sourceBindings"].as_object().unwrap().len(),
        SOURCE_PINS.len()
    );
    for &(name, hash) in SOURCE_PINS {
        let live = regular(&root.join(name));
        let archived = regular(&archive.join(name));
        assert_ne!(live.is_some(), archived.is_some(), "exactly one {name}");
        let matches: Vec<_> = entries.iter().filter(|e| e["source"] == name).collect();
        let (bytes, location) = if let Some(bytes) = archived {
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0]["sha256"], hash);
            (bytes, "archive")
        } else {
            assert!(matches.is_empty());
            (live.unwrap(), "live")
        };
        assert_eq!(digest::sha256_hex(&bytes), hash);
        assert_eq!(metadata["sourceBindings"][name]["sha256"], hash);
        assert_eq!(metadata["sourceBindings"][name]["location"], location);
    }
    let files = metadata["files"].as_object().unwrap();
    assert_eq!(files.len(), FILES.len());
    for name in FILES {
        assert_eq!(
            digest::sha256_hex(&regular(&root.join(name)).unwrap()),
            files[*name].as_str().unwrap(),
            "{name}"
        );
    }
    assert_eq!(
        metadata["testGroups"],
        serde_json::json!([
            "permission errors are logged once per key during the rate-limit window",
            "unrelated permission errors have independent rate limits"
        ])
    );
}
fn num(v: &serde_json::Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
}
fn units(v: &serde_json::Value) -> JsString {
    JsString::from_units(
        v.as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect(),
    )
}
#[test]
#[ignore = "requires externally generated pinned TypeScript oracle"]
fn replay_actual_source() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let checkout = root.parent().unwrap();
    let dir = std::path::PathBuf::from(
        std::env::var_os("PERMISSION_ERROR_REFERENCE_DIR").expect("external oracle directory"),
    );
    assert!(dir.is_absolute() && !dir.starts_with(checkout));
    assert!(std::fs::symlink_metadata(&dir).unwrap().is_dir());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    let raw = regular(&dir.join("permission_error_rate_limit_reference.json")).unwrap();
    let pin =
        std::env::var("PERMISSION_ERROR_REFERENCE_SHA256").expect("independent reference hash");
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    );
    assert_eq!(digest::sha256_hex(&raw), pin);
    let oracle: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(oracle["metadata"]["schema"], 2);
    assert_eq!(
        oracle["metadata"]["node_sha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    verify_bindings(&root, &oracle["metadata"]);
    assert_eq!(oracle["metadata"]["node"], "v24.22.1");
    assert_eq!(oracle["metadata"]["v8"], "13.6.233.17-node.58");
    assert_eq!(oracle["metadata"]["typescript"], "5.9.3");
    let operations = oracle["operations"].as_array().unwrap();
    let results = oracle["results"].as_array().unwrap();
    assert_eq!(operations.len(), results.len());
    assert_eq!(operations.len(), 2113);
    let mut l = PermissionErrorLimiter::new();
    for (op, expected) in operations.iter().zip(results) {
        assert_eq!(
            l.should_log(&units(&op["key"]), num(&op["now"]), num(&op["interval"])),
            expected.as_bool().unwrap()
        );
    }
    let actual = l.snapshot();
    let state = oracle["state"].as_array().unwrap();
    assert_eq!(state.len(), 2000);
    assert_eq!(actual.len(), state.len());
    for ((key, at), row) in actual.iter().zip(state) {
        assert_eq!(*key, units(&row["key"]));
        assert_eq!(at.to_bits(), num(&row["now"]).to_bits());
    }
}
