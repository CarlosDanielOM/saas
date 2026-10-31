//! Redis queue health for AI usage receipts and backfills.
//!
//! TypeScript reads `AI_USAGE_*` limits once, when the module is first imported.
//! This module reads them when a production monitor call builds its limits, so a
//! test can pass [`QueueLimits`] without racing process environment.
//! `monitorAiUsageQueues` loads each queue with `Promise.all`. The commands and
//! keys here are the same; the five reads run one after another.
//!
//! `JSON.stringify` of the snapshot keeps source key order and spells non-finite
//! numbers as `null`. The native logger then re-encodes that object with
//! `serde_json`, whose map sorts keys. [`queue_alert_json`] is the body `warn`
//! receives. List lengths above 2^53 are not exact once stored as JSON numbers,
//! which matches JavaScript.

use std::{
    collections::HashMap,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use redis::aio::ConnectionManager;
use sha2::{Digest, Sha256};

use super::{
    credit_policy::JsDate,
    js_compat::trim as js_trim,
    js_date::parse_date,
    json_number::{number_string, to_number},
    logger::{Destination, Level, LogOptions, LogReport, Logger},
    lossless_json::{JsonValue, JsonValueRef, fields_to_json_string},
};

pub const HEALTH_KEY_PREFIX: &str = "ai-usage:queue-health";
pub const QUEUE_ALERT_WORKER: &str = "ai_usage_receipts";
pub const QUEUE_ALERT_MESSAGE: &str = "AI usage queue requires attention";
pub const DEFAULT_MAX_ATTEMPTS: i64 = 3;
pub const DEFAULT_MAX_AGE_SECONDS: f64 = 900.0;
pub const DEFAULT_PROCESSING_MAX_AGE_SECONDS: f64 = 900.0;
pub const DEFAULT_FAILURE_THRESHOLD: f64 = 3.0;
pub const SNAPSHOT_TTL_SECONDS: i64 = 300;
pub const ALERT_TTL_SECONDS: i64 = 300;
/// Matches the `604800` literal in [`FAIL_SCRIPT`].
pub const RETRY_TTL_SECONDS: i64 = 604_800;
pub const QUEUE_MAX_AGE_ENV: &str = "AI_USAGE_QUEUE_MAX_AGE_SECONDS";
pub const PROCESSING_MAX_AGE_ENV: &str = "AI_USAGE_PROCESSING_MAX_AGE_SECONDS";
pub const FAILURE_THRESHOLD_ENV: &str = "AI_USAGE_QUEUE_FAILURE_THRESHOLD";

/// Leading newline and the single space before each inner `redis.call` are part of the source text.
pub const CLAIM_SCRIPT: &str = r#"
local item = redis.call('LPOP', KEYS[1])
if item then
 redis.call('RPUSH', KEYS[2], item)
 redis.call('HSET', KEYS[3], 'processingSince', ARGV[1])
end
return item"#;
pub const COMPLETE_SCRIPT: &str =
    "redis.call('LREM', KEYS[1], 1, ARGV[1]); redis.call('DEL', KEYS[2]); return 1";
pub const FAIL_SCRIPT: &str = r#"
local attempts = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], 604800)
redis.call('HINCRBY', KEYS[5], 'failures', 1)
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return 0 end
if attempts >= tonumber(ARGV[2]) then
 redis.call('RPUSH', KEYS[3], ARGV[1]); redis.call('DEL', KEYS[4]); return 2
end
redis.call('RPUSH', KEYS[2], ARGV[1]); return 1"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageQueue<'a> {
    pub name: &'a str,
    pub queue: &'a str,
    pub processing: &'a str,
    pub dead: &'a str,
}

pub const USAGE_QUEUES: [UsageQueue<'static>; 2] = [
    UsageQueue {
        name: "receipts",
        queue: "cron:ai-usage-receipts:queue",
        processing: "cron:ai-usage-receipts:processing",
        dead: "cron:ai-usage-receipts:queue:dead",
    },
    UsageQueue {
        name: "backfills",
        queue: "cron:ai-usage-backfills:queue",
        processing: "cron:ai-usage-backfills:processing",
        dead: "cron:ai-usage-backfills:dead",
    },
];

