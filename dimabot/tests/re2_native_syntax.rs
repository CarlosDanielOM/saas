#![cfg(feature = "re2-native")]

use dima_rust::utils::{
    js_string::JsString,
    re2_native::{CompileError, Re2Native},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;

#[path = "support/sha256.rs"]
mod digest;

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("UTF-16 array")
        .iter()
        .map(|v| u16::try_from(v.as_u64().expect("UTF-16 unit")).expect("unit in range"))
        .collect()
}

/// An external, independently hashed direct-SDK corpus; no complete parity claim.
#[test]
#[ignore = "requires externally generated pinned Node 24 source-built RE2 fixture"]
fn replay_native_syntax_oracle() {
    let name = std::env::var("DIMA_RE2_SYNTAX_REFERENCE").expect("absolute reference path");
    let supplied_hash =
        std::env::var("DIMA_RE2_SYNTAX_REFERENCE_SHA256").expect("independent SHA-256");
    assert!(
        supplied_hash.len() == 64
            && supplied_hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    );
    let path = Path::new(&name);
    assert!(path.is_absolute(), "reference path must be absolute");
    let canonical = path.canonicalize().expect("reference file");
    assert_eq!(path, canonical, "reference path must be canonical");
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(
        !canonical.starts_with(source_root),
        "reference must be external"
    );
    let bytes = std::fs::read(canonical).expect("reference bytes");
    assert!(bytes.len() <= 8 * 1024 * 1024, "fixture byte budget");
    assert_eq!(digest::sha256_hex(&bytes), supplied_hash, "fixture digest");
    let doc: Value = serde_json::from_slice(&bytes).expect("fixture JSON");
    let meta = &doc["metadata"];
    assert_eq!(meta["format"], 1);
    assert_eq!(meta["node"]["version"], "24.22.1");
    assert_eq!(meta["node"]["abi"], "137");
    assert_eq!(
        meta["node"]["sha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(meta["runtime"]["kind"], "node24-fixture");
    assert_eq!(meta["runtime"]["sourceFileCount"], 1762);
    assert_eq!(
        meta["runtime"]["loadedBinarySha256"],
        "94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb"
    );
    assert_eq!(
        meta["runtime"]["sourceManifestSha256"],
        "e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664"
    );
    assert_eq!(
        meta["runtime"]["buildProvenanceSha256"],
        "4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c"
    );
    assert_eq!(
        meta["loaderSha256"],
        "5263edb4c997171c2e172e9d4c47093126a0d6146ff37ad432dac100865b52c2"
    );
    assert_eq!(
        meta["readerSha256"],
        "a78faddee60390868b5d56d5c5bce4d4baf6a9df12103327f9f89e2548217eb5"
    );
    assert_eq!(
        meta["pins"]["src/utils/moderation/advanced.ts"],
        "e88c52a8662a1531bdca981129e91f9cfe3b84c2543f11d38584652aede8a4d7"
    );
    assert_eq!(
        meta["pins"]["node_modules/re2/lib/new.cc"],
        "dcee6f77b7cd82af66f94a66bfb757a5266273fd954e68f97f6e3a5a423a8317"
    );
    let cases = doc["cases"].as_array().expect("cases");
    assert!((2000..=5000).contains(&cases.len()));
    assert_eq!(meta["total"].as_u64().unwrap() as usize, cases.len());
    let mut counts: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut mismatches = Vec::new();
    // Cases are grouped by source with two case modes. Bound the replay cache
    // to those two compilations rather than rebuilding for each input string.
    type Cached = ((Vec<u16>, bool), Result<Re2Native, CompileError>);
    let mut recent = VecDeque::<Cached>::with_capacity(2);
    for (index, case) in cases.iter().enumerate() {
        let category = case["category"].as_str().expect("category");
        let source = units(&case["source"]);
        let input = units(&case["text"]);
        assert!(source.len() <= 250 && input.len() <= 32);
        let ignore_case = case["ignoreCase"].as_bool().expect("case flag");
        let key = (source.clone(), ignore_case);
        let compiled = if let Some(value) = recent
            .iter()
            .find(|(known, _)| known == &key)
            .map(|(_, value)| value.clone())
        {
            value
        } else {
            let value =
                Re2Native::compile(&JsString::from_units(source.clone()), ignore_case, true);
            if recent.len() == 2 {
                recent.pop_front();
            }
            recent.push_back((key, value.clone()));
            value
        };
        let actual = match compiled {
            Err(_) => json!({"compiled":false}),
            Ok(re) => {
                let found = re.exec(&JsString::from_units(input.clone())).map(|m| {
                    let captures: Vec<_> = m
                        .captures
                        .iter()
                        .map(|c| c.as_ref().map(|c| c.text.units()))
                        .collect();
                    let indices: Vec<_> = m
                        .captures
                        .iter()
                        .map(|c| c.as_ref().map(|c| [c.start, c.end]))
                        .collect();
                    json!({"index":m.index,"captures":captures,"indices":indices})
                });
                json!({"compiled":true,"match":found})
            }
        };
        let entry = counts.entry(category.to_owned()).or_default();
        entry.0 += 1;
        if actual == case["result"] {
            entry.1 += 1;
        } else {
            mismatches.push(format!("{category}[{index}] source={source:?} text={input:?} i={ignore_case} expected={} actual={actual}", case["result"]));
        }
    }
    assert_eq!(meta["counts"].as_object().unwrap().len(), counts.len());
    for (category, (total, passed)) in &counts {
        assert_eq!(
            meta["counts"][category.as_str()].as_u64().unwrap() as usize,
            *total
        );
        eprintln!("{category}: {passed}/{total}");
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
