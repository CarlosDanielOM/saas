#![cfg(feature = "ai-constants")]
//! External, prepared-operation benchmark for the pure `ai/constants` selectors.
//!
//! The fixture and the Node report are produced by
//! `tests/fixtures/ai_constants_benchmark.cjs --write DIR`; this test replays
//! every golden wire, verifies all independently supplied source and file
//! hashes, and writes `native-report.json` with every sample. Nothing here
//! spawns Node or talks to a service.
use dima_rust::utils::ai_constants as constants;
#[path = "support/sha256.rs"]
mod digest;

use constants::{
    PlanTierValue, get_background_summary_model_units, get_provider_restriction_units,
    select_chat_model_value,
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    hint::black_box,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const SCOPE: &str =
    "prepared pure constant selector and provider lookups; scalar output-length checksum";
const UNIT: &str = "nanoseconds per full trial";
const WARMUP_PASSES: usize = 20;
const TRIALS: usize = 7;
const CASE_COUNT: usize = 32;
const OPERATIONS: usize = 32 * 1024;

const SOURCE_SHA: &str = "7505c5481b8681c83ec57c8b89b856250bdd3970586810e900075d06fb5eb0f4";
const PACKAGE_SHA: &str = "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef";
const LOCK_SHA: &str = "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7";
const TOOLCHAIN_SHA: &str = "b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2";
const NODE_SHA: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const TYPESCRIPT_SHA: &str = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const TYPESCRIPT_PACKAGE_SHA: &str =
    "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6";

const NATIVE_FILES: &[(&str, &[u8])] = &[
    (
        "src/utils/ai/constants.rs",
        include_bytes!("../src/utils/ai/constants.rs"),
    ),
    ("tests/ai_constants.rs", include_bytes!("ai_constants.rs")),
    (
        "tests/fixtures/ai_constants_reference.cjs",
        include_bytes!("fixtures/ai_constants_reference.cjs"),
    ),
    (
        "tests/fixtures/ai_constants_benchmark.cjs",
        include_bytes!("fixtures/ai_constants_benchmark.cjs"),
    ),
    (
        "tests/ai_constants_benchmark.rs",
        include_bytes!("ai_constants_benchmark.rs"),
    ),
    (
        "tests/support/sha256.rs",
        include_bytes!("support/sha256.rs"),
    ),
    ("Cargo.toml", include_bytes!("../Cargo.toml")),
    ("Cargo.lock", include_bytes!("../Cargo.lock")),
    (
        "rust-toolchain.toml",
        include_bytes!("../rust-toolchain.toml"),
    ),
    ("package.json", include_bytes!("../package.json")),
    ("package-lock.json", include_bytes!("../package-lock.json")),
    (
        "src/utils/ai/constants.ts",
        include_bytes!("../src/utils/ai/constants.ts"),
    ),
];

#[derive(Clone, Debug)]
enum PlanInput {
    Missing,
    Units(Vec<u16>),
    NonString,
}

impl PlanInput {
    fn value(&self) -> PlanTierValue<'_> {
        match self {
            Self::Missing => PlanTierValue::Missing,
            Self::Units(units) => PlanTierValue::CodeUnits(units.as_slice()),
            Self::NonString => PlanTierValue::NonString,
        }
    }
}

enum Argument {
    Plan(PlanInput),
    Units(Vec<u16>),
}

struct Record {
    argument: Argument,
    scalar: u32,
}

struct Pool {
    name: String,
    records: Vec<Record>,
}

#[derive(Clone, Copy)]
enum Workload {
    Select { exhausted: bool },
    Background,
    Provider,
}

fn hash(bytes: &[u8]) -> String {
    digest::sha256_hex(bytes)
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key}"))
}

fn integer(value: &Value, key: &str) -> usize {
    usize::try_from(
        value[key]
            .as_u64()
            .unwrap_or_else(|| panic!("missing integer {key}")),
    )
    .expect("usize")
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("missing array {key}"))
}

fn read(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert!(!bytes.is_empty(), "empty file: {}", path.display());
    bytes
}

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("code units")
        .iter()
        .map(|unit| u16::try_from(unit.as_u64().expect("unit")).expect("u16"))
        .collect()
}

fn source_root() -> PathBuf {
    match std::env::var_os("DIMA_AI_CONSTANTS_SOURCE_ROOT") {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    }
}

fn workload_for(name: &str) -> Workload {
    match name {
        "select-chat-model" => Workload::Select { exhausted: false },
        "select-chat-model-exhausted" => Workload::Select { exhausted: true },
        "background-model" => Workload::Background,
        "provider-restriction" => Workload::Provider,
        other => panic!("unknown workload {other}"),
    }
}

