//! The receipt queue: every accepted use of an AI feature queues one receipt, and a consumer
//! settles the queue into the usage ledger.
//!
//! References: `enqueueAiUsageReceipt` (`utils/ai_usage_ledger.ts`, called from
//! `projectAcceptedUsage` and `grantPolarAiCredits` in `utils/polarsh.ts`) and the native
//! worker that consumes the queue in production (`dima-rust/src/workers/ai_usage_receipts.rs`
//! and `queue.rs`): what it stores and how it handles the queue is the contract.
//!
//! # The chain from a use to a settled receipt
//!
//! | Step | Where the truth is | A stop right after it leaves |
//! |---|---|---|
//! | 1. The usage event is built; its `external_id` (= the receipt's entry id) is fixed | memory | nothing: the use was not accepted (the caller's AI call is not billed) |
//! | 2. The event is queued (`twitch:{c}:ai:polarshevent`) | Dragonfly: the usage queue (money owed to Polar) | the event, flushed later (by the next use or [`crate::usage_health::QuietFlush`]); no local debit until the next balance read, where the queue holds it; no receipt, which the backfill restores from Polar under the same entry id |
//! | 3. The local debit (`record_usage`, deduplicated by the external id) | Dragonfly: the cached balance | as above, without the debit gap |
//! | 4. The receipt is queued ([`ReceiptSink`]) | Dragonfly: the receipt queue | the receipt, settled later |
//! | 5. The flush claims, sends and acknowledges the event | Polar (after the acknowledgement); the processing list before it | an unacknowledged batch, resent with the same external ids (Polar deduplicates) |
//! | 6. The consumer claims the receipt | the processing list | the receipt, resumed by the next consumer |
//! | 7. The receipt is upserted on `{channelID, customerId, entryId}` | MongoDB `ai_usage_receipts` | the receipt stored, its day not rebuilt; the job is still claimed and its retry rebuilds the day (the upsert matches) |
//! | 8. Its day is rebuilt | MongoDB `ai_usage_dailies` | between the delete and the insert, the day missing until the retry rebuilds it |
//! | 9. The job is settled | — | nothing |
//!
//! Steps 2 to 4 are three separate writes in the reference and here (the ingest flows are not
//! changed by this package); what joins them is the entry id: Polar keeps the event under it,
//! the debit is deduplicated by it, and the receipt is keyed by it. The backfill
//! ([`crate::usage_backfill`]) reads Polar's events and upserts the receipts by the same key,
//! so a receipt lost between steps 2 and 4 (or dead-lettered at step 7) is restored, and one
//! that arrives by both paths is stored once.
//!
//! # Keys (Rust's own after the cutover; the names are kept)
//!
//! | Key | Type | Value | Lifetime |
//! |---|---|---|---|
//! | `cron:ai-usage-receipts:queue` | list | `JSON.stringify({...receipt, enqueuedAt})` | none |
//! | `cron:ai-usage-receipts:processing` | list | claimed jobs, byte for byte | none |
//! | `cron:ai-usage-receipts:queue:dead` | list | jobs that failed their last attempt, raw | none (an operator empties it) |
//! | `cron:ai-usage-receipts:queue:attempts:{sha256 hex}` | string | attempt count | 7 days |
//! | `worker:ai-usage-receipts:lock` | string | the consumer's random token | [`ConsumerConfig::lease_ms`] |
//! | `ai-usage:queue-health:receipts` | hash | `processingSince`, `failures`, `pendingSince`, `observedFailures` | none |
//!
//! # Cutover and rollback
//!
//! The queue holds receipts (derived from money already counted elsewhere, but the usage page
//! of a channel shows them): it is *drained*, with a carry as fallback.
//!
//! 1. Before the cutover, with the TypeScript producers (bot, API) stopped, let the native
//!    worker run until `cron:ai-usage-receipts:queue` and `:processing` are empty in database 0
//!    (it settles 200 a second).
//! 2. If they cannot be emptied (the native worker is down), move each element of database 0's
//!    queue, then processing list, to the tail of database 1's queue unchanged (`LMOVE` across
//!    databases is not possible: `LRANGE` then `RPUSH` then `LTRIM`, in batches): Rust reads the
//!    reference's format ([`crate::usage_ledger::receipt::parse_queued_receipt`]), and the
//!    upsert makes a receipt that was in fact already stored a no-op.
//! 3. Copy `cron:ai-usage-receipts:queue:dead` the same way if it is not empty, or keep it for
//!    an operator: a dead receipt is restored by the backfill anyway.
//! 4. Rollback: stop the Rust producers, let the Rust consumer drain database 1's queue and
//!    processing list (or move them to database 0 as in step 2: the native worker reads the
//!    same JSON), then start the TypeScript processes.

