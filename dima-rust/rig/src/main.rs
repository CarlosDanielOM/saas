//! `dima-rig`: the side-by-side rig's command line. See `rig/README.md`.
#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use dima_rig::config::{self, Overrides};
use dima_rig::error::RigError;
use dima_rig::report::Report;
use dima_rig::run::{self, Settings};
use dima_rig::stores::Registry;

#[derive(Parser)]
#[command(
    name = "dima-rig",
    version,
    about = "Run the reference and the Rust candidate on the same scenarios and compare what they did."
)]
struct Cli {
    /// Directory with targets/ and scenarios/ [default: the rig crate; env DIMA_RIG_DIR]
    #[arg(long, global = true)]
    rig_dir: Option<PathBuf>,
    /// Where captures live [default: <rig-dir>/captures]
    #[arg(long, global = true)]
    captures_dir: Option<PathBuf>,
    /// Logs and reports [default: <rig-dir>/out]
    #[arg(long, global = true)]
    out_dir: Option<PathBuf>,
    /// Root MongoDB URI [default: env DIMA_RIG_MONGO_URI, then DIMA_TEST_MONGO_URI]
    #[arg(long, global = true)]
    mongo_uri: Option<String>,
    /// Dragonfly host:port [default: env DIMA_RIG_DRAGONFLY, then DIMA_TEST_DRAGONFLY, then 127.0.0.1:6379]
    #[arg(long, global = true)]
    dragonfly: Option<String>,
    /// Dragonfly logical databases the rig may claim [default: 1-9]
    #[arg(long, global = true, value_name = "LIST")]
    dragonfly_dbs: Option<String>,
    /// Template variable for targets: {var.NAME}
    #[arg(long = "set", global = true, value_name = "NAME=VALUE")]
    set: Vec<String>,
    /// Write the JSON report here [default: <out-dir>/report-<command>-<target>.json]
    #[arg(long, global = true)]
    report: Option<PathBuf>,
    /// Keep the side databases after the run (for inspection)
    #[arg(long, global = true)]
    keep: bool,
    /// Dragonfly keys whose values compare as exact text [default: byte_sensitive.json in the rig crate]
    #[arg(long, global = true, value_name = "FILE")]
    byte_sensitive: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the reference and write captures (runs it twice to prove the scenario is stable)
    Record {
        target: String,
        /// Scenario names, directories or globs [default: all]
        scenarios: Vec<String>,
        /// Run the reference once (skip the stability check)
        #[arg(long)]
        once: bool,
        /// Stored in each capture's provenance: what was recorded, such as the reference's commit id
        #[arg(long)]
        label: Option<String>,
    },
    /// Run the candidate and compare it with the recorded captures
    Verify {
        target: String,
        scenarios: Vec<String>,
    },
    /// Run both sides live and compare them
    Compare {
        target: String,
        scenarios: Vec<String>,
    },
    /// GET a list of paths on both sides over an existing database (read endpoints, real data)
    #[command(name = "diff-get")]
    DiffGet {
        target: String,
        /// MongoDB database both sides read (never written by the rig)
        #[arg(long)]
        db: String,
        /// Request list file (see README)
        #[arg(long)]
        paths: PathBuf,
        /// Skip the before/after dbHash check that proves no side wrote to the database
        #[arg(long)]
        no_write_check: bool,
    },
    /// Check the target and scenario files without running anything
    Check {
        target: String,
        scenarios: Vec<String>,
    },
    /// Drop rig_ databases left behind by rig processes that are gone
    Gc,
}

async fn dispatch(cmd: &Cmd, s: &Settings, reg: &Registry) -> Result<Option<Report>, RigError> {
    Ok(Some(match cmd {
        Cmd::Record {
            target,
            scenarios,
            once,
            label,
        } => run::record(s, reg, target, scenarios, *once, label.as_deref()).await?,
        Cmd::Verify { target, scenarios } => run::verify(s, reg, target, scenarios).await?,
        Cmd::Compare { target, scenarios } => run::compare_live(s, reg, target, scenarios).await?,
        Cmd::DiffGet {
            target,
            db,
            paths,
            no_write_check,
        } => run::diff_get(s, reg, target, db, paths, !no_write_check).await?,
        Cmd::Check { target, scenarios } => run::check(s, target, scenarios)?,
        Cmd::Gc => {
            let dropped = dima_rig::stores::gc(&s.stores.mongo_uri).await?;
            println!(
                "dropped {} database(s){}{}",
                dropped.len(),
                if dropped.is_empty() { "" } else { ": " },
                dropped.join(", ")
            );
            return Ok(None);
        }
    }))
}

fn target_of(cmd: &Cmd) -> &str {
    match cmd {
        Cmd::Record { target, .. }
        | Cmd::Verify { target, .. }
        | Cmd::Compare { target, .. }
        | Cmd::DiffGet { target, .. }
        | Cmd::Check { target, .. } => target,
        Cmd::Gc => "",
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let o = Overrides {
        rig_dir: cli.rig_dir.clone(),
        captures_dir: cli.captures_dir.clone(),
        out_dir: cli.out_dir.clone(),
        mongo_uri: cli.mongo_uri.clone(),
        dragonfly: cli.dragonfly.clone(),
        dragonfly_dbs: cli.dragonfly_dbs.clone(),
        vars: cli.set.clone(),
        keep: cli.keep,
        byte_sensitive: cli.byte_sensitive.clone(),
    };
    let settings = match config::settings(&o, std::env::vars().collect()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("dima-rig: {e}");
            return ExitCode::from(2);
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("dima-rig: cannot start the runtime: {e}");
            return ExitCode::from(2);
        }
    };
    let reg = Registry::default();
    let (result, cleanup) = rt.block_on(async {
        let result = tokio::select! {
            r = dispatch(&cli.cmd, &settings, &reg) => r,
            _ = tokio::signal::ctrl_c() => Err(RigError::Interrupted),
        };
        // One cleanup path for success, error and interruption. When interrupted, dropping the
        // command above already killed the side processes (SIGKILL to their groups).
        let cleanup = reg.cleanup(&settings.stores, settings.keep).await;
        (result, cleanup)
    });
    if let Some(line) = cleanup.summary() {
        eprintln!("dima-rig: {line}");
    }
    for e in &cleanup.errors {
        eprintln!("dima-rig: cleanup failed: {e}; run `dima-rig gc`");
    }
    let result = result.map(|r| {
        r.map(|mut report| {
            report
                .errors
                .extend(cleanup.errors.iter().map(|e| format!("cleanup: {e}")));
            report.finish();
            report
        })
    });
    match result {
        Ok(None) => ExitCode::SUCCESS,
        Ok(Some(report)) => {
            print!("{}", report.to_text());
            let path = cli.report.clone().unwrap_or_else(|| {
                settings.out_dir.join(format!(
                    "report-{}-{}.json",
                    report.command,
                    target_of(&cli.cmd)
                ))
            });
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match serde_json::to_string_pretty(&report).map(|s| std::fs::write(&path, s + "\n")) {
                Ok(Ok(())) => println!("report: {}", path.display()),
                Ok(Err(e)) => eprintln!("dima-rig: cannot write {}: {e}", path.display()),
                Err(e) => eprintln!("dima-rig: cannot encode the report: {e}"),
            }
            if report.ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(RigError::Interrupted) => ExitCode::from(130),
        Err(e) => {
            eprintln!("dima-rig: {e}");
            ExitCode::from(2)
        }
    }
}
