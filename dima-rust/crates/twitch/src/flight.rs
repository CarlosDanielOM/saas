//! One piece of work per key inside a process: the first caller starts it as a task, the
//! others wait for the same result.
//!
//! The work runs as a task on the crate's [`TaskTracker`], not inside the caller's future, so a
//! caller that gives up (its own deadline, a dropped request) does not cancel it: a refresh whose
//! answer Twitch has already sent is written to the store even when nobody waits any more. The
//! map holds at most `limit` keys; past that, [`Flights::join`] refuses instead of growing.

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokio_util::task::TaskTracker;

type Waiter<V> = Shared<BoxFuture<'static, V>>;
type Map<K, V> = Arc<Mutex<HashMap<K, Waiter<V>>>>;

pub(crate) struct Flights<K, V> {
    map: Map<K, V>,
    limit: usize,
}

fn lock<K, V>(map: &Mutex<HashMap<K, V>>) -> MutexGuard<'_, HashMap<K, V>> {
    map.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Removes the key when the task ends, however it ends (value, panic or abort).
struct Leave<K: Eq + Hash, V> {
    map: Map<K, V>,
    key: Option<K>,
}

impl<K: Eq + Hash, V> Drop for Leave<K, V> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            lock(&self.map).remove(&key);
        }
    }
}

impl<K, V> Flights<K, V>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
            limit: limit.max(1),
        }
    }

    /// The running flight for `key`, or a new one running `work()` on `tracker`. A flight that
    /// ends without a value (panic, abort at shutdown) gives `interrupted`. `None` when `limit`
    /// flights are already running.
    pub(crate) fn join<F>(
        &self,
        key: K,
        tracker: &TaskTracker,
        interrupted: V,
        work: impl FnOnce() -> F,
    ) -> Option<Waiter<V>>
    where
        F: Future<Output = V> + Send + 'static,
    {
        let mut map = lock(&self.map);
        if let Some(waiter) = map.get(&key) {
            return Some(waiter.clone());
        }
        if map.len() >= self.limit {
            return None;
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let leave = Leave {
            map: Arc::clone(&self.map),
            key: Some(key.clone()),
        };
        let future = work();
        tracker.spawn(async move {
            let value = future.await;
            // Leave the map before the result is visible: a caller that arrives now starts a
            // new flight, which reads the store again.
            drop(leave);
            let _ = sender.send(value);
        });
        let waiter = async move { receiver.await.unwrap_or(interrupted) }
            .boxed()
            .shared();
        map.insert(key, waiter.clone());
        Some(waiter)
    }

    /// Flights running now.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock(&self.map).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn callers_share_one_run_and_the_key_is_released() {
        let flights: Flights<&'static str, u32> = Flights::new(8);
        let tracker = TaskTracker::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let mut waiters = Vec::new();
        for _ in 0..50 {
            let runs = Arc::clone(&runs);
            waiters.push(
                flights
                    .join("k", &tracker, 0, move || async move {
                        runs.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        7
                    })
                    .unwrap(),
            );
        }
        for waiter in waiters {
            assert_eq!(waiter.await, 7);
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(flights.len(), 0);
    }

    #[tokio::test]
    async fn a_dropped_caller_does_not_cancel_the_work() {
        let flights: Flights<u8, u32> = Flights::new(8);
        let tracker = TaskTracker::new();
        let done = Arc::new(AtomicUsize::new(0));
        let marker = Arc::clone(&done);
        let waiter = flights
            .join(1, &tracker, 0, move || async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                marker.fetch_add(1, Ordering::SeqCst);
                1
            })
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1), waiter)
                .await
                .is_err()
        );
        tracker.close();
        tracker.wait().await;
        assert_eq!(done.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_limit_refuses_new_keys_and_a_panic_reports_interrupted() {
        let flights: Flights<u8, u32> = Flights::new(1);
        let tracker = TaskTracker::new();
        let first = flights
            .join(1, &tracker, 99, || async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if Duration::from_millis(20) > Duration::ZERO {
                    panic!("boom");
                }
                1
            })
            .unwrap();
        assert!(flights.join(2, &tracker, 99, || async { 2 }).is_none());
        assert_eq!(first.await, 99);
        assert_eq!(flights.len(), 0);
        assert_eq!(
            flights.join(2, &tracker, 99, || async { 2 }).unwrap().await,
            2
        );
    }
}
