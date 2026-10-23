//! Library-only port of `dimabot/src/utils/cron_jobs_queue.ts`.
//!
//! Connections, clocks, UUIDs, and the captured dedupe configuration are injected;
//! importing this module never reads environment variables or connects to Redis.
//! JSON wire equivalence is structural, not byte-for-byte: serde_json's existing
//! map ordering and number formatting are retained. No global serde features are
//! changed. Optional `None` is JS `undefined`; `Some(Value::Null)` is JSON null.
//! `parse_cron_queue_job` intentionally accepts array data, as the source does.
//! Rust strings/JSON cannot represent JS undefined, functions, cyclic objects,
//! lone UTF-16 surrogates, or non-finite JSON numbers. Those are outside this API.
//! Parsing has an explicit 127-container depth bound, including the job object,
//! and returns CronQueueParseError rather than silently discarding deeper jobs.
//! This is a deliberate migration boundary: JS accepts deeper data. Callers
//! must preserve/quarantine/reject these payloads explicitly, not treat resource
//! errors as malformed-job None. serde_json's global recursion guard is unchanged.
//! Typed structs expose the declared job fields; JS-only extra properties are
//! not retained by typed deserialization (the source parser also drops them).
//!
//! Consumer boundaries traced in the active TypeScript sources:
//! - follow ledger and stream memory destructively BLPOP from the left and
//!   requeue with RPUSH; both RPUSH unsupported jobs before clearing dedupe.
//! - stream memory and clips share attempt normalization and increment only.
//!   Retry limits, future-due checks, delays, and dedupe cleanup remain policies.
//! - clips BLMOVE RIGHT/LEFT into a processing list and fence acknowledge,
//!   requeue, recovery, and dead-letter operations with an owner lease. Those
//!   scripts have no counterpart in the other two workers and are NOT exposed
//!   as a universal claim API here. A clip migration must port the full fenced
//!   protocol separately, including raw-payload identity and lease loss.

use redis::{RedisResult, aio::ConnectionManager};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::js_compat::trim;

pub const CRON_JOBS_QUEUE_KEY: &str = "cron:jobs:queue";
pub const CRON_JOBS_DEAD_LETTER_KEY: &str = "cron:jobs:dead-letter";
pub const CRON_JOBS_DEDUPE_PREFIX: &str = "cron:jobs:dedupe";
/// Maximum open JSON objects/arrays, including the outer job object. Matches
/// the existing serde_json guard without enabling its unbounded_depth feature.
pub const CRON_QUEUE_JSON_MAX_DEPTH: usize = 127;

// Kept verbatim, including rollback ordering, from cron_jobs_queue.ts. Redis
// Lua does not roll writes back on errors; both explicit cleanup paths matter.
pub const ENQUEUE_DEDUPLICATED_JOB: &str = r#"
if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
if KEYS[3] then
    local accepted = redis.pcall('SET', KEYS[3], '1')
    if type(accepted) == 'table' and accepted.err then
        redis.call('DEL', KEYS[1])
        return redis.error_reply(accepted.err)
    end
end
local pushed = redis.pcall('LPUSH', KEYS[2], ARGV[2])
if type(pushed) == 'table' and pushed.err then
    redis.call('DEL', KEYS[1])
    if KEYS[3] then redis.call('DEL', KEYS[3]) end
    return redis.error_reply(pushed.err)
end
return 1
"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronQueueJob {
    pub id: String,
    pub job: String,
    pub requested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(rename = "accountID", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
}

