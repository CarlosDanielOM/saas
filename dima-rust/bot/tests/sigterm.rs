//! The binary starts and stops cleanly: it reaches "ready", and on `SIGTERM` (or `SIGINT`) it
//! shuts down in order and exits 0 well within its budget. It runs in an empty directory with
//! an empty environment, so no `.env` file and no store is read.

use anyhow::{Context, bail};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_dima-bot");

/// Kills the child if the test fails half-way, so no process outlives it.
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn starts_and_stops_on(signal: Signal, name: &str) -> anyhow::Result<()> {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("dima-bot-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let mut child = Running(
        Command::new(BINARY)
            .env_clear()
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let stdout = child.0.stdout.take().context("stdout")?;
    let (lines, received) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = lines.send(line);
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen = Vec::new();
    loop {
        let Ok(line) = received.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        else {
            bail!("no ready line; output so far: {seen:?}");
        };
        let ready = line.contains("\"step\":\"ready\"");
        seen.push(line);
        if ready {
            break;
        }
    }
    let sent = Instant::now();
    kill(Pid::from_raw(i32::try_from(child.0.id())?), signal)?;
    let status = loop {
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        if sent.elapsed() > Duration::from_secs(20) {
            bail!("still running 20 s after {name}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let _ = reader.join();
    seen.extend(received.try_iter());
    let mut stderr = String::new();
    child
        .0
        .stderr
        .take()
        .context("stderr")?
        .read_to_string(&mut stderr)?;
    anyhow::ensure!(
        status.success(),
        "{status}; stdout {seen:?}; stderr {stderr}"
    );
    anyhow::ensure!(
        seen.iter()
            .any(|line| line.contains("\"function\":\"shutdown\"") && line.contains(name)),
        "no shutdown line naming {name}: {seen:?}"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn exits_cleanly_on_sigterm() -> anyhow::Result<()> {
    starts_and_stops_on(Signal::SIGTERM, "SIGTERM")
}

#[test]
fn exits_cleanly_on_sigint() -> anyhow::Result<()> {
    starts_and_stops_on(Signal::SIGINT, "SIGINT")
}
