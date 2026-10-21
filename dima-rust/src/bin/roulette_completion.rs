//! Roulette-completion executable for the cron supervisor and manual runs.
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use dima_rust::{utils::mongo::get_mongo_client, workers::roulette_completion::RouletteCompletion};
use tokio::sync::watch;

const HELP: &str = "Usage: roulette_completion [--help | --dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nSettles due roulette draws in the existing roulette_channels collection.\nNo automatic .env loading; MONGO_URI must name a database, or supply --database.\nExisting environment wins; explicit environment files load after --dry-run and before runtime threads.\nEach pass polls at most 100 indexed dueAt deadlines and compare-and-swaps state with revision.\nReady due work continues immediately; idle or blocked passes poll every second. A signal finishes the current pass and exits cleanly.\nStorage failures and a 20-second hung-pass watchdog exit nonzero for supervisor recovery.";
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Below the supervisor's 25-second shutdown grace, so a hung pass can still
/// end its process before SIGKILL.
const PASS_WATCHDOG: Duration = Duration::from_secs(20);
/// The supervisor discards native batch durations above five minutes.
const MAX_DURATION_MS: f64 = 300_000.0;
const STORAGE_FAILED: &str = "Roulette completion pass failed";
const WATCHDOG_EXCEEDED: &str = "Roulette completion pass exceeded 20-second watchdog";

fn metric_duration(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0).min(MAX_DURATION_MS)
}

fn batch_telemetry(result: &Result<usize, &'static str>, duration_ms: f64) -> String {
    format!(
        "roulette_completion:{}",
        serde_json::json!({
            "event": "batch",
            "events": result.as_ref().copied().unwrap_or(0).min(100),
            "durationMs": duration_ms,
            "success": result.is_ok(),
        })
    )
}

async fn wait_or_stop(wait: Duration, stopped: &mut watch::Receiver<bool>) {
    if !*stopped.borrow() {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = stopped.changed() => {}
        }
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
    fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Self, &'static str> {
        let mut args = Self::default();
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
            "Roulette completion: bounded due-deadline polls; no connection or environment files loaded"
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
    let database = match args.database.as_deref() {
        Some(name) => client.database(name),
        None => client
            .default_database()
            .ok_or("Select a database using --database or MONGO_URI")?,
    };
    let completion = RouletteCompletion::new(database);
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
        while !*stopped.borrow() {
            let started = Instant::now();
            // A signal never cancels the active pass; the bounded write is
            // either fully applied by its single-document CAS or not at all.
            let (result, ready) =
                match tokio::time::timeout(PASS_WATCHDOG, completion.settle_due_with_readiness())
                    .await
                {
                    Ok(Ok(outcome)) => (Ok(outcome.changed), outcome.ready),
                    Ok(Err(_)) => (Err(STORAGE_FAILED), false),
                    Err(_) => (Err(WATCHDOG_EXCEEDED), false),
                };
            if args.telemetry_json {
                // Reporting cannot turn a pass outcome into another outcome.
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    batch_telemetry(&result, metric_duration(started))
                );
            }
            // Storage failures exit for supervisor recovery instead of
            // silently falling back to the TypeScript worker.
            result?;
            if args.once {
                return Ok(());
            }
            if *stopped.borrow() {
                break;
            }
            if ready {
                // Yield between bounded passes for signals and runtime fairness.
                tokio::task::yield_now().await;
            } else {
                wait_or_stop(POLL_INTERVAL, &mut stopped).await;
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
    fn arguments_are_strict_and_only_explicit_files_load() {
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
            vec!["positional"],
        ] {
            assert!(Args::parse(invalid.into_iter().map(String::from)).is_err());
        }
    }

    #[test]
    fn telemetry_frames_carry_only_bounded_batch_metadata() {
        for (result, events, success) in [
            (Ok(0), 0, true),
            (Ok(1), 1, true),
            (Ok(100), 100, true),
            (Ok(usize::MAX), 100, true),
            (Err("storage failed"), 0, false),
        ] {
            let line = batch_telemetry(&result, 12.5);
            let payload: serde_json::Value =
                serde_json::from_str(line.strip_prefix("roulette_completion:").unwrap()).unwrap();
            assert_eq!(
                payload,
                serde_json::json!({
                    "event": "batch", "events": events, "durationMs": 12.5, "success": success,
                })
            );
            assert!(line.len() < 256);
        }
    }

    #[test]
    fn poll_and_watchdog_bounds_match_the_supervisor_contract() {
        let poll = POLL_INTERVAL;
        let watchdog = PASS_WATCHDOG;
        let max_duration = MAX_DURATION_MS;
        assert_eq!(poll, Duration::from_secs(1));
        assert!(watchdog < Duration::from_secs(25));
        assert!(max_duration <= 300_000.0);
        let duration = metric_duration(Instant::now());
        assert!(duration.is_finite() && (0.0..=max_duration).contains(&duration));
    }

    #[tokio::test]
    async fn signals_interrupt_idle_and_post_pass_waits() {
        let (stopping, mut stopped) = watch::channel(false);
        let signal = tokio::spawn(async move {
            let _ = stopping.send(true);
        });
        assert!(
            tokio::time::timeout(POLL_INTERVAL, wait_or_stop(POLL_INTERVAL, &mut stopped))
                .await
                .is_ok()
        );
        signal.await.unwrap();
        // An already-observed signal also bypasses the next wait.
        assert!(
            tokio::time::timeout(POLL_INTERVAL, wait_or_stop(POLL_INTERVAL, &mut stopped))
                .await
                .is_ok()
        );
    }
}