fn argument(workload: Workload, input: &Value) -> Argument {
    let kind = string(input, "kind");
    match workload {
        Workload::Select { .. } => Argument::Plan(match kind {
            "undefined" | "null" | "missing" => PlanInput::Missing,
            "string" | "units" => PlanInput::Units(units(&input["units"])),
            _ => PlanInput::NonString,
        }),
        Workload::Background | Workload::Provider => Argument::Units(units(&input["units"])),
    }
}

fn evaluate(workload: Workload, argument: &Argument) -> String {
    match (workload, argument) {
        (Workload::Select { exhausted }, Argument::Plan(plan)) => {
            select_chat_model_value(plan.value(), exhausted).to_owned()
        }
        (Workload::Background, Argument::Units(units)) => {
            get_background_summary_model_units(units).to_owned()
        }
        (Workload::Provider, Argument::Units(units)) => match get_provider_restriction_units(units)
        {
            Some(restriction) => format!("only={}", restriction.only.join(",")),
            None => "undefined".to_owned(),
        },
        _ => panic!("argument/workload mismatch"),
    }
}

fn scalar(workload: Workload, argument: &Argument) -> u32 {
    match (workload, argument) {
        (Workload::Select { exhausted }, Argument::Plan(plan)) => {
            select_chat_model_value(plan.value(), exhausted)
                .encode_utf16()
                .count() as u32
        }
        (Workload::Background, Argument::Units(units)) => get_background_summary_model_units(units)
            .encode_utf16()
            .count() as u32,
        (Workload::Provider, Argument::Units(units)) => {
            match get_provider_restriction_units(units) {
                Some(restriction) => {
                    restriction
                        .only
                        .iter()
                        .map(|provider| provider.encode_utf16().count())
                        .sum::<usize>() as u32
                        + 1
                }
                None => 0,
            }
        }
        _ => panic!("argument/workload mismatch"),
    }
}

fn checksum_for(pool: &Pool, operations: usize) -> u32 {
    let mut sum = 0u32;
    for index in 0..operations {
        sum = sum.wrapping_add(pool.records[index % pool.records.len()].scalar);
    }
    sum
}

fn expected_checksum(pool: &Pool) -> u32 {
    checksum_for(pool, OPERATIONS)
}

fn run(workload: Workload, pool: &Pool, operations: usize) -> u32 {
    let mut sum = 0u32;
    let length = pool.records.len();
    match workload {
        Workload::Select { exhausted } => {
            for index in 0..operations {
                let record = &pool.records[index % length];
                let plan = match &record.argument {
                    Argument::Plan(plan) => plan.value(),
                    Argument::Units(_) => unreachable!(),
                };
                let value = black_box(select_chat_model_value(black_box(plan), exhausted));
                sum = sum.wrapping_add(black_box(value.encode_utf16().count() as u32));
            }
        }
        Workload::Background => {
            for index in 0..operations {
                let record = &pool.records[index % length];
                let units = match &record.argument {
                    Argument::Units(units) => units.as_slice(),
                    Argument::Plan(_) => unreachable!(),
                };
                let value = black_box(get_background_summary_model_units(black_box(units)));
                sum = sum.wrapping_add(black_box(value.encode_utf16().count() as u32));
            }
        }
        Workload::Provider => {
            for index in 0..operations {
                let record = &pool.records[index % length];
                let units = match &record.argument {
                    Argument::Units(units) => units.as_slice(),
                    Argument::Plan(_) => unreachable!(),
                };
                let restriction = black_box(get_provider_restriction_units(black_box(units)));
                let value = match restriction {
                    Some(restriction) => {
                        restriction
                            .only
                            .iter()
                            .map(|provider| provider.encode_utf16().count())
                            .sum::<usize>() as u32
                            + 1
                    }
                    None => 0,
                };
                sum = sum.wrapping_add(black_box(value));
            }
        }
    }
    black_box(sum)
}

