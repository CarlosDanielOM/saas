//! Native baseline child of the existing cron supervisor; no automatic dotenv.
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use dima_rust::{
    utils::mongo::get_mongo_client,
    workers::follow_defense_baseline::FollowDefenseBaselineProjector,
};
use tokio::sync::watch;

const HELP: &str = "Usage: follow_defense_baseline [--dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nRefreshes one due follow-defense baseline per second. MongoDB aggregates are read-only.\nUses the existing Redis due queue and seven-day baseline cache.\nNo automatic .env loading. MONGO_URI must name a database, or supply --database.\nExisting environment wins; explicit environment files load before runtime threads.\nFailed ticks retain the retry receipt and continue; --once reports failure with a nonzero exit.\nA 30-second hung-tick watchdog exits nonzero for supervisor recovery.";
const WATCHDOG: Duration = Duration::from_secs(30);

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

fn batch_telemetry(result: &Result<usize, &'static str>, duration_ms: f64) -> String {
    format!(
        "follow_defense_baseline:{}",
        serde_json::json!({
            "event": "batch", "events": result.as_ref().copied().unwrap_or(0).min(1),
            "durationMs": duration_ms, "success": result.is_ok()
        })
    )
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
    for path in &args.env_files {
        if dotenvy::from_path(path).is_err() {
            eprintln!("follow_defense_baseline_rust: Cannot load selected environment file");
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

async fn tick(database_name: Option<&str>) -> Result<usize, &'static str> {
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
        .project_once()
        .await
}

async fn run(args: Args) -> Result<(), &'static str> {
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
            // Signals only stop subsequent ticks; active work drains, bounded
            // by the same watchdog as the original TypeScript worker.
            let attempt = tokio::time::timeout(WATCHDOG, tick(args.database.as_deref())).await;
            let hung = attempt.is_err();
            let result = attempt.unwrap_or(Err("Baseline tick exceeded 30-second watchdog"));
            if args.telemetry_json {
                let duration_ms = (started.elapsed().as_secs_f64() * 1000.0).min(1_000_000_000_000_000.0);
                // A telemetry write failure cannot fail a successful refresh.
                let _ = writeln!(std::io::stdout().lock(), "{}", batch_telemetry(&result, duration_ms));
            }
            if hung { return Err("Baseline tick exceeded 30-second watchdog"); }
            if args.once { return result.map(|_| ()); }
            if let Err(message) = result { eprintln!("follow_defense_baseline_rust: {message}"); }
            if *stopped.borrow() { break; }
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = stopped.changed() => {} }
        }
        Ok(())
    }.await;
    signal_task.abort();
    let _ = signal_task.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let line = batch_telemetry(&result, 12.5);
            let payload: serde_json::Value =
                serde_json::from_str(line.strip_prefix("follow_defense_baseline:").unwrap())
                    .unwrap();
            assert_eq!(
                payload,
                serde_json::json!({ "event": "batch", "events": events, "durationMs": 12.5, "success": success })
            );
            assert!(line.len() < 256);
        }
    }
}
