//! One side's process: launched in its own process group with an environment built only from
//! the target's template, probed until ready, stopped with a signal then SIGKILL of the group.
//! Its output goes to a log file; the tail is shown when it fails.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path as FsPath, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::process::{Child, Command};

use crate::report::SideFailure;
use crate::target::{Probe, Ready, StopSignal};
use crate::timefmt;

const TAIL_LINES: usize = 30;
const TAIL_BYTES: u64 = 64 * 1024;

pub struct LaunchSpec {
    pub side: String,
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub log_path: PathBuf,
    pub ports: BTreeMap<String, u16>,
    pub ready: Ready,
    pub stop_signal: StopSignal,
    pub grace_ms: u64,
}

pub struct SideProcess {
    pub side: String,
    child: Child,
    pgid: Option<i32>,
    pub log_path: PathBuf,
    pub started_at: i64,
    pub ports: BTreeMap<String, u16>,
    stop_signal: StopSignal,
    grace_ms: u64,
    exited: Option<ExitStatus>,
}

/// A free loopback port (the rig asks the kernel, then releases it for the side).
pub fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

/// The last lines of a log file.
pub fn log_tail(path: &FsPath) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(TAIL_LINES);
    lines.get(from..).unwrap_or(&[]).iter().map(|l| crate::value::cut(l, 400)).collect()
}

fn describe(st: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (st.code(), st.signal()) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(s)) => format!("signal {}", Signal::try_from(s).map_or_else(|_| s.to_string(), |sig| sig.as_str().to_string())),
        _ => "unknown exit".into(),
    }
}

/// Find a bare program name in the side's PATH (or the rig's when the side has none).
fn resolve_program(program: &str, side_path: Option<&str>, rig_path: Option<&str>, cwd: &FsPath) -> Option<PathBuf> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        return Some(if p.is_absolute() { p } else { cwd.join(p) });
    }
    let search = side_path.or(rig_path)?;
    std::env::split_paths(search).map(|d| d.join(program)).find(|p| p.is_file())
}

