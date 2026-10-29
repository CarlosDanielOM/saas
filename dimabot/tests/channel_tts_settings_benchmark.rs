#![cfg(feature = "channel-tts-settings")]
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    tts::settings::normalize_channel_tts_settings,
};
use serde_json::{Value, json};
use std::{hint::black_box, time::Instant};

#[test]
#[ignore = "owner-only isolated release benchmark; requires source-generated inputs"]
fn prepared_settings_json_utf8_checksum() {
    let input_path = std::env::var("CHANNEL_TTS_SETTINGS_BENCHMARK_INPUTS")
        .expect("source benchmark input required");
    let data: Value = serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
    let string = |raw: &Value| match parse_json(raw.as_str().unwrap()).unwrap() {
        JsonValue::String(s) => s,
        _ => panic!("string required"),
    };
    let id: JsString = string(&data["idJson"]);
    let channel: JsString = string(&data["channelJson"]);
    let mut runs = Vec::new();
    for w in data["workloads"].as_array().unwrap() {
        let input = parse_json(w["inputJson"].as_str().unwrap()).unwrap();
        let expected = w["outputJson"].as_str().unwrap();
        let run = || {
            normalize_channel_tts_settings(
                Some(black_box(&input)),
                black_box(&id),
                black_box(&channel),
            )
            .unwrap()
            .to_json_string()
        };
        assert_eq!(run(), expected, "{}", w["name"]);
        let checksum = |bytes: &[u8]| {
            bytes
                .iter()
                .fold(0u32, |n, b| n.wrapping_add(u32::from(*b)))
        };
        for _ in 0..100 {
            let output = run();
            black_box(checksum(output.as_bytes()));
        }
        let iterations = w["iterations"].as_u64().unwrap();
        let mut samples = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let mut bytes = 0u64;
            let mut sum = 0u32;
            for _ in 0..iterations {
                let output = black_box(run());
                bytes += output.len() as u64;
                sum = sum.wrapping_add(checksum(output.as_bytes()));
            }
            samples.push(json!({"elapsedNs":start.elapsed().as_nanos().to_string(),"bytes":bytes,"checksum":sum}));
        }
        runs.push(json!({"name":w["name"],"iterations":iterations,"samples":samples}));
    }
    let result = json!({"implementation":"native-rust","scope":"prepared normalize + JSON + UTF-8 + full byte sum","warmups":100,"runs":runs});
    let output =
        std::env::var("CHANNEL_TTS_SETTINGS_BENCHMARK_OUTPUT").expect("output path required");
    std::fs::write(
        output,
        serde_json::to_string_pretty(&result).unwrap() + "\n",
    )
    .unwrap();
    println!("{result}");
}
