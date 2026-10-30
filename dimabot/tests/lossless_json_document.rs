#![cfg(feature = "lossless-json")]

use dima_rust::utils::{js_string::JsString, lossless_json_document::JsonDocument};

#[path = "support/sha256.rs"]
mod digest;

fn canonical(raw: &str) -> String {
    JsonDocument::parse(raw).unwrap().root().to_json_string()
}

#[test]
fn canonicalizes_duplicates_indices_scalars_and_utf16() {
    for (raw, expected) in [
        (
            r#" { "b":1, "2":2, "10":3, "1":4, "b":5, "01":6, "\u0032":7 } "#,
            r#"{"1":4,"2":7,"10":3,"b":5,"01":6}"#,
        ),
        (
            r#"{"4294967295":1,"4294967294":2,"0":3,"-0":4}"#,
            r#"{"0":3,"4294967294":2,"4294967295":1,"-0":4}"#,
        ),
        (
            r#"{"\ud800":"\udc00","\ud800":"\ud83d\ude00","s":"\u0061\/\n"}"#,
            r#"{"\ud800":"😀","s":"a/\n"}"#,
        ),
        (
            "[1e999,-1e999,-0,1e-9999,1.00,1e21,1e-7]",
            "[null,null,0,0,1,1e+21,1e-7]",
        ),
        (
            r#"{"__proto__":1,"constructor":2,"__proto__":3}"#,
            r#"{"__proto__":3,"constructor":2}"#,
        ),
    ] {
        assert_eq!(canonical(raw), expected, "{raw}");
    }
}

