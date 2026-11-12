//! The supervisor with fake workers: one worker cannot take the others down, and a stuck one is
//! noticed. Time is tokio's paused clock (`start_paused`), except where a thread really blocks,
//! where the test waits for an observable state (the supervisor's verdict), never for a fixed
//! sleep.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_core::runtime::{Backoff, Deadline, Shutdown, SupervisorConfig, WorkScope};
use dima_cron::host::{self, Exit};
use dima_cron::pacing::{Burst, IdleBackoff};
use dima_cron::worker::{Lease, Pacing, Spec, TickError, TickFuture, Work, Worker};
use dima_telemetry::{ConsoleTarget, Telemetry, TelemetryConfig};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::{Instant, sleep};

/// What a fake worker's ticks do.
#[derive(Clone, Copy, Debug)]
enum Behaviour {
    /// Nothing to do.
    Idle,
    /// An error every tick.
    Fail,
    /// An error on the ticks of the process with these numbers, otherwise idle.
    FailOn(&'static [u64]),
    /// A panic every tick.
    Panic,
    /// Never returns (cooperates with an abort).
    Hang,
    /// Blocks its thread for this long, ignoring every abort.
    Block(Duration),
    /// Works for this long, then reports one item.
    Work(Duration),
}

struct Fake {
    spec: Spec,
    behaviour: Behaviour,
    burst: bool,
    ticks: Arc<AtomicU64>,
    finished: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
}

/// Counts a tick that went away without finishing.
struct DropGuard {
    finished: bool,
    dropped: Arc<AtomicU64>,
}

impl Drop for DropGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn spec(name: &'static str, limit_ms: u64, grace_ms: u64) -> Spec {
    Spec {
        name,
        telemetry: name,
        batch_metric: "batch_items",
        deadline: Deadline {
            limit: Duration::from_millis(limit_ms),
            grace: Duration::from_millis(grace_ms),
        },
        lease: Lease::Unleased("test"),
        enabled_env: None,
    }
}

impl Fake {
    fn new(name: &'static str, behaviour: Behaviour) -> Arc<Self> {
        Self::with_spec(spec(name, 50_000, 5_000), behaviour)
    }

    fn with_spec(spec: Spec, behaviour: Behaviour) -> Arc<Self> {
        Arc::new(Self {
            spec,
            behaviour,
            burst: false,
            ticks: Arc::default(),
            finished: Arc::default(),
            dropped: Arc::default(),
        })
    }

    fn ticks(&self) -> u64 {
        self.ticks.load(Ordering::SeqCst)
    }
}

impl Worker for Fake {
    fn spec(&self) -> &Spec {
        &self.spec
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        if self.burst {
            Box::new(Burst::default())
        } else {
            Box::new(IdleBackoff::default())
        }
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        let tick = self.ticks.fetch_add(1, Ordering::SeqCst);
        let behaviour = self.behaviour;
        let finished = Arc::clone(&self.finished);
        let guard = DropGuard {
            finished: false,
            dropped: Arc::clone(&self.dropped),
        };
        Box::pin(async move {
            // Moved in whole, so it lives as long as the tick's future.
            let mut guard = guard;
            let result = match behaviour {
                Behaviour::Idle => Ok(Work::IDLE),
                Behaviour::Fail => Err(TickError("store unavailable".to_owned())),
                Behaviour::FailOn(failing) if failing.contains(&tick) => {
                    Err(TickError("store unavailable".to_owned()))
                }
                Behaviour::FailOn(_) => Ok(Work::IDLE),
                Behaviour::Panic => panic!("tick {tick} panicked"),
                Behaviour::Hang => std::future::pending().await,
                Behaviour::Block(duration) => {
                    std::thread::sleep(duration);
                    Ok(Work::IDLE)
                }
                Behaviour::Work(duration) => {
                    sleep(duration).await;
                    Ok(Work::items(1))
                }
            };
            guard.finished = true;
            finished.fetch_add(1, Ordering::SeqCst);
            result
        })
    }
}

/// Telemetry writing console lines to memory; no export, no store.
fn telemetry() -> (Telemetry, Arc<Mutex<Vec<u8>>>) {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let mut config = TelemetryConfig::new("cron", "index");
    config.export = false;
    config.console = ConsoleTarget::Memory(Arc::clone(&buffer));
    (Telemetry::new(config).unwrap(), buffer)
}

fn lines(buffer: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
    String::from_utf8_lossy(&buffer.lock().unwrap())
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// The `data` of every console line about `name` with `message`.
fn about<'a>(lines: &'a [Value], name: &str, message: &str) -> Vec<&'a Value> {
    lines
        .iter()
        .map(|line| &line["data"])
        .filter(|data| {
            (data["name"] == name || data["worker"] == name)
                && data["message"]
                    .as_str()
                    .is_some_and(|text| text.starts_with(message))
        })
        .collect()
}

