//! What a consumer implements ([`Handler`]) and what it gets and returns.
//!
//! Reference: `DomainEventHandler` and `DomainEventPrerequisiteMissingError`
//! (`domain_events/domain_event.types.ts`) and how `processDelivery`
//! (`utils/domain_event_consumer.ts`) tells a thrown error apart.
//!
//! # What the runtime guarantees a handler
//!
//! - **At least once.** A delivery is run until an outcome is recorded under its lease. A handler
//!   can be run again for the same delivery: its process died or its lease was lost after it
//!   caused effects, its outcome write was lost, or an operator replayed it. Every effect must
//!   therefore be idempotent, keyed on the delivery: `(consumer, eventKey)` is unique
//!   ([`DeliveryContext::consumer`], [`crate::envelope::Envelope::event_key`]), and so is
//!   [`DeliveryContext::delivery_id`]. The reference's handlers key on the event key.
//! - **Never two at once.** One holder at a time: the claim is a compare-and-set that takes a
//!   lease (60 s, renewed every 20 s while the handler runs). A handler that outlives its lease,
//!   its execution limit (120 s) or the shutdown grace (5 s) is aborted and joined before anyone
//!   else may claim the delivery, and its outcome is never recorded.
//! - **No ordering.** Within a consumer, new events are handed over in journal (`_id`) order and
//!   one at a time, but a delivery waiting for a retry or a prerequisite is passed over, ready
//!   retries come first in `updatedAt, _id` order, and nothing orders deliveries across
//!   consumers. A handler that needs ordering compares event times itself (the reference's
//!   stream-operations and Polar handlers do).
//! - **Replay** is an operator resetting a `dead` delivery to `retry` with its attempts back to
//!   0 ([`super::admin::replay`]); the handler then sees the same envelope again with
//!   [`DeliveryContext::replay_count`] above 0.
//! - **Retry timing belongs to the runtime.** "Consumers report prerequisites; only the delivery
//!   engine owns retry timing/budgets" (the reference's own rule): a handler says what happened,
//!   never when to try again.

use crate::envelope::Envelope;
use bson::oid::ObjectId;
use dima_core::Shutdown;
use futures_util::future::BoxFuture;

/// What happened to one delivery, as the reference tells a thrown error apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Done (the handler returned): `succeeded`. A handler that decides an event is not its
    /// business also returns this, as the reference's handlers do.
    Done,
    /// Something failed that may work later (a thrown `Error`): `retry` after 5 s, 30 s, 5 min,
    /// then every 30 min, `dead` once the attempts are used up (`handler_failed`). The text is
    /// stored (cut at 8,000 UTF-16 units) and shown to admins: no secrets.
    Failed(String),
    /// The event can never be handled (a `DomainEventContractError`): `dead` at once
    /// (`contract_invalid`), and the attempt is not counted. The text follows
    /// `Domain event contract: `.
    Invalid(String),
    /// Something the handler needs does not exist yet (a `DomainEventPrerequisiteMissingError`):
    /// `retry` in 30 s (a `metric-session:` prerequisite on its own schedule), without spending
    /// an attempt, until the prerequisite horizon (24 h from the journal time; 15 min for a
    /// metric session, then `skipped`). The prefix names the kind: `owner:`, `subject:`,
    /// `metric-session:`, anything else is `other`.
    MissingPrerequisite(String),
}

/// What a handler gets besides the event.
#[derive(Clone, Debug)]
pub struct DeliveryContext {
    pub(crate) consumer: &'static str,
    pub(crate) delivery_id: ObjectId,
    pub(crate) attempt: i64,
    pub(crate) replay_count: i64,
    pub(crate) stop: Shutdown,
}

impl DeliveryContext {
    /// A context for calling a handler outside the runtime (tests of a feature's handler).
    pub fn new(
        consumer: &'static str,
        delivery_id: ObjectId,
        attempt: i64,
        replay_count: i64,
    ) -> Self {
        Self {
            consumer,
            delivery_id,
            attempt,
            replay_count,
            stop: Shutdown::new(),
        }
    }

    /// The consumer.
    pub fn consumer(&self) -> &'static str {
        self.consumer
    }

    /// The delivery's `_id` (one per consumer and event, kept across retries and replays).
    pub fn delivery_id(&self) -> ObjectId {
        self.delivery_id
    }

    /// This attempt's number as stored (`attempts` after the claim: 1 on the first run; a
    /// missing prerequisite or an invalid event gives its attempt back, so the same number can
    /// come twice).
    pub fn attempt(&self) -> i64 {
        self.attempt
    }

    /// How many times an operator replayed the delivery (`replayCount`).
    pub fn replay_count(&self) -> i64 {
        self.replay_count
    }

    /// Fires when the handler must stop: its lease is lost or about to expire, its execution
    /// limit passed, or the shutdown grace ran out. The handler is aborted at its next `.await`
    /// anyway; long work, or blocking work, should watch this and stop early. Leases are renewed
    /// by the runtime while the handler runs, up to the execution limit: there is nothing to
    /// extend by hand.
    pub fn stopping(&self) -> &Shutdown {
        &self.stop
    }
}

/// A consumer (`DomainEventHandler`). Cancellable: the future may be dropped at any `.await`
/// (see [`DeliveryContext::stopping`]).
pub trait Handler: Send + Sync + std::fmt::Debug {
    /// Handles one delivery of `event`.
    fn handle<'a>(
        &'a self,
        event: &'a Envelope,
        context: &'a DeliveryContext,
    ) -> BoxFuture<'a, Outcome>;
}

/// The kind a prerequisite text names (`lastPrerequisiteKind`).
pub(crate) fn prerequisite_kind(prerequisite: &str) -> &'static str {
    if prerequisite.starts_with("owner:") {
        "owner"
    } else if prerequisite.starts_with("subject:") {
        "subject"
    } else if prerequisite.starts_with("metric-session:") {
        "metric"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerequisite_kinds() {
        assert_eq!(prerequisite_kind("owner:polar customer mapping"), "owner");
        assert_eq!(prerequisite_kind("subject:x"), "subject");
        assert_eq!(prerequisite_kind("metric-session:1001"), "metric");
        assert_eq!(prerequisite_kind("stream-session"), "other");
        assert_eq!(prerequisite_kind("Owner:x"), "other");
    }
}
