//! Raid analytics summary projection: one due channel's summary per unit of work
//! ([`dima_stream::raid_analytics::RaidAnalytics::project_raid_summary_once`]).
//!
//! The loop is the native worker's that runs in production (`src/bin/raid_analytics.rs`):
//!
//! | | |
//! |---|---|
//! | Schedule | continuous: [`crate::pacing::IdleBackoff`] |
//! | Per unit of work | one channel (at most 25 follow windows, five queries at a time: the library's) |
//! | Work found | the next channel at once |
//! | Nothing due | waits 1, 2, 4, then 5 s |
//! | Store error | the run ends; the supervisor restarts the worker after 5 s, growing (native: the process exited non-zero); the library has already marked the channel `error` and due again in 30 s |
//! | Deadline | the library's 45 s pass deadline answers first (an error, as above); [`SPEC`]'s 50 s is the backstop that aborts and joins a hung call |
//! | Lease | the library's, in MongoDB, per channel: `raid_analytics_summaries/{channel}` (`owner`, `leaseUntil`), 60 s on the wall clock, renewed every 10 s, owner-fenced writes and release, `dirtyAt`-fenced publication. A fresh owner id per pass ([`OWNER_BYTES`] random bytes, hex) |
//! | Killed mid-pass | the summary keeps its `rustPending` receipt; the lease expires within 60 s and the next pass repairs it |
//!
//! **Pacing difference.** The library answers whether the summary changed, not whether a
//! channel was claimed, so a claimed channel whose summary did not change counts as idle here and
//! is followed by the idle pause; the native worker went on at once (it watched the release
//! phase). Due channels are still all handled, at most 5 s apart instead of back to back (in the
//! production copy 67 of the 95 summaries come due every 15 minutes for their repair). The
//! library would need to return "claimed" to restore it.
//!
//! Not ported: the native 30 s health probe (due channels, oldest due age); the library has no
//! health read.

use super::Deps;
use crate::pacing::IdleBackoff;
use crate::worker::{Lease, Pacing, Spec, TickFuture, Work, Worker};
use dima_core::runtime::{Deadline, WorkScope};
use dima_core::{Random, SystemClock};
use dima_stream::raid_analytics::{Config, RaidAnalytics};
use std::sync::Arc;
use std::time::Duration;

/// The worker's name.
pub const NAME: &str = "raid-analytics";
/// Random bytes of an owner id.
pub const OWNER_BYTES: usize = 12;

/// The declaration.
pub static SPEC: Spec = Spec {
    name: NAME,
    telemetry: "raid_analytics_rust",
    batch_metric: "batch_channels",
    // Above the library's 45 s pass deadline; with the grace, below its 60 s lease.
    deadline: Deadline {
        limit: Duration::from_secs(50),
        grace: Duration::from_secs(5),
    },
    lease: Lease::Library(
        "MongoDB raid_analytics_summaries per channel: 60 s, renewed every 10 s, owner-fenced writes, dirtyAt-fenced publication",
    ),
    enabled_env: None,
};

/// The worker.
pub struct RaidAnalyticsWorker {
    raids: RaidAnalytics,
    random: Arc<dyn Random>,
}

impl RaidAnalyticsWorker {
    /// Built on the process's MongoDB with the library's default deadlines (30 s per store
    /// call, 45 s per pass). Business time is the process clock; the lease clock is always the
    /// wall clock, which the other processes' leases are compared with.
    pub fn new(deps: &Deps) -> Result<Self, String> {
        Ok(Self {
            raids: RaidAnalytics::new(
                deps.mongo.clone(),
                deps.clock.clone(),
                Arc::new(SystemClock),
                Config::default(),
            )
            .map_err(|error| error.to_string())?,
            random: deps.random.clone(),
        })
    }
}

impl Worker for RaidAnalyticsWorker {
    fn spec(&self) -> &Spec {
        &SPEC
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        Box::new(IdleBackoff::default())
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        let raids = self.raids.clone();
        let owner = self.random.hex_token(OWNER_BYTES);
        Box::pin(async move {
            let owner = owner?;
            let changed = raids.project_raid_summary_once(&owner).await?;
            Ok(Work::items(u64::from(changed)))
        })
    }
}
