#![cfg(feature = "re2-unicode")]

#[path = "support/sha256.rs"]
mod digest;

use dima_rust::utils::re2_unicode::{
    Namespace, equivalents, fold_next, lookup, properties, resolve_braced,
};
use serde_json::Value;
use std::path::{Component, Path};

#[test]
fn namespaces_and_native_cycles() {
    for (namespace, count) in [
        (Namespace::Builtin, 200),
        (Namespace::Binary, 98),
        (Namespace::ScriptExtensions, 342),
    ] {
        assert_eq!(properties(namespace).len(), count);
        let names: Vec<_> = properties(namespace).map(|p| p.name).collect();
        assert!(names.windows(2).all(|p| p[0] < p[1]));
        for property in properties(namespace) {
            assert_eq!(
                lookup(namespace, property.name).unwrap().ranges,
                property.ranges
            );
            assert!(!property.contains(0x110000));
            assert!(!property.contains(u32::MAX));
        }
    }
    assert!(lookup(Namespace::Builtin, "Cs").unwrap().contains(0xd800));
    assert!(lookup(Namespace::Builtin, "Any").unwrap().contains(0xdfff));
    assert!(!lookup(Namespace::Builtin, "L").unwrap().contains(0x11db0));
    assert!(!lookup(Namespace::Builtin, "L").unwrap().contains(0xa7cb));
    assert!(!lookup(Namespace::Builtin, "L").unwrap().contains(0x1c8a));
    assert!(
        lookup(Namespace::Binary, "Alphabetic")
            .unwrap()
            .contains(0x11db0)
    );
    assert!(
        resolve_braced("Script_Extensions=Tolong_Siki")
            .unwrap()
            .property
            .contains(0x11db0)
    );
    assert_eq!(
        resolve_braced("gc=Letter").unwrap().property.namespace,
        Namespace::Builtin
    );
    assert_eq!(
        resolve_braced("gc=Alphabetic").unwrap().property.namespace,
        Namespace::Binary
    );
    assert!(resolve_braced("Script=Latin").is_some());
    assert!(resolve_braced("Script=Latn").is_none());
    assert!(resolve_braced("scx=Latn").is_some());
    assert!(resolve_braced("letter").is_none());
    assert!(resolve_braced("^L").unwrap().inverted);
    assert!(resolve_braced("^Letter").is_none());
    assert_eq!(equivalents(0x4b).collect::<Vec<_>>(), [0x4b, 0x6b, 0x212a]);
    assert_eq!(
        equivalents(0x3a3).collect::<Vec<_>>(),
        [0x3a3, 0x3c2, 0x3c3]
    );
    assert_eq!(equivalents(0x264).collect::<Vec<_>>(), [0x264]);
    for cp in [0x130, 0x131, 0xd800, 0xdfff, 0x110000, u32::MAX] {
        assert_eq!(fold_next(cp), cp);
        let mut iter = equivalents(cp);
        assert_eq!(iter.next(), Some(cp));
        assert_eq!(iter.next(), None);
        assert_eq!(iter.next(), None);
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn pairs(value: &Value) -> Vec<(u32, u32)> {
    value
        .as_array()
        .expect("pair array")
        .iter()
        .map(|v| {
            let row = v.as_array().expect("pair");
            assert_eq!(row.len(), 2);
            let a = u32::try_from(row[0].as_u64().expect("unsigned bound")).unwrap();
            let b = u32::try_from(row[1].as_u64().expect("unsigned bound")).unwrap();
            assert!(a <= 0x10ffff && b <= 0x10ffff);
            (a, b)
        })
        .collect()
}

fn in_ranges(ranges: &[(u32, u32)], cp: u32) -> bool {
    let i = ranges.partition_point(|&(_, hi)| hi < cp);
    ranges.get(i).is_some_and(|&(lo, _)| lo <= cp)
}

fn namespace(name: &str) -> Namespace {
    match name {
        "builtin" => Namespace::Builtin,
        "binary" => Namespace::Binary,
        "scriptExtensions" => Namespace::ScriptExtensions,
        _ => panic!("unknown namespace {name}"),
    }
}

#[test]
#[ignore = "requires independently hashed external actual-SDK reference"]
fn external_cpp_facts_and_sdk_checks_replay() {
    let fixture_dir =
        std::env::var_os("DIMA_RE2_UNICODE_FIXTURE_DIR").expect("fixture directory required");
    let dir = Path::new(&fixture_dir);
    assert!(dir.is_absolute());
    assert_eq!(dir, dir.canonicalize().unwrap());
    assert!(dir.is_dir());
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(&root), "external fixture required");
    let hash = std::env::var("DIMA_RE2_UNICODE_FIXTURE_SHA256")
        .expect("independent fixture SHA-256 required");
    assert!(valid_digest(&hash));
    let bytes = std::fs::read(dir.join("re2-unicode-reference.json")).unwrap();
    assert_eq!(digest::sha256_hex(&bytes), hash);
    let doc: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(doc["format"], 1);
    assert_eq!(doc["sdkVersion"], "1.27.0");
    assert!(doc["nativeUnicodeVersion"].is_null());
    assert_eq!(doc["wrapperUnicodeVersion"], "17.0.0");
    assert_eq!(
        doc["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, expected) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("modules", "137"),
    ] {
        assert_eq!(doc["versions"][key], expected);
    }
    assert_eq!(doc["runtime"]["kind"], "node24-fixture");
    assert_eq!(doc["runtime"]["sourceFileCount"], 1762);
    assert_eq!(
        doc["runtime"]["loadedBinarySha256"],
        "94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb"
    );
    assert_eq!(
        doc["runtime"]["sourceManifestSha256"],
        "e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664"
    );
    assert_eq!(
        doc["runtime"]["buildProvenanceSha256"],
        "4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c"
    );
    let hashes = doc["hashes"].as_object().unwrap();
    assert_eq!(hashes.len(), 11);
    for (name, hash) in hashes {
        let relative = Path::new(name);
        assert!(
            !name.is_empty()
                && relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
        );
        let full = root.join(relative).canonicalize().unwrap();
        assert!(full.starts_with(&root) && full.is_file());
        let hash = hash.as_str().unwrap();
        assert!(valid_digest(hash));
        assert_eq!(
            digest::sha256_hex(&std::fs::read(full).unwrap()),
            hash,
            "source {name}"
        );
    }
    let sdk_dir = std::env::var_os("DIMA_RE2_UNICODE_SDK_SOURCE_DIR")
        .expect("external pinned SDK source directory required");
    let sdk_dir = Path::new(&sdk_dir);
    assert!(sdk_dir.is_absolute() && sdk_dir.is_dir());
    assert_eq!(sdk_dir, sdk_dir.canonicalize().unwrap());
    assert!(!sdk_dir.starts_with(&root), "external SDK sources required");
    let source_pins = doc["sourcePins"].as_object().unwrap();
    assert_eq!(source_pins.len(), 9);
    for (name, hash) in source_pins {
        let relative = Path::new(name);
        assert!(
            relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        );
        let full = sdk_dir.join(relative).canonicalize().unwrap();
        assert!(full.starts_with(sdk_dir) && full.is_file());
        let hash = hash.as_str().unwrap();
        assert!(valid_digest(hash));
        assert_eq!(
            digest::sha256_hex(&std::fs::read(full).unwrap()),
            hash,
            "SDK source {name}"
        );
    }
    let generated = std::fs::read(root.join("src/utils/re2_unicode_data.rs")).unwrap();
    assert_eq!(
        digest::sha256_hex(&generated),
        doc["generatedRustSha256"].as_str().unwrap()
    );
    for (name, count) in [("builtin", 200), ("binary", 98), ("scriptExtensions", 342)] {
        let entries = doc["tables"][name].as_array().unwrap();
        assert_eq!(entries.len(), count);
        let actual_names: Vec<_> = properties(namespace(name)).map(|p| p.name).collect();
        let golden_names: Vec<_> = entries
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect();
        assert_eq!(actual_names, golden_names);
        for row in entries {
            let property = lookup(namespace(name), row["name"].as_str().unwrap()).unwrap();
            let ranges = pairs(&row["ranges"]);
            assert!(ranges.iter().all(|&(lo, hi)| lo <= hi));
            assert!(ranges.windows(2).all(|p| p[0].1 < p[1].0));
            assert_eq!(property.ranges, ranges);
            for &(lo, hi) in &ranges {
                for cp in [
                    lo.saturating_sub(1),
                    lo,
                    lo.saturating_add(1),
                    hi.saturating_sub(1),
                    hi,
                    hi.saturating_add(1),
                ] {
                    assert_eq!(
                        property.contains(cp),
                        cp <= 0x10ffff && in_ranges(&ranges, cp)
                    );
                }
            }
        }
    }
    for check in doc["propertyChecks"].as_array().unwrap() {
        let property = lookup(
            namespace(check["namespace"].as_str().unwrap()),
            check["name"].as_str().unwrap(),
        )
        .unwrap();
        for cp in check["points"].as_array().unwrap() {
            let cp = u32::try_from(cp.as_u64().unwrap()).unwrap();
            assert!(
                char::from_u32(cp).is_some(),
                "SDK checks must use representable scalars"
            );
            assert_eq!(property.contains(cp), in_ranges(property.ranges, cp));
        }
    }
    for check in doc["resolutionChecks"].as_array().unwrap() {
        let actual = resolve_braced(check["name"].as_str().unwrap());
        if check["expected"].is_null() {
            assert!(actual.is_none(), "{check}");
        } else {
            let expected = check["expected"].as_array().unwrap();
            let actual = actual.unwrap();
            assert_eq!(
                actual.property.namespace,
                namespace(expected[0].as_str().unwrap())
            );
            assert_eq!(actual.property.name, expected[1].as_str().unwrap());
            assert_eq!(actual.inverted, expected[2].as_bool().unwrap());
        }
    }
    let fold_pairs = pairs(&doc["foldPairs"]);
    assert_eq!(fold_pairs.len(), 2884);
    assert!(fold_pairs.windows(2).all(|p| p[0].0 < p[1].0));
    for cp in 0..=0x10ffff {
        let expected = fold_pairs
            .binary_search_by_key(&cp, |&(source, _)| source)
            .map_or(cp, |i| fold_pairs[i].1);
        assert_eq!(fold_next(cp), expected, "fold U+{cp:04X}");
    }
    let cycles = doc["foldCycles"].as_array().unwrap();
    assert_eq!(cycles.len(), 1427);
    let mut members = std::collections::BTreeSet::new();
    for cycle in cycles {
        let cycle: Vec<u32> = cycle
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u32::try_from(v.as_u64().unwrap()).unwrap())
            .collect();
        assert!((2..=4).contains(&cycle.len()));
        for (i, &member) in cycle.iter().enumerate() {
            assert!(members.insert(member));
            assert_eq!(
                equivalents(member).collect::<Vec<_>>(),
                cycle[i..]
                    .iter()
                    .chain(cycle[..i].iter())
                    .copied()
                    .collect::<Vec<_>>()
            );
        }
    }
    assert_eq!(members.len(), 2884);
    for key in ["foldSdkChecks", "edgeSdkChecks"] {
        assert!(doc["checks"][key].as_u64().unwrap() > 0);
    }
    assert_eq!(doc["checks"]["surrogateEngineComparisons"], 0);
    assert_eq!(doc["checks"]["engineComparableScalars"], 1_112_064);
    assert_eq!(
        doc["checks"]["exhaustiveSdkChecks"].as_u64().unwrap(),
        if doc["checks"]["exhaustiveCategories"].as_bool().unwrap() {
            3 * 1_112_064
        } else {
            0
        }
    );
}
