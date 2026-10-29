#![cfg(feature = "tts-utilities")]

// Owner-only, isolated release benchmark. The runner must independently hash
// the exact input bytes before AND after this test and supply the resulting
// lowercase SHA-256 as DIMA_TTS_LOSSLESS_INPUT_SHA256. tts-utilities does not
// enable the optional sha2 dependency. Node --check also hashes the bytes.
// Measures each prepared function and the wrapping sum of all output UTF-16
// units; setup, JSON and I/O are excluded. Median is microseconds per operation.
// No CPU, RSS, provider, or production behavior is measured.
use dima_rust::{
    pet_speech_text::filter_pet_talk_text,
    utils::{
        js_string::JsString,
        lossless_json::parse_json,
        tts::{NormalizeTtsMessageOptions, TtsProvider, normalize_tts_message_js},
    },
};
use serde_json::{Value, json};
use std::{hint::black_box, path::PathBuf, time::Instant};

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("unit array required")
        .iter()
        .map(|unit| {
            u16::try_from(unit.as_u64().expect("unsigned unit required"))
                .expect("invalid UTF-16 unit")
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
fn prepared_lossless_operations() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_TTS_LOSSLESS_BENCHMARK_DIR").expect("benchmark directory required"),
    );
    let input_hash = std::env::var("DIMA_TTS_LOSSLESS_INPUT_SHA256")
        .expect("externally verified input SHA-256 required");
    assert!(
        input_hash.len() == 64
            && input_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid SHA-256"
    );
    let bytes = std::fs::read(dir.join("tts-lossless-benchmark-inputs.json"))
        .expect("source-generated input required");
    assert!(!bytes.is_empty(), "empty benchmark input");
    let fixture: Value =
        serde_json::from_slice(&bytes).expect("valid benchmark input JSON required");
    assert_eq!(fixture["schema"], 1);
    assert_eq!(fixture["warmups"], 100);
    assert_eq!(fixture["samples"], 7);
    assert_eq!(
        fixture["measurement"],
        "function plus wrapping UTF-16 unit sum"
    );
    let workloads = fixture["workloads"].as_array().expect("workloads required");
    assert!(!workloads.is_empty(), "empty benchmark workloads");
    let source: Value = serde_json::from_slice(
        &std::fs::read(dir.join("tts-lossless-node-benchmark.json"))
            .expect("source report required"),
    )
    .expect("valid source report required");
    assert_eq!(source["implementation"], "actual-typescript");
    assert_eq!(source["inputSha256"], input_hash);
    assert_eq!(source["warmups"], 100);
    assert_eq!(source["measurement"], fixture["measurement"]);
    let source_runs = source["runs"].as_array().expect("source runs required");
    assert_eq!(source_runs.len(), workloads.len());
    let output_path = dir.join("tts-lossless-rust-benchmark.json");
    assert!(!output_path.exists(), "native report already exists");
    let mut runs = Vec::new();
    for (index, w) in workloads.iter().enumerate() {
        let name = w["name"].as_str().expect("name required");
        let op = w["op"].as_str().expect("operation required");
        assert!(op == "normalize" || op == "pet", "invalid operation");
        let text = JsString::from_units(units(&w["inputUnits"]));
        assert!(!text.is_empty(), "empty benchmark input for {name}");
        let emotes: Vec<JsString> = w["emoteUnits"]
            .as_array()
            .expect("emotes required")
            .iter()
            .map(|v| JsString::from_units(units(v)))
            .collect();
        let opts = &w["options"];
        let options = NormalizeTtsMessageOptions {
            skip_emotes: opts["skipEmotes"].as_bool().expect("skipEmotes required"),
            strip_links: opts["stripLinks"].as_bool().expect("stripLinks required"),
            normalize_whitespace: opts["normalizeWhitespace"]
                .as_bool()
                .expect("normalizeWhitespace required"),
            max_length: opts["maxLength"].as_f64().expect("maxLength required"),
            emote_names: &emotes,
        };
        let provider = match (op, w["provider"].as_str()) {
            ("normalize", None) if w["provider"].is_null() => TtsProvider::Piper,
            ("pet", Some("fish")) => TtsProvider::Fish,
            ("pet", Some("piper")) => TtsProvider::Piper,
            _ => panic!("invalid provider for {name}"),
        };
        let tags = if op == "pet" {
            Some(
                parse_json(&serde_json::to_string(&w["tags"]).expect("serialize tags"))
                    .expect("parse lossless tags"),
            )
        } else {
            assert!(w["tags"].is_null());
            None
        };
        let expected = units(&w["expectedUnits"]);
        let per_op = expected
            .iter()
            .fold(0u32, |sum, unit| sum.wrapping_add(u32::from(*unit)));
        assert_eq!(
            w["expectedUnitsChecksum"].as_u64(),
            Some(u64::from(per_op)),
            "{name}"
        );
        let iterations = w["iterations"].as_u64().expect("iterations required");
        assert!(
            iterations > 0 && iterations <= 10_000,
            "invalid iteration count"
        );
        let total = per_op.wrapping_mul(u32::try_from(iterations).unwrap());
        let run = || {
            if op == "normalize" {
                normalize_tts_message_js(black_box(&text), black_box(&options)).text
            } else {
                filter_pet_talk_text(
                    black_box(&text),
                    provider,
                    black_box(&options),
                    black_box(tags.as_ref()),
                )
                .text
            }
        };
        let actual = run();
        assert_eq!(actual.units(), expected, "output mismatch for {name}");
        assert_eq!(checksum(&actual), per_op, "checksum mismatch for {name}");
        let node = &source_runs[index];
        assert_eq!(node["name"], name);
        assert_eq!(node["op"], op);
        assert_eq!(node["provider"], w["provider"]);
        assert_eq!(node["iterations"], iterations);
        assert_eq!(node["expectedUnitsChecksum"], per_op);
        assert_eq!(node["resultChecksum"], total);
        let node_samples = node["samples"].as_array().expect("source samples required");
        assert_eq!(node_samples.len(), 7);
        for sample in node_samples {
            assert!(
                sample["elapsedNs"].as_u64().is_some_and(|n| n > 0),
                "invalid source elapsed time"
            );
            assert_eq!(sample["checksum"], total);
        }
        for _ in 0..100 {
            black_box(checksum(&run()));
        }
        let mut samples = Vec::new();
        let mut elapsed_times = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let mut sum = 0u32;
            for _ in 0..iterations {
                let output = black_box(run());
                for unit in output.code_units() {
                    sum = sum.wrapping_add(u32::from(unit));
                }
            }
            let elapsed = u64::try_from(start.elapsed().as_nanos()).expect("elapsed overflow");
            black_box(sum);
            assert!(elapsed > 0, "empty timing sample");
            assert_eq!(sum, total, "sample checksum mismatch for {name}");
            samples.push(json!({"elapsedNs":elapsed,"checksum":sum}));
            elapsed_times.push(elapsed);
        }
        elapsed_times.sort_unstable();
        let median_us = (elapsed_times[3] as f64 / iterations as f64) / 1000.0;
        runs.push(json!({"name":name,"op":op,"provider":w["provider"],"iterations":iterations,"expectedUnitsChecksum":per_op,"resultChecksum":total,"samples":samples,"medianUsPerOp":median_us}));
    }
    let report = json!({"implementation":"native-rust","inputSha256":input_hash,"warmups":100,"measurement":fixture["measurement"],"runs":runs});
    std::fs::write(
        output_path,
        serde_json::to_string_pretty(&report).unwrap() + "\n",
    )
    .expect("write native report");
}
