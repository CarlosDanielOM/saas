#![cfg(feature = "moderation-spam")]
//! One fresh-process matched pure-operation sample; coordinator runs seven pairs.
#[path = "support/moderation_spam.rs"]
mod support;
use serde_json::{Value, json};
use std::{env, hint::black_box, time::Instant};
use support::*;
#[test]
#[ignore = "isolated release benchmark sample"]
fn benchmark_sample() {
    let bytes = external_bytes(
        &env::var("DIMA_SPAM_BENCHMARK_FIXTURE").unwrap(),
        &env::var("DIMA_SPAM_BENCHMARK_SHA256").unwrap(),
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(data["format"], 1);
    let names = [
        "invitation",
        "settings",
        "rule_context",
        "review_policy",
        "marker",
    ];
    // Full source outputs for every workload are checked before warmups/timing.
    for name in names {
        let cases = data["workloads"][name].as_array().unwrap();
        assert_eq!(cases.len(), 32);
        for c in cases {
            check_result(Prepared::from_case(c).run(), &c["result"], name);
        }
    }
    let workload = env::var("DIMA_SPAM_BENCH_WORKLOAD").unwrap();
    assert!(names.contains(&workload.as_str()));
    let cases = data["workloads"][&workload].as_array().unwrap();
    let pool = cases.iter().map(Prepared::from_case).collect::<Vec<_>>();
    let rounds = env::var("DIMA_SPAM_BENCH_ROUNDS")
        .unwrap_or_else(|_| "250".into())
        .parse::<usize>()
        .unwrap();
    assert!((1..=500).contains(&rounds));
    let count = rounds * 32;
    // Initialize the native lazy template before either actor's timed interval.
    black_box(dima_rust::utils::moderation::spam::spam_rule());
    for _ in 0..3 {
        let mut retained = Vec::with_capacity(count);
        for _ in 0..rounds {
            for c in &pool {
                retained.push(black_box(black_box(c).run().unwrap()));
            }
        }
        assert_eq!(retained.len(), count);
        drop(retained);
    }
    let mut results = Vec::with_capacity(count);
    let start = Instant::now();
    for _ in 0..rounds {
        for c in &pool {
            results.push(black_box(black_box(c).run().unwrap()));
        }
    }
    let elapsed = start.elapsed().as_nanos();
    for (i, result) in results.iter().enumerate() {
        assert_eq!(wire(result), cases[i % 32]["result"]["value"]);
    }
    println!(
        "{}",
        json!({"format":1,"actor":"rust","workload":workload,"rounds":rounds,"operations":count,"warmups":3,"warmupOperations":count*3,"nanoseconds":elapsed.to_string(),"checksum":checksum(&results),"inputSha256":env::var("DIMA_SPAM_BENCHMARK_SHA256").unwrap()})
    );
}
