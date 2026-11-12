//! The register of work a worker has started, so that whoever owns the worker can wait until that
//! work has really stopped.
//!
//! [`run_with_deadline`](super::run_with_deadline) aborts its work when the caller's future is
//! dropped, but aborting is a request: an aborted task stops at its next `.await`, and blocking
//! work stops when it next checks its token. Neither may still be running when the owner moves on
//! (restarts the worker, hands its lease to someone else). So every task and every piece of
//! blocking work that `run_with_deadline` starts holds an entry in the registry carried by the
//! [`Shutdown`](super::Shutdown) it was given, until it has finished. The owner (the
//! [`Supervisor`](super::Supervisor) for each run of a worker) waits on the registry, which does
//! not live inside any future that can be cancelled.
//!
//! The registry also records when `run_with_deadline` gave up on work it could not stop
//! ([`DeadlineError::Unstoppable`](super::DeadlineError::Unstoppable)), whatever the caller then
//! does with that error, so the owner can treat it as fatal.

use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tokio_util::task::task_tracker::TaskTrackerToken;

/// Work registered by [`run_with_deadline`](super::run_with_deadline) under one owner. Clones
/// share the register. Attach it to a token with [`Shutdown::with_registry`](super::Shutdown::with_registry);
/// tokens derived from that one (children, [`WorkScope::token`](super::WorkScope::token)) register
/// in it too, so nested work is covered.
#[derive(Clone, Debug, Default)]
pub struct WorkRegistry(Arc<Inner>);

#[derive(Debug, Default)]
struct Inner {
    tracker: TaskTracker,
    unstoppable: CancellationToken,
}

/// An entry in a [`WorkRegistry`]: the work counts as running while this is alive.
#[derive(Debug)]
pub(crate) struct WorkHold {
    _token: TaskTrackerToken,
}

impl WorkRegistry {
    /// An empty register.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one piece of work until the returned hold is dropped.
    pub(crate) fn hold(&self) -> WorkHold {
        WorkHold {
            _token: self.0.tracker.token(),
        }
    }

    /// How many registered pieces of work have not finished yet.
    pub fn running(&self) -> usize {
        self.0.tracker.len()
    }

    /// Records that registered work did not stop within its grace period.
    pub(crate) fn report_unstoppable(&self) {
        self.0.unstoppable.cancel();
    }

    /// Whether registered work was reported unstoppable: it may still be running, and nothing
    /// may take it over until the process has exited.
    pub fn is_unstoppable(&self) -> bool {
        self.0.unstoppable.is_cancelled()
    }

    /// Resolves once registered work is reported unstoppable (never, if none is).
    pub async fn unstoppable(&self) {
        self.0.unstoppable.cancelled().await;
    }

    /// Resolves once every registered piece of work has finished (at once if none is running).
    /// Bound it with a timeout: work stuck in synchronous code never finishes.
    pub async fn wait(&self) {
        // A tracker only resolves `wait` once closed. Closing does not stop registration: work
        // registered afterwards is still waited for.
        self.0.tracker.close();
        self.0.tracker.wait().await;
    }
}
