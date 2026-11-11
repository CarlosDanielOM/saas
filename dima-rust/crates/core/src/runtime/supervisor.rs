//! A supervisor for long-running named tasks, as `workers/cron.index.ts` supervises its workers.
//!
//! Each task runs on its own; when one ends (error, panic, or even a normal return, as a worker
//! process exiting with 0 is restarted by the reference), only that task is started again after
//! the restart delay, and its restart count goes up. On shutdown every task's token fires; tasks
//! get [`SupervisorConfig::stop_deadline`] to return, then the stragglers are aborted and get
//! [`SupervisorConfig::stop_grace`] more. A task that still has not stopped (stuck in synchronous
//! code) is reported, so the binary can exit non-zero. No processes are spawned.

use super::deadline::panic_message;
use super::shutdown::Shutdown;
use crate::env::read::{finite_max_or, timer_delay_ms};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::task::AbortHandle;
use tokio_util::task::TaskTracker;

/// The reference's default restart delay (`CRON_WORKER_RESTART_DELAY_MS`), in milliseconds.
pub const RESTART_DELAY_DEFAULT_MS: f64 = 5000.0;
/// The reference's minimum restart delay, in milliseconds.
pub const RESTART_DELAY_MIN_MS: f64 = 1000.0;

/// `CRON_WORKER_RESTART_DELAY_MS` as `resolveSupervisorConfig` reads it:
/// `n = Number(x || 5000); Number.isFinite(n) ? Math.max(1000, n) : 5000`, then used as a Node
/// timer delay (so a value above 2147483647 ms becomes 1 ms, as Node coerces it).
pub fn restart_delay_from_env(raw: Option<&str>) -> Duration {
    let ms = timer_delay_ms(finite_max_or(
        raw,
        RESTART_DELAY_MIN_MS,
        RESTART_DELAY_DEFAULT_MS,
    ));
    Duration::from_secs_f64(ms / 1000.0)
}

/// Timing of a [`Supervisor`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupervisorConfig {
    /// Wait before restarting a task that ended (reference default 5 s).
    pub restart_delay: Duration,
    /// Time the tasks get to return after shutdown before they are aborted (the reference gives
    /// worker processes 25 s before SIGKILL).
    pub stop_deadline: Duration,
    /// Time aborted tasks get to stop before they are reported unstoppable.
    pub stop_grace: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            restart_delay: Duration::from_millis(5000),
            stop_deadline: Duration::from_secs(25),
            stop_grace: Duration::from_secs(2),
        }
    }
}

/// How a task's last run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskExit {
    /// It returned `Ok(())`.
    Finished,
    /// It returned an error (its text).
    Failed(String),
    /// It panicked (the panic message).
    Panicked(String),
    /// It was aborted at shutdown after the stop deadline.
    Aborted,
}

/// Where a task is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    /// Running now.
    Running,
    /// Ended; waiting for the restart delay.
    Restarting,
    /// Stopped for shutdown.
    Stopped,
}

/// A task's state, for health reporting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskState {
    /// The task's name.
    pub name: &'static str,
    /// Where it is now.
    pub status: TaskStatus,
    /// How many times it has been scheduled for a restart.
    pub restarts: u64,
    /// How its last run ended, if it has ended.
    pub last_exit: Option<TaskExit>,
}

type TaskFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type TaskFactory = Arc<dyn Fn(Shutdown) -> TaskFuture + Send + Sync>;

struct Entry {
    name: &'static str,
    factory: TaskFactory,
}

/// Long-running named tasks to supervise. Add them, then [`Supervisor::start`].
#[derive(Default)]
pub struct Supervisor {
    config: SupervisorConfig,
    entries: Vec<Entry>,
}

impl fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<_> = self.entries.iter().map(|entry| entry.name).collect();
        f.debug_struct("Supervisor")
            .field("config", &self.config)
            .field("tasks", &names)
            .finish()
    }
}

impl Supervisor {
    /// An empty supervisor with the given timing.
    pub fn new(config: SupervisorConfig) -> Self {
        Self {
            config,
            entries: Vec::new(),
        }
    }

