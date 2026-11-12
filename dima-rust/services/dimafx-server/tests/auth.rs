#![allow(clippy::unwrap_used)]
use dima_core::{
    SecretBytes,
    crypto::{digest::hmac_sha256, encoding::encode_base64url},
};
use dimafx_server::auth::{decode, keys, verify};
use serde_json::{Value, json};
fn token(payload: Value, key: &[u8], alg: &str) -> String {
    let signed = format!(
        "{}.{}",
        encode_base64url(json!({"alg":alg}).to_string().as_bytes()),
        encode_base64url(payload.to_string().as_bytes())
    );
    format!(
        "{signed}.{}",
        hmac_sha256(&SecretBytes::new(key.to_vec()), &signed).base64url()
    )
}
#[test]
fn node_lenient_base64_table() {
    let table: Value = serde_json::from_str(include_str!("node-base64.json")).unwrap();
    for case in table["cases"].as_array().unwrap() {
        let bytes = decode(case["input"].as_str().unwrap());
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["base64"]);
        assert_eq!(hex, case["base64url"]);
    }
}
#[test]
fn candidates_gating_expiry_and_constant_time_verification() {
    let candidates = keys("c2VjcmV0");
    assert_eq!(candidates.len(), 2);
    for key in [b"secret".as_slice(), b"c2VjcmV0".as_slice()] {
        let jwt = token(json!({"channel_id":"c","exp":2}), key, "HS256");
        assert!(verify(&jwt, &candidates, false, 2000).is_some());
        assert!(verify(&jwt, &candidates, false, 2001).is_none());
    }
    for exp in [json!(0), json!("bad"), Value::Null] {
        assert!(
            verify(
                &token(json!({"channel_id":"c","exp":exp}), b"secret", "HS256"),
                &candidates,
                false,
                9000
            )
            .is_some()
        );
    }
    for (key, alg, payload) in [
        (b"bad".as_slice(), "HS256", json!({"channel_id":"c"})),
        (b"secret", "none", json!({"channel_id":"c"})),
        (b"secret", "HS256", json!({})),
    ] {
        assert!(verify(&token(payload, key, alg), &candidates, true, 0).is_none());
    }
    let unsigned = format!("x.{}", encode_base64url(br#"{"channel_id":"c","exp":1}"#));
    assert!(verify(&unsigned, &[], true, 9999).is_some());
    assert!(verify(&unsigned, &[], false, 0).is_none());
    assert!(verify(&unsigned, &candidates, true, 0).is_none());
    // Guard the primitive choice as well as its rejection behaviour (not a timing benchmark).
    assert!(include_str!("../src/auth.rs").contains("constant_time_eq(hmac_sha256"));
}