fn verify_provenance(root: &Path, _workspace: &Path, metadata: &Value) {
    let pins = &metadata["pins"];
    assert_eq!(string(pins, "source"), SOURCE_SHA);
    assert_eq!(string(pins, "package"), PACKAGE_SHA);
    assert_eq!(string(pins, "lock"), LOCK_SHA);
    assert_eq!(string(pins, "toolchain"), TOOLCHAIN_SHA);
    assert_eq!(string(pins, "node"), NODE_SHA);
    assert_eq!(string(pins, "typescript"), TYPESCRIPT_SHA);
    assert_eq!(string(pins, "typescriptPackage"), TYPESCRIPT_PACKAGE_SHA);
    assert_eq!(
        hash(&read(&root.join("src/utils/ai/constants.ts"))),
        SOURCE_SHA
    );
    assert_eq!(hash(&read(&root.join("package.json"))), PACKAGE_SHA);
    assert_eq!(hash(&read(&root.join("package-lock.json"))), LOCK_SHA);
    assert_eq!(
        hash(&read(&root.join("rust-toolchain.toml"))),
        TOOLCHAIN_SHA
    );

    let hashes = metadata["nativeHashes"].as_object().expect("native hashes");
    assert_eq!(hashes.len(), NATIVE_FILES.len());
    for (file, compiled) in NATIVE_FILES {
        let recorded = hashes
            .get(*file)
            .unwrap_or_else(|| panic!("missing {file}"));
        assert_eq!(
            hash(compiled),
            recorded.as_str().unwrap(),
            "compile-time {file}"
        );
        assert_eq!(
            hash(&read(&root.join(*file))),
            recorded.as_str().unwrap(),
            "runtime {file}"
        );
    }

    for (variable, expected) in [
        ("DIMA_AI_CONSTANTS_NODE_BINARY", NODE_SHA),
        (
            "DIMA_AI_CONSTANTS_TYPESCRIPT_IMPLEMENTATION",
            TYPESCRIPT_SHA,
        ),
        (
            "DIMA_AI_CONSTANTS_TYPESCRIPT_PACKAGE",
            TYPESCRIPT_PACKAGE_SHA,
        ),
    ] {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            assert!(path.is_absolute(), "{variable} must be absolute");
            assert_eq!(hash(&read(&path)), expected, "{variable}");
        }
    }
}

fn verify_report(report: &Value, pools: &[Pool], input_sha: &str, language: &str) {
    assert_eq!(integer(report, "format"), 1);
    assert_eq!(string(report, "language"), language);
    assert_eq!(string(report, "scope"), SCOPE);
    assert_eq!(string(report, "sampleUnit"), UNIT);
    assert_eq!(string(report, "fixtureSha256"), input_sha);
    if language == "node" {
        assert_eq!(string(&report["runtime"], "node"), "v24.22.1");
        assert_eq!(string(&report["runtime"], "v8"), "13.6.233.17-node.58");
        assert_eq!(string(&report["runtime"], "typescript"), "5.9.3");
    } else {
        assert_eq!(string(&report["runtime"], "toolchain"), "1.99.1");
        assert!(string(&report["runtime"], "rustc").starts_with("rustc 1.99.1 "));
        assert_eq!(string(&report["runtime"], "profile"), "release");
    }
    let results = array(report, "pools");
    assert_eq!(results.len(), pools.len());
    for (result, pool) in results.iter().zip(pools) {
        assert_eq!(string(result, "name"), pool.name);
        assert_eq!(integer(result, "caseCount"), CASE_COUNT);
        assert_eq!(integer(result, "operations"), OPERATIONS);
        assert_eq!(integer(result, "warmupPasses"), WARMUP_PASSES);
        let checksum = expected_checksum(pool);
        assert_eq!(integer(result, "checksum"), checksum as usize);
        let trials = array(result, "trials");
        assert_eq!(trials.len(), TRIALS);
        let mut durations = Vec::new();
        for trial in trials {
            assert_eq!(integer(trial, "checksum"), checksum as usize);
            let ns = trial["ns"].as_u64().expect("sample nanoseconds");
            assert!(ns > 0, "positive sample");
            durations.push(ns);
        }
        durations.sort_unstable();
        assert_eq!(result["min"].as_u64(), Some(durations[0]));
        assert_eq!(result["median"].as_u64(), Some(durations[3]));
        assert_eq!(result["max"].as_u64(), Some(durations[6]));
    }
}

