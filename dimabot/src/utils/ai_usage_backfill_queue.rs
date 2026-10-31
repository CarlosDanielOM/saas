//! AI usage backfill queue.
//!
//! `AI_USAGE_BACKFILL_DEDUPE_SECONDS` is read when an enqueue call omits its own
//! TTL. The TypeScript module captures that value at import. Passing the TTL,
//! queue, and prefix on the input keeps tests off the process environment.
//!
//! `safe_part` trims strings and drops every other JSON type. It does not remove
//! colons, so distinct channel and customer pairs can share one dedupe key.
//! Job JSON uses the lossless writer: insertion order, integral `attempts` of
//! `0` rather than `0.0`, and `null` for non-finite numbers. `serde_json` still
//! rejects lone surrogates that `JSON.parse` would keep, and the shared string
//! writer does not escape U+2028 or U+2029 the way ES2019 `JSON.stringify` does.
//! Date strings are trimmed with ECMAScript whitespace before `parse_date`,
//! because that parser rejects surrounding spaces that `Date.parse` accepts.

use std::{
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use redis::aio::ConnectionManager;
use serde_json::Value;

use super::{
    ai_usage_producer::get_ai_usage_retention_days,
    credit_policy::JsDate,
    js_compat::trim as js_trim,
    js_date::parse_date,
    json_number::{number_string, to_number},
    lossless_json::{JsonValue, JsonValueRef, fields_to_json_string},
};

pub const AI_USAGE_BACKFILL_QUEUE_KEY: &str = "cron:ai-usage-backfills:queue";
pub const AI_USAGE_BACKFILL_PROCESSING_KEY: &str = "cron:ai-usage-backfills:processing";
pub const AI_USAGE_BACKFILL_DEAD_KEY: &str = "cron:ai-usage-backfills:dead";
pub const AI_USAGE_BACKFILL_DEDUPE_PREFIX: &str = "cron:ai-usage-backfills:dedupe";
/// Local copy of `AI_USAGE_REPORT_VERSION`. This module does not import a ledger store.
pub const AI_USAGE_BACKFILL_REPORT_VERSION: i32 = 3;
pub const AI_USAGE_BACKFILL_DEDUPE_ENV: &str = "AI_USAGE_BACKFILL_DEDUPE_SECONDS";
pub const AI_USAGE_BACKFILL_DEDUPE_DEFAULT_SECONDS: f64 = 172_800.0;
pub const AI_USAGE_BACKFILL_DEDUPE_MIN_SECONDS: f64 = 300.0;

/// Leading newline, two spaces before `RPUSH`, and the trailing newline are part of the source text.
pub const ENQUEUE_SCRIPT: &str = r#"
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  redis.call('RPUSH', KEYS[2], ARGV[3])
  return 1
end
return 0
"#;

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageBackfillJob {
    pub id: String,
    pub channel_id: String,
    pub customer_id: String,
    pub plan_tier: String,
    pub coverage_start: String,
    pub requested_at: String,
    pub reason: String,
    pub attempts: f64,
    pub dedupe_key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedBackfillPlan {
    pub queue_key: String,
    pub dedupe_prefix: String,
    pub dedupe_seconds: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackfillEnqueuePlan {
    pub job: AiUsageBackfillJob,
    pub queue_key: String,
    pub payload: String,
    pub dedupe_ex: String,
}

pub struct EnqueueAiUsageBackfillInput<'a> {
    pub channel_id: &'a Value,
    pub customer_id: &'a Value,
    pub plan_tier: &'a Value,
    pub coverage_start: Option<JsDate>,
    pub reason: Option<&'a str>,
    pub now: Option<JsDate>,
    /// `None` selects [`AI_USAGE_BACKFILL_QUEUE_KEY`].
    pub queue_key: Option<&'a str>,
    /// `None` selects [`AI_USAGE_BACKFILL_DEDUPE_PREFIX`].
    pub dedupe_prefix: Option<&'a str>,
    /// `None` reads [`AI_USAGE_BACKFILL_DEDUPE_ENV`] at the call, then applies the source floor.
    pub dedupe_seconds: Option<f64>,
    /// `None` allocates a lowercase UUID v4. `Some` is copied as given.
    pub id: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueAiUsageBackfillResult {
    pub enqueued: bool,
    pub job: AiUsageBackfillJob,
}

#[derive(Debug)]
pub enum BackfillQueueError {
    Identity,
    InvalidDate,
    Redis(redis::RedisError),
}

impl fmt::Display for BackfillQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity => f.write_str("AI usage backfill requires channel and customer IDs"),
            Self::InvalidDate => f.write_str("Invalid time value"),
            Self::Redis(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for BackfillQueueError {}

impl From<redis::RedisError> for BackfillQueueError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

/// `typeof value === 'string' ? value.trim() : ''`.
pub fn safe_part(value: &Value) -> String {
    match value {
        Value::String(text) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

pub fn normalize_tier(value: &Value) -> &'static str {
    match value.as_str() {
        Some("pro") => "pro",
        Some("premium") => "premium",
        _ => "free",
    }
}

pub fn get_ai_usage_desired_coverage_start(plan_tier: &JsonValue, now_ms: i64) -> i64 {
    let days = i64::from(get_ai_usage_retention_days(plan_tier));
    let midnight = now_ms.div_euclid(86_400_000) * 86_400_000;
    midnight - (days - 1) * 86_400_000
}

pub use get_ai_usage_desired_coverage_start as desired_coverage_start;

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

fn falsy_json(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !*flag,
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            number == 0.0 || number.is_nan()
        }
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => number_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(value || '')`, then `Date.parse` and `toISOString`.
fn canonical_date(value: Option<&Value>) -> Option<String> {
    let text = match value {
        None => String::new(),
        Some(value) if falsy_json(value) => String::new(),
        Some(value) => js_string(value),
    };
    let millis = parse_date(js_trim(&text))?;
    JsDate::from_millis(millis as f64).to_iso_string().ok()
}

fn attempts_of(value: Option<&Value>) -> f64 {
    let Some(Value::Number(number)) = value else {
        return 0.0;
    };
    let number = number.as_f64().unwrap_or(f64::NAN);
    if number.is_finite() && number.fract() == 0.0 {
        js_max(0.0, number)
    } else {
        0.0
    }
}

fn reason_of(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("daily_sweep") => "daily_sweep",
        Some("startup_sweep") => "startup_sweep",
        _ => "api_request",
    }
}

pub fn parse_ai_usage_backfill_job(raw: &str) -> Option<AiUsageBackfillJob> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    if !parsed.is_object() {
        return None;
    }
    let id = safe_part(parsed.get("id").unwrap_or(&Value::Null));
    let channel_id = safe_part(parsed.get("channelID").unwrap_or(&Value::Null));
    let customer_id = safe_part(parsed.get("customerId").unwrap_or(&Value::Null));
    let dedupe_key = safe_part(parsed.get("dedupeKey").unwrap_or(&Value::Null));
    if id.is_empty() || channel_id.is_empty() || customer_id.is_empty() || dedupe_key.is_empty() {
        return None;
    }
    Some(AiUsageBackfillJob {
        id,
        channel_id,
        customer_id,
        plan_tier: normalize_tier(parsed.get("planTier").unwrap_or(&Value::Null)).to_owned(),
        coverage_start: canonical_date(parsed.get("coverageStart"))?,
        requested_at: canonical_date(parsed.get("requestedAt"))?,
        reason: reason_of(parsed.get("reason")).to_owned(),
        attempts: attempts_of(parsed.get("attempts")),
        dedupe_key,
    })
}

/// `Math.max(300, Number(raw || 172800))`. `None` and `""` use the default.
/// `"abc"` stays NaN. `"Infinity"` stays infinite. Fractional values are not floored.
pub fn backfill_dedupe_seconds_from(raw: Option<&str>) -> f64 {
    let number = match raw {
        None | Some("") => AI_USAGE_BACKFILL_DEDUPE_DEFAULT_SECONDS,
        Some(value) => to_number(&Value::String(value.to_owned())),
    };
    js_max(AI_USAGE_BACKFILL_DEDUPE_MIN_SECONDS, number)
}

pub fn backfill_dedupe_seconds() -> f64 {
    match std::env::var(AI_USAGE_BACKFILL_DEDUPE_ENV) {
        Ok(value) => backfill_dedupe_seconds_from(Some(&value)),
        Err(_) => backfill_dedupe_seconds_from(None),
    }
}

pub fn backfill_dedupe_ex(seconds: f64) -> String {
    number_string(seconds)
}

pub fn backfill_dedupe_key(prefix: &str, channel_id: &str, customer_id: &str) -> String {
    format!("{prefix}:v{AI_USAGE_BACKFILL_REPORT_VERSION}:{channel_id}:{customer_id}")
}

pub fn resolve_backfill_plan(
    queue_key: Option<&str>,
    dedupe_prefix: Option<&str>,
    dedupe_seconds: Option<f64>,
    env_seconds: Option<&str>,
) -> ResolvedBackfillPlan {
    ResolvedBackfillPlan {
        queue_key: queue_key.unwrap_or(AI_USAGE_BACKFILL_QUEUE_KEY).to_owned(),
        dedupe_prefix: dedupe_prefix
            .unwrap_or(AI_USAGE_BACKFILL_DEDUPE_PREFIX)
            .to_owned(),
        dedupe_seconds: match dedupe_seconds {
            Some(seconds) => js_max(AI_USAGE_BACKFILL_DEDUPE_MIN_SECONDS, seconds),
            None => backfill_dedupe_seconds_from(env_seconds),
        },
    }
}

pub fn backfill_job_json(job: &AiUsageBackfillJob) -> String {
    fields_to_json_string(&[
        ("id", JsonValueRef::Utf8(&job.id)),
        ("channelID", JsonValueRef::Utf8(&job.channel_id)),
        ("customerId", JsonValueRef::Utf8(&job.customer_id)),
        ("planTier", JsonValueRef::Utf8(&job.plan_tier)),
        ("coverageStart", JsonValueRef::Utf8(&job.coverage_start)),
        ("requestedAt", JsonValueRef::Utf8(&job.requested_at)),
        ("reason", JsonValueRef::Utf8(&job.reason)),
        ("attempts", JsonValueRef::Number(job.attempts)),
        ("dedupeKey", JsonValueRef::Utf8(&job.dedupe_key)),
    ])
}

fn unix_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

pub fn prepare_ai_usage_backfill_job(
    input: &EnqueueAiUsageBackfillInput<'_>,
    env_seconds: Option<&str>,
) -> Result<BackfillEnqueuePlan, BackfillQueueError> {
    let now = input
        .now
        .unwrap_or_else(|| JsDate::from_millis(unix_millis() as f64));
    let channel_id = safe_part(input.channel_id);
    let customer_id = safe_part(input.customer_id);
    if channel_id.is_empty() || customer_id.is_empty() {
        return Err(BackfillQueueError::Identity);
    }
    let plan_tier = normalize_tier(input.plan_tier);
    let coverage = match input.coverage_start {
        Some(coverage) => coverage,
        None => {
            let now_ms = now
                .timestamp_millis()
                .ok_or(BackfillQueueError::InvalidDate)?;
            let tier = JsonValue::String(plan_tier.into());
            JsDate::from_millis(get_ai_usage_desired_coverage_start(&tier, now_ms) as f64)
        }
    };
    let coverage_start = coverage
        .to_iso_string()
        .map_err(|_| BackfillQueueError::InvalidDate)?;
    let requested_at = now
        .to_iso_string()
        .map_err(|_| BackfillQueueError::InvalidDate)?;
    let policy = resolve_backfill_plan(
        input.queue_key,
        input.dedupe_prefix,
        input.dedupe_seconds,
        env_seconds,
    );
    let reason = match input.reason {
        Some(reason) if !reason.is_empty() => reason,
        _ => "api_request",
    };
    let dedupe_key = backfill_dedupe_key(&policy.dedupe_prefix, &channel_id, &customer_id);
    let job = AiUsageBackfillJob {
        id: input
            .id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        channel_id,
        customer_id,
        plan_tier: plan_tier.to_owned(),
        coverage_start,
        requested_at,
        reason: reason.to_owned(),
        attempts: 0.0,
        dedupe_key,
    };
    let payload = backfill_job_json(&job);
    Ok(BackfillEnqueuePlan {
        dedupe_ex: backfill_dedupe_ex(policy.dedupe_seconds),
        queue_key: policy.queue_key,
        payload,
        job,
    })
}

pub async fn enqueue_ai_usage_backfill(
    cache: &mut ConnectionManager,
    input: EnqueueAiUsageBackfillInput<'_>,
) -> Result<EnqueueAiUsageBackfillResult, BackfillQueueError> {
    let env_value;
    let env_seconds = if input.dedupe_seconds.is_none() {
        env_value = std::env::var(AI_USAGE_BACKFILL_DEDUPE_ENV).ok();
        env_value.as_deref()
    } else {
        None
    };
    let prepared = prepare_ai_usage_backfill_job(&input, env_seconds)?;
    let enqueued: i64 = redis::cmd("EVAL")
        .arg(ENQUEUE_SCRIPT)
        .arg(2)
        .arg(&prepared.job.dedupe_key)
        .arg(&prepared.queue_key)
        .arg(&prepared.job.id)
        .arg(&prepared.dedupe_ex)
        .arg(&prepared.payload)
        .query_async(cache)
        .await?;
    Ok(EnqueueAiUsageBackfillResult {
        enqueued: enqueued == 1,
        job: prepared.job,
    })
}

/// Opens the shared Dragonfly client. Importing this module does not connect.
pub async fn enqueue_ai_usage_backfill_with_client(
    input: EnqueueAiUsageBackfillInput<'_>,
) -> Result<EnqueueAiUsageBackfillResult, BackfillQueueError> {
    let mut cache = super::redis::get_redis_client().await?;
    enqueue_ai_usage_backfill(&mut cache, input).await
}