fn production_timing() -> (SupervisorConfig, Backoff) {
    host::timing(Duration::from_millis(5000))
}

/// Runs `workers` until `stop_after` (paused time), then stops them as the process does;
/// returns how it ended, the console lines and how long `serve` took. The final telemetry flush
/// waits for the console thread, so it runs after the clock is resumed.
async fn run_for(
    workers: Vec<Arc<dyn Worker>>,
    timing: (SupervisorConfig, Backoff),
    stop_after: Duration,
) -> (Exit, Vec<Value>, Duration) {
    let (telemetry, buffer) = telemetry();
    let running = telemetry.start();
    let supervisor = host::supervisor(workers, timing.0, timing.1, &telemetry, None).unwrap();
    let handle = supervisor.start(&Shutdown::new());
    let started = Instant::now();
    let exit = host::serve(
        handle,
        async move {
            sleep(stop_after).await;
            "SIGTERM"
        },
        async { true },
        |_| async { true },
        host::SHUTDOWN_BUDGET,
        &telemetry,
    )
    .await;
    let elapsed = started.elapsed();
    tokio::time::resume();
    assert!(running.shutdown(Duration::from_secs(5)).await.clean);
    (exit, lines(&buffer), elapsed)
}

#[tokio::test(start_paused = true)]
async fn a_worker_failing_at_every_start_backs_off_to_its_cap_and_the_others_keep_running() {
    let broken = Fake::new("broken", Behaviour::Fail);
    let healthy = Fake::new("healthy", Behaviour::Idle);
    let (exit, lines, _) = run_for(
        vec![broken.clone(), healthy.clone()],
        production_timing(),
        Duration::from_secs(400),
    )
    .await;
    assert_eq!(exit, Exit::Clean);
    // Starts at 0, 5, 15, 35, 75, 135, 195, 255, 315, 375 s.
    assert_eq!(broken.ticks(), 10);
    let delays: Vec<u64> = about(&lines, "broken", "Restarting cron worker")
        .iter()
        .filter_map(|data| data["delayMs"].as_u64())
        .collect();
    assert_eq!(
        delays,
        vec![
            5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000
        ]
    );
    let counts: Vec<u64> = about(&lines, "broken", "Restarting cron worker")
        .iter()
        .filter_map(|data| data["restartCount"].as_u64())
        .collect();
    assert_eq!(counts, (1..=10).collect::<Vec<_>>());
    let failures = about(&lines, "broken", "Cron worker tick failed");
    assert_eq!(failures.len(), 10);
    assert_eq!(failures[0]["code"], "CRON_TICK_FAILED");
    assert_eq!(failures[0]["error"], "failed: store unavailable");
    // The healthy worker was never restarted and polled every 5 s once idle (1, 2, 4, 5, ...).
    assert!(about(&lines, "healthy", "Restarting cron worker").is_empty());
    assert_eq!(about(&lines, "healthy", "Started cron worker").len(), 1);
    assert!(healthy.ticks() >= 75, "{}", healthy.ticks());
    assert_eq!(about(&lines, "healthy", "Stopped cron worker").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_worker_that_recovers_returns_to_the_base_delay() {
    // Fails at 0, 5 and 15 s; from 35 s it polls (idle) at 36, 38, 42, 47 s and every 5 s
    // after; its tick 20 (at 112 s, 77 s into a healthy run) fails again.
    let flaky = Fake::new("flaky", Behaviour::FailOn(&[0, 1, 2, 20]));
    let (exit, lines, _) = run_for(
        vec![flaky.clone()],
        production_timing(),
        Duration::from_secs(200),
    )
    .await;
    assert_eq!(exit, Exit::Clean);
    let delays: Vec<u64> = about(&lines, "flaky", "Restarting cron worker")
        .iter()
        .filter_map(|data| data["delayMs"].as_u64())
        .collect();
    assert_eq!(delays, vec![5000, 10_000, 20_000, 5000]);
    let ran: Vec<u64> = about(&lines, "flaky", "Cron worker ended")
        .iter()
        .filter_map(|data| data["ranMs"].as_u64())
        .collect();
    assert_eq!(ran[..4], [0, 0, 0, 77_000]);
}

#[tokio::test(start_paused = true)]
async fn an_error_with_a_burst_pacing_goes_on_without_a_restart() {
    let mut fake = Fake::new("baseline-like", Behaviour::Fail);
    Arc::get_mut(&mut fake).unwrap().burst = true;
    let (exit, lines, _) = run_for(
        vec![fake.clone()],
        production_timing(),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(exit, Exit::Clean);
    // One tick a second: at 0, 1, ..., 9 s and the one at 10 s races the stop.
    assert!((10..=11).contains(&fake.ticks()), "{}", fake.ticks());
    assert!(about(&lines, "baseline-like", "Restarting cron worker").is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_panicking_tick_restarts_only_its_worker() {
    let panicking = Fake::new("panicking", Behaviour::Panic);
    let healthy = Fake::new("healthy", Behaviour::Idle);
    let (exit, lines, _) = run_for(
        vec![panicking.clone(), healthy.clone()],
        production_timing(),
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(exit, Exit::Clean);
    // Starts at 0, 5 and 15 s.
    assert_eq!(panicking.ticks(), 3);
    let failures = about(&lines, "panicking", "Cron worker tick failed");
    assert_eq!(failures[0]["code"], "CRON_TICK_PANIC");
    assert_eq!(failures[0]["error"], "panicked: tick 0 panicked");
    assert_eq!(
        about(&lines, "panicking", "Restarting cron worker").len(),
        3
    );
    assert!(about(&lines, "healthy", "Restarting cron worker").is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_tick_that_never_returns_is_aborted_at_its_deadline_joined_and_restarted() {
    let hanging = Fake::with_spec(spec("hanging", 50_000, 5_000), Behaviour::Hang);
    let healthy = Fake::new("healthy", Behaviour::Idle);
    let (exit, lines, _) = run_for(
        vec![hanging.clone(), healthy.clone()],
        production_timing(),
        Duration::from_secs(60),
    )
    .await;
    assert_eq!(exit, Exit::Clean);
    // Aborted at 50 s (and its future dropped before the runner went on), restarted at 55 s,
    // aborted again by the stop at 70 s (the stop deadline is 10 s).
    assert_eq!(hanging.ticks(), 2);
    assert_eq!(hanging.dropped.load(Ordering::SeqCst), 2);
    assert_eq!(hanging.finished.load(Ordering::SeqCst), 0);
    let failures = about(&lines, "hanging", "Cron worker tick failed");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["code"], "CRON_TICK_TIMEOUT");
    let duration = failures[0]["durationMs"].as_u64().unwrap();
    assert!((50_000..55_000).contains(&duration), "{duration}");
    let restarts = about(&lines, "hanging", "Restarting cron worker");
    assert_eq!(restarts.len(), 1);
    assert_eq!(restarts[0]["delayMs"], 5000);
    assert!(about(&lines, "healthy", "Restarting cron worker").is_empty());
}

#[tokio::test(start_paused = true)]
async fn shutdown_lets_ticks_in_flight_finish_within_their_deadline_and_the_stop_deadline() {
    // Mid-tick at the signal (1 s): one tick ends at 3 s, one would end at 30 s.
    let short = Fake::new("short", Behaviour::Work(Duration::from_secs(3)));
    let long = Fake::new("long", Behaviour::Work(Duration::from_secs(30)));
    let idle = Fake::new("idle", Behaviour::Idle);
    let (exit, lines, elapsed) = run_for(
        vec![short.clone(), long.clone(), idle.clone()],
        production_timing(),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(exit, Exit::Clean, "{lines:#?}");
    // The short tick was not cancelled; no tick started after the signal.
    assert_eq!(short.ticks(), 1);
    assert_eq!(short.finished.load(Ordering::SeqCst), 1);
    assert_eq!(short.dropped.load(Ordering::SeqCst), 0);
    // The long one was aborted at the stop deadline and joined.
    assert_eq!(long.ticks(), 1);
    assert_eq!(long.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(long.finished.load(Ordering::SeqCst), 0);
    // Signal at 1 s, stop deadline 10 s: everything done within the 17 s budget.
    assert!(elapsed >= Duration::from_secs(11), "{elapsed:?}");
    assert!(
        elapsed < Duration::from_secs(1) + host::SHUTDOWN_BUDGET,
        "{elapsed:?}"
    );
    let ended: Vec<String> = ["short", "long", "idle"]
        .iter()
        .flat_map(|name| about(&lines, name, "Cron worker ended"))
        .map(|data| {
            format!(
                "{} {}",
                data["name"].as_str().unwrap_or_default(),
                data["exit"].as_str().unwrap_or_default()
            )
        })
        .collect();
    assert_eq!(
        ended,
        vec!["short finished", "long aborted", "idle finished"]
    );
    let stopped = lines
        .iter()
        .map(|line| &line["data"])
        .find(|data| data["step"] == "stopped")
        .unwrap();
    assert_eq!(stopped["clean"], true);
}

fn fast_timing() -> (SupervisorConfig, Backoff) {
    (
        SupervisorConfig {
            restart_delay: Duration::from_millis(10),
            stop_deadline: Duration::from_millis(200),
            stop_grace: Duration::from_millis(100),
        },
        Backoff {
            max: Duration::from_millis(100),
            reset_after: Duration::from_secs(60),
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_tick_that_ignores_its_abort_and_blocks_its_thread_ends_the_process() {
    // Deadline 50 ms, grace 50 ms; the tick holds its thread for 1.5 s.
    let stuck = Fake::with_spec(
        spec("stuck", 50, 50),
        Behaviour::Block(Duration::from_millis(1500)),
    );
    let healthy = Fake::new("healthy", Behaviour::Idle);
    let (telemetry, buffer) = telemetry();
    let running = telemetry.start();
    let (config, backoff) = fast_timing();
    let supervisor = host::supervisor(
        vec![stuck.clone(), healthy.clone()],
        config,
        backoff,
        &telemetry,
        None,
    )
    .unwrap();
    let handle = supervisor.start(&Shutdown::new());
    let started = std::time::Instant::now();
    // No signal: only the fatal worker can end it.
    let exit = host::serve(
        handle,
        std::future::pending(),
        async { true },
        |budget| async move { running.shutdown(budget).await.clean },
        host::SHUTDOWN_BUDGET,
        &telemetry,
    )
    .await;
    assert_eq!(exit, Exit::Fatal("stuck"));
    assert_eq!(exit.code(), 2);
    // Decided after the deadline and the grace, before the blocked thread let go.
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(stuck.ticks(), 1, "restarted over work that may still run");
    let lines = lines(&buffer);
    let fatal = about(&lines, "stuck", "Work of a cron worker did not stop");
    assert_eq!(fatal.len(), 1, "{lines:#?}");
    assert_eq!(fatal[0]["code"], "CRON_WORKER_UNSTOPPABLE");
    assert_eq!(
        about(&lines, "stuck", "Cron worker tick failed")[0]["code"],
        "CRON_TICK_UNSTOPPABLE"
    );
    assert_eq!(about(&lines, "healthy", "Stopped cron worker").len(), 1);
    let stopped = lines
        .iter()
        .map(|line| &line["data"])
        .find(|data| data["step"] == "stopped")
        .unwrap();
    assert_eq!(stopped["fatal"], "stuck");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_tick_stuck_at_shutdown_makes_the_exit_unclean() {
    // A long deadline: the stop deadline (200 ms) comes first, then the grace (100 ms).
    let stuck = Fake::with_spec(
        spec("stuck", 60_000, 5_000),
        Behaviour::Block(Duration::from_millis(1500)),
    );
    let (telemetry, buffer) = telemetry();
    let running = telemetry.start();
    let (config, backoff) = fast_timing();
    let supervisor =
        host::supervisor(vec![stuck.clone()], config, backoff, &telemetry, None).unwrap();
    let handle = supervisor.start(&Shutdown::new());
    let snapshot_ticks = Arc::clone(&stuck.ticks);
    let started = std::time::Instant::now();
    let exit = host::serve(
        handle,
        async move {
            // Stop once the tick is running.
            while snapshot_ticks.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            "SIGTERM"
        },
        async { true },
        |budget| async move { running.shutdown(budget).await.clean },
        host::SHUTDOWN_BUDGET,
        &telemetry,
    )
    .await;
    assert_eq!(exit, Exit::Unclean);
    assert_eq!(exit.code(), 3);
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    let lines = lines(&buffer);
    let unstopped = lines
        .iter()
        .map(|line| &line["data"])
        .find(|data| data["message"] == "Cron workers did not stop within the stop deadline")
        .unwrap();
    assert_eq!(unstopped["names"][0], "stuck");
}

#[test]
fn the_supervisor_refuses_two_workers_with_one_name() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (telemetry, _) = telemetry();
        let (config, backoff) = production_timing();
        let result = host::supervisor(
            vec![
                Fake::new("twin", Behaviour::Idle),
                Fake::new("twin", Behaviour::Idle),
            ],
            config,
            backoff,
            &telemetry,
            None,
        );
        assert!(result.is_err());
    });
}

#[test]
fn exit_statuses() {
    assert_eq!(Exit::Clean.code(), 0);
    assert_eq!(Exit::Startup.code(), 1);
    assert_eq!(Exit::Fatal("x").code(), 2);
    assert_eq!(Exit::Unclean.code(), 3);
}
