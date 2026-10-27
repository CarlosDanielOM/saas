//! Native baseline child of the existing cron supervisor; no automatic dotenv.
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use dima_rust::{
    utils::{
        mongo::get_mongo_client,
        worker_process::{load_env_files, spawn_shutdown_signal},
    },
    workers::follow_defense_baseline::{
        BacklogHealth, FollowDefenseBaselineProjector, MAX_METRIC_VALUE, PhaseTimings,
        backlog_health,
    },
};
use mongodb::bson::DateTime;
use tokio::sync::watch;

const HELP: &str = "Usage: follow_defense_baseline [--dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nRefreshes one due follow-defense baseline per tick; drains sequential bursts of eight. MongoDB aggregates are read-only.\nUses the existing Redis due queue and seven-day baseline cache.\nNo automatic .env loading. MONGO_URI must name a database, or supply --database.\nExisting environment wins; explicit environment files load before runtime threads.\nFailed ticks retain the retry receipt and continue; --once reports failure with a nonzero exit.\nIdle polling backs off from 1s to 5s; each eight successful channels has a 1s cooldown.\nA 30-second hung-tick watchdog exits nonzero for supervisor recovery.";
const WATCHDOG: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

fn metric_elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0).min(MAX_METRIC_VALUE as f64)
}

/// One tick at a time. Work drains immediately until a bounded burst completes;
/// empty queues and ordinary errors reset the burst independently of health.
struct Scheduler {
    idle_seconds: u64,
    burst_successes: usize,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            idle_seconds: 1,
            burst_successes: 0,
        }
    }
}

impl Scheduler {
    fn after_tick(&mut self, result: &Result<usize, &'static str>) -> Option<Duration> {
        match result {
            Ok(count) if *count > 0 => {
                self.idle_seconds = 1;
                self.burst_successes += 1;
                if self.burst_successes == 8 {
                    self.burst_successes = 0;
                    Some(Duration::from_secs(1))
                } else {
                    None
                }
            }
            Ok(_) => {
                self.burst_successes = 0;
                let wait = Duration::from_secs(self.idle_seconds);
                self.idle_seconds = (self.idle_seconds * 2).min(5);
                Some(wait)
            }
            Err(_) => {
                self.idle_seconds = 1;
                self.burst_successes = 0;
                Some(Duration::from_secs(1))
            }
        }
    }
}

async fn wait_or_stop(wait: Duration, stopped: &mut watch::Receiver<bool>) {
    if !*stopped.borrow() {
        tokio::select! { _ = tokio::time::sleep(wait) => {}, _ = stopped.changed() => {} }
    }
}

#[derive(Default)]
struct Args {
    help: bool,
    dry_run: bool,
    once: bool,
    telemetry_json: bool,
    database: Option<String>,
    env_files: Vec<PathBuf>,
}

impl Args {
    fn parse(arguments: impl Iterator<Item = String>) -> Result<Self, &'static str> {
        let mut args = Self::default();
        let mut arguments = arguments.peekable();
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--help" | "-h" => args.help = true,
                "--dry-run" => args.dry_run = true,
                "--once" => args.once = true,
                "--telemetry-json" => args.telemetry_json = true,
                "--database" => {
                    let name = arguments.next().ok_or("Missing database name")?;
                    if name.is_empty() {
                        return Err("Empty database name");
                    }
                    args.database = Some(name);
                }
                "--env-file" => args.env_files.push(
                    arguments
                        .next()
                        .ok_or("Missing environment file path")?
                        .into(),
                ),
                _ => return Err("Unknown argument; use --help"),
            }
        }
        Ok(args)
    }
}

fn batch_telemetry(
    result: &Result<usize, &'static str>,
    duration_ms: f64,
    phases: &PhaseTimings,
) -> String {
    format!(
        "follow_defense_baseline:{}",
        serde_json::json!({
            "event": "batch", "events": result.as_ref().copied().unwrap_or(0).min(1),
            "durationMs": duration_ms, "success": result.is_ok(), "phases": phases
        })
    )
}

