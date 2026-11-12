//! Telemetry of supervised tasks: the cron binary's workers, which share one process.
//!
//! Today each TypeScript worker is a process and reports its own `runtime` row
//! (`<file>.worker.rss_bytes`, `cpu_cores`, `event_loop_p99_ms`); the seven native workers print
//! `<protocol>:{json}` frames that the supervisor turns into metrics. Here a worker calls a typed
//! API on its [`Worker`] handle, and the process sampler adds per-worker rows every 10 seconds.
//!
//! **Names.** Everything is reported under the worker's prefix: `<name>.worker` for the workers
//! ported from TypeScript (so the admin page labels the row "Goals worker" as today) and the
//! existing `<name>_rust` prefixes for the seven native workers (the page's refresh-health panel
//! and phase charts are keyed on them).
//!
//! | Metric | Kind | Value |
//! |---|---|---|
//! | `<prefix>.cpu_cores` | `runtime` | **poll busy time**, not CPU time: wall time spent inside polls of the instrumented future over the window (see below) |
//! | `<prefix>.event_loop_p99_ms` | `runtime` | **the longest single poll** in the window, ms, not a percentile: how long the worker held a runtime thread at once |
//! | `<prefix>.state` | `worker` | 0 idle, 1 running, 2 restarting (backoff), 3 stopped, 4 fatal |
//! | `<prefix>.since_success_ms` | `worker` | time since the last successful run |
//! | `<prefix>.runs` | `worker` | one per finished run, outcome `ok`, `idle` or `error` |
//! | `<prefix>.run` | `queue_run` | run duration, same outcomes (the page's queue/job row) |
//! | `<prefix>.restarts` | `worker` | one per restart |
//! | `<prefix>.errors` | `worker` | one per reported failure, plus a metadata-only telemetry log |
//! | `<prefix>.<batch>` and `<prefix>.project_batch` | `worker` / `queue_run` | [`Worker::batch`], as the native frames |
//! | `<prefix>.phase.<phase>` | `queue_run` | [`Worker::phase`] |
//! | `<prefix>.health_query`, `health_errors`, gauges | `worker` | [`Worker::health`], [`Worker::gauge`] |
//!
//! The wire names are the ones the admin page reads for a process row ("CPU" and "lag"); the
//! figures behind them are not those of a process.
//!
//! **What poll busy time measures.** Two monotonic clock reads around each poll of the future
//! given to [`Worker::instrument`], summed, over the wall time since the previous sample (the
//! first window starts when the worker is registered with [`crate::Telemetry::worker`]). It is
//! wall time on a runtime thread, so a poll that waits for a lock or is descheduled by the
//! operating system counts as busy, and a busy figure above 1 is impossible for one future. It
//! misses: work in tasks the worker spawns (they are polled by the runtime, not through the
//! wrapper, unless they are instrumented too), work handed to `spawn_blocking` or another thread,
//! and a poll that panics (it has no end; the worker then stops, see [`Worker::instrument`]). The
//! longest poll has the same coverage.
//!
//! **What a worker row shows after the migration.** Poll busy time in the "CPU" column and the
//! longest poll in the "lag" column. Memory per worker no longer exists: all workers share one
//! allocator, so the row shows no memory and the process row (`cron` / `index`, "Workers host")
//! carries the resident size of all of them together.

use crate::label::Channel;
use crate::span::Span;
use crate::telemetry::Telemetry;
use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, PoisonError};
use std::task::Poll;
use std::time::Duration;
use tokio::time::Instant;

/// Where a worker is, as the supervisor sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WorkerState {
    /// Waiting for its next run.
    Idle = 0,
    /// Running.
    Running = 1,
    /// Ended; waiting for its restart delay.
    Restarting = 2,
    /// Stopped (shutdown or disabled).
    Stopped = 3,
    /// Not restarted because its work would not stop: the process is exiting.
    Fatal = 4,
}

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    /// Did work.
    Ok,
    /// Found nothing to do.
    Idle,
    /// Failed.
    Error,
}

impl RunOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Idle => "idle",
            Self::Error => "error",
        }
    }
}

struct Names {
    run: &'static str,
    runs: &'static str,
    restarts: &'static str,
    errors: &'static str,
    state: &'static str,
    since_success: &'static str,
    /// Wire name `<prefix>.cpu_cores`.
    poll_busy_cores: &'static str,
    /// Wire name `<prefix>.event_loop_p99_ms`.
    longest_poll_ms: &'static str,
    project_batch: &'static str,
    health_query: &'static str,
    health_errors: &'static str,
}

pub(crate) struct WorkerCell {
    prefix: &'static str,
    names: Names,
    poll_busy_ns: AtomicU64,
    longest_poll_ns: AtomicU64,
    state: AtomicU8,
    last_success_ms: AtomicI64,
    /// Where the current measurement window began: the registration, then the last sample.
    window: std::sync::Mutex<Instant>,
}