pub mod consumer;

use crate::polar::{AcceptedUsage, UsageSink};
use crate::usage_ledger::receipt::{QueuedReceipt, receipt_of};
use crate::usage_queue::QueueKeys;
use dima_core::Clock;
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

pub use consumer::{ConsumerConfig, ReceiptConsumer, SettleEnd, SettleReport};

/// The receipt queue's keys.
pub fn receipt_keys() -> QueueKeys {
    receipt_keys_prefixed("")
}

/// The receipt queue's keys under `prefix` (the tests' isolation).
pub fn receipt_keys_prefixed(prefix: &str) -> QueueKeys {
    QueueKeys {
        name: "receipts",
        queue: format!("{prefix}cron:ai-usage-receipts:queue"),
        processing: format!("{prefix}cron:ai-usage-receipts:processing"),
        dead: format!("{prefix}cron:ai-usage-receipts:queue:dead"),
        lease: format!("{prefix}worker:ai-usage-receipts:lock"),
        health: format!("{prefix}ai-usage:queue-health:receipts"),
    }
}

/// The producer side.
#[derive(Clone, Copy)]
pub struct ReceiptQueue<'a> {
    /// Dragonfly.
    pub dragonfly: &'a Dragonfly,
    /// Keys.
    pub keys: &'a QueueKeys,
    /// `enqueuedAt`.
    pub clock: &'a dyn Clock,
}

impl std::fmt::Debug for ReceiptQueue<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReceiptQueue")
    }
}

impl ReceiptQueue<'_> {
    /// `enqueueAiUsageReceipt(cache, receipt)`: appends the receipt with `enqueuedAt`.
    pub async fn enqueue(&self, receipt: &QueuedReceipt) -> Result<(), DragonflyError> {
        let text = receipt.queued_text(self.clock.now_ms());
        self.dragonfly
            .rpush(&self.keys.queue, &[text.as_bytes()])
            .await
            .map(|_| ())
    }
}

/// `trackAiUsageRecorded`: analytics of an accepted use (another package's; best effort).
pub trait UsageTracker: Send + Sync {
    /// Records the use.
    fn track(&self, usage: AcceptedUsage<'_>, metadata: &Map<String, Value>);
}

/// Tracks nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoTracker;

impl UsageTracker for NoTracker {
    fn track(&self, _usage: AcceptedUsage<'_>, _metadata: &Map<String, Value>) {}
}

/// The [`UsageSink`] of the ingest flows: the receipt of an accepted use is built when it is
/// accepted (`occurredAt` is now) and queued; analytics go to the tracker.
#[derive(Clone, Copy)]
pub struct ReceiptSink<'a> {
    /// The queue.
    pub queue: ReceiptQueue<'a>,
    /// Analytics.
    pub tracker: &'a dyn UsageTracker,
}

impl std::fmt::Debug for ReceiptSink<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReceiptSink")
    }
}

impl UsageSink for ReceiptSink<'_> {
    fn enqueue_receipt<'a>(
        &'a self,
        usage: AcceptedUsage<'a>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            // `buildQueuedAiUsageReceipt` answers null (nothing queued) without a channel, a
            // customer or finite credits.
            let Some(receipt) = receipt_of(usage, self.queue.clock.now_ms()) else {
                return Ok(());
            };
            self.queue
                .enqueue(&receipt)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn track(&self, usage: AcceptedUsage<'_>, metadata: &Map<String, Value>) {
        self.tracker.track(usage, metadata);
    }
}
