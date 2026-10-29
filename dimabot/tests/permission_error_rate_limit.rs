#![cfg(feature = "permissions")]
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
    let dir = std::env::var("PERMISSION_ERROR_REFERENCE_DIR").expect("external oracle directory");
    let raw = std::fs::read(
        std::path::Path::new(&dir).join("permission_error_rate_limit_reference.json"),
    )
    .unwrap();
    let oracle: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(oracle["metadata"]["node"], "v24.22.1");
    assert_eq!(oracle["metadata"]["v8"], "13.6.233.17-node.58");
    assert_eq!(oracle["metadata"]["typescript"], "5.9.3");
    let operations = oracle["operations"].as_array().unwrap();
    let results = oracle["results"].as_array().unwrap();
    assert_eq!(operations.len(), results.len());
    assert!(operations.len() > 2000);
    let mut l = PermissionErrorLimiter::new();
    for (op, expected) in operations.iter().zip(results) {
        assert_eq!(
            l.should_log(&units(&op["key"]), num(&op["now"]), num(&op["interval"])),
            expected.as_bool().unwrap()
        );
    }
    let actual = l.snapshot();
    let state = oracle["state"].as_array().unwrap();
    assert_eq!(actual.len(), state.len());
    for ((key, at), row) in actual.iter().zip(state) {
        assert_eq!(*key, units(&row["key"]));
        assert_eq!(at.to_bits(), num(&row["now"]).to_bits());
    }
}
