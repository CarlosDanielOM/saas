//! Port of `src/utils/follow_ledger_queue.ts`.
//!
//! The module owns the follow-ledger cron job identity and its dedupe wrapper
//! around the native cron queue (`utils::cron_queue`). It is a pure transport
//! adapter: no connection is opened here, no task is spawned and no environment
//! value is read at import time. The dedupe window is resolved from
//! `FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS` on every call.
//!
//! Parity notes:
//! - `FOLLOW_LEDGER_JOB_NAME` and `FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX` are both
//!   `follow-ledger-sync`.
//! - The dedupe window is `max(60, Number(env || 900))`. A malformed value is
//!   `NaN` in the source and is then falsy inside `enqueueCronJob`, so the cron
//!   queue's own default applies. That is reproduced by omitting
//!   `dedupeSeconds` rather than by inventing a number.
//! - `channelID`, `accountID`, `data.reason`, `data.type`, `dedupeToken` and the
//!   `manual_request` fallback reason keep their exact source values. `reason`
//!   and `channelID` are trimmed; `requestedBy` is passed through and trimmed by
//!   the cron queue, exactly as the source does.
//! - An empty/blank channel returns the source's `Invalid channel ID` result
//!   without touching Redis.
use std::fmt;

use mongodb::bson::DateTime;
use serde_json::{Value, json};

use super::cron_queue::{
    CronQueueClock, CronQueueError, CronQueueJob, CronQueueUuidSource, EnqueueCronJobInput,
    RandomUuidSource, RedisCronQueue, get_cron_job_dedupe_key,
};
use super::js_compat::trim;
use super::json_number::to_number;

pub const FOLLOW_LEDGER_JOB_NAME: &str = "follow-ledger-sync";
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX: &str = "follow-ledger-sync";
/// Environment key resolved at call time, never at import time.
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_ENV: &str = "FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS";
/// Source fallback when the environment key is absent or empty.
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_DEFAULT_SECONDS: f64 = 900.0;
/// Source `Math.max(60, ...)` floor.
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_MIN_SECONDS: f64 = 60.0;
/// Source default reason when no usable reason is supplied.
pub const FOLLOW_LEDGER_DEFAULT_REASON: &str = "manual_request";
/// Exact source message for a blank channel.
pub const INVALID_CHANNEL_MESSAGE: &str = "Invalid channel ID";

const DAY_MS: i64 = 86_400_000;

/// Source `EnqueueFollowLedgerSyncJobResult`. `job` is absent only for a
/// rejected channel; the source's inline job type is the native
/// [`CronQueueJob`] shape, which additionally carries `userID` when set.
#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueFollowLedgerSyncJobResult {
    pub enqueued: bool,
    pub message: String,
    pub dedupe_key: String,
    pub job: Option<CronQueueJob>,
}

/// Source `normalizeValue`: non-strings are `''`, otherwise the JavaScript
/// `trim()` result (not Rust `str::trim`).
pub fn normalize_value(value: Option<&str>) -> &str {
    value.map(trim).unwrap_or("")
}

/// Source `getCronJobDedupeKey(`${FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX}:${channelID}`)`.
pub fn get_follow_ledger_dedupe_key(channel_id: &str) -> String {
    get_cron_job_dedupe_key(&format!(
        "{FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX}:{}",
        normalize_value(Some(channel_id))
    ))
}

/// Pure form of `Math.max(60, Number(env || 900))`.
///
/// `""`, `None` and non-UTF-8 inputs are absent and select 900. Any other text
/// goes through JavaScript `Number()`; `NaN` survives as `NaN` exactly like
/// `Math.max(60, NaN)`, and the enqueue path then lets the cron queue apply its
/// own default because the source treats `NaN` as falsy.
pub fn follow_ledger_queue_dedupe_seconds_from(value: Option<&str>) -> f64 {
    let raw = value.filter(|text| !text.is_empty()).unwrap_or("900");
    let seconds = to_number(&Value::String(raw.to_owned()));
    if seconds.is_nan() {
        f64::NAN
    } else {
        seconds.max(FOLLOW_LEDGER_QUEUE_DEDUPE_MIN_SECONDS)
    }
}

/// Reads `FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS` at call time. Non-UTF-8 is
/// treated as unset; the raw value is never logged or returned.
pub fn follow_ledger_queue_dedupe_seconds() -> f64 {
    let raw = std::env::var(FOLLOW_LEDGER_QUEUE_DEDUPE_ENV).ok();
    follow_ledger_queue_dedupe_seconds_from(raw.as_deref())
}

/// `dedupeSeconds` input for the cron queue.
///
/// `NaN` is omitted so the queue's `Number(x || DEFAULT)` fallback applies.
/// `±Infinity` has no JSON number representation, so it is passed as the string
/// the source would stringify into the Redis `EX` argument.
fn dedupe_seconds_input(seconds: f64) -> Option<Value> {
    if seconds.is_nan() {
        return None;
    }
    match serde_json::Number::from_f64(seconds) {
        Some(value) => Some(Value::Number(value)),
        None if seconds.is_infinite() && seconds.is_sign_positive() => {
            Some(Value::String("Infinity".into()))
        }
        None => Some(Value::String("-Infinity".into())),
    }
}