/// Strings retain their raw input until preparation. JSON deserialization also
/// models the source's `typeof value === 'string'` checks for invalid casts.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueCronJobInput {
    #[serde(default, deserialize_with = "input_text")]
    pub job: String,
    #[serde(default, deserialize_with = "input_optional_text")]
    pub requested_by: Option<String>,
    #[serde(rename = "userID", default, deserialize_with = "input_optional_text")]
    pub user_id: Option<String>,
    #[serde(
        rename = "accountID",
        default,
        deserialize_with = "input_optional_text"
    )]
    pub account_id: Option<String>,
    #[serde(
        rename = "channelID",
        default,
        deserialize_with = "input_optional_text"
    )]
    pub channel_id: Option<String>,
    #[serde(default, deserialize_with = "present_json")]
    pub data: Option<Value>,
    #[serde(default, deserialize_with = "input_optional_text")]
    pub dedupe_token: Option<String>,
    // JSON preserves the Number(value || default) boundary, including numeric
    // strings, booleans, null, and arrays passed by invalid TS runtime casts.
    #[serde(default, deserialize_with = "present_json")]
    pub dedupe_seconds: Option<Value>,
    #[serde(default, deserialize_with = "input_optional_text")]
    pub queue_key: Option<String>,
}

fn input_text<'de, D: Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    Ok(Value::deserialize(input)?.as_str().unwrap_or("").to_owned())
}

fn input_optional_text<'de, D: Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Ok(Value::deserialize(input)?.as_str().map(str::to_owned))
}

