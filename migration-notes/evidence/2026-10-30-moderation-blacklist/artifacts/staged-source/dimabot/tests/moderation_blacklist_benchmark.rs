#![cfg(feature = "moderation-blacklist")]
//! Manual sample runner. Integrator wires this test into the isolated snapshot.
use dima_rust::utils::js_string::JsString;
use dima_rust::utils::moderation::blacklist::{compile_blacklist_pattern, evaluate_blacklist_rule, BlacklistRule};
use serde_json::{json, Value};
#[path = "support/sha256.rs"]
mod digest;
use digest::sha256_hex;
use std::{env, fs, hint::black_box, time::Instant};

fn string(v: &Value) -> JsString {
    JsString::from_units(v.as_array().unwrap().iter().map(|n| u16::try_from(n.as_u64().unwrap()).unwrap()).collect())
}

#[test]
#[ignore = "isolated manual benchmark sample"]
fn benchmark_sample() {
    let path = env::var("DIMA_BLACKLIST_BENCHMARK_FIXTURE").unwrap();
    assert!(std::path::Path::new(&path).is_absolute());
    let bytes = fs::read(path).unwrap();
    let input_sha256 = sha256_hex(&bytes);
    let expected_sha = env::var("DIMA_BLACKLIST_BENCHMARK_SHA256").unwrap();
    assert!(expected_sha.len() == 64 && expected_sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(input_sha256, expected_sha);
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let suite = env::var("DIMA_BLACKLIST_BENCH_SUITE").unwrap();
    let cases = data["suites"][&suite].as_array().unwrap();
    let iterations: usize = env::var("DIMA_BLACKLIST_BENCH_ITERATIONS").unwrap().parse().unwrap();
    assert!((1..=100_000).contains(&iterations));
    let pool: Vec<_> = cases.iter().map(|c| {
        let terms: Vec<_> = c["terms"].as_array().unwrap().iter().map(string).collect();
        let pattern = compile_blacklist_pattern(Some(&terms));
        let rule = BlacklistRule { terms };
        (rule, string(&c["text"]), pattern)
    }).collect();
    // Validate complete outputs before entering the timed region.
    for ((rule,text,pattern),case) in pool.iter().zip(cases) {
        let got = evaluate_blacklist_rule(rule, Some(text), pattern.as_ref());
        assert_eq!(json!({"triggered":got.triggered,"matchedText":got.matched_text.as_ref().map(JsString::units)}),case["evaluation"]);
    }
    for _ in 0..3 {
        let mut retained = Vec::with_capacity(iterations * pool.len());
        for _ in 0..iterations {
            for (rule,text,pattern) in &pool {
                retained.push(black_box(evaluate_blacklist_rule(black_box(rule), Some(black_box(text)), black_box(pattern.as_ref()))));
            }
        }
        assert_eq!(retained.len(), iterations * pool.len());
        drop(retained);
    }
    let mut results = Vec::with_capacity(iterations * pool.len());
    let start = Instant::now();
    for _ in 0..iterations {
        for (rule,text,pattern) in &pool {
            results.push(black_box(evaluate_blacklist_rule(black_box(rule), Some(black_box(text)), black_box(pattern.as_ref()))));
        }
    }
    let elapsed = start.elapsed().as_nanos();
    let mut checksum: u32 = 2_166_136_261;
    for (i,result) in results.iter().enumerate() {
        let actual = json!({"triggered":result.triggered,"matchedText":result.matched_text.as_ref().map(JsString::units)});
        assert_eq!(actual,cases[i % cases.len()]["evaluation"]);
        let mut add = |n: u32| checksum = (checksum ^ n).wrapping_mul(16_777_619);
        add(u32::from(result.triggered));
        if let Some(text) = &result.matched_text { for unit in text.code_units() { add(u32::from(unit)); } }
        add(65_536);
    }
    println!("{}",json!({"actor":"rust","suite":suite,"iterations":iterations,"operations":results.len(),"nanoseconds":elapsed.to_string(),"checksum":checksum,"warmups":3,"inputSha256":input_sha256}));
}
