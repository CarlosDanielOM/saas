//! The Dragonfly lease a worker may declare ([`crate::worker::Lease::Dragonfly`]): one process
//! at a time runs the worker.
//!
//! It is the TypeScript workers' `worker:*:lock` (for example `temporary_roles.worker.ts`):
//! `SET key owner NX EX ttl` when the worker starts, tried again every `retry` while another
//! process holds it; refreshed before every unit of work, and the worker stops (here: the run
//! ends and the supervisor restarts it) when it was lost; deleted when the worker stops. Two
//! changes, both on the side of safety: the owner is a random token rather than
//! `{pid}-{ms}`, and renewal and release compare the owner inside one script (the reference's
//! `GET` then `EXPIRE`, and `GET` then `DEL`, can extend or delete a lease that another process
//! took in between). The scripts have no loop (data rule 7).
//!
//! A renewal extends the lease to `ttl` from now, and one unit of work lasts at most its
//! deadline plus its grace ([`LeaseSpec::check`] requires the lease to be longer), so the lease
//! cannot expire under work that is still running while its process lives. A process that dies
//! leaves the key until it expires.
//!
//! The key is the reference's (`worker:<name>:lock`, or its setting) in Rust's own logical
//! database (charter section 3), so a Rust worker and its TypeScript twin in database 0 never see
//! each other's lease: the cutover keeps them apart by stopping the TypeScript cron first.

use dima_core::runtime::Deadline;
use dima_store::dragonfly::script::Script;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, SetCondition, SetExpiry, SetOptions, SetOutcome,
};
use std::time::Duration;

/// Extends the lease when it still holds the owner's token.
pub static RENEW: Script = Script::new(
    "RUST_CRON_LEASE_RENEW_SCRIPT",
    include_str!("lua/lease_renew.lua"),
);
/// Deletes the lease when it still holds the owner's token.
pub static RELEASE: Script = Script::new(
    "RUST_CRON_LEASE_RELEASE_SCRIPT",
    include_str!("lua/lease_release.lua"),
);

/// A worker's lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseSpec {
    /// The key, without the test prefix (`worker:temporary-roles:lock`).
    pub key: String,
    /// How long the lease lives after it is taken or renewed.
    pub ttl: Duration,
    /// How long a worker that did not get the lease waits before it tries again.
    pub retry: Duration,
}

impl LeaseSpec {
    /// The lease must outlive one unit of work, aborted work included.
    pub fn check(&self, deadline: Deadline) -> Result<(), String> {
        let longest = deadline.limit.saturating_add(deadline.grace);
        if self.ttl <= longest {
            return Err(format!(
                "lease {} lives {} ms, not longer than one unit of work ({} ms with its grace)",
                self.key,
                self.ttl.as_millis(),
                longest.as_millis()
            ));
        }
        if self.retry.is_zero() {
            return Err(format!("lease {} has no retry pause", self.key));
        }
        Ok(())
    }
}

/// A lease this process holds.
#[derive(Clone, Debug)]
pub struct Held {
    dragonfly: Dragonfly,
    key: String,
    token: String,
    ttl_ms: String,
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis())
        .unwrap_or(u64::MAX)
        .max(1)
}

impl Held {
    /// `SET key token NX PX ttl`: the lease when nobody holds it.
    pub async fn take(
        dragonfly: &Dragonfly,
        key: String,
        token: String,
        ttl: Duration,
    ) -> Result<Option<Self>, DragonflyError> {
        let options = SetOptions {
            condition: SetCondition::IfMissing,
            expiry: SetExpiry::Millis(millis(ttl)),
            get: false,
        };
        match dragonfly.set(&key, token.as_bytes(), options).await? {
            SetOutcome::Written => Ok(Some(Self {
                dragonfly: dragonfly.clone(),
                key,
                token,
                ttl_ms: millis(ttl).to_string(),
            })),
            _ => Ok(None),
        }
    }

    /// The key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Extends the lease to its lifetime from now; `false` when it is no longer this process's.
    pub async fn renew(&self) -> Result<bool, DragonflyError> {
        let renewed: i64 = RENEW
            .run(&self.dragonfly, &[&self.key], &[&self.token, &self.ttl_ms])
            .await?;
        Ok(renewed == 1)
    }

    /// Deletes the lease if it is still this process's; `false` when it was not.
    pub async fn release(&self) -> Result<bool, DragonflyError> {
        let released: i64 = RELEASE
            .run(&self.dragonfly, &[&self.key], &[&self.token])
            .await?;
        Ok(released == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scripts_pass_the_loop_check() {
        assert!(RENEW.check().is_ok());
        assert!(RELEASE.check().is_ok());
    }

    #[test]
    fn a_lease_must_outlive_one_unit_of_work() {
        let deadline = Deadline {
            limit: Duration::from_secs(50),
            grace: Duration::from_secs(5),
        };
        let lease = |ttl, retry| LeaseSpec {
            key: "worker:test:lock".to_owned(),
            ttl: Duration::from_secs(ttl),
            retry: Duration::from_secs(retry),
        };
        assert!(lease(60, 10).check(deadline).is_ok());
        assert!(lease(55, 10).check(deadline).is_err());
        assert!(lease(60, 0).check(deadline).is_err());
    }
}
