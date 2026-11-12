//! The AI usage ledger: one receipt per use of an AI feature by a channel, the daily totals and
//! dashboards derived from them, how far back each channel's ledger is complete, retention by
//! plan, and the reads of the dashboard's usage page.
//!
//! | Module | Reference |
//! |---|---|
//! | [`receipt`] | `buildQueuedAiUsageReceipt`, `parseQueuedAiUsageReceipt` (`utils/ai_usage_ledger.ts`) and the native worker's `parse_receipt` |
//! | [`lock`] | `utils/ai_usage_lock.ts` |
//! | [`record`] | `persistAiUsageReceipt` (the native worker's `ledger::persist`), `backfillAiUsageLedger`, `rebuildUtcDailyAggregates` |
//! | [`state`] | `getAiUsageLedgerStatus`, `getAiUsageLedgerState` |
//! | [`dashboard`] | `utils/ai_usage_dashboard.ts` and the native worker's `dashboard.rs` |
//! | [`query`] | `utils/ai_usage_queries.ts` |
//! | [`retention`] | `adjustAiUsageRetention` |
//! | [`report`] | the window, period, pacing and summary functions of `utils/ai_usage_receipts.ts` |
//! | [`history`] | `normalizePolarUsageEvent`, `normalizePolarCreditEvent`, `fetchAiUsageTransactions` |
//! | [`display`] | `utils/ai_credit_display.ts` |
//!
//! Not ported, because nothing in production calls them (each has no caller outside its own
//! file and the tests): `getCachedAiUsageTransactions` (with its `…:usage-receipts:v2:…` read
//! cache and the `…:usage-receipts:generation` counter that only it read: Rust neither writes
//! nor reads either key), `loadAiUsageLedgerTransactions`, `loadAiUsagePacingHistory`,
//! `hasAiUsageLedgerCoverage`. `persistAiUsageReceipt` and `refreshAiUsageDashboards` are ported
//! as the native worker runs them in production (it replaced their TypeScript callers).
//!
//! # Once and only once
//!
//! Nothing in the ledger is incremented. A receipt is stored once by its key (see
//! [`receipt`]); a day's totals and a dashboard are recomputed from the stored receipts, so a
//! repeated or interrupted write converges on the same documents: recording the same use again
//! changes no receipt and rebuilds the same day; a backfill that overlaps the queue upserts the
//! same keys. The account lock ([`lock`]) serialises the writers of one channel and customer.
//!
//! # Stores and limits
//!
//! Every MongoDB operation has a server time limit and a client deadline
//! ([`LedgerConfig`]); every read is bounded (a day range of at most 92 UTC days, a page, a
//! batch). Configuration is typed and the crate never reads the environment.

pub mod dashboard;
pub mod display;
pub mod history;
pub mod lock;
pub(crate) mod ops;
pub mod query;
pub mod receipt;
pub mod record;
pub mod report;
pub mod retention;
pub mod state;
pub mod zones;

use dima_core::{Clock, Random};
use dima_model::ai_usage_receipts::RetentionTier;
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use std::time::Duration;

pub use report::DAY_MS;

/// `AI_USAGE_REPORT_VERSION`.
pub const REPORT_VERSION: i64 = 3;

/// `validTier(value)`: `premium` and `pro` are themselves, anything else is `free`.
pub fn valid_tier(value: Option<&str>) -> RetentionTier {
    match value {
        Some("premium") => RetentionTier::Premium,
        Some("pro") => RetentionTier::Pro,
        _ => RetentionTier::Free,
    }
}

/// `getAiUsageRetentionDays(planTier)`: 30 for Free (and anything unknown), 60 for Premium, 90
/// for Pro.
pub fn retention_days(tier: RetentionTier) -> i64 {
    match tier {
        RetentionTier::Free => 30,
        RetentionTier::Premium => 60,
        RetentionTier::Pro => 90,
    }
}

