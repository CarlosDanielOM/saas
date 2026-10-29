#![cfg(feature = "moderation-caps")]
use dima_rust::utils::js_string::JsString;
use dima_rust::utils::moderation::caps::{
    CapsEvaluationInput, CapsEvaluationResult, CapsRule, CapsThresholdMode, evaluate_caps_rule,
};
use std::io::{self, BufRead, Write};

struct Item {
    text: JsString,
    emotes: Option<Vec<JsString>>,
    rule: CapsRule,
}
fn evaluate(item: &Item) -> CapsEvaluationResult {
    evaluate_caps_rule(
        item.rule,
        CapsEvaluationInput {
            text: Some(&item.text),
            emote_texts: item.emotes.as_deref(),
        },
    )
}

#[test]
#[ignore = "external paired benchmark coordinator required"]
fn prepared_benchmark_server() {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "release-only benchmark"
    );
    use dima_rust::utils::json_number::number_string;
    use serde_json::Value;
    let dir = std::env::var("DIMA_CAPS_REFERENCE_DIR").expect("reference directory");
    let bytes =
        std::fs::read(std::path::Path::new(&dir).join("moderation_caps_reference.json")).unwrap();
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let units = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect::<Vec<_>>()
    };
    let bits = |v: &Value| f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap());
    let mut pool = Vec::new();
    let mut ids = Vec::new();
    for case in data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["id"].as_str().unwrap().starts_with("bench-"))
    {
        ids.push(case["id"].as_str().unwrap().to_owned());
        let item = Item {
            text: JsString::from_units(units(&case["text"])),
            emotes: case["emotes"]
                .as_array()
                .map(|a| a.iter().map(|v| JsString::from_units(units(v))).collect()),
            rule: CapsRule {
                caps_threshold_mode: match case["mode"].as_str().unwrap() {
                    "count" => CapsThresholdMode::Count,
                    "percentage" => CapsThresholdMode::Percentage,
                    _ => panic!("invalid mode"),
                },
                min_caps_count: bits(&case["min"]),
                max_caps_percentage: bits(&case["max"]),
                min_message_length: bits(&case["length"]),
            },
        };
        assert!(
            item.rule.min_caps_count.is_finite()
                && item.rule.max_caps_percentage.is_finite()
                && item.rule.min_message_length.is_finite()
        );
        let result = evaluate(&item);
        assert_eq!(
            format!(
                "{{\"triggered\":{},\"capsCount\":{},\"letterCount\":{},\"capsPercentage\":{}}}",
                result.triggered,
                result.caps_count,
                result.letter_count,
                number_string(result.caps_percentage)
            ),
            case["wire"].as_str().unwrap()
        );
        assert_eq!(
            result.caps_percentage.to_bits(),
            bits(&case["percentage"]).to_bits()
        );
        pool.push(item);
    }
    assert_eq!(pool.len(), 8);
    let repetitions: usize = std::env::var("DIMA_CAPS_BENCH_REPETITIONS")
        .unwrap_or_else(|_| "2000".into())
        .parse()
        .unwrap();
    assert!((1..=100_000).contains(&repetitions));
    let total = pool.len() * repetitions;
    println!(
        "{}",
        serde_json::json!({"ready":true,"pool":ids,"repetitions":repetitions})
    );
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "quit" {
            break;
        }
        assert!(line == "warmup" || line == "run");
        // Reserve and initialize every slot before the timed section. Keep
        // all results alive through timing; checksum and drop happen later.
        let mut results = vec![None; total];
        let start = std::time::Instant::now();
        for (i, slot) in results.iter_mut().enumerate() {
            *slot = Some(std::hint::black_box(evaluate(std::hint::black_box(
                &pool[i % pool.len()],
            ))));
        }
        let elapsed = start.elapsed().as_nanos();
        let mut hash = 2_166_136_261u32;
        for result in results.into_iter().flatten() {
            let b = result.caps_percentage.to_bits();
            for n in [
                u32::from(result.triggered),
                result.caps_count as u32,
                result.letter_count as u32,
                (b >> 32) as u32,
                b as u32,
            ] {
                hash = (hash ^ n).wrapping_mul(16_777_619);
            }
        }
        println!(
            "{}",
            serde_json::json!({"elapsedNs":elapsed.to_string(),"checksum":hash,"total":total})
        );
        io::stdout().flush().unwrap();
    }
}
