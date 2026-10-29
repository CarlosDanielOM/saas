#![cfg(feature = "ai-usage-producer")]
//! Parent-owned isolated release benchmark. The parent independently hashes the
//! input before and after this run and supplies that SHA256 in the environment.
//! Rust strings already contain UTF-8; unlike Node's Buffer.from, no separate
//! encoding allocation is needed. Both paths sum every resulting wire byte.
use dima_rust::utils::{
    ai_usage::AiUsageContext,
    ai_usage_producer::{build_queued_ai_usage_receipt, build_queued_ai_usage_receipt_at},
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use serde_json::{Value, json};
use std::{hint::black_box, io::Write, time::Instant};

const LABEL: &str = "prepared receipt builder + JSON + UTF-8 byte sum";
const NAMES: [&str; 5] = [
    "typed-ascii",
    "typed-unicode",
    "lossless-nullish",
    "lossless-surrogate",
    "lossless-large",
];
struct Item {
    channel: String,
    customer: String,
    channel_js: JsString,
    customer_js: JsString,
    date: JsDate,
    credits: f64,
    typed: Option<AiUsageContext>,
    lossless: Option<JsonValue>,
    wire: String,
    checksum: u32,
}
fn uint(v: &Value) -> u64 {
    v.as_u64().expect("unsigned fixture integer")
}
fn text(v: &Value) -> &str {
    v.as_str().expect("fixture string")
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn sum_bytes(s: &str) -> u32 {
    s.bytes()
        .fold(0u32, |sum, b| sum.wrapping_add(u32::from(b)))
}
fn build(item: &Item) -> String {
    let receipt = if let Some(c) = &item.typed {
        build_queued_ai_usage_receipt(
            black_box(&item.channel),
            black_box(&item.customer),
            Some(item.date),
            black_box(c),
            black_box(item.credits),
        )
    } else {
        build_queued_ai_usage_receipt_at(
            black_box(&item.channel_js).clone(),
            black_box(&item.customer_js).clone(),
            Some(item.date),
            item.date,
            black_box(item.lossless.as_ref().unwrap()),
            black_box(item.credits),
        )
    }
    .expect("prepared valid receipt");
    black_box(receipt).json()
}
fn run(pool: &[Item], count: usize) -> u32 {
    let mut total = 0u32;
    for i in 0..count {
        let wire = black_box(build(black_box(&pool[i % pool.len()])));
        total = total.wrapping_add(sum_bytes(black_box(&wire)));
    }
    black_box(total)
}
#[test]
#[ignore = "parent-owned isolated release benchmark with independently hashed input"]
fn matched_prepared_receipts() {
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_AI_USAGE_PRODUCER_BENCHMARK_DIR")
            .expect("benchmark directory required"),
    );
    let supplied = std::env::var("DIMA_AI_USAGE_PRODUCER_INPUT_SHA256")
        .expect("independent input SHA256 required");
    assert!(digest(&supplied));
    let bytes =
        std::fs::read(dir.join("ai-usage-producer-benchmark-input.json")).expect("input required");
    assert!(!bytes.is_empty());
    let input: Value = serde_json::from_slice(&bytes).expect("valid input");
    assert_eq!(uint(&input["format"]), 1);
    assert_eq!(text(&input["label"]), LABEL);
    assert_eq!(text(&input["node"]), "v24.22.1");
    assert_eq!(text(&input["v8"]), "13.6.233.17-node.58");
    assert_eq!(text(&input["typescript"]), "5.9.3");
    assert!(digest(text(&input["extractedSha256"])));
    let hashes = input["hashes"].as_object().expect("hashes");
    for key in [
        "src/utils/ai_usage_ledger.ts",
        "src/utils/ai_usage_classification.ts",
        "src/utils/ai_usage_event.ts",
        "src/utils/ai_usage_receipts.ts",
        "src/schemas/ai_usage_receipt.schema.ts",
        "src/utils/ai_usage_producer.rs",
        "src/utils/ai_usage.rs",
        "src/utils/credit_policy.rs",
        "src/utils/js_string.rs",
        "src/utils/lossless_json.rs",
        "src/utils/json_number.rs",
        "src/utils/js_compat.rs",
        "src/utils/ai_usage_receipts/values.rs",
        "src/utils/ai_usage_receipts/queue.rs",
        "src/utils/ai_usage_receipts.rs",
        "tests/fixtures/ai_usage_producer_source.cjs",
        "tests/fixtures/ai_usage_producer_reference.cjs",
        "tests/fixtures/ai_usage_producer_benchmark.cjs",
        "tests/ai_usage_producer_benchmark.rs",
        "package.json",
        "package-lock.json",
        "node",
        "typescript",
        "typescriptPackage",
    ] {
        assert!(digest(text(&hashes[key])), "missing hash {key}");
    }
    let node: Value = serde_json::from_slice(
        &std::fs::read(dir.join("ai-usage-producer-node-benchmark.json"))
            .expect("node report required"),
    )
    .expect("node report JSON");
    assert_eq!(uint(&node["format"]), 1);
    assert_eq!(text(&node["label"]), LABEL);
    assert_eq!(text(&node["runtime"]), "node-commonjs");
    assert_eq!(text(&node["inputSha256"]), supplied);
    let workloads = input["workloads"].as_array().expect("workloads");
    let reports = node["workloads"].as_array().expect("node workloads");
    assert_eq!(workloads.len(), NAMES.len());
    assert_eq!(reports.len(), NAMES.len());
    let mut prepared = Vec::new();
    for (index, w) in workloads.iter().enumerate() {
        assert_eq!(text(&w["name"]), NAMES[index]);
        let kind = text(&w["kind"]);
        assert_eq!(kind, if index < 2 { "typed" } else { "lossless" });
        let count = uint(&w["iterations"]) as usize;
        let warmup = uint(&w["warmup"]) as usize;
        assert_eq!(count, if index == 4 { 32768 } else { 262144 });
        assert_eq!(warmup, 32000);
        let source = w["pool"].as_array().expect("pool");
        assert_eq!(source.len(), 32);
        let mut pool = Vec::with_capacity(32);
        for p in source {
            let context = text(&p["contextJson"]);
            let wire = text(&p["wire"]).to_owned();
            assert!(!wire.is_empty());
            let item = Item {
                channel: text(&p["channelID"]).to_owned(),
                customer: text(&p["customerId"]).to_owned(),
                channel_js: JsString::from(text(&p["channelID"])),
                customer_js: JsString::from(text(&p["customerId"])),
                date: JsDate::from_millis(p["occurredAtMs"].as_f64().expect("date")),
                credits: p["credits"].as_f64().expect("credits"),
                typed: if kind == "typed" {
                    Some(serde_json::from_str(context).expect("typed context"))
                } else {
                    None
                },
                lossless: if kind == "lossless" {
                    Some(parse_json(context).expect("lossless context"))
                } else {
                    None
                },
                wire,
                checksum: u32::try_from(uint(&p["checksum"])).expect("u32 checksum"),
            };
            assert_eq!(sum_bytes(&item.wire), item.checksum);
            assert_eq!(
                build(&item),
                item.wire,
                "source wire mismatch for {}",
                NAMES[index]
            );
            pool.push(item);
        }
        let expected = (0..count).fold(0u32, |s, i| s.wrapping_add(pool[i % 32].checksum));
        let n = &reports[index];
        assert_eq!(text(&n["name"]), NAMES[index]);
        assert_eq!(uint(&n["iterations"]) as usize, count);
        assert_eq!(uint(&n["warmup"]) as usize, warmup);
        assert_eq!(uint(&n["checksum"]), u64::from(expected));
        let sums = n["sampleChecksums"]
            .as_array()
            .expect("per-trial source checksums");
        assert_eq!(sums.len(), 7);
        assert!(sums.iter().all(|s| uint(s) == u64::from(expected)));
        let samples = n["samples"].as_array().expect("node samples");
        assert_eq!(samples.len(), 7);
        let mut ns: Vec<u64> = samples.iter().map(uint).collect();
        assert!(ns.iter().all(|x| *x > 0 && *x <= 9_007_199_254_740_991));
        ns.sort_unstable();
        assert_eq!(uint(&n["medianNs"]), ns[3]);
        prepared.push((pool, count, warmup, expected));
    }
    let mut results = Vec::new();
    for (index, (pool, count, warmup, expected)) in prepared.into_iter().enumerate() {
        black_box(run(&pool, warmup));
        let mut times = Vec::new();
        let mut sample_checksums = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let actual = run(&pool, count);
            let elapsed = u64::try_from(start.elapsed().as_nanos()).expect("elapsed overflow");
            assert!(elapsed > 0 && elapsed <= 9_007_199_254_740_991);
            assert_eq!(actual, expected);
            times.push(elapsed);
            sample_checksums.push(actual);
        }
        let mut sorted = times.clone();
        sorted.sort_unstable();
        results.push(json!({"name":NAMES[index],"iterations":count,"warmup":warmup,"checksum":expected,"samples":times,"sampleChecksums":sample_checksums,"medianNs":sorted[3]}));
    }
    let report = json!({"format":1,"label":LABEL,"runtime":"rust-release","inputSha256":supplied,"workloads":results});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("ai-usage-producer-rust-benchmark.json"))
        .expect("exclusive report creation");
    serde_json::to_writer_pretty(&mut file, &report).expect("write report");
    file.write_all(b"\n").expect("newline");
}
