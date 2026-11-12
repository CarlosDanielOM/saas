//! One unit of work under a deadline, stopped and joined before the caller moves on.
//!
//! This is the single-process replacement for the reference's "kill the worker process when its
//! lease is about to expire" (MIGRATION.md section 6, "Single-process cron"): the work runs as a
//! task; when the deadline passes (or shutdown fires) its token is triggered and the task is
//! aborted, and [`run_with_deadline`] returns only once the task, and any blocking work it started
//! through its [`WorkScope`], has really finished. If that takes longer than the grace period it
//! returns [`DeadlineError::Unstoppable`]: the caller must then exit the process (non-zero), since
//! the work may still be running and nothing else may take it over.
//!
//! Aborting stops async code at its next `.await`. It cannot interrupt code that is running on a
//! thread: a long synchronous stretch inside the task, or blocking work. Blocking work must go
//! through [`WorkScope::spawn_blocking`], so it is waited for, and should check
//! [`WorkScope::token`] to stop early.
//!
//! **If the caller goes away first.** The future [`run_with_deadline`] returns owns the work: when
//! it is dropped before it finished (the worker awaiting it was aborted, or it lost a `select!`),
//! the token fires and the task is aborted. Dropping cannot wait, so the work is also registered,
//! until it has really stopped, in the [`WorkRegistry`] of the [`Shutdown`] passed in (if it
//! carries one); the owner of the worker waits on that registry. The [`Supervisor`] gives each
//! run of each task a token with its own registry and waits on it before restarting the task.
//! Pass that token, or one derived from it such as [`WorkScope::token`], so nested work is
//! registered too.
//!
//! [`Supervisor`]: super::Supervisor

use super::registry::WorkRegistry;
use super::shutdown::Shutdown;
use std::future::Future;
use std::time::Duration;
use tokio::task::{AbortHandle, JoinError};
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

/// The time allowed for a unit of work, and for it to stop afterwards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadline {
    /// How long the work may run.
    pub limit: Duration,
    /// How long it may take to stop once aborted; past this it is reported unstoppable.
    pub grace: Duration,
}

/// What the work gets to cooperate with its deadline.
#[derive(Clone, Debug)]
pub struct WorkScope {
    token: Shutdown,
    tracker: TaskTracker,
}

impl WorkScope {
    /// Fires when the deadline passes or shutdown begins. It carries the caller's registry, so
    /// [`run_with_deadline`] called with it registers nested work with the same owner.
    pub fn token(&self) -> &Shutdown {
        &self.token
    }

    /// Runs blocking code on tokio's blocking pool; [`run_with_deadline`] waits for it before it
    /// reports the work stopped. The closure should check [`WorkScope::token`] to stop early.
    pub fn spawn_blocking<F, R>(&self, f: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let hold = self.token.registry().map(WorkRegistry::hold);
        self.tracker.spawn_blocking(move || {
            let _hold = hold;
            f()
        })
    }
}

/// Why the work did not produce a value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeadlineError {
    /// The deadline passed; the work was aborted and has stopped.
    #[error("work exceeded its deadline and was stopped")]
    TimedOut,
    /// Shutdown began; the work was aborted and has stopped.
    #[error("work was stopped for shutdown")]
    ShutDown,
    /// The work was aborted but did not stop within the grace period. Exit the process. It is
    /// also recorded in the caller's [`WorkRegistry`], so a [`Supervisor`](super::Supervisor)
    /// treats the task as fatal even if the error is swallowed or turned into text.
    #[error("work did not stop within its grace period")]
    Unstoppable,
    /// The work panicked (the panic is contained; the message is kept).
    #[error("work panicked: {0}")]
    Panicked(String),
}

/// The message of a panic, as far as it is text.
pub(crate) fn panic_message(error: JoinError) -> String {
    match error.try_into_panic() {
        Ok(payload) => payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-text panic payload".to_owned()),
        Err(error) => error.to_string(),
    }
}

/// Fires the work's token and aborts its task when dropped, whichever way the caller leaves.
struct StopOnDrop {
    token: Shutdown,
    task: AbortHandle,
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.token.trigger();
        self.task.abort();
    }
}

