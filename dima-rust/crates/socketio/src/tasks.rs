//! The tasks this crate starts: every one can be waited for, and aborted and joined, at
//! shutdown.

use std::future::Future;
use std::sync::{Mutex, PoisonError};

use tokio::task::JoinSet;
use tokio_util::task::TaskTracker;

/// Every task of the server (connections, sockets, the recovery sweep) and every future tracked
/// inside one of them (a socket's concurrent event handlers).
#[derive(Default)]
pub(crate) struct Tasks {
    /// Abort handles of the spawned tasks; finished ones are reaped as new ones start.
    set: Mutex<JoinSet<()>>,
    /// Done once every spawned task and tracked future has been dropped, finished or aborted.
    tracker: TaskTracker,
}

impl Tasks {
    /// Spawns a task the server owns.
    pub fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        let future = self.tracker.track_future(future);
        let mut set = self.set.lock().unwrap_or_else(PoisonError::into_inner);
        while set.try_join_next().is_some() {}
        set.spawn(future);
    }

    /// Tracks a future that runs inside a task the server owns (its owner aborts it).
    pub fn track<F: Future>(&self, future: F) -> tokio_util::task::task_tracker::TrackedFuture<F> {
        self.tracker.track_future(future)
    }

    /// Resolves once every task and tracked future has ended (after [`Tasks::close`]).
    pub async fn ended(&self) {
        self.tracker.wait().await;
    }

    /// No task will be added: [`Tasks::ended`] can resolve.
    pub fn close(&self) {
        self.tracker.close();
    }

    /// How many tasks and tracked futures have not ended.
    pub fn running(&self) -> usize {
        self.tracker.len()
    }

    /// Aborts every spawned task still running (each ends at its next await, and its tracked
    /// futures with it); returns how many were aborted.
    pub fn abort_all(&self) -> usize {
        let mut set = self.set.lock().unwrap_or_else(PoisonError::into_inner);
        while set.try_join_next().is_some() {}
        let running = set.len();
        set.abort_all();
        running
    }
}
