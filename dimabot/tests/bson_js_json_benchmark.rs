#![cfg(feature = "bson-js-json")]
//! Isolated, independently hashed prepared-document benchmark; decoding is excluded.
use dima_rust::utils::bson_js_json::bson_js_json;
use mongodb::bson::{Bson, Document};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{hint::black_box, io::Write, time::Instant};

const LABEL: &str = "prepared BSON projection + JSON + UTF-8 byte sum";
const NAMES: [&str; 4] = [
    "ordinary-numeric",
    "nested-mixed",
    "bson-specials",
    "large-context-arrays",
];
fn text(v: &Value) -> &str {
    v.as_str().expect("string")
}
fn number(v: &Value) -> u64 {
    v.as_u64().expect("unsigned integer")
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sum(s: &str) -> u32 {
    s.bytes().fold(0u32, |n, b| n.wrapping_add(u32::from(b)))
}
fn run(pool: &[Bson], count: usize) -> u32 {
    let mut total = 0u32;
    for i in 0..count {
        let wire = black_box(
            bson_js_json(black_box(&pool[i % pool.len()]))
                .expect("projection")
                .to_json_string(),
        );
        total = total.wrapping_add(sum(black_box(&wire)));
    }
    black_box(total)
}
#[test]
#[ignore = "isolated benchmark requires independently hashed external SDK fixture"]
fn matched_prepared_bson_json() {
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_BSON_JSON_BENCHMARK_DIR").expect("benchmark directory"),
    );
    assert!(dir.is_absolute());
    let supplied =
        std::env::var("DIMA_BSON_JSON_BENCHMARK_INPUT_SHA256").expect("independent input SHA256");
    let bytes = std::fs::read(dir.join("bson-js-json-input.json")).unwrap();
    assert_eq!(hash(&bytes), supplied);
    let input: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(number(&input["format"]), 1);
    assert_eq!(text(&input["label"]), LABEL);
    assert_eq!(
        text(&input["nodeSha"]),
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let hashes = input["sourceHashes"].as_object().unwrap();
    for file in [
        "src/utils/bson_js_json.rs",
        "src/utils/js_string.rs",
        "src/utils/lossless_json.rs",
        "src/utils/credit_policy.rs",
        "src/utils/json_number.rs",
        "tests/bson_js_json.rs",
        "tests/fixtures/bson_js_json_reference.cjs",
        "tests/bson_js_json_benchmark.rs",
        "tests/fixtures/bson_js_json_benchmark.cjs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "package.json",
        "package-lock.json",
    ] {
        assert_eq!(
            hash(&std::fs::read(root.join(file)).unwrap()),
            text(&hashes[file]),
            "source: {file}"
        );
    }
    let node: Value =
        serde_json::from_slice(&std::fs::read(dir.join("bson-js-json-node.json")).unwrap())
            .unwrap();
    assert_eq!(number(&node["format"]), 1);
    assert_eq!(text(&node["label"]), LABEL);
    assert_eq!(text(&node["runtime"]), "node-commonjs");
    assert_eq!(text(&node["inputSha256"]), supplied);
    let workloads = input["workloads"].as_array().unwrap();
    let reports = node["workloads"].as_array().unwrap();
    assert_eq!(workloads.len(), NAMES.len());
    assert_eq!(reports.len(), NAMES.len());
    let mut prepared = Vec::new();
    for (index, workload) in workloads.iter().enumerate() {
        assert_eq!(text(&workload["name"]), NAMES[index]);
        let count = number(&workload["iterations"]) as usize;
        assert_eq!(count, if index == 3 { 4096 } else { 65536 });
        assert_eq!(number(&workload["warmup"]) as usize, count);
        let source = workload["pool"].as_array().unwrap();
        assert_eq!(source.len(), 32);
        let mut pool = Vec::new();
        let mut checksums = Vec::new();
        for item in source {
            let hex = text(&item["hex"]).as_bytes();
            assert_eq!(hex.len() % 2, 0);
            let raw: Vec<u8> = hex
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
                .collect();
            let value = Bson::Document(Document::from_reader(raw.as_slice()).unwrap());
            let wire = text(&item["wire"]);
            assert_eq!(
                bson_js_json(&value).unwrap().to_json_string(),
                wire,
                "{}",
                NAMES[index]
            );
            let checksum = sum(wire);
            assert_eq!(u64::from(checksum), number(&item["checksum"]));
            pool.push(value);
            checksums.push(checksum);
        }
        let expected = (0..count).fold(0u32, |n, i| n.wrapping_add(checksums[i % 32]));
        let report = &reports[index];
        assert_eq!(text(&report["name"]), NAMES[index]);
        assert_eq!(number(&report["iterations"]) as usize, count);
        assert_eq!(number(&report["warmup"]) as usize, count);
        assert_eq!(number(&report["checksum"]), u64::from(expected));
        let samples = report["samples"].as_array().unwrap();
        let sums = report["sampleChecksums"].as_array().unwrap();
        assert_eq!(samples.len(), 7);
        assert_eq!(sums.len(), 7);
        assert!(sums.iter().all(|v| number(v) == u64::from(expected)));
        let mut times: Vec<u64> = samples.iter().map(number).collect();
        assert!(times.iter().all(|n| *n > 0 && *n <= 9_007_199_254_740_991));
        times.sort_unstable();
        assert_eq!(number(&report["medianNs"]), times[3]);
        prepared.push((pool, count, expected));
    }
    let mut results = Vec::new();
    for (i, (pool, count, expected)) in prepared.iter().enumerate() {
        assert_eq!(run(pool, *count), *expected);
        let mut times = Vec::new();
        let mut sums = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let actual = run(pool, *count);
            let elapsed = u64::try_from(start.elapsed().as_nanos()).unwrap();
            assert!(elapsed > 0 && elapsed <= 9_007_199_254_740_991);
            assert_eq!(actual, *expected);
            times.push(elapsed);
            sums.push(actual);
        }
        let mut sorted = times.clone();
        sorted.sort_unstable();
        results.push(json!({"name":NAMES[i], "iterations":count, "warmup":count, "checksum":expected, "samples":times, "sampleChecksums":sums, "medianNs":sorted[3]}));
    }
    let output = json!({"format":1, "label":LABEL, "runtime":"rust-release", "inputSha256":supplied, "workloads":results});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("bson-js-json-rust.json"))
        .unwrap();
    serde_json::to_writer_pretty(&mut file, &output).unwrap();
    file.write_all(b"\n").unwrap();
}
