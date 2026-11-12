//! Twitch token recovery: every five minutes, the recovery records of token exchanges that
//! MongoDB has not taken yet are reconciled into MongoDB ([`dima_twitch::Twitch::reconcile_recovery`],
//! P2-TWITCH-01c). The start-up run ([`dima_twitch::Twitch::start_recovery`], holding the start
//! at most 3 s) is part of the process's start ([`crate::app`]), so the first tick comes one
//! period later.
//!
//! | | |
//! |---|---|
//! | Schedule | [`crate::pacing::Every`] [`dima_twitch::Timings::recovery_interval`] (5 min), first after one period |
//! | Per unit of work | one complete reconciliation (a `SCAN` of the record keys, each record compared with MongoDB and written or removed) |
//! | Nothing to do | the next run one period later |
//! | Error (the scan could not finish) | logged and counted by the library and here; the next period runs it again |
//! | Deadline | 4 min, inside the period; the run is safe to interrupt (the next one finishes it) |
//! | Lease | the library's: its writes are compare-and-set and its removals compare-and-delete, safe from several processes at once; one run at a time per process |
//!
//! Rust only: the reference has no recovery records. The operator commands of the rollback
//! procedure are [`crate::recovery`].

use super::Deps;
use crate::pacing::Every;
use crate::worker::{Lease, Pacing, Spec, TickFuture, Work, Worker};
use dima_core::runtime::{Deadline, WorkScope};
use dima_twitch::Twitch;
use std::time::Duration;

/// The worker's name.
pub const NAME: &str = "token-recovery";

/// The declaration.
pub static SPEC: Spec = Spec {
    name: NAME,
    telemetry: "token_recovery_rust",
    batch_metric: "batch_records",
    deadline: Deadline {
        limit: Duration::from_secs(240),
        grace: Duration::from_secs(5),
    },
    lease: Lease::Library(
        "compare-and-set writes and compare-and-delete removals, safe from several processes at once",
    ),
    enabled_env: None,
};

/// The worker.
pub struct TokenRecoveryWorker {
    twitch: Twitch,
}

impl TokenRecoveryWorker {
    /// Built on the process's Twitch handle.
    pub fn new(deps: &Deps) -> Self {
        Self {
            twitch: deps.twitch.clone(),
        }
    }
}

impl Worker for TokenRecoveryWorker {
    fn spec(&self) -> &Spec {
        &SPEC
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        let period = self.twitch.config().timings.recovery_interval;
        Box::new(Every {
            first: period,
            period,
        })
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        let twitch = self.twitch.clone();
        Box::pin(async move {
            let report = twitch.reconcile_recovery().await?;
            Ok(Work::items(
                report.applied + report.already_newer + report.account_gone,
            ))
        })
    }
}
