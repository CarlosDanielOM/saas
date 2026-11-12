//! The cron job queue protocol, ported from the pre-existing crate (`dima-rust/src/utils/
//! cron_queue.rs`) onto this module's client. TypeScript originals:
//! `dimabot/src/utils/cron_jobs_queue.ts` and the Redis half of `dimabot/src/utils/durable_cron_jobs.ts`.
//!
//! A job travels as the bytes of `JSON.stringify(job)`. Field order is `id, job, requestedAt,
//! requestedBy?, userID?, accountID?, channelID?, data?, dedupeKey?`; absent fields are omitted;
//! numbers inside `data` are written as JavaScript writes them. [`CronQueueJob::to_item`] produces
//! exactly those bytes, and a popped job is carried as its [`QueueItem`] (requeue, dead letter
//! and `LREM` use the popped bytes).
//!
//! Enqueueing goes through `ENQUEUE_DEDUPLICATED_JOB` (verbatim, `lua/cron_enqueue_deduplicated_job.lua`):
//! one atomic step sets the dedupe marker (`SET NX EX`), the optional session acceptance marker,
//! and `LPUSH`es the job, rolling the markers back if the push fails. Jobs the reference routes to
//! the durable path (stream memory summaries and maintenance, clip analysis) need the Mongo
//! `CronJobIntent` step first; [`prepare_enqueue_cron_job`] returns [`EnqueuePlan::Durable`] for
//! them instead of pushing, and [`publish_durable_cron_job`] is the Redis half of that path.
//!
//! Clock and UUIDs are passed in; nothing here reads the environment.

use super::client::Dragonfly;
use super::commands::reply;
use super::error::DragonflyError;
use super::queue::QueueItem;
use super::script::Script;
use dima_text::{js_key_order, number_to_string, parse_number, string_of, to_js_json, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `cron:jobs:queue`.
pub const CRON_JOBS_QUEUE_KEY: &str = "cron:jobs:queue";
/// `cron:jobs:dead-letter`.
pub const CRON_JOBS_DEAD_LETTER_KEY: &str = "cron:jobs:dead-letter";
/// `cron:jobs:dedupe` (dedupe markers are `cron:jobs:dedupe:{token}`).
pub const CRON_JOBS_DEDUPE_PREFIX: &str = "cron:jobs:dedupe";
/// `cron:stream-memory:queue`.
pub const STREAM_MEMORY_QUEUE_KEY: &str = "cron:stream-memory:queue";
/// `cron:clip-recommendations:queue`.
pub const CLIP_RECOMMENDATIONS_QUEUE_KEY: &str = "cron:clip-recommendations:queue";
/// `QUEUE_SCAN_LIMIT` of the durable publish (`LPOS ... MAXLEN 1000`).
pub const DURABLE_QUEUE_SCAN_LIMIT: u32 = 1000;
/// Maximum open JSON objects/arrays when parsing a job, including the outer object.
pub const CRON_QUEUE_JSON_MAX_DEPTH: usize = 127;

/// `ENQUEUE_DEDUPLICATED_JOB` (`cron_jobs_queue.ts`).
pub static ENQUEUE_DEDUPLICATED_JOB: Script = Script::new(
    "ENQUEUE_DEDUPLICATED_JOB",
    include_str!("lua/cron_enqueue_deduplicated_job.lua"),
);
/// `PUBLISH_DURABLE_CRON_JOB` (`durable_cron_jobs.ts`).
pub static PUBLISH_DURABLE_CRON_JOB: Script = Script::new(
    "PUBLISH_DURABLE_CRON_JOB",
    include_str!("lua/cron_publish_durable_job.lua"),
);

/// A cron queue job, shaped as the TypeScript `CronQueueJob` object (field order matters).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronQueueJob {
    /// UUID.
    pub id: String,
    /// Job name.
    pub job: String,
    /// `Date#toISOString()`.
    pub requested_at: String,
    /// Who asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// `userID`.
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// `accountID`.
    #[serde(rename = "accountID", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// `channelID`.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Free-form data: an object (or, from a parsed payload, an array).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// The dedupe marker key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
}

