//! How many chat messages are handled at once, and what happens to the rest.
//!
//! The ingress runs the handler on a task per notification, after the answer was written, with
//! no bound on how many such tasks exist (`EventsubHandler::handle` asks the handler to bound
//! itself). The reference starts every message at once. Here:
//!
//! - **Per channel**: at most [`MessageConfig::per_channel_in_flight`] messages of a channel are
//!   handled at the same time; the next ones wait for a place in arrival order (a fair
//!   semaphore), at most [`MessageConfig::per_channel_waiting`] of them. A slow channel (a slow
//!   command, a slow Twitch for its chat) fills only its own places: the other channels' messages
//!   do not wait behind it.
//! - **In total**: at most [`MessageConfig::total_in_flight`] messages are handled at once and
//!   [`MessageConfig::total_waiting`] wait (a message holds its channel's place while it waits
//!   for a total one, so one channel never holds more than its share).
//! - **Evaluations**: at most [`MessageConfig::evaluations_in_flight`] command or keyword runs
//!   of the engine at once, all channels together ([`Admission::evaluation`]); a run waits for
//!   its turn inside its message's deadline.
//!
//! A message over a waiting bound, or that waited [`MessageConfig::admission_wait`] without a
//! place, is **dropped and counted** ([`Dropped`], [`AdmissionStats`], telemetry
//! `chat_message.dropped`): chat messages are at most once in the reference (a process that
//! dies while it handles one does not handle it again) and nothing journals them, so a message
//! the bot cannot take in time is lost the way an overload loses it today; waiting without a
//! bound would hold the memory of every message instead. Nothing a message started is dropped
//! by these bounds once it has its place, only by its own deadline
//! ([`MessageConfig::message_deadline`], [`Dropped::TimedOut`]).

use super::config::MessageConfig;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Why a message was not handled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dropped {
    /// Its channel already had [`MessageConfig::per_channel_waiting`] messages waiting.
    ChannelQueueFull,
    /// [`MessageConfig::total_waiting`] messages were already waiting.
    QueueFull,
    /// No place within [`MessageConfig::admission_wait`].
    WaitedTooLong,
    /// Its handling passed [`MessageConfig::message_deadline`] and was stopped.
    TimedOut,
}

impl Dropped {
    /// The counter's name.
    pub fn name(self) -> &'static str {
        match self {
            Self::ChannelQueueFull => "channel_queue_full",
            Self::QueueFull => "queue_full",
            Self::WaitedTooLong => "waited_too_long",
            Self::TimedOut => "timed_out",
        }
    }
}

/// Counts since start (fixed names; for tests and an operator).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AdmissionStats {
    /// Messages that got a place.
    pub admitted: u64,
    /// Messages handled right now.
    pub in_flight: usize,
    /// Messages waiting for a place right now.
    pub waiting: usize,
    /// Channels with a message in flight or waiting.
    pub channels: usize,
    /// Dropped: channel queue full.
    pub channel_queue_full: u64,
    /// Dropped: total queue full.
    pub queue_full: u64,
    /// Dropped: waited too long.
    pub waited_too_long: u64,
    /// Stopped at the message deadline.
    pub timed_out: u64,
    /// Evaluations running right now.
    pub evaluations: usize,
}

struct Gate {
    permits: Arc<Semaphore>,
    waiting: AtomicUsize,
}

struct Inner {
    per_channel_in_flight: usize,
    per_channel_waiting: usize,
    total_waiting: usize,
    total_in_flight: usize,
    evaluations_in_flight: usize,
    admission_wait: std::time::Duration,
    channels: Mutex<HashMap<String, Arc<Gate>>>,
    total: Arc<Semaphore>,
    evaluations: Arc<Semaphore>,
    waiting: AtomicUsize,
    admitted: AtomicU64,
    dropped: [AtomicU64; 4],
}

impl Inner {
    fn release(&self, channel: &str, gate: &Arc<Gate>) {
        let mut channels = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        // Every clone of a gate comes from the map under this lock: two references (the map's and
        // the caller's) mean nobody else is in flight or waiting for this channel.
        if Arc::strong_count(gate) == 2
            && channels.get(channel).is_some_and(|g| Arc::ptr_eq(g, gate))
        {
            channels.remove(channel);
        }
    }
}

