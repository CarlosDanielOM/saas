//! Stream-activity executable for the cron supervisor and explicit manual runs.
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
    workers::stream_activity::{HEALTH_METRIC_MAX, StreamActivityHealth, StreamActivityProjector},
};
use mongodb::bson::DateTime;
use tokio::sync::watch;

const HELP: &str = "Usage: stream_activity [--dry-run] [--once] [--telemetry-json] [--batch-size N] [--database NAME] [--env-file PATH]...\n\nManual MongoDB 8.0+ stream-activity projector. No automatic .env loading.\nMONGO_URI must name a database, or supply --database. Existing environment wins.\nDefault batch: 500 (clamped 1–1000); idle polling backs off from 1s to 5s and resets after work. Backlog is processed without waiting.\n--telemetry-json emits bounded batch and periodic health metadata to stdout for the parent supervisor.";
const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

fn batch_telemetry(events: usize, duration_ms: f64, success: bool) -> String {
    format!(
        "stream_activity:{}",
        serde_json::json!({
            "event": "batch", "events": events.min(1000), "durationMs": duration_ms, "success": success
        })
    )
}

fn last_success_age_ms(last_success: Option<Instant>, now: Instant) -> Option<u64> {
    last_success.map(|at| {
        now.saturating_duration_since(at)
            .as_millis()
            .min(u128::from(HEALTH_METRIC_MAX)) as u64
    })
}

fn health_telemetry(
    health: Option<&StreamActivityHealth>,
    last_success_age: Option<u64>,
) -> String {
    let mut metadata = serde_json::json!({ "event": "health", "success": health.is_some() });
    if let Some(health) = health {
        metadata["hasPending"] = health.has_pending.into();
        if let Some(age) = health.oldest_pending_age_ms {
            metadata["oldestPendingAgeMs"] = age.into();
        }
        if let Some(seq) = health.checkpoint_seq {
            metadata["checkpointSeq"] = seq.into();
        }
        if let Some(count) = health.active_batch_events {
            metadata["activeBatchEvents"] = count.into();
        }
    }
    if let Some(age) = last_success_age {
        metadata["lastSuccessAgeMs"] = age.into();
    }
    format!("stream_activity:{metadata}")
}

