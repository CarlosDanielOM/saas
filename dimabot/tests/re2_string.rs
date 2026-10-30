#![cfg(feature = "re2-strings")]

use std::borrow::Cow;
use std::fs;
use std::path::Path;

#[path = "support/sha256.rs"]
mod digest;

use dima_rust::utils::js_string::JsString;
use dima_rust::utils::re2_string::{
    decode_capture, encode_input, encode_pattern, utf16_prefix_len,
};
use serde_json::{Value, json};

#[test]
fn recorded_examples_cover_unpaired_surrogates_and_partial_byte_indices() {
    let normal = JsString::from("A😀é");
    assert!(matches!(encode_pattern(&normal), Cow::Borrowed(_)));
    assert!(matches!(encode_input(&normal), Cow::Borrowed(_)));
    assert_eq!(encode_input(&normal).as_ref(), "A😀é".as_bytes());
    let bad = JsString::from_units(vec![0xd800, 0xd800, 0x41]);
    assert_eq!(
        encode_pattern(&bad).as_ref(),
        &[0xed, 0xa0, 0x80, 0xed, 0xa0, 0x80, 0x41]
    );
    assert_eq!(encode_input(&bad).as_ref(), &[0xef, 0xbf, 0xbd]);
    let lone = JsString::from_units(vec![0xdc00]);
    assert_eq!(encode_pattern(&lone).as_ref(), &[0xed, 0xb0, 0x80]);
    assert!(encode_input(&lone).is_empty());
    let bytes = "😀".as_bytes();
    assert_eq!(utf16_prefix_len(bytes, 0), Some(0));
    assert_eq!(utf16_prefix_len(bytes, 1), Some(2));
    assert_eq!(utf16_prefix_len(bytes, 4), Some(2));
    assert_eq!(utf16_prefix_len(bytes, 5), None);
    assert_eq!(decode_capture(&bytes[..1]).units(), vec![0xfffd]);
}

fn numbers<T: TryFrom<u64>>(v: &Value) -> Vec<T>
where
    T::Error: std::fmt::Debug,
{
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| T::try_from(x.as_u64().unwrap()).unwrap())
        .collect()
}

#[test]
#[ignore = "requires pinned external codec receipt"]
fn replay_pinned_node24_codec_probe() {
    let dir = std::env::var("DIMA_RE2_CODEC_RECEIPT_DIR").expect("receipt directory required");
    let expected = std::env::var("DIMA_RE2_CODEC_RECEIPT_SHA256")
        .expect("independent receipt SHA-256 required");
    const PIN: &str = "a5a92da501dfaa4e78098ee0b8a5e97367cbe7bd1d6dd5dcf0a281c2ed077f31";
    assert_eq!(expected, PIN);
    let dir = Path::new(&dir);
    assert!(dir.is_absolute() && dir.is_dir());
    assert_eq!(dir, dir.canonicalize().unwrap());
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(&root), "external fixture required");
    let bytes = fs::read(dir.join("re2-codec-observations.json")).unwrap();
    assert_eq!(digest::sha256_hex(&bytes), PIN);
    let doc: Value = serde_json::from_slice(&bytes).unwrap();
    let metadata = &doc["metadata"];
    assert_eq!(doc["format"], 1);
    assert_eq!(
        metadata["node"],
        json!({"version":"24.22.1", "abi":"137", "v8":"13.6.233.17-node.58", "icu":"78.3", "unicode":"17.0", "binarySha256":"569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"})
    );
    assert_eq!(
        metadata["sdk"],
        json!({"version":"1.27.0", "sourceSha256": {
        "package.json":"3bc12f3e008781cd558c278365bcc3373aaf6ff0aed18e645f3a8e53e6d5c0db",
        "lib/addon.cc":"947db392a87d64bd1200e522b664986a1b25e38c96d439c64c7fbd6f7b3d0bd6",
        "lib/wrapped_re2.h":"e4b3f23eb963f07d765d8e7ea3ebc650be81e02b782aeceda0fd2c72435e2f28",
        "lib/new.cc":"dcee6f77b7cd82af66f94a66bfb757a5266273fd954e68f97f6e3a5a423a8317"},
        "binarySha256":"94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb"})
    );
    assert_eq!(
        metadata["probe"],
        json!({"cppSha256":"482e52abbfa34ae6efc6d09ba3f1c6190167e4574ccb9f47a1ee8e3bdd745ed5", "jsSha256":"182f3700649887318a5eecdcc490cb53525b9fc1b720d4a00c0e97adbc124c8e", "binarySha256":"4270949a101973cea8bd4768ce26c738e95d7c94c26bb2da0cee29befb8f0846"})
    );
    assert_eq!(metadata["fixture"]["flags"], "du");
    assert_eq!(
        metadata["fixture"]["patterns"],
        json!([".", "\u{fffd}", r"\C"])
    );
    let cases = doc["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 1472);
    for case in cases {
        let units: Vec<u16> = numbers(&case["units"]);
        let value = JsString::from_units(units.clone());
        let pattern = encode_pattern(&value);
        let input = encode_input(&value);
        assert_eq!(
            pattern.as_ref(),
            numbers::<u8>(&case["writeDefault"]),
            "pattern {units:?}"
        );
        assert_eq!(
            input.as_ref(),
            numbers::<u8>(&case["bufferNew"]),
            "input {units:?}"
        );
        assert_eq!(
            value.to_utf8_lossy().as_bytes(),
            numbers::<u8>(&case["bufferFrom"]),
            "Buffer.from {units:?}"
        );
        assert_eq!(
            pattern.len(),
            case["utf8Length"].as_u64().unwrap() as usize,
            "length {units:?}"
        );
        assert_eq!(
            value.len(),
            case["utf16Length"].as_u64().unwrap() as usize,
            "units {units:?}"
        );
        let found = &case["matches"][2];
        if input.is_empty() {
            assert!(found.is_null(), "empty \\C {units:?}");
        } else {
            assert_eq!(found["index"], 0, "index {units:?}");
            assert_eq!(
                decode_capture(&input[..1]).units(),
                numbers::<u16>(&found["captures"][0]),
                "capture {units:?}"
            );
            assert_eq!(
                utf16_prefix_len(&input, 0),
                Some(found["indices"][0][0].as_u64().unwrap() as usize),
                "start {units:?}"
            );
            assert_eq!(
                utf16_prefix_len(&input, 1),
                Some(found["indices"][0][1].as_u64().unwrap() as usize),
                "end {units:?}"
            );
        }
    }
}
