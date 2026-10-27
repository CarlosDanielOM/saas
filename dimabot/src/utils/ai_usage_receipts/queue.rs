//! The shared TypeScript queue and ownership protocols, using the original keys.
use super::{Result, TIMEOUT, values::*};
use mongodb::bson::oid::ObjectId;
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;

pub(super) const QUEUE: &str = "cron:ai-usage-receipts:queue";
pub(super) const PROCESSING: &str = "cron:ai-usage-receipts:processing";
pub(super) const DEAD: &str = "cron:ai-usage-receipts:queue:dead";
const RELEASE: &str =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
const EXTEND: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0";
pub(super) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn account_key(channel: &str, customer: &str) -> String {
    format!(
        "locks:ai-usage-write:{}",
        hash(&serde_json::to_string(&[channel, customer]).expect("string array serialization"))
    )
}
pub(super) async fn eval<T: redis::FromRedisValue>(
    cache: &mut ConnectionManager,
    script: &str,
    keys: &[&str],
    args: &[String],
) -> Result<T> {
    redis::cmd("EVAL")
        .arg(script)
        .arg(keys.len())
        .arg(keys)
        .arg(args)
        .query_async(cache)
        .await
        .map_err(|_| "AI usage queue operation failed")
}

/// Drop stops heartbeats but deliberately retains the TTL. A cancelled Mongo
/// command can still be in flight: only an uncancelled unit releases ownership.
pub(super) struct Lease {
    pub lost: Arc<AtomicBool>,
    cache: ConnectionManager,
    key: String,
    owner: String,
    heartbeat: JoinHandle<()>,
}
impl Lease {
    pub async fn acquire(
        cache: &mut ConnectionManager,
        key: String,
        ttl: u64,
        heartbeat_ms: u64,
    ) -> Result<Option<Self>> {
        let owner = format!(
            "{}-{}-{}",
            std::process::id(),
            now(),
            ObjectId::new().to_hex()
        );
        let acquired: Option<String> = redis::cmd("SET")
            .arg(&key)
            .arg(&owner)
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage lease acquisition failed")?;
        if acquired.as_deref() != Some("OK") {
            return Ok(None);
        }
        let lost = Arc::new(AtomicBool::new(false));
        let heartbeat_lost = lost.clone();
        let mut connection = cache.clone();
        let heartbeat_key = key.clone();
        let heartbeat_owner = owner.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(heartbeat_ms)).await;
                let result = tokio::time::timeout(
                    Duration::from_secs(2),
                    eval::<i64>(
                        &mut connection,
                        EXTEND,
                        &[&heartbeat_key],
                        &[heartbeat_owner.clone(), ttl.to_string()],
                    ),
                )
                .await;
                if !matches!(result, Ok(Ok(1))) {
                    heartbeat_lost.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
        Ok(Some(Self {
            lost,
            cache: cache.clone(),
            key,
            owner,
            heartbeat,
        }))
    }
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
    pub async fn release(self) -> Result<()> {
        self.release_owned().await.map(|_| ())
    }
    /// Whether the existing owner-fenced release still found our lease.
    pub async fn release_owned(mut self) -> Result<bool> {
        self.heartbeat.abort();
        let released = tokio::time::timeout(
            Duration::from_secs(2),
            eval::<i64>(
                &mut self.cache,
                RELEASE,
                &[&self.key],
                &[self.owner.clone()],
            ),
        )
        .await
        .map_err(|_| TIMEOUT)??;
        Ok(released == 1)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.heartbeat.abort();
    }
}
pub(super) async fn account_lease(
    cache: &mut ConnectionManager,
    channel: &str,
    customer: &str,
) -> Result<Lease> {
    let key = account_key(channel, customer);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(lease) = Lease::acquire(cache, key.clone(), 120, 30_000).await? {
            return Ok(lease);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("AI usage account is busy");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
pub(super) async fn reclaim(cache: &mut ConnectionManager) -> Result<()> {
    eval::<i64>(cache,"local moved = 0 while true do local item = redis.call('RPOP', KEYS[1]) if not item then return moved end redis.call('LPUSH', KEYS[2], item) moved = moved + 1 end",&[PROCESSING,QUEUE],&[]).await?;
    Ok(())
}
pub(super) async fn claim(cache: &mut ConnectionManager) -> Result<Option<String>> {
    eval(cache,"local item = redis.call('LPOP', KEYS[1]) if item then redis.call('RPUSH', KEYS[2], item) redis.call('HSET', KEYS[3], 'processingSince', ARGV[1]) end return item",&[QUEUE,PROCESSING,"ai-usage:queue-health:receipts"],&[now().to_string()]).await
}
pub(super) async fn complete(cache: &mut ConnectionManager, raw: &str) -> Result<()> {
    let retry = format!("{QUEUE}:attempts:{}", hash(raw));
    eval::<i64>(
        cache,
        "redis.call('LREM', KEYS[1], 1, ARGV[1]); redis.call('DEL', KEYS[2]); return 1",
        &[PROCESSING, &retry],
        &[raw.into()],
    )
    .await?;
    Ok(())
}
pub(super) async fn fail(cache: &mut ConnectionManager, raw: &str, invalid: bool) -> Result<()> {
    let retry = format!("{QUEUE}:attempts:{}", hash(raw));
    eval::<i64>(cache,r#"local attempts = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], 604800)
redis.call('HINCRBY', KEYS[5], 'failures', 1)
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return 0 end
if attempts >= tonumber(ARGV[2]) then redis.call('RPUSH', KEYS[3], ARGV[1]); redis.call('DEL', KEYS[4]); return 2 end
redis.call('RPUSH', KEYS[2], ARGV[1]); return 1"#,&[PROCESSING,QUEUE,DEAD,&retry,"ai-usage:queue-health:receipts"],&[raw.into(),if invalid {"1"}else{"3"}.into()]).await?;
    Ok(())
}
pub(super) async fn generation(cache: &mut ConnectionManager, channel: &str) -> Result<()> {
    redis::cmd("INCR")
        .arg(format!("twitch:{channel}:ai:usage-receipts:generation"))
        .query_async::<i64>(cache)
        .await
        .map_err(|_| "AI usage generation failed")?;
    Ok(())
}

fn logger_timestamp(checked: i64) -> String {
    let stamp = iso(checked);
    let part = |range: std::ops::Range<usize>| {
        stamp
            .get(range)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
    };
    let hour = part(11..13);
    format!(
        "{}/{}/{}, {}:{:02}:{:02} {}",
        part(5..7),
        part(8..10),
        &stamp[..4],
        if hour % 12 == 0 { 12 } else { hour % 12 },
        part(14..16),
        part(17..19),
        if hour >= 12 { "PM" } else { "AM" }
    )
}
/// The TS logger reports cache errors as a failed LogResponse and never fails
/// receipt processing or queue monitoring. Preserve that best-effort contract.
pub(super) async fn cache_log(cache: &mut ConnectionManager, level: &str, data: Value) {
    let checked = now();
    let entry = json!({"data":data,"timestamp":logger_timestamp(checked),"level":level,"platform":"twitch"});
    let mut command = redis::cmd("SET");
    command
        .arg(format!(
            "logger:twitch:global:{level}:{checked}-{}",
            ObjectId::new().to_hex()
        ))
        .arg(entry.to_string())
        .arg("EX")
        .arg(604800);
    let _ = tokio::time::timeout(Duration::from_secs(2), command.query_async::<()>(cache)).await;
}

fn numeric(previous: &HashMap<String, String>, key: &str) -> f64 {
    previous
        .get(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0)
}
pub(super) async fn monitor(cache: &mut ConnectionManager, config: &super::Config) -> Result<()> {
    let checked = now();
    for (name, queue, processing, dead) in [
        ("receipts", QUEUE, PROCESSING, DEAD),
        (
            "backfills",
            "cron:ai-usage-backfills:queue",
            "cron:ai-usage-backfills:processing",
            "cron:ai-usage-backfills:dead",
        ),
    ] {
        let key = format!("ai-usage:queue-health:{name}");
        let pending: u64 = redis::cmd("LLEN")
            .arg(queue)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        let active: u64 = redis::cmd("LLEN")
            .arg(processing)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        let dead: u64 = redis::cmd("LLEN")
            .arg(dead)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        let oldest: Option<String> = redis::cmd("LINDEX")
            .arg(queue)
            .arg(0)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        let previous: HashMap<String, String> = redis::cmd("HGETALL")
            .arg(&key)
            .query_async(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        let oldest = oldest.and_then(|v| serde_json::from_str::<Value>(&v).ok());
        let queued = oldest
            .as_ref()
            .and_then(|v| {
                v.get("enqueuedAt")
                    .filter(|v| truthy(v))
                    .or_else(|| v.get("requestedAt"))
            })
            .and_then(Value::as_str)
            .and_then(parse_date)
            .filter(|v| *v != 0);
        let pending_since = if pending > 0 {
            let v = numeric(&previous, "pendingSince");
            if v != 0.0 { v } else { checked as f64 }
        } else {
            0.0
        };
        let oldest_age = if pending > 0 {
            ((checked as f64 - queued.map_or(pending_since, |v| v as f64)) / 1000.0).max(0.0)
        } else {
            0.0
        };
        let processing_since = numeric(&previous, "processingSince");
        let processing_age = if active > 0 {
            ((checked as f64
                - if processing_since != 0.0 {
                    processing_since
                } else {
                    checked as f64
                })
                / 1000.0)
                .max(0.0)
        } else {
            0.0
        };
        let failures = numeric(&previous, "failures");
        let mut reasons = Vec::new();
        if oldest_age > config.queue_max_age {
            reasons.push("queue_age");
        }
        if processing_age > config.processing_max_age {
            reasons.push("processing_stalled");
        }
        if dead > 0 {
            reasons.push("dead_letters");
        }
        if failures - numeric(&previous, "observedFailures") >= config.failure_threshold {
            reasons.push("repeated_failures");
        }
        let status = json!({"queue":name,"pending":pending,"processing":active,"dead":dead,"oldestAgeSeconds":oldest_age,"processingAgeSeconds":processing_age,"failures":failures,"reasons":reasons,"checkedAt":iso(checked)});
        redis::cmd("SET")
            .arg(format!("{key}:snapshot"))
            .arg(status.to_string())
            .arg("EX")
            .arg(300)
            .query_async::<()>(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        redis::cmd("HSET")
            .arg(&key)
            .arg("pendingSince")
            .arg(pending_since.to_string())
            .arg("observedFailures")
            .arg(failures.to_string())
            .query_async::<i64>(cache)
            .await
            .map_err(|_| "AI usage queue health failed")?;
        if !reasons.is_empty() {
            let alert: Option<String> = redis::cmd("SET")
                .arg(format!("{key}:alert"))
                .arg("1")
                .arg("NX")
                .arg("EX")
                .arg(300)
                .query_async(cache)
                .await
                .map_err(|_| "AI usage queue alert failed")?;
            if alert.as_deref() == Some("OK") {
                let mut data = status;
                data["worker"] = json!("ai_usage_receipts");
                data["message"] = json!("AI usage queue requires attention");
                cache_log(cache, "warn", data).await;
                eprintln!("AI usage queue requires attention");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logger_timestamp_uses_existing_en_us_utc_contract() {
        assert_eq!(
            logger_timestamp(parse_date("2026-10-21T13:05:06Z").unwrap()),
            "10/21/2026, 1:05:06 PM"
        );
        assert_eq!(
            logger_timestamp(parse_date("2026-10-21T00:00:00Z").unwrap()),
            "10/21/2026, 12:00:00 AM"
        );
    }
    #[test]
    fn account_lock_hash_is_unambiguous_and_matches_json_contract() {
        assert_eq!(
            account_key("a", "b"),
            format!("locks:ai-usage-write:{}", hash("[\"a\",\"b\"]"))
        );
        assert_ne!(account_key("a|b", "c"), account_key("a", "b|c"));
    }
}