#[derive(Debug)]
pub enum QueueHealthError {
    Redis(redis::RedisError),
    InvalidTime,
}

impl fmt::Display for QueueHealthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Redis(error) => write!(f, "{error}"),
            Self::InvalidTime => f.write_str("Invalid time value"),
        }
    }
}

impl std::error::Error for QueueHealthError {}

impl From<redis::RedisError> for QueueHealthError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QueueLimits {
    pub max_age_seconds: f64,
    pub processing_max_age_seconds: f64,
    pub failure_threshold: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueStatus {
    pub queue: String,
    pub pending: i64,
    pub processing: i64,
    pub dead: i64,
    pub oldest_age_seconds: f64,
    pub processing_age_seconds: f64,
    pub failures: f64,
    pub reasons: Vec<String>,
    pub checked_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueAssessment {
    pub status: QueueStatus,
    /// Value written to `pendingSince`. This is not the previous field.
    pub pending_since: f64,
    /// Value written to `observedFailures` (`String(failures)` in the source).
    pub observed_failures: f64,
    pub pending_since_text: String,
    pub observed_failures_text: String,
    pub snapshot_json: String,
    pub alert_json: String,
}

pub fn queue_health_key(prefix: &str, name: &str) -> String {
    format!("{prefix}:{name}")
}

pub fn queue_snapshot_key(prefix: &str, name: &str) -> String {
    format!("{}:snapshot", queue_health_key(prefix, name))
}

pub fn queue_alert_key(prefix: &str, name: &str) -> String {
    format!("{}:alert", queue_health_key(prefix, name))
}

pub fn usage_retry_key(queue: &str, raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    format!("{queue}:attempts:{digest:x}")
}

/// `Number(raw || default)`. Empty and missing raw values select `default`.
/// A whitespace string is present, so its number is used (`Number(" ")` is 0).
/// Non-UTF-8 environment values never reach this function; callers map them to
/// `None`.
pub fn queue_limit_from(raw: Option<&str>, default: f64) -> f64 {
    match raw {
        None | Some("") => default,
        Some(value) => to_number(&serde_json::Value::String(value.to_owned())),
    }
}

fn queue_limit(name: &str, default: f64) -> f64 {
    match std::env::var(name) {
        Ok(value) => queue_limit_from(Some(&value), default),
        Err(_) => queue_limit_from(None, default),
    }
}

pub fn production_queue_limits() -> QueueLimits {
    QueueLimits {
        max_age_seconds: queue_limit(QUEUE_MAX_AGE_ENV, DEFAULT_MAX_AGE_SECONDS),
        processing_max_age_seconds: queue_limit(
            PROCESSING_MAX_AGE_ENV,
            DEFAULT_PROCESSING_MAX_AGE_SECONDS,
        ),
        failure_threshold: queue_limit(FAILURE_THRESHOLD_ENV, DEFAULT_FAILURE_THRESHOLD),
    }
}

/// `Math.max`. Unlike `f64::max`, a NaN argument stays NaN, and mixed zeros are +0.
fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() && right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    left.max(right)
}

/// `Number(value) || fallback`, with a missing Redis field acting as `undefined`.
fn number_or_fallback(raw: Option<&str>, fallback: f64) -> f64 {
    let number = match raw {
        None => f64::NAN,
        Some(text) => to_number(&serde_json::Value::String(text.to_owned())),
    };
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// `Number(value || 0)` for a Redis hash string. Only a missing or empty field
/// is replaced. `"0"`, `"NaN"`, and `"abc"` are present strings.
fn number_or_zero(raw: Option<&str>) -> f64 {
    match raw {
        None | Some("") => 0.0,
        Some(text) => to_number(&serde_json::Value::String(text.to_owned())),
    }
}

fn js_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(flag) => *flag,
        serde_json::Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            number != 0.0 && !number.is_nan()
        }
        serde_json::Value::String(text) => !text.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

fn js_date_millis(value: &serde_json::Value) -> f64 {
    let millis = if let serde_json::Value::String(text) = value {
        match parse_date(js_trim(text)) {
            Some(parsed) => parsed as f64,
            None => return f64::NAN,
        }
    } else {
        to_number(value)
    };
    JsDate::from_millis(millis)
        .timestamp_millis()
        .map(|parsed| parsed as f64)
        .unwrap_or(f64::NAN)
}

/// `JSON.parse(oldest || '{}')`, then `new Date(enqueuedAt || requestedAt || '')`.
/// Property access on `null` throws in JavaScript and is reported as 0 here.
/// A truthy non-string uses `Date`'s numeric conversion, not `Date.parse(String(n))`.
fn queued_at_millis(oldest: Option<&str>) -> f64 {
    let text = match oldest {
        Some(value) if !value.is_empty() => value,
        _ => "{}",
    };
    let parsed = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Null) => return 0.0,
        Ok(value) => value,
        Err(_) => return 0.0,
    };
    let chosen = parsed
        .get("enqueuedAt")
        .filter(|value| js_truthy(value))
        .or_else(|| parsed.get("requestedAt").filter(|value| js_truthy(value)));
    let millis = match chosen {
        Some(value) => js_date_millis(value),
        None => f64::NAN,
    };
    if millis.is_nan() || millis == 0.0 {
        0.0
    } else {
        millis
    }
}

