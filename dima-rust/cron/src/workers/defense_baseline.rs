//! Follow-defense baseline: one due channel's normal follow rate per unit of work
//! ([`dima_stream::defense_baseline::Baselines::process_defense_baseline`]): the read-only
//! aggregates over MongoDB, the value cached in Dragonfly for seven days.
//!
//! The loop is the native worker's that runs in production (`src/bin/follow_defense_baseline.rs`):
//!
//! | | |
//! |---|---|
//! | Schedule | continuous: [`crate::pacing::Burst`] |
//! | Per unit of work | the first channel of `follow:defense:baseline:due` whose time has come |
//! | Work found | the next at once, for bursts of 8 channels, each burst followed by 1 s |
//! | Nothing due | waits 1, 2, 4, then 5 s |
//! | Store error | logged and counted, then 1 s and the next unit of work (the due entry is the retry receipt; native: the same) |
//! | Deadline | 30 s, the native watchdog: the unit of work is aborted and joined and the run ends (native: the process exited non-zero); restarted after 5 s, growing |
//! | Lease | none, as the native worker: the due entry is moved 60 s ahead before the work (the crash receipt) and an hour ahead after it; MongoDB is only read and the cached value is a pure function of it at that time, so two processes refreshing one channel at once (both read the entry before either moved it) write the same value |
//! | Killed mid-unit | the entry comes due again 60 s later and the channel is refreshed then; an older value is never overwritten by a failed query |
//!
//! The keys are `follow:defense:baseline:{channel}` and the due set, in Rust's own logical
//! database (rebuilt at the cutover: a read of a missing or stale value requests a refresh), behind
//! `CRON_KEY_PREFIX` in tests. Not ported: the native 30 s health probe (due count and oldest due
//! age); the library has no health read.

use super::Deps;
use crate::pacing::Burst;
use crate::worker::{Lease, Pacing, Spec, TickFuture, Work, Worker};
use dima_core::runtime::{Deadline, WorkScope};
use dima_stream::defense_baseline::{Baselines, Config};
use std::time::Duration;

/// The worker's name.
pub const NAME: &str = "follow-defense-baseline";

/// The declaration.
pub static SPEC: Spec = Spec {
    name: NAME,
    telemetry: "follow_defense_baseline_rust",
    batch_metric: "batch_channels",
    // The native 30 s watchdog; with the grace, inside the 60 s crash receipt.
    deadline: Deadline {
        limit: Duration::from_secs(30),
        grace: Duration::from_secs(5),
    },
    lease: Lease::Unleased(
        "the due entry is moved 60 s ahead before the work; MongoDB is only read and the cached value is the same whoever computes it",
    ),
    enabled_env: None,
};

/// The worker.
pub struct DefenseBaselineWorker {
    baselines: Baselines,
}

impl DefenseBaselineWorker {
    /// Built on the process's stores and clock with the library's deadlines (MongoDB's own
    /// 10 s per aggregate, 30 s of wall time each, 5 s per cache command).
    pub fn new(deps: &Deps) -> Self {
        Self {
            baselines: Baselines::new(
                deps.mongo.clone(),
                deps.dragonfly.clone(),
                deps.clock.clone(),
                Config {
                    key_prefix: deps.key_prefix.clone(),
                    ..Config::default()
                },
            ),
        }
    }
}

impl Worker for DefenseBaselineWorker {
    fn spec(&self) -> &Spec {
        &SPEC
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        Box::new(Burst::default())
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        let baselines = self.baselines.clone();
        Box::pin(async move {
            let refreshed = baselines.process_defense_baseline().await?;
            Ok(Work::items(u64::from(refreshed)))
        })
    }
}
