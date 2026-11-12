//! What the usage tests share: a throwaway database with the ledger's indexes, Dragonfly
//! database 9 under a key prefix no other run uses (cleaned up afterwards), a fixed clock, a
//! ledger, and a write boundary that stops a run at a chosen write as a killed process would.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::{Context, Result};
use bson::{Bson, Document, doc};
use dima_billing::usage_backfill::{BackfillConfig, BackfillKeys};
use dima_billing::usage_ledger::{Ledger, LedgerConfig, NoBoundary, WriteBoundary};
use dima_billing::usage_queue::QueueKeys;
use dima_core::{ManualClock, SeededRandom};
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[path = "../support/mod.rs"]
pub mod support;

/// 2026-11-12T12:00:00.000Z.
pub const NOW: i64 = 1_794_484_800_000;
pub const DAY: i64 = 86_400_000;

/// Creates the declared indexes of the four ledger collections (and `users`).
pub async fn indexes(store: &MongoStore) -> Result<()> {
    for info in [
        &dima_model::ai_usage_receipts::INFO,
        &dima_model::ai_usage_dailies::INFO,
        &dima_model::ai_usage_ledger_states::INFO,
        &dima_model::ai_usage_dashboards::INFO,
    ] {
        let policy = dima_model::startup_policy(info).context("policy")?;
        let report = dima_model::ensure_indexes(store, info, policy, Duration::from_secs(30)).await;
        report.require().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    }
    Ok(())
}

/// The test's stores and settings.
pub struct Env {
    pub mongo: MongoStore,
    pub dragonfly: Dragonfly,
    pub clock: ManualClock,
    pub random: SeededRandom,
    pub config: LedgerConfig,
    pub prefix: String,
}

impl Env {
    pub async fn new(mongo: MongoStore) -> Result<Self> {
        indexes(&mongo).await?;
        let dragonfly = support::dragonfly(9).await?.context("dragonfly")?;
        Ok(Self {
            mongo,
            dragonfly,
            clock: ManualClock::new(NOW),
            random: SeededRandom::new(7),
            config: LedgerConfig {
                // Generous on a busy machine; the production default is 15 s.
                op_deadline: Duration::from_secs(60),
                ..LedgerConfig::default()
            },
            prefix: format!("t{}:", support::channel_id()),
        })
    }

    pub fn ledger<'a>(&'a self, boundary: &'a dyn WriteBoundary) -> Ledger<'a> {
        Ledger {
            mongo: &self.mongo,
            dragonfly: &self.dragonfly,
            clock: &self.clock,
            random: &self.random,
            config: &self.config,
            boundary,
        }
    }

    pub fn plain(&self) -> Ledger<'_> {
        self.ledger(&NoBoundary)
    }

    pub fn receipt_keys(&self) -> QueueKeys {
        dima_billing::usage_receipts::receipt_keys_prefixed(&self.prefix)
    }

    pub fn backfill_keys(&self) -> BackfillKeys {
        BackfillKeys::prefixed(&self.prefix)
    }

    /// Deletes every key under the prefix and every ledger lock (they hash the channel).
    pub async fn cleanup(&self, channels: &[&str]) -> Result<()> {
        support::cleanup(&self.dragonfly, &self.prefix).await?;
        for channel in channels {
            support::cleanup(&self.dragonfly, channel).await?;
        }
        Ok(())
    }

    /// Simulates every lease and lock of a stopped process expiring.
    pub async fn expire_locks(&self, channel: &str, customer: &str) -> Result<()> {
        let keys = [
            dima_billing::usage_ledger::lock::lock_key(channel, customer),
            self.receipt_keys().lease,
            self.backfill_keys().jobs.lease,
        ];
        for key in keys {
            self.dragonfly.del(&[&key]).await?;
        }
        Ok(())
    }

    /// A list's items as text.
    pub async fn list(&self, key: &str) -> Result<Vec<String>> {
        let items: Vec<Vec<u8>> = self
            .dragonfly
            .query(redis::cmd("LRANGE").arg(key).arg(0).arg(-1))
            .await?;
        Ok(items
            .into_iter()
            .map(|item| String::from_utf8_lossy(&item).into_owned())
            .collect())
    }
}

