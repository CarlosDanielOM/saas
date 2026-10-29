#![cfg(feature = "tts-utilities")]
// Parent verifies the input SHA-256 externally before and after the run.
use dima_rust::utils::tts::{TtsUsageResult, calculate_tts_usage};
use serde_json::{Value, json};
use std::{hint::black_box, time::Instant};

fn checksum(r: TtsUsageResult) -> u32 {
    ((r.characters * 100_000.0) as u32)
        .wrapping_add((r.credits_consumed * 100_000.0) as u32)
        .wrapping_add((r.polarsh_cost * 100_000.0) as u32)
        .wrapping_add((r.cost_usd * 100_000.0) as u32)
}

#[test]
#[ignore = "parent-owned isolated release benchmark"]
fn prepared_usage() {
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_TTS_USAGE_BENCHMARK_DIR").expect("directory required"),
    );
    let hash =
        std::env::var("DIMA_TTS_USAGE_INPUT_SHA256").expect("externally verified SHA-256 required");
    assert!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    );
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(dir.join("tts-usage-benchmark-input.json")).unwrap())
            .unwrap();
    let measurement = "prepared pool pricing plus four scalar scaled fields, wrapping u32";
    assert_eq!(fixture["schema"], 2);
    assert_eq!(fixture["warmupPasses"], 100);
    assert_eq!(fixture["samples"], 7);
    assert_eq!(fixture["measurement"], measurement);
    assert_eq!(fixture["metadata"]["executionRealm"], "node-commonjs-realm");
    let workloads = fixture["workloads"].as_array().unwrap();
    assert_eq!(workloads.len(), 6);
    let output = dir.join("tts-usage-rust-benchmark.json");
    assert!(!output.exists());
    let mut runs = Vec::new();
    for w in workloads {
        let name = w["name"].as_str().unwrap();
        let iterations = w["iterations"].as_u64().unwrap() as usize;
        assert_eq!(iterations, 262144);
        let entries = w["pool"].as_array().unwrap();
        assert_eq!(entries.len(), 32);
        let mut pool = Vec::new();
        let mut checksums = Vec::new();
        for entry in entries {
            let provider = entry["provider"].as_str().unwrap();
            let characters = entry["characters"].as_f64().unwrap();
            let result = calculate_tts_usage(provider, characters);
            assert_eq!(result.to_json_string(), entry["wire"].as_str().unwrap());
            for (n, bits) in [
                result.characters,
                result.credits_consumed,
                result.polarsh_cost,
                result.cost_usd,
            ]
            .into_iter()
            .zip(entry["fields"].as_array().unwrap())
            {
                assert_eq!(format!("{:016x}", n.to_bits()), bits.as_str().unwrap());
                let scaled = n * 100_000.0;
                assert!(scaled.is_finite() && (0.0..4_294_967_296.0).contains(&scaled));
            }
            let sum = checksum(result);
            assert_eq!(u64::from(sum), entry["checksum"].as_u64().unwrap());
            pool.push((provider, characters));
            checksums.push(sum);
        }
        let total = (0..iterations).fold(0u32, |sum, i| {
            sum.wrapping_add(checksums[i % checksums.len()])
        });
        assert_eq!(u64::from(total), w["resultChecksum"].as_u64().unwrap());
        let consume = || {
            let mut sum = 0u32;
            for i in 0..iterations {
                let (provider, characters) = black_box(pool[i % pool.len()]);
                let result = calculate_tts_usage(black_box(provider), black_box(characters));
                sum = sum.wrapping_add(checksum(black_box(result)));
            }
            black_box(sum)
        };
        for _ in 0..100 {
            assert_eq!(consume(), total);
        }
        let mut samples = Vec::new();
        let mut times = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let sum = consume();
            let elapsed = start.elapsed().as_nanos() as u64;
            assert!(elapsed > 0 && elapsed <= 9_007_199_254_740_991);
            assert_eq!(sum, total);
            times.push(elapsed);
            samples.push(json!({"elapsedNs":elapsed,"checksum":sum}));
        }
        times.sort_unstable();
        let median = times[3] as f64 / iterations as f64 / 1000.0;
        runs.push(json!({"name":name,"iterations":iterations,"resultChecksum":total,"samples":samples,"medianUsPerOp":median}));
    }
    let report = json!({"implementation":"native-rust","inputSha256":hash,"warmupPasses":100,"measurement":measurement,"runs":runs});
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
