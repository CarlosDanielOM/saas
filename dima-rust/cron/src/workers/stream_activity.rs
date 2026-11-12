//! Stream activity projection: pending `stream_activities` into `stream_activity_aggregates`,
//! one batch per unit of work ([`dima_stream::stream_activity::Activities::project_stream_activity_batch`]).
//!
//! The loop is the native worker's that runs in production (`src/bin/stream_activity.rs`,
//! started by the native registry with `--batch-size 500`):
//!
//! | | |
//! |---|---|
//! | Schedule | continuous: [`crate::pacing::IdleBackoff`] |
//! | Per unit of work | one batch of at most [`BATCH`] events (the registry's `--batch-size 500`) |
//! | Work found | the next batch at once (a backlog drains without waiting) |
//! | Nothing pending, or another process holds the lease | waits 1, 2, 4, then 5 s |
//! | Store error | the run ends; the supervisor restarts the worker after 5 s, growing (native: the process exited non-zero, restarted after 5 s) |
//! | Deadline | the library's own 45 s batch deadline answers first (an error, as above); [`SPEC`]'s 50 s is the backstop that aborts and joins a call that hangs, then the same restart |
//! | Lease | the library's, in MongoDB: `stream_activity_states/projector-v1` (`owner`, `leaseUntil`), 60 s, renewed every 10 s while the batch runs, released (owner-fenced) at the end; every write checks it and the aggregates are fenced by `lastSeq`. A fresh owner id per batch ([`OWNER_BYTES`] random bytes, hex) |
//! | Killed mid-batch | the checkpoint keeps the batch's members and sequence; the lease expires within 60 s and the next owner replays the same batch, which the `lastSeq` fence makes count once |
//!
//! The native health probe (every 30 s: oldest pending age, checkpoint) is not ported: the
//! library has no health read. The worker's `since_success_ms` and `runs` metrics stand in.
//! The native worker read no setting for this loop, so this one reads none.

use super::Deps;
use crate::pacing::IdleBackoff;
use crate::worker::{Lease, Pacing, Spec, TickFuture, Work, Worker};
use dima_core::Random;
use dima_core::runtime::{Deadline, WorkScope};
use dima_stream::stream_activity::{Activities, Config};
use std::sync::Arc;
use std::time::Duration;

/// The worker's name.
pub const NAME: &str = "stream-activity";
/// Events per batch (the native registry's `--batch-size 500`; the library clamps to 1-1000).
pub const BATCH: usize = 500;
/// Random bytes of an owner id (24 hex digits, as long as the native worker's ObjectId).
pub const OWNER_BYTES: usize = 12;

/// The declaration.
pub static SPEC: Spec = Spec {
    name: NAME,
    telemetry: "stream_activity_rust",
    batch_metric: "batch_events",
    // Above the library's 45 s batch deadline; with the grace, below its 60 s lease.
    deadline: Deadline {
        limit: Duration::from_secs(50),
        grace: Duration::from_secs(5),
    },
    lease: Lease::Library(
        "MongoDB stream_activity_states/projector-v1: 60 s, renewed every 10 s, owner-fenced writes, lastSeq-fenced aggregates",
    ),
    enabled_env: None,
};

/// The worker.
pub struct StreamActivityWorker {
    activities: Activities,
    random: Arc<dyn Random>,
}

impl StreamActivityWorker {
    /// Built on the process's MongoDB and clock with the library's default deadlines (5 s per
    /// store call, 45 s per batch).
    pub fn new(deps: &Deps) -> Result<Self, String> {
        Ok(Self {
            activities: Activities::new(deps.mongo.clone(), deps.clock.clone(), Config::default())
                .map_err(|error| error.to_string())?,
            random: deps.random.clone(),
        })
    }
}

impl Worker for StreamActivityWorker {
    fn spec(&self) -> &Spec {
        &SPEC
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        Box::new(IdleBackoff::default())
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        let activities = self.activities.clone();
        let owner = self.random.hex_token(OWNER_BYTES);
        Box::pin(async move {
            let owner = owner?;
            let projected = activities
                .project_stream_activity_batch(BATCH, &owner)
                .await?;
            Ok(Work::items(projected))
        })
    }
}
