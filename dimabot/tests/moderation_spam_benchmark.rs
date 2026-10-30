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

/// Read-view representation benchmark; all projections happen after the clock.
#[test]
#[ignore = "isolated release borrowed-view benchmark sample"]
fn benchmark_borrowed_sample() {
    use dima_rust::utils::moderation::spam::*;
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
    for name in names {
        let cases = data["workloads"][name].as_array().unwrap();
        assert_eq!(cases.len(), 32);
        for c in cases {
            let prepared = Prepared::from_case(c);
            let output = match &prepared {
                Prepared::Settings(s) => {
                    spam_protection_settings_view(s).map(|v| Output::Value(v.to_owned_json()))
                }
                Prepared::Rule(c, s) => {
                    spam_rule_for_json_context_view(c, s).map(|v| Output::Value(v.to_owned_json()))
                }
                _ => prepared.run(),
            };
            check_result(output, &c["result"], name);
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
    black_box(spam_rule());
    // Each monomorphized invocation stores the actual API result type only.
    fn measure<'a, T>(
        pool: &'a [Prepared],
        cases: &[Value],
        rounds: usize,
        workload: &str,
        run: impl Fn(&'a Prepared) -> T,
        project: impl Fn(&T) -> Output,
    ) {
        let count = rounds * pool.len();
        for _ in 0..3 {
            let mut retained = Vec::with_capacity(count);
            for _ in 0..rounds {
                for c in pool {
                    retained.push(black_box(run(black_box(c))));
                }
            }
            assert_eq!(retained.len(), count);
            drop(retained);
        }
        let mut retained = Vec::with_capacity(count);
        let start = Instant::now();
        for _ in 0..rounds {
            for c in pool {
                retained.push(black_box(run(black_box(c))));
            }
        }
        let elapsed = start.elapsed().as_nanos();
        let projected = retained.iter().map(project).collect::<Vec<_>>();
        for (i, result) in projected.iter().enumerate() {
            assert_eq!(wire(result), cases[i % 32]["result"]["value"]);
        }
        println!(
            "{}",
            json!({"format":1,"actor":"rust","representation":"borrowed-read-view","workload":workload,"rounds":rounds,"operations":count,"warmups":3,"warmupOperations":count*3,"nanoseconds":elapsed.to_string(),"checksum":checksum(&projected),"inputSha256":env::var("DIMA_SPAM_BENCHMARK_SHA256").unwrap()})
        );
    }
    #[derive(Clone, Copy)]
    enum ReviewResult {
        Bool(bool),
        Nullable(Option<&'static str>),
    }
    match workload.as_str() {
        "invitation" => measure(
            &pool,
            cases,
            rounds,
            &workload,
            |p| match p {
                Prepared::Invitation(c) => broadcaster_invited_promotion_value(c).unwrap(),
                _ => unreachable!(),
            },
            |v| Output::Bool(*v),
        ),
        "settings" => measure(
            &pool,
            cases,
            rounds,
            &workload,
            |p| match p {
                Prepared::Settings(s) => spam_protection_settings_view(s).unwrap(),
                _ => unreachable!(),
            },
            |v| Output::Value(v.to_owned_json()),
        ),
        "rule_context" => measure(
            &pool,
            cases,
            rounds,
            &workload,
            |p| match p {
                Prepared::Rule(c, s) => spam_rule_for_json_context_view(c, s).unwrap(),
                _ => unreachable!(),
            },
            |v| Output::Value(v.to_owned_json()),
        ),
        "review_policy" => measure(
            &pool,
            cases,
            rounds,
            &workload,
            |p| match p {
                Prepared::Review(f, s, t) => {
                    ReviewResult::Nullable(spam_review_source_value(*f, s, t.as_ref()).unwrap())
                }
                Prepared::Policy(s, d) => {
                    ReviewResult::Bool(semantic_policy_active_value(s.as_ref(), d).unwrap())
                }
                _ => unreachable!(),
            },
            |v| match v {
                ReviewResult::Bool(b) => Output::Bool(*b),
                ReviewResult::Nullable(n) => Output::Nullable(*n),
            },
        ),
        "marker" => measure(
            &pool,
            cases,
            rounds,
            &workload,
            |p| match p {
                Prepared::Marker(c, u) => {
                    dima_rust::utils::js_string::JsString::from(chatter_marker_id(c, u))
                }
                _ => unreachable!(),
            },
            |v| Output::String(v.clone()),
        ),
        _ => unreachable!(),
    }
}
