#![cfg(feature = "ai-usage-ledger-persistence")]
//! Prepared reducer benchmark; execute only in the capped, isolated compiler.
use dima_rust::utils::{
    ai_usage_ledger_persistence::{prepare_daily_inserts, reduce_daily_groups},
    ai_usage_producer::FixedReceiptClock,
    ai_usage_receipt_parser::RetentionTier,
    credit_policy::JsDate,
};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    hint::black_box,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::Instant,
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn prepared_hash(groups: &[Vec<Document>]) -> String {
    let mut digest = Sha256::new();
    for workload in groups {
        for group in workload {
            digest.update(mongodb::bson::serialize_to_vec(group).unwrap());
        }
    }
    format!("{:x}", digest.finalize())
}
fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *value = json!(n.as_f64().unwrap()),
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(items) => items.values_mut().for_each(normalize_numbers),
        _ => (),
    }
}
fn number(value: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
}
fn numeric(value: &Bson) -> f64 {
    match value {
        Bson::Double(v) => *v,
        Bson::Int32(v) => f64::from(*v),
        Bson::Int64(v) => *v as f64,
        _ => panic!("expected numeric BSON: {value:?}"),
    }
}
fn groups(input: &Value) -> Vec<Document> {
    input.as_array().unwrap().iter().map(|g| doc! {
        "_id": {"date": g["date"].as_str().unwrap(), "category": g["category"].as_str().unwrap()},
        "spent": number(&g["spent"]), "granted": number(&g["granted"]),
        "debited": number(&g["debited"]), "count": number(&g["count"]),
        "expiresAt": DateTime::from_millis(g["expiresAt"].as_i64().unwrap()),
    }).collect()
}
fn summary(docs: &[Document]) -> Value {
    Value::Array(docs.iter().map(|d| {
        let mut categories = serde_json::Map::new();
        for (name, entry) in d.get_document("categories").unwrap() {
            let entry = entry.as_document().unwrap();
            categories.insert(name.clone(), json!({"credits": numeric(entry.get("credits").unwrap()),
                "transactionCount": numeric(entry.get("transactionCount").unwrap())}));
        }
        json!({"date": d.get_str("date").unwrap(),
            "spentCredits": numeric(d.get("spentCredits").unwrap()),
            "grantedCredits": numeric(d.get("grantedCredits").unwrap()),
            "netConsumedCredits": numeric(d.get("netConsumedCredits").unwrap()),
            "transactionCount": numeric(d.get("transactionCount").unwrap()),
            "categories": categories, "expiresAt": d.get_datetime("expiresAt").unwrap().timestamp_millis()})
    }).collect())
}
fn node_request(
    input: &mut impl Write,
    output: &mut impl BufRead,
    op: &str,
    days: usize,
    iterations: usize,
) -> Value {
    writeln!(
        input,
        "{}",
        json!({"op": op, "days": days, "iterations": iterations})
    )
    .unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    assert!(
        output.read_line(&mut line).unwrap() > 0,
        "Node exited early"
    );
    serde_json::from_str(&line).unwrap()
}
fn native_trial(groups: &[Document], iterations: usize) -> (u128, usize) {
    let mut results = Vec::with_capacity(iterations);
    let start = Instant::now();
    for _ in 0..iterations {
        results.push(reduce_daily_groups(black_box(groups)).unwrap());
    }
    let elapsed = start.elapsed().as_nanos();
    // Retain all results until the timer stops. Consume and drop afterward.
    let count = black_box(&results).iter().map(|rows| rows.len()).sum();
    black_box(results);
    (elapsed, count)
}