/// Enqueues one deduplicated `follow-ledger-sync` job.
///
/// Redis errors surface as [`FollowLedgerQueueError`]; nothing is retried or
/// swallowed, so an ambiguous enqueue stays visible to the caller (the cron
/// queue's Lua script already makes a replay safe).
pub async fn enqueue_follow_ledger_sync_job(
    queue: &mut RedisCronQueue,
    clock: &mut impl CronQueueClock,
    uuids: &mut impl CronQueueUuidSource,
    channel_id: &str,
    reason: Option<&str>,
    requested_by: Option<&str>,
) -> Result<EnqueueFollowLedgerSyncJobResult, FollowLedgerQueueError> {
    let normalized_channel_id = normalize_value(Some(channel_id));
    let normalized_reason = match normalize_value(reason) {
        "" => FOLLOW_LEDGER_DEFAULT_REASON,
        value => value,
    };

    if normalized_channel_id.is_empty() {
        return Ok(EnqueueFollowLedgerSyncJobResult {
            enqueued: false,
            message: INVALID_CHANNEL_MESSAGE.into(),
            dedupe_key: String::new(),
            job: None,
        });
    }

    let dedupe_key = get_follow_ledger_dedupe_key(normalized_channel_id);
    let input = EnqueueCronJobInput {
        job: FOLLOW_LEDGER_JOB_NAME.to_owned(),
        requested_by: requested_by.map(str::to_owned),
        user_id: None,
        account_id: Some(normalized_channel_id.to_owned()),
        channel_id: Some(normalized_channel_id.to_owned()),
        data: Some(json!({
            "reason": normalized_reason,
            "type": FOLLOW_LEDGER_JOB_NAME,
        })),
        dedupe_token: Some(format!(
            "{FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX}:{normalized_channel_id}"
        )),
        dedupe_seconds: dedupe_seconds_input(follow_ledger_queue_dedupe_seconds()),
        queue_key: None,
    };

    let result = queue.enqueue_cron_job(&input, clock, uuids).await?;
    Ok(EnqueueFollowLedgerSyncJobResult {
        enqueued: result.enqueued,
        message: result.message,
        // Source `enqueueResult.job.dedupeKey || dedupeKey`.
        dedupe_key: result.job.dedupe_key.clone().unwrap_or(dedupe_key),
        job: Some(result.job),
    })
}

/// Worker-facing entry point with the default clock and UUID source.
pub async fn enqueue_follow_ledger_sync_job_with_defaults(
    queue: &mut RedisCronQueue,
    channel_id: &str,
    reason: Option<&str>,
    requested_by: Option<&str>,
) -> Result<EnqueueFollowLedgerSyncJobResult, FollowLedgerQueueError> {
    let mut clock = SystemQueueClock::default();
    let mut uuids = RandomUuidSource;
    enqueue_follow_ledger_sync_job(
        queue,
        &mut clock,
        &mut uuids,
        channel_id,
        reason,
        requested_by,
    )
    .await
}

/// `Date.toISOString()` for a millisecond epoch value.
///
/// Mirrors the proleptic Gregorian conversion used elsewhere in the crate: three
/// fraction digits always, and signed six-digit years outside `0000..=9999`.
pub fn javascript_iso_millis(millis: i64) -> String {
    let z = millis.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    let time = millis.rem_euclid(DAY_MS);
    let hour = time / 3_600_000;
    let minute = time / 60_000 % 60;
    let second = time / 1000 % 60;
    let fraction = time % 1000;
    format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z")
}

/// System clock for the cron queue contract: UTC ISO-8601 with milliseconds.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemQueueClock;

impl CronQueueClock for SystemQueueClock {
    fn now_iso(&mut self) -> String {
        javascript_iso_millis(DateTime::now().timestamp_millis())
    }
}

/// Typed enqueue failure. A blank channel is *not* an error: the source returns
/// a `{enqueued:false, message:"Invalid channel ID"}` result for it, and this
/// port keeps that contract. Neither variant includes configuration text,
/// credentials or environment values.
#[derive(Debug)]
pub enum FollowLedgerQueueError {
    /// The queue payload could not be serialized.
    Json(serde_json::Error),
    /// Redis refused or lost the enqueue command.
    Redis(redis::RedisError),
}

impl fmt::Display for FollowLedgerQueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => std::fmt::Display::fmt(error, formatter),
            Self::Redis(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for FollowLedgerQueueError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Redis(error) => Some(error),
        }
    }
}

impl From<CronQueueError> for FollowLedgerQueueError {
    fn from(error: CronQueueError) -> Self {
        match error {
            CronQueueError::Json(error) => Self::Json(error),
            CronQueueError::Redis(error) => Self::Redis(error),
        }
    }
}
