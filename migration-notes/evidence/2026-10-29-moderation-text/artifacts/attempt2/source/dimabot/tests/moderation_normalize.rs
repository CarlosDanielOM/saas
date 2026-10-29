#![cfg(feature = "moderation-normalize")]

use dima_rust::utils::{
    js_string::JsString,
    moderation::normalize::{escape_reg_exp, fold_text},
};
use serde_json::Value;
use std::{borrow::Cow, path::PathBuf};

// Independent raw-byte hash helper, reused from examples/ast_evaluator_bench.rs.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[index] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let a = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let b = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let x = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(x);
            d = c;
            c = b;
            b = a;
            a = x.wrapping_add(y);
        }
        for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(word);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("UTF-16 unit array")
        .iter()
        .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
        .collect()
}

#[test]
fn typed_boundary_borrows_and_preserves_utf16() {
    let plain = JsString::from_static("safe /,-_");
    assert!(matches!(escape_reg_exp(&plain), Cow::Borrowed(_)));
    assert!(matches!(fold_text(Some(&plain)), Cow::Borrowed(_)));
    assert_eq!(fold_text(None).units(), Vec::<u16>::new());
    let input = JsString::from_units(vec![
        0,
        0xd800,
        b'.' as u16,
        0xdc00,
        0xd83d,
        0xde00,
        b'\\' as u16,
    ]);
    assert_eq!(
        escape_reg_exp(&input).units(),
        vec![
            0,
            0xd800,
            b'\\' as u16,
            b'.' as u16,
            0xdc00,
            0xd83d,
            0xde00,
            b'\\' as u16,
            b'\\' as u16
        ]
    );
    assert_eq!(
        fold_text(Some(&JsString::from("CAFÉ"))).as_str(),
        Some("cafe")
    );
}

#[test]
#[ignore = "requires pinned actual-TypeScript external fixture"]
fn replay_actual_normalize_exports() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_MODERATION_NORMALIZE_FIXTURE_DIR")
            .expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(&root));
    let expected_hash = std::env::var("DIMA_MODERATION_NORMALIZE_FIXTURE_SHA256")
        .expect("independently verified fixture SHA-256 required");
    assert_eq!(expected_hash.len(), 64);
    assert!(
        expected_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join("moderation-normalize-reference.json")).unwrap();
    assert_eq!(sha256_hex(&bytes), expected_hash);
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["format"], 1);
    assert_eq!(fixture["implementation"], "actual-typescript");
    assert_eq!(
        fixture["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, expected) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(fixture["versions"][key], expected);
    }
    let files = [
        (
            "src/utils/moderation/normalize.ts",
            include_bytes!("../src/utils/moderation/normalize.ts").as_slice(),
        ),
        (
            "src/utils/moderation/normalize.rs",
            include_bytes!("../src/utils/moderation/normalize.rs").as_slice(),
        ),
        (
            "src/utils/js_unicode.rs",
            include_bytes!("../src/utils/js_unicode.rs").as_slice(),
        ),
        (
            "src/utils/js_unicode_data.rs",
            include_bytes!("../src/utils/js_unicode_data.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
        ),
        (
            "tests/moderation_normalize.rs",
            include_bytes!("moderation_normalize.rs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml").as_slice(),
        ),
        ("package.json", include_bytes!("../package.json").as_slice()),
        (
            "package-lock.json",
            include_bytes!("../package-lock.json").as_slice(),
        ),
        (
            "oracle-script",
            include_bytes!("fixtures/moderation_normalize_reference.cjs").as_slice(),
        ),
    ];
    for (key, bytes) in files {
        assert_eq!(
            sha256_hex(bytes),
            fixture["sourceSha256"][key].as_str().unwrap(),
            "source hash {key}"
        );
    }
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 220);
    for (index, case) in cases.iter().enumerate() {
        let input = JsString::from_units(units(&case["input"]));
        let folded = fold_text(Some(&input));
        assert_eq!(folded.units(), units(&case["fold"]), "fold case {index}");
        assert_eq!(
            folded.to_json_string(),
            case["foldJson"].as_str().unwrap(),
            "fold JSON case {index}"
        );
        let escaped = escape_reg_exp(&input);
        assert_eq!(
            escaped.units(),
            units(&case["escape"]),
            "escape case {index}"
        );
        assert_eq!(
            escaped.to_json_string(),
            case["escapeJson"].as_str().unwrap(),
            "escape JSON case {index}"
        );
    }
    let nullish = fixture["nullish"].as_array().unwrap();
    assert_eq!(nullish.len(), 2);
    assert_eq!(nullish[0]["kind"], "null");
    assert_eq!(nullish[1]["kind"], "undefined");
    for case in nullish {
        let actual = fold_text(None);
        assert_eq!(actual.units(), units(&case["fold"]));
        assert_eq!(actual.to_json_string(), case["foldJson"].as_str().unwrap());
    }
}
