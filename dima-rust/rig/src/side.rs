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
    /// The port requests and readiness use when they name none: the first one the target declares.
    pub primary_port: String,
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
    /// The first port the target declares (requests without a `port` go there).
    pub primary_port: String,
    stop_signal: StopSignal,
    grace_ms: u64,
    exited: Option<ExitStatus>,
    /// The whole process group is known to be gone (nothing left to kill).
    group_gone: bool,
}

/// `docker rm -f <name>`: `Ok(true)` when a container was removed, `Ok(false)` when there was
/// none. Bounded by a timeout.
pub async fn remove_container(name: &str) -> Result<bool, String> {
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("docker")
            .args(["rm", "-f", name])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("docker rm -f {name} timed out"))?
    .map_err(|e| format!("docker rm -f {name}: {e}"))?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("No such container") {
        Ok(false)
    } else {
        Err(format!("docker rm -f {name}: {}", err.trim()))
    }
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
    lines
        .get(from..)
        .unwrap_or(&[])
        .iter()
        .map(|l| crate::value::cut(l, 400))
        .collect()
}

fn describe(st: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (st.code(), st.signal()) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(s)) => format!(
            "signal {}",
            Signal::try_from(s).map_or_else(|_| s.to_string(), |sig| sig.as_str().to_string())
        ),
        _ => "unknown exit".into(),
    }
}

/// Find a bare program name in the side's PATH (or the rig's when the side has none).
fn resolve_program(
    program: &str,
    side_path: Option<&str>,
    rig_path: Option<&str>,
    cwd: &FsPath,
) -> Option<PathBuf> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        return Some(if p.is_absolute() { p } else { cwd.join(p) });
    }
    let search = side_path.or(rig_path)?;
    std::env::split_paths(search)
        .map(|d| d.join(program))
        .find(|p| p.is_file())
}

