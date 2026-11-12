//! The receipt consumer: one batch per call (the worker that calls it on a schedule is another
//! package). Reference: `AiUsageReceipts::run_batch` and `process_next` of the native worker.
//!
//! A call takes the consumer lease (no wait: another consumer means [`SettleEnd::Busy`]),
//! claims up to [`ConsumerConfig::batch_size`] jobs (an earlier consumer's unsettled ones
//! first) and settles them one by one, each within [`ConsumerConfig::job_deadline`] and with
//! the lease renewed before it:
//!
//! - a job that is not a receipt goes to the dead-letter list at once (one attempt);
//! - a receipt is recorded with the plan of the channel's owner (read once per call; the native
//!   worker cached it for a minute) through [`crate::usage_ledger::Ledger::persist_receipt`],
//!   then settled; recording it again is a no-op (its key), so a job resumed after a stop is
//!   harmless;
//! - a failure counts an attempt: back to the queue tail, or to the dead-letter list after the
//!   third.
//!
//! A job that passes its deadline is abandoned where it is (still claimed) and the call ends
//! with [`SettleEnd::Timeout`] **without releasing the lease**: nothing else takes the
//! processing list until the lease expires, by which time the abandoned operations have ended
//! (each MongoDB operation has a 10 s server limit; the native worker exited the process for
//! the same reason). The call also stops claiming work once [`ConsumerConfig::tick_deadline`]
//! has passed, leaving what it claimed for the next call to resume.
//!
//! A dead-lettered receipt is never applied by the queue; the backfill restores it from
//! Polar's copy of the usage (same entry id), and an operator may move it back to the queue.

use crate::Observer;
use crate::usage_ledger::receipt::parse_queued_receipt;
use crate::usage_ledger::record::Persisted;
use crate::usage_ledger::{Ledger, LedgerError, ops, valid_tier};
use crate::usage_queue::{self, Failed, QueueKeys};
use bson::doc;
use dima_core::Random;
use dima_model::ai_usage_receipts::RetentionTier;
use dima_store::dragonfly::DragonflyError;
use std::collections::HashMap;
use std::time::Duration;

/// The consumer's settings.
#[derive(Clone, Debug)]
pub struct ConsumerConfig {
    /// `AI_USAGE_RECEIPTS_BATCH_SIZE` (200; 1 to 1,000, a fraction rounded up).
    pub batch_size: usize,
    /// The consumer lease (`AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS`, 300 s, at least 30 s).
    pub lease_ms: u64,
    /// One job's deadline (the native worker's 20 s active-unit limit).
    pub job_deadline: Duration,
    /// After this long a call claims nothing more (60 s).
    pub tick_deadline: Duration,
    /// Attempts before the dead-letter list (3).
    pub max_attempts: u32,
}

impl Default for ConsumerConfig {
    fn default() -> Self {
        Self {
            batch_size: 200,
            lease_ms: 300_000,
            job_deadline: Duration::from_secs(20),
            tick_deadline: Duration::from_secs(60),
            max_attempts: 3,
        }
    }
}

/// How a call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleEnd {
    /// Fewer jobs than a batch were waiting: the queue is empty for now.
    Drained,
    /// A whole batch was settled: more may wait (the native worker continued at once).
    Full,
    /// Another consumer holds the lease.
    Busy,
    /// The lease passed to another consumer during the call; it owns what is left.
    LeaseLost,
    /// [`ConsumerConfig::tick_deadline`] passed; the rest stays claimed for the next call.
    Deadline,
    /// A job passed its deadline (see the module docs).
    Timeout,
}

/// What one call did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleReport {
    /// Jobs claimed (resumed ones included).
    pub claimed: usize,
    /// Of which resumed from an earlier consumer.
    pub resumed: usize,
    /// Receipts stored.
    pub inserted: usize,
    /// Receipts already stored.
    pub duplicates: usize,
    /// Receipts past their retention (not stored).
    pub expired: usize,
    /// Jobs requeued after a failure.
    pub retried: usize,
    /// Jobs moved to the dead-letter list.
    pub dead_lettered: usize,
    /// How it ended.
    pub end: SettleEnd,
}

impl SettleReport {
    fn new(end: SettleEnd) -> Self {
        Self {
            claimed: 0,
            resumed: 0,
            inserted: 0,
            duplicates: 0,
            expired: 0,
            retried: 0,
            dead_lettered: 0,
            end,
        }
    }

    /// Whether every claimed job was settled cleanly and a whole batch was taken (the native
    /// worker's `ready`: the next call may follow at once).
    pub fn ready(&self) -> bool {
        self.end == SettleEnd::Full && self.retried == 0 && self.dead_lettered == 0
    }
}

/// Why a call failed (Dragonfly; MongoDB failures are attempts of the job).
#[derive(Debug, thiserror::Error)]
pub enum ConsumerError {
    /// Dragonfly failed: what is claimed stays claimed for the next call.
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
}