fn present_json<'de, D: Deserializer<'de>>(input: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(input).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnqueueCronJobResult {
    pub enqueued: bool,
    pub message: String,
    pub job: CronQueueJob,
}

/// Supply a UTC ISO timestamp with milliseconds, matching Date.toISOString().
/// Kept independent of MongoDB/BSON and of process-global environment setup.
pub trait CronQueueClock {
    fn now_iso(&mut self) -> String;
}

pub trait CronQueueUuidSource {
    fn random_uuid(&mut self) -> String;
}

#[derive(Debug, Default)]
pub struct RandomUuidSource;

impl CronQueueUuidSource for RandomUuidSource {
    fn random_uuid(&mut self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CronQueueConfig {
    pub default_dedupe_seconds: f64,
}

impl Default for CronQueueConfig {
    fn default() -> Self {
        Self {
            default_dedupe_seconds: 900.0,
        }
    }
}

impl CronQueueConfig {
    /// Capture CRON_JOBS_DEDUPE_SECONDS explicitly, as the TS module does at
    /// import. Empty/missing defaults to 900, "0" clamps to 60, malformed values
    /// remain NaN and reach Redis as an invalid EX argument (not silently fixed).
    pub fn from_dedupe_seconds_env(value: Option<&str>) -> Self {
        let value = value.filter(|text| !text.is_empty()).unwrap_or("900");
        Self {
            default_dedupe_seconds: at_least_sixty(number_from_text(value)),
        }
    }
}

fn optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn normalized_value(value: &Value) -> Option<String> {
    optional_text(value.as_str())
}

pub fn get_cron_job_dedupe_key(token: &str) -> String {
    format!("{CRON_JOBS_DEDUPE_PREFIX}:{}", trim(token))
}

/// Serialization is deliberately separate from parsing: it performs no trim,
/// repair, or validation, just like JSON.stringify(job). Property order and
/// number spelling are not a byte-parity contract; see the module boundary.
pub fn serialize_cron_queue_job(job: &CronQueueJob) -> serde_json::Result<String> {
    serde_json::to_string(job)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CronQueueParseError {
    DepthLimitExceeded { maximum_depth: usize },
}

impl std::fmt::Display for CronQueueParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DepthLimitExceeded { maximum_depth } => {
                write!(
                    formatter,
                    "cron queue JSON exceeds the {maximum_depth}-container depth limit"
                )
            }
        }
    }
}

impl std::error::Error for CronQueueParseError {}

// An iterative lexical preflight makes this a public resource boundary instead
// of classifying serde_json's private RecursionLimitExceeded code by its error
// text. Quotes and escapes are respected; delimiters in data strings don't
// consume depth. JSON syntax validation still belongs to serde_json. Even an
// invalid payload gets a resource error if this bound is reached first.
fn check_json_depth(payload: &str) -> Result<(), CronQueueParseError> {
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in payload.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else {
            match byte {
                b'"' => in_string = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > CRON_QUEUE_JSON_MAX_DEPTH {
                        return Err(CronQueueParseError::DepthLimitExceeded {
                            maximum_depth: CRON_QUEUE_JSON_MAX_DEPTH,
                        });
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    Ok(())
}

/// Invalid JSON/missing names are Ok(None), matching the source. Exceeding the
/// explicit parser depth budget is Err and must remain visible to consumers.
pub fn parse_cron_queue_job(
    payload: &str,
    clock: &mut impl CronQueueClock,
    uuids: &mut impl CronQueueUuidSource,
) -> Result<Option<CronQueueJob>, CronQueueParseError> {
    check_json_depth(payload)?;
    let parsed: Value = match serde_json::from_str(payload) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };
    let Some(job) = normalized_value(&parsed["job"]) else {
        return Ok(None);
    };
    Ok(Some(CronQueueJob {
        id: normalized_value(&parsed["id"]).unwrap_or_else(|| uuids.random_uuid()),
        job,
        // Source validates nonblank strings, not their date/UUID syntax.
        requested_at: normalized_value(&parsed["requestedAt"]).unwrap_or_else(|| clock.now_iso()),
        requested_by: normalized_value(&parsed["requestedBy"]),
        user_id: normalized_value(&parsed["userID"]),
        account_id: normalized_value(&parsed["accountID"]),
        channel_id: normalized_value(&parsed["channelID"]),
        data: parsed
            .get("data")
            .filter(|value| value.is_object() || value.is_array())
            .cloned(),
        dedupe_key: normalized_value(&parsed["dedupeKey"]),
    }))
}

/// Inspectable, deterministic transport request used by the real Redis adapter.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CronEnqueueCommand {
    pub keys: Vec<String>,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCronJob {
    pub result: EnqueueCronJobResult,
    pub command: Option<CronEnqueueCommand>,
}

pub fn prepare_enqueue_cron_job(
    input: &EnqueueCronJobInput,
    config: CronQueueConfig,
    clock: &mut impl CronQueueClock,
    uuids: &mut impl CronQueueUuidSource,
) -> serde_json::Result<PreparedCronJob> {
    let normalized_job = trim(&input.job);
    let mut job = CronQueueJob {
        id: uuids.random_uuid(),
        job: normalized_job.to_owned(),
        requested_at: clock.now_iso(),
        requested_by: None,
        user_id: None,
        account_id: None,
        channel_id: None,
        data: None,
        dedupe_key: None,
    };
    if normalized_job.is_empty() {
        return Ok(PreparedCronJob {
            result: EnqueueCronJobResult {
                enqueued: false,
                message: "Invalid cron job name".into(),
                job,
            },
            command: None,
        });
    }
    job.requested_by = optional_text(input.requested_by.as_deref());
    job.user_id = optional_text(input.user_id.as_deref());
    job.account_id = optional_text(input.account_id.as_deref());
    job.channel_id = optional_text(input.channel_id.as_deref());
    job.data = input.data.clone();
    let token = optional_text(input.dedupe_token.as_deref()).unwrap_or_else(|| {
        [
            Some(normalized_job),
            job.channel_id.as_deref(),
            job.user_id.as_deref(),
            job.account_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(":")
    });
    let seconds = input
        .dedupe_seconds
        .as_ref()
        .filter(|value| truthy(value))
        .map(number)
        .unwrap_or(config.default_dedupe_seconds);
    let seconds = at_least_sixty(seconds);
    let queue =
        optional_text(input.queue_key.as_deref()).unwrap_or_else(|| CRON_JOBS_QUEUE_KEY.into());
    let dedupe = get_cron_job_dedupe_key(&token);
    job.dedupe_key = Some(dedupe.clone());
    let mut keys = vec![dedupe, queue];
    if let Some(data) = &input.data
        && data.get("source").and_then(Value::as_str) == Some("stream_offline")
        && let Some(session) = data.get("sessionID").and_then(normalized_value)
    {
        keys.push(format!(
            "cron:jobs:accepted:{normalized_job}:{}:{session}",
            job.channel_id.as_deref().unwrap_or("")
        ));
    }
    // For every valid job the default token contains its nonempty name. Thus
    // TS's undeduplicated LPUSH branch is unreachable at this public boundary.
    let arguments = vec![number_argument(seconds), serialize_cron_queue_job(&job)?];
    Ok(PreparedCronJob {
        result: EnqueueCronJobResult {
            enqueued: true,
            message: "Cron job queued".into(),
            job,
        },
        command: Some(CronEnqueueCommand { keys, arguments }),
    })
}

/// Real adapter over an injected redis-rs manager. Errors propagate, including
/// ambiguous response loss: callers may replay the input, letting Lua dedupe.
/// This adapter does not retry application commands, open connections, or read
/// the process environment. Its configuration is fixed when constructed.
#[derive(Clone)]
pub struct RedisCronQueue {
    connection: ConnectionManager,
    config: CronQueueConfig,
}

impl RedisCronQueue {
    pub fn new(connection: ConnectionManager, config: CronQueueConfig) -> Self {
        Self { connection, config }
    }

    pub async fn enqueue_cron_job(
        &mut self,
        input: &EnqueueCronJobInput,
        clock: &mut impl CronQueueClock,
        uuids: &mut impl CronQueueUuidSource,
    ) -> Result<EnqueueCronJobResult, CronQueueError> {
        let prepared = prepare_enqueue_cron_job(input, self.config, clock, uuids)?;
        let mut result = prepared.result;
        if let Some(command) = prepared.command {
            let accepted: i64 = redis::cmd("EVAL")
                .arg(ENQUEUE_DEDUPLICATED_JOB)
                .arg(command.keys.len())
                .arg(&command.keys)
                .arg(&command.arguments)
                .query_async(&mut self.connection)
                .await?;
            if accepted == 0 {
                result.enqueued = false;
                result.message = "Cron job already queued recently".into();
            }
        }
        Ok(result)
    }

    /// Clears only this normalized key. Never derives or clears acceptance.
    pub async fn clear_cron_job_dedupe_by_key(&mut self, key: Option<&str>) -> RedisResult<()> {
        clear_cron_job_dedupe_by_key(&mut self.connection, key).await
    }
}

#[derive(Debug)]
pub enum CronQueueError {
    Json(serde_json::Error),
    Redis(redis::RedisError),
}

impl std::fmt::Display for CronQueueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(error) => std::fmt::Display::fmt(error, formatter),
            Self::Redis(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for CronQueueError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Redis(error) => Some(error),
        }
    }
}

impl From<serde_json::Error> for CronQueueError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<redis::RedisError> for CronQueueError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

pub async fn clear_cron_job_dedupe_by_key(
    connection: &mut ConnectionManager,
    key: Option<&str>,
) -> RedisResult<()> {
    if let Some(key) = optional_text(key) {
        let _: i64 = redis::cmd("DEL").arg(key).query_async(connection).await?;
    }
    Ok(())
}

/// Destructive left pop shared by follow ledger and stream memory. A dedicated
/// manager/socket is required for blocking work; do not share it with producer
/// or lease heartbeats. No ownership, acknowledgement, or crash recovery is
/// implied. The raw payload is retained so the caller decides malformed policy.
pub async fn pop_left_blocking_raw(
    connection: &mut ConnectionManager,
    queue_key: &str,
    timeout_seconds: f64,
) -> RedisResult<Option<(String, String)>> {
    redis::cmd("BLPOP")
        .arg(queue_key)
        .arg(timeout_seconds)
        .query_async(connection)
        .await
}

/// RPUSH is the shared transport primitive for requeues and dead-letter writes.
/// This neither increments attempts nor clears markers. In the source those
/// steps are separate and caller-specific, including their failure ordering.
pub async fn push_right_job(
    connection: &mut ConnectionManager,
    queue_key: &str,
    job: Option<&CronQueueJob>,
) -> Result<(), CronQueueError> {
    if let Some(job) = job {
        let payload = serialize_cron_queue_job(job)?;
        let _: i64 = redis::cmd("RPUSH")
            .arg(queue_key)
            .arg(payload)
            .query_async(connection)
            .await?;
    }
    Ok(())
}

/// Exact overlap of stream memory's getJobAttempt and clips' getClipJobAttempt.
/// Fractional positive attempts below 1 floor to 0 in both sources; retain that
/// behavior. No retry limit, retryability, scheduling, or dead-letter policy.
pub fn get_job_attempt(job: Option<&CronQueueJob>) -> f64 {
    let attempt = job
        .and_then(|job| job.data.as_ref())
        .and_then(|data| data.get("attempt"));
    let attempt = attempt
        .filter(|value| truthy(value))
        .map(number)
        .unwrap_or(1.0);
    if attempt.is_finite() && attempt > 0.0 {
        attempt.floor()
    } else {
        1.0
    }
}

/// Exact shared increment, including spreading array data into numeric fields.
/// This helper is for parsed jobs, whose data is an object, array, or absent.
pub fn with_next_attempt(job: Option<&CronQueueJob>) -> Option<CronQueueJob> {
    let job = job?;
    let mut next = job.clone();
    let mut data = match &job.data {
        Some(Value::Object(data)) => data.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        _ => Map::new(),
    };
    let attempt = get_job_attempt(Some(job)) + 1.0;
    // JS uses double precision, including rounding at and above 2^53.
    data.insert("attempt".into(), Value::from(attempt));
    next.data = Some(Value::Object(data));
    Some(next)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn at_least_sixty(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(60.0)
    }
}

fn number_argument(value: f64) -> String {
    if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        value.to_string()
    }
}

fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => number_from_text(value),
        Value::Array(values) => number_from_text(&array_string(values)),
        Value::Object(_) => f64::NAN,
    }
}

