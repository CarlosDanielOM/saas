//! Request-time AI ledger ownership, matching `withAiUsageLock`.
//!
//! Keys use the existing well-formed JavaScript UTF-16 JSON string encoder and
//! SHA-256, and interoperate with the deployed receipt worker's account lock.
//! The concrete Redis manager and its lazy default bootstrap are reused.
//!
//! Renewal is polled alongside the callback, never spawned. Dropping this
//! future (including unwinding a panic) stops renewal and retains the lease's
//! TTL: a cancelled application write may still be in flight. Normal callback
//! success/failure always awaits owner-fenced release. Redis command futures
//! have the supplied manager's response timeout; the default manager disables
//! that timeout, as does the TypeScript client. No command is replayed here.
use super::{js_string::JsString, json_number::to_number};
use redis::{RedisError, Value, aio::ConnectionManager};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::time::{Instant, MissedTickBehavior};

pub const KEY_PREFIX: &str = "locks:ai-usage-write:";
pub const ACQUIRE_WAIT: Duration = Duration::from_secs(10);
pub const CONTENTION_WAIT: Duration = Duration::from_millis(50);
pub const LEASE_SECONDS: u64 = 120;
pub const HEARTBEAT_WAIT: Duration = Duration::from_secs(30);
pub const BUSY_MESSAGE: &str = "AI usage ledger busy; retry later";
pub const LEASE_LOST_MESSAGE: &str = "AI usage ledger lease lost; retry required";
pub const RENEW_SCRIPT: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0";
pub const RELEASE_SCRIPT: &str =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/// The exact `JSON.stringify([channelID, customerId])` UTF-8 bytes, including
/// escaped lone surrogates, are hashed. No trimming or Unicode normalization.
pub fn account_key(channel_id: &JsString, customer_id: &JsString) -> String {
    let mut pair = String::from("[");
    channel_id.write_json_string(&mut pair);
    pair.push(',');
    customer_id.write_json_string(&mut pair);
    pair.push(']');
    format!("{KEY_PREFIX}{:x}", Sha256::digest(pair.as_bytes()))
}

/// Callback errors retain their concrete type. As in JavaScript `finally`, a
/// release error supersedes callback failure, lease loss, or a successful value.
#[derive(Debug)]
pub enum AiUsageLockError<E> {
    Acquire(RedisError),
    Busy,
    Callback(E),
    LeaseLost,
    Release(RedisError),
}
impl<E: fmt::Display> fmt::Display for AiUsageLockError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Acquire(error) | Self::Release(error) => fmt::Display::fmt(error, f),
            Self::Busy => f.write_str(BUSY_MESSAGE),
            Self::Callback(error) => fmt::Display::fmt(error, f),
            Self::LeaseLost => f.write_str(LEASE_LOST_MESSAGE),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for AiUsageLockError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Acquire(error) | Self::Release(error) => Some(error),
            Self::Callback(error) => Some(error),
            Self::Busy | Self::LeaseLost => None,
        }
    }
}

/// Explicit construction does no I/O. Clones share the multiplexed manager.
#[derive(Clone)]
pub struct AiUsageLock {
    cache: ConnectionManager,
}
impl AiUsageLock {
    pub fn new(cache: ConnectionManager) -> Self {
        Self { cache }
    }

    /// Acquire with NX/EX120, run exactly once, and release only our UUID owner.
    /// A successful SET is accepted even if its reply arrives after ten seconds;
    /// the source checks the contention deadline only after a failed SET.
    /// Waiting uses a monotonic clock, avoiding wall-clock jumps.
    pub async fn with<T, E, F, Fut>(
        &self,
        channel_id: &JsString,
        customer_id: &JsString,
        run: F,
    ) -> Result<T, AiUsageLockError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let key = account_key(channel_id, customer_id);
        let owner = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + ACQUIRE_WAIT;
        let mut cache = self.cache.clone();
        loop {
            let acquired: Option<String> = redis::cmd("SET")
                .arg(&key)
                .arg(&owner)
                .arg("NX")
                .arg("EX")
                .arg(LEASE_SECONDS)
                .query_async(&mut cache)
                .await
                .map_err(AiUsageLockError::Acquire)?;
            if acquired.as_deref() == Some("OK") {
                break;
            }
            if Instant::now() >= deadline {
                return Err(AiUsageLockError::Busy);
            }
            tokio::time::sleep(CONTENTION_WAIT).await;
        }

