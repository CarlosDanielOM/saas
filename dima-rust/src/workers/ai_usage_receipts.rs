//! Native receipt consumer for the existing AI usage ledger and derived dashboards.
//! Producers, Polar calls, API reads, and the backfill worker remain TypeScript.
//! No collections or indices are created. Queue ownership and per-account locks
//! interoperate with the existing SHA256/Redis Lua protocols.
use mongodb::{
    Database,
    bson::{Document, doc},
};
use redis::aio::ConnectionManager;
use std::{collections::HashMap, future::Future, time::Duration};
use tokio::sync::watch;
mod dashboard;
mod ledger;
mod queue;
mod values;
use values::*;

type Result<T> = std::result::Result<T, &'static str>;
pub const TIMEOUT: &str = "AI usage active work timed out; leases retained for recovery";
const ACTIVE_LIMIT: Duration = Duration::from_secs(20);

/// Only one active job or dashboard is bounded. A legitimate batch may contain
/// 1000 jobs; a whole-pass watchdog would interrupt healthy queue draining.
async fn unit<T>(work: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(ACTIVE_LIMIT, work)
        .await
        .map_err(|_| TIMEOUT)?
}

#[derive(Clone, Debug)]
pub struct Config {
    pub interval_ms: u64,
    pub batch_size: usize,
    pub enabled: bool,
    pub lock_key: String,
    pub lock_ttl_seconds: u64,
    pub queue_max_age: f64,
    pub processing_max_age: f64,
    pub failure_threshold: f64,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_values(|key| std::env::var(key).ok())
    }
    fn from_values(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let numeric = |key, default: f64, min: f64, max: f64| -> Result<f64> {
            let value = get(key).filter(|v| !v.is_empty());
            let number = match value {
                None => default,
                Some(value) => values::number(Some(&serde_json::Value::String(value)))
                    .ok_or("Invalid AI usage worker configuration")?,
            };
            Ok(number.clamp(min, max))
        };
        Ok(Self {
            interval_ms: numeric(
                "AI_USAGE_RECEIPTS_INTERVAL_MS",
                1000.0,
                250.0,
                u64::MAX as f64,
            )? as u64,
            batch_size: numeric("AI_USAGE_RECEIPTS_BATCH_SIZE", 200.0, 1.0, 1000.0)?.ceil()
                as usize,
            enabled: get("AI_USAGE_RECEIPTS_ENABLED").as_deref() != Some("false"),
            lock_key: get("AI_USAGE_RECEIPTS_LOCK_KEY")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "worker:ai-usage-receipts:lock".into()),
            lock_ttl_seconds: numeric(
                "AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS",
                300.0,
                30.0,
                u32::MAX as f64,
            )? as u64,
            queue_max_age: numeric("AI_USAGE_QUEUE_MAX_AGE_SECONDS", 900.0, -f64::MAX, f64::MAX)?,
            processing_max_age: numeric(
                "AI_USAGE_PROCESSING_MAX_AGE_SECONDS",
                900.0,
                -f64::MAX,
                f64::MAX,
            )?,
            failure_threshold: numeric(
                "AI_USAGE_QUEUE_FAILURE_THRESHOLD",
                3.0,
                -f64::MAX,
                f64::MAX,
            )?,
        })
    }
}

#[derive(Debug, PartialEq)]
pub struct BatchOutcome {
    pub processed: usize,
    pub success: bool,
}