fn array_string(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| match value {
            Value::Null => String::new(),
            Value::String(value) => value.clone(),
            Value::Array(values) => array_string(values),
            Value::Object(_) => "[object Object]".into(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn number_from_text(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0b", "0B"], 2), (["0o", "0O"], 8)] {
        if let Some(digits) = prefixes
            .into_iter()
            .find_map(|prefix| text.strip_prefix(prefix))
        {
            return radix_number(digits, radix);
        }
    }
    // Rust accepts "inf" and other spellings that JS Number rejects. Validate
    // the ECMAScript decimal grammar before using the platform decimal parser.
    let bytes = text.as_bytes();
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        digits += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if start == index {
            return f64::NAN;
        }
    }
    if index != bytes.len() {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

// Power-of-two radix integers round exactly once to the nearest binary64,
// ties to even. Per-digit f64 multiplication/addition can double-round, e.g.
// 0x200000000000011. Same bit algorithm as credit_policy's private helper,
// streamed here with constant storage; no cross-feature dependency is added.
fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let width = radix.trailing_zeros();
    let mut bit_count = 0_usize;
    let mut significand = 0_u64;
    let mut round_bit = false;
    let mut sticky = false;
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(radix) else {
            return f64::NAN;
        };
        for shift in (0..width).rev() {
            let bit = (digit >> shift) & 1;
            if bit_count == 0 && bit == 0 {
                continue;
            }
            bit_count = bit_count.saturating_add(1);
            match bit_count {
                1..=53 => significand = (significand << 1) | u64::from(bit),
                54 => round_bit = bit != 0,
                _ => sticky |= bit != 0,
            }
        }
    }
    // Validate all trailing digits before reporting overflow, so an invalid
    // suffix is NaN even when the valid prefix already exceeded binary64.
    if bit_count > 1024 {
        return f64::INFINITY;
    }
    if bit_count <= 53 {
        return significand as f64;
    }
    if round_bit && (sticky || significand & 1 != 0) {
        significand += 1;
    }
    (significand as f64) * 2.0_f64.powi((bit_count - 53) as i32)
}