fn finite_json(value: f64) -> JsonValue {
    if value.is_finite() {
        JsonValue::Number(value)
    } else {
        JsonValue::Null
    }
}

fn render_status(status: &QueueStatus, alert: bool) -> String {
    let pending = finite_json(status.pending as f64);
    let processing = finite_json(status.processing as f64);
    let dead = finite_json(status.dead as f64);
    let oldest_age = finite_json(status.oldest_age_seconds);
    let processing_age = finite_json(status.processing_age_seconds);
    let failures = finite_json(status.failures);
    let reasons = JsonValue::Array(
        status
            .reasons
            .iter()
            .map(|reason| JsonValue::String(reason.as_str().into()))
            .collect(),
    );
    let mut fields = Vec::with_capacity(11);
    if alert {
        fields.push(("worker", JsonValueRef::Utf8(QUEUE_ALERT_WORKER)));
        fields.push(("message", JsonValueRef::Utf8(QUEUE_ALERT_MESSAGE)));
    }
    fields.extend([
        ("queue", JsonValueRef::Utf8(status.queue.as_str())),
        ("pending", JsonValueRef::Value(&pending)),
        ("processing", JsonValueRef::Value(&processing)),
        ("dead", JsonValueRef::Value(&dead)),
        ("oldestAgeSeconds", JsonValueRef::Value(&oldest_age)),
        ("processingAgeSeconds", JsonValueRef::Value(&processing_age)),
        ("failures", JsonValueRef::Value(&failures)),
        ("reasons", JsonValueRef::Value(&reasons)),
        ("checkedAt", JsonValueRef::Utf8(status.checked_at.as_str())),
    ]);
    fields_to_json_string(&fields)
}

pub fn queue_snapshot_json(status: &QueueStatus) -> String {
    render_status(status, false)
}

pub fn queue_alert_json(status: &QueueStatus) -> String {
    render_status(status, true)
}

pub fn queue_alert_acquired(reason_count: usize, reply: Option<&str>) -> bool {
    reason_count > 0 && reply == Some("OK")
}

