#![cfg(feature = "js-unicode17")]

#[path = "support/moderation_leaf_source.rs"]
mod moderation_leaf_source;

use dima_rust::utils::{
    js_string::JsString,
    js_unicode::{fold_text, lowercase},
};
use serde_json::Value;
use std::{borrow::Cow, collections::HashMap, path::PathBuf};
use unicode_normalization::{
    UnicodeNormalization,
    char::{canonical_combining_class, decompose_canonical},
};

#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../src/utils/js_unicode_data.rs"]
mod unicode17_data;

fn property_contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    let i = ranges.partition_point(|&(first, _)| first <= cp);
    i != 0 && cp <= ranges[i - 1].1
}

#[test]
fn every_assigned_decomposition_nonstarter_is_removed() {
    assert_eq!(unicode_normalization::UNICODE_VERSION, (18, 0, 0));
    let mut assigned = 0usize;
    let mut nonstarters = 0usize;
    for cp in 0..=0x10ffff {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        if !property_contains(unicode17_data::ASSIGNED_RANGES, cp) {
            continue;
        }
        assigned += 1;
        decompose_canonical(c, |part| {
            if canonical_combining_class(part) != 0 {
                nonstarters += 1;
                assert!(
                    property_contains(unicode17_data::MARK_RANGES, part as u32),
                    "U+{cp:04X} decomposes to retained nonstarter U+{:04X}",
                    part as u32
                );
            }
        });
    }
    assert!(assigned > 250_000 && nonstarters > 1_000);
}

// Independently retain the original segmented NFD ordering path for sequence
// checks; lowercasing itself has separate exhaustive Node reference coverage.
fn ordered_nfd_fold(value: &JsString) -> JsString {
    fn flush(run: &mut String, units: &mut Vec<u16>) {
        for c in run
            .nfd()
            .filter(|c| !property_contains(unicode17_data::MARK_RANGES, *c as u32))
        {
            let mut buf = [0; 2];
            units.extend_from_slice(c.encode_utf16(&mut buf));
        }
        run.clear();
    }
    let mut run = String::new();
    let mut units = Vec::new();
    for item in char::decode_utf16(value.code_units()) {
        match item {
            Ok(c) if property_contains(unicode17_data::ASSIGNED_RANGES, c as u32) => run.push(c),
            Ok(c) => {
                flush(&mut run, &mut units);
                let mut buf = [0; 2];
                units.extend_from_slice(c.encode_utf16(&mut buf));
            }
            Err(e) => {
                flush(&mut run, &mut units);
                units.push(e.unpaired_surrogate());
            }
        }
    }
    flush(&mut run, &mut units);
    let stripped = JsString::from_units(units);
    lowercase(&stripped).into_owned()
}

#[test]
fn sequences_match_ordered_nfd_and_utf16_barriers() {
    let fragments: &[&[u16]] = &[
        &[0x0041],
        &[0x03a3],
        &[0x0345],
        &[0x0301],
        &[0x0327],
        &[0x0903],
        &[0x00c5],
        &[0x0130],
        &[0xac01],
        &[0x1ade],
        &[0x1adf],
        &[0xd801],
        &[0xdc00],
        &[0xd83d, 0xde00],
        &[0x0021],
    ];
    for first in fragments {
        for second in fragments {
            for third in fragments {
                let units = [*first, *second, *third].concat();
                let input = JsString::from_units(units.clone());
                assert_eq!(
                    fold_text(&input).as_ref(),
                    &ordered_nfd_fold(&input),
                    "UTF-16 input {units:04x?}"
                );
            }
        }
    }
    let input = JsString::from_units(vec![0xd801, 0x0301, 0xdc00]);
    assert_eq!(fold_text(&input).units(), vec![0xd801, 0xdc28]);
    let unchanged = JsString::from_static("lower 中文 😀");
    assert!(matches!(fold_text(&unchanged), Cow::Borrowed(_)));
}

