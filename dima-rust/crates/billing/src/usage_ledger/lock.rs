//! The per-account write lock of the usage ledger (`withAiUsageLock`,
//! `dimabot/src/utils/ai_usage_lock.ts`; the native worker's `account_lease`).
//!
//! `locks:ai-usage-write:{sha256 hex of JSON.stringify([channelID, customerId])}` holds a random
//! owner token (`SET NX EX 120`), tried every 50 ms for 10 s, after which the write fails with
//! "AI usage ledger busy; retry later". Every writer of a channel's receipts, dailies and
//! dashboards takes it: the receipt consumer, the backfill, the dashboard's computation. The key
//! is a stored identity of the reference (its hash input is JavaScript's `JSON.stringify`,
//! written by `dima_text::to_js_json`), kept although Dragonfly is internal so the family stays
//! recognisable in the ledger.
//!
//! The reference renewed it every 30 s from a timer and noticed a lost lease only after its
//! writes. Here [`AccountLock::confirm`] renews it (fenced on the token, the reference's script)
//! immediately before every write, and a write whose lock was lost does not start: each
//! MongoDB operation has a server time limit far below the 120 s lifetime, so a lease confirmed
//! before an operation outlives it. Released only by its owner.
//!
//! A writer that stores a retention expiry also holds the channel owner's plan effects lease
//! (item 4 of P2-BILLING-02c, [`super::record`]); the lock carries it, so the same confirmation
//! renews both before every write and refuses when either passed to another holder, and the
//! release lets both go. The account lock is always taken first.

use super::{Ledger, LedgerError};
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{Script, SetCondition, SetExpiry, SetOptions, SetOutcome};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The lock's lifetime (`EX 120`; the renewal script carries the same number).
pub const LOCK_TTL_SECONDS: u64 = 120;

static EXTEND: Script = Script::new(
    "AI_USAGE_LOCK_HEARTBEAT",
    include_str!("lua/ledger_lock_extend.lua"),
);
static RELEASE: Script = Script::new(
    "AI_USAGE_LOCK_RELEASE",
    include_str!("lua/ledger_lock_release.lua"),
);

/// The lock's scripts, for the tests that check them.
pub fn scripts() -> [&'static Script; 2] {
    [&EXTEND, &RELEASE]
}

/// `locks:ai-usage-write:{sha256hex(JSON.stringify([channelID, customerId]))}`.
pub fn lock_key(channel_id: &str, customer_id: &str) -> String {
    let json = dima_text::to_js_json(&Value::Array(vec![
        Value::from(channel_id),
        Value::from(customer_id),
    ]));
    format!(
        "locks:ai-usage-write:{}",
        hex::encode(Sha256::digest(json.as_bytes()))
    )
}

/// A held account lock (with the owner's plan effects lease, when the writer took it).
pub struct AccountLock {
    key: String,
    owner: String,
    plan: Option<PlanLease>,
}

/// A held plan effects lease of the channel's owner ([`crate::plans::projection`]).
pub(crate) struct PlanLease {
    pub(crate) key: String,
    pub(crate) token: String,
}

impl std::fmt::Debug for AccountLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccountLock")
    }
}

impl AccountLock {
    /// Takes the lock of (`channel_id`, `customer_id`), waiting as the reference did.
    pub async fn acquire(
        ledger: &Ledger<'_>,
        channel_id: &str,
        customer_id: &str,
    ) -> Result<Self, LedgerError> {
        let key = lock_key(channel_id, customer_id);
        let owner = ledger.random.uuid_v4().map_err(|_| LedgerError::Random)?;
        let started = tokio::time::Instant::now();
        loop {
            let options = SetOptions {
                condition: SetCondition::IfMissing,
                expiry: SetExpiry::Seconds(LOCK_TTL_SECONDS),
                get: false,
            };
            if ledger
                .dragonfly
                .set(&key, owner.as_bytes(), options)
                .await?
                == SetOutcome::Written
            {
                return Ok(Self {
                    key,
                    owner,
                    plan: None,
                });
            }
            if started.elapsed() >= ledger.config.lock_wait {
                return Err(LedgerError::Busy);
            }
            tokio::time::sleep(ledger.config.lock_retry).await;
        }
    }

    /// Holds `lease` with the lock: confirmed and released with it.
    pub(crate) fn hold_plan(&mut self, lease: PlanLease) {
        self.plan = Some(lease);
    }

    /// Renews the lock (and the plan effects lease it holds) if both are still this owner's;
    /// [`LedgerError::LeaseLost`] otherwise. Called immediately before every write.
    pub async fn confirm(&self, ledger: &Ledger<'_>) -> Result<(), LedgerError> {
        let renewed = EXTEND
            .run_value(ledger.dragonfly, &[&self.key], &[self.owner.as_str()])
            .await?;
        if reply::int(renewed)? != 1 {
            return Err(LedgerError::LeaseLost);
        }
        if let Some(plan) = &self.plan
            && !crate::plans::projection::extend_owner_lease(
                ledger.dragonfly,
                &plan.key,
                &plan.token,
            )
            .await?
        {
            return Err(LedgerError::LeaseLost);
        }
        Ok(())
    }

    /// Releases the lock and the plan effects lease it holds, each if it is still this owner's
    /// (a failed release expires on its own).
    pub async fn release(self, ledger: &Ledger<'_>) {
        if let Some(plan) = &self.plan {
            crate::plans::projection::release_owner_lease(ledger.dragonfly, &plan.key, &plan.token)
                .await;
        }
        let _ = RELEASE
            .run_value(ledger.dragonfly, &[&self.key], &[self.owner.as_str()])
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_hashes_the_json_pair() {
        // sha256 of `["a","b"]`, as the native worker's own test pins it.
        assert_eq!(
            lock_key("a", "b"),
            format!(
                "locks:ai-usage-write:{}",
                hex::encode(Sha256::digest(br#"["a","b"]"#))
            )
        );
        assert_ne!(lock_key("a|b", "c"), lock_key("a", "b|c"));
        for script in scripts() {
            assert!(script.check().is_ok());
        }
    }
}
