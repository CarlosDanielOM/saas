//! Stream-activity executable for the cron supervisor and explicit manual runs.
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use dima_rust::{
    utils::mongo::get_mongo_client, workers::stream_activity::StreamActivityProjector,
};
use tokio::sync::watch;

const HELP: &str = "Usage: stream_activity [--dry-run] [--once] [--telemetry-json] [--batch-size N] [--database NAME] [--env-file PATH]...\n\nManual MongoDB 8.0+ stream-activity projector. No automatic .env loading.\nMONGO_URI must name a database, or supply --database. Existing environment wins.\nDefault batch: 500 (clamped 1–1000); idle polling backs off from 1s to 5s and resets after work. Backlog is processed without waiting.\n--telemetry-json emits bounded batch metadata to stdout for the parent supervisor.";

fn batch_telemetry(events: usize, duration_ms: f64, success: bool) -> String {
    format!(
        "stream_activity:{}",
        serde_json::json!({
            "event": "batch", "events": events.min(1000), "durationMs": duration_ms, "success": success
        })
    )
}

/// Consecutive empty batches back off; any work restores responsive polling.
struct IdleBackoff {
    next_seconds: u64,
}

impl Default for IdleBackoff {
    fn default() -> Self {
        Self { next_seconds: 1 }
    }
}

impl IdleBackoff {
    fn after_batch(&mut self, count: usize) -> Option<Duration> {
        if count > 0 {
            self.next_seconds = 1;
            None
        } else {
            let wait = Duration::from_secs(self.next_seconds);
            self.next_seconds = (self.next_seconds * 2).min(5);
            Some(wait)
        }
    }
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
    for path in &args.env_files {
        if dotenvy::from_path(path).is_err() {
            eprintln!("Cannot load selected environment file");
            return ExitCode::FAILURE;
        }
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
    let signal_task = tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(signal) => signal,
                    Err(_) => {
                        let _ = stopping.send(true);
                        return;
                    }
                };
            tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = stopping.send(true);
    });
    let result = async {
        let mut idle = IdleBackoff::default();
        while !*stopped.borrow() {
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
    use super::{Args, IdleBackoff, batch_telemetry};
    use std::time::Duration;

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
