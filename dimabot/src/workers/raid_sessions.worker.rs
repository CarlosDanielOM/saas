//! Sole scheduled raid-session maintenance/admission worker. External moderation
//! remains in the existing TypeScript executor; no fallback is implemented here.
use dima_rust::{
    utils::{
        mongo::get_mongo_client,
        redis::get_redis_client,
        worker_process::{load_env_files, spawn_shutdown_signal},
    },
    workers::raid_sessions::{BATCH_SIZE, MAX_EVENTS, RaidSessions, TickOutcome},
};
use mongodb::options::ConnectionString;
use std::{
    io::Write,
    path::PathBuf,
    process::ExitCode,
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const HELP: &str = "Usage: raid_sessions [--help | --dry-run] [--once] [--telemetry-json] [--database NAME] [--env-file PATH]...\n\nMaintains existing raid history, backfills journaled follows and admits durable moderation requests.\nNo external moderation calls, schema/index creation or automatic .env loading.\nMONGO_URI must name a database, or supply --database. Existing environment wins over explicitly selected files.\nEach tick extends one retained session, backfills up to 200 events and admits up to 200 followers, in that order.\nDrains ready backlog in successive bounded ticks; idle and failed ticks wait one second.\nSignals finish the current bounded tick and readiness probe, then stop.\nA hard 20-second initialization/tick watchdog exits nonzero, leaving durable cursors and 60-second leases for recovery.\n--once performs one bounded tick and exits nonzero on failure; normal mode reports sanitized errors and retries after one second.";
const ACTIVE_LIMIT: Duration = Duration::from_secs(20);

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
                    if name.is_empty() || name.starts_with('-') {
                        return Err("Invalid database name");
                    }
                    args.database = Some(name);
                }
                "--env-file" => {
                    let path = arguments.next().ok_or("Missing environment file path")?;
                    if path.is_empty() || path.starts_with("--") {
                        return Err("Invalid environment file path");
                    }
                    args.env_files.push(path.into());
                }
                _ => return Err("Unknown argument; use --help"),
            }
        }
        Ok(args)
    }
}

