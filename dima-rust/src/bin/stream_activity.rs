//! Manual executable only; never starts as part of the library or TS supervisor.
use std::{path::PathBuf, process::ExitCode, time::Duration};

use dima_rust::{
    utils::mongo::get_mongo_client, workers::stream_activity::StreamActivityProjector,
};
use tokio::sync::watch;

const HELP: &str = "Usage: stream_activity [--dry-run] [--once] [--batch-size N] [--database NAME] [--env-file PATH]...\n\nManual MongoDB 8.0+ stream-activity projector. No automatic .env loading.\nMONGO_URI must name a database, or supply --database. Existing environment wins.\nDefault batch: 500 (clamped 1–1000); continuous mode waits 1s only when idle.";

#[derive(Default)]
struct Args {
    help: bool,
    dry_run: bool,
    once: bool,
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
        while !*stopped.borrow() {
            // Never cancel an active batch on a shutdown signal.
            let count = projector.project_batch(args.batch_size.unwrap_or(500)).await
                .map_err(|_| "Stream activity projection failed; checkpoint retained for retry")?;
            if args.once || *stopped.borrow() { break; }
            if count == 0 {
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = stopped.changed() => {} }
            }
        }
        Ok(())
    }.await;
    signal_task.abort();
    let _ = signal_task.await;
    result
}

#[cfg(test)]
mod tests {
    use super::Args;

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
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(args.env_files.len(), 2);
        assert_eq!(args.batch_size.unwrap().clamp(1, 1000), 1000);
        assert!(args.once);
        assert!(Args::parse(["--database"].into_iter().map(String::from)).is_err());
        assert!(Args::parse(["--batch-size", "nope"].into_iter().map(String::from)).is_err());
    }
}
