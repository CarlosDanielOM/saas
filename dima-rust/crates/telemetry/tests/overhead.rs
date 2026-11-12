//! What telemetry costs on hot paths, and the memory it holds at the reference's bounds.
//!
//! Prints the measured figures (`cargo test --test overhead -- --nocapture`). The assertions are
//! loose ceilings for an unoptimised test build on a loaded machine; the printed numbers are the
//! measurement. Resident memory is read from `/proc/self/status` before and after: a hot path
//! that allocated per call would grow it by hundreds of megabytes over these loops.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_telemetry::process::parse_rss;
use dima_telemetry::{Level, LogOptions, Telemetry, TelemetryConfig};
use std::hint::black_box;
use std::time::Instant;

fn rss() -> u64 {
    parse_rss(&std::fs::read_to_string("/proc/self/status").unwrap()).unwrap()
}

fn per_call(iterations: u32, mut f: impl FnMut()) -> f64 {
    for _ in 0..1000 {
        f();
    }
    let started = Instant::now();
    for _ in 0..iterations {
        f();
    }
    started.elapsed().as_nanos() as f64 / f64::from(iterations)
}

fn handle() -> Telemetry {
    let mut config = TelemetryConfig::new("bench", "index");
    config.dragonfly = Some(support::local_store(1));
    config.console = dima_telemetry::ConsoleTarget::Off;
    config.min_level = Level::Info;
    config.sample_rate = 0.0;
    Telemetry::new(config).unwrap()
}

/// One test, so nothing else in this process allocates while resident memory is measured: the
/// memory part runs first, on the test thread, before any runtime thread exists.
#[test]
fn hot_paths_cost_nanoseconds_and_memory_stays_bounded() {
    memory_at_the_reference_bounds_is_bounded();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(hot_paths());
}

async fn hot_paths() {
    let telemetry = handle();
    // The probe task keeps the coarse clock that picks buckets, as in a running process.
    let running = telemetry.start();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    const N: u32 = 2_000_000;
    let before = rss();
    let filtered = per_call(N, || {
        telemetry.debug(black_box(&("a", 1)), LogOptions::console());
    });
    let counter = per_call(N, || {
        telemetry.count(black_box("command"), black_box("!uptime"))
    });
    let observe = per_call(N, || {
        telemetry.observe_with("chat", "message", black_box(12.5), "ok", Some("123456"));
    });
    let span = per_call(N, || {
        telemetry
            .span(black_box("cache"), black_box("get"))
            .end("ok")
    });
    let grown = rss().saturating_sub(before);
    let clock = per_call(N / 4, || {
        black_box(tokio::time::Instant::now());
    });
    let rows = telemetry.take_snapshot();
    // Every call was counted: still aggregated, or lost by a scheduled flush to this test's
    // unreachable store (and then counted as dropped).
    let counted: u64 =
        rows.metrics.iter().map(|row| row.count).sum::<u64>() + telemetry.stats().pipeline_dropped;
    assert!(counted >= 3 * (u64::from(N) + 1000), "{counted}");
    eprintln!(
        "per call (test build): filtered debug {filtered:.1} ns, counter {counter:.1} ns, \
         observation {observe:.1} ns, unsampled span {span:.1} ns (two clock reads of {clock:.1} ns each \
         on this machine); resident growth over {} calls: {} KiB",
        4 * N,
        grown / 1024
    );
    // Ceilings for an unoptimised build on a machine whose clock source may be slow (HPET: about
    // 1.2 µs per clock read; a span reads the monotonic clock twice).
    assert!(filtered < 100.0, "{filtered}");
    assert!(counter < 5_000.0 && observe < 5_000.0 && span < 15_000.0);
    // 8 million calls that each allocated even 16 bytes would add over 100 MiB.
    assert!(grown < 8 * 1024 * 1024, "{grown}");
    running.shutdown(std::time::Duration::from_secs(2)).await;
}

fn fill(telemetry: &Telemetry) {
    for index in 0..2000 {
        telemetry.observe_with(
            "command",
            &format!("{index:0>60}"),
            10.0,
            "ok",
            Some("123456789"),
        );
    }
    for _ in 0..300 {
        telemetry.span("http", &"n".repeat(100)).end("error");
    }
    for _ in 0..100 {
        telemetry.error(
            &serde_json::json!({"function": "f".repeat(100), "code": "c".repeat(80), "step": "s".repeat(80)}),
            LogOptions::console(),
        );
    }
}

fn memory_at_the_reference_bounds_is_bounded() {
    let telemetry = handle();
    let before = rss();
    fill(&telemetry);
    assert_eq!(telemetry.stats().series, 2000);
    let held = rss().saturating_sub(before);
    // Steady state: a flush empties the rows and keeps the series; filling again reuses them.
    let _ = telemetry.take_snapshot();
    let refilled = rss();
    fill(&telemetry);
    let regrown = rss().saturating_sub(refilled);
    eprintln!(
        "held at the bounds (2000 series, 300 spans, 100 logs): {} KiB resident; \
         a second fill after a flush: +{} KiB",
        held / 1024,
        regrown / 1024
    );
    // The first fill also counts transient allocations (names built with `format!`, JSON values,
    // redaction) and the allocator touching fresh pages; what stays live at these bounds is about
    // 1.2 MB (2000 series of ~300 bytes plus their hash table, 300 span rows, 100 log rows).
    assert!(held < 4 * 1024 * 1024, "{held}");
    assert!(regrown < 512 * 1024, "{regrown}");
}