pub fn assess_usage_queue(
    name: &str,
    pending: i64,
    processing: i64,
    dead: i64,
    oldest: Option<&str>,
    previous: &HashMap<String, String>,
    now_ms: i64,
    limits: QueueLimits,
) -> Result<QueueAssessment, QueueHealthError> {
    let checked_at = JsDate::from_millis(now_ms as f64)
        .to_iso_string()
        .map_err(|_| QueueHealthError::InvalidTime)?;
    let now = now_ms as f64;
    let pending_since = if pending != 0 {
        number_or_fallback(previous.get("pendingSince").map(String::as_str), now)
    } else {
        0.0
    };
    let queued_at = queued_at_millis(oldest);
    let oldest_basis = if queued_at == 0.0 { pending_since } else { queued_at };
    let oldest_age_seconds = if pending != 0 {
        js_max(0.0, (now - oldest_basis) / 1000.0)
    } else {
        0.0
    };
    let processing_since = number_or_fallback(previous.get("processingSince").map(String::as_str), now);
    let processing_age_seconds = if processing != 0 {
        js_max(0.0, (now - processing_since) / 1000.0)
    } else {
        0.0
    };
    let failures = number_or_zero(previous.get("failures").map(String::as_str));
    let observed = number_or_zero(previous.get("observedFailures").map(String::as_str));
    let mut reasons = Vec::new();
    if oldest_age_seconds > limits.max_age_seconds {
        reasons.push("queue_age".to_owned());
    }
    if processing_age_seconds > limits.processing_max_age_seconds {
        reasons.push("processing_stalled".to_owned());
    }
    if dead != 0 {
        reasons.push("dead_letters".to_owned());
    }
    if failures - observed >= limits.failure_threshold {
        reasons.push("repeated_failures".to_owned());
    }
    let status = QueueStatus {
        queue: name.to_owned(),
        pending,
        processing,
        dead,
        oldest_age_seconds,
        processing_age_seconds,
        failures,
        reasons,
        checked_at,
    };
    let snapshot_json = queue_snapshot_json(&status);
    let alert_json = queue_alert_json(&status);
    Ok(QueueAssessment {
        pending_since,
        observed_failures: failures,
        pending_since_text: number_string(pending_since),
        observed_failures_text: number_string(failures),
        snapshot_json,
        alert_json,
        status,
    })
}

pub async fn emit_queue_alert(logger: &Logger, status: &QueueStatus) -> LogReport {
    let body = serde_json::from_str(queue_alert_json(status).as_str())
        .expect("queue alert JSON is produced by the lossless writer");
    logger
        .log(
            Level::Warn,
            body,
            LogOptions {
                destination: Destination::Both,
                ..LogOptions::default()
            },
        )
        .await
}

fn unix_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

pub async fn claim_usage_job_in(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
    now_ms: i64,
    prefix: &str,
) -> Result<Option<String>, QueueHealthError> {
    let health = queue_health_key(prefix, queue.name);
    let value: Option<String> = redis::cmd("EVAL")
        .arg(CLAIM_SCRIPT)
        .arg(3)
        .arg(queue.queue)
        .arg(queue.processing)
        .arg(health)
        .arg(now_ms.to_string())
        .query_async(cache)
        .await?;
    Ok(value)
}

pub async fn claim_usage_job(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
    now_ms: i64,
) -> Result<Option<String>, QueueHealthError> {
    claim_usage_job_in(cache, queue, now_ms, HEALTH_KEY_PREFIX).await
}

pub async fn claim_usage_job_now(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
) -> Result<Option<String>, QueueHealthError> {
    claim_usage_job(cache, queue, unix_millis()).await
}

pub async fn complete_usage_job(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
    raw: &str,
) -> Result<(), QueueHealthError> {
    let retry = usage_retry_key(queue.queue, raw);
    let _: i64 = redis::cmd("EVAL")
        .arg(COMPLETE_SCRIPT)
        .arg(2)
        .arg(queue.processing)
        .arg(retry)
        .arg(raw)
        .query_async(cache)
        .await?;
    Ok(())
}

pub async fn fail_usage_job_in(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
    raw: &str,
    invalid: bool,
    max_attempts: i64,
    prefix: &str,
) -> Result<i64, QueueHealthError> {
    let retry = usage_retry_key(queue.queue, raw);
    let health = queue_health_key(prefix, queue.name);
    let limit = if invalid { 1 } else { max_attempts };
    let value: i64 = redis::cmd("EVAL")
        .arg(FAIL_SCRIPT)
        .arg(5)
        .arg(queue.processing)
        .arg(queue.queue)
        .arg(queue.dead)
        .arg(retry)
        .arg(health)
        .arg(raw)
        .arg(limit.to_string())
        .query_async(cache)
        .await?;
    Ok(value)
}