impl SideProcess {
    pub async fn launch(spec: LaunchSpec, rig_path: Option<&str>) -> Result<SideProcess, SideFailure> {
        let fail = |msg: String, log: &FsPath| SideFailure {
            side: spec.side.clone(),
            step: None,
            message: msg,
            log: Some(log.display().to_string()),
            log_tail: log_tail(log),
        };
        if let Some(dir) = spec.log_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut log = match std::fs::OpenOptions::new().create(true).append(true).open(&spec.log_path) {
            Ok(f) => f,
            Err(e) => return Err(fail(format!("cannot open log file: {e}"), &spec.log_path)),
        };
        let Some((program, args)) = spec.command.split_first() else {
            return Err(fail("empty command".into(), &spec.log_path));
        };
        let side_path = spec.env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str());
        let Some(resolved) = resolve_program(program, side_path, rig_path, &spec.cwd) else {
            return Err(fail(format!("program `{program}` not found on PATH (add PATH to pass_env or use an absolute path)"), &spec.log_path));
        };
        let names: Vec<&str> = spec.env.iter().map(|(k, _)| k.as_str()).collect();
        let _ = writeln!(
            log,
            "=== dima-rig: {} started at {}: {} {}\n=== cwd {}; environment: {}",
            spec.side,
            timefmt::format_iso_ms(timefmt::now_ms()).unwrap_or_default(),
            resolved.display(),
            args.join(" "),
            spec.cwd.display(),
            names.join(", ")
        );
        let (out, err) = match (log.try_clone(), log.try_clone()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => return Err(fail("cannot share the log file with the process".into(), &spec.log_path)),
        };
        let mut cmd = Command::new(&resolved);
        cmd.args(args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .process_group(0)
            .kill_on_drop(true);
        let started_at = timefmt::now_ms();
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(fail(format!("cannot start {}: {e}", resolved.display()), &spec.log_path)),
        };
        let pgid = child.id().and_then(|id| i32::try_from(id).ok());
        let mut p = SideProcess {
            side: spec.side.clone(),
            child,
            pgid,
            log_path: spec.log_path.clone(),
            started_at,
            ports: spec.ports.clone(),
            stop_signal: spec.stop_signal,
            grace_ms: spec.grace_ms,
            exited: None,
        };
        p.wait_ready(&spec.ready).await?;
        Ok(p)
    }

    pub fn failure(&self, step: Option<usize>, message: impl Into<String>) -> SideFailure {
        SideFailure { side: self.side.clone(), step, message: message.into(), log: Some(self.log_path.display().to_string()), log_tail: log_tail(&self.log_path) }
    }

    /// `Err` with a description when the process has exited.
    pub fn check_alive(&mut self) -> Result<(), String> {
        if let Some(st) = self.exited {
            return Err(format!("the process had exited ({})", describe(&st)));
        }
        match self.child.try_wait() {
            Ok(None) => Ok(()),
            Ok(Some(st)) => {
                self.exited = Some(st);
                Err(format!("the process exited ({})", describe(&st)))
            }
            Err(e) => Err(format!("cannot check the process: {e}")),
        }
    }

    pub fn port(&self, name: &str) -> Option<u16> {
        self.ports.get(name).copied()
    }

    async fn wait_ready(&mut self, ready: &Ready) -> Result<(), SideFailure> {
        let Some(port) = self.port(&ready.port) else {
            return Err(self.failure(None, format!("no port named {}", ready.port)));
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ready.timeout_ms);
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build();
        let mut last = String::from("no answer yet");
        loop {
            if let Err(why) = self.check_alive() {
                return Err(self.failure(None, format!("did not become ready: {why}")));
            }
            match &ready.probe {
                Probe::Tcp => match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                    Ok(_) => return Ok(()),
                    Err(e) => last = e.to_string(),
                },
                Probe::Http { path, status } => {
                    if let Ok(c) = &client {
                        match c.get(format!("http://127.0.0.1:{port}{path}")).send().await {
                            Ok(r) => {
                                let s = r.status().as_u16();
                                if status.map_or((200..300).contains(&s), |want| s == want) {
                                    return Ok(());
                                }
                                last = format!("GET {path} answered {s}");
                            }
                            Err(e) => last = e.to_string(),
                        }
                    }
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(self.failure(None, format!("not ready after {} ms (last probe: {last})", ready.timeout_ms)));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn signal_group(&self, sig: Signal) {
        if let Some(pg) = self.pgid {
            // ESRCH (nothing left in the group) is fine.
            let _ = killpg(Pid::from_raw(pg), sig);
        }
    }

    /// Stop the process group. Returns `Some(description)` when the process had already exited
    /// on its own before the rig asked it to stop (always a failure).
    pub async fn stop(&mut self) -> Option<String> {
        let died = self.check_alive().err();
        if died.is_none() {
            let sig = match self.stop_signal {
                StopSignal::Term => Signal::SIGTERM,
                StopSignal::Int => Signal::SIGINT,
                StopSignal::Quit => Signal::SIGQUIT,
                StopSignal::Hup => Signal::SIGHUP,
            };
            self.signal_group(sig);
            match tokio::time::timeout(Duration::from_millis(self.grace_ms), self.child.wait()).await {
                Ok(Ok(st)) => self.exited = Some(st),
                _ => {
                    self.signal_group(Signal::SIGKILL);
                    if let Ok(st) = self.child.wait().await {
                        self.exited = Some(st);
                    }
                }
            }
        }
        // Anything the process started in its group goes too.
        self.signal_group(Signal::SIGKILL);
        let _ = std::fs::OpenOptions::new().append(true).open(&self.log_path).map(|mut f| {
            let _ = writeln!(f, "=== dima-rig: stopped ({})", self.exited.as_ref().map_or_else(|| "unknown".into(), describe));
        });
        died
    }
}

impl Drop for SideProcess {
    fn drop(&mut self) {
        if self.exited.is_none() {
            self.signal_group(Signal::SIGKILL);
        }
    }
}
