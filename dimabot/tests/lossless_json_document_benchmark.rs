#![cfg(feature = "lossless-json")]

//! Isolated release-only matched benchmark. Fixture preparation, validation,
//! hashing, and per-case comparisons occur outside all timed sections.
#[path = "support/sha256.rs"]
mod digest;

use dima_rust::utils::lossless_json_document::JsonDocument;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    hint::black_box,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const NODE_SHA: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const INPUT: &str = "lossless-json-document-benchmark-input.json";
const PROVENANCE: &str = "lossless-json-document-benchmark-provenance.json";
const OUTPUT: &str = "lossless-json-document-benchmark-rust.json";
const FILES: &[&str] = &[
    "src/utils/lossless_json_document.rs",
    "src/utils/lossless_json_view.rs",
    "src/utils/lossless_json.rs",
    "src/utils/js_string.rs",
    "src/utils/js_compat.rs",
    "src/utils/json_number.rs",
    "src/utils/mod.rs",
    "tests/lossless_json_document.rs",
    "tests/fixtures/lossless_json_document_reference.cjs",
    "tests/support/sha256.rs",
    "tests/lossless_json_document_benchmark.rs",
    "tests/fixtures/lossless_json_document_benchmark.cjs",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
];

fn read_regular(dir: &Path, name: &str) -> Vec<u8> {
    let file = dir.join(name);
    assert!(
        fs::symlink_metadata(&file)
            .expect("input file")
            .file_type()
            .is_file()
    );
    assert_eq!(file.canonicalize().unwrap(), file);
    fs::read(file).unwrap()
}

fn pin(name: &str, bytes: &[u8]) -> String {
    let expected = std::env::var(name).expect("independent SHA-256 required");
    assert_eq!(expected.len(), 64);
    assert!(
        expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(digest::sha256_hex(bytes), expected, "{name}");
    expected
}

fn verify_sources(root: &Path, provenance: &Value) {
    let hashes = provenance["hashes"].as_object().unwrap();
    assert_eq!(hashes.len(), FILES.len());
    for file in FILES {
        assert_eq!(
            digest::sha256_hex(&fs::read(root.join(file)).unwrap()),
            hashes[*file].as_str().unwrap(),
            "{file}"
        );
    }
}

fn operation(raw: &str) -> String {
    let document = JsonDocument::parse(raw).expect("valid benchmark input");
    match document.root().get("error") {
        Some(value) if value.truthy() => value.to_json_string(),
        _ => "null".to_owned(),
    }
}

struct Case {
    raw: String,
    expected: String,
}
fn checksum(pool: &[Case], passes: usize) -> u32 {
    let mut sum = 0u32;
    for _ in 0..passes {
        for case in pool {
            let output = black_box(operation(black_box(case.raw.as_str())));
            sum = sum.wrapping_add(black_box(output.len()) as u32);
        }
    }
    black_box(sum)
}
fn expected_checksum(pool: &[Case], passes: usize) -> u32 {
    pool.iter()
        .fold(0u32, |sum, c| sum.wrapping_add(c.expected.len() as u32))
        .wrapping_mul(passes as u32)
}

#[test]
#[ignore = "isolated release-only benchmark with independently pinned prepared inputs"]
fn matched_parse_select_serialize_benchmark() {
    assert!(
        !black_box(cfg!(debug_assertions)),
        "release profile required"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let checkout = root.canonicalize().unwrap().parent().unwrap().to_path_buf();
    let dir = PathBuf::from(
        std::env::var_os("DIMA_JSON_DOCUMENT_BENCH_DIR").expect("benchmark directory"),
    );
    assert!(dir.is_absolute());
    assert!(fs::symlink_metadata(&dir).unwrap().file_type().is_dir());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(!dir.starts_with(checkout));
    let input_bytes = read_regular(&dir, INPUT);
    let provenance_bytes = read_regular(&dir, PROVENANCE);
    let input_sha = pin("DIMA_JSON_DOCUMENT_BENCH_INPUT_SHA256", &input_bytes);
    let provenance_sha = pin(
        "DIMA_JSON_DOCUMENT_BENCH_PROVENANCE_SHA256",
        &provenance_bytes,
    );
    let input: Value = serde_json::from_slice(&input_bytes).unwrap();
    let provenance: Value = serde_json::from_slice(&provenance_bytes).unwrap();
    assert_eq!(input["format"], 1);
    assert_eq!(
        input["operation"],
        "JSON.parse, own error lookup, truthiness, JSON.stringify or null"
    );
    assert_eq!(input["warmupPasses"], 20);
    assert_eq!(input["trials"], 7);
    assert_eq!(provenance["format"], 1);
    assert_eq!(provenance["node"], "v24.22.1");
    assert_eq!(provenance["v8"], "13.6.233.17-node.58");
    assert_eq!(provenance["nodeSha256"], NODE_SHA);
    assert_eq!(provenance["inputSha256"], input_sha);
    verify_sources(root, &provenance);
    let definitions = [
        ("small-strings", 500usize),
        ("wide-object", 500),
        ("large-ignored", 100),
        ("deep-selected", 500),
        ("escaped-strings", 500),
    ];
    let workloads = input["workloads"].as_array().unwrap();
    assert_eq!(workloads.len(), definitions.len());
    let mut results = Vec::new();
    for (workload, (name, passes)) in workloads.iter().zip(definitions) {
        assert_eq!(workload["name"], name);
        assert_eq!(workload["passes"].as_u64(), Some(passes as u64));
        assert_eq!(workload["caseCount"], 32);
        let rows = workload["pool"].as_array().unwrap();
        assert_eq!(rows.len(), 32);
        let pool: Vec<Case> = rows
            .iter()
            .map(|row| Case {
                raw: row["raw"].as_str().unwrap().to_owned(),
                expected: row["expected"].as_str().unwrap().to_owned(),
            })
            .collect();
        for case in &pool {
            assert!(case.expected.is_ascii(), "{name}");
            assert_eq!(operation(&case.raw), case.expected, "{name}");
        }
        assert_eq!(checksum(&pool, 20), expected_checksum(&pool, 20));
        let operations = passes * pool.len();
        let expected = expected_checksum(&pool, passes);
        let mut samples = Vec::new();
        let mut elapsed = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let actual = checksum(&pool, passes);
            let ns = u64::try_from(start.elapsed().as_nanos()).unwrap();
            assert!(ns > 0 && ns <= 9_007_199_254_740_991);
            assert_eq!(actual, expected);
            samples.push(json!({"elapsedNs": ns, "nsPerOp": ns as f64 / operations as f64, "checksum": actual}));
            elapsed.push(ns);
        }
        elapsed.sort_unstable();
        results.push(
            json!({"name": name, "passes": passes, "caseCount": 32, "operations": operations,
            "warmupPasses": 20, "ascii": true, "checksum": expected, "samples": samples,
            "medianNsPerOp": elapsed[3] as f64 / operations as f64}),
        );
    }
    assert_eq!(read_regular(&dir, INPUT), input_bytes);
    assert_eq!(read_regular(&dir, PROVENANCE), provenance_bytes);
    verify_sources(root, &provenance);
    let report = json!({"format": 1, "runtime": "rust-release", "inputSha256": input_sha,
        "provenanceSha256": provenance_sha, "workloads": results});
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
