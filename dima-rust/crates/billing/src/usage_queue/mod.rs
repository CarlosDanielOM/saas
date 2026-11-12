//! The job queue pattern the receipt queue and the backfill queue share
//! (`utils/ai_usage_queue_health.ts`: `claimUsageJob`, `completeUsageJob`, `failUsageJob`; the
//! native worker's `queue.rs`), fenced by a consumer lease.
//!
//! Lists: the queue (`RPUSH` by producers, claimed from the head), the processing list (what a
//! consumer has claimed and not settled), the dead-letter list (jobs that failed their last
//! attempt, raw bytes, never trimmed). Per job, an attempt counter
//! `{queue}:attempts:{sha256 hex of the job's bytes}` (7 days). Per queue, the health hash
//! `ai-usage:queue-health:{name}` (`processingSince`, `failures`, and the monitor's own fields).
//!
//! Differences from the reference, all about who may move a job:
//!
//! - **One consumer at a time, fenced.** A consumer holds `lease` (a random token, `SET NX PX`)
//!   and every move it makes is a Lua script that first checks the token (`FencedTransition`):
//!   a consumer whose lease passed to another cannot settle, requeue or dead-letter anything.
//!   The native worker held a lock too, but its moves were not fenced.
//! - **Resume, not reclaim.** A claim first takes back what the processing list holds (an
//!   earlier consumer stopped before settling it), then tops it up from the queue head. The
//!   reference moved the whole processing list back to the queue at start-up, with a loop that
//!   had no bound (`RECLAIM_SCRIPT`); nothing here loops without one.
//! - Jobs are carried as the bytes that were read (data rule 6): settled and requeued by them.
//!
//! What makes a job safe to run twice is the job itself: a receipt is an upsert on its key, a
//! backfill rewrites what Polar holds. A job is therefore never lost by a stop: it is in the
//! queue, the processing list or the dead-letter list at every moment.

use dima_core::Random;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, End, Fence, FencedTransition, ProcessingList, QueueItem,
    SetCondition, SetExpiry, SetOptions, SetOutcome, Transition,
};
use sha2::{Digest, Sha256};
use std::borrow::Cow;

/// How long a job's attempt counter lives (`604800` s).
pub const ATTEMPTS_TTL_SECONDS: u64 = 604_800;

static CLAIM: FencedTransition =
    FencedTransition::new("USAGE_QUEUE_CLAIM", include_str!("lua/claim.lua"));
static COMPLETE: FencedTransition =
    FencedTransition::new("USAGE_QUEUE_COMPLETE", include_str!("lua/complete.lua"));
static FAIL: FencedTransition =
    FencedTransition::new("USAGE_QUEUE_FAIL", include_str!("lua/fail.lua"));
static EXTEND: FencedTransition = FencedTransition::new(
    "USAGE_QUEUE_LEASE_EXTEND",
    include_str!("lua/lease_extend.lua"),
);
static RELEASE: FencedTransition = FencedTransition::new(
    "USAGE_QUEUE_LEASE_RELEASE",
    include_str!("lua/lease_release.lua"),
);

/// Every script of the pattern, for the tests that check them.
pub fn scripts() -> [&'static FencedTransition; 5] {
    [&CLAIM, &COMPLETE, &FAIL, &EXTEND, &RELEASE]
}

/// The keys of one queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueKeys {
    /// The queue's name in health reports (`receipts`, `backfills`).
    pub name: &'static str,
    /// The queue.
    pub queue: String,
    /// The processing list.
    pub processing: String,
    /// The dead-letter list.
    pub dead: String,
    /// The consumer lease.
    pub lease: String,
    /// The health hash.
    pub health: String,
}

impl QueueKeys {
    /// `{queue}:attempts:{sha256 hex of the job}`.
    pub fn attempts(&self, job: &[u8]) -> String {
        format!(
            "{}:attempts:{}",
            self.queue,
            hex::encode(Sha256::digest(job))
        )
    }

    /// `{health}:snapshot`.
    pub fn snapshot(&self) -> String {
        format!("{}:snapshot", self.health)
    }

    /// `{health}:alert`.
    pub fn alert(&self) -> String {
        format!("{}:alert", self.health)
    }

    fn processing_list(&self) -> ProcessingList {
        ProcessingList::new(Cow::Owned(self.processing.clone()), End::Right)
    }
}

/// A held consumer lease.
pub struct Lease {
    key: String,
    owner: String,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Lease")
    }
}

impl Lease {
    fn fence(&self) -> Fence<'_> {
        Fence {
            lease_key: &self.key,
            owner: self.owner.as_bytes(),
        }
    }
}

/// How a failed job ended (`failUsageJob`'s answer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failed {
    /// Back at the queue tail for another attempt.
    Requeued,
    /// In the dead-letter list.
    DeadLettered,
    /// It was no longer in the processing list.
    Missing,
}

