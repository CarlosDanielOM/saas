//! Raid-analytics executable for the cron supervisor and explicit manual runs.
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use dima_rust::{
    utils::{
        mongo::get_mongo_client,
        worker_process::{IdleBackoff, load_env_files, spawn_shutdown_signal},
    },
    workers::raid_analytics::{BacklogHealth, PhaseTimings, RaidAnalyticsProjector},
};
use mongodb::bson::DateTime;
use tokio::sync::watch;

const HELP: &str = "Usage: raid_analytics [--dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nManual MongoDB 8.0+ raid-summary projector. No automatic .env loading.\nMONGO_URI must name a database, or supply --database. Existing environment wins.\nOne channel per pass; at most 25 follow windows and five query tasks at a time.\nIdle polling backs off from 1s to 5s and resets after work. Due channels run immediately.\n--telemetry-json emits bounded batch, phase, and periodic health metadata to stdout for the parent supervisor.";

const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_METRIC_VALUE: f64 = 1_000_000_000_000_000.0;

fn metric_elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0).min(MAX_METRIC_VALUE)
}

fn batch_telemetry(
    events: usize,
    duration_ms: f64,
    success: bool,
    phases: &PhaseTimings,
) -> String {
    format!(
        "raid_analytics:{}",
        serde_json::json!({
            "event": "batch", "events": events.min(1), "durationMs": duration_ms, "success": success,
            "phases": phases
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
    format!("raid_analytics:{metadata}")
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

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    if args.help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if args.dry_run {
        println!(
            "Raid analytics: one channel per pass, bounded follow-count refresh; no connection or environment files loaded"
        );
        return ExitCode::SUCCESS;
    }
    // Synchronous environment loading precedes runtime threads. dotenvy's
    // non-override API preserves existing variables and earlier-file precedence.
    if let Err(message) = load_env_files(&args.env_files) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("Cannot create worker runtime");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<(), &'static str> {
    let client = get_mongo_client()
        .await
        .map_err(|_| "Cannot initialize MongoDB client")?;
    let database = match args.database {
        Some(name) => client.database(&name),
        None => client
            .default_database()
            .ok_or("Select a database using --database or MONGO_URI")?,
    };
    let projector = RaidAnalyticsProjector::new(database);
    let (stopping, mut stopped) = watch::channel(false);
    let signal_task = spawn_shutdown_signal(stopping);
    let result = async {
        let mut idle = IdleBackoff::default();
        // Unknown after every restart until a non-idle batch fully succeeds.
        // Monotonic time keeps clock adjustments out of last-success age.
        let mut last_success = None;
        let mut last_health: Option<Instant> = None;
        while !*stopped.borrow() {
            // Never cancel an active batch on a shutdown signal.
            let started = Instant::now();
            let observation = projector.project_once_observed().await;
            // A no-change repair publishes zero events but still claims a
            // channel. Continue draining due channels without idle backoff.
            let claimed = observation.phases.release_ms.is_some();
            let projected = observation.result;
            if matches!(&projected, Ok(count) if *count > 0) {
                last_success = Some(Instant::now());
            }
            if args.telemetry_json {
                // Reporting cannot turn successful projection into a failure.
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    batch_telemetry(
                        projected.as_ref().copied().unwrap_or(0),
                        metric_elapsed_ms(started),
                        projected.is_ok(),
                        &observation.phases
                    )
                );
                if last_health.is_none_or(|at| at.elapsed() >= HEALTH_INTERVAL) {
                    // One bounded probe at a time, only between batches. A
                    // query failure cannot fail projection or invent a zero
                    // backlog; last-success age remains independently known.
                    let health = tokio::time::timeout(
                        HEALTH_TIMEOUT,
                        projector.backlog_health(DateTime::now()),
                    )
                    .await
                    .ok()
                    .and_then(Result::ok);
                    last_health = Some(Instant::now());
                    let _ = writeln!(
                        std::io::stdout().lock(),
                        "{}",
                        health_telemetry(health.as_ref(), last_success.map(metric_elapsed_ms))
                    );
                }
            }
            projected
                .map_err(|_| "Raid analytics projection failed; channel retained for retry")?;
            if args.once || *stopped.borrow() {
                break;
            }
            if let Some(wait) = idle.after_batch(usize::from(claimed)) {
                tokio::select! { _ = tokio::time::sleep(wait) => {}, _ = stopped.changed() => {} }
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
    use super::{Args, IdleBackoff, batch_telemetry, health_telemetry};
    use dima_rust::workers::raid_analytics::{BacklogHealth, PhaseTimings};
    use std::time::Duration;

    #[test]
    fn idle_polling_is_bounded_and_work_resets_without_waiting() {
        let mut idle = IdleBackoff::default();
        for seconds in [1, 2, 4, 5, 5, 5] {
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(seconds)));
        }
        // Both a small batch and a full backlog batch resume immediately.
        for count in [1, usize::MAX] {
            assert_eq!(idle.after_batch(count), None);
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(1)));
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(2)));
        }
    }

    #[test]
    fn explicit_files_and_arguments_only() {
        let args = Args::parse(
            [
                "--env-file",
                "first",
                "--env-file",
                "second",
                "--once",
                "--telemetry-json",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(args.env_files.len(), 2);
        assert!(args.once);
        assert!(args.telemetry_json);
        assert!(Args::parse(["--database"].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--unknown"].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--database", ""].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--env-file"].into_iter().map(String::from)).is_err());
    }

    #[test]
    fn batch_protocol_contains_only_bounded_metadata() {
        for (events, success) in [(0, true), (1, true), (0, false), (usize::MAX, true)] {
            let phases = PhaseTimings {
                claim_ms: Some(1.0),
                ..PhaseTimings::default()
            };
            let line = batch_telemetry(events, 12.5, success, &phases);
            assert!(line.len() < 1024);
            let value: serde_json::Value =
                serde_json::from_str(line.strip_prefix("raid_analytics:").unwrap()).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 5);
            assert_eq!(value["event"], "batch");
            assert_eq!(value["events"], events.min(1));
            assert_eq!(value["durationMs"], 12.5);
            assert_eq!(value["success"], success);
            assert_eq!(value["phases"], serde_json::json!({ "claimMs": 1.0 }));
        }
    }

    #[test]
    fn health_unknown_empty_and_failed_samples_remain_distinct() {
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
                    oldest_due_age_ms: Some(456),
                }),
                Some(12.0),
                serde_json::json!({ "event": "health", "success": true, "dueChannels": 3, "oldestDueAgeMs": 456, "lastSuccessAgeMs": 12.0 }),
            ),
        ] {
            let line = health_telemetry(health.as_ref(), last_success);
            assert!(line.len() < 1024);
            let actual: serde_json::Value =
                serde_json::from_str(line.strip_prefix("raid_analytics:").unwrap()).unwrap();
            assert_eq!(actual, expected);
        }
    }
}