impl WorkerCell {
    pub(crate) fn new(prefix: &'static str, _now_ms: u64) -> Self {
        let name = |suffix: &'static str| crate::names::join(prefix, ".", suffix);
        Self {
            names: Names {
                run: name("run"),
                runs: name("runs"),
                restarts: name("restarts"),
                errors: name("errors"),
                state: name("state"),
                since_success: name("since_success_ms"),
                poll_busy_cores: name("cpu_cores"),
                longest_poll_ms: name("event_loop_p99_ms"),
                project_batch: name("project_batch"),
                health_query: name("health_query"),
                health_errors: name("health_errors"),
            },
            prefix,
            poll_busy_ns: AtomicU64::new(0),
            longest_poll_ns: AtomicU64::new(0),
            state: AtomicU8::new(WorkerState::Idle as u8),
            last_success_ms: AtomicI64::new(i64::MIN),
            window: std::sync::Mutex::new(Instant::now()),
        }
    }

    pub(crate) fn prefix(&self) -> &'static str {
        self.prefix
    }

    fn polled(&self, elapsed: Duration) {
        let nanos = u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX);
        self.poll_busy_ns.fetch_add(nanos, Ordering::Relaxed);
        self.longest_poll_ns.fetch_max(nanos, Ordering::Relaxed);
    }
}

/// One worker's telemetry handle. Cheap to clone.
#[derive(Clone)]
pub struct Worker {
    telemetry: Telemetry,
    cell: Arc<WorkerCell>,
}

impl std::fmt::Debug for Worker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Worker")
            .field("prefix", &self.cell.prefix)
            .finish()
    }
}

impl Worker {
    pub(crate) fn new(telemetry: Telemetry, cell: Arc<WorkerCell>) -> Self {
        Self { telemetry, cell }
    }

    /// The prefix every metric of this worker carries.
    pub fn prefix(&self) -> &'static str {
        self.cell.prefix
    }

    /// Wraps the worker's future so the time spent polling it is counted (two clock reads per
    /// poll). Wrap the whole task once, at the supervisor.
    ///
    /// The worker is alive while the wrapped future is: when it is first polled the state becomes
    /// `idle`, and every way out of it (it returns, it is dropped or cancelled, it panics, or it is
    /// dropped without ever being polled) sets `stopped`, after which the sampler emits no rows for
    /// the worker until it runs again: the admin page shows a dead worker as stale, as it does a
    /// dead process. [`Worker::restarted`] marks the backoff before the next instance.
    /// The returned future does not borrow the handle, so it can be spawned.
    pub fn instrument<F: Future>(&self, future: F) -> impl Future<Output = F::Output> + use<F> {
        let cell = self.cell.clone();
        let alive = Alive(self.cell.clone());
        async move {
            let _alive = alive;
            cell.state.store(WorkerState::Idle as u8, Ordering::Relaxed);
            let mut future = std::pin::pin!(future);
            std::future::poll_fn(|cx| {
                let started = std::time::Instant::now();
                let poll = future.as_mut().poll(cx);
                cell.polled(started.elapsed());
                match poll {
                    Poll::Ready(output) => Poll::Ready(output),
                    Poll::Pending => Poll::Pending,
                }
            })
            .await
        }
    }

    /// Sets the state gauge.
    pub fn set_state(&self, state: WorkerState) {
        self.cell.state.store(state as u8, Ordering::Relaxed);
    }

    /// The current state.
    pub fn state(&self) -> WorkerState {
        WorkerState::from_u8(self.cell.state.load(Ordering::Relaxed))
    }

    /// Starts a run: state `running`, and a `queue_run` span named `<prefix>.run`.
    pub fn run(&self) -> Run<'_> {
        self.set_state(WorkerState::Running);
        Run {
            worker: self,
            span: Some(Span::start(
                &self.telemetry,
                "queue_run",
                self.cell.names.run,
                Some(Channel::EMPTY),
            )),
        }
    }

    /// The supervisor restarted the worker.
    pub fn restarted(&self) {
        self.set_state(WorkerState::Restarting);
        self.telemetry
            .observe_with("worker", self.cell.names.restarts, 1.0, "ok", Some(""));
    }

    /// A failure worth an operator's attention (`recordWorkerError`): the `<prefix>.errors` count
    /// and a metadata-only telemetry log `{function: prefix, step, code}`. `step` and `code` must be
    /// fixed labels from the source, never error text.
    pub fn error(&self, step: &'static str, code: &'static str) {
        self.telemetry
            .observe_with("worker", self.cell.names.errors, 1.0, "error", Some(""));
        let code = if !code.is_empty()
            && code.len() <= 40
            && code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            code
        } else {
            "WORKER_ERROR"
        };
        self.telemetry.record_metadata_log(
            "error",
            &serde_json::json!({ "function": self.cell.prefix, "step": step, "code": code }),
        );
    }

    /// One batch, as the native frames report it: `worker <prefix>.<metric>` = items and
    /// `queue_run <prefix>.project_batch` = duration, outcome `error` on failure, `ok` with items,
    /// `idle` without.
    pub fn batch(&self, metric: &'static str, items: u64, duration: Duration, success: bool) {
        let outcome = if !success {
            "error"
        } else if items > 0 {
            "ok"
        } else {
            "idle"
        };
        let name = crate::names::join(self.cell.prefix, ".", metric);
        self.telemetry
            .observe_with("worker", name, items as f64, outcome, Some(""));
        self.telemetry.observe_with(
            "queue_run",
            self.cell.names.project_batch,
            duration.as_secs_f64() * 1000.0,
            outcome,
            Some(""),
        );
    }

    /// One phase of a batch: `queue_run <prefix>.phase.<phase>`.
    pub fn phase(&self, phase: &'static str, duration: Duration, outcome: &'static str) {
        let name = crate::names::join(self.cell.prefix, ".phase.", phase);
        self.telemetry.observe_with(
            "queue_run",
            name,
            duration.as_secs_f64() * 1000.0,
            outcome,
            Some(""),
        );
    }

    /// A health probe: `health_query` = 1 or 0, and `health_errors` on failure.
    pub fn health(&self, success: bool) {
        self.telemetry.observe_with(
            "worker",
            self.cell.names.health_query,
            if success { 1.0 } else { 0.0 },
            "ok",
            Some(""),
        );
        if !success {
            self.telemetry.observe_with(
                "worker",
                self.cell.names.health_errors,
                1.0,
                "error",
                Some(""),
            );
        }
    }

    /// A gauge: `worker <prefix>.<metric>`.
    pub fn gauge(&self, metric: &'static str, value: f64) {
        let name = crate::names::join(self.cell.prefix, ".", metric);
        self.telemetry
            .observe_with("worker", name, value, "ok", Some(""));
    }
}

