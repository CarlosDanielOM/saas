//! The consumer runtime: claims a delivery, runs its consumer, records the outcome.
//!
//! References: `utils/domain_event_consumer.ts` (`drainDomainEvents`, `processDelivery`,
//! `claimDelivery`, `finishPolicyDelivery`, `advanceCheckpoint`, `replayDeadDomainEvent`),
//! `utils/domain_event_execution.ts` (the watchdog that kills a consumer process whose lease or
//! execution limit runs out, the poll signal) and `workers/domain_events.worker.ts` (the
//! dispatcher process and one process per consumer).
//!
//! - [`handler`]: what a consumer implements and what the runtime guarantees it.
//! - [`drain`]: one pass of one consumer, and one delivery under its lease.
//! - [`runtime`]: the long-running entry point (dispatcher, consumers, wakeups, sweep,
//!   shutdown).
//! - [`admin`]: the admin page's listing and the operator's replay.
//! - [`config`]: the settings.
//!
//! # The delivery state machine
//!
//! A delivery is created `pending` by the dispatcher or the consumer's own journal scan. A
//! drain pass claims it (`processing`, `attempts + 1`, a fresh `leaseToken`, `lockedUntil = now +
//! 60 s`) when it is active, below the attempt limit (5), unleased and due. Then, under the lease
//! (every write after the claim matches `{status: processing, leaseToken, lockedUntil > now}`):
//!
//! | outcome | status | attempts | |
//! |---|---|---|---|
//! | done | `succeeded` | kept | errors cleared |
//! | failed | `retry` in 5 s, 30 s, 5 min, 30 min, 30 min…; `dead` at the limit | kept | `handler_failed` |
//! | invalid event (contract) | `dead` | given back | `contract_invalid` |
//! | missing prerequisite | `retry` in 30 s (metric session: 30 s, 90 s, 210 s, 450 s, 750 s, 900 s from the journal time); `dead` past 24 h from the journal time or the event's expiry; a metric session past 15 min: `skipped` | given back | `prerequisite_missing` |
//! | too old for an ephemeral consumer, or an unsupported schema | `skipped` / `dead` | given back | `policy_rejected` (dead) |
//!
//! Without a claim: a delivery whose event is gone is `dead` (`journal_missing`); one whose
//! final attempt was interrupted (process died, lease expired at the limit) is `dead`
//! (`interrupted`) without running again; a policy rejection settles it (`skipped`/`dead`).
//! `processing` whose lease expired is ready again (the sweep's dead-process recovery). An
//! operator moves `dead` back to `retry` with attempts 0 ([`admin::replay`]). `succeeded`,
//! `skipped` and `dead` are final otherwise.
//!
//! # Across the cutover
//!
//! Deliveries and checkpoints are MongoDB documents written exactly as the reference writes
//! them, so the Rust runtime takes over where the TypeScript one stopped: `pending` and due
//! `retry` deliveries are claimed by the next pass; a `retry` not yet due waits for its time;
//! `processing` under a lease of a stopped TypeScript worker is ready once the lease expires
//! (at most 60 s) and is claimed again, spending an attempt as the reference's own restart would
//! (at the limit it is retired `dead`, `interrupted`, without running); `dead`, `skipped` and
//! `succeeded` stay as they are (a `dead` one can be replayed by an operator). Checkpoints carry
//! on from the last event each consumer read. Nothing is kept in Dragonfly.

pub mod admin;
pub mod config;
pub mod drain;
pub mod handler;
pub(crate) mod records;
pub mod runtime;

use crate::dispatch::DispatchError;
use crate::envelope::EnvelopeError;
use crate::store::StoreError;
use dima_model::ModelError;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub use config::{ConfigError, ConsumerConfig};
pub use drain::{DeliveryOutcome, DeliveryRecord, DrainResult, Engine};
pub use handler::{DeliveryContext, Handler, Outcome};
pub use runtime::{Report, Runtime};

/// One consumer: its registry entry and its handler.
#[derive(Clone, Debug)]
pub struct Consumer {
    /// The definition (name, topics, filter, policy).
    pub definition: &'static crate::contracts::policy::ConsumerDefinition,
    /// The handler.
    pub handler: Arc<dyn Handler>,
}

/// Why a handler was stopped before it finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// Its lease was not renewed in time (`lockedUntil - leaseSafety` passed), a renewal failed
    /// or found the lease gone, or the lease had expired when it returned.
    LeaseLost,
    /// It ran past the execution limit (120 s after its claim).
    ExecutionLimit,
    /// The shutdown grace (5 s) ran out.
    Shutdown,
}

impl fmt::Display for StopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::LeaseLost => "lease lost",
            Self::ExecutionLimit => "execution limit passed",
            Self::Shutdown => "shutdown grace ran out",
        })
    }
}

/// A drain pass or a runtime that did not complete.
#[derive(Debug, thiserror::Error)]
pub enum ConsumerError {
    /// MongoDB failed or timed out (an `outcome_unknown` write may have been applied: every
    /// write here is fenced or idempotent, so the next pass settles it).
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The model refused a write it prepared (a bug: the documents are built here).
    #[error(transparent)]
    Model(#[from] ModelError),
    /// Creating or settling a delivery failed.
    #[error(transparent)]
    Dispatch(#[from] DispatchError),
    /// A journaled event could not be read as one.
    #[error(transparent)]
    Event(#[from] EnvelopeError),
    /// No lease token could be made.
    #[error("lease token: {0}")]
    Random(String),
    /// A handler was stopped before it finished; nothing was recorded and its lease is left to
    /// expire (the reference's watchdog kill; `Domain event execution lease expired`).
    #[error("{consumer}: delivery of {event_key} stopped: {reason}")]
    Stopped {
        /// The consumer.
        consumer: &'static str,
        /// The event.
        event_key: String,
        /// Why.
        reason: StopReason,
    },
    /// A stopped handler did not finish within the abort grace and may still be running: the
    /// process must exit (`MIGRATION.md` section 6).
    #[error("{consumer}: the handler of {event_key} did not stop; the process must exit")]
    Unstoppable {
        /// The consumer.
        consumer: &'static str,
        /// The event.
        event_key: String,
    },
    /// Two consumers have the same name (`Duplicate domain event consumer IDs`).
    #[error("Duplicate domain event consumer IDs")]
    Duplicate,
}

/// A monotonic clock for attempt durations (`performance.now()`), injectable for tests.
pub trait Monotonic: Send + Sync + fmt::Debug {
    /// Time since an arbitrary fixed origin.
    fn now(&self) -> Duration;
}

/// tokio's monotonic clock.
#[derive(Clone, Copy, Debug)]
pub struct TokioMonotonic {
    origin: tokio::time::Instant,
}

impl Default for TokioMonotonic {
    fn default() -> Self {
        Self {
            origin: tokio::time::Instant::now(),
        }
    }
}

impl Monotonic for TokioMonotonic {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

/// A monotonic clock that moves only when told to (tests). Clones share the time.
#[derive(Clone, Debug, Default)]
pub struct ManualMonotonic(Arc<AtomicU64>);

impl ManualMonotonic {
    /// Moves it forward by `ms`.
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Monotonic for ManualMonotonic {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}
