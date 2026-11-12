//! The worker table: every worker of the cron, in start order.
//!
//! Adding a worker (P2-CRON-02, P4-CRON-LEDGERS, P4-CRON-MONEY, P4-CRON-FEATURES,
//! P4-CRON-RECAP): write a module here that implements [`crate::worker::Worker`] around one
//! library call (its [`crate::worker::Spec`] states the name, the deadline, the lease and the
//! reference's off switch; its pacing is one of [`crate::pacing`] or its own), then add one line
//! to [`TABLE`] and one arm to [`build`]. If it needs a store or client the table does not have
//! yet, add it to [`Deps`] and to the wiring in [`crate::app`]; if it reads settings, add them to
//! [`crate::config`]. Nothing else changes.
//!
//! The order follows the native supervisor's registry (`src/supervisor/registry.rs`), then the
//! Rust-only token recovery.

pub mod defense_baseline;
pub mod raid_analytics;
pub mod stream_activity;
pub mod token_recovery;

use crate::worker::Worker;
use dima_core::{Clock, Random};
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_twitch::Twitch;
use std::sync::Arc;

/// Every worker: its name and the reference's setting that turns it off when exactly `false`.
pub const TABLE: &[(&str, Option<&str>)] = &[
    // P2-CRON-02: dashboard-activity.
    (raid_analytics::NAME, None),
    (stream_activity::NAME, None),
    // roulette-completion goes here. Its native worker (`src/workers/roulette_completion.rs`,
    // `bin/roulette_completion.rs`: at most 100 due rows per pass by `dueAt`, ready work at
    // once, else a 1 s poll, a revision compare-and-set of at most 20 attempts, a 20 s pass
    // watchdog that ended the process) moves here when the roulette library lands (P4-FEAT-GAMES).
    (defense_baseline::NAME, None),
    // P2-CRON-02: raid-sessions, ai-usage-receipts (`AI_USAGE_RECEIPTS_ENABLED`).
    (token_recovery::NAME, None),
];

/// What the workers are built from (one of each per process).
#[derive(Clone, Debug)]
pub struct Deps {
    /// MongoDB.
    pub mongo: MongoStore,
    /// Rust's logical database of Dragonfly.
    pub dragonfly: Dragonfly,
    /// The process's Twitch handle.
    pub twitch: Twitch,
    /// The wall clock of the work (business time).
    pub clock: Arc<dyn Clock>,
    /// Randomness (owner ids).
    pub random: Arc<dyn Random>,
    /// `CRON_KEY_PREFIX`: in front of every Dragonfly key the workers own (empty in production).
    pub key_prefix: String,
}

/// The workers named, in the table's order.
pub fn build(names: &[&str], deps: &Deps) -> Result<Vec<Arc<dyn Worker>>, String> {
    let mut workers: Vec<Arc<dyn Worker>> = Vec::new();
    for (name, _) in TABLE {
        if !names.contains(name) {
            continue;
        }
        let worker: Arc<dyn Worker> = match *name {
            raid_analytics::NAME => Arc::new(raid_analytics::RaidAnalyticsWorker::new(deps)?),
            stream_activity::NAME => Arc::new(stream_activity::StreamActivityWorker::new(deps)?),
            defense_baseline::NAME => Arc::new(defense_baseline::DefenseBaselineWorker::new(deps)),
            token_recovery::NAME => Arc::new(token_recovery::TokenRecoveryWorker::new(deps)),
            other => return Err(format!("no worker is named {other}")),
        };
        workers.push(worker);
    }
    Ok(workers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::Lease;

    #[test]
    fn every_declaration_is_consistent() {
        let specs = [
            &stream_activity::SPEC,
            &raid_analytics::SPEC,
            &defense_baseline::SPEC,
            &token_recovery::SPEC,
        ];
        assert_eq!(specs.len(), TABLE.len());
        for spec in specs {
            assert!(
                TABLE.iter().any(|(name, _)| *name == spec.name),
                "{} is not in the table",
                spec.name
            );
            assert!(!spec.deadline.limit.is_zero() && !spec.deadline.grace.is_zero());
            match &spec.lease {
                Lease::Dragonfly(lease) => assert!(lease.check(spec.deadline).is_ok()),
                Lease::Library(what) | Lease::Unleased(what) => assert!(!what.is_empty()),
            }
        }
        let mut names: Vec<&str> = TABLE.iter().map(|(name, _)| *name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), TABLE.len());
    }
}
