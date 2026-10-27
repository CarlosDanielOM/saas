//! Per-child process ownership, bounded pipe framing, and cooperative shutdown.
//!
//! There is exactly one owner/task per worker. It reaps the child, cancels its
//! sampler, and closes/drains stdout before scheduling a single restart. No
//! child changes process group; the production bridge owns the outer group.

use std::{
    fs::File,
    io::{self, Write},
    os::fd::FromRawFd,
    process::{ExitStatus, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::watch,
    task::{JoinHandle, JoinSet},
};

use super::{
    Config,
    registry::{Environment, WorkerSpec},
    telemetry::{self, Telemetry},
};

const FRAME_LIMIT: usize = 1024;
const OUTPUT_LIMIT: usize = 16_384;
const DIAGNOSTIC_PREFIX: &[u8] = b"cron_index:";
const DIAGNOSTIC_LINE_LIMIT: usize = OUTPUT_LIMIT + DIAGNOSTIC_PREFIX.len() + 1;
const DIAGNOSTIC_QUEUE_CAPACITY: usize = 64;
const DIAGNOSTIC_FLUSH_GRACE: Duration = Duration::from_millis(100);
const PIPE_CLOSE_GRACE: Duration = Duration::from_secs(2);
const EXPORT_CLOSE_GRACE: Duration = Duration::from_secs(2);

static DIAGNOSTICS: OnceLock<Result<Diagnostics, &'static str>> = OnceLock::new();

#[derive(Default)]
struct DiagnosticProgress {
    completed: AtomicU64,
    closed: AtomicBool,
    changed: tokio::sync::Notify,
}

struct Diagnostics {
    sender: SyncSender<Vec<u8>>,
    accepted: AtomicU64,
    progress: Arc<DiagnosticProgress>,
}

/// Serialization cannot grow a producer buffer beyond one diagnostic line.
struct DiagnosticLine(Vec<u8>);

impl Write for DiagnosticLine {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > DIAGNOSTIC_LINE_LIMIT - self.0.len() {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn diagnostic_line(value: &Value) -> Option<Vec<u8>> {
    let mut line = DiagnosticLine(Vec::with_capacity(DIAGNOSTIC_LINE_LIMIT));
    line.write_all(DIAGNOSTIC_PREFIX).ok()?;
    serde_json::to_writer(&mut line, value).ok()?;
    // Reserve the final byte for newline; even oversized values stay bounded.
    line.write_all(b"\n").ok()?;
    Some(line.0)
}

impl Diagnostics {
    fn stdout() -> Result<Self, &'static str> {
        // Duplicate atomically with CLOEXEC before starting any child. File
        // writes bypass Rust's global stdout/LineWriter lock and buffer. In
        // particular, a blocked writer cannot hold that lock during exit's
        // stdio cleanup. Do not set O_NONBLOCK on the shared open description.
        // SAFETY: fcntl duplicates a valid descriptor or returns a checked error.
        let fd = unsafe { libc::fcntl(libc::STDOUT_FILENO, libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err("Cannot initialize diagnostic writer");
        }
        // SAFETY: fd is a newly owned descriptor, transferred exactly once.
        let mut output = unsafe { File::from_raw_fd(fd) };
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(DIAGNOSTIC_QUEUE_CAPACITY);
        let progress = Arc::new(DiagnosticProgress::default());
        let writer_progress = progress.clone();
        let writer = std::thread::Builder::new()
            .name("cron-diagnostics".into())
            .stack_size(128 * 1024)
            .spawn(move || {
                for line in receiver {
                    if output.write_all(&line).is_err() {
                        break; // No raw IO errors and no recursive diagnostics.
                    }
                    writer_progress.completed.fetch_add(1, Ordering::Release);
                    writer_progress.changed.notify_one();
                }
                writer_progress.closed.store(true, Ordering::Release);
                writer_progress.changed.notify_one();
            })
            .map_err(|_| "Cannot initialize diagnostic writer")?;
        // Intentionally detach this single process-lifetime thread. Neither
        // Tokio shutdown nor main/exit joins a potentially blocked File write.
        // File has no userspace buffer to flush on drop, unlike BufWriter.
        drop(writer);
        Ok(Self {
            sender,
            accepted: AtomicU64::new(0),
            progress,
        })
    }

    fn submit(&self, value: &Value) -> bool {
        let Some(line) = diagnostic_line(value) else {
            return false;
        };
        // Full/disconnected queues drop the new line. Existing accepted lines
        // retain the channel's FIFO order. No IO or waiting occurs here.
        if self.sender.try_send(line).is_err() {
            return false;
        }
        self.accepted.fetch_add(1, Ordering::Release);
        true
    }

    async fn drain_until(&self, deadline: tokio::time::Instant) {
        let target = self.accepted.load(Ordering::Acquire);
        while self.progress.completed.load(Ordering::Acquire) < target
            && !self.progress.closed.load(Ordering::Acquire)
            && tokio::time::Instant::now() < deadline
        {
            // notify_one retains a permit if completion races this check.
            tokio::select! {
                _ = self.progress.changed.notified() => {},
                _ = tokio::time::sleep_until(deadline) => return,
            }
        }
    }
}

/// Called once after explicit env loading, before runtime threads/children.
/// A library caller can also initialize through run; emit itself never starts
/// threads or waits for initialization. At most one OS writer exists per index.
pub fn start_diagnostics() -> Result<(), &'static str> {
    DIAGNOSTICS
        .get_or_init(Diagnostics::stdout)
        .as_ref()
        .map(|_| ())
        .map_err(|error| *error)
}

/// One clock for all workers, pipe closure, and final export on shutdown.
/// The last two seconds are shared; per-worker/export waits never stack them.
#[derive(Clone, Default)]
struct ShutdownBudget(Arc<OnceLock<tokio::time::Instant>>);

impl ShutdownBudget {
    fn end(&self, child_grace: Duration) -> tokio::time::Instant {
        *self
            .0
            .get_or_init(|| tokio::time::Instant::now() + child_grace + PIPE_CLOSE_GRACE)
    }

    fn pipe_deadline(&self) -> tokio::time::Instant {
        let local = tokio::time::Instant::now() + PIPE_CLOSE_GRACE;
        self.0
            .get()
            .copied()
            .map_or(local, |global| local.min(global))
    }
}

/// All callers supply fixed registry metadata or a strictly accepted frame.
pub fn emit(value: Value) {
    if let Some(Ok(diagnostics)) = DIAGNOSTICS.get() {
        let _ = diagnostics.submit(&value);
    }
}

/// Direct single-output CLI path, used only before runtime/writer startup.
pub fn emit_cli(value: Value) {
    if let Some(line) = diagnostic_line(&value) {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        let _ = output.write_all(&line);
        let _ = output.flush();
    }
}

async fn drain_diagnostics(deadline: tokio::time::Instant) {
    if let Some(Ok(diagnostics)) = DIAGNOSTICS.get() {
        // Writable pipes normally drain before main returns. A blocked writer
        // gets at most 100 ms within the existing shared close deadline. Its
        // thread is never joined; pending diagnostics may be lost on exit.
        diagnostics
            .drain_until(deadline.min(tokio::time::Instant::now() + DIAGNOSTIC_FLUSH_GRACE))
            .await;
    }
}

/// Match the previous supervisor: root drops to nobody; other callers stay.
pub fn worker_identity() -> (u32, u32) {
    // SAFETY: getuid/getgid have no preconditions and do not mutate process state.
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    if uid == 0 { (65534, 65534) } else { (uid, gid) }
}

#[derive(Clone)]
struct Events {
    progress: bool,
    #[cfg(test)]
    capture: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
}

impl Events {
    fn new(progress: bool) -> Self {
        Self {
            progress,
            #[cfg(test)]
            capture: None,
        }
    }

    fn send(&self, event: Value) {
        #[cfg(test)]
        if let Some(capture) = &self.capture {
            let _ = capture.send(event);
            return;
        }
        emit(event);
    }
}

fn worker_error(
    telemetry: Option<&Telemetry>,
    events: &Events,
    spec: &WorkerSpec,
    step: &'static str,
    code: &'static str,
) {
    events.send(json!({
        "event": "error", "name": spec.name, "worker": spec.name,
        "step": step, "code": code,
    }));
    if let Some(telemetry) = telemetry {
        telemetry.record_worker_error(spec.metric_prefix, step, code);
    }
}

fn error_code(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOEXEC) => "ENOEXEC",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::ECHILD) => "ECHILD",
        Some(libc::ESRCH) => "ESRCH",
        _ => "NATIVE_WORKER_PROCESS",
    }
}