pub async fn fail_usage_job(
    cache: &mut ConnectionManager,
    queue: UsageQueue<'_>,
    raw: &str,
    invalid: bool,
    max_attempts: i64,
) -> Result<i64, QueueHealthError> {
    fail_usage_job_in(cache, queue, raw, invalid, max_attempts, HEALTH_KEY_PREFIX).await
}

async fn list_len(cache: &mut ConnectionManager, key: &str) -> Result<i64, QueueHealthError> {
    Ok(redis::cmd("LLEN").arg(key).query_async(cache).await?)
}

pub async fn monitor_ai_usage_queues_in(
    cache: &mut ConnectionManager,
    logger: &Logger,
    now_ms: i64,
    queues: &[UsageQueue<'_>],
    prefix: &str,
    limits: QueueLimits,
) -> Result<Vec<QueueStatus>, QueueHealthError> {
    let mut statuses = Vec::with_capacity(queues.len());
    for queue in queues {
        let pending = list_len(cache, queue.queue).await?;
        let processing = list_len(cache, queue.processing).await?;
        let dead = list_len(cache, queue.dead).await?;
        let oldest: Option<String> = redis::cmd("LINDEX")
            .arg(queue.queue)
            .arg(0)
            .query_async(cache)
            .await?;
        let health = queue_health_key(prefix, queue.name);
        let previous: HashMap<String, String> = redis::cmd("HGETALL")
            .arg(&health)
            .query_async(cache)
            .await?;
        // Invalid `checkedAt` fails before SET, HSET, or the alert key.
        let assessment = assess_usage_queue(
            queue.name,
            pending,
            processing,
            dead,
            oldest.as_deref(),
            &previous,
            now_ms,
            limits,
        )?;
        let _: Option<String> = redis::cmd("SET")
            .arg(queue_snapshot_key(prefix, queue.name))
            .arg(&assessment.snapshot_json)
            .arg("EX")
            .arg(SNAPSHOT_TTL_SECONDS)
            .query_async(cache)
            .await?;
        let _: i64 = redis::cmd("HSET")
            .arg(&health)
            .arg("pendingSince")
            .arg(&assessment.pending_since_text)
            .arg("observedFailures")
            .arg(&assessment.observed_failures_text)
            .query_async(cache)
            .await?;
        if !assessment.status.reasons.is_empty() {
            let reply: Option<String> = redis::cmd("SET")
                .arg(queue_alert_key(prefix, queue.name))
                .arg("1")
                .arg("NX")
                .arg("EX")
                .arg(ALERT_TTL_SECONDS)
                .query_async(cache)
                .await?;
            if queue_alert_acquired(assessment.status.reasons.len(), reply.as_deref()) {
                // The alert key stays set when the logger sink fails.
                emit_queue_alert(logger, &assessment.status).await;
            }
        }
        statuses.push(assessment.status);
    }
    Ok(statuses)
}

pub async fn monitor_ai_usage_queues(
    cache: &mut ConnectionManager,
    logger: &Logger,
    now_ms: i64,
) -> Result<Vec<QueueStatus>, QueueHealthError> {
    monitor_ai_usage_queues_in(
        cache,
        logger,
        now_ms,
        &USAGE_QUEUES,
        HEALTH_KEY_PREFIX,
        production_queue_limits(),
    )
    .await
}

pub async fn monitor_ai_usage_queues_with_redis(
    logger: &Logger,
    now_ms: i64,
) -> Result<Vec<QueueStatus>, QueueHealthError> {
    let mut cache = super::redis::get_redis_client().await?;
    monitor_ai_usage_queues(&mut cache, logger, now_ms).await
}

pub async fn monitor_ai_usage_queues_production(
    logger: &Logger,
) -> Result<Vec<QueueStatus>, QueueHealthError> {
    monitor_ai_usage_queues_with_redis(logger, unix_millis()).await
}
