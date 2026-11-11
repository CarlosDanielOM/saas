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

use super::shutdown::Shutdown;
use std::future::Future;
use std::time::Duration;
use tokio::task::JoinError;
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
    /// Fires when the deadline passes or shutdown begins.
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
        self.tracker.spawn_blocking(f)
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
    /// The work was aborted but did not stop within the grace period. Exit the process.
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

/// Runs `work` as a task under `deadline`, stopping it on expiry or when `shutdown` fires.
///
/// - Finished in time: its value. Blocking work it left running is told to stop and waited for
///   (up to the grace period; past that, [`DeadlineError::Unstoppable`]).
/// - Panicked: [`DeadlineError::Panicked`].
/// - Deadline or shutdown: the token fires, the task is aborted, and this waits until the task and
///   its blocking work have stopped, then returns [`DeadlineError::TimedOut`] or
///   [`DeadlineError::ShutDown`]; a value produced in that window is discarded.
pub async fn run_with_deadline<T, F, Fut>(
    shutdown: &Shutdown,
    deadline: Deadline,
    work: F,
) -> Result<T, DeadlineError>
where
    F: FnOnce(WorkScope) -> Fut,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let token = shutdown.child();
    let tracker = TaskTracker::new();
    let scope = WorkScope {
        token: token.clone(),
        tracker: tracker.clone(),
    };
    let mut handle = tracker.spawn(work(scope));
    let abort = handle.abort_handle();
    tracker.close();

    let stopped = tokio::select! {
        biased;
        joined = &mut handle => Ok(joined),
        () = tokio::time::sleep(deadline.limit) => Err(DeadlineError::TimedOut),
        () = shutdown.wait() => Err(DeadlineError::ShutDown),
    };
    token.trigger();
    if stopped.is_err() {
        abort.abort();
    }
    if tokio::time::timeout(deadline.grace, tracker.wait())
        .await
        .is_err()
    {
        return Err(DeadlineError::Unstoppable);
    }
    match stopped? {
        Ok(value) => Ok(value),
        Err(error) if error.is_panic() => Err(DeadlineError::Panicked(panic_message(error))),
        // Only this function aborts the task, and only on the paths above.
        Err(_) => Err(DeadlineError::TimedOut),
    }
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