/// Fixed storage even for an infinite line, invalid UTF-8, or hostile output.
struct Frames {
    bytes: [u8; FRAME_LIMIT],
    length: usize,
    discarding: bool,
}

impl Default for Frames {
    fn default() -> Self {
        Self {
            bytes: [0; FRAME_LIMIT],
            length: 0,
            discarding: false,
        }
    }
}

impl Frames {
    fn feed(&mut self, chunk: &[u8], mut accept: impl FnMut(&[u8])) {
        for byte in chunk {
            if *byte == b'\n' {
                if !self.discarding {
                    accept(&self.bytes[..self.length]);
                }
                self.length = 0;
                self.discarding = false;
            } else if !self.discarding {
                if self.length == FRAME_LIMIT {
                    self.length = 0;
                    self.discarding = true;
                } else {
                    self.bytes[self.length] = *byte;
                    self.length += 1;
                }
            }
        }
    }
}

async fn read_stdout(
    mut stdout: impl AsyncRead + Unpin,
    spec: &'static WorkerSpec,
    pid: Option<u32>,
    stopping: watch::Receiver<bool>,
    telemetry: Option<Telemetry>,
    events: Events,
) {
    let mut buffer = [0; FRAME_LIMIT];
    let mut frames = Frames::default();
    loop {
        let length = match stdout.read(&mut buffer).await {
            Ok(0) => return, // An unterminated final line is never a frame.
            Ok(length) => length,
            Err(error) => {
                worker_error(
                    telemetry.as_ref(),
                    &events,
                    spec,
                    "stdout",
                    error_code(&error),
                );
                return;
            }
        };
        #[cfg(test)]
        if events.capture.is_some() {
            // Readiness notification for owned fixtures; never expose bytes.
            events.send(json!({"event": "fixture-read", "name": spec.name}));
        }
        frames.feed(&buffer[..length], |line| {
            // Shutdown drains bytes without accepting fresh telemetry. The
            // reader is retained until EOF (or the explicit bounded close).
            if *stopping.borrow() {
                return;
            }
            if let Some(telemetry) = &telemetry
                && let Some(frame) = telemetry.accept_frame(spec, line)
                && events.progress
            {
                // event/name/worker cannot be overridden by child keys.
                let kind = match frame.get("event").and_then(Value::as_str) {
                    Some("batch") => Some("batch"),
                    Some("health") => Some("health"),
                    _ => None,
                };
                if let Some(kind) = kind {
                    events.send(json!({
                        "event": kind, "name": spec.name,
                        "worker": spec.name, "pid": pid, "frame": frame,
                    }));
                }
            }
        });
        // A perpetually ready pipe cannot starve other workers or shutdown.
        tokio::task::yield_now().await;
    }
}

