#![cfg(feature = "js-unicode17")]
use dima_rust::utils::{js_string::JsString, js_unicode::lowercase_ascii_bounded};
#[path = "support/sha256.rs"]
mod digest;

#[test]
fn bounded_ascii_projection_covers_expansion_context_and_boundaries() {
    for (text, bound, expected) in [
        ("", 0, Some("")),
        ("A", 0, None),
        ("A", 1, Some("a")),
        ("K", 1, Some("k")),
        ("İ", 2, None),
        ("AΣA", 40, None),
        ("😀", 40, None),
        ("\0", 1, Some("\0")),
        ("AB", 1, None),
    ] {
        assert_eq!(lowercase_ascii_bounded(text, bound).as_deref(), expected);
    }
    assert_eq!(
        lowercase_ascii_bounded(&"K".repeat(40), 40),
        Some("k".repeat(40))
    );
    assert_eq!(lowercase_ascii_bounded(&"K".repeat(41), 40), None);
    let lone = JsString::from_units(vec![0xd800]);
    assert!(lone.as_str().is_none());
}

#[test]
#[ignore = "requires independently generated pinned Node ASCII-lowercase oracle"]
fn pinned_node_all_scalars_and_mixed_boundaries() {
    use std::{
        collections::BTreeMap,
        fs,
        path::{Path, PathBuf},
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let file = PathBuf::from(std::env::var("JS_ASCII_LOWER_ORACLE").unwrap());
    assert!(
        file.is_absolute()
            && fs::canonicalize(&file).unwrap() == file
            && !file.starts_with(root.parent().unwrap())
    );
    assert!(fs::symlink_metadata(&file).unwrap().file_type().is_file());
    let bytes = fs::read(file).unwrap();
    let pin = std::env::var("JS_ASCII_LOWER_ORACLE_SHA256").unwrap();
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(digest::sha256_hex(&bytes), pin);
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["schema"], 1);
    assert_eq!(
        fixture["versions"],
        serde_json::json!({"node":"24.22.1","v8":"13.6.233.17-node.58","icu":"78.3","unicode":"17.0"})
    );
    assert_eq!(
        fixture["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(fixture["count"], 1_112_064);
    let files = [
        "src/utils/js_unicode.rs",
        "src/utils/js_unicode_data.rs",
        "src/utils/js_string.rs",
        "src/schemas/channel_fish_voice_favorites.schema.rs",
        "tests/js_unicode_ascii_lower.rs",
        "tests/channel_fish_voice_favorites.rs",
        "tests/support/sha256.rs",
        "tests/fixtures/js_unicode_ascii_lower_reference.cjs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
    ];
    assert_eq!(fixture["hashes"].as_object().unwrap().len(), files.len());
    for file in files {
        assert_eq!(
            fixture["hashes"][file].as_str().unwrap(),
            digest::sha256_hex(&fs::read(root.join(file)).unwrap())
        );
    }
    let mut expected = BTreeMap::new();
    for item in fixture["scalars"].as_array().unwrap() {
        let cp = u32::try_from(item["cp"].as_u64().unwrap()).unwrap();
        assert!(
            expected
                .insert(cp, item["output"].as_str().unwrap())
                .is_none()
        );
    }
    let mut seen = 0usize;
    let mut matching = 0usize;
    for cp in 0..=0x10ffff_u32 {
        let Some(ch) = char::from_u32(cp) else {
            continue;
        };
        seen += 1;
        let value = lowercase_ascii_bounded(&ch.to_string(), 40);
        assert_eq!(value.as_deref(), expected.get(&cp).copied(), "U+{cp:04X}");
        if value.is_some() {
            matching += 1;
        }
    }
    assert_eq!(seen, 1_112_064);
    assert_eq!(matching, expected.len());
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 76);
    for case in cases {
        let units = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
            .collect();
        let input = JsString::from_units(units);
        assert_eq!(case["wellFormed"], input.as_str().is_some());
        let result = input.as_str().and_then(|text| {
            lowercase_ascii_bounded(text, case["bound"].as_u64().unwrap() as usize)
        });
        assert_eq!(result.as_deref(), case["output"].as_str());
    }
}
