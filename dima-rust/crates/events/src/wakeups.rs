//! How consumers learn there is work: a pub/sub hint after every journal append, and a periodic
//! sweep that finds the work without it.
//!
//! References: `utils/domain_event_wakeups.ts` (`DomainEventWakeups`), `DomainEventPollSignal`
//! (`utils/domain_event_execution.ts`) and the loops of `workers/domain_events.worker.ts`.
//!
//! # A lost wakeup only delays work
//!
//! The hint carries nothing: the work is in MongoDB (`dispatchPending: true` on the event, a
//! `pending`/`retry` delivery). The dispatcher and every consumer wait on a [`PollSignal`] for at
//! most the poll interval (`DOMAIN_EVENTS_POLL_INTERVAL_MS`, default 1,000 ms, minimum 250) and
//! then sweep MongoDB whether or not a hint came; a full batch sweeps again at once. So a hint
//! lost anywhere (Dragonfly down, the publisher cooling down after a failure, a subscription
//! buffer full, a reconnect) delays the work by at most one interval, and nothing is lost:
//! `tests/wakeups.rs` journals with the hint switched off and with Dragonfly unreachable, and the
//! sweep still dispatches.
//!
//! # Publisher
//!
//! [`Publisher::publish`] never waits: it sets one pending bit, and a background task sends one
//! `PUBLISH <channel> 1` at a time, coalescing every append that happened meanwhile into the next
//! one. A failed or slow publish (over [`WakeupConfig::timeout`], 500 ms as in the reference) is
//! dropped, and the publisher cools down for [`WakeupConfig::retry`] (1 s), dropping hints, as
//! the reference does. Intended difference: the reference opens a dedicated short-lived client
//! (closed after 30 s idle) because node-redis queues commands while disconnected; the Rust
//! client bounds every command, so the hint goes over the process's shared connection.
//!
//! # Listener
//!
//! [`Listener::start`] subscribes with [`Overflow::DropNewest`]: a hint already in the buffer
//! says the same as the dropped one, and the sweep covers the rest, so the subscription never
//! needs a gap marker. Every message wakes the [`PollSignal`]; the subscriber reconnects and
//! resubscribes on its own.
//!
//! # Channel
//!
//! `domain-events:wakeup:v1` in the reference. Pub/sub channels are server-wide and Rust never
//! shares a channel name with TypeScript (`MIGRATION.md` section 3, cutover sequence), so the
//! Rust default is [`DEFAULT_CHANNEL`]. Nothing is carried across the cutover: a hint is never
//! stored.

use crate::producers::WakeHint;
use dima_core::Shutdown;
use dima_store::dragonfly::{Dragonfly, Event, Overflow, Topic};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// The reference's channel (`CHANNEL` in `domain_event_wakeups.ts`).
pub const REFERENCE_CHANNEL: &str = "domain-events:wakeup:v1";
/// The Rust channel: never the TypeScript one.
pub const DEFAULT_CHANNEL: &str = "rust:domain-events:wakeup:v1";

/// Wakeup settings (`DOMAIN_EVENTS_WAKEUPS_ENABLED` and the reference's constants).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WakeupConfig {
    /// `DOMAIN_EVENTS_WAKEUPS_ENABLED`: anything but `false` (any case) enables hints.
    pub enabled: bool,
    /// The channel.
    pub channel: String,
    /// Bound on one publish (`timeoutMs`, 500).
    pub timeout: Duration,
    /// Cool-down after a failure (`retryMs`, 1,000).
    pub retry: Duration,
}

impl Default for WakeupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            channel: DEFAULT_CHANNEL.to_owned(),
            timeout: Duration::from_millis(500),
            retry: Duration::from_millis(1_000),
        }
    }
}

impl WakeupConfig {
    /// `domainEventWakeupsEnabled()`: `process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED?.toLowerCase()
    /// !== 'false'`.
    pub fn enabled_from_env(value: Option<&str>) -> bool {
        value.is_none_or(|value| value.to_lowercase() != "false")
    }
}

/// `DomainEventPollSignal`: one pending wake, or a wait of at most an interval.
#[derive(Debug, Default)]
pub struct PollSignal {
    notify: Notify,
    stopped: AtomicBool,
}

impl PollSignal {
    /// A signal with nothing pending.
    pub fn new() -> Self {
        Self::default()
    }

    /// Wakes the current wait, or the next one when nobody waits (one pending wake).
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// Returns on a wake, after `interval`, or at once when a wake is pending or the signal
    /// is stopped.
    pub async fn wait(&self, interval: Duration) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let _ = tokio::time::timeout(interval, self.notify.notified()).await;
    }

    /// Ends every wait for good.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
        self.notify.notify_one();
    }
}