/// The consumer.
#[derive(Clone, Copy)]
pub struct ReceiptConsumer<'a> {
    /// The ledger (and its stores).
    pub ledger: Ledger<'a>,
    /// Keys.
    pub keys: &'a QueueKeys,
    /// Settings.
    pub config: &'a ConsumerConfig,
    /// Lease tokens.
    pub random: &'a dyn Random,
    /// Failures the reference logged.
    pub observer: &'a dyn Observer,
}

impl std::fmt::Debug for ReceiptConsumer<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReceiptConsumer")
    }
}

/// `pro` and `premium` are themselves; anything else, or no owner, is `free`.
async fn plan_of(ledger: &Ledger<'_>, channel: &str) -> Result<RetentionTier, LedgerError> {
    let user = ops::find_one(
        ledger,
        dima_model::users::COLLECTION,
        doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": channel } } },
        Some(doc! { "plan_tier": 1 }),
    )
    .await?;
    Ok(valid_tier(
        user.as_ref().and_then(|u| u.get_str("plan_tier").ok()),
    ))
}

impl ReceiptConsumer<'_> {
    /// Settles one batch (see the module docs).
    pub async fn settle_batch(&self) -> Result<SettleReport, ConsumerError> {
        let dragonfly = self.ledger.dragonfly;
        let Some(lease) = usage_queue::acquire(
            dragonfly,
            self.keys,
            self.random,
            self.config.lease_ms.max(30_000),
        )
        .await?
        else {
            return Ok(SettleReport::new(SettleEnd::Busy));
        };
        let report = self.settle_leased(&lease).await;
        match &report {
            Ok(report) if report.end == SettleEnd::Timeout => {}
            _ => usage_queue::release(dragonfly, self.keys, &lease).await,
        }
        report
    }

    async fn settle_leased(
        &self,
        lease: &usage_queue::Lease,
    ) -> Result<SettleReport, ConsumerError> {
        let dragonfly = self.ledger.dragonfly;
        let started = tokio::time::Instant::now();
        let batch = self.config.batch_size.clamp(1, 1000);
        let lease_ms = self.config.lease_ms.max(30_000);
        let now = self.ledger.clock.now_ms();
        let Some((resumed, jobs)) =
            usage_queue::claim(dragonfly, self.keys, lease, batch, now).await?
        else {
            return Ok(SettleReport::new(SettleEnd::LeaseLost));
        };
        let mut report = SettleReport::new(if jobs.len() >= batch {
            SettleEnd::Full
        } else {
            SettleEnd::Drained
        });
        report.claimed = jobs.len();
        report.resumed = resumed;
        let mut plans: HashMap<String, RetentionTier> = HashMap::new();
        for job in jobs {
            if started.elapsed() >= self.config.tick_deadline {
                report.end = SettleEnd::Deadline;
                return Ok(report);
            }
            if !usage_queue::extend(dragonfly, self.keys, lease, lease_ms).await? {
                report.end = SettleEnd::LeaseLost;
                return Ok(report);
            }
            let Some(receipt) = parse_queued_receipt(job.as_bytes()) else {
                match usage_queue::fail(dragonfly, self.keys, lease, &job, 1).await? {
                    None => {
                        report.end = SettleEnd::LeaseLost;
                        return Ok(report);
                    }
                    Some(_) => report.dead_lettered += 1,
                }
                self.observer.error(
                    "ai_usage_receipts",
                    "invalid AI usage receipt moved to the dead-letter list",
                );
                continue;
            };
            let attempt = tokio::time::timeout(self.config.job_deadline, async {
                let tier = match plans.get(&receipt.channel_id) {
                    Some(tier) => *tier,
                    None => {
                        let tier = plan_of(&self.ledger, &receipt.channel_id).await?;
                        plans.insert(receipt.channel_id.clone(), tier);
                        tier
                    }
                };
                self.ledger.persist_receipt(&receipt, tier).await
            })
            .await;
            let Ok(outcome) = attempt else {
                report.end = SettleEnd::Timeout;
                self.observer.error(
                    "ai_usage_receipts",
                    "AI usage active work timed out; leases retained for recovery",
                );
                return Ok(report);
            };
            match outcome {
                Ok(persisted) => {
                    if !usage_queue::complete(dragonfly, self.keys, lease, &job).await? {
                        report.end = SettleEnd::LeaseLost;
                        return Ok(report);
                    }
                    match persisted {
                        Persisted::Inserted => report.inserted += 1,
                        Persisted::Duplicate => report.duplicates += 1,
                        Persisted::Expired => report.expired += 1,
                    }
                }
                Err(error) => {
                    self.observer.error(
                        "ai_usage_receipts",
                        &format!("Receipt persistence failed; requeued or retained in dead letters: {error}"),
                    );
                    match usage_queue::fail(
                        dragonfly,
                        self.keys,
                        lease,
                        &job,
                        self.config.max_attempts.max(1),
                    )
                    .await?
                    {
                        None => {
                            report.end = SettleEnd::LeaseLost;
                            return Ok(report);
                        }
                        Some(Failed::DeadLettered) => report.dead_lettered += 1,
                        Some(Failed::Requeued) => report.retried += 1,
                        Some(Failed::Missing) => {}
                    }
                }
            }
        }
        Ok(report)
    }
}
