//! Compare with tests/fixtures/pure_utils_reference.mjs --benchmark using the
//! same PURE_UTILS_ITERATIONS and PURE_UTILS_SAMPLES in isolated containers.

#[cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]
#[allow(dead_code)]
#[path = "../tests/fixtures/pure_utils_harness.rs"]
mod harness;

#[cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]
fn main() {
    use serde_json::json;

    let fixture = harness::fixture();
    let cases = harness::benchmark_cases(&fixture);
    for case in &cases {
        assert!(harness::json_equal(
            &harness::evaluate(case),
            &case["expected"]
        ));
        let result = harness::evaluate(case);
        let bytes = serde_json::to_vec(&result).unwrap();
        assert!(harness::json_equal(
            &serde_json::from_slice(&bytes).unwrap(),
            &case["expected"]
        ));
    }
    let setting = |name: &str, default| {
        std::env::var(name).ok().map_or(default, |value| {
            value.parse::<usize>().expect("positive benchmark count")
        })
    };
    let iterations = setting("PURE_UTILS_ITERATIONS", 100);
    let count = setting("PURE_UTILS_SAMPLES", 7);
    assert!(iterations > 0 && count > 0);
    let aggregate = measure(&cases, iterations, count, false);
    let operations = cases
        .iter()
        .map(|case| case["operation"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    let groups = operations
        .into_iter()
        .map(|operation| {
            let group = cases
                .iter()
                .copied()
                .filter(|case| case["operation"] == operation)
                .collect::<Vec<_>>();
            let mut measured = measure(&group, iterations, count, false);
            measured
                .as_object_mut()
                .unwrap()
                .insert("operation".into(), json!(operation));
            measured
        })
        .collect::<Vec<_>>();
    let mut serialized = measure(&cases, iterations, count, true);
    let operations = cases
        .iter()
        .map(|case| case["operation"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    let serialized_groups = operations
        .into_iter()
        .map(|operation| {
            let group = cases
                .iter()
                .copied()
                .filter(|case| case["operation"] == operation)
                .collect::<Vec<_>>();
            let mut measured = measure(&group, iterations, count, true);
            measured
                .as_object_mut()
                .unwrap()
                .insert("operation".into(), json!(operation));
            measured
        })
        .collect::<Vec<_>>();
    serialized
        .as_object_mut()
        .unwrap()
        .insert("groups".into(), json!(serialized_groups));
    let mut output = aggregate;
    let object = output.as_object_mut().unwrap();
    object.insert("implementation".into(), json!("rust"));
    object.insert("sources".into(), fixture["sources"].clone());
    object.insert("groups".into(), json!(groups));
    object.insert("serialized".into(), serialized);
    println!("{output}");
}

#[cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]
fn measure(
    cases: &[&serde_json::Value],
    iterations: usize,
    count: usize,
    serialize: bool,
) -> serde_json::Value {
    use serde_json::json;
    use std::{hint::black_box, time::Instant};
    let mut checksum = 0_u64;
    let mut serialized_bytes = 0_u64;
    let mut run = || {
        for _ in 0..iterations {
            for case in cases {
                let result = harness::evaluate(black_box(case));
                if serialize {
                    serialized_bytes +=
                        black_box(serde_json::to_vec(&result).unwrap()).len() as u64;
                }
                checksum += harness::checksum(black_box(&result));
            }
        }
    };
    run();
    let mut samples = Vec::new();
    let mut elapsed = Vec::new();
    for _ in 0..count {
        let cpu_before = cpu_ticks();
        let started = Instant::now();
        run();
        let nanos = started.elapsed().as_nanos() as u64;
        let cpu_after = cpu_ticks();
        elapsed.push(nanos);
        samples.push(json!({"elapsedNs":nanos,"cpuTicks":cpu_after.zip(cpu_before).map(|(after,before)|after-before),"rssBytes":rss_bytes()}));
    }
    elapsed.sort_unstable();
    json!({"workloadCases":cases.len(),"iterations":iterations,"samples":samples,"medianElapsedNs":elapsed[elapsed.len()/2],"checksum":checksum,"serializedBytes":serialized_bytes})
}

#[cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]
fn cpu_ticks() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
}

#[cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]
fn rss_bytes() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
                .map(|kb| kb * 1024)
        })
}

#[cfg(not(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
)))]
fn main() {
    eprintln!("Enable eventsub,chat-message,reward-body for the pure utility benchmark.");
    std::process::exit(2);
}