#[derive(Debug, Default)]
struct PublisherState {
    pending: AtomicBool,
    notify: Notify,
    sent: AtomicU64,
    dropped: AtomicU64,
}

/// The producer side (`domainEventWakeups.publish()`).
#[derive(Debug, Clone)]
pub struct Publisher {
    state: Arc<PublisherState>,
    enabled: bool,
}

impl Publisher {
    /// Starts the publishing task on `dragonfly`; it stops with `shutdown`.
    pub fn start(
        dragonfly: Dragonfly,
        config: WakeupConfig,
        shutdown: Shutdown,
    ) -> (Self, JoinHandle<()>) {
        let state = Arc::new(PublisherState::default());
        let enabled = config.enabled;
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            if !config.enabled {
                return;
            }
            loop {
                tokio::select! {
                    () = shutdown.wait() => return,
                    () = task_state.notify.notified() => {}
                }
                while task_state.pending.swap(false, Ordering::SeqCst) {
                    let sent = tokio::time::timeout(
                        config.timeout,
                        dragonfly.publish(&config.channel, b"1"),
                    )
                    .await;
                    if matches!(sent, Ok(Ok(_))) {
                        task_state.sent.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    // Publishers drop failed hints and cool down; the sweep finds the work.
                    task_state.dropped.fetch_add(1, Ordering::Relaxed);
                    tokio::select! {
                        () = shutdown.wait() => return,
                        () = tokio::time::sleep(config.retry) => {}
                    }
                    if task_state.pending.swap(false, Ordering::SeqCst) {
                        task_state.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        });
        (Self { state, enabled }, task)
    }

    /// Hints sent so far.
    pub fn sent(&self) -> u64 {
        self.state.sent.load(Ordering::Relaxed)
    }

    /// Hints dropped after a failure.
    pub fn dropped(&self) -> u64 {
        self.state.dropped.load(Ordering::Relaxed)
    }
}

impl WakeHint for Publisher {
    fn publish(&self) {
        if !self.enabled {
            return;
        }
        self.state.pending.store(true, Ordering::SeqCst);
        self.state.notify.notify_one();
    }
}

/// The consumer side (`new DomainEventWakeups({ onWake })`).
#[derive(Debug)]
pub struct Listener {
    task: JoinHandle<()>,
}

impl Listener {
    /// Subscribes to the channel and wakes `signal` on every hint, until `shutdown`. Disabled
    /// hints start nothing (the sweep alone runs). The subscription is made in the background:
    /// while Dragonfly is unreachable the subscriber retries and the sweep carries on.
    pub fn start(
        dragonfly: &Dragonfly,
        config: &WakeupConfig,
        signal: Arc<PollSignal>,
        shutdown: Shutdown,
    ) -> Self {
        let subscriber = dragonfly.subscriber();
        let channel = config.channel.clone();
        let enabled = config.enabled;
        let task = tokio::spawn(async move {
            if !enabled {
                return;
            }
            let subscription = tokio::select! {
                () = shutdown.wait() => return,
                subscription = subscriber.subscribe(Topic::Channel(channel), Overflow::DropNewest) => subscription,
            };
            let Ok(mut subscription) = subscription else {
                return;
            };
            loop {
                tokio::select! {
                    () = shutdown.wait() => break,
                    event = subscription.recv() => match event {
                        Some(Event::Message(_) | Event::Gap(_)) => signal.wake(),
                        None => break,
                    },
                }
            }
            drop(subscription);
            subscriber.shutdown().await;
        });
        Self { task }
    }

    /// Waits for the listener to stop (after shutdown).
    pub async fn join(self) {
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_flag_reads_like_the_reference() {
        assert!(WakeupConfig::enabled_from_env(None));
        assert!(WakeupConfig::enabled_from_env(Some("")));
        assert!(WakeupConfig::enabled_from_env(Some("0")));
        assert!(!WakeupConfig::enabled_from_env(Some("FALSE")));
        assert!(!WakeupConfig::enabled_from_env(Some("false")));
        assert!(WakeupConfig::enabled_from_env(Some(" false")));
    }

    #[tokio::test(start_paused = true)]
    async fn poll_signal_keeps_one_pending_wake() {
        let signal = PollSignal::new();
        signal.wake();
        signal.wake();
        let started = tokio::time::Instant::now();
        signal.wait(Duration::from_secs(1)).await;
        assert_eq!(
            started.elapsed(),
            Duration::ZERO,
            "a pending wake returns at once"
        );
        signal.wait(Duration::from_secs(1)).await;
        assert_eq!(
            started.elapsed(),
            Duration::from_secs(1),
            "two wakes are one"
        );
        signal.stop();
        signal.wait(Duration::from_secs(1)).await;
        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }
}