fn health_telemetry(health: Option<&BacklogHealth>, last_success_age_ms: Option<f64>) -> String {
    let mut metadata = serde_json::json!({ "event": "health", "success": health.is_some() });
    if let Some(health) = health {
        metadata["dueChannels"] = health.due_channels.into();
        if let Some(age) = health.oldest_due_age_ms {
            metadata["oldestDueAgeMs"] = age.into();
        }
    }
    if let Some(age) = last_success_age_ms {
        metadata["lastSuccessAgeMs"] = age.into();
    }
    format!("follow_defense_baseline:{metadata}")
}

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("follow_defense_baseline_rust: {message}");
            return ExitCode::FAILURE;
        }
    };
    if args.help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if args.dry_run {
        println!(
            "{}",
            serde_json::json!({ "worker": "follow-defense-baseline" })
        );
        return ExitCode::SUCCESS;
    }
    // Non-override loading preserves pre-existing values and earlier files.
    if let Err(message) = load_env_files(&args.env_files) {
        eprintln!("follow_defense_baseline_rust: {message}");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("follow_defense_baseline_rust: Cannot create worker runtime");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("follow_defense_baseline_rust: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn tick(
    database_name: Option<&str>,
    phases: &mut PhaseTimings,
) -> Result<usize, &'static str> {
    // Retryable client initialization is part of the tick/watchdog too, so a
    // transient connection failure does not permanently kill the normal loop.
    let client = get_mongo_client()
        .await
        .map_err(|_| "Cannot initialize MongoDB client")?;
    let database = match database_name {
        Some(name) => client.database(name),
        None => client
            .default_database()
            .ok_or("Select a database using --database or MONGO_URI")?,
    };
    FollowDefenseBaselineProjector::new(database)
        .project_once_with_phases(phases)
        .await
}