/// Sets the terminal state when the instrumented future goes away, however it goes.
struct Alive(Arc<WorkerCell>);

impl Drop for Alive {
    fn drop(&mut self) {
        self.0
            .state
            .store(WorkerState::Stopped as u8, Ordering::Relaxed);
    }
}

impl WorkerState {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Idle,
            1 => Self::Running,
            2 => Self::Restarting,
            3 => Self::Stopped,
            _ => Self::Fatal,
        }
    }

    /// Whether the worker has ended (`stopped` or `fatal`): no rows are emitted for it.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Stopped | Self::Fatal)
    }
}

/// One run in progress; ends `error` if dropped unfinished.
pub struct Run<'a> {
    worker: &'a Worker,
    span: Option<Span<'a>>,
}

impl Run<'_> {
    /// Runs `future` inside the run's span.
    pub async fn scope<F: Future>(&mut self, future: F) -> F::Output {
        match &mut self.span {
            Some(span) => span.run(future).await,
            None => future.await,
        }
    }

    /// Ends the run.
    pub fn finish(mut self, outcome: RunOutcome) {
        self.end(outcome);
    }

    fn end(&mut self, outcome: RunOutcome) {
        let Some(span) = self.span.take() else {
            return;
        };
        span.end(outcome.as_str());
        let worker = self.worker;
        worker.telemetry.observe_with(
            "worker",
            worker.cell.names.runs,
            0.0,
            outcome.as_str(),
            Some(""),
        );
        if outcome != RunOutcome::Error {
            worker
                .cell
                .last_success_ms
                .store(worker.telemetry.0.clock.now_ms(), Ordering::Relaxed);
        }
        worker.set_state(WorkerState::Idle);
    }
}

impl Drop for Run<'_> {
    fn drop(&mut self) {
        self.end(RunOutcome::Error);
    }
}

/// The per-worker samples (called by the process sampler).
pub(crate) fn sample_workers(telemetry: &Telemetry, now: Instant) {
    let workers: Vec<Arc<WorkerCell>> = telemetry
        .0
        .workers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let now_ms = telemetry.0.clock.now_ms();
    for cell in workers {
        let busy = cell.poll_busy_ns.swap(0, Ordering::Relaxed);
        let longest = cell.longest_poll_ns.swap(0, Ordering::Relaxed);
        let previous = std::mem::replace(
            &mut *cell.window.lock().unwrap_or_else(PoisonError::into_inner),
            now,
        );
        let state = WorkerState::from_u8(cell.state.load(Ordering::Relaxed));
        if state.is_terminal() {
            // A worker that ended reports nothing; its window restarts with it.
            continue;
        }
        let wall = now.saturating_duration_since(previous).as_secs_f64();
        if wall > 0.0 {
            let cores = busy as f64 / 1e9 / wall;
            telemetry.observe_with("runtime", cell.names.poll_busy_cores, cores, "ok", Some(""));
            telemetry.observe_with(
                "runtime",
                cell.names.longest_poll_ms,
                longest as f64 / 1e6,
                "ok",
                Some(""),
            );
        }
        let state = f64::from(state as u8);
        telemetry.observe_with("worker", cell.names.state, state, "ok", Some(""));
        let last = cell.last_success_ms.load(Ordering::Relaxed);
        if last != i64::MIN {
            let age = (now_ms - last).max(0) as f64;
            telemetry.observe_with("worker", cell.names.since_success, age, "ok", Some(""));
        }
    }
}
