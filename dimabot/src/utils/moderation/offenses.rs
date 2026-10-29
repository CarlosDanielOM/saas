//! Typed moderation offense counter and escalation ladder.
//! See the handoff for shared Redis telemetry and lifecycle boundaries.
use crate::utils::{
    js_string::JsString,
    json_number::number_string,
    observability::{Telemetry, restore_context, telemetry_context},
    redis_application_runtime,
};
use redis::{RedisResult, aio::ConnectionManager};
use std::future::Future;

// Once polled, the caller's cancellation drops only the JoinHandle. The owned
// operation keeps running, including the first-INCR expiry, as JS promises do.
async fn continue_after_cancel<F>(future: F) -> RedisResult<f64>
where
    F: Future<Output = RedisResult<f64>> + Send + 'static,
{
    let parent = telemetry_context();
    let task = tokio::spawn(async move {
        if let Some(context) = parent {
            let channel = context.channel.clone();
            restore_context(Some(context), &channel, future).await
        } else {
            future.await
        }
    });
    task.await.map_err(|_| {
        redis::RedisError::from(std::io::Error::other("offense operation task failed"))
    })?
}

/// The source script is intentionally EVAL'd verbatim; the decision receipt is
/// global, shared across counters and has an independent one-day expiry.
pub const OFFENSE_SCRIPT: &str = "\n            local previous = redis.call('GET', KEYS[2])\n            if previous then return tonumber(previous) end\n            local count = redis.call('INCR', KEYS[1])\n            if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end\n            redis.call('SET', KEYS[2], count, 'EX', 86400)\n            return count\n        ";

fn key(parts: &[&JsString], separator: &str, prefix: &str) -> JsString {
    let mut output: Vec<u16> = prefix.encode_utf16().collect();
    for (index, part) in parts.iter().enumerate() {
        if index != 0 {
            output.extend(separator.encode_utf16());
        }
        output.extend(part.code_units());
    }
    JsString::from_units(output)
}
pub fn offense_key(channel_id: &JsString, rule_id: &JsString, user_id: &JsString) -> JsString {
    let mut output: Vec<u16> = "moderation:".encode_utf16().collect();
    output.extend(channel_id.code_units());
    output.extend(":offenses:".encode_utf16());
    output.extend(rule_id.code_units());
    output.push(u16::from(b':'));
    output.extend(user_id.code_units());
    JsString::from_units(output)
}
pub fn offense_receipt_key(decision_id: &JsString) -> JsString {
    key(&[decision_id], ":", "moderation:offense-receipt:")
}
/// JavaScript `Math.max(60, Math.floor(windowSeconds))` as command text.
pub fn offense_window_text(seconds: f64) -> String {
    let floor = seconds.floor();
    number_string(if floor.is_nan() {
        floor
    } else {
        floor.max(60.0)
    })
}

/// A borrowed view of the source's Pick type. It accepts the existing schema
/// rule's Arc fields directly and retains the selected object's identity.
#[derive(Clone, Copy, Debug)]
pub struct OffenseLadder<'a, T> {
    pub first_offense: &'a T,
    pub second_offense: &'a T,
    pub third_offense: &'a T,
}
pub fn resolve_offense_step<'a, T>(rule: OffenseLadder<'a, T>, offense_number: f64) -> &'a T {
    if offense_number <= 1.0 {
        rule.first_offense
    } else if offense_number == 2.0 {
        rule.second_offense
    } else {
        rule.third_offense
    }
}

