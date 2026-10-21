//! Native AI usage receipts worker; existing queues, accounting, and dashboards.
use dima_rust::{
    utils::{mongo::get_mongo_client, redis::get_redis_client},
    workers::ai_usage_receipts::{AiUsageReceipts, BatchOutcome, Config},
};
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};
use tokio::sync::watch;

const HELP: &str = "Usage: ai_usage_receipts [--help | --dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nConsumes the existing durable AI usage receipts queue, repairs UTC aggregates, refreshes dashboards and queue health.\nNo billing/provider calls or schema/index migration. No automatic dotenv loading.\nMONGO_URI must name a database, or pass --database. Existing environment wins over explicit files.\nSignals stop new jobs and drain the active unit. A 20-second active-unit timeout retains processing payloads and ownership TTLs and exits nonzero for recovery.\nClean full batches continue immediately; idle, nonfatal failed, or unowned batches keep the configured interval.\nAI_USAGE_RECEIPTS_INTERVAL_MS, AI_USAGE_RECEIPTS_BATCH_SIZE, AI_USAGE_RECEIPTS_LOCK_KEY, AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS and existing queue-health thresholds are honored.";
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

fn batch_telemetry(result: &Result<BatchOutcome, &'static str>, duration_ms: f64) -> String {
    let success = result.as_ref().is_ok_and(|outcome| outcome.success);
    format!(
        "ai_usage_receipts:{}",
        serde_json::json!({"event":"batch","events":result.as_ref().ok().filter(|outcome|outcome.success).map_or(0,|outcome|outcome.processed.min(1000)),"durationMs":duration_ms,"success":success})
    )
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
            "AI usage receipts: durable receipt accounting and derived dashboards; no connections or environment files loaded"
        );
        return ExitCode::SUCCESS;
    }
    for path in &args.env_files {
        if dotenvy::from_path(path).is_err() {
            eprintln!("Cannot load selected environment file");
            return ExitCode::FAILURE;
        }
    }
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    if !config.enabled {
        return ExitCode::SUCCESS;
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
    match runtime.block_on(run(args, config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
async fn run(args: Args, config: Config) -> Result<(), &'static str> {
    let (stopping, mut stopped) = watch::channel(false);
    let signal = tokio::spawn(async move {
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
            tokio::select! {_=terminate.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = stopping.send(true);
    });
    let result = async {
        // Initialization is bounded too; it has no claimed jobs or ledger writes.
        let (client, cache) = tokio::time::timeout(Duration::from_secs(20), async {
            let client = get_mongo_client()
                .await
                .map_err(|_| "Cannot initialize MongoDB client")?;
            let cache = get_redis_client()
                .await
                .map_err(|_| "Cannot initialize Redis client")?;
            Ok::<_, &'static str>((client, cache))
        })
        .await
        .map_err(|_| "AI usage initialization timed out")??;
        let database = match args.database.as_deref() {
            Some(name) => client.database(name),
            None => client
                .default_database()
                .ok_or("Select a database using --database or MONGO_URI")?,
        };
        let interval = Duration::from_millis(config.interval_ms);
        let mut worker = AiUsageReceipts::new(database, cache, config);
        while !*stopped.borrow() {
            let started = Instant::now();
            let result = async {
                let outcome = worker.run_batch_with_readiness(&stopped).await?;
                worker.maintain(&stopped, args.once).await?;
                Ok::<_, &'static str>(outcome)
            }
            .await;
            let (result, ready) = match result {
                Ok(outcome) => (Ok(outcome.batch), outcome.ready),
                Err(error) => (Err(error), false),
            };
            if args.telemetry_json {
                let _ = writeln!(
                    std::io::stdout().lock(),
                    "{}",
                    batch_telemetry(
                        &result,
                        (started.elapsed().as_secs_f64() * 1000.0).min(300_000.0)
                    )
                );
            }
            let outcome = result?;
            if args.once {
                break;
            }
            if !*stopped.borrow() {
                if ready && outcome.success {
                    // Keep a scheduler turn between bounded batches so signal
                    // handling and lease heartbeats stay fair under backlog.
                    tokio::task::yield_now().await;
                } else {
                    tokio::select! {_=tokio::time::sleep(interval)=>{},_=stopped.changed()=>{}}
                }
            }
        }
        Ok(())
    }
    .await;
    signal.abort();
    let _ = signal.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_frames_have_zero_events_without_requiring_a_process_error() {
        for result in [
            Ok(BatchOutcome {
                processed: 3,
                success: false,
            }),
            Err("private storage detail"),
        ] {
            let frame = batch_telemetry(&result, 12.5);
            let value: serde_json::Value =
                serde_json::from_str(frame.strip_prefix("ai_usage_receipts:").unwrap()).unwrap();
            assert_eq!(
                value,
                serde_json::json!({"event":"batch","events":0,"durationMs":12.5,"success":false})
            );
            assert!(!frame.contains("private"));
        }
        assert!(
            batch_telemetry(
                &Ok(BatchOutcome {
                    processed: 1001,
                    success: true
                }),
                0.0
            )
            .contains("1000")
        );
    }
    #[test]
    fn arguments_are_explicit_and_strict() {
        let args = Args::parse(
            [
                "--env-file",
                "one",
                "--env-file",
                "two",
                "--database",
                "fixture",
                "--telemetry-json",
                "--once",
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(
            args.env_files,
            vec![PathBuf::from("one"), PathBuf::from("two")]
        );
        assert!(args.once && args.telemetry_json);
        assert_eq!(args.database.as_deref(), Some("fixture"));
        for invalid in [
            vec!["--database"],
            vec!["--database", ""],
            vec!["--env-file"],
            vec!["--unexpected"],
        ] {
            assert!(Args::parse(invalid.into_iter().map(str::to_owned)).is_err());
        }
    }
}
