//! Stream-memory summary and maintenance producers (`stream_memory_queue.ts`).
//! Reuses durable jobs and the shared cron wire format. Queue, processing, dead-letter and
//! automatic acceptance keys have no TTL; dedupe deadlines in Mongo default to 12 h / 7 d / 31 d.
//! UTC ISO weeks use the Thursday's year. Clock is injected; no interval or environment reads.
use crate::clip_recommendations_queue::{EnqueueJobResult, QueueProducer, normalized, token};
use dima_events::jobs::{JobError, JobQueue};
use dima_store::dragonfly::cron_queue::{EnqueueCronJobInput, get_cron_job_dedupe_key};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const STREAM_MEMORY_QUEUE_KEY: &str = "cron:stream-memory:queue";
pub const STREAM_MEMORY_PROCESSING_KEY: &str = "cron:stream-memory:processing";
pub const STREAM_MEMORY_DEAD_LETTER_KEY: &str = "cron:stream-memory:dead-letter";
pub const STREAM_MEMORY_SUMMARY_JOB: &str = "stream-memory-summary";
pub const STREAM_MEMORY_WEEKLY_JOB: &str = "memory-maintenance-weekly";
pub const STREAM_MEMORY_MONTHLY_JOB: &str = "memory-maintenance-monthly";

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    Weekly,
    Monthly,
}
impl Cadence {
    fn as_str(self) -> &'static str {
        match self {
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }
}
pub fn get_stream_memory_summary_dedupe_key(
    channel: &str,
    session: Option<&str>,
    stream: Option<&str>,
) -> String {
    get_cron_job_dedupe_key(&token(&[
        STREAM_MEMORY_SUMMARY_JOB,
        channel,
        session.unwrap_or_default(),
        stream.unwrap_or_default(),
    ]))
}
pub fn get_maintenance_dedupe_key(channel: &str, cadence: Cadence, period: &str) -> String {
    get_cron_job_dedupe_key(&format!(
        "stream-memory-{}:{}:{}",
        cadence.as_str(),
        dima_text::trim(channel),
        dima_text::trim(period)
    ))
}
pub fn get_weekly_maintenance_period_token(now_ms: i64) -> Result<String, JobError> {
    let fields =
        dima_text::utc_fields(now_ms).ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    // Date.UTC remaps years 0..99 to 1900..1999 in the reference.
    let midnight = dima_text::date_utc(
        fields.year,
        i64::from(fields.month),
        i64::from(fields.day),
        0,
        0,
        0,
        0,
    )
    .ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    let fields =
        dima_text::utc_fields(midnight).ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    let day = if fields.weekday == 0 {
        7
    } else {
        fields.weekday
    };
    let thursday = midnight + (4 - i64::from(day)) * 86_400_000;
    let fields =
        dima_text::utc_fields(thursday).ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    let start = dima_text::date_utc(fields.year, 0, 1, 0, 0, 0, 0)
        .ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    let week = ((thursday - start) / 86_400_000 + 1 + 6) / 7;
    Ok(format!("{}-W{week:02}", fields.year))
}
pub fn get_monthly_maintenance_period_token(now_ms: i64) -> Result<String, JobError> {
    let f =
        dima_text::utc_fields(now_ms).ok_or_else(|| JobError::Invalid("Invalid date".into()))?;
    Ok(format!("{}-{:02}", f.year, f.month + 1))
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StreamMemorySummaryInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "sessionID")]
    pub session_id: Option<String>,
    #[serde(rename = "streamID")]
    pub stream_id: Option<String>,
    pub reason: Option<String>,
    pub source: Option<String>,
    pub not_before_unix: f64,
    pub requested_by: Option<String>,
}
pub async fn enqueue_stream_memory_summary_job<Q: JobQueue>(
    producer: &QueueProducer<'_, Q>,
    input: &StreamMemorySummaryInput,
) -> Result<EnqueueJobResult, JobError> {
    let channel = dima_text::trim(&input.channel_id);
    if channel.is_empty() {
        return Ok(EnqueueJobResult::invalid("Invalid channel ID"));
    }
    let reason = normalized(&input.reason);
    producer
        .enqueue(EnqueueCronJobInput {
            job: STREAM_MEMORY_SUMMARY_JOB.into(),
            queue_key: Some(STREAM_MEMORY_QUEUE_KEY.into()),
            requested_by: input.requested_by.clone(),
            channel_id: Some(channel.into()),
            account_id: Some(channel.into()),
            dedupe_token: Some(token(&[
                STREAM_MEMORY_SUMMARY_JOB,
                channel,
                normalized(&input.session_id),
                normalized(&input.stream_id),
            ])),
            dedupe_seconds: Some(producer.config.summary_dedupe_seconds),
            data: Some(
                json!({"reason": if reason.is_empty() {"stream_offline"} else {reason},
            "source": input.source.as_deref().filter(|s| !s.is_empty()).unwrap_or("stream_offline"),
            "sessionID": normalized(&input.session_id), "streamID": normalized(&input.stream_id),
            "notBeforeUnix": input.not_before_unix}),
            ),
            ..Default::default()
        })
        .await
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaintenanceInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub cadence: Cadence,
    pub period_token: Option<String>,
    pub reason: Option<String>,
    pub requested_by: Option<String>,
}
pub async fn enqueue_memory_maintenance_job<Q: JobQueue>(
    producer: &QueueProducer<'_, Q>,
    input: &MemoryMaintenanceInput,
) -> Result<EnqueueJobResult, JobError> {
    let channel = dima_text::trim(&input.channel_id);
    if channel.is_empty() {
        return Ok(EnqueueJobResult::invalid("Invalid channel ID"));
    }
    let cadence = input.cadence.as_str();
    let period = normalized(&input.period_token);
    let period = if period.is_empty() {
        match input.cadence {
            Cadence::Weekly => get_weekly_maintenance_period_token(producer.clock.now_ms())?,
            Cadence::Monthly => get_monthly_maintenance_period_token(producer.clock.now_ms())?,
        }
    } else {
        period.into()
    };
    let reason = normalized(&input.reason);
    producer
        .enqueue(EnqueueCronJobInput {
            job: match input.cadence {
                Cadence::Weekly => STREAM_MEMORY_WEEKLY_JOB,
                Cadence::Monthly => STREAM_MEMORY_MONTHLY_JOB,
            }
            .into(),
            queue_key: Some(STREAM_MEMORY_QUEUE_KEY.into()),
            requested_by: input.requested_by.clone(),
            channel_id: Some(channel.into()),
            account_id: Some(channel.into()),
            dedupe_token: Some(format!("stream-memory-{cadence}:{channel}:{period}")),
            dedupe_seconds: Some(match input.cadence {
                Cadence::Weekly => producer.config.weekly_dedupe_seconds,
                Cadence::Monthly => producer.config.monthly_dedupe_seconds,
            }),
            data: Some(json!({"cadence": cadence, "periodToken": period,
            "reason": if reason.is_empty() {format!("{cadence}_maintenance")} else {reason.into()},
            "source": format!("{cadence}_maintenance")})),
            ..Default::default()
        })
        .await
}