/// Every document of `collection`, sorted by `sort`, with `drop` removed from each.
pub async fn documents(
    store: &MongoStore,
    collection: &str,
    sort: Document,
    drop: &[&str],
) -> Result<Vec<Document>> {
    let mut out: Vec<Document> = store
        .documents(collection)
        .find(doc! {})
        .sort(sort)
        .await?
        .try_collect()
        .await?;
    for document in &mut out {
        for key in drop {
            document.remove(*key);
        }
    }
    Ok(out)
}

/// The ledger's state: receipts (by entry id), days (by date, without `_id`), states, and the
/// dashboards' `dirty` flags.
pub async fn ledger_state(store: &MongoStore) -> Result<Vec<Vec<Document>>> {
    Ok(vec![
        documents(store, "ai_usage_receipts", doc! { "entryId": 1 }, &["_id"]).await?,
        documents(
            store,
            "ai_usage_dailies",
            doc! { "channelID": 1, "date": 1 },
            &["_id"],
        )
        .await?,
        documents(
            store,
            "ai_usage_ledger_states",
            doc! { "channelID": 1 },
            &["_id"],
        )
        .await?,
        documents(store, "ai_usage_dashboards", doc! { "key": 1 }, &["_id"]).await?,
    ])
}

/// Stops the run at the `at`-th write (counting from 0): that write never starts, and the run's
/// future pends until the test drops it.
pub struct Killer {
    at: usize,
    seen: AtomicUsize,
    pub point: Mutex<Option<&'static str>>,
    stopped: tokio::sync::Notify,
}

impl Killer {
    pub fn new(at: usize) -> Self {
        Self {
            at,
            seen: AtomicUsize::new(0),
            point: Mutex::new(None),
            stopped: tokio::sync::Notify::new(),
        }
    }

    /// Writes reached so far.
    pub fn count(&self) -> usize {
        self.seen.load(Ordering::SeqCst)
    }

    /// Runs `work` until it ends or reaches the chosen write; `true` when it was stopped.
    pub async fn run<T>(&self, work: impl std::future::Future<Output = T>) -> bool {
        tokio::select! {
            _ = work => false,
            () = self.stopped.notified() => true,
        }
    }
}

impl WriteBoundary for Killer {
    fn reached<'a>(&'a self, point: &'static str) -> BoxFuture<'a, ()> {
        let n = self.seen.fetch_add(1, Ordering::SeqCst);
        if n == self.at {
            *self.point.lock().unwrap() = Some(point);
            self.stopped.notify_one();
            return Box::pin(std::future::pending());
        }
        Box::pin(std::future::ready(()))
    }
}

/// Counts the writes of a run.
#[derive(Default)]
pub struct Counter(pub Mutex<Vec<&'static str>>);

impl WriteBoundary for Counter {
    fn reached<'a>(&'a self, point: &'static str) -> BoxFuture<'a, ()> {
        self.0.lock().unwrap().push(point);
        Box::pin(std::future::ready(()))
    }
}

/// A user owning `channel` with `tier`.
pub async fn user(store: &MongoStore, channel: &str, customer: &str, tier: &str) -> Result<()> {
    store
        .documents("users")
        .insert_one(doc! {
            "accounts": [ { "type": "twitch", "id": channel } ],
            "plan_tier": tier,
            "polar_sh_customer_id": customer,
            "created_at": Bson::DateTime(bson::DateTime::from_millis(NOW - 400 * DAY)),
        })
        .await?;
    Ok(())
}

/// Unused config placeholders keep the imports of every test file in use.
pub fn backfill_config() -> BackfillConfig {
    BackfillConfig::default()
}
