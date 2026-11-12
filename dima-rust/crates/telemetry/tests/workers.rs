//! Process figures and the typed worker API, with the metric names the admin page reads.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_telemetry::{LogOptions, RunOutcome, WorkerState};
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_process_reports_memory_cpu_runtime_health_loss_and_uptime() {
    let telemetry = support::in_memory(0.0);
    let running = telemetry.start();
    telemetry.sample();
    // Burn some CPU and block a runtime thread so both figures move.
    let spin = Instant::now();
    while spin.elapsed() < Duration::from_millis(60) {
        std::hint::black_box(0_u64);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    telemetry.sample();
    let snapshot = telemetry.take_snapshot();
    let value = |name: &str| {
        let rows = snapshot.metric(name);
        assert!(!rows.is_empty(), "{name}");
        assert!(
            rows.iter()
                .all(|row| row.kind == "runtime" && row.channel.is_empty())
        );
        rows.iter()
            .map(|row| row.sum / row.count as f64)
            .fold(0.0, f64::max)
    };
    assert!(value("index.rss_bytes") > 1_000_000.0);
    assert!(
        value("index.cpu_cores") > 0.1,
        "{}",
        value("index.cpu_cores")
    );
    assert!(value("index.event_loop_p99_ms") >= 0.0);
    assert_eq!(value("index.telemetry_dropped"), 0.0);
    assert!(value("index.uptime_s") >= 0.0);
    assert!(snapshot.metric("index.heap_bytes").is_empty());
    running.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_reports_runs_state_and_busy_time() {
    let telemetry = support::in_memory(0.0);
    let worker = telemetry.worker("goals.worker");
    assert_eq!(worker.prefix(), "goals.worker");
    telemetry.sample(); // opens the busy-time window
    let task = worker.instrument({
        let worker = worker.clone();
        async move {
            let mut run = worker.run();
            run.scope(async {
                // One long poll: 30 ms holding a runtime thread.
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(30) {
                    std::hint::black_box(0_u64);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            })
            .await;
            run.finish(RunOutcome::Ok);
            let run = worker.run();
            run.finish(RunOutcome::Idle);
            drop(worker.run()); // a run that never finished: an error
        }
    });
    task.await;
    worker.restarted();
    worker.error("claim", "E_LEASE");
    worker.error("claim", "lease lost: private text");
    telemetry.sample();
    let snapshot = telemetry.take_snapshot();

    let runs = snapshot.metric("goals.worker.run");
    let outcomes = |rows: &[&dima_telemetry::aggregate::MetricRow]| {
        let mut list: Vec<(String, u64)> =
            rows.iter().map(|r| (r.outcome.clone(), r.count)).collect();
        list.sort();
        list
    };
    assert!(runs.iter().all(|row| row.kind == "queue_run"));
    let expected = vec![
        ("error".to_owned(), 1),
        ("idle".to_owned(), 1),
        ("ok".to_owned(), 1),
    ];
    assert_eq!(outcomes(&runs), expected);
    assert_eq!(outcomes(&snapshot.metric("goals.worker.runs")), expected);
    assert_eq!(snapshot.metric("goals.worker.restarts")[0].count, 1);
    assert_eq!(snapshot.metric("goals.worker.errors")[0].count, 2);
    let codes: Vec<_> = snapshot
        .logs
        .iter()
        .map(|log| log.fields["code"].clone())
        .collect();
    assert_eq!(codes, ["E_LEASE", "WORKER_ERROR"]);
    assert_eq!(snapshot.logs[0].name, "goals.worker");

    let cpu = snapshot.metric("goals.worker.cpu_cores");
    assert_eq!(cpu[0].kind, "runtime");
    assert!(cpu[0].sum > 0.0);
    let longest = snapshot.metric("goals.worker.event_loop_p99_ms")[0].sum;
    assert!(longest >= 29.0, "{longest}");
    // Restarting after `restarted()`.
    assert_eq!(snapshot.metric("goals.worker.state")[0].sum, 2.0);
    assert!(snapshot.metric("goals.worker.since_success_ms")[0].sum < 5000.0);
    // A stopped worker reports nothing (the page shows it as stale).
    worker.set_state(WorkerState::Stopped);
    telemetry.sample();
    assert!(
        telemetry
            .take_snapshot()
            .metrics
            .iter()
            .all(|row| !row.name.starts_with("goals.worker."))
    );
}

fn rows_of(snapshot: &dima_telemetry::Snapshot, prefix: &str) -> usize {
    snapshot
        .metrics
        .iter()
        .filter(|row| row.name.starts_with(prefix))
        .count()
}

/// Every way out of an instrumented task ends the worker: it returns, it is cancelled, it
/// panics, or it is dropped before it ever ran. A worker that ended keeps no fresh-looking row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_that_ends_in_any_way_stops_reporting() {
    let telemetry = support::in_memory(0.0);
    let returns = telemetry.worker("ends_by_returning.worker");
    let cancelled = telemetry.worker("ends_by_cancel.worker");
    let panics = telemetry.worker("ends_by_panic.worker");
    let unpolled = telemetry.worker("ends_unpolled.worker");
    let alive = telemetry.worker("stays_alive.worker");

    returns.instrument(async {}).await;
    let task = tokio::spawn(cancelled.instrument(std::future::pending::<()>()));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(cancelled.state(), WorkerState::Idle);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let task = tokio::spawn(panics.instrument(async {
        panic!("a worker panicked");
    }));
    assert!(task.await.unwrap_err().is_panic());
    drop(unpolled.instrument(async {}));
    let keep = tokio::spawn(alive.instrument(std::future::pending::<()>()));
    tokio::time::sleep(Duration::from_millis(20)).await;

    for worker in [&returns, &cancelled, &panics, &unpolled] {
        assert_eq!(worker.state(), WorkerState::Stopped, "{}", worker.prefix());
    }
    telemetry.sample();
    telemetry.sample();
    let snapshot = telemetry.take_snapshot();
    for prefix in [
        "ends_by_returning",
        "ends_by_cancel",
        "ends_by_panic",
        "ends_unpolled",
    ] {
        assert_eq!(rows_of(&snapshot, prefix), 0, "{prefix}");
    }
    assert!(rows_of(&snapshot, "stays_alive.worker.") > 0);

    // The supervisor restarts it: it reports again.
    panics.restarted();
    telemetry.sample();
    assert_eq!(
        telemetry
            .take_snapshot()
            .metric("ends_by_panic.worker.state")[0]
            .sum,
        2.0
    );
    keep.abort();
}

#[tokio::test]
async fn native_worker_names_are_kept() {
    let telemetry = support::in_memory(0.0);
    let stream = telemetry.worker("stream_activity_rust");
    stream.batch("batch_events", 12, Duration::from_millis(40), true);
    stream.batch("batch_events", 0, Duration::from_millis(3), true);
    stream.health(true);
    stream.gauge("pending_work", 1.0);
    stream.gauge("oldest_pending_age_ms", 1500.0);
    let raid = telemetry.worker("raid_analytics_rust");
    raid.batch("batch_channels", 0, Duration::from_millis(9), false);
    raid.phase("claimMs", Duration::from_millis(4), "error");
    raid.health(false);
    let snapshot = telemetry.take_snapshot();
    let row = |name: &str, outcome: &str| {
        snapshot
            .metrics
            .iter()
            .find(|row| row.name == name && row.outcome == outcome)
            .unwrap_or_else(|| panic!("{name} {outcome}"))
            .clone()
    };
    assert_eq!(row("stream_activity_rust.batch_events", "ok").sum, 12.0);
    assert_eq!(
        row("stream_activity_rust.batch_events", "idle").kind,
        "worker"
    );
    assert_eq!(
        row("stream_activity_rust.project_batch", "ok").kind,
        "queue_run"
    );
    assert_eq!(row("stream_activity_rust.health_query", "ok").sum, 1.0);
    assert_eq!(row("stream_activity_rust.pending_work", "ok").sum, 1.0);
    assert_eq!(
        row("raid_analytics_rust.batch_channels", "error").kind,
        "worker"
    );
    assert_eq!(
        row("raid_analytics_rust.phase.claimMs", "error").kind,
        "queue_run"
    );
    assert_eq!(row("raid_analytics_rust.health_query", "ok").sum, 0.0);
    assert_eq!(row("raid_analytics_rust.health_errors", "error").count, 1);
    // The same prefix twice is the same worker.
    let again = telemetry.worker("stream_activity_rust");
    again.restarted();
    telemetry.sample();
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.metric("stream_activity_rust.state").len(), 1);
    telemetry.info(&"done", LogOptions::console());
}
