#![cfg(feature = "channel-fish-voice-favorites")]
//! Opt-in, prepared-operation comparison; no database or network operations.
#[path = "support/sha256.rs"]
mod digest;
use dima_rust::{
    schemas::channel_fish_voice_favorites::{make_favorite_alias, normalize_favorite_alias},
    utils::{js_string::JsString, lossless_json::JsonValue},
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    hint::black_box,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};
const INPUT: &str = "fish-alias-input.json";
const PROVENANCE: &str = "fish-alias-provenance.json";
const OUTPUT: &str = "fish-alias-rust.json";
const NODE_SHA: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const FILES: &[&str] = &[
    "src/schemas/channel_fish_voice_favorites.schema.rs",
    "src/server/services/tts/fish_tts.rs",
    "src/utils/js_string.rs",
    "src/utils/js_unicode.rs",
    "src/utils/js_unicode_data.rs",
    "src/utils/js_compat.rs",
    "src/utils/lossless_json.rs",
    "tests/support/sha256.rs",
    "tests/fish_favorite_alias_benchmark.rs",
    "tests/fixtures/fish_favorite_alias_benchmark.cjs",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
];
fn read(dir: &Path, name: &str) -> Vec<u8> {
    let p = dir.join(name);
    assert!(fs::symlink_metadata(&p).unwrap().is_file());
    assert_eq!(p.canonicalize().unwrap(), p);
    fs::read(p).unwrap()
}
fn pin(name: &str, b: &[u8]) -> String {
    let s = std::env::var(name).expect("independent SHA required");
    assert_eq!(s.len(), 64);
    assert!(
        s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(s, digest::sha256_hex(b));
    s
}
fn external(name: &str, checkout: &Path) -> Vec<u8> {
    let p = PathBuf::from(std::env::var_os(name).expect("external artifact path"));
    assert!(p.is_absolute() && !p.starts_with(checkout));
    assert!(fs::symlink_metadata(&p).unwrap().is_file());
    assert_eq!(p.canonicalize().unwrap(), p);
    fs::read(p).unwrap()
}
fn verify_sources(root: &Path, checkout: &Path, p: &Value) {
    for (i, (path_env, sha_env)) in [
        (
            "DIMA_FISH_ALIAS_TYPESCRIPT_JS_PATH",
            "DIMA_FISH_ALIAS_TYPESCRIPT_JS_SHA256",
        ),
        (
            "DIMA_FISH_ALIAS_TYPESCRIPT_PACKAGE_PATH",
            "DIMA_FISH_ALIAS_TYPESCRIPT_PACKAGE_SHA256",
        ),
    ]
    .iter()
    .enumerate()
    {
        let bytes = external(path_env, checkout);
        assert_eq!(
            p["typescriptHashes"][i].as_str().unwrap(),
            pin(sha_env, &bytes)
        );
    }
    let hashes = p["hashes"].as_object().unwrap();
    assert_eq!(hashes.len(), FILES.len());
    for name in FILES {
        assert_eq!(
            digest::sha256_hex(&fs::read(root.join(name)).unwrap()),
            hashes[*name].as_str().unwrap(),
            "{name}"
        );
    }
    let rels = [
        "src/schemas/channel_fish_voice_favorites.schema.ts",
        "src/server/services/tts/fish_tts.service.ts",
    ];
    for (i, rel) in rels.iter().enumerate() {
        let live = root.join(rel);
        let archived = checkout
            .join("archives/dimabot-typescript/2026-10-28")
            .join(rel);
        assert_ne!(live.exists(), archived.exists());
        let selected = if live.exists() { live } else { archived };
        assert_eq!(
            p["sourcePaths"][i].as_str().unwrap(),
            selected.to_str().unwrap()
        );
        assert_eq!(
            p["sourceHashes"][i].as_str().unwrap(),
            digest::sha256_hex(&fs::read(selected).unwrap())
        );
    }
}
fn units(v: &Value) -> JsString {
    JsString::from_units(
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
enum Input {
    Normalize(JsonValue),
    Make(JsString, Vec<JsString>),
}
struct Case {
    input: Input,
    expected: Value,
}
fn parse(c: &Value) -> Case {
    let input = match c["op"].as_str().unwrap() {
        "normalize" => {
            let v = &c["input"];
            Input::Normalize(match v["kind"].as_str().unwrap() {
                "string" => JsonValue::String(units(&v["units"])),
                "null" => JsonValue::Null,
                "bool" => JsonValue::Bool(v["value"].as_bool().unwrap()),
                "number" => JsonValue::Number(v["value"].as_f64().unwrap()),
                _ => panic!("kind"),
            })
        }
        "make" => Input::Make(
            units(&c["name"]),
            c["used"].as_array().unwrap().iter().map(units).collect(),
        ),
        _ => panic!("operation"),
    };
    Case {
        input,
        expected: c["expected"].clone(),
    }
}
fn wire(c: &Case) -> Value {
    match &c.input {
        Input::Make(n, u) => {
            json!({"ok":true,"units":make_favorite_alias(n,u).encode_utf16().collect::<Vec<_>>()})
        }
        Input::Normalize(v) => match normalize_favorite_alias(v) {
            Ok(s) => json!({"ok":true,"units":s.encode_utf16().collect::<Vec<_>>()}),
            Err(e) => {
                json!({"ok":false,"status":e.status as u32,"code":e.code.units(),"message":e.message.units()})
            }
        },
    }
}
fn scalar(v: &Value) -> u32 {
    if v["ok"].as_bool().unwrap() {
        v["units"].as_array().unwrap().len() as u32
    } else {
        v["status"].as_u64().unwrap() as u32
            + v["code"].as_array().unwrap().len() as u32
            + v["message"].as_array().unwrap().len() as u32
    }
}
fn expected(pool: &[Case], passes: usize) -> u32 {
    pool.iter()
        .fold(0u32, |s, c| s.wrapping_add(scalar(&c.expected)))
        .wrapping_mul(passes as u32)
}
fn run(pool: &[Case], passes: usize) -> u32 {
    let mut sum = 0u32;
    for _ in 0..passes {
        for c in pool {
            let n = match black_box(&c.input) {
                Input::Make(name, used) => {
                    black_box(make_favorite_alias(black_box(name), black_box(used))).len() as u32
                }
                Input::Normalize(value) => match normalize_favorite_alias(black_box(value)) {
                    Ok(s) => black_box(s).len() as u32,
                    Err(e) => {
                        black_box(e.status as u32 + e.code.len() as u32 + e.message.len() as u32)
                    }
                },
            };
            sum = sum.wrapping_add(black_box(n));
        }
    }
    black_box(sum)
}
#[test]
#[ignore = "release benchmark requires isolated prepared inputs and independent hashes"]
fn matched_fish_alias_benchmark() {
    assert!(!black_box(cfg!(debug_assertions)));
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let checkout = root.parent().unwrap();
    let dir = PathBuf::from(std::env::var_os("DIMA_FISH_ALIAS_DIR").expect("external directory"));
    assert!(dir.is_absolute());
    assert!(fs::symlink_metadata(&dir).unwrap().is_dir());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(!dir.starts_with(checkout));
    let input_bytes = read(&dir, INPUT);
    let provenance_bytes = read(&dir, PROVENANCE);
    let input_sha = pin("DIMA_FISH_ALIAS_INPUT_SHA256", &input_bytes);
    let provenance_sha = pin("DIMA_FISH_ALIAS_PROVENANCE_SHA256", &provenance_bytes);
    let input: Value = serde_json::from_slice(&input_bytes).unwrap();
    let provenance: Value = serde_json::from_slice(&provenance_bytes).unwrap();
    assert_eq!(input["format"], 1);
    assert_eq!(
        input["operation"],
        "prepared helper call; scalar output/error lengths and status"
    );
    assert_eq!(input["warmupPasses"], 20);
    assert_eq!(input["trials"], 7);
    assert_eq!(provenance["format"], 1);
    let metadata_bytes = external("DIMA_FISH_ALIAS_RUSTC_PROVENANCE_PATH", checkout);
    let metadata_sha = pin("DIMA_FISH_ALIAS_RUSTC_PROVENANCE_SHA256", &metadata_bytes);
    let metadata: Value = serde_json::from_slice(&metadata_bytes).unwrap();
    assert_eq!(metadata.as_object().unwrap().len(), 5);
    assert_eq!(metadata["schemaVersion"], 1);
    assert_eq!(metadata["version"], "rustc 1.99.1 (58cf8f9c3 2026-10-13)");
    let verbose = metadata["verbose"].as_str().unwrap();
    assert!(
        verbose.starts_with("rustc 1.99.1 (58cf8f9c3 2026-10-13)\n") && verbose.ends_with('\n')
    );
    assert_eq!(provenance["rustcMetadataSha256"], metadata_sha);
    assert_eq!(provenance["rustcMetadata"], metadata);
    let rustc_path = PathBuf::from(metadata["path"].as_str().unwrap());
    assert!(rustc_path.is_absolute());
    assert!(fs::symlink_metadata(&rustc_path).unwrap().is_file());
    assert_eq!(rustc_path.canonicalize().unwrap(), rustc_path);
    assert_eq!(
        metadata["sha256"].as_str().unwrap(),
        digest::sha256_hex(&fs::read(&rustc_path).unwrap())
    );
    assert_eq!(provenance["nodeSha256"], NODE_SHA);
    assert_eq!(provenance["inputSha256"], input_sha);
    for (key, value) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(provenance["versions"][key], value);
    }
    verify_sources(&root, checkout, &provenance);
    let definitions = [
        ("normalize-valid", 2000usize),
        ("normalize-invalid", 2000),
        ("make-ascii", 1000),
        ("make-unicode", 1000),
        ("make-collisions", 1000),
    ];
    let workloads = input["workloads"].as_array().unwrap();
    assert_eq!(workloads.len(), definitions.len());
    let mut prepared = Vec::new();
    for (w, (name, passes)) in workloads.iter().zip(definitions) {
        assert_eq!(w["name"], name);
        assert_eq!(w["passes"], passes);
        assert_eq!(w["caseCount"], 32);
        let pool: Vec<Case> = w["pool"].as_array().unwrap().iter().map(parse).collect();
        assert_eq!(pool.len(), 32);
        for c in &pool {
            assert_eq!(wire(c), c.expected, "{name}");
            if c.expected["ok"].as_bool().unwrap() {
                assert!(
                    c.expected["units"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|v| v.as_u64().unwrap() < 128)
                );
            }
        }
        prepared.push(pool);
    }
    let mut results = Vec::new();
    for ((name, passes), pool) in definitions.into_iter().zip(&prepared) {
        assert_eq!(run(pool, 20), expected(pool, 20));
        let operations = passes * 32;
        let checksum = expected(pool, passes);
        let mut samples = Vec::new();
        let mut elapsed = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let actual = run(pool, passes);
            let ns = u64::try_from(start.elapsed().as_nanos()).unwrap();
            assert!(ns > 0 && ns <= 9_007_199_254_740_991);
            assert_eq!(actual, checksum);
            samples.push(
                json!({"elapsedNs":ns,"nsPerOp":ns as f64/operations as f64,"checksum":actual}),
            );
            elapsed.push(ns);
        }
        elapsed.sort_unstable();
        results.push(json!({"name":name,"passes":passes,"caseCount":32,"operations":operations,"warmupPasses":20,"checksum":checksum,"samples":samples,"medianNsPerOp":elapsed[3] as f64/operations as f64}));
    }
    assert_eq!(read(&dir, INPUT), input_bytes);
    assert_eq!(read(&dir, PROVENANCE), provenance_bytes);
    verify_sources(&root, checkout, &provenance);
    assert_eq!(
        external("DIMA_FISH_ALIAS_RUSTC_PROVENANCE_PATH", checkout),
        metadata_bytes
    );
    assert_eq!(
        metadata["sha256"].as_str().unwrap(),
        digest::sha256_hex(&fs::read(&rustc_path).unwrap())
    );
    let report = json!({"format":1,"runtime":"rust-release","inputSha256":input_sha,"provenanceSha256":provenance_sha,"workloads":results});
    let mut bytes = serde_json::to_vec(&report).unwrap();
    bytes.push(b'\n');
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(OUTPUT))
        .unwrap();
    output.write_all(&bytes).unwrap();
    println!("rustReportSha256={}", digest::sha256_hex(&bytes));
}
