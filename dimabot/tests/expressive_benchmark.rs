#![cfg(feature = "tts-utilities")]

// Owner-only prepared-operation benchmark. Prepare inputs with the actual TS
// script first; all file IO, configuration and JsString construction precede
// timing. Run release mode with EXPRESSIVE_TTS_BENCHMARK_DIR set to that DIR.
use dima_rust::utils::{
    js_string::JsString,
    tts::{TtsProvider, filter_expressive_tts_tags_js, reinforce_fish_tts_tags_js},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, hint::black_box, path::PathBuf, time::Instant};

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("unit array required")
        .iter()
        .map(|v| {
            u16::try_from(v.as_u64().expect("unit must be unsigned")).expect("unit exceeds UTF-16")
        })
        .collect()
}

fn checksum(value: &JsString) -> u32 {
    value
        .code_units()
        .fold(0u32, |sum, unit| sum.wrapping_add(u32::from(unit)))
}

#[test]
#[ignore = "owner-only isolated release benchmark with source-generated inputs"]
fn prepared_expressive_operations() {
    let dir = PathBuf::from(
        std::env::var_os("EXPRESSIVE_TTS_BENCHMARK_DIR").expect("benchmark directory required"),
    );
    let bytes = std::fs::read(dir.join("expressive-benchmark-inputs.json"))
        .expect("source-generated input required");
    assert!(!bytes.is_empty(), "empty benchmark input");
    // The isolated runner computes and verifies the file hash before and after
    // this test; the Node report and Rust report share that identity.
    let input_hash = std::env::var("EXPRESSIVE_TTS_INPUT_SHA256")
        .expect("externally verified input SHA-256 required");
    assert!(
        input_hash.len() == 64
            && input_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "invalid SHA-256"
    );
    let data: Value = serde_json::from_slice(&bytes).expect("valid benchmark input JSON required");
    assert_eq!(data["schema"], 1);
    assert_eq!(data["warmups"], 100);
    assert_eq!(data["samples"], 7);
    let workloads = data["workloads"].as_array().expect("workloads required");
    assert!(!workloads.is_empty(), "empty benchmark workloads");
    let node: Value = serde_json::from_slice(
        &std::fs::read(dir.join("expressive-node-benchmark.json"))
            .expect("source benchmark report required"),
    )
    .expect("valid source report required");
    assert_eq!(node["implementation"], "actual-typescript");
    assert_eq!(node["inputSha256"], input_hash);
    let node_runs = node["runs"].as_array().expect("source runs required");
    assert_eq!(node_runs.len(), workloads.len());
    let mut runs = Vec::new();
    for (index, w) in workloads.iter().enumerate() {
        let name = w["name"].as_str().expect("name required");
        let op = w["op"].as_str().expect("operation required");
        let text = JsString::from_units(units(&w["inputUnits"]));
        assert!(!text.is_empty(), "empty benchmark input for {name}");
        let expected = units(&w["expectedUnits"]);
        let expected_checksum = expected
            .iter()
            .fold(0u32, |sum, unit| sum.wrapping_add(u32::from(*unit)));
        assert_eq!(
            w["expectedUnitsChecksum"].as_u64(),
            Some(u64::from(expected_checksum)),
            "{name}"
        );
        let iterations = w["iterations"].as_u64().expect("iterations required");
        assert!(
            iterations > 0 && iterations <= 10_000,
            "invalid iteration count"
        );
        let provider = match w["provider"].as_str() {
            Some("fish") => TtsProvider::Fish,
            Some("piper") => TtsProvider::Piper,
            Some("kokoro") => TtsProvider::Kokoro,
            None if op == "reinforce" => TtsProvider::Fish,
            _ => panic!("invalid provider"),
        };
        let enabled: BTreeMap<String, bool> = if op == "filter" {
            w["enabled"]
                .as_object()
                .expect("enabled settings required")
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        value.as_bool().expect("boolean setting required"),
                    )
                })
                .collect()
        } else {
            assert_eq!(op, "reinforce");
            BTreeMap::new()
        };
        let run = || match op {
            "filter" => {
                filter_expressive_tts_tags_js(black_box(&text), provider, Some(black_box(&enabled)))
            }
            "reinforce" => reinforce_fish_tts_tags_js(black_box(&text)),
            _ => panic!("invalid operation"),
        };
        assert_eq!(run().units(), expected, "output mismatch for {name}");
        let expected_result_checksum =
            expected_checksum.wrapping_mul(u32::try_from(iterations).unwrap());
        let source = &node_runs[index];
        assert_eq!(source["name"], name);
        assert_eq!(source["iterations"], iterations);
        assert_eq!(source["expectedUnitsChecksum"], expected_checksum);
        assert_eq!(source["resultChecksum"], expected_result_checksum);
        let source_samples = source["samples"]
            .as_array()
            .expect("source samples required");
        assert_eq!(source_samples.len(), 7);
        for sample in source_samples {
            assert_eq!(sample["checksum"], expected_result_checksum);
        }
        for _ in 0..100 {
            black_box(checksum(&run()));
        }
        let mut samples = Vec::new();
        let mut per_op = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let mut sum = 0u32;
            for _ in 0..iterations {
                let output = black_box(run());
                for unit in output.code_units() {
                    sum = sum.wrapping_add(u32::from(unit));
                }
            }
            let elapsed = u64::try_from(start.elapsed().as_nanos()).unwrap();
            black_box(sum);
            assert_eq!(
                sum, expected_result_checksum,
                "sample checksum mismatch for {name}"
            );
            samples.push(json!({"elapsedNs":elapsed,"checksum":sum}));
            per_op.push(elapsed as f64 / iterations as f64);
        }
        per_op.sort_by(f64::total_cmp);
        let median = per_op[3];
        runs.push(json!({"name":name,"iterations":iterations,"expectedUnitsChecksum":expected_checksum,"resultChecksum":expected_result_checksum,"samples":samples,"medianNsPerOp":median,"medianUsPerOp":median / 1000.0}));
    }
    let result = json!({"implementation":"native-rust","scope":"prepared filter or reinforce + wrapping sum of every UTF-16 output unit","inputSha256":input_hash,"warmups":100,"runs":runs});
    std::fs::write(
        dir.join("expressive-rust-benchmark.json"),
        serde_json::to_string_pretty(&result).unwrap() + "\n",
    )
    .expect("write result");
}