#[test]
#[ignore = "manual benchmark: capped isolated compiler and fresh external fixture directory required"]
fn prepared_daily_reducer_matched_trials() {
    assert!(!black_box(cfg!(debug_assertions)), "use cargo test --release");
    let dir = PathBuf::from(std::env::var_os("DIMA_DAILY_REDUCER_BENCH_DIR").unwrap())
        .canonicalize()
        .unwrap();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(
        !dir.starts_with(&repo),
        "fixture directory must be external"
    );
    let input_bytes = fs::read(dir.join("inputs.json")).unwrap();
    let input_hash = hash(&input_bytes);
    let expected_input_hash =
        std::env::var("DIMA_DAILY_REDUCER_INPUT_SHA256").expect("independent input hash required");
    assert_eq!(
        input_hash, expected_input_hash,
        "common input does not match independent hash"
    );
    let inputs: Value = serde_json::from_slice(&input_bytes).unwrap();
    let expected: Value =
        serde_json::from_slice(&fs::read(dir.join("expected.json")).unwrap()).unwrap();
    let sizes = [1usize, 30, 90, 366, 3660];
    let prepared: Vec<_> = sizes
        .iter()
        .map(|n| groups(&inputs[n.to_string()]))
        .collect();
    let before_prepared = prepared_hash(&prepared);
    let clock = FixedReceiptClock(JsDate::from_millis(1_800_000_000_000.0));
    for (index, days) in sizes.iter().enumerate() {
        let rows = reduce_daily_groups(&prepared[index]).unwrap();
        let docs = prepare_daily_inserts(
            &"channel".into(),
            &"customer".into(),
            RetentionTier::Free,
            &rows,
            &clock,
        );
        let mut actual = summary(&docs);
        let mut reference = expected[days.to_string()].clone();
        normalize_numbers(&mut actual);
        normalize_numbers(&mut reference);
        assert_eq!(
            actual, reference,
            "source schema-compatible summary for {days}"
        );
        assert_eq!(rows.len(), *days);
    }
    let node = PathBuf::from(
        std::env::var_os("DIMA_DAILY_REDUCER_NODE").expect("absolute Node executable required"),
    );
    assert!(node.is_absolute(), "absolute Node executable required");
    let node_hash = hash(&fs::read(&node).unwrap());
    let expected_node_hash = std::env::var("DIMA_DAILY_REDUCER_NODE_SHA256")
        .expect("independent Node executable hash required");
    assert_eq!(
        node_hash, expected_node_hash,
        "Node executable does not match independent hash"
    );
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ai_usage_daily_reducer_benchmark.cjs");
    let mut child = Command::new(&node)
        .arg(fixture)
        .arg("--serve")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut results = Vec::new();
    for (index, days) in sizes.iter().enumerate() {
        let group_count = prepared[index].len();
        let warmup_ops = 100_000usize.div_ceil(group_count).clamp(3, 10_000);
        let timed_ops = 50_000usize.div_ceil(group_count).clamp(1, 1_000);
        assert_eq!(
            node_request(&mut stdin, &mut stdout, "warmup", *days, warmup_ops)["checksum"],
            *days * warmup_ops
        );
        assert_eq!(
            native_trial(&prepared[index], warmup_ops).1,
            *days * warmup_ops
        );
        for trial in 0..7 {
            let (node_result, native_result) = if trial % 2 == 0 {
                (
                    node_request(&mut stdin, &mut stdout, "trial", *days, timed_ops),
                    native_trial(&prepared[index], timed_ops),
                )
            } else {
                let native = native_trial(&prepared[index], timed_ops);
                (
                    node_request(&mut stdin, &mut stdout, "trial", *days, timed_ops),
                    native,
                )
            };
            assert_eq!(node_result["checksum"], *days * timed_ops);
            assert_eq!(node_result["iterations"], timed_ops);
            assert_eq!(native_result.1, *days * timed_ops);
            let node_ns = node_result["elapsedNs"].as_u64().unwrap();
            results.push(json!({"days": days, "groupCount": group_count, "warmupOps": warmup_ops,
                "timedOps": timed_ops, "trial": trial, "first": if trial % 2 == 0 {"node"} else {"rust"},
                "nodeNs": node_ns, "rustNs": native_result.0,
                "nodeNsPerOp": node_ns as f64 / timed_ops as f64,
                "rustNsPerOp": native_result.0 as f64 / timed_ops as f64, "checksum": native_result.1}));
        }
    }
    let finish = node_request(&mut stdin, &mut stdout, "finish", 0, 0);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    assert_eq!(finish["inputSha256"], input_hash);
    assert_eq!(finish["nodeExecutableSha256"], node_hash);
    assert_eq!(
        hash(&fs::read(dir.join("inputs.json")).unwrap()),
        input_hash
    );
    assert_eq!(prepared_hash(&prepared), before_prepared);
    let report = json!({"inputSha256Before": input_hash, "inputSha256After": hash(&fs::read(dir.join("inputs.json")).unwrap()),
        "rustPreparedSha256": before_prepared, "nodePreparedSha256": finish["preparedSha256"], "nodeExecutableSha256": node_hash,
        "nativeSourceSha256": hash(&fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/utils/ai_usage_ledger_persistence.rs")).unwrap()),
        "nodeSink": finish["sink"], "samples": results});
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("rust-node-trials.json"))
        .unwrap();
    writeln!(file, "{}", report).unwrap();
}