#[test]
#[ignore = "external prepared paired benchmark coordinator required"]
fn prepared_ai_constants_benchmark() {
    assert!(
        !black_box(cfg!(debug_assertions)),
        "release profile required"
    );
    let dir = PathBuf::from(
        std::env::var_os("DIMA_AI_CONSTANTS_BENCH_DIR").expect("benchmark directory required"),
    );
    assert!(dir.is_absolute(), "absolute benchmark directory required");
    let dir = dir
        .canonicalize()
        .expect("existing benchmark directory required");
    let root = source_root()
        .canonicalize()
        .expect("existing source root required");
    let workspace = root.parent().expect("workspace parent").to_path_buf();
    assert!(
        !dir.starts_with(&workspace),
        "benchmark directory must be external to the checkout"
    );

    let input_path = dir.join("inputs.json");
    let bytes = read(&input_path);
    let input_sha = hash(&bytes);
    let supplied = std::env::var("DIMA_AI_CONSTANTS_BENCH_INPUT_SHA256")
        .expect("independently supplied input SHA required");
    assert_eq!(supplied.len(), 64);
    assert_eq!(input_sha, supplied, "independent input SHA");
    let rustc = std::env::var("DIMA_AI_CONSTANTS_BENCH_RUSTC_VERSION")
        .expect("independently observed rustc version required");
    assert!(rustc.starts_with("rustc 1.99.1 "));

    let inputs: Value = serde_json::from_slice(&bytes).expect("prepared input JSON");
    let metadata = &inputs["metadata"];
    assert_eq!(integer(metadata, "format"), 1);
    assert_eq!(string(metadata, "scope"), SCOPE);
    assert_eq!(string(metadata, "sampleUnit"), UNIT);
    assert_eq!(integer(metadata, "warmupPasses"), WARMUP_PASSES);
    assert_eq!(integer(metadata, "trials"), TRIALS);
    assert_eq!(integer(metadata, "caseCount"), CASE_COUNT);
    assert_eq!(integer(metadata, "operations"), OPERATIONS);
    assert_eq!(string(metadata, "source"), "src/utils/ai/constants.ts");
    verify_provenance(&root, &workspace, metadata);

    let pool_values = array(&inputs, "pools");
    assert_eq!(pool_values.len(), 4);
    let mut pools = Vec::new();
    for pool in pool_values {
        let name = string(pool, "name").to_owned();
        let workload = workload_for(&name);
        assert_eq!(integer(pool, "caseCount"), CASE_COUNT);
        assert_eq!(integer(pool, "operations"), OPERATIONS);
        assert_eq!(integer(pool, "warmupPasses"), WARMUP_PASSES);
        let values = array(pool, "records");
        assert_eq!(values.len(), CASE_COUNT);
        let mut records = Vec::new();
        for record in values {
            let id = string(record, "id").to_owned();
            let input = &record["input"];
            let argument = argument(workload, input);
            let wire = evaluate(workload, &argument);
            assert_eq!(wire, string(record, "wire"), "{id} wire");
            let value = scalar(workload, &argument);
            assert_eq!(value, integer(record, "scalar") as u32, "{id} scalar");
            records.push(Record {
                argument,
                scalar: value,
            });
        }
        pools.push(Pool { name, records });
    }

    let node: Value =
        serde_json::from_slice(&read(&dir.join("node-report.json"))).expect("Node report JSON");
    verify_report(&node, &pools, &input_sha, "node");

    let mut results = Vec::new();
    for pool in &pools {
        let workload = workload_for(&pool.name);
        let warmup_operations = WARMUP_PASSES * CASE_COUNT;
        assert_eq!(
            run(workload, pool, warmup_operations),
            checksum_for(pool, warmup_operations),
            "{} warmup",
            pool.name
        );
        let checksum = expected_checksum(pool);
        let mut trials = Vec::new();
        let mut durations = Vec::new();
        for _ in 0..TRIALS {
            let start = Instant::now();
            let value = run(workload, pool, OPERATIONS);
            let ns = start.elapsed().as_nanos() as u64;
            assert_eq!(value, checksum);
            assert!(ns > 0);
            durations.push(ns);
            trials.push(json!({"ns": ns, "checksum": value}));
        }
        durations.sort_unstable();
        results.push(json!({
            "name": pool.name,
            "caseCount": CASE_COUNT,
            "operations": OPERATIONS,
            "warmupPasses": WARMUP_PASSES,
            "checksum": checksum,
            "trials": trials,
            "min": durations[0],
            "median": durations[3],
            "max": durations[6],
        }));
    }

    assert_eq!(hash(&read(&input_path)), input_sha, "input changed");
    verify_provenance(&root, &workspace, metadata);

    let runtime = json!({
        "toolchain": "1.99.1",
        "rustc": rustc,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
    });
    let report = json!({
        "format": 1,
        "language": "rust",
        "runtime": runtime,
        "scope": SCOPE,
        "sampleUnit": UNIT,
        "fixtureSha256": input_sha,
        "provenance": {
            "sourceSha256": SOURCE_SHA,
            "packageSha256": PACKAGE_SHA,
            "lockSha256": LOCK_SHA,
            "toolchainSha256": TOOLCHAIN_SHA,
            "nodeSha256": NODE_SHA,
            "typescriptSha256": TYPESCRIPT_SHA,
            "typescriptPackageSha256": TYPESCRIPT_PACKAGE_SHA,
            "compiledSha256": metadata["compiledSha256"],
            "nativeHashes": metadata["nativeHashes"],
        },
        "pools": results,
    });
    verify_report(&report, &pools, &input_sha, "rust");
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("native-report.json"))
        .expect("exclusive native report");
    writeln!(out, "{report}").expect("write native report");
}