/// The bounds of [`super::MessageHandler`]. Cheap to clone; one per handler.
#[derive(Clone)]
pub struct Admission(Arc<Inner>);

impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Admission")
            .field("stats", &self.stats())
            .finish()
    }
}

/// A message's place: released (and its channel forgotten when idle) when dropped.
pub struct Place {
    channel_permit: Option<OwnedSemaphorePermit>,
    total_permit: Option<OwnedSemaphorePermit>,
    gate: Arc<Gate>,
    channel: String,
    owner: Arc<Inner>,
}

impl Drop for Place {
    fn drop(&mut self) {
        self.total_permit.take();
        self.channel_permit.take();
        self.owner.release(&self.channel, &self.gate);
    }
}

/// Counts a waiting message until it has its place or gives up.
struct Waiting<'a> {
    inner: &'a Inner,
    gate: &'a Gate,
    channel_counted: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.inner.waiting.fetch_sub(1, Ordering::SeqCst);
        if self.channel_counted {
            self.gate.waiting.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Admission {
    /// The bounds of `config`.
    pub fn new(config: &MessageConfig) -> Self {
        let total_in_flight = config.total_in_flight.max(1);
        let evaluations_in_flight = config.evaluations_in_flight.max(1);
        Self(Arc::new(Inner {
            per_channel_in_flight: config.per_channel_in_flight.max(1),
            per_channel_waiting: config.per_channel_waiting,
            total_waiting: config.total_waiting,
            total_in_flight,
            evaluations_in_flight,
            admission_wait: config.admission_wait,
            channels: Mutex::new(HashMap::new()),
            total: Arc::new(Semaphore::new(total_in_flight)),
            evaluations: Arc::new(Semaphore::new(evaluations_in_flight)),
            waiting: AtomicUsize::new(0),
            admitted: AtomicU64::new(0),
            dropped: std::array::from_fn(|_| AtomicU64::new(0)),
        }))
    }

    /// Counts a message dropped for `reason`.
    pub fn count_dropped(&self, reason: Dropped) {
        let slot = match reason {
            Dropped::ChannelQueueFull => 0,
            Dropped::QueueFull => 1,
            Dropped::WaitedTooLong => 2,
            Dropped::TimedOut => 3,
        };
        self.0.dropped[slot].fetch_add(1, Ordering::Relaxed);
    }

    /// Waits for a place for a message of `channel_id` (see the module documentation).
    pub async fn admit(&self, channel_id: &str) -> Result<Place, Dropped> {
        let inner = &self.0;
        let gate = {
            let mut channels = inner
                .channels
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            Arc::clone(channels.entry(channel_id.to_owned()).or_insert_with(|| {
                Arc::new(Gate {
                    permits: Arc::new(Semaphore::new(inner.per_channel_in_flight)),
                    waiting: AtomicUsize::new(0),
                })
            }))
        };
        let refused = |reason: Dropped| {
            inner.release(channel_id, &gate);
            self.count_dropped(reason);
            Err(reason)
        };
        if inner.waiting.fetch_add(1, Ordering::SeqCst) >= inner.total_waiting {
            inner.waiting.fetch_sub(1, Ordering::SeqCst);
            return refused(Dropped::QueueFull);
        }
        let mut waiting = Waiting {
            inner,
            gate: &gate,
            channel_counted: false,
        };
        if gate.waiting.fetch_add(1, Ordering::SeqCst) >= inner.per_channel_waiting {
            gate.waiting.fetch_sub(1, Ordering::SeqCst);
            drop(waiting);
            return refused(Dropped::ChannelQueueFull);
        }
        waiting.channel_counted = true;
        let acquire = async {
            let channel = Arc::clone(&gate.permits).acquire_owned().await;
            let total = Arc::clone(&inner.total).acquire_owned().await;
            (channel, total)
        };
        let acquired = tokio::time::timeout(inner.admission_wait, acquire).await;
        drop(waiting);
        match acquired {
            Ok((Ok(channel_permit), Ok(total_permit))) => {
                inner.admitted.fetch_add(1, Ordering::Relaxed);
                Ok(Place {
                    channel_permit: Some(channel_permit),
                    total_permit: Some(total_permit),
                    gate,
                    channel: channel_id.to_owned(),
                    owner: Arc::clone(inner),
                })
            }
            // The semaphores are never closed; a closed one reads as no place in time.
            _ => refused(Dropped::WaitedTooLong),
        }
    }

    /// Waits for a turn to evaluate a command or a keyword (no bound on the wait but the
    /// message's own deadline).
    pub async fn evaluation(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.0.evaluations).acquire_owned().await.ok()
    }

    /// Counts since start.
    pub fn stats(&self) -> AdmissionStats {
        let inner = &self.0;
        let channels = inner
            .channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len();
        AdmissionStats {
            admitted: inner.admitted.load(Ordering::Relaxed),
            in_flight: inner
                .total_in_flight
                .saturating_sub(inner.total.available_permits()),
            waiting: inner.waiting.load(Ordering::SeqCst),
            channels,
            channel_queue_full: inner.dropped[0].load(Ordering::Relaxed),
            queue_full: inner.dropped[1].load(Ordering::Relaxed),
            waited_too_long: inner.dropped[2].load(Ordering::Relaxed),
            timed_out: inner.dropped[3].load(Ordering::Relaxed),
            evaluations: inner
                .evaluations_in_flight
                .saturating_sub(inner.evaluations.available_permits()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn config(
        per_channel: usize,
        per_channel_waiting: usize,
        total: usize,
        total_waiting: usize,
    ) -> MessageConfig {
        MessageConfig {
            per_channel_in_flight: per_channel,
            per_channel_waiting,
            total_in_flight: total,
            total_waiting,
            admission_wait: Duration::from_secs(30),
            ..MessageConfig::default()
        }
    }

    #[tokio::test]
    async fn a_busy_channel_waits_and_overflows_alone() {
        let admission = Admission::new(&config(2, 1, 10, 100));
        let a = admission.admit("a").await;
        let b = admission.admit("a").await;
        assert!(a.is_ok() && b.is_ok());
        // The third waits for a place; the fourth finds the channel's queue full.
        let third = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit("a").await.map(drop) }
        });
        while admission.stats().waiting == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            admission.admit("a").await.err(),
            Some(Dropped::ChannelQueueFull)
        );
        // Another channel is not held up by the busy one.
        let other = admission.admit("b").await;
        assert!(other.is_ok());
        drop(a);
        assert_eq!(third.await.ok(), Some(Ok(())));
        let stats = admission.stats();
        assert_eq!(
            (stats.admitted, stats.channel_queue_full, stats.waiting),
            (4, 1, 0)
        );
        drop((b, other));
        assert_eq!(admission.stats().channels, 0, "idle channels are forgotten");
        assert_eq!(admission.stats().in_flight, 0);
    }

    #[tokio::test]
    async fn the_total_bounds_hold_across_channels() {
        let admission = Admission::new(&config(4, 10, 2, 1));
        let first = admission.admit("a").await;
        let second = admission.admit("b").await;
        assert!(first.is_ok() && second.is_ok());
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit("c").await.map(drop) }
        });
        while admission.stats().waiting == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(admission.admit("d").await.err(), Some(Dropped::QueueFull));
        drop(first);
        assert_eq!(waiting.await.ok(), Some(Ok(())));
        assert_eq!(admission.stats().queue_full, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_message_that_waits_too_long_is_dropped() {
        let admission = Admission::new(&MessageConfig {
            per_channel_in_flight: 1,
            admission_wait: Duration::from_secs(5),
            ..MessageConfig::default()
        });
        let held = admission.admit("a").await;
        assert!(held.is_ok());
        assert_eq!(
            admission.admit("a").await.err(),
            Some(Dropped::WaitedTooLong)
        );
        let stats = admission.stats();
        assert_eq!(
            (stats.waited_too_long, stats.waiting, stats.channels),
            (1, 0, 1)
        );
        drop(held);
        assert_eq!(admission.stats().channels, 0);
    }
}
