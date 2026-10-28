use dima_rust::utils::js_date::{parse_date, parse_date_utf16};
use serde_json::Value;

#[test]
fn matches_pinned_v8_date_parse_in_process_timezone() {
    let zone =
        std::env::var("TZ").expect("set TZ to a fixture zone before starting the test process");
    assert!(
        [
            "UTC",
            "America/New_York",
            "Europe/Berlin",
            "Australia/Lord_Howe",
            "Pacific/Apia"
        ]
        .contains(&zone.as_str()),
        "unsupported TZ: {zone}"
    );
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/js_date_cases.json"
    );
    let content =
        std::fs::read_to_string(path).expect("generate the pinned V8 fixture before testing");
    let corpus: Value = serde_json::from_str(&content).expect("valid fixture JSON");
    let cases = corpus["cases"].as_array().expect("fixture cases");
    let expected = corpus["results"][&zone]
        .as_array()
        .expect("fixture results for TZ");
    assert!(!cases.is_empty(), "fixture must not be empty");
    assert_eq!(cases.len(), expected.len());
    for (index, (case, result)) in cases.iter().zip(expected).enumerate() {
        let units: Vec<u16> = case["units"]
            .as_array()
            .expect("units")
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().expect("numeric unit")).expect("UTF-16 unit"))
            .collect();
        let expected = if result.is_null() {
            None
        } else {
            Some(result.as_i64().expect("integer result"))
        };
        assert_eq!(
            parse_date_utf16(&units),
            expected,
            "case {index} ({}) {units:?} in {zone}",
            case["group"]
        );
        if let Ok(input) = String::from_utf16(&units) {
            assert_eq!(
                parse_date(&input),
                expected,
                "string case {index} ({}) {units:?} in {zone}",
                case["group"]
            );
        }
    }
}

// Run this ignored test in release mode in a fresh process with the same TZ and
// workload as js_date_benchmark.mjs. Fixture decoding is outside timed loops.
#[test]
#[ignore]
fn benchmark_date_parse() {
    use std::hint::black_box;
    use std::time::Instant;

    let zone = std::env::var("TZ").expect("TZ must be set");
    assert!(
        [
            "UTC",
            "America/New_York",
            "Europe/Berlin",
            "Australia/Lord_Howe",
            "Pacific/Apia"
        ]
        .contains(&zone.as_str())
    );
    let workload = std::env::var("JS_DATE_BENCH_WORKLOAD").expect("set JS_DATE_BENCH_WORKLOAD");
    assert!(["iso", "legacy", "invalid", "mixed"].contains(&workload.as_str()));
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/js_date_cases.json"
    );
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture required")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let expected = corpus["results"][&zone].as_array().expect("fixture TZ");
    assert_eq!(cases.len(), expected.len());
    let inputs: Vec<Vec<u16>> = cases
        .iter()
        .zip(expected)
        .filter(|(case, value)| match workload.as_str() {
            "iso" => case["group"] == "iso",
            "legacy" => case["group"] == "legacy",
            "invalid" => value.is_null(),
            "mixed" => true,
            _ => unreachable!(),
        })
        .map(|(case, _)| {
            case["units"]
                .as_array()
                .unwrap()
                .iter()
                .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
                .collect()
        })
        .collect();
    assert!(!inputs.is_empty());
    let run = |iterations: usize| {
        let mut checksum = 0_u32;
        let mut valid = 0_u32;
        for i in 0..iterations {
            let result = black_box(parse_date_utf16(black_box(&inputs[i % inputs.len()])));
            if let Some(value) = result {
                valid += 1;
                checksum = checksum.wrapping_add(value as u32);
            }
            checksum = checksum.wrapping_add(i as u32);
        }
        (checksum, valid, iterations as u32 - valid)
    };
    black_box(run(10_000));
    let mut samples = Vec::new();
    let mut result = None;
    for _ in 0..7 {
        let start = Instant::now();
        let outcome = run(100_000);
        let elapsed_ns = start.elapsed().as_nanos() as u64;
        if let Some(previous) = result {
            assert_eq!(previous, outcome);
        }
        result = Some(outcome);
        samples.push(elapsed_ns);
    }
    let (checksum, valid, invalid) = result.unwrap();
    let output = serde_json::json!({"runtime":"rust", "zone":zone, "workload":workload,
        "cases":inputs.len(), "iterations":100_000, "warmup":10_000,
        "samplesNs":samples, "checksum":checksum, "valid":valid, "invalid":invalid});
    let output = serde_json::to_string(&output).unwrap();
    if let Ok(path) = std::env::var("JS_DATE_BENCH_OUTPUT") {
        std::fs::write(path, &output).unwrap();
    }
    println!("{output}");
}
