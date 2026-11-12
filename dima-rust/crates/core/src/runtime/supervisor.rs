//! A supervisor for long-running named tasks, as `workers/cron.index.ts` supervises its workers.
//!
//! Each task runs on its own; when one ends (error, panic, or even a normal return, as a worker
//! process exiting with 0 is restarted by the reference), only that task is started again after
//! the restart delay, and its restart count goes up. On shutdown every task's token fires; tasks
//! get [`SupervisorConfig::stop_deadline`] to return, then the stragglers are aborted and get
//! [`SupervisorConfig::stop_grace`] more. A task that still has not stopped (stuck in synchronous
//! code) is reported, so the binary can exit non-zero. No processes are spawned.
//!
//! **Work that will not stop is fatal.** Each run of a task gets a token with its own
//! [`WorkRegistry`]: the work it starts through
//! [`run_with_deadline`](super::run_with_deadline) is registered there until it has really
//! stopped. Before a task is restarted, everything its last run started must have stopped (the
//! supervisor waits up to [`SupervisorConfig::stop_grace`]). When work did not stop (a deadline
//! returned [`DeadlineError::Unstoppable`](super::DeadlineError::Unstoppable), whatever the task
//! did with that error, or left-over work outlived the grace period), the task is **not**
//! restarted, since a new run would overlap work that may still hold its lease: its status
//! becomes [`TaskStatus::Fatal`], [`SupervisorHandle::fatal`] names it, and
//! [`SupervisorHandle::run_until_shutdown`] returns so the binary stops the other tasks and exits
//! non-zero ([`SupervisorReport::is_clean`] is false). This is MIGRATION.md section 6's rule for
//! the single-process cron: the process exits and the container restarts it.
//!
//! **Restart delays.** By default every restart waits [`SupervisorConfig::restart_delay`], as
//! the reference's supervisor does. With [`Supervisor::with_backoff`] the delay doubles on each
//! restart that follows a short run, up to [`Backoff::max`], and falls back to the base delay
//! after a run that lasted [`Backoff::reset_after`]: a task that fails at every start is retried
//! ever more slowly instead of every few seconds for ever, while one that fails once in a while
//! is retried at the base delay. The delays are per task; the other tasks are not affected.
//!
//! **Events.** [`Supervisor::with_events`] reports each start, end, scheduled restart (with its
//! delay), stop and fatal stop to a [`TaskEvents`] sink, so a binary can turn them into logs and
//! metrics.

use super::deadline::panic_message;
use super::registry::WorkRegistry;
use super::shutdown::Shutdown;
use crate::env::read::{finite_max_or, timer_delay_ms};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
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

/// Growing restart delays ([`Supervisor::with_backoff`]).
///
/// The delay before a restart is `restart_delay × 2^n`, at most `max` (and never less than
/// `restart_delay`), where `n` counts the restarts in a row that followed a run shorter than
/// `reset_after`. A run that lasted at least `reset_after` sets `n` back to 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    /// The longest delay.
    pub max: Duration,
    /// How long a run must last to count as healthy.
    pub reset_after: Duration,
}

impl Backoff {
    /// The delay of a restart after `streak` short runs in a row before this one.
    fn delay(&self, base: Duration, streak: u32) -> Duration {
        let factor = 1_u32.checked_shl(streak.min(31)).unwrap_or(u32::MAX);
        base.saturating_mul(factor).min(self.max.max(base))
    }
}