    /// Adds a task. `task` is called for every (re)start with a token that fires on shutdown; the
    /// task should return when it fires.
    pub fn add<F, Fut, E>(&mut self, name: &'static str, task: F)
    where
        F: Fn(Shutdown) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
        E: fmt::Display,
    {
        let factory: TaskFactory = Arc::new(move |token| {
            let run = task(token);
            Box::pin(async move { run.await.map_err(|error| error.to_string()) })
        });
        self.entries.push(Entry { name, factory });
    }

    /// Starts every task. The supervisor stops when `shutdown` fires or [`SupervisorHandle::stop`]
    /// is called; either way call `stop` to wait for the tasks and get the report.
    pub fn start(self, shutdown: &Shutdown) -> SupervisorHandle {
        let token = shutdown.child();
        let tracker = TaskTracker::new();
        let mut slots = Vec::new();
        for entry in self.entries {
            let slot = Arc::new(Slot {
                state: Mutex::new(TaskState {
                    name: entry.name,
                    status: TaskStatus::Running,
                    restarts: 0,
                    last_exit: None,
                }),
                current: Mutex::new(None),
            });
            tracker.spawn(supervise(
                entry.factory,
                token.clone(),
                Arc::clone(&slot),
                self.config.restart_delay,
            ));
            slots.push(slot);
        }
        tracker.close();
        SupervisorHandle {
            config: self.config,
            token,
            tracker,
            slots,
        }
    }
}

struct Slot {
    state: Mutex<TaskState>,
    current: Mutex<Option<AbortHandle>>,
}

impl Slot {
    fn update(&self, change: impl FnOnce(&mut TaskState)) {
        change(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner));
    }

    fn snapshot(&self) -> TaskState {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set_current(&self, handle: Option<AbortHandle>) {
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = handle;
    }

    fn abort(&self) {
        if let Some(handle) = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            handle.abort();
        }
    }
}

async fn supervise(factory: TaskFactory, token: Shutdown, slot: Arc<Slot>, delay: Duration) {
    loop {
        if token.is_triggered() {
            slot.update(|state| state.status = TaskStatus::Stopped);
            return;
        }
        slot.update(|state| state.status = TaskStatus::Running);
        let handle = tokio::spawn(factory(token.clone()));
        slot.set_current(Some(handle.abort_handle()));
        let exit = match handle.await {
            Ok(Ok(())) => TaskExit::Finished,
            Ok(Err(error)) => TaskExit::Failed(error),
            Err(error) if error.is_panic() => TaskExit::Panicked(panic_message(error)),
            Err(_) => TaskExit::Aborted,
        };
        slot.set_current(None);
        slot.update(|state| state.last_exit = Some(exit));
        if token.is_triggered() {
            slot.update(|state| state.status = TaskStatus::Stopped);
            return;
        }
        slot.update(|state| {
            state.restarts += 1;
            state.status = TaskStatus::Restarting;
        });
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = token.wait() => {}
        }
    }
}

/// A running supervisor.
pub struct SupervisorHandle {
    config: SupervisorConfig,
    token: Shutdown,
    tracker: TaskTracker,
    slots: Vec<Arc<Slot>>,
}

impl fmt::Debug for SupervisorHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SupervisorHandle")
            .field("tasks", &self.snapshot())
            .finish()
    }
}

/// The outcome of [`SupervisorHandle::stop`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupervisorReport {
    /// Every task's final state.
    pub tasks: Vec<TaskState>,
    /// Tasks that had not stopped after the deadline and the grace period. Exit non-zero.
    pub unstoppable: Vec<&'static str>,
}

impl SupervisorHandle {
    /// Every task's current state, in the order they were added.
    pub fn snapshot(&self) -> Vec<TaskState> {
        self.slots.iter().map(|slot| slot.snapshot()).collect()
    }

    /// Waits until shutdown fires, then stops (see [`SupervisorHandle::stop`]).
    pub async fn run_until_shutdown(self) -> SupervisorReport {
        self.token.wait().await;
        self.stop().await
    }

