#![cfg(feature = "ai-usage-receipt-parser")]
//! Explicit opt-in benchmark: required fixture and externally supplied SHA, no ignored skip.
use dima_rust::utils::ai_usage_receipt_parser::parse_queued_ai_usage_receipt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, hint::black_box, path::Path, time::Instant};

const SCOPE: &str =
    "prepared input parse, ordered JSON wire encoding, wrapping UTF-8 byte checksum";
const UNIT: &str = "nanoseconds per full trial";
const NATIVE_FILES: &[(&str, &[u8])] = &[
    ("Cargo.toml", include_bytes!("../Cargo.toml")),
    ("Cargo.lock", include_bytes!("../Cargo.lock")),
    (
        "rust-toolchain.toml",
        include_bytes!("../rust-toolchain.toml"),
    ),
    ("src/lib.rs", include_bytes!("../src/lib.rs")),
    ("src/utils/mod.rs", include_bytes!("../src/utils/mod.rs")),
    (
        "src/utils/ai_usage_receipt_parser.rs",
        include_bytes!("../src/utils/ai_usage_receipt_parser.rs"),
    ),
    (
        "src/utils/ai_usage.rs",
        include_bytes!("../src/utils/ai_usage.rs"),
    ),
    (
        "src/utils/bson_compat.rs",
        include_bytes!("../src/utils/bson_compat.rs"),
    ),
    (
        "src/utils/credit_policy.rs",
        include_bytes!("../src/utils/credit_policy.rs"),
    ),
    (
        "src/utils/js_compat.rs",
        include_bytes!("../src/utils/js_compat.rs"),
    ),
    (
        "src/utils/js_string.rs",
        include_bytes!("../src/utils/js_string.rs"),
    ),
    (
        "src/utils/json_number.rs",
        include_bytes!("../src/utils/json_number.rs"),
    ),
    (
        "src/utils/lossless_json.rs",
        include_bytes!("../src/utils/lossless_json.rs"),
    ),
    (
        "src/utils/lossless_json_view.rs",
        include_bytes!("../src/utils/lossless_json_view.rs"),
    ),
    (
        "src/utils/js_date/mod.rs",
        include_bytes!("../src/utils/js_date/mod.rs"),
    ),
    (
        "src/utils/js_date/parser.rs",
        include_bytes!("../src/utils/js_date/parser.rs"),
    ),
    (
        "src/utils/js_date/local_time.rs",
        include_bytes!("../src/utils/js_date/local_time.rs"),
    ),
    (
        "src/utils/tts/mod.rs",
        include_bytes!("../src/utils/tts/mod.rs"),
    ),
    (
        "src/utils/tts/settings.rs",
        include_bytes!("../src/utils/tts/settings.rs"),
    ),
    (
        "src/utils/tts/usage.rs",
        include_bytes!("../src/utils/tts/usage.rs"),
    ),
    (
        "src/utils/tts/tag_types.rs",
        include_bytes!("../src/utils/tts/tag_types.rs"),
    ),
    (
        "src/utils/tts_defaults.rs",
        include_bytes!("../src/utils/tts_defaults.rs"),
    ),
    (
        "tests/ai_usage_receipt_parser_benchmark.rs",
        include_bytes!("../tests/ai_usage_receipt_parser_benchmark.rs"),
    ),
];

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn s(v: &Value) -> &str {
    v.as_str().expect("required string")
}
fn n(v: &Value) -> usize {
    v.as_u64().expect("required integer") as usize
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().expect("required array")
}
fn wire(input: &str) -> String {
    parse_queued_ai_usage_receipt(black_box(input))
        .map(|v| black_box(v).json())
        .unwrap_or_else(|| "null".to_owned())
}
fn checksum(records: &[Value], operations: usize, native: bool) -> u32 {
    let mut sum = 0u32;
    for i in 0..operations {
        let record = &records[i % records.len()];
        let output = if native {
            wire(s(&record["input"]))
        } else {
            s(&record["wire"]).to_owned()
        };
        for b in black_box(output).bytes() {
            sum = sum.wrapping_add(u32::from(b));
        }
    }
    black_box(sum)
}
fn verify_report(
    report: &Value,
    pools: &[Value],
    expected_sha: &str,
    language: &str,
    runtime: &Value,
) {
    assert_eq!(report["language"], language);
    assert_eq!(report["scope"], SCOPE);
    assert_eq!(report["sampleUnit"], UNIT);
    assert_eq!(&report["runtime"], runtime);
    assert_eq!(report["version"], 1);
    assert_eq!(s(&report["fixtureSha256"]), expected_sha);
    let results = arr(&report["pools"]);
    assert_eq!(results.len(), pools.len());
    for (result, pool) in results.iter().zip(pools) {
        assert_eq!(result["name"], pool["name"]);
        assert_eq!(result["operations"], pool["operations"]);
        assert_eq!(result["warmupOperations"], pool["warmupOperations"]);
        let expected = checksum(arr(&pool["records"]), n(&pool["operations"]), false);
        let trials = arr(&result["trials"]);
        assert_eq!(trials.len(), 7);
        let mut durations = Vec::new();
        for trial in trials {
            assert_eq!(n(&trial["checksum"]), expected as usize);
            let duration = trial["ns"].as_u64().expect("duration");
            assert!(duration > 0);
            durations.push(duration);
        }
        durations.sort_unstable();
        assert_eq!(result["min"], durations[0]);
        assert_eq!(result["median"], durations[3]);
        assert_eq!(result["max"], durations[6]);
    }
}
#[test]
#[ignore = "source-bound release benchmark"]
fn prepared_receipt_parser_benchmark() {
    if cfg!(debug_assertions) {
        panic!("release profile required");
    }
    let dir = std::env::var("AI_RECEIPT_BENCH_DIR").expect("AI_RECEIPT_BENCH_DIR required");
    let expected_sha =
        std::env::var("AI_RECEIPT_BENCH_INPUT_SHA256").expect("independent input SHA required");
    assert_eq!(expected_sha.len(), 64);
    assert_eq!(std::env::var("TZ").as_deref(), Ok("UTC"));
    let rustc = std::env::var("AI_RECEIPT_BENCH_RUSTC_VERSION")
        .expect("independently observed rustc version required");
    assert!(rustc.starts_with("rustc 1.99.1 "));
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let input_path = Path::new(&dir).join("inputs.json");
    let bytes = fs::read(&input_path).expect("nonempty fixture");
    assert!(!bytes.is_empty());
    assert_eq!(hash(&bytes), expected_sha);
    let fixture: Value = serde_json::from_slice(&bytes).expect("fixture JSON");
    assert_eq!(fixture["version"], 1);
    for entry in arr(&fixture["provenance"])
        .iter()
        .chain(arr(&fixture["harness"]).iter())
    {
        assert_eq!(
            hash(&fs::read(root.join(s(&entry["file"]))).expect("source file")),
            s(&entry["sha256"])
        );
    }
    assert_eq!(fixture["scope"], SCOPE);
    assert_eq!(fixture["runtime"]["node"], "v24.22.1");
    assert_eq!(fixture["runtime"]["v8"], "13.6.233.17-node.58");
    assert_eq!(fixture["runtime"]["typescript"], "5.9.3");
    assert_eq!(fixture["runtime"]["tz"], "UTC");
    assert_eq!(arr(&fixture["pinnedFiles"]).len(), 3);
    let pinned = arr(&fixture["pinnedFiles"]);
    let artifacts = [
        ("node", "DIMA_AI_RECEIPT_NODE_BINARY"),
        ("typescript", "DIMA_AI_RECEIPT_TYPESCRIPT_IMPLEMENTATION"),
        ("typescriptPackage", "DIMA_AI_RECEIPT_TYPESCRIPT_PACKAGE"),
    ];
    for (entry, (name, variable)) in pinned.iter().zip(artifacts) {
        assert_eq!(s(&entry["name"]), name);
        assert!(!s(&entry["file"]).is_empty());
        let artifact =
            std::env::var(variable).expect("read-only pinned runtime artifact path required");
        assert_eq!(
            hash(&fs::read(artifact).expect("pinned runtime artifact")),
            s(&entry["sha256"])
        );
    }
    let bound = arr(&fixture["nativeFiles"]);
    assert_eq!(bound.len(), NATIVE_FILES.len());
    for (entry, (file, compiled)) in bound.iter().zip(NATIVE_FILES) {
        assert_eq!(s(&entry["file"]), *file);
        assert_eq!(hash(compiled), s(&entry["sha256"]), "compile-time {file}");
        assert_eq!(
            hash(&fs::read(root.join(file)).expect("native source")),
            s(&entry["sha256"]),
            "runtime {file}"
        );
    }
    let pools = arr(&fixture["pools"]);
    assert_eq!(pools.len(), 6);
    // Validate every wire and every Node trial before starting any native timer.
    for pool in pools {
        let records = arr(&pool["records"]);
        assert_eq!(records.len(), 32);
        let warmup = n(&pool["warmupOperations"]);
        assert_eq!(warmup % 32, 0);
        assert_eq!(
            warmup,
            if s(&pool["name"]).starts_with("deep-") {
                2048
            } else {
                32000
            }
        );
        for record in records {
            assert_eq!(
                wire(s(&record["input"])),
                s(&record["wire"]),
                "{}",
                pool["name"]
            );
        }
    }
    let node: Value = serde_json::from_slice(
        &fs::read(Path::new(&dir).join("node-report.json")).expect("Node report required"),
    )
    .expect("Node report JSON");
    verify_report(&node, pools, &expected_sha, "node", &fixture["runtime"]);
    let mut results = Vec::new();
    for pool in pools {
        let records = arr(&pool["records"]);
        let operations = n(&pool["operations"]);
        assert!(operations >= records.len());
        let warmup = n(&pool["warmupOperations"]);
        assert_eq!(
            checksum(records, warmup, true),
            checksum(records, warmup, false)
        );
        let expected = checksum(records, operations, false);
        let mut trials = Vec::new();
        let mut durations = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let value = checksum(records, operations, true);
            let ns = start.elapsed().as_nanos() as u64;
            assert_eq!(value, expected);
            assert!(ns > 0);
            durations.push(ns);
            trials.push(json!({"ns":ns,"checksum":value}));
        }
        durations.sort_unstable();
        results.push(json!({"name":pool["name"],"operations":operations,"warmupOperations":warmup,"trials":trials,"min":durations[0],"median":durations[3],"max":durations[6]}));
    }
    assert_eq!(
        hash(&fs::read(&input_path).unwrap()),
        expected_sha,
        "fixture changed"
    );
    for entry in arr(&fixture["provenance"])
        .iter()
        .chain(arr(&fixture["harness"]).iter())
    {
        assert_eq!(
            hash(&fs::read(root.join(s(&entry["file"]))).unwrap()),
            s(&entry["sha256"]),
            "source changed"
        );
    }
    for (entry, (file, compiled)) in bound.iter().zip(NATIVE_FILES) {
        assert_eq!(hash(compiled), s(&entry["sha256"]));
        assert_eq!(
            hash(&fs::read(root.join(file)).unwrap()),
            s(&entry["sha256"])
        );
    }
    for (entry, (_, variable)) in pinned.iter().zip(artifacts) {
        assert_eq!(
            hash(&fs::read(std::env::var(variable).unwrap()).unwrap()),
            s(&entry["sha256"])
        );
    }
    let runtime = json!({"toolchain":"1.99.1","rustc":rustc,"profile":if cfg!(debug_assertions) {"debug"} else {"release"},"arch":std::env::consts::ARCH,"os":std::env::consts::OS});
    let report = json!({"version":1,"language":"rust","runtime":runtime.clone(),"scope":SCOPE,"sampleUnit":UNIT,"fixtureSha256":expected_sha,"pools":results});
    verify_report(&report, pools, &expected_sha, "rust", &runtime);
    use std::io::Write;
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(Path::new(&dir).join("native-report.json"))
        .expect("exclusive native report");
    writeln!(out, "{}", report).unwrap();
}
