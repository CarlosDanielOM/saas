//! The supervisor of the workers, its timing, its telemetry, and how the process ends.
//!
//! Every worker is a task of one [`Supervisor`] (`dima_core::runtime`), on one runtime, with no
//! thread of its own:
//!
//! | Case | What happens | Exit status |
//! |---|---|---|
//! | A tick returns an error, panics or passes its deadline | The pacing decides: go on (after a pause) or end the run; an ended run is restarted alone after [`SupervisorConfig::restart_delay`] (5 s), doubling while it keeps failing within [`BACKOFF_RESET`], up to [`BACKOFF_MAX`] | (keeps running) |
//! | A tick never returns | Aborted at its deadline and joined; then as above | (keeps running) |
//! | A tick ignores the abort and blocks its thread | After the tick's grace the supervisor marks the worker fatal and does not restart it; the process stops the others and exits | [`Exit::Fatal`], 2 |
//! | SIGTERM or SIGINT | Pauses end at once; ticks in flight finish within their deadline or [`STOP_DEADLINE`], then are aborted and joined within [`STOP_GRACE`]; Twitch drains; telemetry flushes; all inside [`SHUTDOWN_BUDGET`] | [`Exit::Clean`], 0, or [`Exit::Unclean`], 3 |
//! | Bad configuration, a store that cannot be reached at start | Nothing starts | [`Exit::Startup`], 1 |
//!
//! Lifecycle telemetry ([`SupervisorLog`]): console lines for start, end, restart (with its
//! delay and count), stop and fatal stop, in the shape of the TypeScript supervisor's
//! (`worker: "cron_supervisor"`, `name`, `restartCount`); the worker's `restarts` and `state`
//! metrics; and per tick (in [`crate::runner`]) the `run` span, the batch metric and `errors`.

use crate::runner::{LeaseContext, Runner};
use crate::worker::{Lease, Worker};
use dima_core::runtime::{
    Backoff, FatalError, Supervisor, SupervisorConfig, SupervisorHandle, SupervisorReport,
    TaskEvents, TaskExit,
};
use dima_telemetry::worker::WorkerState;
use dima_telemetry::{LogOptions, Telemetry};
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// The whole shutdown, every step included: `dima_twitch::Timings::shutdown_budget()` with the
/// reference values (15 s of token-exchange drain and 2 s to park), which the container's stop
/// timeout (25 s, phase 7) must exceed. The TypeScript cron gave its workers 25 s before SIGKILL.
pub const SHUTDOWN_BUDGET: Duration = Duration::from_secs(17);
/// How long ticks in flight may go on after the shutdown signal before they are aborted.
pub const STOP_DEADLINE: Duration = Duration::from_secs(10);
/// How long aborted work gets to stop before it is reported unstoppable.
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// The longest restart delay of a worker that keeps failing (12 times the reference's 5 s).
pub const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A run that lasted this long resets a worker's restart delay to the base.
pub const BACKOFF_RESET: Duration = Duration::from_secs(60);
/// The longest the final telemetry flush may take within the budget.
pub const TELEMETRY_FLUSH: Duration = Duration::from_secs(5);

/// How the process ends, and its exit status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exit {
    /// Stopped on a signal; everything stopped within its budget. Status 0.
    Clean,
    /// Could not start: a setting or a store. Status 1.
    Startup,
    /// A worker's work did not stop when told to. Status 2: the container restarts the
    /// process (MIGRATION.md section 6).
    Fatal(&'static str),
    /// Stopped on a signal, but something did not stop within its budget. Status 3.
    Unclean,
}

impl Exit {
    /// The process exit status.
    pub fn code(&self) -> u8 {
        match self {
            Self::Clean => 0,
            Self::Startup => 1,
            Self::Fatal(_) => 2,
            Self::Unclean => 3,
        }
    }
}

/// The supervisor's timing in production.
pub fn timing(restart_delay: Duration) -> (SupervisorConfig, Backoff) {
    (
        SupervisorConfig {
            restart_delay,
            stop_deadline: STOP_DEADLINE,
            stop_grace: STOP_GRACE,
        },
        Backoff {
            max: BACKOFF_MAX,
            reset_after: BACKOFF_RESET,
        },
    )
}

/// Turns the supervisor's events into console lines and worker metrics.
pub struct SupervisorLog {
    log: Telemetry,
    workers: HashMap<&'static str, dima_telemetry::Worker>,
}

impl SupervisorLog {
    fn entry(&self, name: &'static str, message: &str) -> serde_json::Value {
        json!({ "worker": "cron_supervisor", "message": message, "name": name })
    }

    fn metrics(&self, name: &str) -> Option<&dima_telemetry::Worker> {
        self.workers.get(name)
    }
}

impl TaskEvents for SupervisorLog {
    fn started(&self, task: &'static str, restarts: u64) {
        let mut entry = self.entry(task, "Started cron worker");
        entry["restartCount"] = restarts.into();
        self.log.info(&entry, LogOptions::console());
    }