/// Runs `work` as a task under `deadline`, stopping it on expiry or when `shutdown` fires.
///
/// - Finished in time: its value. Blocking work it left running is told to stop and waited for
///   (up to the grace period; past that, [`DeadlineError::Unstoppable`]).
/// - Panicked: [`DeadlineError::Panicked`].
/// - Deadline or shutdown: the token fires, the task is aborted, and this waits until the task and
///   its blocking work have stopped, then returns [`DeadlineError::TimedOut`] or
///   [`DeadlineError::ShutDown`]; a value produced in that window is discarded. When the work
///   finishes as the deadline passes or shutdown is requested, the deadline or shutdown is
///   reported, never the value.
/// - Shutdown already requested: [`DeadlineError::ShutDown`] at once; `work` is not called.
/// - The returned future dropped first: the token fires and the task is aborted at once; the work
///   stays in `shutdown`'s [`WorkRegistry`] until it has stopped (see the module documentation).
pub async fn run_with_deadline<T, F, Fut>(
    shutdown: &Shutdown,
    deadline: Deadline,
    work: F,
) -> Result<T, DeadlineError>
where
    F: FnOnce(WorkScope) -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    if shutdown.is_triggered() {
        return Err(DeadlineError::ShutDown);
    }
    let started = Instant::now();
    let token = shutdown.child();
    let tracker = TaskTracker::new();
    let scope = WorkScope {
        token: token.clone(),
        tracker: tracker.clone(),
    };
    let hold = shutdown.registry().map(WorkRegistry::hold);
    // `work` is called inside the task, so a panic while building the future is contained too.
    let mut handle = tracker.spawn(async move {
        let _hold = hold;
        work(scope).await
    });
    let stop = StopOnDrop {
        token: token.clone(),
        task: handle.abort_handle(),
    };
    tracker.close();

    let stopped = tokio::select! {
        biased;
        () = tokio::time::sleep(deadline.limit) => Err(DeadlineError::TimedOut),
        () = shutdown.wait() => Err(DeadlineError::ShutDown),
        joined = &mut handle => Ok(joined),
    };
    // The work may have finished just as the deadline passed or shutdown was requested (the
    // timer is only seen once the runtime fires it). Then the deadline or shutdown wins: its
    // owner may already treat the work as abandoned.
    let stopped = match stopped {
        Ok(_) if started.elapsed() >= deadline.limit => Err(DeadlineError::TimedOut),
        Ok(_) if shutdown.is_triggered() => Err(DeadlineError::ShutDown),
        other => other,
    };
    token.trigger();
    if stopped.is_err() {
        stop.task.abort();
    }
    if tokio::time::timeout(deadline.grace, tracker.wait())
        .await
        .is_err()
    {
        if let Some(registry) = shutdown.registry() {
            registry.report_unstoppable();
        }
        return Err(DeadlineError::Unstoppable);
    }
    match stopped? {
        Ok(value) => Ok(value),
        Err(error) if error.is_panic() => Err(DeadlineError::Panicked(panic_message(error))),
        // Only this function aborts the task, and only on the paths above.
        Err(_) => Err(DeadlineError::TimedOut),
    }
    // `stop` drops here: the task has finished, so its abort does nothing.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::time::{Instant, sleep};

    struct SetOnDrop(Arc<AtomicBool>);
    impl Drop for SetOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    const DEADLINE: Deadline = Deadline {
        limit: Duration::from_secs(1),
        grace: Duration::from_millis(100),
    };

    #[tokio::test(start_paused = true)]
    async fn normal_completion_returns_the_value() {
        let result = run_with_deadline(&Shutdown::new(), DEADLINE, |_| async {
            sleep(Duration::from_millis(500)).await;
            42
        })
        .await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test(start_paused = true)]
    async fn cooperative_task_is_stopped_at_the_deadline() {
        let start = Instant::now();
        let saw_token = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&saw_token);
        let result = run_with_deadline(&Shutdown::new(), DEADLINE, move |scope| async move {
            let token = scope.token().clone();
            let _guard = SetOnDrop(flag);
            token.wait().await;
            "stopped"
        })
        .await;
        assert_eq!(result, Err(DeadlineError::TimedOut));
        assert_eq!(start.elapsed(), Duration::from_secs(1));
        assert!(
            saw_token.load(Ordering::SeqCst),
            "the task was dropped before returning"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn task_ignoring_its_token_is_aborted_and_joined() {
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&dropped);
        let result = run_with_deadline(&Shutdown::new(), DEADLINE, move |_| async move {
            let _guard = SetOnDrop(flag);
            loop {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert_eq!(result, Err(DeadlineError::TimedOut));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn aborting_the_caller_aborts_nested_work() {
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&dropped);
        let long = Deadline {
            limit: Duration::from_secs(3600),
            grace: Duration::from_secs(1),
        };
        // A worker awaiting work that itself awaits nested work; the supervisor aborts the worker.
        let worker = tokio::spawn(async move {
            run_with_deadline(&Shutdown::new(), long, move |scope| async move {
                let inner = scope.token().clone();
                run_with_deadline(&inner, long, move |_| async move {
                    let _guard = SetOnDrop(flag);
                    std::future::pending::<()>().await;
                })
                .await
            })
            .await
        });
        sleep(Duration::from_millis(10)).await;
        worker.abort();
        assert!(worker.await.is_err_and(|error| error.is_cancelled()));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(
            dropped.load(Ordering::SeqCst),
            "nested work kept running after its caller was aborted"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_owner_joins_work_left_by_a_dropped_caller() {
        let registry = WorkRegistry::new();
        let root = Shutdown::new().with_registry(&registry);
        let finished = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&finished);
        let long = Deadline {
            limit: Duration::from_secs(3600),
            grace: Duration::from_secs(1),
        };
        let caller = run_with_deadline(&root, long, move |scope| async move {
            run_with_deadline(scope.token(), long, move |scope| async move {
                // Blocking work cannot be aborted; it ignores its token for 300 ms.
                let _ = scope
                    .spawn_blocking(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        flag.store(true, Ordering::SeqCst);
                    })
                    .await;
            })
            .await
        });
        // The caller is dropped while the nested blocking work runs.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), caller)
                .await
                .is_err()
        );
        assert!(registry.running() > 0, "the left-over work is registered");
        assert!(!finished.load(Ordering::SeqCst));
        tokio::time::timeout(Duration::from_secs(5), registry.wait())
            .await
            .unwrap();
        assert!(finished.load(Ordering::SeqCst), "wait returned early");
        assert_eq!(registry.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_stops_the_work() {
        let shutdown = Shutdown::new();
        let trigger = shutdown.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(200)).await;
            trigger.trigger();
        });
        let start = Instant::now();
        let result: Result<(), _> =
            run_with_deadline(&shutdown, DEADLINE, |_| std::future::pending()).await;
        assert_eq!(result, Err(DeadlineError::ShutDown));
        assert_eq!(start.elapsed(), Duration::from_millis(200));
    }

    #[tokio::test(start_paused = true)]
    async fn no_work_starts_after_shutdown() {
        let shutdown = Shutdown::new();
        shutdown.trigger();
        let started = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&started);
        let result = run_with_deadline(&shutdown, DEADLINE, move |_| async move {
            flag.store(true, Ordering::SeqCst);
        })
        .await;
        assert_eq!(result, Err(DeadlineError::ShutDown));
        tokio::task::yield_now().await;
        assert!(!started.load(Ordering::SeqCst), "the work was started");
    }

    #[tokio::test(start_paused = true)]
    async fn completion_after_shutdown_reports_shutdown() {
        let shutdown = Shutdown::new();
        let trigger = shutdown.clone();
        let result = run_with_deadline(&shutdown, DEADLINE, move |_| async move {
            trigger.trigger();
            42
        })
        .await;
        assert_eq!(result, Err(DeadlineError::ShutDown));
    }

    #[tokio::test(start_paused = true)]
    async fn completion_at_the_deadline_reports_the_deadline() {
        let result = run_with_deadline(&Shutdown::new(), DEADLINE, |_| async {
            tokio::time::advance(DEADLINE.limit).await;
            42
        })
        .await;
        assert_eq!(result, Err(DeadlineError::TimedOut));
    }

    #[tokio::test(start_paused = true)]
    async fn panics_are_contained() {
        let result: Result<(), _> =
            run_with_deadline(&Shutdown::new(), DEADLINE, |_| async { panic!("boom") }).await;
        assert_eq!(result, Err(DeadlineError::Panicked("boom".to_owned())));
    }

    /// Blocking work that only looks at its token after 300 ms (real time: tokio's paused clock
    /// does not advance while blocking work runs).
    fn late_blocking_work(scope: &WorkScope) -> tokio::task::JoinHandle<()> {
        let token = scope.token().clone();
        scope.spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(300));
            while !token.is_triggered() {
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_work_that_stops_late_is_waited_for() {
        let start = std::time::Instant::now();
        let deadline = Deadline {
            limit: Duration::from_millis(50),
            grace: Duration::from_secs(5),
        };
        let result = run_with_deadline(&Shutdown::new(), deadline, |scope| async move {
            let _ = late_blocking_work(&scope).await;
        })
        .await;
        assert_eq!(result, Err(DeadlineError::TimedOut));
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "returned before the work stopped"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_work_past_the_grace_period_is_unstoppable() {
        let deadline = Deadline {
            limit: Duration::from_millis(50),
            grace: Duration::from_millis(50),
        };
        let result = run_with_deadline(&Shutdown::new(), deadline, |scope| async move {
            let _ = late_blocking_work(&scope).await;
        })
        .await;
        assert_eq!(result, Err(DeadlineError::Unstoppable));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_task_stuck_in_synchronous_code_is_unstoppable() {
        let deadline = Deadline {
            limit: Duration::from_millis(20),
            grace: Duration::from_millis(50),
        };
        let result = run_with_deadline(&Shutdown::new(), deadline, |_| async {
            // Simulates CPU-bound code that never reaches an await point in time.
            std::thread::sleep(Duration::from_millis(300));
        })
        .await;
        assert_eq!(result, Err(DeadlineError::Unstoppable));
    }
}
