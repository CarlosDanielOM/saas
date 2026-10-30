#![cfg(feature = "js-unicode17")]
use dima_rust::utils::{js_string::JsString, js_unicode::normalize_nfkd};
use std::borrow::Cow;

#[path = "support/sha256.rs"]
mod digest;

#[test]
fn nfkd_preserves_utf16_barriers_and_canonical_order() {
    for units in [
        vec![],
        vec![65, 66, 67],
        vec![0xd800],
        vec![0xdc00],
        vec![0x0378],
    ] {
        let input = JsString::from_units(units.clone());
        assert!(matches!(normalize_nfkd(&input), Cow::Borrowed(_)));
        assert_eq!(normalize_nfkd(&input).units(), units);
    }
    for (input, expected) in [
        (vec![0xfb03, 0xff21, 0x212a], vec![102, 102, 105, 65, 75]),
        (vec![0x61, 0x0315, 0x0300], vec![0x61, 0x0300, 0x0315]),
        (
            vec![0x61, 0x0315, 0x0378, 0x0300],
            vec![0x61, 0x0315, 0x0378, 0x0300],
        ),
        (
            vec![0x61, 0x0315, 0xd800, 0x0300],
            vec![0x61, 0x0315, 0xd800, 0x0300],
        ),
        (vec![0xd800, 0x0301, 0xdc00], vec![0xd800, 0x0301, 0xdc00]),
        (
            vec![0xd83d, 0xde00, 0x0301, 0x0327],
            vec![0xd83d, 0xde00, 0x0327, 0x0301],
        ),
    ] {
        assert_eq!(
            normalize_nfkd(&JsString::from_units(input)).units(),
            expected
        );
    }
}

#[test]
fn nfkd_utf8_fast_path_respects_borrowing_and_unassigned_barriers() {
    for text in ["ascii", "漢字😀", "a\u{0315}\u{0378}\u{0300}"] {
        let input = JsString::from(text);
        assert!(
            matches!(normalize_nfkd(&input), Cow::Borrowed(_)),
            "{text:?}"
        );
    }
    for (text, expected) in [
        ("ﬃ K", "ffi K"),
        (
            "a\u{0315}\u{0300}\u{0378}b\u{0315}\u{0300}",
            "a\u{0300}\u{0315}\u{0378}b\u{0300}\u{0315}",
        ),
        ("é\u{0378}é", "e\u{0301}\u{0378}e\u{0301}"),
    ] {
        let input = JsString::from(text);
        assert!(matches!(normalize_nfkd(&input), Cow::Owned(_)), "{text:?}");
        assert_eq!(normalize_nfkd(&input).as_str(), Some(expected));
    }
    let input = JsString::from_units(vec![0xd800, 0xfb03, 0xdc00]);
    assert_eq!(
        normalize_nfkd(&input).units(),
        vec![0xd800, 102, 102, 105, 0xdc00]
    );
}

#[test]
#[ignore = "requires independently generated external pinned Node NFKD oracle"]
fn pinned_node_all_scalar_and_mixed_nfkd() {
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let file = PathBuf::from(std::env::var("JS_NFKD_ORACLE").unwrap());
    assert!(
        file.is_absolute()
            && fs::canonicalize(&file).unwrap() == file
            && !file.starts_with(root.parent().unwrap())
    );
    assert!(fs::symlink_metadata(&file).unwrap().file_type().is_file());
    let bytes = fs::read(&file).unwrap();
    let pin = std::env::var("JS_NFKD_ORACLE_SHA256").unwrap();
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
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
    assert_eq!(
        fixture["record"],
        "u32le code point, u16le length, u16le UTF-16 units"
    );
    assert_eq!(fixture["count"], 1_112_064);
    let files = [
        "src/utils/js_unicode.rs",
        "src/utils/js_unicode_data.rs",
        "src/utils/js_string.rs",
        "tests/js_unicode_nfkd.rs",
        "tests/support/sha256.rs",
        "tests/fixtures/js_unicode_nfkd_reference.cjs",
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
    let read_units = |v: &serde_json::Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|n| u16::try_from(n.as_u64().unwrap()).unwrap())
            .collect::<Vec<_>>()
    };
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 14);
    for case in cases {
        assert_eq!(
            normalize_nfkd(&JsString::from_units(read_units(&case["input"]))).units(),
            read_units(&case["output"])
        );
    }
    let chunks = fixture["chunks"].as_array().unwrap();
    assert_eq!(chunks.len(), 272);
    let mut total = 0usize;
    for (index, chunk) in chunks.iter().enumerate() {
        let start = (index as u32) * 0x1000;
        let end = start + 0x1000;
        assert_eq!(chunk["start"], start);
        assert_eq!(chunk["end"], end);
        let mut data = Vec::new();
        let mut count = 0usize;
        for cp in start..end {
            let Some(ch) = char::from_u32(cp) else {
                continue;
            };
            let input = JsString::from(ch.to_string());
            let normalized = normalize_nfkd(&input);
            let units = normalized.units();
            data.extend_from_slice(&cp.to_le_bytes());
            data.extend_from_slice(&u16::try_from(units.len()).unwrap().to_le_bytes());
            for unit in units {
                data.extend_from_slice(&unit.to_le_bytes());
            }
            count += 1;
        }
        total += count;
        assert_eq!(chunk["count"], count);
        assert_eq!(
            chunk["sha256"].as_str().unwrap(),
            digest::sha256_hex(&data),
            "chunk {index}"
        );
    }
    assert_eq!(total, 1_112_064);
}