    fn ended(&self, task: &'static str, exit: &TaskExit, ran: Duration) {
        let mut entry = self.entry(task, "Cron worker ended");
        entry["ranMs"] = u64::try_from(ran.as_millis()).unwrap_or(u64::MAX).into();
        match exit {
            TaskExit::Finished => {
                entry["exit"] = "finished".into();
                self.log.info(&entry, LogOptions::console());
            }
            TaskExit::Aborted => {
                entry["exit"] = "aborted".into();
                self.log.warn(&entry, LogOptions::console());
            }
            TaskExit::Failed(error) => {
                entry["exit"] = "failed".into();
                entry["error"] = error.as_str().into();
                self.log.warn(&entry, LogOptions::console());
                if let Some(metrics) = self.metrics(task) {
                    metrics.error("run", "CRON_WORKER_FAILED");
                }
            }
            TaskExit::Panicked(message) => {
                entry["exit"] = "panicked".into();
                entry["error"] = message.as_str().into();
                self.log.error(&entry, LogOptions::console());
                if let Some(metrics) = self.metrics(task) {
                    metrics.error("run", "CRON_WORKER_PANIC");
                }
            }
            TaskExit::Unstoppable => {
                entry["exit"] = "unstoppable".into();
                self.log.error(&entry, LogOptions::console());
            }
        }
    }

    fn restarting(&self, task: &'static str, restarts: u64, delay: Duration) {
        let mut entry = self.entry(task, "Restarting cron worker");
        entry["restartCount"] = restarts.into();
        entry["delayMs"] = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX).into();
        self.log.warn(&entry, LogOptions::console());
        if let Some(metrics) = self.metrics(task) {
            metrics.restarted();
            metrics.gauge("restart_delay_ms", delay.as_secs_f64() * 1000.0);
        }
    }

    fn stopped(&self, task: &'static str) {
        self.log.info(
            &self.entry(task, "Stopped cron worker"),
            LogOptions::console(),
        );
        if let Some(metrics) = self.metrics(task) {
            metrics.set_state(WorkerState::Stopped);
        }
    }

    fn fatal(&self, task: &'static str) {
        let mut entry = self.entry(
            task,
            "Work of a cron worker did not stop within its grace period; the process exits so the container restarts it",
        );
        entry["code"] = "CRON_WORKER_UNSTOPPABLE".into();
        self.log.error(&entry, LogOptions::console());
        if let Some(metrics) = self.metrics(task) {
            metrics.set_state(WorkerState::Fatal);
        }
    }
}

/// A supervisor with one task per worker, the timing given, and its events reported to
/// `telemetry`. Fails when a worker's declaration is inconsistent (a lease shorter than one unit
/// of work, two workers with one name).
pub fn supervisor(
    workers: Vec<Arc<dyn Worker>>,
    config: SupervisorConfig,
    backoff: Backoff,
    telemetry: &Telemetry,
    leases: Option<LeaseContext>,
) -> Result<Supervisor, String> {
    let mut log = SupervisorLog {
        log: telemetry.clone(),
        workers: HashMap::new(),
    };
    let mut runners = Vec::new();
    for worker in workers {
        let spec = worker.spec();
        if let Lease::Dragonfly(lease) = &spec.lease {
            lease.check(spec.deadline)?;
        }
        let runner = Runner::new(worker, telemetry, leases.clone());
        if log
            .workers
            .insert(runner.name(), runner.metrics().clone())
            .is_some()
        {
            return Err(format!("two workers are named {}", runner.name()));
        }
        runners.push(runner);
    }
    let mut supervisor = Supervisor::new(config)
        .with_backoff(backoff)
        .with_events(Arc::new(log));
    for runner in runners {
        let name = runner.name();
        supervisor.add(name, move |token| {
            let runner = runner.clone();
            let metrics = runner.metrics().clone();
            metrics.instrument(async move { runner.run(token).await })
        });
    }
    Ok(supervisor)
}

/// Waits for `stop` (the signal's name) or a fatal worker, then stops the workers together with
/// `drain` (Twitch's), then runs `flush` (telemetry) with what is left of the time, all inside
/// `budget`. Returns how the process ends.
pub async fn serve<S, D, F, FF>(
    handle: SupervisorHandle,
    stop: S,
    drain: D,
    flush: F,
    budget: Duration,
    log: &Telemetry,
) -> Exit
where
    S: Future<Output = &'static str>,
    D: Future<Output = bool>,
    F: FnOnce(Duration) -> FF,
    FF: Future<Output = bool>,
{
    let fatal: Option<FatalError> = tokio::select! {
        signal = stop => {
            log.info(
                &json!({ "function": "shutdown", "process": "cron", "signal": signal }),
                LogOptions::console(),
            );
            None
        }
        fatal = handle.wait_fatal() => Some(fatal),
    };
    let started = tokio::time::Instant::now();
    let stopping = async move { tokio::join!(handle.stop(), drain) };
    let (report, drained): (Option<SupervisorReport>, bool) =
        match tokio::time::timeout(budget, stopping).await {
            Ok((report, drained)) => (Some(report), drained),
            Err(_) => (None, false),
        };
    let left = budget.saturating_sub(started.elapsed());
    if let Some(report) = &report
        && !report.unstoppable.is_empty()
    {
        log.error(
            &json!({
                "worker": "cron_supervisor",
                "message": "Cron workers did not stop within the stop deadline",
                "names": report.unstoppable,
            }),
            LogOptions::console(),
        );
    }
    let clean = report.as_ref().is_some_and(SupervisorReport::is_clean) && drained;
    log.info(
        &json!({
            "function": "shutdown",
            "process": "cron",
            "step": "stopped",
            "clean": clean,
            "fatal": fatal.as_ref().map(|fatal| fatal.task),
        }),
        LogOptions::console(),
    );
    let flushed = matches!(
        tokio::time::timeout(left, flush(left.min(TELEMETRY_FLUSH))).await,
        Ok(true)
    );
    match fatal {
        Some(fatal) => Exit::Fatal(fatal.task),
        None if clean && flushed => Exit::Clean,
        None => Exit::Unclean,
    }
}