// Same independent raw-byte SHA-256 helper used by ast_evaluator_bench.rs.
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
        .expect("unit array")
        .iter()
        .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
        .collect()
}
fn point_units(cp: u32) -> Vec<u16> {
    if (0xd800..=0xdfff).contains(&cp) {
        return vec![cp as u16];
    }
    char::from_u32(cp)
        .unwrap()
        .encode_utf16(&mut [0; 2])
        .to_vec()
}
fn scalar_map(value: &Value, code_points: bool) -> HashMap<u32, Vec<u16>> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let cp = row[0].as_u64().unwrap() as u32;
            let out = if code_points {
                row[1]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|v| point_units(v.as_u64().unwrap() as u32))
                    .collect()
            } else {
                units(&row[1])
            };
            (cp, out)
        })
        .collect()
}
fn fixture(dir_env: &str, filename: &str, hash_env: &str) -> Value {
    let dir = PathBuf::from(
        std::env::var_os(dir_env).expect("explicit external fixture directory required"),
    );
    assert!(dir.is_absolute());
    let canonical = dir.canonicalize().unwrap();
    assert_eq!(dir, canonical);
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!canonical.starts_with(source));
    let expected = std::env::var(hash_env).expect("explicit SHA-256 pin required");
    assert_eq!(expected.len(), 64);
    assert!(
        expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join(filename)).unwrap();
    assert_eq!(sha256_hex(&bytes), expected);
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn borrowed_ascii_and_lossless_context() {
    // These points are unassigned in the Node 17 table but have nonzero
    // combining class in the dependency's later normalization tables.
    assert_ne!(
        unicode_normalization::char::canonical_combining_class('\u{1ade}'),
        0
    );
    assert_ne!(
        unicode_normalization::char::canonical_combining_class('\u{1adf}'),
        0
    );
    let unchanged = JsString::from_static("lower 123 !");
    assert!(matches!(lowercase(&unchanged), Cow::Borrowed(_)));
    assert!(matches!(fold_text(&unchanged), Cow::Borrowed(_)));
    for (input, expected) in [
        ("A\u{0345}Σ", "a\u{0345}ς"),
        ("\u{0345}Σ", "\u{0345}σ"),
        ("AΣ\u{0345}A", "aσ\u{0345}a"),
    ] {
        assert_eq!(lowercase(&JsString::from(input)).as_str(), Some(expected));
    }
    assert_eq!(
        fold_text(&JsString::from("Café İ A\u{0345}Σ")).as_str(),
        Some("cafe i aς")
    );
    let mixed = JsString::from_units(vec![0xd800, b'A' as u16, 0x03a3, 0xdc00]);
    assert_eq!(
        lowercase(&mixed).units(),
        vec![0xd800, b'a' as u16, 0x03c2, 0xdc00]
    );
    assert_eq!(
        fold_text(&mixed).units(),
        vec![0xd800, b'a' as u16, 0x03c2, 0xdc00]
    );
    let joined = JsString::from_units(vec![0xd801, 0x0301, 0xdc00]);
    assert_eq!(fold_text(&joined).units(), vec![0xd801, 0xdc28]);
}

#[test]
#[ignore = "requires pinned external Node-generated reference artifacts"]
fn replay_node_unicode17_and_actual_source() {
    const DATA_HASH: &str = "07f5dec8895f155a91f2bc7807a028dca7af308638091cc60bd5edd85f16c0a5";
    const RUST_HASH: &str = "6c9529a54bd192de38852f31421383d3295dc9010ca463037b6383e361040aeb";
    let data = fixture(
        "DIMA_JS_UNICODE_DATA_DIR",
        "unicode17-reference.json",
        "DIMA_JS_UNICODE_DATA_SHA256",
    );
    assert_eq!(
        std::env::var("DIMA_JS_UNICODE_DATA_SHA256").unwrap(),
        DATA_HASH
    );
    assert_eq!(
        sha256_hex(include_bytes!("../src/utils/js_unicode_data.rs")),
        RUST_HASH
    );
    assert_eq!(data["generatedRustSha256"], RUST_HASH);
    assert_eq!(data["counts"]["lowercaseMappings"], 1488);
    assert_eq!(data["counts"]["nfdMappings"], 13253);
    assert_eq!(data["counts"]["contextualGoldens"], 6432);
    let source = fixture(
        "DIMA_JS_UNICODE_SOURCE_DIR",
        "js-unicode-source-reference.json",
        "DIMA_JS_UNICODE_SOURCE_SHA256",
    );
    assert_eq!(source["implementation"], "actual-typescript");
    assert_eq!(source["format"], 1);
    assert_eq!(source["versions"], data["versions"]);
    assert_eq!(source["nodeExecutableSha256"], data["nodeExecutableSha256"]);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for path in [
        "src/utils/moderation/normalize.ts",
        "package.json",
        "package-lock.json",
        "rust-toolchain.toml",
    ] {
        assert_eq!(
            sha256_hex(&std::fs::read(moderation_leaf_source::path(&root, path)).unwrap()),
            source["sourceSha256"][path].as_str().unwrap()
        );
        assert_eq!(source["sourceSha256"][path], data["sourceSha256"][path]);
    }
    for key in [
        "typescript-resolved-js",
        "typescript-package.json",
        "normalize-canonical-declarations",
    ] {
        assert_eq!(source["sourceSha256"][key], data["sourceSha256"][key]);
    }
    assert_eq!(
        sha256_hex(include_bytes!("fixtures/js_unicode_reference.cjs")),
        source["sourceSha256"]["oracle-script"].as_str().unwrap()
    );
    let lower = scalar_map(&data["lowercaseMappings"], true);
    assert_eq!(lower.len(), 1488);
    let folds = scalar_map(&source["scalarFolds"], false);
    assert_eq!(folds.len(), source["scalarFolds"].as_array().unwrap().len());
    for cp in 0..=0x10ffff {
        let input = point_units(cp);
        let value = JsString::from_units(input.clone());
        assert_eq!(
            lowercase(&value).units(),
            lower.get(&cp).unwrap_or(&input).clone(),
            "lower U+{cp:04X}"
        );
        assert_eq!(
            fold_text(&value).units(),
            folds.get(&cp).unwrap_or(&input).clone(),
            "fold U+{cp:04X}"
        );
    }
    let contexts = data["contextualGoldens"].as_array().unwrap();
    assert_eq!(contexts.len(), 6432);
    for case in contexts {
        assert_eq!(
            lowercase(&JsString::from_units(units(&case["input"]))).units(),
            units(&case["lower"]),
            "context {case}"
        );
    }
    let cases = source["cases"].as_array().unwrap();
    assert!(cases.len() >= 19);
    for case in cases {
        let value = JsString::from_units(units(&case["input"]));
        assert_eq!(lowercase(&value).units(), units(&case["lower"]));
        assert_eq!(fold_text(&value).units(), units(&case["fold"]));
    }
}
