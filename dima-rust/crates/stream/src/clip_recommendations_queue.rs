//! Clip-analysis producer (`clip_recommendations_queue.ts`). Uses the existing durable intents;
//! queue/processing/dead-letter lists have no TTL. Automatic acceptance strings have no TTL;
//! dedupe windows live in MongoDB (6 h by default), not Redis TTL markers on this path.
//! The exported dedupe helper deliberately omits the enqueue function's stream/URL fallback.
//! Callers supply a configured durable service, clock, randomness and startup-parsed windows.
//! No scheduler or worker is started here. Queue payload bytes remain the shared cron protocol.
use dima_core::{Clock, Random};
use dima_events::jobs::{DurableJobs, JobError, JobQueue};
use dima_store::dragonfly::cron_queue::{self, CronQueueConfig, CronQueueJob, EnqueueCronJobInput};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const CLIP_RECOMMENDATIONS_QUEUE_KEY: &str = "cron:clip-recommendations:queue";
pub const CLIP_RECOMMENDATIONS_PROCESSING_KEY: &str = "cron:clip-recommendations:processing";
pub const CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY: &str = "cron:clip-recommendations:dead-letter";
pub const CLIP_RECOMMENDATION_ANALYSIS_JOB: &str = "clip-recommendation-analysis";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueJobResult {
    pub enqueued: bool,
    pub message: String,
    pub dedupe_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<CronQueueJob>,
}
impl EnqueueJobResult {
    pub(crate) fn invalid(message: &str) -> Self {
        Self {
            enqueued: false,
            message: message.into(),
            dedupe_key: String::new(),
            job: None,
        }
    }
}

/// Startup-parsed defaults; the generic cron default is independently configured.
#[derive(Debug, Clone, Copy)]
pub struct QueueConfig {
    pub clip_dedupe_seconds: f64,
    pub summary_dedupe_seconds: f64,
    pub weekly_dedupe_seconds: f64,
    pub monthly_dedupe_seconds: f64,
    pub cron: CronQueueConfig,
}
impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            clip_dedupe_seconds: 21600.0,
            summary_dedupe_seconds: 43200.0,
            weekly_dedupe_seconds: 604800.0,
            monthly_dedupe_seconds: 2678400.0,
            cron: CronQueueConfig::default(),
        }
    }
}
impl QueueConfig {
    /// Parses startup values in clip/summary/weekly/monthly order without reading the environment.
    /// Names: `CLIP_RECOMMENDATIONS_DEDUPE_SECONDS`, `STREAM_MEMORY_{SUMMARY,WEEKLY,MONTHLY}_DEDUPE_SECONDS`.
    pub fn from_values(values: [Option<&str>; 4], cron: CronQueueConfig) -> Self {
        let parse = |value: Option<&str>, fallback: f64| {
            let number = value
                .filter(|v| !v.is_empty())
                .map(dima_text::parse_number)
                .unwrap_or(fallback);
            if number.is_nan() {
                number
            } else {
                number.max(60.0)
            }
        };
        Self {
            clip_dedupe_seconds: parse(values[0], 21600.0),
            summary_dedupe_seconds: parse(values[1], 43200.0),
            weekly_dedupe_seconds: parse(values[2], 604800.0),
            monthly_dedupe_seconds: parse(values[3], 2678400.0),
            cron,
        }
    }
}
/// Borrows the existing durable service; its own store deadline bounds every IO operation.
pub struct QueueProducer<'a, Q> {
    pub jobs: &'a DurableJobs<Q>,
    pub clock: &'a dyn Clock,
    pub random: &'a dyn Random,
    pub config: QueueConfig,
}
impl<Q: JobQueue> QueueProducer<'_, Q> {
    pub(crate) async fn enqueue(
        &self,
        input: EnqueueCronJobInput,
    ) -> Result<EnqueueJobResult, JobError> {
        let at = dima_text::to_iso_string(self.clock.now_ms())
            .ok_or_else(|| JobError::Invalid("Invalid clock".into()))?;
        let id = self
            .random
            .uuid_v4()
            .map_err(|e| JobError::Invalid(e.to_string()))?;
        let plan = cron_queue::prepare_enqueue_cron_job(&input, self.config.cron, &at, &id)
            .map_err(|e| JobError::Invalid(e.to_string()))?;
        let (enqueued, message, job) = self.jobs.enqueue(plan).await?;
        Ok(EnqueueJobResult {
            enqueued,
            message: message.into(),
            dedupe_key: job.dedupe_key.clone().unwrap_or_default(),
            job: Some(job),
        })
    }
}
pub(crate) fn normalized(value: &Option<String>) -> &str {
    dima_text::trim(value.as_deref().unwrap_or_default())
}
pub(crate) fn token(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|s| dima_text::trim(s))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(":")
}
pub fn get_clip_recommendation_dedupe_key(
    channel: &str,
    session: Option<&str>,
    vod: Option<&str>,
) -> String {
    cron_queue::get_cron_job_dedupe_key(&token(&[
        CLIP_RECOMMENDATION_ANALYSIS_JOB,
        channel,
        session.unwrap_or_default(),
        vod.unwrap_or_default(),
    ]))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClipRecommendationInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub channel: Option<String>,
    #[serde(rename = "sessionID")]
    pub session_id: Option<String>,
    #[serde(rename = "streamID")]
    pub stream_id: Option<String>,
    #[serde(rename = "vodID")]
    pub vod_id: Option<String>,
    pub vod_url: String,
    pub source: String,
    pub requested_by: Option<String>,
    pub vod_duration_minutes: f64,
    pub not_before_unix: f64,
}

pub async fn enqueue_clip_recommendation_job<Q: JobQueue>(
    producer: &QueueProducer<'_, Q>,
    input: &ClipRecommendationInput,
) -> Result<EnqueueJobResult, JobError> {
    let channel = dima_text::trim(&input.channel_id);
    let url = dima_text::trim(&input.vod_url);
    if channel.is_empty() {
        return Ok(EnqueueJobResult::invalid("Invalid channel ID"));
    }
    if url.is_empty() {
        return Ok(EnqueueJobResult::invalid("Missing VOD URL"));
    }
    let session = normalized(&input.session_id);
    let stream = normalized(&input.stream_id);
    let vod = normalized(&input.vod_id);
    producer.enqueue(EnqueueCronJobInput {
        job: CLIP_RECOMMENDATION_ANALYSIS_JOB.into(), queue_key: Some(CLIP_RECOMMENDATIONS_QUEUE_KEY.into()),
        requested_by: input.requested_by.clone(), channel_id: Some(channel.into()), account_id: Some(channel.into()),
        dedupe_token: Some(token(&[CLIP_RECOMMENDATION_ANALYSIS_JOB, channel, session,
            if !vod.is_empty() { vod } else if !stream.is_empty() { stream } else { url }])),
        dedupe_seconds: Some(producer.config.clip_dedupe_seconds),
        data: Some(json!({"channel": normalized(&input.channel), "sessionID": session, "streamID": stream,
            "vodID": vod, "vodUrl": url, "source": input.source,
            "vodDurationMinutes": input.vod_duration_minutes, "notBeforeUnix": input.not_before_unix})),
        ..Default::default()
    }).await
}