async fn run(args: Args) -> Result<(), &'static str> {
    let (stopping, mut stopped) = watch::channel(false);
    let signal_task = spawn_shutdown_signal(stopping);
    let result = async {
        let mut scheduler = Scheduler::default();
        // Unknown on startup until one non-idle tick fully succeeds. Monotonic
        // time prevents host clock changes from corrupting last-success age.
        let mut last_success: Option<Instant> = None;
        let mut last_health: Option<Instant> = None;
        while !*stopped.borrow() {
            if args.telemetry_json && last_health.is_none_or(|at| at.elapsed() >= HEALTH_INTERVAL) {
                // Only Redis reads, before the first tick and between later
                // ticks. Failure/timeout cannot fail projection or invent zeros.
                let health = tokio::time::timeout(HEALTH_TIMEOUT, backlog_health(DateTime::now()))
                    .await
                    .ok()
                    .and_then(Result::ok);
                last_health = Some(Instant::now());
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    health_telemetry(health.as_ref(), last_success.map(metric_elapsed_ms))
                );
                if *stopped.borrow() {
                    break;
                }
            }
            let started = Instant::now();
            // Keep completed observations outside the cancellable watchdog
            // future. Signals drain active work before stopping subsequent ticks.
            let mut phases = PhaseTimings::default();
            let attempt =
                tokio::time::timeout(WATCHDOG, tick(args.database.as_deref(), &mut phases)).await;
            let hung = attempt.is_err();
            let result = attempt.unwrap_or(Err("Baseline tick exceeded 30-second watchdog"));
            if matches!(&result, Ok(count) if *count > 0) {
                last_success = Some(Instant::now());
            }
            if args.telemetry_json {
                // A telemetry write failure cannot fail a successful refresh.
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    batch_telemetry(&result, metric_elapsed_ms(started), &phases)
                );
            }
            if hung {
                return Err("Baseline tick exceeded 30-second watchdog");
            }
            if args.once {
                return result.map(|_| ());
            }
            if let Err(message) = result {
                eprintln!("follow_defense_baseline_rust: {message}");
            }
            if *stopped.borrow() {
                break;
            }
            if let Some(wait) = scheduler.after_tick(&result) {
                wait_or_stop(wait, &mut stopped).await;
            }
        }
        Ok(())
    }
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_backs_off_and_resets_after_work_or_errors() {
        let mut scheduler = Scheduler::default();
        for seconds in [1, 2, 4, 5, 5] {
            assert_eq!(
                scheduler.after_tick(&Ok(0)),
                Some(Duration::from_secs(seconds))
            );
        }
        assert_eq!(scheduler.after_tick(&Ok(1)), None);
        assert_eq!(scheduler.after_tick(&Ok(0)), Some(Duration::from_secs(1)));
        assert_eq!(scheduler.after_tick(&Ok(0)), Some(Duration::from_secs(2)));
        assert_eq!(
            scheduler.after_tick(&Err("Redis failed")),
            Some(Duration::from_secs(1))
        );
        assert_eq!(scheduler.after_tick(&Ok(0)), Some(Duration::from_secs(1)));
    }

    #[test]
    fn scheduler_drains_eight_sequential_successes_before_cooldown() {
        let mut scheduler = Scheduler::default();
        for _ in 0..2 {
            for _ in 0..7 {
                assert_eq!(scheduler.after_tick(&Ok(1)), None);
            }
            assert_eq!(scheduler.after_tick(&Ok(1)), Some(Duration::from_secs(1)));
        }
        for _ in 0..7 {
            assert_eq!(scheduler.after_tick(&Ok(1)), None);
        }
        assert_eq!(
            scheduler.after_tick(&Err("query failed")),
            Some(Duration::from_secs(1))
        );
        // Error resets the partial burst, so the next tick starts at one.
        assert_eq!(scheduler.after_tick(&Ok(1)), None);
        assert_eq!(scheduler.burst_successes, 1);
        assert_eq!(scheduler.after_tick(&Ok(0)), Some(Duration::from_secs(1)));
        assert_eq!(scheduler.burst_successes, 0);
    }

    #[tokio::test]
    async fn shutdown_interrupts_idle_and_cooldown_waits() {
        for wait in [Duration::from_secs(5), Duration::from_secs(1)] {
            let (stopping, mut stopped) = watch::channel(false);
            let signal = tokio::spawn(async move {
                let _ = stopping.send(true);
            });
            assert!(
                tokio::time::timeout(Duration::from_millis(100), wait_or_stop(wait, &mut stopped))
                    .await
                    .is_ok()
            );
            signal.await.unwrap();
            assert!(*stopped.borrow());
            // A signal already observed must also bypass the next wait.
            assert!(
                tokio::time::timeout(Duration::from_millis(100), wait_or_stop(wait, &mut stopped))
                    .await
                    .is_ok()
            );
        }
    }

    #[test]
    fn health_frames_distinguish_unknown_empty_failed_and_known_success() {
        for (health, last_success, expected) in [
            (
                None,
                None,
                serde_json::json!({ "event": "health", "success": false }),
            ),
            (
                None,
                Some(123.0),
                serde_json::json!({ "event": "health", "success": false, "lastSuccessAgeMs": 123.0 }),
            ),
            (
                Some(BacklogHealth {
                    due_channels: 0,
                    oldest_due_age_ms: None,
                }),
                None,
                serde_json::json!({ "event": "health", "success": true, "dueChannels": 0 }),
            ),
            (
                Some(BacklogHealth {
                    due_channels: 3,
                    oldest_due_age_ms: Some(456.5),
                }),
                Some(12.0),
                serde_json::json!({ "event": "health", "success": true, "dueChannels": 3, "oldestDueAgeMs": 456.5, "lastSuccessAgeMs": 12.0 }),
            ),
        ] {
            let line = health_telemetry(health.as_ref(), last_success);
            assert!(line.len() < 1024);
            let actual: serde_json::Value =
                serde_json::from_str(line.strip_prefix("follow_defense_baseline:").unwrap())
                    .unwrap();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn arguments_require_explicit_environment_and_accept_supervisor_flags() {
        let args = Args::parse(
            [
                "--env-file",
                "first",
                "--env-file",
                "second",
                "--once",
                "--telemetry-json",
                "--database",
                "fixture",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(
            args.env_files,
            vec![PathBuf::from("first"), PathBuf::from("second")]
        );
        assert_eq!(args.database.as_deref(), Some("fixture"));
        assert!(args.once && args.telemetry_json);
        for invalid in [
            vec!["--database"],
            vec!["--database", ""],
            vec!["--env-file"],
            vec!["--unknown"],
        ] {
            assert!(Args::parse(invalid.into_iter().map(String::from)).is_err());
        }
    }

    #[test]
    fn telemetry_counts_only_completed_channels_and_contains_bounded_metadata() {
        for (result, events, success) in [
            (Ok(0), 0, true),
            (Ok(1), 1, true),
            (Ok(usize::MAX), 1, true),
            (Err("query failed"), 0, false),
        ] {
            let phases = PhaseTimings {
                queue_ms: Some(0.5),
                ..PhaseTimings::default()
            };
            let line = batch_telemetry(&result, 12.5, &phases);
            let payload: serde_json::Value =
                serde_json::from_str(line.strip_prefix("follow_defense_baseline:").unwrap())
                    .unwrap();
            assert_eq!(
                payload,
                serde_json::json!({ "event": "batch", "events": events, "durationMs": 12.5, "success": success, "phases": { "queueMs": 0.5 } })
            );
            assert!(line.len() < 256);
        }
    }
}