async fn wait_for_shutdown(stopping: &mut watch::Receiver<bool>) {
    while !*stopping.borrow() {
        if stopping.changed().await.is_err() {
            return;
        }
    }
}

async fn cancel_task(task: JoinHandle<()>) {
    task.abort();
    let _ = task.await;
}

async fn close_stdout(mut task: JoinHandle<()>, budget: &ShutdownBudget) {
    // A descendant can retain the pipe after its direct parent exits. Fence
    // that ownership explicitly; never hold a worker restart forever for EOF.
    if tokio::time::timeout_at(budget.pipe_deadline(), &mut task)
        .await
        .is_err()
    {
        cancel_task(task).await;
    }
}

fn command(spec: &WorkerSpec, once: bool, env: &Environment) -> Command {
    let mut command = Command::new(spec.binary);
    command
        .args(spec.launch_args(once))
        .env_clear()
        .envs(spec.child_env(env))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // uid/gid are applied in the child, without changing the supervisor's uid.
    // No setsid/process_group: all workers remain in the bridge-owned group.
    // SAFETY: getuid has no preconditions.
    if unsafe { libc::getuid() } == 0 {
        command.uid(65534).gid(65534);
    }
    command
}

async fn stop_child(
    child: &mut Child,
    deadline: tokio::time::Instant,
    spec: &WorkerSpec,
    telemetry: Option<&Telemetry>,
    events: &Events,
) -> io::Result<ExitStatus> {
    if let Some(status) = child.try_wait()? {
        return Ok(status);
    }
    if let Some(pid) = child.id() {
        // The child has not been reaped: this PID still belongs to this owner.
        // SAFETY: positive PID, constant SIGTERM, no pointer arguments.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                worker_error(telemetry, events, spec, "terminate", error_code(&error));
            }
        }
    }
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            events.send(json!({"event": "kill", "name": spec.name, "worker": spec.name}));
            if let Err(error) = child.start_kill() {
                worker_error(telemetry, events, spec, "kill", error_code(&error));
            }
            // SIGKILL is followed by wait/reap, never fire-and-forget cleanup.
            child.wait().await
        }
    }
}

fn exit_metadata(status: &ExitStatus) -> (i32, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    (status.code().unwrap_or(1), status.signal())
}