pub struct AiUsageReceipts {
    database: Database,
    cache: ConnectionManager,
    config: Config,
    plans: HashMap<String, (String, i64)>,
    last_maintenance: i64,
}
impl AiUsageReceipts {
    pub fn new(database: Database, cache: ConnectionManager, config: Config) -> Self {
        Self {
            database,
            cache,
            config,
            plans: HashMap::new(),
            last_maintenance: 0,
        }
    }
    async fn plan(&mut self, channel: &str) -> Result<String> {
        if let Some((tier, _)) = self
            .plans
            .get(channel)
            .filter(|(_, expiry)| *expiry > now())
        {
            return Ok(tier.clone());
        }
        let user = self
            .database
            .collection::<Document>("users")
            .find_one(doc! {"accounts":{"$elemMatch":{"type":"twitch","id":channel}}})
            .projection(doc! {"plan_tier":1})
            .await
            .map_err(|_| "AI usage plan lookup failed")?;
        let tier = match user.as_ref().and_then(|v| v.get_str("plan_tier").ok()) {
            Some("pro") => "pro",
            Some("premium") => "premium",
            _ => "free",
        }
        .to_owned();
        self.plans
            .insert(channel.into(), (tier.clone(), now() + 60_000));
        Ok(tier)
    }
    async fn process_next(&mut self) -> Result<Option<bool>> {
        let Some(raw) = queue::claim(&mut self.cache)
            .await?
            .filter(|v| !v.is_empty())
        else {
            return Ok(None);
        };
        let Some(receipt) = parse_receipt(&raw) else {
            queue::fail(&mut self.cache, &raw, true).await?;
            return Ok(Some(false));
        };
        let result = async {
            let plan = self.plan(&receipt.channel).await?;
            ledger::persist(&self.database, &mut self.cache, &receipt, &plan).await?;
            queue::complete(&mut self.cache, &raw).await?;
            queue::generation(&mut self.cache, &receipt.channel).await?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {}
            Err(TIMEOUT) => return Err(TIMEOUT),
            Err(_) => {
                // Ordinary failures retry/dead-letter the original raw bytes.
                // A previous receipt-only write is repaired on the retry.
                queue::fail(&mut self.cache, &raw, false).await?;
                queue::cache_log(&mut self.cache,"error",serde_json::json!({"worker":"ai_usage_receipts","message":"Receipt persistence failed; requeued or retained in dead letters","error":"AI usage receipt persistence failed"})).await;
                eprintln!(
                    "AI usage receipt persistence failed; retained for retry or dead letters"
                );
                return Ok(Some(false));
            }
        }
        Ok(Some(true))
    }
    pub async fn run_batch(&mut self, stopped: &watch::Receiver<bool>) -> Result<BatchOutcome> {
        let ttl = self.config.lock_ttl_seconds;
        let lease = unit(queue::Lease::acquire(
            &mut self.cache,
            self.config.lock_key.clone(),
            ttl,
            (ttl * 1000 / 3).max(5000),
        ))
        .await?;
        let Some(lease) = lease else {
            return Ok(BatchOutcome {
                processed: 0,
                success: true,
            });
        };
        let result = async {
            if *stopped.borrow() {
                return Ok(BatchOutcome {
                    processed: 0,
                    success: true,
                });
            }
            unit(queue::reclaim(&mut self.cache)).await?;
            let mut processed = 0;
            let mut success = true;
            while !*stopped.borrow() && !lease.is_lost() && processed < self.config.batch_size {
                let Some(succeeded) = unit(self.process_next()).await? else {
                    break;
                };
                success &= succeeded;
                processed += 1;
            }
            Ok(BatchOutcome { processed, success })
        }
        .await;
        if result == Err(TIMEOUT) {
            return result;
        } // Drop retains TTL after cancellation.
        lease.release().await?;
        result
    }
    pub async fn maintain(&mut self, stopped: &watch::Receiver<bool>, once: bool) -> Result<()> {
        if *stopped.borrow() || !once && now() - self.last_maintenance < 10_000 {
            return Ok(());
        }
        let dashboards = unit(dashboard::due(&self.database)).await?;
        for dashboard in dashboards {
            if *stopped.borrow() {
                return Ok(());
            }
            unit(dashboard::refresh(
                &self.database,
                &mut self.cache,
                &dashboard,
            ))
            .await?;
        }
        if !*stopped.borrow() {
            unit(queue::monitor(&mut self.cache, &self.config)).await?;
            self.last_maintenance = now();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_preserves_defaults_clamps_and_fractional_batch_loop_behavior() {
        let config = Config::from_values(|_| None).unwrap();
        assert_eq!(config.batch_size, 200);
        assert_eq!(config.interval_ms, 1000);
        assert_eq!(config.lock_ttl_seconds, 300);
        assert!(config.enabled);
        let config = Config::from_values(|key| match key {
            "AI_USAGE_RECEIPTS_BATCH_SIZE" => Some("1.5".into()),
            "AI_USAGE_RECEIPTS_INTERVAL_MS" => Some("0".into()),
            "AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS" => Some("1".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(config.batch_size, 2);
        assert_eq!(config.interval_ms, 250);
        assert_eq!(config.lock_ttl_seconds, 30);
    }
}
