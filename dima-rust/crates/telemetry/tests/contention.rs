//! Recording while a flush runs: the worst time a recording thread waits.
//!
//! Prints the measured figures (`cargo test --test contention -- --nocapture`). The bound is
//! generous (an unoptimised build on a loaded laptop, where the scheduler alone can pause a
//! thread for milliseconds); the printed numbers are the measurement. Before a flush swapped each
//! shard's map out, it held a shard's lock for the whole copy and merge (about 4.5 ms for 2000
//! series in this build), and every recording thread of that shard waited for it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

const PRODUCERS: usize = 4;
const SERIES_PER_PRODUCER: usize = 500;

#[test]
fn recording_waits_at_most_for_a_swap_while_a_flush_runs() {
    let telemetry = support::in_memory(0.0);
    let stop = Arc::new(AtomicBool::new(false));
    let recorded = Arc::new(AtomicU64::new(0));
    let producers: Vec<_> = (0..PRODUCERS)
        .map(|producer| {
            let telemetry = telemetry.clone();
            let stop = stop.clone();
            let recorded = recorded.clone();
            // Names are fixed at start-up, as in a real process.
            let names: Vec<&'static str> = (0..SERIES_PER_PRODUCER)
                .map(|index| {
                    &*Box::leak(format!("p{producer}.series{index:0>80}").into_boxed_str())
                })
                .collect();
            std::thread::spawn(move || {
                let mut latencies = Vec::with_capacity(1 << 20);
                let mut index = 0;
                while !stop.load(Ordering::Relaxed) {
                    let name = names[index % names.len()];
                    index += 1;
                    let started = Instant::now();
                    telemetry.observe_with("command", name, 1.0, "ok", Some("123456"));
                    latencies.push(started.elapsed());
                }
                recorded.fetch_add(index as u64, Ordering::Relaxed);
                latencies
            })
        })
        .collect();
    let mut taken = 0_u64;
    let mut flushes = 0;
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(1500) {
        let snapshot = telemetry.take_snapshot();
        taken += snapshot.metrics.iter().map(|row| row.count).sum::<u64>();
        flushes += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    stop.store(true, Ordering::Relaxed);
    let mut latencies: Vec<Duration> = producers
        .into_iter()
        .flat_map(|producer| producer.join().unwrap())
        .collect();
    taken += telemetry
        .take_snapshot()
        .metrics
        .iter()
        .map(|row| row.count)
        .sum::<u64>();
    latencies.sort_unstable();
    let at = |fraction: f64| latencies[((latencies.len() - 1) as f64 * fraction) as usize];
    let worst = latencies[latencies.len() - 1];
    eprintln!(
        "{PRODUCERS} producer threads over {} series, {flushes} concurrent flushes, {} recordings: \
         median {:?}, p99.9 {:?}, p99.99 {:?}, worst {worst:?}",
        PRODUCERS * SERIES_PER_PRODUCER,
        latencies.len(),
        at(0.5),
        at(0.999),
        at(0.9999),
    );
    // Every observation is either exported or counted as lost.
    assert_eq!(
        taken + telemetry.stats().pipeline_dropped,
        recorded.load(Ordering::Relaxed)
    );
    assert!(worst < Duration::from_millis(50), "worst {worst:?}");
    assert!(
        at(0.999) < Duration::from_millis(2),
        "p99.9 {:?}",
        at(0.999)
    );
}