enum WatchCommand {
    Arm(Instant),
    Disarm,
    Stop,
}
struct Watchdog {
    sender: Sender<WatchCommand>,
    thread: Option<JoinHandle<()>>,
}
impl Watchdog {
    fn new() -> Result<Self, &'static str> {
        let (sender, receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("raid-session-watchdog".into())
            .spawn(move || {
                let mut deadline: Option<Instant> = None;
                loop {
                    let command = match deadline {
                        None => match receiver.recv() {
                            Ok(command) => command,
                            Err(_) => return,
                        },
                        Some(until) => match receiver
                            .recv_timeout(until.saturating_duration_since(Instant::now()))
                        {
                            Ok(command) => command,
                            Err(RecvTimeoutError::Disconnected) => return,
                            Err(RecvTimeoutError::Timeout) => watchdog_exit(),
                        },
                    };
                    match command {
                        WatchCommand::Arm(until) => deadline = Some(until),
                        WatchCommand::Disarm => deadline = None,
                        WatchCommand::Stop => return,
                    }
                }
            })
            .map_err(|_| "Cannot create raid-session watchdog")?;
        Ok(Self {
            sender,
            thread: Some(thread),
        })
    }
    fn arm(&self) -> Result<Instant, &'static str> {
        let started = Instant::now();
        self.sender
            .send(WatchCommand::Arm(started + ACTIVE_LIMIT))
            .map_err(|_| "Raid-session watchdog unavailable")?;
        Ok(started)
    }
    fn disarm(&self, started: Instant) -> Result<(), &'static str> {
        if started.elapsed() >= ACTIVE_LIMIT {
            watchdog_exit();
        }
        self.sender
            .send(WatchCommand::Disarm)
            .map_err(|_| "Raid-session watchdog unavailable")
    }
}
impl Drop for Watchdog {
    fn drop(&mut self) {
        let _ = self.sender.send(WatchCommand::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn watchdog_exit() -> ! {
    eprintln!(
        "Raid session active work exceeded 20-second watchdog; durable work retained for recovery"
    );
    std::process::exit(1)
}

fn batch_telemetry(result: &Result<usize, &'static str>, duration_ms: f64) -> String {
    format!(
        "raid_sessions:{}",
        serde_json::json!({
            "event":"batch","events":result.as_ref().copied().unwrap_or(0).min(MAX_EVENTS),
            "durationMs":duration_ms,"success":result.is_ok()
        })
    )
}

fn continue_immediately(result: &Result<TickOutcome, &'static str>) -> bool {
    result.as_ref().is_ok_and(|outcome| outcome.ready)
}

fn database_name(explicit: Option<&str>, uri: Option<&str>) -> Result<String, &'static str> {
    let uri = uri
        .filter(|uri| !uri.trim().is_empty())
        .ok_or("MONGO_URI must be set")?;
    let parsed =
        ConnectionString::parse(uri).map_err(|_| "Invalid MONGO_URI; raw value omitted")?;
    let name = explicit
        .map(str::to_owned)
        .or(parsed.default_database)
        .ok_or("Select a database using --database or MONGO_URI")?;
    if name.is_empty()
        || name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '.' | ' ' | '"' | '$' | '\0'))
    {
        return Err("Invalid database name");
    }
    Ok(name)
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
            "{}",
            serde_json::json!({"worker":"raid-sessions","batchSize":BATCH_SIZE})
        );
        return ExitCode::SUCCESS;
    }
    // Do this before runtime or watchdog threads: dotenvy's non-override loader
    // preserves inherited variables and the first explicit file's precedence.
    if let Err(message) = load_env_files(&args.env_files) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }
    let database = match database_name(
        args.database.as_deref(),
        std::env::var("MONGO_URI").ok().as_deref(),
    ) {
        Ok(database) => database,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let watchdog = match Watchdog::new() {
        Ok(watchdog) => watchdog,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
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
    let result = runtime.block_on(run(args, &database, &watchdog));
    runtime.shutdown_timeout(Duration::from_secs(1));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args, database: &str, watchdog: &Watchdog) -> Result<(), &'static str> {
    let (stopping, mut stopped) = watch::channel(false);
    let signal = spawn_shutdown_signal(stopping);
    let result=async {
        let started=watchdog.arm()?;
        let initialization=async {
            let client=get_mongo_client().await.map_err(|_| "Cannot initialize MongoDB client")?;
            let cache=get_redis_client().await.map_err(|_| "Cannot initialize Redis client")?;
            Ok::<_,&'static str>((client.database(database),cache))
        }.await;
        watchdog.disarm(started)?;
        let (database,cache)=initialization?;
        let mut worker=RaidSessions::new(database,cache);
        while !*stopped.borrow() {
            let started=watchdog.arm()?;
            let result=if args.once {
                worker.run_once().await.map(|events|TickOutcome {events,ready:false})
            } else {
                worker.run_tick().await
            };
            watchdog.disarm(started)?;
            if args.telemetry_json {
                let events=result.as_ref().map(|outcome|outcome.events).map_err(|&message|message);
                let _=writeln!(std::io::stdout().lock(),"{}",batch_telemetry(&events,(started.elapsed().as_secs_f64()*1000.0).min(300_000.0)));
            }
            if let Err(message)=result {
                if args.once {return Err(message);}
                eprintln!("Raid session tick failed: {message}");
            }
            if args.once || *stopped.borrow() {break;}
            if continue_immediately(&result) {
                // Let the signal task run even while a backlog stays ready.
                // The next loop checks stop before starting another tick.
                tokio::task::yield_now().await;
            } else {
                tokio::select! {_=tokio::time::sleep(Duration::from_secs(1))=>{},_=stopped.changed()=>{}}
            }
        }
        Ok(())
    }.await;
    signal.abort();
    let _ = signal.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_confirmed_ready_work_skips_the_idle_and_error_wait() {
        // Remaining ready maintenance can produce zero events in this tick.
        assert!(continue_immediately(&Ok(TickOutcome {
            events: 0,
            ready: true
        })));
        assert!(continue_immediately(&Ok(TickOutcome {
            events: BATCH_SIZE,
            ready: true
        })));
        // Progress by itself says nothing about remaining work. A live
        // future-only request has already pushed nextAttemptAt ahead and must
        // use the same wait as a completely empty database.
        for events in [0, 1, 199, MAX_EVENTS] {
            assert!(!continue_immediately(&Ok(TickOutcome {
                events,
                ready: false
            })));
        }
        assert!(!continue_immediately(&Err("Raid ready-work lookup failed")));
        assert!(!continue_immediately(&Err(
            "Raid moderation action insert failed"
        )));
    }
    #[test]
    fn strict_arguments_preserve_repeated_explicit_files() {
        let args = Args::parse(
            [
                "--env-file",
                "one",
                "--env-file",
                "two",
                "--database",
                "fixture",
                "--once",
                "--telemetry-json",
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
        for invalid in [
            vec!["--database"],
            vec!["--database", ""],
            vec!["--database", "--once"],
            vec!["--env-file"],
            vec!["--unknown"],
        ] {
            assert!(Args::parse(invalid.into_iter().map(str::to_owned)).is_err());
        }
    }
    #[test]
    fn database_selection_has_no_implicit_default_or_secret_errors() {
        assert!(
            database_name(None, Some("mongodb://secret:password@localhost/"))
                .unwrap_err()
                .contains("Select a database")
        );
        assert_eq!(
            database_name(None, Some("mongodb://localhost/fixture")).unwrap(),
            "fixture"
        );
        assert_eq!(
            database_name(Some("override"), Some("mongodb://localhost/")).unwrap(),
            "override"
        );
        for uri in [None, Some(""), Some("invalid-secret")] {
            assert!(database_name(None, uri).is_err());
        }
        assert!(database_name(Some("bad/name"), Some("mongodb://localhost/")).is_err());
    }
    #[test]
    fn failed_ticks_report_zero_and_bounded_telemetry_never_contains_errors() {
        let frame = batch_telemetry(&Err("storage password secret"), 2.5);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                frame.strip_prefix("raid_sessions:").unwrap()
            )
            .unwrap(),
            serde_json::json!({"event":"batch","events":0,"durationMs":2.5,"success":false})
        );
        assert!(!frame.contains("secret"));
        assert!(batch_telemetry(&Ok(usize::MAX), 1.0).contains("\"events\":401"));
    }
}