/// Supplied manager clones share the existing multiplexed connection. Optional
/// telemetry reproduces the source wrapper's eval span; incr/expire are not
/// wrapped in the TypeScript Dragonfly client. Native bootstrap is shared;
/// connection-event logging and process metrics remain shared dependency gaps.
#[derive(Clone)]
pub struct OffenseStore {
    cache: ConnectionManager,
    telemetry: Option<Telemetry>,
}
impl OffenseStore {
    pub fn new(cache: ConnectionManager) -> Self {
        Self {
            cache,
            telemetry: None,
        }
    }
    pub fn with_telemetry(cache: ConnectionManager, telemetry: Telemetry) -> Self {
        Self {
            cache,
            telemetry: Some(telemetry),
        }
    }
    pub async fn connect() -> RedisResult<Self> {
        let (cache, telemetry) = redis_application_runtime::acquire().await?;
        Ok(Self { cache, telemetry })
    }
    pub async fn record_offense(
        &self,
        channel_id: &JsString,
        rule_id: &JsString,
        user_id: &JsString,
        window_seconds: f64,
        decision_id: Option<&JsString>,
    ) -> RedisResult<f64> {
        let key = offense_key(channel_id, rule_id, user_id).to_utf8_lossy();
        let receipt = decision_id
            .filter(|s| !s.is_empty())
            .map(|decision| offense_receipt_key(decision).to_utf8_lossy());
        let window = offense_window_text(window_seconds);
        let cache = self.cache.clone();
        let telemetry = self.telemetry.clone();
        continue_after_cancel(async move {
            let mut cache = cache;
            if let Some(receipt) = receipt {
                let span = telemetry
                    .as_ref()
                    .map(|t| t.begin_span("cache", "eval", None));
                let result: RedisResult<Option<i64>> = redis::cmd("EVAL")
                    .arg(OFFENSE_SCRIPT)
                    .arg(2)
                    .arg(key)
                    .arg(receipt)
                    .arg(window)
                    .query_async(&mut cache)
                    .await;
                if let Some(span) = span {
                    span.end(if result.is_ok() { "ok" } else { "error" }, None);
                }
                // Lua nil is a null Redis reply; JS Number(null) is zero.
                return result.map(|value| value.unwrap_or(0) as f64);
            }
            let count: i64 = redis::cmd("INCR").arg(&key).query_async(&mut cache).await?;
            // The source compares the decoded JavaScript Number, not the raw i64.
            if count as f64 == 1.0 {
                let _: i64 = redis::cmd("EXPIRE")
                    .arg(key)
                    .arg(window)
                    .query_async(&mut cache)
                    .await?;
            }
            Ok(count as f64)
        })
        .await
    }
}
pub async fn record_offense(
    channel_id: &JsString,
    rule_id: &JsString,
    user_id: &JsString,
    window_seconds: f64,
    decision_id: Option<&JsString>,
) -> RedisResult<f64> {
    OffenseStore::connect()
        .await?
        .record_offense(channel_id, rule_id, user_id, window_seconds, decision_id)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::observability::{TraceContext, telemetry_context, with_telemetry_context};
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;

    #[tokio::test]
    async fn operation_keeps_context_and_continues_after_caller_cancellation() {
        let parent = TraceContext {
            trace_id: "0123456789abcdef0123456789abcdef".into(),
            span_id: "0123456789abcdef".into(),
            sampled: true,
            channel: "offense_channel".into(),
            outcome: None,
        };
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let finished = Arc::new(Notify::new());
        let (operation_started, operation_release, operation_finished) =
            (started.clone(), release.clone(), finished.clone());
        let operation = async move {
            let before = telemetry_context().expect("context lost before first command");
            assert_eq!(before.trace_id, "0123456789abcdef0123456789abcdef");
            assert_eq!(before.span_id, "0123456789abcdef");
            assert_eq!(before.channel, "offense_channel");
            operation_started.notify_one();
            operation_release.notified().await;
            let after = telemetry_context().expect("context lost after first command");
            assert_eq!(after.trace_id, before.trace_id);
            assert_eq!(after.span_id, before.span_id);
            assert_eq!(after.channel, before.channel);
            operation_finished.notify_one();
            Ok(1.0)
        };
        let caller = tokio::spawn(with_telemetry_context(
            parent,
            continue_after_cancel(operation),
        ));
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        caller.abort();
        let _ = caller.await;
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), finished.notified())
            .await
            .unwrap();
    }
}