/// What a [`Supervisor`] reports about its tasks ([`Supervisor::with_events`]). Every method is
/// called from the task's supervising future: keep it quick and never block.
pub trait TaskEvents: Send + Sync {
    /// The task starts (`restarts`: how many times it has been restarted before).
    fn started(&self, _task: &'static str, _restarts: u64) {}
    /// A run of the task ended after `ran`, and everything it started has stopped.
    fn ended(&self, _task: &'static str, _exit: &TaskExit, _ran: Duration) {}
    /// The task will start again after `delay` (`restarts`: the count including this one).
    fn restarting(&self, _task: &'static str, _restarts: u64, _delay: Duration) {}
    /// The task stopped for shutdown and will not start again.
    fn stopped(&self, _task: &'static str) {}
    /// Work the task started did not stop: the task will not start again and the process must
    /// exit ([`FatalError`]).
    fn fatal(&self, _task: &'static str) {}
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
    /// Work it started did not stop when told to and may still be running. Fatal: see the
    /// module documentation.
    Unstoppable,
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
    /// Not restarted because work it started would not stop. The process must exit.
    Fatal,
}

/// A task that may not run again because work it started did not stop and may still be running.
/// The binary must exit non-zero; the container restarts the process (MIGRATION.md section 6).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("task {task}: work it started did not stop within its grace period; exiting")]
pub struct FatalError {
    /// The task's name.
    pub task: &'static str,
}

/// The first fatal task, and a signal for those waiting on it.
#[derive(Debug, Default)]
struct FatalState {
    first: Mutex<Option<FatalError>>,
    signal: CancellationToken,
}

impl FatalState {
    fn report(&self, task: &'static str) {
        self.first
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert(FatalError { task });
        self.signal.cancel();
    }

    fn get(&self) -> Option<FatalError> {
        self.first
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
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
    backoff: Option<Backoff>,
    events: Option<Arc<dyn TaskEvents>>,
    entries: Vec<Entry>,
}

impl fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<_> = self.entries.iter().map(|entry| entry.name).collect();
        f.debug_struct("Supervisor")
            .field("config", &self.config)
            .field("backoff", &self.backoff)
            .field("events", &self.events.is_some())
            .field("tasks", &names)
            .finish()
    }
}

/// What every supervising future of one supervisor shares.
#[derive(Clone)]
struct Policy {
    config: SupervisorConfig,
    backoff: Option<Backoff>,
    events: Option<Arc<dyn TaskEvents>>,
}

impl Policy {
    fn emit(&self, event: impl FnOnce(&dyn TaskEvents)) {
        if let Some(events) = &self.events {
            event(events.as_ref());
        }
    }
}

impl Supervisor {
    /// An empty supervisor with the given timing.
    pub fn new(config: SupervisorConfig) -> Self {
        Self {
            config,
            backoff: None,
            events: None,
            entries: Vec::new(),
        }
    }

    /// Restart delays that grow while a task keeps failing soon after it starts (see
    /// [`Backoff`]); without this every restart waits [`SupervisorConfig::restart_delay`].
    #[must_use]
    pub fn with_backoff(mut self, backoff: Backoff) -> Self {
        self.backoff = Some(backoff);
        self
    }

    /// Reports every start, end, restart, stop and fatal stop to `events`.
    #[must_use]
    pub fn with_events(mut self, events: Arc<dyn TaskEvents>) -> Self {
        self.events = Some(events);
        self
    }

    /// Adds a task. `task` is called for every (re)start with a token that fires on shutdown; the
    /// task should return when it fires. Pass that token (or one derived from it) to
    /// [`run_with_deadline`](super::run_with_deadline), so the work is registered with this run.
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
        let fatal = Arc::new(FatalState::default());
        let policy = Policy {
            config: self.config,
            backoff: self.backoff,
            events: self.events,
        };
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
                policy.clone(),
                Arc::clone(&fatal),
            ));
            slots.push(slot);
        }
        tracker.close();
        SupervisorHandle {
            config: self.config,
            token,
            tracker,
            slots,
            fatal,
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

async fn supervise(
    factory: TaskFactory,
    token: Shutdown,
    slot: Arc<Slot>,
    policy: Policy,
    fatal: Arc<FatalState>,
) {
    let config = policy.config;
    let name = slot.snapshot().name;
    // Restarts in a row that followed a short run (see `Backoff`).
    let mut streak: u32 = 0;
    loop {
        if token.is_triggered() {
            slot.update(|state| state.status = TaskStatus::Stopped);
            policy.emit(|events| events.stopped(name));
            return;
        }
        slot.update(|state| state.status = TaskStatus::Running);
        policy.emit(|events| events.started(name, slot.snapshot().restarts));
        let started = tokio::time::Instant::now();
        // Everything this run starts through `run_with_deadline` is registered here, and so is
        // the run itself.
        let registry = WorkRegistry::new();
        let (build, child) = (Arc::clone(&factory), token.with_registry(&registry));
        let hold = registry.hold();
        // The factory runs inside the task, so a panic while building the future is a task panic.
        let mut handle = tokio::spawn(async move {
            let _hold = hold;
            build(child).await
        });
        slot.set_current(Some(handle.abort_handle()));
        let exit = tokio::select! {
            biased;
            joined = &mut handle => Some(match joined {
                Ok(Ok(())) => TaskExit::Finished,
                Ok(Err(error)) => TaskExit::Failed(error),
                Err(error) if error.is_panic() => TaskExit::Panicked(panic_message(error)),
                Err(_) => TaskExit::Aborted,
            }),
            // The task carries on after its work proved unstoppable: stop it now.
            () = registry.unstoppable() => None,
        };
        if exit.is_none() {
            handle.abort();
        }
        // Nothing may start again until everything this run started has stopped.
        let stopped = !registry.is_unstoppable()
            && tokio::time::timeout(config.stop_grace, registry.wait())
                .await
                .is_ok();
        slot.set_current(None);
        let ran = started.elapsed();
        let exit = match exit {
            Some(exit) if stopped => exit,
            _ => {
                slot.update(|state| {
                    state.last_exit = Some(TaskExit::Unstoppable);
                    state.status = TaskStatus::Fatal;
                });
                fatal.report(name);
                policy.emit(|events| events.ended(name, &TaskExit::Unstoppable, ran));
                policy.emit(|events| events.fatal(name));
                return;
            }
        };
        policy.emit(|events| events.ended(name, &exit, ran));
        slot.update(|state| state.last_exit = Some(exit));
        if token.is_triggered() {
            slot.update(|state| state.status = TaskStatus::Stopped);
            policy.emit(|events| events.stopped(name));
            return;
        }
        let delay = match policy.backoff {
            None => config.restart_delay,
            Some(backoff) => {
                if ran >= backoff.reset_after {
                    streak = 0;
                }
                let delay = backoff.delay(config.restart_delay, streak);
                streak = streak.saturating_add(1);
                delay
            }
        };
        slot.update(|state| {
            state.restarts += 1;
            state.status = TaskStatus::Restarting;
        });
        policy.emit(|events| events.restarting(name, slot.snapshot().restarts, delay));
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
    fatal: Arc<FatalState>,
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
    /// Tasks that had not stopped after the deadline and the grace period, and fatal tasks
    /// (whose work may still be running). Exit non-zero.
    pub unstoppable: Vec<&'static str>,
    /// The first task that became fatal, if any. Exit non-zero.
    pub fatal: Option<FatalError>,
}

impl SupervisorReport {
    /// Whether every task stopped and none was fatal. When false, the binary exits non-zero.
    pub fn is_clean(&self) -> bool {
        self.unstoppable.is_empty() && self.fatal.is_none()
    }
}

impl SupervisorHandle {
    /// Every task's current state, in the order they were added.
    pub fn snapshot(&self) -> Vec<TaskState> {
        self.slots.iter().map(|slot| slot.snapshot()).collect()
    }

    /// The first task that became fatal, if any.
    pub fn fatal(&self) -> Option<FatalError> {
        self.fatal.get()
    }

    /// Resolves once a task becomes fatal (never, if none does).
    pub async fn wait_fatal(&self) -> FatalError {
        loop {
            self.fatal.signal.cancelled().await;
            if let Some(fatal) = self.fatal.get() {
                return fatal;
            }
        }
    }

    /// Waits until shutdown fires or a task becomes fatal, then stops every task (see
    /// [`SupervisorHandle::stop`]). Exit non-zero unless the report [is clean](SupervisorReport::is_clean).
    pub async fn run_until_shutdown(self) -> SupervisorReport {
        tokio::select! {
            () = self.token.wait() => {}
            _ = self.wait_fatal() => {}
        }
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
        SupervisorReport {
            tasks,
            unstoppable,
            fatal: self.fatal.get(),
        }
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

    /// Every event, in order, as text.
    #[derive(Default)]
    struct Recorded(std::sync::Mutex<Vec<String>>);

    impl Recorded {
        fn push(&self, line: String) {
            self.0.lock().unwrap().push(line);
        }
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    impl TaskEvents for Recorded {
        fn started(&self, task: &'static str, restarts: u64) {
            self.push(format!("{task} started {restarts}"));
        }
        fn ended(&self, task: &'static str, exit: &TaskExit, ran: Duration) {
            self.push(format!("{task} ended {exit:?} after {}ms", ran.as_millis()));
        }
        fn restarting(&self, task: &'static str, restarts: u64, delay: Duration) {
            self.push(format!(
                "{task} restart {restarts} in {}ms",
                delay.as_millis()
            ));
        }
        fn stopped(&self, task: &'static str) {
            self.push(format!("{task} stopped"));
        }
        fn fatal(&self, task: &'static str) {
            self.push(format!("{task} fatal"));
        }
    }

    #[test]
    fn backoff_doubles_from_the_base_and_stops_at_its_cap() {
        let backoff = Backoff {
            max: Duration::from_secs(60),
            reset_after: Duration::from_secs(60),
        };
        let base = Duration::from_secs(5);
        let delays: Vec<u64> = (0..8)
            .map(|streak| backoff.delay(base, streak).as_secs())
            .collect();
        assert_eq!(delays, vec![5, 10, 20, 40, 60, 60, 60, 60]);
        assert_eq!(backoff.delay(base, u32::MAX), Duration::from_secs(60));
        // A cap below the base never shortens the base delay.
        let tight = Backoff {
            max: Duration::from_secs(1),
            reset_after: Duration::ZERO,
        };
        assert_eq!(tight.delay(base, 3), base);
    }

    #[tokio::test(start_paused = true)]
    async fn a_task_failing_at_every_start_backs_off_to_the_cap_alone() {
        let events = Arc::new(Recorded::default());
        let (healthy_starts, healthy_seen) = counter();
        let mut supervisor = Supervisor::new(config())
            .with_backoff(Backoff {
                max: Duration::from_secs(8),
                reset_after: Duration::from_secs(30),
            })
            .with_events(events.clone());
        supervisor.add("broken", |_| async { Err::<(), _>("no store") });
        supervisor.add("healthy", move |token: Shutdown| {
            healthy_starts.fetch_add(1, Ordering::SeqCst);
            async move {
                token.wait().await;
                Ok::<(), String>(())
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        // Delays 1, 2, 4, 8, 8 s: the sixth start happens at 23 s.
        sleep(Duration::from_millis(23_500)).await;
        let restarts: Vec<String> = events
            .lines()
            .into_iter()
            .filter(|line| line.starts_with("broken restart"))
            .collect();
        assert_eq!(
            restarts,
            vec![
                "broken restart 1 in 1000ms",
                "broken restart 2 in 2000ms",
                "broken restart 3 in 4000ms",
                "broken restart 4 in 8000ms",
                "broken restart 5 in 8000ms",
                "broken restart 6 in 8000ms",
            ]
        );
        let states = handle.snapshot();
        assert_eq!(states[0].restarts, 6);
        assert_eq!(
            states[0].last_exit,
            Some(TaskExit::Failed("no store".to_owned()))
        );
        assert_eq!(states[1].status, TaskStatus::Running);
        assert_eq!(states[1].restarts, 0);
        assert_eq!(healthy_seen.load(Ordering::SeqCst), 1);
        assert!(handle.stop().await.is_clean());
        let lines = events.lines();
        assert!(lines.contains(&"broken stopped".to_owned()), "{lines:?}");
        assert!(lines.contains(&"healthy stopped".to_owned()), "{lines:?}");
        assert!(lines.contains(&"healthy started 0".to_owned()), "{lines:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_healthy_run_resets_the_backoff() {
        let events = Arc::new(Recorded::default());
        let (runs, _) = counter();
        let mut supervisor = Supervisor::new(config())
            .with_backoff(Backoff {
                max: Duration::from_secs(8),
                reset_after: Duration::from_secs(30),
            })
            .with_events(events.clone());
        supervisor.add("flaky", move |_| {
            let run = runs.fetch_add(1, Ordering::SeqCst);
            async move {
                // Runs 0, 1, 2 fail at once; run 3 lasts a minute, then fails.
                if run == 3 {
                    sleep(Duration::from_secs(60)).await;
                }
                Err::<(), _>("lost")
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        // 1 + 2 + 4 s of delays, then 60 s of run 3, then the delay after it.
        sleep(Duration::from_millis(67_500)).await;
        let restarts: Vec<String> = events
            .lines()
            .into_iter()
            .filter(|line| line.starts_with("flaky restart"))
            .collect();
        assert_eq!(
            restarts,
            vec![
                "flaky restart 1 in 1000ms",
                "flaky restart 2 in 2000ms",
                "flaky restart 3 in 4000ms",
                "flaky restart 4 in 1000ms",
            ]
        );
        assert!(
            events
                .lines()
                .contains(&"flaky ended Failed(\"lost\") after 60000ms".to_owned())
        );
        handle.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fatal_task_is_reported_to_the_events() {
        let events = Arc::new(Recorded::default());
        let mut supervisor = Supervisor::new(SupervisorConfig {
            restart_delay: Duration::from_millis(10),
            stop_deadline: Duration::from_secs(1),
            stop_grace: Duration::from_millis(50),
        })
        .with_events(events.clone());
        supervisor.add("stuck", |token: Shutdown| async move {
            stubborn_work(&token, 10, 10, 300).await;
            Err::<(), _>("work did not stop".to_owned())
        });
        let handle = supervisor.start(&Shutdown::new());
        let report = tokio::time::timeout(Duration::from_secs(5), handle.run_until_shutdown())
            .await
            .unwrap();
        assert!(!report.is_clean());
        let lines = events.lines();
        assert_eq!(lines.first().map(String::as_str), Some("stuck started 0"));
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("stuck ended Unstoppable")),
            "{lines:?}"
        );
        assert_eq!(lines.last().map(String::as_str), Some("stuck fatal"));
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
    async fn a_panicking_factory_is_a_task_panic() {
        let (builds, seen) = counter();
        let mut supervisor = Supervisor::new(config());
        supervisor.add("factory", move |token: Shutdown| {
            assert!(
                builds.fetch_add(1, Ordering::SeqCst) > 0,
                "first build fails"
            );
            async move {
                token.wait().await;
                Ok::<(), String>(())
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        sleep(Duration::from_millis(1500)).await;
        let state = &handle.snapshot()[0];
        assert_eq!(seen.load(Ordering::SeqCst), 2);
        assert_eq!(state.status, TaskStatus::Running);
        assert_eq!(state.restarts, 1);
        assert_eq!(
            state.last_exit,
            Some(TaskExit::Panicked("first build fails".to_owned()))
        );
        assert!(handle.stop().await.unstoppable.is_empty());
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

    /// Blocking work under `run_with_deadline` that ignores its token for `ms` milliseconds.
    async fn stubborn_work(token: &Shutdown, limit_ms: u64, grace_ms: u64, ms: u64) {
        let deadline = crate::runtime::Deadline {
            limit: Duration::from_millis(limit_ms),
            grace: Duration::from_millis(grace_ms),
        };
        let result = crate::runtime::run_with_deadline(token, deadline, move |scope| async move {
            let _ = scope
                .spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
                .await;
        })
        .await;
        assert_eq!(result, Err(crate::runtime::DeadlineError::Unstoppable));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unstoppable_work_is_fatal_and_not_restarted() {
        let (starts, seen) = counter();
        let mut supervisor = Supervisor::new(SupervisorConfig {
            restart_delay: Duration::from_millis(10),
            stop_deadline: Duration::from_secs(1),
            stop_grace: Duration::from_millis(50),
        });
        supervisor.add("lease-worker", move |token: Shutdown| {
            starts.fetch_add(1, Ordering::SeqCst);
            async move {
                stubborn_work(&token, 10, 10, 400).await;
                // The worker flattens the error to text, as most workers will.
                Err::<(), _>("work did not stop".to_owned())
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        let fatal = tokio::time::timeout(Duration::from_secs(5), handle.wait_fatal())
            .await
            .unwrap();
        assert_eq!(fatal.task, "lease-worker");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "restarted over the survivor"
        );
        let state = &handle.snapshot()[0];
        assert_eq!(state.restarts, 0);
        assert_eq!(state.status, TaskStatus::Fatal);
        assert_eq!(state.last_exit, Some(TaskExit::Unstoppable));
        // The binary's loop: returns on the fatal task without any shutdown signal.
        let report = tokio::time::timeout(Duration::from_secs(5), handle.run_until_shutdown())
            .await
            .unwrap();
        assert!(!report.is_clean());
        assert_eq!(report.fatal, Some(fatal));
        assert_eq!(report.unstoppable, vec!["lease-worker"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_task_that_swallows_unstoppable_is_stopped_and_fatal() {
        let mut supervisor = Supervisor::new(SupervisorConfig {
            restart_delay: Duration::from_millis(10),
            stop_deadline: Duration::from_secs(1),
            stop_grace: Duration::from_millis(50),
        });
        supervisor.add("carries-on", |token: Shutdown| async move {
            stubborn_work(&token, 10, 10, 300).await;
            // Ignores the error and keeps going, never returning.
            std::future::pending::<Result<(), String>>().await
        });
        supervisor.add("healthy", |token: Shutdown| async move {
            token.wait().await;
            Ok::<(), String>(())
        });
        let handle = supervisor.start(&Shutdown::new());
        let report = tokio::time::timeout(Duration::from_secs(5), handle.run_until_shutdown())
            .await
            .unwrap();
        assert_eq!(report.fatal.map(|fatal| fatal.task), Some("carries-on"));
        assert_eq!(report.tasks[0].status, TaskStatus::Fatal);
        assert_eq!(report.tasks[1].status, TaskStatus::Stopped);
        assert_eq!(report.unstoppable, vec!["carries-on"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_restart_waits_for_work_left_by_the_previous_run() {
        let running = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let overlapped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (starts, seen) = counter();
        let mut supervisor = Supervisor::new(SupervisorConfig {
            restart_delay: Duration::from_millis(10),
            stop_deadline: Duration::from_secs(1),
            stop_grace: Duration::from_secs(2),
        });
        let (flag, overlap) = (Arc::clone(&running), Arc::clone(&overlapped));
        supervisor.add("worker", move |token: Shutdown| {
            if flag.load(Ordering::SeqCst) {
                overlap.store(true, Ordering::SeqCst);
            }
            let run = starts.fetch_add(1, Ordering::SeqCst);
            let flag = Arc::clone(&flag);
            async move {
                if run > 0 {
                    token.wait().await;
                    return Ok(());
                }
                let deadline = crate::runtime::Deadline {
                    limit: Duration::from_secs(60),
                    grace: Duration::from_secs(1),
                };
                let work =
                    crate::runtime::run_with_deadline(&token, deadline, move |scope| async move {
                        let _ = scope
                            .spawn_blocking(move || {
                                flag.store(true, Ordering::SeqCst);
                                std::thread::sleep(Duration::from_millis(200));
                                flag.store(false, Ordering::SeqCst);
                            })
                            .await;
                    });
                // The worker gives up on the work early (it loses a select) and fails.
                let _ = tokio::time::timeout(Duration::from_millis(20), work).await;
                Err::<(), _>("gave up".to_owned())
            }
        });
        let handle = supervisor.start(&Shutdown::new());
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(seen.load(Ordering::SeqCst), 2);
        assert!(
            !overlapped.load(Ordering::SeqCst),
            "restarted while the previous run's work was still running"
        );
        assert_eq!(handle.snapshot()[0].restarts, 1);
        assert!(handle.stop().await.is_clean());
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