/// The ledger's limits.
#[derive(Clone, Debug)]
pub struct LedgerConfig {
    /// How long a writer waits for the account lock (`10_000` ms in the reference).
    pub lock_wait: Duration,
    /// How often it tries meanwhile (50 ms).
    pub lock_retry: Duration,
    /// The server time limit of each MongoDB operation (`maxTimeMS`; 10 s, the most the plan
    /// effects allow).
    pub max_time_ms: u64,
    /// The client deadline of each MongoDB operation (15 s: the server limit and a margin).
    pub op_deadline: Duration,
    /// The documents one retention step changes at most (500).
    pub retention_batch: i64,
    /// The receipts one backfill write sends at most (500, the reference's batch).
    pub backfill_batch: usize,
    /// How long recording a receipt waits for the owner's plan effects lease (2.5 s, a plan
    /// write's own wait) before it answers [`LedgerError::PlanChanging`] (item 4 of
    /// P2-BILLING-02c: the consumer then leaves the receipt for its next call).
    pub plan_lease_wait: Duration,
    /// How long a backfill waits for it (75 s: longer than a plan change's effects,
    /// `EFFECTS_DEADLINE` and a lease's lifetime, so a backfill job is not failed by one).
    pub backfill_plan_lease_wait: Duration,
}

impl Default for LedgerConfig {
    fn default() -> Self {
        Self {
            lock_wait: Duration::from_secs(10),
            lock_retry: Duration::from_millis(50),
            max_time_ms: 10_000,
            op_deadline: Duration::from_secs(15),
            retention_batch: 500,
            backfill_batch: 500,
            plan_lease_wait: crate::plans::projection::EFFECTS_LEASE_WAIT,
            backfill_plan_lease_wait: Duration::from_secs(75),
        }
    }
}

/// Called before every write the ledger makes, with the write's name. Production passes
/// [`NoBoundary`]; the fault tests stop a run at a chosen write (the future is dropped there,
/// as a killed process would stop) and run it again.
pub trait WriteBoundary: Send + Sync {
    /// Resolves when the write may go ahead.
    fn reached<'a>(&'a self, point: &'static str) -> BoxFuture<'a, ()>;
}

/// Every write goes ahead at once.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoBoundary;

impl WriteBoundary for NoBoundary {
    fn reached<'a>(&'a self, _point: &'static str) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

/// Why a ledger operation failed.
#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    /// The account lock stayed taken for [`LedgerConfig::lock_wait`].
    #[error("AI usage ledger busy; retry later")]
    Busy,
    /// The account lock passed to another writer before a write: nothing more was written.
    #[error("AI usage ledger lease lost; retry required")]
    LeaseLost,
    /// A plan change of the channel's owner holds the owner's plan effects lease: nothing was
    /// written; retry once it is done (item 4 of P2-BILLING-02c).
    #[error("a plan change of this channel's owner is running; retry later")]
    PlanChanging,
    /// No randomness for a lock token.
    #[error("randomness unavailable")]
    Random,
    /// The model refused the write.
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    /// A prepared write lost paths the schema does not know (a bug in the caller).
    #[error("{collection}: unknown paths {paths:?}")]
    Dropped {
        /// The collection.
        collection: String,
        /// The paths.
        paths: Vec<String>,
    },
    /// MongoDB failed or refused.
    #[error("MongoDB: {0}")]
    Mongo(String),
    /// A stored document does not have the shape the reference reads.
    #[error("malformed {0}")]
    Malformed(&'static str),
    /// A MongoDB operation passed its client deadline.
    #[error("{0} timed out")]
    Timeout(&'static str),
    /// Dragonfly failed.
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
}

/// What the ledger works with.
#[derive(Clone, Copy)]
pub struct Ledger<'a> {
    /// MongoDB.
    pub mongo: &'a MongoStore,
    /// Dragonfly (the account lock).
    pub dragonfly: &'a Dragonfly,
    /// Write times, retention floors, freshness.
    pub clock: &'a dyn Clock,
    /// Lock tokens.
    pub random: &'a dyn Random,
    /// Limits.
    pub config: &'a LedgerConfig,
    /// The fault tests' stop points ([`NoBoundary`] in production).
    pub boundary: &'a dyn WriteBoundary,
}

impl std::fmt::Debug for Ledger<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ledger")
    }
}

impl Ledger<'_> {
    /// Waits at the write boundary `point` (see [`WriteBoundary`]).
    pub(crate) async fn boundary(&self, point: &'static str) {
        self.boundary.reached(point).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ai_usage_ledger.test.ts: "retention is 30 days for Free, 60 for Premium, and 90 for Pro"
    #[test]
    fn retention_is_30_days_for_free_60_for_premium_and_90_for_pro() {
        assert_eq!(retention_days(valid_tier(Some("free"))), 30);
        assert_eq!(retention_days(valid_tier(Some("premium"))), 60);
        assert_eq!(retention_days(valid_tier(Some("pro"))), 90);
        assert_eq!(retention_days(valid_tier(Some("unknown"))), 30);
        assert_eq!(retention_days(valid_tier(None)), 30);
    }
}