impl CronQueueJob {
    /// `serializeCronQueueJob(job)`: `JSON.stringify(job)` bytes. Keys inside `data` enumerate as
    /// a JavaScript object's would (array-index keys first).
    pub fn to_item(&self) -> Result<QueueItem, DragonflyError> {
        let mut value = serde_json::to_value(self)?;
        js_key_order(&mut value);
        Ok(QueueItem::encode_value(&value))
    }
}

/// `enqueueCronJob` input.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnqueueCronJobInput {
    /// Job name (trimmed).
    pub job: String,
    /// `requestedBy`.
    pub requested_by: Option<String>,
    /// `userID`.
    pub user_id: Option<String>,
    /// `accountID`.
    pub account_id: Option<String>,
    /// `channelID`.
    pub channel_id: Option<String>,
    /// `data`, stored as given.
    pub data: Option<Value>,
    /// `dedupeToken`; when absent the token is `job:channel:user:account` (empty parts skipped).
    pub dedupe_token: Option<String>,
    /// `dedupeSeconds`; 0 or NaN falls back to the configured default (`||`), then at least 60.
    pub dedupe_seconds: Option<f64>,
    /// `queueKey`, default [`CRON_JOBS_QUEUE_KEY`].
    pub queue_key: Option<String>,
}

/// `enqueueCronJob` result.
#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueCronJobResult {
    /// Whether the job was pushed.
    pub enqueued: bool,
    /// The reference's message text.
    pub message: &'static str,
    /// The job as built.
    pub job: CronQueueJob,
}

/// The module-level `DEFAULT_DEDUPE_SECONDS`, captured at startup from `CRON_JOBS_DEDUPE_SECONDS`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CronQueueConfig {
    /// Default dedupe seconds (already `Math.max(60, …)`; NaN when the variable is not a number).
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
    /// `Math.max(60, Number(process.env.CRON_JOBS_DEDUPE_SECONDS || 900))`.
    pub fn from_dedupe_seconds_env(value: Option<&str>) -> Self {
        let value = value.filter(|text| !text.is_empty()).unwrap_or("900");
        Self {
            default_dedupe_seconds: js_max_60(parse_number(value)),
        }
    }
}

/// What [`prepare_enqueue_cron_job`] decided.
#[derive(Debug, Clone, PartialEq)]
pub enum EnqueuePlan {
    /// Empty job name: nothing is sent (`enqueued: false`, "Invalid cron job name").
    Invalid(EnqueueCronJobResult),
    /// Run `ENQUEUE_DEDUPLICATED_JOB` with these keys (dedupe marker, queue, optional acceptance
    /// marker) and arguments (dedupe seconds, job bytes).
    Deduplicated {
        /// The job as it will be pushed.
        job: CronQueueJob,
        /// `KEYS`.
        keys: Vec<String>,
        /// `ARGV`.
        args: Vec<Vec<u8>>,
    },
    /// The reference routes this job through the durable Mongo intent first
    /// (`prepareDurableCronJob`), then publishes with [`publish_durable_cron_job`]. Not done here.
    Durable {
        /// The job, with `dedupeKey` set as the reference sets it before the durable step.
        job: CronQueueJob,
        /// The queue.
        queue_key: String,
        /// The dedupe seconds the durable step uses.
        dedupe_seconds: f64,
    },
}

fn optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `getCronJobDedupeKey(token)`.
pub fn get_cron_job_dedupe_key(token: &str) -> String {
    format!("{CRON_JOBS_DEDUPE_PREFIX}:{}", trim(token))
}

fn is_durable_route(queue_key: &str, job: &str) -> bool {
    (queue_key == STREAM_MEMORY_QUEUE_KEY
        && matches!(
            job,
            "stream-memory-summary" | "memory-maintenance-weekly" | "memory-maintenance-monthly"
        ))
        || (queue_key == CLIP_RECOMMENDATIONS_QUEUE_KEY && job == "clip-recommendation-analysis")
}

