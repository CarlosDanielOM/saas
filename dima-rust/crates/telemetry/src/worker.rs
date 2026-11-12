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
//! | `<prefix>.cpu_cores` | `runtime` | time spent polling the worker's futures over wall time (busy cores) |
//! | `<prefix>.event_loop_p99_ms` | `runtime` | longest single poll in the window, ms: how long the worker held a runtime thread |
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
//! **What a worker row shows after the migration.** CPU (busy cores) and the longest poll in the
//! "lag" column, from the figures above. Memory per worker no longer exists: all workers share one
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
    run: String,
    runs: String,
    restarts: String,
    errors: String,
    state: String,
    since_success: String,
    cpu: String,
    lag: String,
    project_batch: String,
}

pub(crate) struct WorkerCell {
    prefix: String,
    names: Names,
    busy_ns: AtomicU64,
    max_poll_ns: AtomicU64,
    state: AtomicU8,
    last_success_ms: AtomicI64,
    window: std::sync::Mutex<Option<Instant>>,
}

impl WorkerCell {
    pub(crate) fn new(prefix: &str, _now_ms: u64) -> Self {
        let prefix = crate::label::Label::<60>::clean(prefix).as_str().to_owned();
        let name = |suffix: &str| format!("{prefix}.{suffix}");
        Self {
            names: Names {
                run: name("run"),
                runs: name("runs"),
                restarts: name("restarts"),
                errors: name("errors"),
                state: name("state"),
                since_success: name("since_success_ms"),
                cpu: name("cpu_cores"),
                lag: name("event_loop_p99_ms"),
                project_batch: name("project_batch"),
            },
            prefix,
            busy_ns: AtomicU64::new(0),
            max_poll_ns: AtomicU64::new(0),
            state: AtomicU8::new(WorkerState::Idle as u8),
            last_success_ms: AtomicI64::new(i64::MIN),
            window: std::sync::Mutex::new(None),
        }
    }

    pub(crate) fn prefix(&self) -> &str {
        &self.prefix
    }

    fn polled(&self, elapsed: Duration) {
        let nanos = u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX);
        self.busy_ns.fetch_add(nanos, Ordering::Relaxed);
        self.max_poll_ns.fetch_max(nanos, Ordering::Relaxed);
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
    pub fn prefix(&self) -> &str {
        &self.cell.prefix
    }

    /// Wraps the worker's future so the time spent polling it is counted (two clock reads per
    /// poll). Wrap the whole task once, at the supervisor.
    pub fn instrument<F: Future>(&self, future: F) -> impl Future<Output = F::Output> {
        let cell = self.cell.clone();
        async move {
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

    /// Starts a run: state `running`, and a `queue_run` span named `<prefix>.run`.
    pub fn run(&self) -> Run<'_> {
        self.set_state(WorkerState::Running);
        Run {
            worker: self,
            span: Some(Span::start(
                &self.telemetry,
                "queue_run",
                &self.cell.names.run,
                Some(Channel::EMPTY),
            )),
        }
    }

    /// The supervisor restarted the worker.
    pub fn restarted(&self) {
        self.set_state(WorkerState::Restarting);
        self.telemetry
            .observe_with("worker", &self.cell.names.restarts, 1.0, "ok", Some(""));
    }

    /// A failure worth an operator's attention (`recordWorkerError`): the `<prefix>.errors` count
    /// and a metadata-only telemetry log `{function: prefix, step, code}`. `step` and `code` must be
    /// fixed labels from the source, never error text.
    pub fn error(&self, step: &str, code: &str) {
        self.telemetry
            .observe_with("worker", &self.cell.names.errors, 1.0, "error", Some(""));
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
    pub fn batch(&self, metric: &str, items: u64, duration: Duration, success: bool) {
        let outcome = if !success {
            "error"
        } else if items > 0 {
            "ok"
        } else {
            "idle"
        };
        let name = format!("{}.{metric}", self.cell.prefix);
        self.telemetry
            .observe_with("worker", &name, items as f64, outcome, Some(""));
        self.telemetry.observe_with(
            "queue_run",
            &self.cell.names.project_batch,
            duration.as_secs_f64() * 1000.0,
            outcome,
            Some(""),
        );
    }

    /// One phase of a batch: `queue_run <prefix>.phase.<phase>`.
    pub fn phase(&self, phase: &str, duration: Duration, outcome: &str) {
        let name = format!("{}.phase.{phase}", self.cell.prefix);
        self.telemetry.observe_with(
            "queue_run",
            &name,
            duration.as_secs_f64() * 1000.0,
            outcome,
            Some(""),
        );
    }

    /// A health probe: `health_query` = 1 or 0, and `health_errors` on failure.
    pub fn health(&self, success: bool) {
        let prefix = &self.cell.prefix;
        self.telemetry.observe_with(
            "worker",
            &format!("{prefix}.health_query"),
            if success { 1.0 } else { 0.0 },
            "ok",
            Some(""),
        );
        if !success {
            self.telemetry.observe_with(
                "worker",
                &format!("{prefix}.health_errors"),
                1.0,
                "error",
                Some(""),
            );
        }
    }

    /// A gauge: `worker <prefix>.<metric>`.
    pub fn gauge(&self, metric: &str, value: f64) {
        let name = format!("{}.{metric}", self.cell.prefix);
        self.telemetry
            .observe_with("worker", &name, value, "ok", Some(""));
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
            &worker.cell.names.runs,
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
        let busy = cell.busy_ns.swap(0, Ordering::Relaxed);
        let longest = cell.max_poll_ns.swap(0, Ordering::Relaxed);
        let previous = cell
            .window
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(now);
        if let Some(previous) = previous {
            let wall = now.saturating_duration_since(previous).as_secs_f64();
            if wall > 0.0 {
                let cores = busy as f64 / 1e9 / wall;
                telemetry.observe_with("runtime", &cell.names.cpu, cores, "ok", Some(""));
                telemetry.observe_with(
                    "runtime",
                    &cell.names.lag,
                    longest as f64 / 1e6,
                    "ok",
                    Some(""),
                );
            }
        }
        let state = f64::from(cell.state.load(Ordering::Relaxed));
        telemetry.observe_with("worker", &cell.names.state, state, "ok", Some(""));
        let last = cell.last_success_ms.load(Ordering::Relaxed);
        if last != i64::MIN {
            let age = (now_ms - last).max(0) as f64;
            telemetry.observe_with("worker", &cell.names.since_success, age, "ok", Some(""));
        }
    }
}