        let lost = AtomicBool::new(false);
        let start = Instant::now() + HEARTBEAT_WAIT;
        let outcome = {
            let heartbeat = async {
                let mut cache = self.cache.clone();
                let mut ticks = tokio::time::interval_at(start, HEARTBEAT_WAIT);
                // Bound renewal to one in-flight command. Ready callback work
                // still runs while a renewal reply is held. Missed renewals do
                // not accumulate into an unbounded queue or a catch-up burst.
                ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    ticks.tick().await;
                    let reply = eval(&mut cache, RENEW_SCRIPT, &key, &owner).await;
                    if !matches!(reply, Ok(ref reply) if renewal_reply_is_one(reply)) {
                        lost.store(true, Ordering::SeqCst);
                    }
                    // Lost is sticky, but the source continues attempting each
                    // future heartbeat until callback completion or cancellation.
                }
            };
            tokio::pin!(heartbeat);
            // Invoke the callback after acquisition, inside the lifetime that
            // owns heartbeat polling. Callback panic unwinds this entire scope.
            let callback = run();
            tokio::pin!(callback);
            tokio::select! {
                // Callback completion wins a simultaneous poll. Only renewal
                // replies already observed while it ran influence `lost`.
                biased;
                result = &mut callback => result,
                _ = &mut heartbeat => unreachable!("heartbeat loop cannot complete"),
            }
        };
        let outcome = match outcome {
            Err(error) => Err(AiUsageLockError::Callback(error)),
            Ok(_) if lost.load(Ordering::SeqCst) => Err(AiUsageLockError::LeaseLost),
            Ok(value) => Ok(value),
        };
        // Dropping the heartbeat above prevents further renewals. A command
        // already sent to Redis may still complete; both scripts fence by owner.
        eval(&mut cache, RELEASE_SCRIPT, &key, &owner)
            .await
            .map_err(AiUsageLockError::Release)?;
        outcome
    }
}

/// Native default acquisition replaces `getDragonflyClient('AiUsageLedgerLock')`.
/// The existing bootstrap validates plain-TCP configuration and bounds startup;
/// this helper adds no telemetry wrapper or environment mutation.
pub async fn with_ai_usage_lock<T, E, F, Fut>(
    channel_id: &JsString,
    customer_id: &JsString,
    run: F,
) -> Result<T, AiUsageLockError<E>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let cache = super::redis::get_redis_client()
        .await
        .map_err(AiUsageLockError::Acquire)?;
    AiUsageLock::new(cache)
        .with(channel_id, customer_id, run)
        .await
}

async fn eval(
    cache: &mut ConnectionManager,
    script: &str,
    key: &str,
    owner: &str,
) -> redis::RedisResult<Value> {
    redis::cmd("EVAL")
        .arg(script)
        .arg(1)
        .arg(key)
        .arg(owner)
        .query_async(cache)
        .await
}

// The exact Lua returns integer 0/1. Preserve Number(value) for ordinary RESP2
// scalar/array replies as well, reusing the existing ECMAScript coercion core.
// RESP3-only maps/sets/pushes are outside node-redis's default RESP2 contract.
fn renewal_reply_is_one(reply: &Value) -> bool {
    fn json(reply: &Value) -> serde_json::Value {
        match reply {
            Value::Nil => serde_json::Value::Null,
            Value::Int(value) => (*value).into(),
            Value::BulkString(value) => String::from_utf8_lossy(value).into_owned().into(),
            Value::SimpleString(value) => value.clone().into(),
            Value::Okay => "OK".into(),
            Value::Array(values) => serde_json::Value::Array(values.iter().map(json).collect()),
            // Retain the ordinary native scalar forms without inventing a
            // second Number parser. Nonfinite values cannot compare equal to 1.
            Value::Double(value) => serde_json::Number::from_f64(*value)
                .map_or(serde_json::Value::Null, serde_json::Value::Number),
            Value::Boolean(value) => (*value).into(),
            Value::Attribute { data, .. } => json(data),
            Value::VerbatimString { text, .. } => text.clone().into(),
            _ => serde_json::Value::Object(Default::default()),
        }
    }
    to_number(&json(reply)) == 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renewal_coercion_reuses_javascript_number() {
        for value in [
            Value::Int(1),
            Value::BulkString(b" \xef\xbb\xbf0x1 ".to_vec()),
            Value::SimpleString("1e0".into()),
            Value::Array(vec![Value::Int(1)]),
            Value::Array(vec![Value::Array(vec![Value::SimpleString("1.0".into())])]),
        ] {
            assert!(renewal_reply_is_one(&value), "{value:?}");
        }
        for value in [
            Value::Nil,
            Value::Int(0),
            Value::Int(2),
            Value::Okay,
            Value::SimpleString("garbage".into()),
            Value::Array(vec![]),
            Value::Array(vec![Value::Int(1), Value::Int(1)]),
        ] {
            assert!(!renewal_reply_is_one(&value), "{value:?}");
        }
    }
}
