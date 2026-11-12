//! Starting an outside program (`yt-dlp`, `ffmpeg`) without a shell.
//!
//! A [`Program`] is a fixed absolute path, checked once at startup (absolute, an existing
//! regular file with an execute bit; symlinks are resolved then, never at run time) and never
//! looked up through `PATH`. [`Program::run`] starts it with an argument vector, a cleared
//! environment plus the variables the caller names, the caller's working directory, standard
//! input closed and its own process group. The run has a time limit and a limit on captured
//! output (standard output and error together); passing either, or dropping the caller's future,
//! kills the whole group with `SIGKILL`, so a forked helper does not outlive the run. A normal
//! exit also kills what the program left behind in its group. A non-zero exit or a death by
//! signal is an error that carries the captured output.
//!
//! The group is killed with `nix::sys::signal::killpg`, a safe wrapper (the workspace forbids
//! `unsafe`); the group is created by the standard library's `process_group(0)`. While the leader
//! is not yet reaped its id cannot be reused, so the kill on a time limit, an output limit or a
//! drop always reaches the right group. After a normal exit the leader is reaped before the group
//! is killed: if the program left processes behind they keep the group id alive and are the ones
//! killed; if it left none, the id is free and Linux only reuses it for a new process that makes
//! itself a group leader within that instant, which this accepts.
use dima_core::Random;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt as _};

/// How long a killed program may take to be reaped before the run gives up waiting for it
/// (it stays killed; the runtime reaps it later).
const REAP_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("program path is not an absolute path to an executable regular file")]
    Program,
    #[error("invalid run options")]
    Invalid,
    #[error("program could not be started: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("program exceeded its time limit")]
    Timeout,
    #[error("program output exceeded its limit")]
    OutputLimit,
    #[error("program was stopped by the caller's guard")]
    Stopped,
    #[error("program failed ({status})")]
    Failed {
        status: ExitStatus,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    #[error("program I/O: {0}")]
    Io(#[source] std::io::Error),
}

/// A program at a fixed absolute path, checked at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    path: PathBuf,
}

impl Program {
    /// Checks `path` (absolute, an existing regular file, executable by someone) and keeps its
    /// canonical form. Startup only: this touches the file system synchronously.
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, Error> {
        let path = path.into();
        if !path.is_absolute() {
            return Err(Error::Program);
        }
        let path = std::fs::canonicalize(&path).map_err(|_| Error::Program)?;
        let meta = std::fs::metadata(&path).map_err(|_| Error::Program)?;
        if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
            return Err(Error::Program);
        }
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs the program to completion (see the module documentation).
    pub async fn run(&self, invocation: Invocation<'_>) -> Result<Output, Error> {
        self.run_until(invocation, std::future::pending()).await
    }

    /// As [`Program::run`], and the group is killed with [`Error::Stopped`] when `guard`
    /// completes first (a caller's watchdog, such as a size limit on what the program writes).
    pub async fn run_until(
        &self,
        invocation: Invocation<'_>,
        guard: impl Future<Output = ()>,
    ) -> Result<Output, Error> {
        let Invocation {
            args,
            env,
            cwd,
            timeout,
            max_output,
        } = invocation;
        if timeout.is_zero() || max_output == 0 || !cwd.is_absolute() {
            return Err(Error::Invalid);
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let mut command = tokio::process::Command::new(&self.path);
        command
            .args(&args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (OsStr::new(k), v.as_os_str())))
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(Error::Spawn)?;
        let mut group = Group::new(child.id());
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take())
        else {
            return Err(Error::Invalid);
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut buf_out = [0_u8; 8192];
        let mut buf_err = [0_u8; 8192];
        let (mut out_open, mut err_open) = (true, true);
        let mut status = None;
        tokio::pin!(guard);
        let result = loop {
            if let Some(status) = status
                && !out_open
                && !err_open
            {
                break Ok(status);
            }
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => break Err(Error::Timeout),
                () = &mut guard => break Err(Error::Stopped),
                waited = child.wait(), if status.is_none() => match waited {
                    Ok(s) => {
                        status = Some(s);
                        // Reaped: kill what it left in its group, so their pipes close too.
                        group.kill_after_reap();
                    }
                    Err(e) => break Err(Error::Io(e)),
                },
                read = read_some(&mut stdout, &mut buf_out), if out_open => {
                    match capture(read, &mut out, err.len(), max_output, &buf_out) {
                        Ok(open) => out_open = open,
                        Err(e) => break Err(e),
                    }
                }
                read = read_some(&mut stderr, &mut buf_err), if err_open => {
                    match capture(read, &mut err, out.len(), max_output, &buf_err) {
                        Ok(open) => err_open = open,
                        Err(e) => break Err(e),
                    }
                }
            }
        };
        match result {
            Ok(status) if status.success() => Ok(Output {
                stdout: out,
                stderr: err,
            }),
            Ok(status) => Err(Error::Failed {
                status,
                stdout: out,
                stderr: err,
            }),
            Err(e) => {
                if status.is_none() {
                    group.kill();
                    if let Ok(Ok(_)) = tokio::time::timeout(REAP_GRACE, child.wait()).await {
                        group.disarm();
                    }
                }
                Err(e)
            }
        }
    }
}