async fn run_worker(
    spec: &'static WorkerSpec,
    config: Config,
    env: Arc<Environment>,
    mut stopping: watch::Receiver<bool>,
    telemetry: Option<Telemetry>,
    events: Events,
    budget: ShutdownBudget,
) -> bool {
    let mut restarts = 0_u64;
    loop {
        if *stopping.borrow() {
            return true;
        }
        let mut child = match command(spec, config.once, &env).spawn() {
            Ok(child) => child,
            Err(error) => {
                worker_error(
                    telemetry.as_ref(),
                    &events,
                    spec,
                    "spawn",
                    error_code(&error),
                );
                events.send(
                    json!({"event": "exit", "name": spec.name, "worker": spec.name,
                    "pid": null, "code": 1, "signal": null, "failedSpawn": true,
                    "restarting": !config.once && !*stopping.borrow()}),
                );
                if config.once {
                    return false;
                }
                if !restart_wait(
                    spec,
                    config,
                    &mut stopping,
                    telemetry.as_ref(),
                    &events,
                    &mut restarts,
                )
                .await
                {
                    return true;
                }
                continue;
            }
        };
        let pid = child.id();
        let mut spawned = json!({
            "event": "spawn", "name": spec.name, "worker": spec.name,
            "pid": pid, "runtime": "rust", "restartCount": restarts,
        });
        if config.events_json {
            let (uid, gid) = worker_identity();
            let metadata = spec.launch_metadata(&env, config.once, uid, gid);
            for field in ["uid", "gid", "binary", "args", "envKeys"] {
                spawned[field] = metadata[field].clone();
            }
        }
        events.send(spawned);
        let sampler = pid
            .zip(telemetry.clone())
            .map(|(pid, telemetry)| telemetry::spawn_sampler(pid, spec.metric_prefix, telemetry));
        let stdout = child.stdout.take().map(|stdout| {
            tokio::spawn(read_stdout(
                stdout,
                spec,
                pid,
                stopping.clone(),
                telemetry.clone(),
                events.clone(),
            ))
        });
        let status = tokio::select! {
            biased;
            _ = wait_for_shutdown(&mut stopping) => {
                // Stop metrics immediately, then let the worker drain its batch.
                if let Some(sampler) = &sampler { sampler.abort(); }
                let deadline = budget.end(config.shutdown_grace) - PIPE_CLOSE_GRACE;
                stop_child(&mut child, deadline, spec, telemetry.as_ref(), &events).await
            }
            status = child.wait() => status,
        };
        if let Some(sampler) = sampler {
            cancel_task(sampler).await;
        }
        let (code, signal) = match status {
            Ok(status) => exit_metadata(&status),
            Err(error) => {
                worker_error(
                    telemetry.as_ref(),
                    &events,
                    spec,
                    "wait",
                    error_code(&error),
                );
                if error.raw_os_error() != Some(libc::ECHILD) {
                    // Preserve ownership after a recoverable wait failure.
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
                (1, None)
            }
        };
        // EOF/forced close is the final fence before the next child generation.
        if let Some(stdout) = stdout {
            close_stdout(stdout, &budget).await;
        }
        let stopped = *stopping.borrow();
        if code != 0 && !stopped {
            worker_error(
                telemetry.as_ref(),
                &events,
                spec,
                "exit",
                "NATIVE_WORKER_PROCESS",
            );
        }
        events.send(json!({
            "event": "exit", "name": spec.name, "worker": spec.name,
            "pid": pid, "code": code, "signal": signal,
            "restarting": !stopped && !config.once,
        }));
        if stopped {
            return true;
        }
        if config.once {
            return code == 0;
        }
        if !restart_wait(
            spec,
            config,
            &mut stopping,
            telemetry.as_ref(),
            &events,
            &mut restarts,
        )
        .await
        {
            return true;
        }
    }
}

async fn restart_wait(
    spec: &WorkerSpec,
    config: Config,
    stopping: &mut watch::Receiver<bool>,
    telemetry: Option<&Telemetry>,
    events: &Events,
    restarts: &mut u64,
) -> bool {
    if *stopping.borrow() {
        return false;
    }
    *restarts = restarts.saturating_add(1);
    if let Some(telemetry) = telemetry {
        telemetry.observe(
            "worker",
            &format!("{}.restarts", spec.metric_prefix),
            1.0,
            "error",
        );
    }
    events.send(json!({
        "event": "restart", "name": spec.name, "worker": spec.name,
        "restartCount": *restarts, "delayMs": config.restart_delay.as_millis() as u64,
    }));
    tokio::select! {
        biased;
        _ = wait_for_shutdown(stopping) => false,
        _ = tokio::time::sleep(config.restart_delay) => !*stopping.borrow(),
    }
}

fn signal_listener(
    stopping: watch::Sender<bool>,
    events: Events,
    budget: ShutdownBudget,
    child_grace: Duration,
) -> Result<JoinHandle<()>, &'static str> {
    // Register both Unix signals before any children are spawned.
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate =
        signal(SignalKind::terminate()).map_err(|_| "Cannot register shutdown signal")?;
    let mut interrupt =
        signal(SignalKind::interrupt()).map_err(|_| "Cannot register shutdown signal")?;
    Ok(tokio::spawn(async move {
        let signal = tokio::select! {
            _ = terminate.recv() => "SIGTERM",
            _ = interrupt.recv() => "SIGINT",
        };
        budget.end(child_grace);
        let _ = stopping.send(true);
        events.send(json!({"event": "shutdown", "worker": "cron_index", "signal": signal}));
    }))
}

pub async fn run(
    config: Config,
    workers: Vec<&'static WorkerSpec>,
    env: Environment,
) -> Result<bool, &'static str> {
    start_diagnostics()?;
    let events = Events::new(config.events_json);
    let (stop, stopping) = watch::channel(false);
    let budget = ShutdownBudget::default();
    let signal_task = signal_listener(
        stop.clone(),
        events.clone(),
        budget.clone(),
        config.shutdown_grace,
    )?;
    let telemetry = Telemetry::from_env();
    // The exporter sees shutdown immediately and flushes concurrently with the
    // 25-second child grace. It does not add a trailing two-second phase.
    let mut exporter = tokio::spawn(telemetry::run_exporter(telemetry.clone(), stopping.clone()));
    let mut tasks = JoinSet::new();
    let env = Arc::new(env);
    for spec in workers {
        if spec.enabled(&env) {
            tasks.spawn(run_worker(
                spec,
                config,
                env.clone(),
                stopping.clone(),
                Some(telemetry.clone()),
                events.clone(),
                budget.clone(),
            ));
        } else {
            events.send(json!({"event": "disabled", "name": spec.name, "worker": spec.name}));
        }
    }
    let success = finish_workers(tasks, &stop, &budget, config.shutdown_grace).await;
    cancel_task(signal_task).await;
    let was_stopping = *stopping.borrow();
    let _ = stop.send(true);
    let finish_deadline = budget
        .0
        .get()
        .copied()
        .unwrap_or_else(|| tokio::time::Instant::now() + EXPORT_CLOSE_GRACE);
    if tokio::time::timeout_at(finish_deadline, &mut exporter)
        .await
        .is_err()
    {
        cancel_task(exporter).await;
    }
    // Shutdown may have recorded errors after the concurrent exporter ended.
    // Reuse the same deadline for that final delta, without another grace.
    if was_stopping {
        let _ = tokio::time::timeout_at(finish_deadline, telemetry.flush()).await;
    }
    drain_diagnostics(finish_deadline).await;
    Ok(success)
}

