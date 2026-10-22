//! Standalone ownership of the seven native cron children.
//!
//! This module has no import-time initialization. The executable loads only
//! explicitly selected environment files before constructing runtime threads.

pub mod process;
pub mod registry;
pub mod telemetry;

use std::{path::PathBuf, time::Duration};

use crate::utils::js_compat::trim;
pub use crate::utils::worker_process::load_env_files;
use registry::{Environment, WorkerSpec, selected_workers};
use serde_json::json;

pub const HELP: &str = "Usage: cron_index [--once] [--dry-run] [--events-json] [--workers NAME,...] [--env-file PATH]...\n\nStandalone Rust supervisor for the seven registered native cron workers.\nNo automatic .env loading; inherited environment and earlier explicit files win.\n--once runs each enabled worker once, without restart, and aggregates failures.\n--dry-run prints registry/launch metadata without spawning workers or telemetry.\n--workers selects known registry names for explicit standalone/isolated use.\n--events-json additionally emits validated batch/health frames as cron_index: JSON.\nCRON_WORKER_RESTART_DELAY_MS defaults to 5000 ms, with a 1000 ms minimum.\nNon-finite/invalid values and timers above 2147483647 ms fall back to 5000 ms.\nSIGTERM or Ctrl-C allows 25 seconds for children, with a shared 27-second close/export deadline.";

#[derive(Debug, Default)]
pub struct Args {
    pub help: bool,
    pub once: bool,
    pub dry_run: bool,
    pub events_json: bool,
    pub workers: Option<String>,
    pub env_files: Vec<PathBuf>,
}

impl Args {
    pub fn parse(arguments: impl Iterator<Item = String>) -> Result<Self, &'static str> {
        let mut args = Self::default();
        let mut arguments = arguments.peekable();
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--help" | "-h" => args.help = true,
                "--once" => args.once = true,
                "--dry-run" => args.dry_run = true,
                "--events-json" => args.events_json = true,
                "--workers" => {
                    if args.workers.is_some() {
                        return Err("Repeated worker selection");
                    }
                    let names = arguments.next().ok_or("Missing worker selection")?;
                    selected_workers(Some(&names))?;
                    args.workers = Some(names);
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

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub once: bool,
    pub events_json: bool,
    pub restart_delay: Duration,
    pub shutdown_grace: Duration,
}

impl Config {
    pub fn from_args(args: &Args, env: &Environment) -> Self {
        Self {
            once: args.once,
            events_json: args.events_json,
            restart_delay: restart_delay(
                env.get(std::ffi::OsStr::new("CRON_WORKER_RESTART_DELAY_MS"))
                    .and_then(|value| value.to_str()),
            ),
            shutdown_grace: Duration::from_secs(25),
        }
    }
}

/// Mirror Number(value || 5000), including whitespace and radix literals.
/// Oversized timers are invalid instead of inheriting Node's 1 ms overflow.
pub fn restart_delay(value: Option<&str>) -> Duration {
    let value = trim(value.filter(|value| !value.is_empty()).unwrap_or("5000"));
    let numeric = if value.is_empty() {
        Some(0.0)
    } else if value.starts_with("0x") || value.starts_with("0X") {
        radix_number(&value[2..], 16)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        radix_number(&value[2..], 8)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        radix_number(&value[2..], 2)
    } else {
        value.parse::<f64>().ok()
    };
    let milliseconds = numeric
        .filter(|n| n.is_finite() && *n <= 2_147_483_647.0)
        .map(|n| n.max(1000.0).floor())
        .unwrap_or(5000.0);
    Duration::from_millis(milliseconds as u64)
}

fn radix_number(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
        return None;
    }
    // Overflowing u64 is already beyond the supported timer range.
    u64::from_str_radix(digits, radix)
        .ok()
        .map(|number| number as f64)
}

pub fn print_dry_run(workers: &[&WorkerSpec], config: Config, env: &Environment) {
    let (uid, gid) = process::worker_identity();
    process::emit_cli(json!({
        "event": "dry-run", "worker": "cron_index", "once": config.once,
        "restartDelayMs": config.restart_delay.as_millis() as u64,
        "shutdownGraceMs": 25_000,
        "workers": workers.iter().map(|worker| worker.launch_metadata(env, config.once, uid, gid))
            .collect::<Vec<_>>(),
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, &'static str> {
        Args::parse(args.iter().map(|arg| (*arg).into()))
    }

    #[test]
    fn cli_accepts_only_registered_selection_and_explicit_files() {
        let args = parse(&[
            "--once",
            "--events-json",
            "--workers",
            "raid-sessions",
            "--env-file",
            "first",
            "--env-file",
            "second",
        ])
        .unwrap();
        assert!(args.once && args.events_json);
        assert_eq!(args.workers.as_deref(), Some("raid-sessions"));
        assert_eq!(
            args.env_files,
            [PathBuf::from("first"), PathBuf::from("second")]
        );
        assert!(
            parse(&["--help", "--env-file", "/does/not/exist"])
                .unwrap()
                .help
        );
        for invalid in [
            vec!["--workers"],
            vec!["--workers", "invalid"],
            vec!["--workers", "raid-sessions", "--workers", "raid-sessions"],
            vec!["--env-file"],
            vec!["--env-file", ""],
            vec!["--command", "/bin/sh"],
        ] {
            assert!(parse(&invalid).is_err());
        }
    }

    #[test]
    fn restart_numbers_keep_the_existing_minimum_without_invalid_timer_spins() {
        for (value, expected) in [
            (None, 5000),
            (Some(""), 5000),
            (Some(" "), 1000),
            (Some("\u{feff}"), 1000),
            (Some("-12"), 1000),
            (Some("0"), 1000),
            (Some("1.25e3"), 1250),
            (Some("1500.99"), 1500),
            (Some("0x1000"), 4096),
            (Some("0o4000"), 2048),
            (Some("0b100000000000"), 2048),
            (Some("NaN"), 5000),
            (Some("Infinity"), 5000),
            (Some("-Infinity"), 5000),
            (Some("1200ms"), 5000),
            (Some("1_200"), 5000),
            (Some("+0x1000"), 5000),
            (Some("0x+1000"), 5000),
            (Some("\u{0085}1000\u{0085}"), 5000),
            (Some("2147483647"), 2147483647),
            (Some("2147483648"), 5000),
            (Some("1e99"), 5000),
        ] {
            assert_eq!(
                restart_delay(value),
                Duration::from_millis(expected),
                "{value:?}"
            );
        }
    }
}