    /// Stops every task: fire the token, wait up to the stop deadline, abort what is left, wait
    /// up to the grace period, and report.
    pub async fn stop(self) -> SupervisorReport {
        self.token.trigger();
        if tokio::time::timeout(self.config.stop_deadline, self.tracker.wait())
            .await
            .is_err()
        {
            for slot in &self.slots {
                slot.abort();
            }
            // Ignored on purpose: what is still running is listed below.
            let _ = tokio::time::timeout(self.config.stop_grace, self.tracker.wait()).await;
        }
        let tasks = self.snapshot();
        let unstoppable = tasks
            .iter()
            .filter(|task| task.status != TaskStatus::Stopped)
            .map(|task| task.name)
            .collect();
        SupervisorReport { tasks, unstoppable }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::time::{Instant, sleep};

    fn config() -> SupervisorConfig {
        SupervisorConfig {
            restart_delay: Duration::from_secs(1),
            stop_deadline: Duration::from_secs(10),
            stop_grace: Duration::from_millis(100),
        }
    }

    fn counter() -> (Arc<AtomicU64>, Arc<AtomicU64>) {
        let count = Arc::new(AtomicU64::new(0));
        (Arc::clone(&count), count)
    }

    #[test]
    fn restart_delay_reads_like_the_reference() {
        assert_eq!(restart_delay_from_env(None), Duration::from_millis(5000));
        assert_eq!(
            restart_delay_from_env(Some("")),
            Duration::from_millis(5000)
        );
        assert_eq!(
            restart_delay_from_env(Some("abc")),
            Duration::from_millis(5000)
        );
        assert_eq!(
            restart_delay_from_env(Some("10")),
            Duration::from_millis(1000)
        );
        assert_eq!(
            restart_delay_from_env(Some("2500")),
            Duration::from_millis(2500)
        );
        assert_eq!(
            restart_delay_from_env(Some("1e10")),
            Duration::from_millis(1)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn only_the_failing_task_restarts_and_restarts_are_counted() {
        let (healthy_starts, healthy_seen) = counter();
        let (failing_starts, failing_seen) = counter();
        let mut supervisor = Supervisor::new(config());
        supervisor.add("healthy", move |token: Shutdown| {
            healthy_starts.fetch_add(1, Ordering::SeqCst);
            async move {
                token.wait().await;
                Ok::<(), String>(())
            }
        });
        supervisor.add("failing", move |_| {
            failing_starts.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>("lost connection") }
        });
        let handle = supervisor.start(&Shutdown::new());
        sleep(Duration::from_millis(3500)).await;
        let states = handle.snapshot();
        assert_eq!(healthy_seen.load(Ordering::SeqCst), 1);
        assert_eq!(failing_seen.load(Ordering::SeqCst), 4);
        assert_eq!(states[0].status, TaskStatus::Running);
        assert_eq!(states[0].restarts, 0);
        assert_eq!(states[1].status, TaskStatus::Restarting);
        assert_eq!(states[1].restarts, 4);
        assert_eq!(
            states[1].last_exit,
            Some(TaskExit::Failed("lost connection".to_owned()))
        );
        let report = handle.stop().await;
        assert!(report.unstoppable.is_empty());
        assert!(
            report
                .tasks
                .iter()
                .all(|task| task.status == TaskStatus::Stopped)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn panics_and_normal_returns_restart_too() {
        let (runs, seen) = counter();
        let mut supervisor = Supervisor::new(config());
        supervisor.add("flaky", move |_| {
            let run = runs.fetch_add(1, Ordering::SeqCst);
            async move {
                if run == 0 {
                    panic!("boom");
                }
                Ok::<(), String>(())
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        sleep(Duration::from_millis(500)).await;
        assert_eq!(
            handle.snapshot()[0].last_exit,
            Some(TaskExit::Panicked("boom".to_owned()))
        );
        sleep(Duration::from_secs(1)).await;
        assert_eq!(seen.load(Ordering::SeqCst), 2);
        assert_eq!(handle.snapshot()[0].last_exit, Some(TaskExit::Finished));
        assert_eq!(handle.snapshot()[0].restarts, 2);
        handle.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_waits_for_cooperative_tasks_then_aborts_the_rest() {
        let shutdown = Shutdown::new();
        let mut supervisor = Supervisor::new(config());
        supervisor.add("cooperative", |token: Shutdown| async move {
            token.wait().await;
            sleep(Duration::from_secs(2)).await; // a short drain
            Ok::<(), String>(())
        });
        supervisor.add("stubborn", |_| async {
            // Ignores its token entirely.
            let mut ticks = 0_u64;
            while ticks < u64::MAX {
                sleep(Duration::from_millis(100)).await;
                ticks += 1;
            }
            Ok::<(), String>(())
        });
        let handle = supervisor.start(&shutdown);
        sleep(Duration::from_secs(1)).await;
        shutdown.trigger();
        let start = Instant::now();
        let report = handle.run_until_shutdown().await;
        assert_eq!(start.elapsed(), Duration::from_secs(10));
        assert!(report.unstoppable.is_empty());
        assert_eq!(report.tasks[0].last_exit, Some(TaskExit::Finished));
        assert_eq!(report.tasks[1].last_exit, Some(TaskExit::Aborted));
        assert!(report.tasks.iter().all(|task| task.restarts == 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_task_stuck_in_synchronous_code_is_reported() {
        let mut supervisor = Supervisor::new(SupervisorConfig {
            restart_delay: Duration::from_secs(1),
            stop_deadline: Duration::from_millis(30),
            stop_grace: Duration::from_millis(30),
        });
        supervisor.add("stuck", |token: Shutdown| async move {
            token.wait().await;
            std::thread::sleep(Duration::from_millis(400));
            Ok::<(), String>(())
        });
        supervisor.add("fine", |token: Shutdown| async move {
            token.wait().await;
            Ok::<(), String>(())
        });
        let handle = supervisor.start(&Shutdown::new());
        tokio::time::sleep(Duration::from_millis(20)).await;
        let report = handle.stop().await;
        assert_eq!(report.unstoppable, vec!["stuck"]);
    }
}