/// One run's options.
#[derive(Debug)]
pub struct Invocation<'a> {
    /// The argument vector after the program path.
    pub args: Vec<OsString>,
    /// The whole environment of the program (everything else is cleared).
    pub env: Vec<(&'static str, OsString)>,
    /// The working directory (absolute).
    pub cwd: &'a Path,
    /// Wall-clock limit for the run, output included.
    pub timeout: Duration,
    /// Limit on standard output and error together, in bytes.
    pub max_output: usize,
}

/// What a successful run printed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

async fn read_some(
    reader: &mut (impl AsyncRead + Unpin),
    buf: &mut [u8],
) -> std::io::Result<usize> {
    reader.read(buf).await
}

/// Appends a read to `into`; `Ok(false)` at end of stream.
fn capture(
    read: std::io::Result<usize>,
    into: &mut Vec<u8>,
    other: usize,
    max: usize,
    buf: &[u8],
) -> Result<bool, Error> {
    let n = read.map_err(Error::Io)?;
    if n == 0 {
        return Ok(false);
    }
    if into.len().saturating_add(other).saturating_add(n) > max {
        return Err(Error::OutputLimit);
    }
    into.extend_from_slice(buf.get(..n).ok_or(Error::Invalid)?);
    Ok(true)
}

/// The child's process group: killed when dropped unless disarmed.
struct Group {
    pgid: Option<Pid>,
}

impl Group {
    fn new(pid: Option<u32>) -> Self {
        Self {
            pgid: pid
                .and_then(|p| i32::try_from(p).ok())
                .filter(|p| *p > 1)
                .map(Pid::from_raw),
        }
    }
    fn kill(&self) {
        if let Some(pgid) = self.pgid {
            // ESRCH (nothing left in the group) is the expected outcome after a clean exit.
            let _ = killpg(pgid, Signal::SIGKILL);
        }
    }
    fn kill_after_reap(&mut self) {
        self.kill();
        self.disarm();
    }
    fn disarm(&mut self) {
        self.pgid = None;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Text of captured output for an error message: lossy UTF-8, at most `max` bytes from the end,
/// cut on a character boundary.
pub fn tail_text(bytes: &[u8], max: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= max {
        return text.into_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.get(start..).unwrap_or_default().to_owned()
}

/// A private run directory, removed when the run ends or its future is dropped.
#[derive(Debug)]
pub(crate) struct RunDir {
    pub(crate) path: PathBuf,
    removed: bool,
}

impl RunDir {
    /// `<parent>/<prefix>-<24 hex>`, mode 0700; fails if the name exists (never reuses or
    /// follows anything already there).
    pub(crate) async fn create(
        parent: &Path,
        prefix: &str,
        random: &dyn Random,
    ) -> Result<Self, std::io::Error> {
        let token = random
            .hex_token(12)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let path = parent.join(format!("{prefix}-{token}"));
        let mut builder = tokio::fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(&path).await?;
        Ok(Self {
            path,
            removed: false,
        })
    }

    /// Removes the directory and everything in it (symlinks inside are removed, not followed).
    pub(crate) async fn remove(mut self) {
        let _ = tokio::fs::remove_dir_all(&self.path).await;
        self.removed = true;
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        if !self.removed {
            // Cancellation only (the async path removes it otherwise): a few small files.
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