async fn finish_workers(
    mut tasks: JoinSet<bool>,
    stop: &watch::Sender<bool>,
    budget: &ShutdownBudget,
    child_grace: Duration,
) -> bool {
    let mut success = true;
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(worker_success) => success &= worker_success,
            Err(_) => {
                // Main installs a fail-closed panic hook. This also protects
                // callers that use the library without that executable hook.
                success = false;
                budget.end(child_grace);
                let _ = stop.send(true);
            }
        }
    }
    success
}

#[cfg(test)]
mod tests {
    use super::super::registry::ProtocolKind;
    use super::*;

    // Injected definitions are internal to tests. The production CLI accepts
    // only canonical registry names and exposes no executable/argument option.
    const fn fixture(
        name: &'static str,
        binary: &'static str,
        args: &'static [&'static str],
    ) -> WorkerSpec {
        WorkerSpec {
            name,
            binary,
            args,
            metric_prefix: "fixture_rust",
            protocol: "fixture:",
            batch_metric: "batch_events",
            extra_env: &[],
            enabled_env: None,
            max_events: 1,
            max_duration_ms: 300_000.0,
            protocol_kind: ProtocolKind::BatchOnly,
        }
    }

    static SUCCESS: WorkerSpec = fixture("fixture-success", "/bin/sh", &["-c", "exit 0"]);
    static FAILURE: WorkerSpec = fixture("fixture-failure", "/bin/sh", &["-c", "exit 7"]);
    static MISSING: WorkerSpec = fixture(
        "fixture-missing",
        "/__cron_index_fixture_private_missing__/child",
        &[],
    );
    static COOPERATIVE: WorkerSpec = fixture(
        "fixture-cooperative",
        "/usr/bin/python3",
        &[
            "-c",
            "import signal,sys; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); print('ready',flush=True); signal.pause()",
        ],
    );
    static STUBBORN: WorkerSpec = fixture(
        "fixture-stubborn",
        "/usr/bin/python3",
        &[
            "-c",
            "import signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); signal.pause()",
        ],
    );
    // Encode the expected dummy value so the fixed Python source in launch
    // arguments cannot itself trigger the diagnostic secret-leak assertion.
    static ENV_CHECK: WorkerSpec = fixture(
        "fixture-env",
        "/usr/bin/python3",
        &[
            "-c",
            "import os,sys; assert os.read(0,1)==b''; assert os.environ.get('MONGO_URI')==''.join(map(chr,[102,105,120,116,117,114,101,45,118,97,108,117,101])); assert 'NODE_OPTIONS' not in os.environ; assert 'UNRELATED_SECRET' not in os.environ; assert sys.argv[1:] == ['--once']; expected=65534 if int(os.environ['TZ'])==0 else int(os.environ['TZ']); assert os.getuid()==expected; expected_gid=65534 if int(os.environ['TZ'])==0 else int(os.environ['LANG']); assert os.getgid()==expected_gid; assert os.getpgrp()==int(os.environ['LC_ALL'])",
        ],
    );

    #[test]
    fn diagnostic_queue_is_bounded_fifo_and_drops_new_lines_when_full() {
        let (sender, receiver) = mpsc::sync_channel(DIAGNOSTIC_QUEUE_CAPACITY);
        let diagnostics = Diagnostics {
            sender,
            accepted: AtomicU64::new(0),
            progress: Arc::new(DiagnosticProgress::default()),
        };
        assert!(
            diagnostic_line(&json!({"oversized": "x".repeat(DIAGNOSTIC_LINE_LIMIT)})).is_none()
        );
        for index in 0..DIAGNOSTIC_QUEUE_CAPACITY {
            assert!(diagnostics.submit(&json!({"event": "fixture", "index": index})));
        }
        // The receiver is deliberately undrained. No send may wait or grow it.
        for _ in 0..4096 {
            assert!(!diagnostics.submit(&json!({"event": "dropped"})));
        }
        assert_eq!(
            diagnostics.accepted.load(Ordering::Acquire),
            DIAGNOSTIC_QUEUE_CAPACITY as u64
        );
        for index in 0..DIAGNOSTIC_QUEUE_CAPACITY {
            let line = receiver.try_recv().unwrap();
            assert!(line.len() <= DIAGNOSTIC_LINE_LIMIT);
            assert!(line.capacity() <= DIAGNOSTIC_LINE_LIMIT);
            assert!(line.starts_with(DIAGNOSTIC_PREFIX) && line.ends_with(b"\n"));
            let value: Value =
                serde_json::from_slice(&line[DIAGNOSTIC_PREFIX.len()..line.len() - 1]).unwrap();
            assert_eq!(value["index"], index);
        }
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn undrained_diagnostic_pipe_does_not_freeze_runtime_signal_drain_or_process_exit() {
        // Run only the internal fixture test in its own process/group. There
        // is no production executable/fixture flag. Its stdout is never read.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "supervisor::process::tests::diagnostic_backpressure_process_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .env("CRON_INDEX_DIAGNOSTIC_TEST_PROCESS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        // Even a failing assertion/timeout cannot strand a fixture descendant.
        // SAFETY: this is exclusively the newly created fixture process group.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
        let status = match status {
            Ok(status) => status.unwrap(),
            Err(_) => {
                let _ = child.wait().await;
                panic!("Undrained stdout froze the isolated diagnostic fixture");
            }
        };
        assert!(status.success(), "Isolated diagnostic fixture failed");
        assert_reaped(pid);
    }

    #[test]
    fn diagnostic_backpressure_process_fixture() {
        if std::env::var_os("CRON_INDEX_DIAGNOSTIC_TEST_PROCESS").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            return;
        }
        // Clear the harness's own pre-test stdout before the raw-fd writer
        // starts. From this point onward this process uses no std stdout API.
        io::stdout().flush().unwrap();
        start_diagnostics().unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // Both runtime threads emit well beyond the kernel pipe plus the
            // bounded queue. The parent never consumes a byte from this pipe.
            let mut emitters = JoinSet::new();
            for _ in 0..2 {
                emitters.spawn(async {
                    let value = json!({"event": "fixture", "padding": "x".repeat(8192)});
                    for _ in 0..512 {
                        emit(value.clone());
                    }
                });
            }
            while let Some(result) = emitters.join_next().await {
                result.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            let diagnostics = DIAGNOSTICS.get().unwrap().as_ref().unwrap();
            let accepted = diagnostics.accepted.load(Ordering::Acquire);
            assert!(accepted < 1024, "Full diagnostic queue must drop new lines");
            assert!(accepted > diagnostics.progress.completed.load(Ordering::Acquire));

            // Exercise real SIGTERM reception and an uncooperative owned child
            // while the writer is blocked. Scale only the fixture child grace.
            let (stop, stopping) = watch::channel(false);
            let budget = ShutdownBudget::default();
            let signals = signal_listener(
                stop,
                Events::new(false),
                budget.clone(),
                config(false).shutdown_grace,
            )
            .unwrap();
            let (events, mut captured) = capture();
            let worker = tokio::spawn(run_worker(
                &STUBBORN,
                config(false),
                Arc::new(Environment::new()),
                stopping,
                None,
                events,
                budget,
            ));
            let spawned = next_event(&mut captured, "spawn", STUBBORN.name).await;
            next_event(&mut captured, "fixture-read", STUBBORN.name).await;
            // SAFETY: target is this isolated fixture process, after its
            // explicit signal handler registration; no production PID is used.
            assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGTERM) }, 0);
            assert!(
                tokio::time::timeout(Duration::from_secs(3), worker)
                    .await
                    .unwrap()
                    .unwrap()
            );
            cancel_task(signals).await;
            assert_reaped(spawned["pid"].as_u64().unwrap() as u32);

            let started = tokio::time::Instant::now();
            drain_diagnostics(started + Duration::from_secs(1)).await;
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(
                diagnostics.accepted.load(Ordering::Acquire)
                    > diagnostics.progress.completed.load(Ordering::Acquire)
            );
        });
        // The raw-fd writer still blocks on the undrained pipe. Explicitly
        // exercise both runtime drop and Rust's normal exit/stdio cleanup;
        // neither may try to join it or flush a globally locked stdout buffer.
        drop(runtime);
        std::process::exit(0);
    }

    fn config(once: bool) -> Config {
        Config {
            once,
            events_json: true,
            restart_delay: Duration::from_millis(40),
            shutdown_grace: Duration::from_millis(250),
        }
    }

    fn capture() -> (Events, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Events {
                progress: false,
                capture: Some(tx),
            },
            rx,
        )
    }

    async fn next_event(
        events: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
        kind: &str,
        name: &str,
    ) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.expect("fixture event channel closed");
                if event["event"] == kind && event["name"] == name {
                    return event;
                }
            }
        })
        .await
        .expect("fixture event deadline")
    }

    fn assert_reaped(pid: u32) {
        // SAFETY: waitpid with WNOHANG cannot block; this is a task-owned PID.
        let result =
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(result, -1, "Owned fixture must have been reaped");
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[tokio::test]
    async fn once_aggregates_success_exit_failure_and_failed_spawn_without_restarts() {
        let (stop, stopping) = watch::channel(false);
        let (events, mut captured) = capture();
        let mut tasks = JoinSet::new();
        let budget = ShutdownBudget::default();
        for spec in [&SUCCESS, &FAILURE, &MISSING] {
            tasks.spawn(run_worker(
                spec,
                config(true),
                Arc::new(Environment::new()),
                stopping.clone(),
                None,
                events.clone(),
                budget.clone(),
            ));
        }
        assert!(!finish_workers(tasks, &stop, &budget, config(true).shutdown_grace).await);
        let mut spawns = 0;
        let mut exits = 0;
        while let Ok(event) = captured.try_recv() {
            match event["event"].as_str() {
                Some("spawn") => {
                    spawns += 1;
                    assert_reaped(event["pid"].as_u64().unwrap() as u32);
                }
                Some("exit") => {
                    exits += 1;
                    assert_eq!(event["restarting"], false);
                }
                Some("restart") => panic!("once must never schedule restart"),
                _ => {}
            }
            assert!(
                !event
                    .to_string()
                    .contains("__cron_index_fixture_private_missing__")
            );
        }
        assert_eq!((spawns, exits), (2, 3));
    }

    #[tokio::test]
    async fn once_success_inherits_no_private_environment_and_keeps_the_parent_group() {
        let mut env = Environment::new();
        env.insert("MONGO_URI".into(), "fixture-value".into());
        env.insert("NODE_OPTIONS".into(), "private-fixture".into());
        env.insert("UNRELATED_SECRET".into(), "private-fixture".into());
        // Reserved allowlisted slots carry fixture expectations, never a live
        // endpoint. Python does not initialize databases or locale from them.
        // SAFETY: identity/group getters have no preconditions.
        let (uid, gid, group) = unsafe { (libc::getuid(), libc::getgid(), libc::getpgrp()) };
        env.insert("TZ".into(), uid.to_string().into());
        env.insert("LANG".into(), gid.to_string().into());
        env.insert("LC_ALL".into(), group.to_string().into());
        let (_stop, stopping) = watch::channel(false);
        let (events, mut captured) = capture();
        assert!(
            run_worker(
                &ENV_CHECK,
                config(true),
                Arc::new(env),
                stopping,
                None,
                events,
                ShutdownBudget::default()
            )
            .await
        );
        while let Ok(event) = captured.try_recv() {
            assert!(!event.to_string().contains("private-fixture"));
            assert!(!event.to_string().contains("fixture-value"));
        }
    }

    #[tokio::test]
    async fn exit_and_spawn_failure_each_schedule_one_restart_and_stop_cancels_delay() {
        for spec in [&SUCCESS, &FAILURE, &MISSING] {
            let (stop, stopping) = watch::channel(false);
            let (events, mut captured) = capture();
            let task = tokio::spawn(run_worker(
                spec,
                config(false),
                Arc::new(Environment::new()),
                stopping,
                None,
                events,
                ShutdownBudget::default(),
            ));
            let first = next_event(&mut captured, "restart", spec.name).await;
            assert_eq!(first["restartCount"], 1);
            let second = next_event(&mut captured, "restart", spec.name).await;
            assert_eq!(second["restartCount"], 2);
            stop.send(true).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .unwrap()
                    .unwrap()
            );
            while let Ok(event) = captured.try_recv() {
                assert_ne!(event["event"], "spawn");
                assert_ne!(event["event"], "restart");
            }
        }
    }

    #[tokio::test]
    async fn shutdown_allows_a_cooperative_child_and_escalates_then_reaps_a_stubborn_child() {
        for (spec, expected_code, expected_signal) in
            [(&COOPERATIVE, 0, None), (&STUBBORN, 1, Some(libc::SIGKILL))]
        {
            let (stop, stopping) = watch::channel(false);
            let (events, mut captured) = capture();
            let task = tokio::spawn(run_worker(
                spec,
                config(false),
                Arc::new(Environment::new()),
                stopping,
                None,
                events,
                ShutdownBudget::default(),
            ));
            let spawned = next_event(&mut captured, "spawn", spec.name).await;
            next_event(&mut captured, "fixture-read", spec.name).await;
            stop.send(true).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_secs(5), task)
                    .await
                    .unwrap()
                    .unwrap()
            );
            let exit = next_event(&mut captured, "exit", spec.name).await;
            assert_eq!(exit["code"], expected_code);
            assert_eq!(
                exit["signal"],
                expected_signal.map(Value::from).unwrap_or(Value::Null)
            );
            assert_eq!(exit["restarting"], false);
            assert_reaped(spawned["pid"].as_u64().unwrap() as u32);
        }
    }

    #[tokio::test]
    async fn restarting_one_child_does_not_restart_another_live_child() {
        let (stop, stopping) = watch::channel(false);
        let env = Arc::new(Environment::new());
        let budget = ShutdownBudget::default();
        let (stable_events, mut stable_captured) = capture();
        let stable = tokio::spawn(run_worker(
            &COOPERATIVE,
            config(false),
            env.clone(),
            stopping.clone(),
            None,
            stable_events,
            budget.clone(),
        ));
        let spawned = next_event(&mut stable_captured, "spawn", COOPERATIVE.name).await;
        next_event(&mut stable_captured, "fixture-read", COOPERATIVE.name).await;
        let (failed_events, mut failed_captured) = capture();
        let failed = tokio::spawn(run_worker(
            &FAILURE,
            config(false),
            env,
            stopping,
            None,
            failed_events,
            budget,
        ));
        next_event(&mut failed_captured, "restart", FAILURE.name).await;
        let restart = next_event(&mut failed_captured, "restart", FAILURE.name).await;
        assert_eq!(restart["restartCount"], 2);
        assert!(stable_captured.try_recv().is_err());
        stop.send(true).unwrap();
        assert!(stable.await.unwrap());
        assert!(failed.await.unwrap());
        assert_reaped(spawned["pid"].as_u64().unwrap() as u32);
    }

    #[tokio::test]
    async fn stdout_accepts_only_valid_bounded_frames_and_discards_private_text() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(2048);
        let (mut events, mut captured) = capture();
        events.progress = true;
        let (_stop, stopping) = watch::channel(false);
        // from_env does no IO. This test never starts an exporter or sampler,
        // and therefore cannot contact even an inherited telemetry endpoint.
        let reader = tokio::spawn(read_stdout(
            reader,
            &SUCCESS,
            Some(12345),
            stopping,
            Some(Telemetry::from_env()),
            events,
        ));
        writer.write_all(b"private-stdout\nfixture:{\"event\":\"batch\",\"events\":1,\"durationMs\":2,\"success\":true,\"secret\":\"private-field\"}\n").await.unwrap();
        for _ in 0..64 {
            writer.write_all(&[b'x'; FRAME_LIMIT]).await.unwrap();
        }
        writer.write_all(b"\nfixture:{\"event\":\"batch\",\"events\":1,\"durationMs\":2,\"success\":true}\nfixture:{\"event\":\"health\",\"success\":true}\nfixture:{\"event\":\"batch\",\"events\":0,\"durationMs\":2,\"success\":false}").await.unwrap();
        drop(writer);
        reader.await.unwrap();
        let mut progress = Vec::new();
        while let Ok(event) = captured.try_recv() {
            assert!(!event.to_string().contains("private-"));
            if event["event"] == "batch" || event["event"] == "health" {
                progress.push(event);
            }
        }
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0]["event"], "batch");
        assert_eq!(progress[0]["worker"], SUCCESS.name);
        assert_eq!(progress[0]["pid"], 12345);
        assert_eq!(progress[0]["frame"]["events"], 1);
    }

    #[tokio::test]
    async fn shutdown_continues_draining_stdout_without_accepting_new_progress() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(2048);
        let (mut events, mut captured) = capture();
        events.progress = true;
        let (_stop, stopping) = watch::channel(true);
        let reader = tokio::spawn(read_stdout(
            reader,
            &SUCCESS,
            Some(12345),
            stopping,
            Some(Telemetry::from_env()),
            events,
        ));
        for _ in 0..100 {
            writer.write_all(b"fixture:{\"event\":\"batch\",\"events\":1,\"durationMs\":2,\"success\":true}\n").await.unwrap();
        }
        drop(writer);
        reader.await.unwrap();
        while let Ok(event) = captured.try_recv() {
            assert_ne!(event["event"], "batch");
        }
    }

    #[tokio::test]
    async fn pipe_and_export_share_a_deadline_instead_of_stacking_close_timeouts() {
        let budget = ShutdownBudget::default();
        let end = tokio::time::Instant::now() + Duration::from_millis(30);
        budget.0.set(end).unwrap();
        assert_eq!(budget.end(Duration::from_secs(25)), end);
        close_stdout(tokio::spawn(std::future::pending()), &budget).await;
        // The next finalization wait shares the expired deadline, rather than
        // adding a new two-second grace period after the pipe fence.
        assert!(
            tokio::time::timeout_at(end, std::future::pending::<()>())
                .await
                .is_err()
        );
        assert!(tokio::time::Instant::now().duration_since(end) < Duration::from_secs(1));
    }

    #[test]
    fn framing_is_bounded_and_recovers_only_after_newline() {
        let mut frames = Frames::default();
        let mut accepted = Vec::new();
        frames.feed(b"one\ntw", |line| accepted.push(line.to_vec()));
        frames.feed(b"o\n", |line| accepted.push(line.to_vec()));
        frames.feed(&[b'x'; FRAME_LIMIT], |line| accepted.push(line.to_vec()));
        assert_eq!(frames.length, FRAME_LIMIT);
        frames.feed(b"x", |line| accepted.push(line.to_vec()));
        assert!(frames.discarding);
        assert_eq!(frames.length, 0);
        for _ in 0..1000 {
            frames.feed(&[b'x'; FRAME_LIMIT], |line| accepted.push(line.to_vec()));
            assert_eq!(frames.length, 0);
        }
        frames.feed(b"\nvalid\npartial", |line| accepted.push(line.to_vec()));
        assert_eq!(
            accepted,
            [b"one".to_vec(), b"two".to_vec(), b"valid".to_vec()]
        );
        // Exactly 1024 bytes followed by newline remains a valid frame.
        let mut exact = Frames::default();
        exact.feed(&[b'x'; FRAME_LIMIT], |_| panic!("No newline yet"));
        exact.feed(b"\n", |line| assert_eq!(line.len(), FRAME_LIMIT));
    }
}