#[derive(Default)]
struct Args {
    help: bool,
    dry_run: bool,
    once: bool,
    telemetry_json: bool,
    batch_size: Option<usize>,
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
                "--batch-size" => {
                    args.batch_size = Some(
                        arguments
                            .next()
                            .ok_or("Missing batch size")?
                            .parse()
                            .map_err(|_| "Invalid batch size")?,
                    )
                }
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
            "Stream activity: bounded {}-event batches; no connection or environment files loaded",
            args.batch_size.unwrap_or(500).clamp(1, 1000)
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
    let projector = StreamActivityProjector::new(database);
    let (stopping, mut stopped) = watch::channel(false);
    let signal_task = spawn_shutdown_signal(stopping);
    let result = async {
        let mut idle = IdleBackoff::default();
        // Process-local monotonic age remains unknown after restart until work succeeds.
        let mut last_success = None;
        let mut last_health: Option<Instant> = None;
        while !*stopped.borrow() {
            if args.telemetry_json && last_health.is_none_or(|at| at.elapsed() >= HEALTH_INTERVAL) {
                // Health runs only between batches, including startup. A failed or
                // timed-out read cannot fail projection or trigger child recovery.
                // Shutdown waits at most this probe's remaining two-second bound.
                let health =
                    tokio::time::timeout(HEALTH_TIMEOUT, projector.health(DateTime::now()))
                        .await
                        .ok()
                        .and_then(Result::ok);
                last_health = Some(Instant::now());
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    health_telemetry(
                        health.as_ref(),
                        last_success_age_ms(last_success, Instant::now())
                    )
                );
                if *stopped.borrow() {
                    break;
                }
            }
            // Never cancel an active batch on a shutdown signal.
            let started = Instant::now();
            let projected = projector
                .project_batch(args.batch_size.unwrap_or(500))
                .await;
            if args.telemetry_json {
                // Reporting cannot turn successful projection into a failure.
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    batch_telemetry(
                        projected.as_ref().copied().unwrap_or(0),
                        started.elapsed().as_secs_f64() * 1000.0,
                        projected.is_ok()
                    )
                );
            }
            let count = projected
                .map_err(|_| "Stream activity projection failed; checkpoint retained for retry")?;
            if count > 0 {
                last_success = Some(Instant::now());
            }
            if args.once || *stopped.borrow() {
                break;
            }
            if let Some(wait) = idle.after_batch(count) {
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
    use super::{Args, IdleBackoff, batch_telemetry, health_telemetry, last_success_age_ms};
    use dima_rust::workers::stream_activity::{HEALTH_METRIC_MAX, StreamActivityHealth};
    use std::time::{Duration, Instant};

    #[test]
    fn health_unknown_empty_pending_and_failed_samples_remain_distinct() {
        for (health, last_success, expected) in [
            (
                None,
                None,
                serde_json::json!({ "event": "health", "success": false }),
            ),
            (
                None,
                Some(123),
                serde_json::json!({ "event": "health", "success": false, "lastSuccessAgeMs": 123 }),
            ),
            (
                Some(StreamActivityHealth {
                    has_pending: false,
                    oldest_pending_age_ms: None,
                    checkpoint_seq: None,
                    active_batch_events: None,
                }),
                None,
                serde_json::json!({ "event": "health", "success": true, "hasPending": false }),
            ),
            (
                Some(StreamActivityHealth {
                    has_pending: false,
                    oldest_pending_age_ms: None,
                    checkpoint_seq: Some(0),
                    active_batch_events: Some(0),
                }),
                None,
                serde_json::json!({ "event": "health", "success": true, "hasPending": false, "checkpointSeq": 0, "activeBatchEvents": 0 }),
            ),
            (
                Some(StreamActivityHealth {
                    has_pending: true,
                    oldest_pending_age_ms: Some(HEALTH_METRIC_MAX),
                    checkpoint_seq: Some(HEALTH_METRIC_MAX),
                    active_batch_events: Some(1000),
                }),
                Some(HEALTH_METRIC_MAX),
                serde_json::json!({ "event": "health", "success": true, "hasPending": true, "oldestPendingAgeMs": HEALTH_METRIC_MAX, "checkpointSeq": HEALTH_METRIC_MAX, "activeBatchEvents": 1000, "lastSuccessAgeMs": HEALTH_METRIC_MAX }),
            ),
        ] {
            let line = health_telemetry(health.as_ref(), last_success);
            assert!(line.len() < 1024);
            let value: serde_json::Value =
                serde_json::from_str(line.strip_prefix("stream_activity:").unwrap()).unwrap();
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn success_age_is_unknown_until_work_and_uses_monotonic_time() {
        let started = Instant::now();
        assert_eq!(last_success_age_ms(None, started), None);
        assert_eq!(last_success_age_ms(Some(started), started), Some(0));
        assert_eq!(
            last_success_age_ms(Some(started), started + Duration::from_millis(123)),
            Some(123)
        );
        assert_eq!(
            last_success_age_ms(Some(started + Duration::from_secs(1)), started),
            Some(0)
        );
        assert_eq!(
            last_success_age_ms(
                Some(started),
                started + Duration::from_millis(HEALTH_METRIC_MAX + 1)
            ),
            Some(HEALTH_METRIC_MAX)
        );
    }

    #[test]
    fn idle_polling_is_bounded_and_work_resets_without_waiting() {
        let mut idle = IdleBackoff::default();
        for seconds in [1, 2, 4, 5, 5, 5] {
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(seconds)));
        }
        // Both a small batch and a full backlog batch resume immediately.
        for count in [1, 500, usize::MAX] {
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
                "--batch-size",
                "1001",
                "--once",
                "--telemetry-json",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(args.env_files.len(), 2);
        assert_eq!(args.batch_size.unwrap().clamp(1, 1000), 1000);
        assert!(args.once);
        assert!(args.telemetry_json);
        assert!(Args::parse(["--database"].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--batch-size", "nope"].into_iter().map(String::from)).is_err());
    }

    #[test]
    fn batch_protocol_contains_only_bounded_metadata() {
        for (events, success) in [(0, true), (500, true), (0, false), (usize::MAX, true)] {
            let line = batch_telemetry(events, 12.5, success);
            assert!(line.len() < 1024);
            let value: serde_json::Value =
                serde_json::from_str(line.strip_prefix("stream_activity:").unwrap()).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 4);
            assert_eq!(value["event"], "batch");
            assert_eq!(value["events"], events.min(1000));
            assert_eq!(value["durationMs"], 12.5);
            assert_eq!(value["success"], success);
        }
    }
}