/// The pure part of `enqueueCronJob`: builds the job and decides what to send.
pub fn prepare_enqueue_cron_job(
    input: &EnqueueCronJobInput,
    config: CronQueueConfig,
    now_iso: &str,
    uuid: &str,
) -> Result<EnqueuePlan, DragonflyError> {
    let normalized_job = trim(&input.job);
    let mut job = CronQueueJob {
        id: uuid.to_owned(),
        job: normalized_job.to_owned(),
        requested_at: now_iso.to_owned(),
        requested_by: None,
        user_id: None,
        account_id: None,
        channel_id: None,
        data: None,
        dedupe_key: None,
    };
    if normalized_job.is_empty() {
        return Ok(EnqueuePlan::Invalid(EnqueueCronJobResult {
            enqueued: false,
            message: "Invalid cron job name",
            job,
        }));
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
        .filter(|seconds| *seconds != 0.0 && !seconds.is_nan())
        .unwrap_or(config.default_dedupe_seconds);
    let seconds = js_max_60(seconds);
    let queue_key =
        optional_text(input.queue_key.as_deref()).unwrap_or_else(|| CRON_JOBS_QUEUE_KEY.into());
    // For every valid job the default token contains its non-empty name, so the reference's
    // undeduplicated LPUSH branch is unreachable.
    let dedupe_key = get_cron_job_dedupe_key(&token);
    job.dedupe_key = Some(dedupe_key.clone());
    if is_durable_route(&queue_key, normalized_job) {
        return Ok(EnqueuePlan::Durable {
            job,
            queue_key,
            dedupe_seconds: seconds,
        });
    }
    let mut keys = vec![dedupe_key, queue_key];
    if let Some(data) = &input.data
        && data.get("source").and_then(Value::as_str) == Some("stream_offline")
        && let Some(session) = optional_text(data.get("sessionID").and_then(Value::as_str))
    {
        keys.push(format!(
            "cron:jobs:accepted:{normalized_job}:{}:{session}",
            job.channel_id.as_deref().unwrap_or("")
        ));
    }
    let args = vec![
        number_to_string(seconds).into_bytes(),
        job.to_item()?.into_bytes(),
    ];
    Ok(EnqueuePlan::Deduplicated { job, keys, args })
}

/// Errors of [`enqueue_cron_job`].
#[derive(Debug, thiserror::Error)]
pub enum CronQueueError {
    /// Dragonfly failed (including a script error reply after its markers were rolled back).
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
    /// The job belongs to the durable path, which needs the Mongo intent first.
    #[error("cron job {job} on {queue_key} must go through the durable intent path")]
    DurableRouteRequired {
        /// Job name.
        job: String,
        /// Queue.
        queue_key: String,
    },
}

/// `enqueueCronJob` for the non-durable routes: one atomic script call.
///
/// # Delivery is at least once
///
/// A lost reply (timeout, dropped connection: [`DragonflyError::outcome_unknown`]) leaves the
/// outcome unknown, and retrying is **not** guaranteed to be harmless. The dedupe marker only
/// answers 0 while it exists, and the consumer deletes it when it takes or finishes the job
/// ([`clear_cron_job_dedupe_by_key`], as `follow_ledger.worker.ts` does). If that happens between
/// the lost reply and the retry, the retry enqueues the job a second time
/// (`tests/dragonfly_protocols.rs`, `a_retry_after_the_consumer_took_the_job_enqueues_it_again`).
/// The acceptance marker of automatic session jobs is permanent, so those are the exception:
/// a retry of one of them is refused for good.
///
/// What a caller must do:
///
/// - Retry with the **same** `uuid`. The job id is then the same in both copies, and it is the
///   receipt key: a consumer whose effect must happen exactly once records the id it has applied
///   (in the same write as the effect, or behind a unique index) and skips a job whose id it has
///   already seen.
/// - A consumer whose effect is idempotent (a sync, a recount) may run the duplicate.
/// - Do not retry when a second run is harmful and the consumer keeps no receipt; report the
///   unknown outcome instead.
pub async fn enqueue_cron_job(
    dragonfly: &Dragonfly,
    input: &EnqueueCronJobInput,
    config: CronQueueConfig,
    now_iso: &str,
    uuid: &str,
) -> Result<EnqueueCronJobResult, CronQueueError> {
    match prepare_enqueue_cron_job(input, config, now_iso, uuid)? {
        EnqueuePlan::Invalid(result) => Ok(result),
        EnqueuePlan::Durable { job, queue_key, .. } => Err(CronQueueError::DurableRouteRequired {
            job: job.job,
            queue_key,
        }),
        EnqueuePlan::Deduplicated { job, keys, args } => {
            let value = ENQUEUE_DEDUPLICATED_JOB
                .run_value(dragonfly, &keys, &args)
                .await?;
            // `Number(dedupeResult) === 0`.
            if reply::number(value)? == 0.0 {
                return Ok(EnqueueCronJobResult {
                    enqueued: false,
                    message: "Cron job already queued recently",
                    job,
                });
            }
            Ok(EnqueueCronJobResult {
                enqueued: true,
                message: "Cron job queued",
                job,
            })
        }
    }
}

/// `clearCronJobDedupeByKey`: deletes the trimmed key, nothing when it is empty.
pub async fn clear_cron_job_dedupe_by_key(
    dragonfly: &Dragonfly,
    key: Option<&str>,
) -> Result<(), DragonflyError> {
    if let Some(key) = optional_text(key) {
        dragonfly.del(&[key.as_str()]).await?;
    }
    Ok(())
}

/// The Redis half of the durable publish (`publishIntent`): `LPUSH` the payload unless an
/// identical element is among the first 1000 (`LPOS ... MAXLEN`), then set the automatic
/// acceptance key when there is one. `payload` must be `JSON.stringify(intent.payload)` of the
/// Mongo lean document, byte for byte, or the `LPOS` check misses and a duplicate is pushed.
/// Returns `true` when pushed.
pub async fn publish_durable_cron_job(
    dragonfly: &Dragonfly,
    queue_key: &str,
    automatic_key: Option<&str>,
    payload: &QueueItem,
) -> Result<bool, DragonflyError> {
    let mut keys = vec![queue_key];
    keys.extend(automatic_key);
    let limit = DURABLE_QUEUE_SCAN_LIMIT.to_string();
    let args = [payload.as_bytes(), limit.as_bytes()];
    let value = PUBLISH_DURABLE_CRON_JOB
        .run_value(dragonfly, &keys, &args)
        .await?;
    Ok(reply::number(value)? == 1.0)
}

/// Exceeding the parse depth budget (the job is kept, not treated as malformed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("cron queue JSON exceeds the {maximum_depth}-container depth limit")]
pub struct CronQueueDepthError {
    /// The limit.
    pub maximum_depth: usize,
}

fn check_json_depth(payload: &str) -> Result<(), CronQueueDepthError> {
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
                        return Err(CronQueueDepthError {
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

fn normalized_value(value: Option<&Value>) -> Option<String> {
    optional_text(value.and_then(Value::as_str))
}

/// `parseCronQueueJob(payload)`: `Ok(None)` where the reference returns `null` (not JSON, no job
/// name). The payload is read as node-redis delivers it (UTF-8, invalid bytes replaced) and lone
/// surrogate escapes become U+FFFD, so whatever `JSON.parse` accepts parses here. `now_iso` and
/// `uuid` fill a missing `requestedAt` / `id`.
pub fn parse_cron_queue_job(
    item: &QueueItem,
    now_iso: &str,
    uuid: &str,
) -> Result<Option<CronQueueJob>, CronQueueDepthError> {
    let text = String::from_utf8_lossy(item.as_bytes());
    check_json_depth(&text)?;
    let Ok(parsed) =
        serde_json::from_slice::<Value>(&dima_text::sanitize_lone_surrogates(text.as_bytes()))
    else {
        return Ok(None);
    };
    let Value::Object(parsed) = parsed else {
        return Ok(None);
    };
    let Some(job) = normalized_value(parsed.get("job")) else {
        return Ok(None);
    };
    Ok(Some(CronQueueJob {
        id: normalized_value(parsed.get("id")).unwrap_or_else(|| uuid.to_owned()),
        job,
        requested_at: normalized_value(parsed.get("requestedAt"))
            .unwrap_or_else(|| now_iso.to_owned()),
        requested_by: normalized_value(parsed.get("requestedBy")),
        user_id: normalized_value(parsed.get("userID")),
        account_id: normalized_value(parsed.get("accountID")),
        channel_id: normalized_value(parsed.get("channelID")),
        data: parsed
            .get("data")
            .filter(|value| value.is_object() || value.is_array())
            .cloned(),
        dedupe_key: normalized_value(parsed.get("dedupeKey")),
    }))
}

/// `getJobAttempt` (stream memory) / `getClipJobAttempt` (clips):
/// `Number(job.data?.attempt || 1)`, then `floor` when finite and positive, else 1. A fraction
/// below 1 floors to 0, as in both originals.
pub fn get_job_attempt(job: &CronQueueJob) -> f64 {
    let attempt = job
        .data
        .as_ref()
        .and_then(|data| data.get("attempt"))
        .filter(|value| truthy(value))
        .map(js_number)
        .unwrap_or(1.0);
    if attempt.is_finite() && attempt > 0.0 {
        attempt.floor()
    } else {
        1.0
    }
}

/// `withNextAttempt`: `{...job, data: {...(job.data || {}), attempt: current + 1}}`. An array
/// `data` spreads into index keys; an existing `attempt` keeps its position.
pub fn with_next_attempt(job: &CronQueueJob) -> CronQueueJob {
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
    let attempt = get_job_attempt(job) + 1.0;
    data.insert(
        "attempt".into(),
        serde_json::Number::from_f64(attempt).map_or(Value::Null, Value::Number),
    );
    next.data = Some(Value::Object(data));
    next
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

/// `Number(value)` for a JSON value.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => parse_number(text),
        Value::Array(_) => parse_number(&string_of(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `Math.max(60, x)`: NaN stays NaN.
fn js_max_60(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(60.0)
    }
}

/// `JSON.stringify` text of a job, for logs and tests.
pub fn job_json(job: &CronQueueJob) -> Result<String, DragonflyError> {
    let mut value = serde_json::to_value(job)?;
    js_key_order(&mut value);
    Ok(to_js_json(&value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-11-11T12:00:00.000Z";

    fn input(job: &str) -> EnqueueCronJobInput {
        EnqueueCronJobInput {
            job: job.into(),
            ..EnqueueCronJobInput::default()
        }
    }

    fn deduplicated(plan: EnqueuePlan) -> (CronQueueJob, Vec<String>, Vec<Vec<u8>>) {
        match plan {
            EnqueuePlan::Deduplicated { job, keys, args } => (job, keys, args),
            other => panic!("expected the deduplicated route, got {other:?}"),
        }
    }

    #[test]
    fn serialisation_is_json_stringify() {
        let job = CronQueueJob {
            id: "id".into(),
            job: "follow-ledger-sync".into(),
            requested_at: NOW.into(),
            requested_by: None,
            user_id: None,
            account_id: Some("1".into()),
            channel_id: Some("1".into()),
            data: Some(
                json!({"reason": "manual_request", "n": 1.0, "big": 1e21, "2": "index", "attempt": 3}),
            ),
            dedupe_key: Some("cron:jobs:dedupe:x".into()),
        };
        assert_eq!(
            job_json(&job).unwrap(),
            r#"{"id":"id","job":"follow-ledger-sync","requestedAt":"2026-11-11T12:00:00.000Z","accountID":"1","channelID":"1","data":{"2":"index","reason":"manual_request","n":1,"big":1e+21,"attempt":3},"dedupeKey":"cron:jobs:dedupe:x"}"#
        );
        assert_eq!(
            job.to_item().unwrap().as_str().unwrap(),
            job_json(&job).unwrap()
        );
    }

    #[test]
    fn invalid_names_are_not_sent() {
        let plan =
            prepare_enqueue_cron_job(&input(" \u{feff}\n"), CronQueueConfig::default(), NOW, "u")
                .unwrap();
        let EnqueuePlan::Invalid(result) = plan else {
            panic!("expected invalid")
        };
        assert!(!result.enqueued);
        assert_eq!(result.message, "Invalid cron job name");
        assert_eq!(
            job_json(&result.job).unwrap(),
            r#"{"id":"u","job":"","requestedAt":"2026-11-11T12:00:00.000Z"}"#
        );
    }

    #[test]
    fn default_token_dedupe_seconds_and_keys() {
        let mut request = input("  summary ");
        request.channel_id = Some(" 42 ".into());
        request.user_id = Some("".into());
        request.account_id = Some("7".into());
        request.dedupe_seconds = Some(30.0);
        let (job, keys, args) = deduplicated(
            prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap(),
        );
        assert_eq!(keys, ["cron:jobs:dedupe:summary:42:7", "cron:jobs:queue"]);
        assert_eq!(args[0], b"60");
        assert_eq!(
            job.dedupe_key.as_deref(),
            Some("cron:jobs:dedupe:summary:42:7")
        );
        assert_eq!(job.user_id, None);
        // 0 and NaN are falsy: the configured default applies.
        for falsy in [0.0, f64::NAN] {
            request.dedupe_seconds = Some(falsy);
            let (_, _, args) = deduplicated(
                prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap(),
            );
            assert_eq!(args[0], b"900");
        }
        request.dedupe_seconds = Some(1e21);
        let (_, _, args) = deduplicated(
            prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap(),
        );
        assert_eq!(args[0], b"1e+21");
    }

    #[test]
    fn configured_default_follows_number_semantics() {
        assert_eq!(
            CronQueueConfig::from_dedupe_seconds_env(None).default_dedupe_seconds,
            900.0
        );
        assert_eq!(
            CronQueueConfig::from_dedupe_seconds_env(Some("")).default_dedupe_seconds,
            900.0
        );
        assert_eq!(
            CronQueueConfig::from_dedupe_seconds_env(Some("0")).default_dedupe_seconds,
            60.0
        );
        assert_eq!(
            CronQueueConfig::from_dedupe_seconds_env(Some(" 0x10 ")).default_dedupe_seconds,
            60.0
        );
        assert_eq!(
            CronQueueConfig::from_dedupe_seconds_env(Some("1200")).default_dedupe_seconds,
            1200.0
        );
        assert!(
            CronQueueConfig::from_dedupe_seconds_env(Some("abc"))
                .default_dedupe_seconds
                .is_nan()
        );
    }

    #[test]
    fn automatic_session_jobs_carry_an_acceptance_key() {
        let mut request = input("summary");
        request.dedupe_token = Some("session:automatic-summary".into());
        request.data = Some(json!({"source": "stream_offline", "sessionID": " session "}));
        let (_, keys, _) = deduplicated(
            prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap(),
        );
        assert_eq!(
            keys,
            [
                "cron:jobs:dedupe:session:automatic-summary",
                "cron:jobs:queue",
                "cron:jobs:accepted:summary::session"
            ]
        );
        request.data = Some(json!({"source": "manual", "sessionID": "session"}));
        let (_, keys, _) = deduplicated(
            prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap(),
        );
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn durable_routes_are_not_pushed_directly() {
        for (queue, job) in [
            (STREAM_MEMORY_QUEUE_KEY, "stream-memory-summary"),
            (STREAM_MEMORY_QUEUE_KEY, "memory-maintenance-weekly"),
            (STREAM_MEMORY_QUEUE_KEY, "memory-maintenance-monthly"),
            (
                CLIP_RECOMMENDATIONS_QUEUE_KEY,
                "clip-recommendation-analysis",
            ),
        ] {
            let mut request = input(job);
            request.queue_key = Some(queue.into());
            request.channel_id = Some("9".into());
            let plan =
                prepare_enqueue_cron_job(&request, CronQueueConfig::default(), NOW, "u").unwrap();
            let EnqueuePlan::Durable { job, queue_key, .. } = plan else {
                panic!("expected durable")
            };
            assert_eq!(queue_key, queue);
            assert!(job.dedupe_key.is_some());
        }
        let mut other = input("stream-memory-summary");
        other.queue_key = Some(CLIP_RECOMMENDATIONS_QUEUE_KEY.into());
        assert!(matches!(
            prepare_enqueue_cron_job(&other, CronQueueConfig::default(), NOW, "u").unwrap(),
            EnqueuePlan::Deduplicated { .. }
        ));
    }

    #[test]
    fn parsing_matches_parse_cron_queue_job() {
        let parse =
            |raw: &[u8]| parse_cron_queue_job(&QueueItem::from_popped(raw.to_vec()), NOW, "fresh");
        assert_eq!(parse(b"not json").unwrap(), None);
        assert_eq!(parse(b"null").unwrap(), None);
        assert_eq!(parse(b"[1]").unwrap(), None);
        assert_eq!(parse(br#"{"job":"  "}"#).unwrap(), None);
        let job =
            parse(br#"{"job":" x ","id":" ","data":[1],"channelID":7,"dedupeKey":"k","extra":1}"#)
                .unwrap()
                .unwrap();
        assert_eq!(job.job, "x");
        assert_eq!(job.id, "fresh");
        assert_eq!(job.requested_at, NOW);
        assert_eq!(job.channel_id, None);
        assert_eq!(job.data, Some(json!([1])));
        assert_eq!(job.dedupe_key.as_deref(), Some("k"));
        // JSON.parse accepts a lone surrogate escape; so does this parser (as U+FFFD).
        let job = parse(br#"{"job":"j","data":{"t":"\ud83d"}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(job.data, Some(json!({"t": "\u{fffd}"})));
        // Invalid UTF-8 is read as node-redis decodes it.
        let job = parse(b"{\"job\":\"j\xff\"}").unwrap().unwrap();
        assert_eq!(job.job, "j\u{fffd}");
        let deep = format!(
            "{{\"job\":\"j\",\"data\":{}{}}}",
            "[".repeat(200),
            "]".repeat(200)
        );
        assert!(parse(deep.as_bytes()).is_err());
    }

    #[test]
    fn attempts_follow_both_workers() {
        let with = |data: Option<Value>| CronQueueJob {
            id: "i".into(),
            job: "j".into(),
            requested_at: NOW.into(),
            requested_by: None,
            user_id: None,
            account_id: None,
            channel_id: None,
            data,
            dedupe_key: None,
        };
        assert_eq!(get_job_attempt(&with(None)), 1.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": "3"})))), 3.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": 2.7})))), 2.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": 0.5})))), 0.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": -1})))), 1.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": "x"})))), 1.0);
        assert_eq!(get_job_attempt(&with(Some(json!({"attempt": [4]})))), 4.0);
        let next = with_next_attempt(&with(Some(json!({"attempt": 2, "reason": "r"}))));
        assert_eq!(
            job_json(&next).unwrap(),
            r#"{"id":"i","job":"j","requestedAt":"2026-11-11T12:00:00.000Z","data":{"attempt":3,"reason":"r"}}"#
        );
        let next = with_next_attempt(&with(Some(json!(["a"]))));
        assert!(
            job_json(&next)
                .unwrap()
                .ends_with(r#""data":{"0":"a","attempt":2}}"#)
        );
        let next = with_next_attempt(&with(None));
        assert!(
            job_json(&next)
                .unwrap()
                .ends_with(r#""data":{"attempt":2}}"#)
        );
    }
}