#[test]
fn borrowed_owned_subtrees_and_last_utf16_key_survive_source_drop() {
    let owned = {
        let raw = String::from(r#"  {"item":{"\ud800":1,"\ud800":[-0,1e999]},"n":9}  "#);
        let doc = JsonDocument::parse(&raw).unwrap();
        assert_eq!(doc.raw(), raw.trim());
        let selected = doc.root().get("item").unwrap();
        let key = JsString::from_units(vec![0xd800]);
        assert_eq!(selected.get_key(&key).unwrap().raw(), "[-0,1e999]");
        selected.into_owned()
    };
    assert_eq!(owned.root().to_json_string(), r#"{"\ud800":[0,null]}"#);
    let moved = owned.into_owned();
    assert_eq!(
        moved
            .root()
            .get_key(&JsString::from_units(vec![0xd800]))
            .unwrap()
            .array()
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn deep_index_serialization_and_drop_do_not_use_recursive_trees() {
    for depth in [129, 256, 4096] {
        let raw = format!(
            "{}{{\"x\":-0,\"x\":1e999}}{}",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let expected = format!("{}{{\"x\":null}}{}", "[".repeat(depth), "]".repeat(depth));
        let doc = JsonDocument::parse(&raw).unwrap().into_owned();
        assert_eq!(doc.root().to_json_string(), expected);
        let mut value = doc.root();
        for _ in 0..depth {
            value = value.array().unwrap().next().unwrap();
        }
        assert_eq!(value.get("x").unwrap().raw(), "1e999");
        drop(doc);
        let objects = format!("{}0{}", r#"{"x":"#.repeat(depth), "}".repeat(depth));
        let doc = JsonDocument::parse(&objects).unwrap().into_owned();
        assert_eq!(doc.root().to_json_string(), objects);
        drop(doc);
    }
}

#[test]
fn invalid_syntax_is_rejected_even_at_depth() {
    for bad in [
        "",
        "null true",
        "[1,]",
        "{\"a\":}",
        "01",
        "\"\\u12xz\"",
        "\u{feff}null",
    ] {
        assert!(JsonDocument::parse(bad).is_err(), "{bad:?}");
        if !bad.is_empty() && bad != "\u{feff}null" {
            let deep = format!("{}{}{}", "[".repeat(256), bad, "]".repeat(256));
            assert!(JsonDocument::parse(&deep).is_err(), "{bad:?}");
        }
    }
}

#[test]
#[ignore = "generate the pinned Node fixture in an isolated snapshot first"]
fn pinned_node_oracle_canonicalization() {
    use digest::sha256_hex as hash;
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    const NODE_SHA256: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
    fn external_file(var: &str, checkout: &Path) -> PathBuf {
        let file = PathBuf::from(std::env::var_os(var).expect("absolute external file required"));
        assert!(file.is_absolute(), "{var} must be absolute");
        assert!(
            fs::symlink_metadata(&file)
                .expect("file must exist")
                .file_type()
                .is_file(),
            "{var} must be a regular file"
        );
        assert_eq!(
            file.canonicalize().expect("canonical file"),
            file,
            "{var} must be canonical and contain no symlinks"
        );
        let dir = file.parent().expect("file parent");
        assert!(
            fs::symlink_metadata(dir)
                .expect("directory must exist")
                .file_type()
                .is_dir()
        );
        assert_eq!(dir.canonicalize().expect("canonical directory"), dir);
        assert!(
            !file.starts_with(checkout),
            "{var} must be outside the checkout"
        );
        file
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let checkout = root.canonicalize().unwrap().parent().unwrap().to_path_buf();
    let fixture_path = external_file("DIMA_JSON_DOCUMENT_ORACLE", &checkout);
    assert_eq!(
        fixture_path.file_name().unwrap(),
        "lossless-json-document-reference.json"
    );
    let fixture = fs::read(fixture_path).unwrap();
    let pin = std::env::var("DIMA_JSON_DOCUMENT_ORACLE_SHA256")
        .expect("independent fixture SHA-256 required");
    assert_eq!(pin.len(), 64);
    assert!(
        pin.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(hash(&fixture), pin, "independently supplied fixture hash");
    let oracle: serde_json::Value = serde_json::from_slice(&fixture).unwrap();
    assert_eq!(oracle["node"], "v24.22.1");
    assert_eq!(oracle["v8"], "13.6.233.17-node.58");
    let binary = external_file("DIMA_JSON_DOCUMENT_NODE_BINARY", &checkout);
    assert_eq!(hash(&fs::read(binary).unwrap()), NODE_SHA256);
    assert_eq!(oracle["nodeSha256"].as_str().unwrap(), NODE_SHA256);
    let files = [
        "src/utils/lossless_json_document.rs",
        "src/utils/lossless_json_view.rs",
        "src/utils/lossless_json.rs",
        "src/utils/js_string.rs",
        "src/utils/json_number.rs",
        "src/utils/mod.rs",
        "tests/lossless_json_document.rs",
        "tests/support/sha256.rs",
        "tests/fixtures/lossless_json_document_reference.cjs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
    ];
    let hashes = oracle["hashes"].as_object().unwrap();
    assert_eq!(hashes.len(), files.len());
    for file in files {
        assert_eq!(
            hash(&fs::read(root.join(file)).unwrap()),
            hashes[file].as_str().unwrap(),
            "{file}"
        );
    }
    let cases = oracle["cases"].as_array().unwrap();
    assert_eq!(oracle["count"].as_u64().unwrap() as usize, cases.len());
    assert_eq!(cases.len(), 31);
    for depth in [129, 256, 4096] {
        for prefix in ["deep", "deep-objects", "deep-invalid"] {
            let label = format!("{prefix}-{depth}");
            assert_eq!(
                cases
                    .iter()
                    .filter(|c| c["label"] == label && c["depth"].as_u64() == Some(depth))
                    .count(),
                1
            );
        }
    }
    let mut valid = 0;
    let mut invalid = 0;
    let mut resource_limited = 0;
    for case in cases {
        let raw = case["raw"].as_str().unwrap();
        let label = case["label"].as_str().unwrap();
        match case["stage"].as_str().unwrap() {
            "complete" => {
                valid += 1;
                assert!(case["error"].is_null() && case["expectedNativeCanonical"].is_null());
                assert_eq!(
                    canonical(raw),
                    case["canonical"].as_str().unwrap(),
                    "{label}"
                );
            }
            "parse" => {
                invalid += 1;
                assert_eq!(case["error"], "SyntaxError");
                assert!(case["canonical"].is_null() && case["expectedNativeCanonical"].is_null());
                assert!(JsonDocument::parse(raw).is_err(), "{label}");
            }
            "stringify" => {
                resource_limited += 1;
                assert_eq!(case["error"], "RangeError");
                assert!(case["canonical"].is_null());
                let depth = case["depth"].as_u64().unwrap() as usize;
                assert!([129, 256, 4096].contains(&depth));
                let (expected_raw, expected_wire) = if label == format!("deep-{depth}") {
                    (
                        format!(
                            "{}{{\"x\":-0,\"x\":1e999}}{}",
                            "[".repeat(depth),
                            "]".repeat(depth)
                        ),
                        format!("{}{{\"x\":null}}{}", "[".repeat(depth), "]".repeat(depth)),
                    )
                } else {
                    assert_eq!(label, format!("deep-objects-{depth}"));
                    let objects = format!("{}0{}", r#"{"x":"#.repeat(depth), "}".repeat(depth));
                    (objects.clone(), objects)
                };
                assert_eq!(raw, expected_raw);
                assert_eq!(
                    case["expectedNativeCanonical"].as_str().unwrap(),
                    expected_wire
                );
                let document = JsonDocument::parse(raw).expect("V8 parsed resource probe");
                assert_eq!(document.root().to_json_string(), expected_wire, "{label}");
            }
            stage => panic!("unexpected oracle stage {stage}: {label}"),
        }
    }
    assert_eq!(oracle["valid"].as_u64().unwrap() as usize, valid);
    assert_eq!(oracle["invalid"].as_u64().unwrap() as usize, invalid);
    assert_eq!(
        oracle["resourceLimited"].as_u64().unwrap() as usize,
        resource_limited
    );
    assert_eq!(valid + invalid + resource_limited, cases.len());
    assert!(valid >= 15 && invalid >= 10);
}