impl SideProcess {
    pub async fn launch(
        spec: LaunchSpec,
        rig_path: Option<&str>,
    ) -> Result<SideProcess, SideFailure> {
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
        let mut log = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spec.log_path)
        {
            Ok(f) => f,
            Err(e) => return Err(fail(format!("cannot open log file: {e}"), &spec.log_path)),
        };
        let Some((program, args)) = spec.command.split_first() else {
            return Err(fail("empty command".into(), &spec.log_path));
        };
        let side_path = spec
            .env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.as_str());
        let Some(resolved) = resolve_program(program, side_path, rig_path, &spec.cwd) else {
            return Err(fail(
                format!(
                    "program `{program}` not found on PATH (add PATH to pass_env or use an absolute path)"
                ),
                &spec.log_path,
            ));
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
            _ => {
                return Err(fail(
                    "cannot share the log file with the process".into(),
                    &spec.log_path,
                ));
            }
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
            Err(e) => {
                return Err(fail(
                    format!("cannot start {}: {e}", resolved.display()),
                    &spec.log_path,
                ));
            }
        };
        let pgid = child.id().and_then(|id| i32::try_from(id).ok());
        let mut p = SideProcess {
            side: spec.side.clone(),
            child,
            pgid,
            log_path: spec.log_path.clone(),
            started_at,
            ports: spec.ports.clone(),
            primary_port: spec.primary_port.clone(),
            stop_signal: spec.stop_signal,
            grace_ms: spec.grace_ms,
            exited: None,
            group_gone: false,
        };
        if let Err(f) = p.wait_ready(&spec.ready).await {
            // The leader may have exited already while what it started lives on in its group.
            p.kill_group().await;
            return Err(f);
        }
        Ok(p)
    }

    pub fn failure(&self, step: Option<usize>, message: impl Into<String>) -> SideFailure {
        SideFailure {
            side: self.side.clone(),
            step,
            message: message.into(),
            log: Some(self.log_path.display().to_string()),
            log_tail: log_tail(&self.log_path),
        }
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
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build();
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
                return Err(self.failure(
                    None,
                    format!(
                        "not ready after {} ms (last probe: {last})",
                        ready.timeout_ms
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn signal_group(&self, sig: Signal) {
        if let Some(pg) = self.pgid
            && !self.group_gone
        {
            // ESRCH (nothing left in the group) is fine.
            let _ = killpg(Pid::from_raw(pg), sig);
        }
    }

    /// SIGKILL the whole group, reap the leader, and wait (bounded) until no member is left.
    async fn kill_group(&mut self) {
        self.signal_group(Signal::SIGKILL);
        if self.exited.is_none()
            && let Ok(Ok(st)) =
                tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await
        {
            self.exited = Some(st);
        }
        let Some(pg) = self.pgid else {
            self.group_gone = true;
            return;
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            // Signal 0 only checks: ESRCH means no process is left in the group.
            if killpg(Pid::from_raw(pg), None) == Err(nix::errno::Errno::ESRCH) {
                self.group_gone = true;
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            let _ = killpg(Pid::from_raw(pg), Signal::SIGKILL);
            tokio::time::sleep(Duration::from_millis(20)).await;
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
            if let Ok(Ok(st)) =
                tokio::time::timeout(Duration::from_millis(self.grace_ms), self.child.wait()).await
            {
                self.exited = Some(st);
            }
        }
        // Anything the process started in its group goes too (also when the leader is gone).
        self.kill_group().await;
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.log_path)
            .map(|mut f| {
                let _ = writeln!(
                    f,
                    "=== dima-rig: stopped ({})",
                    self.exited
                        .as_ref()
                        .map_or_else(|| "unknown".into(), describe)
                );
            });
        died
    }
}

impl Drop for SideProcess {
    /// Every exit path (an error, a dropped future on Ctrl-C) kills the whole group, including
    /// when the leader has already exited and only what it started is left.
    fn drop(&mut self) {
        self.signal_group(Signal::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use crate::target::{Probe, Ready, StopSignal};

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dima-rig-side-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn spec(dir: &FsPath, script: &str, timeout_ms: u64) -> LaunchSpec {
        let port = free_port().unwrap();
        LaunchSpec {
            side: "candidate".into(),
            command: vec!["/bin/sh".into(), "-c".into(), script.into()],
            cwd: dir.to_path_buf(),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            log_path: dir.join("side.log"),
            ports: [("http".to_string(), port)].into(),
            primary_port: "http".into(),
            ready: Ready {
                probe: Probe::Tcp,
                port: "http".into(),
                timeout_ms,
            },
            stop_signal: StopSignal::Term,
            grace_ms: 500,
        }
    }

    /// Wait until the process is gone (or a zombie nobody has reaped yet).
    async fn gone(pid: &str) -> bool {
        for _ in 0..150 {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => return true,
                Ok(stat)
                    if stat
                        .rsplit(')')
                        .next()
                        .is_some_and(|t| t.trim_start().starts_with('Z')) =>
                {
                    return true;
                }
                Ok(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        false
    }

    async fn helper_pid(dir: &FsPath) -> String {
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(dir.join("helper.pid"))
                && !s.trim().is_empty()
            {
                return s.trim().to_string();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the helper pid was not written");
    }

    #[tokio::test]
    async fn the_group_is_killed_when_the_leader_exits_before_readiness() {
        let dir = scratch("exit");
        let s = spec(&dir, "sleep 300 & echo $! > helper.pid; exit 1", 5000);
        let err = match SideProcess::launch(s, None).await {
            Err(e) => e,
            Ok(_) => panic!("a process that exits is never ready"),
        };
        assert!(
            err.message.contains("did not become ready"),
            "{}",
            err.message
        );
        let pid = helper_pid(&dir).await;
        assert!(
            gone(&pid).await,
            "the helper {pid} outlived its exited leader"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_group_is_killed_when_readiness_times_out() {
        let dir = scratch("timeout");
        let s = spec(
            &dir,
            "sleep 300 & echo $! > helper.pid; exec sleep 300",
            400,
        );
        let err = match SideProcess::launch(s, None).await {
            Err(e) => e,
            Ok(_) => panic!("nothing listens, so it is never ready"),
        };
        assert!(
            err.message.contains("not ready after 400 ms"),
            "{}",
            err.message
        );
        let pid = helper_pid(&dir).await;
        assert!(gone(&pid).await, "the helper {pid} outlived the timeout");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn dropping_a_ready_side_kills_its_group() {
        let dir = scratch("drop");
        let port = free_port().unwrap();
        let mut s = spec(
            &dir,
            &format!(
                "sleep 300 & echo $! > helper.pid; exec python3 -c 'import socket,time; s=socket.socket(); s.bind((\"127.0.0.1\", {port})); s.listen(); time.sleep(300)'"
            ),
            5000,
        );
        s.ports = [("http".to_string(), port)].into();
        if std::process::Command::new("python3")
            .arg("-c")
            .arg("pass")
            .status()
            .is_err()
        {
            eprintln!("skipping: python3 is not available");
            return;
        }
        let p = SideProcess::launch(s, None).await.unwrap();
        let pid = helper_pid(&dir).await;
        drop(p);
        assert!(
            gone(&pid).await,
            "the helper {pid} outlived the dropped side"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
