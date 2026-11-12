//! The binary: it refuses a configuration it cannot run with (naming the setting), starts on
//! the local stores, reaches "ready" with every worker started, and on `SIGTERM` or `SIGINT`
//! stops in order and exits 0 well within its budget. Each run has its own database and key
//! prefix (database 11), removed afterwards.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::{Context, Result};
use nix::sys::signal::Signal;
use std::process::Command;
use std::time::{Duration, Instant};
use support::{BINARY, Cron, Stores, clean_log_entries, now_ms};

#[test]
fn an_empty_environment_is_refused_naming_the_setting() -> Result<()> {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(support::unique());
    std::fs::create_dir_all(&dir)?;
    let output = Command::new(BINARY)
        .env_clear()
        .current_dir(&dir)
        .output()?;
    std::fs::remove_dir_all(&dir)?;
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("MONGO_URI is not set"), "{stderr}");
    Ok(())
}

#[test]
fn a_bad_setting_is_refused_naming_it() -> Result<()> {
    let output = Command::new(BINARY)
        .env_clear()
        .current_dir(env!("CARGO_TARGET_TMPDIR"))
        .envs([
            ("NODE_ENV", "production"),
            ("MONGO_URI", "mongodb://127.0.0.1:1/x"),
            ("DRAGONFLY_HOST", "127.0.0.1"),
            ("DRAGONFLY_PORT", "6379"),
            ("SECRET_KEY", support::TEST_SECRET_KEY),
            ("CRON_WORKERS", "stream-activity,nobody"),
        ])
        .output()?;
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid CRON_WORKERS"), "{stderr}");
    assert!(stderr.contains("\"nobody\""), "{stderr}");
    Ok(())
}

#[test]
fn help_and_unknown_commands() -> Result<()> {
    let help = Command::new(BINARY).env_clear().arg("--help").output()?;
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).contains("dima-cron recovery reconcile"));
    let unknown = Command::new(BINARY).env_clear().arg("serve").output()?;
    assert_eq!(unknown.status.code(), Some(1));
    Ok(())
}

async fn starts_and_stops_on(signal: Signal, name: &str) -> Result<()> {
    let Some(stores) = Stores::new().await? else {
        return Ok(());
    };
    let since = now_ms();
    let result = async {
        let mut cron = Cron::start(&stores.cron_env(""), &[])?;
        cron.wait_line("ready", Duration::from_secs(40), |data| {
            data["step"] == "ready"
        })?;
        for worker in [
            "raid-analytics",
            "stream-activity",
            "follow-defense-baseline",
            "token-recovery",
        ] {
            cron.wait_line(worker, Duration::from_secs(5), |data| {
                data["message"] == "Started cron worker" && data["name"] == worker
            })?;
        }
        let sent = Instant::now();
        let status = cron.stop(signal, Duration::from_secs(25))?;
        let took = sent.elapsed();
        assert_eq!(status, 0, "stderr {:?}", cron.stderr.lock().unwrap());
        assert!(took < Duration::from_secs(17), "{took:?}");
        cron.wait_line("shutdown", Duration::from_secs(1), |data| {
            data["function"] == "shutdown" && data["signal"] == name
        })?;
        let stopped = cron.wait_line("stopped", Duration::from_secs(1), |data| {
            data["step"] == "stopped"
        })?;
        assert_eq!(stopped["clean"], true);
        let stopped_workers = cron
            .json_lines()
            .iter()
            .filter(|line| line["data"]["message"] == "Stopped cron worker")
            .count();
        assert_eq!(stopped_workers, 4);
        Ok(())
    }
    .await;
    // The start-up reconciliation logs its counts to the debug log too.
    clean_log_entries(&stores.dragonfly, since, &["reconcileRecovery"]).await?;
    stores.clean().await?;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starts_on_the_stores_and_exits_cleanly_on_sigterm() -> Result<()> {
    starts_and_stops_on(Signal::SIGTERM, "SIGTERM").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starts_on_the_stores_and_exits_cleanly_on_sigint() -> Result<()> {
    starts_and_stops_on(Signal::SIGINT, "SIGINT").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_cannot_be_reached_ends_the_start_with_status_1() -> Result<()> {
    let Some(stores) = Stores::new().await? else {
        return Ok(());
    };
    let result = async {
        let mut env = stores.cron_env("stream-activity");
        // Nothing listens on port 1.
        for (name, value) in &mut env {
            if name == "DRAGONFLY_PORT" {
                *value = "1".to_owned();
            }
        }
        let mut cron = Cron::start(&env, &[])?;
        let status = cron.wait_exit(Duration::from_secs(40))?;
        assert_eq!(status, 1);
        let failure = cron.wait_line("stores", Duration::from_secs(1), |data| {
            data["step"] == "stores"
        })?;
        let error = failure["error"].as_str().context("error")?;
        assert!(error.contains("DRAGONFLY_HOST, DRAGONFLY_PORT"), "{error}");
        Ok(())
    }
    .await;
    stores.clean().await?;
    result
}