fn no_token() -> DragonflyError {
    DragonflyError::Reply("lease token unavailable")
}

/// Takes the queue's consumer lease (one try, no wait); `None` when another consumer has it.
pub(crate) async fn acquire(
    dragonfly: &Dragonfly,
    keys: &QueueKeys,
    random: &dyn Random,
    ttl_ms: u64,
) -> Result<Option<Lease>, DragonflyError> {
    let owner = random.uuid_v4().map_err(|_| no_token())?;
    let options = SetOptions {
        condition: SetCondition::IfMissing,
        expiry: SetExpiry::Millis(ttl_ms),
        get: false,
    };
    Ok((dragonfly
        .set(&keys.lease, owner.as_bytes(), options)
        .await?
        == SetOutcome::Written)
        .then(|| Lease {
            key: keys.lease.clone(),
            owner,
        }))
}

/// Renews the lease to `ttl_ms`; `false` when it is no longer ours.
pub(crate) async fn extend(
    dragonfly: &Dragonfly,
    keys: &QueueKeys,
    lease: &Lease,
    ttl_ms: u64,
) -> Result<bool, DragonflyError> {
    let ttl = ttl_ms.to_string();
    Ok(EXTEND
        .run(
            dragonfly,
            lease.fence(),
            &keys.processing_list(),
            &QueueItem::from_popped(Vec::new()),
            &[],
            &[ttl.as_bytes()],
        )
        .await?
        != Transition::LeaseLost)
}

/// Releases the lease if it is still ours (a failed release expires on its own).
pub(crate) async fn release(dragonfly: &Dragonfly, keys: &QueueKeys, lease: &Lease) {
    let _ = RELEASE
        .run(
            dragonfly,
            lease.fence(),
            &keys.processing_list(),
            &QueueItem::from_popped(Vec::new()),
            &[],
            &[],
        )
        .await;
}

/// Claims up to `most` jobs (resumed ones first): `(resumed, jobs)`, or `None` when the lease
/// is not ours.
pub(crate) async fn claim(
    dragonfly: &Dragonfly,
    keys: &QueueKeys,
    lease: &Lease,
    most: usize,
    now_ms: i64,
) -> Result<Option<(usize, Vec<QueueItem>)>, DragonflyError> {
    let (most, now) = (most.to_string(), now_ms.to_string());
    let claimed = CLAIM
        .run(
            dragonfly,
            lease.fence(),
            &keys.processing_list(),
            &QueueItem::from_popped(Vec::new()),
            &[&keys.queue, &keys.health],
            &[most.as_bytes(), now.as_bytes()],
        )
        .await?;
    let Transition::Applied(value) = claimed else {
        return Ok(None);
    };
    let mut parts = reply::array(value)?.into_iter();
    let (Some(resumed), Some(items), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(DragonflyError::Reply("unexpected claim reply"));
    };
    let resumed = usize::try_from(reply::int(resumed)?).unwrap_or(0);
    let items = reply::array(items)?
        .into_iter()
        .map(|item| reply::bytes(item).map(QueueItem::from_popped))
        .collect::<Result<_, _>>()?;
    Ok(Some((resumed, items)))
}

/// Settles a job (`completeUsageJob`); `false` when the lease is not ours.
pub(crate) async fn complete(
    dragonfly: &Dragonfly,
    keys: &QueueKeys,
    lease: &Lease,
    job: &QueueItem,
) -> Result<bool, DragonflyError> {
    let attempts = keys.attempts(job.as_bytes());
    Ok(COMPLETE
        .run(
            dragonfly,
            lease.fence(),
            &keys.processing_list(),
            job,
            &[&attempts],
            &[],
        )
        .await?
        != Transition::LeaseLost)
}

/// Counts a failed attempt (`failUsageJob`); `None` when the lease is not ours.
pub(crate) async fn fail(
    dragonfly: &Dragonfly,
    keys: &QueueKeys,
    lease: &Lease,
    job: &QueueItem,
    most_attempts: u32,
) -> Result<Option<Failed>, DragonflyError> {
    let attempts = keys.attempts(job.as_bytes());
    let (most, ttl) = (most_attempts.to_string(), ATTEMPTS_TTL_SECONDS.to_string());
    let outcome = FAIL
        .run(
            dragonfly,
            lease.fence(),
            &keys.processing_list(),
            job,
            &[&keys.queue, &keys.dead, &attempts, &keys.health],
            &[most.as_bytes(), ttl.as_bytes()],
        )
        .await?;
    let Transition::Applied(value) = outcome else {
        return Ok(None);
    };
    Ok(Some(match reply::int(value)? {
        2 => Failed::DeadLettered,
        1 => Failed::Requeued,
        _ => Failed::Missing,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_script_is_fenced_and_bounded() {
        for script in scripts() {
            assert!(script.check().is_ok(), "{}", script.script().name());
        }
    }
}
