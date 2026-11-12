//! TTS character accounting from `utils/tts_usage.ts`, including its partial cache writes.
//!
//! Money uses the caller's character count, never a recount of text. Queue and preview callers
//! use UTF-16 units for Fish, Unicode scalars for Piper/Kokoro (`tts_queue.handler.ts:563`,
//! `voice_preview.service.ts:34,130`). Desktop and pet callers use UTF-16 for ALL providers
//! (`desktop_ai/execution.ts:177`, `pets/runtime.ts:249`). Callers must preserve that distinction
//! with dima_text::utf16_len or chars().count(). Voice aliases/custom Fish ids, local Piper
//! voices, and Kokoro presets have no separate rate: this service takes only the provider.
//!
//! Cache is rebuilt/internal. Its six sequential commands and first-error stop are retained;
//! fractional counts fail HINCRBY but still reach billing. UTC expiry reproduces production's
//! TZ=UTC and the reference's 30-day arithmetic (not the next calendar month): on day 30/31,
//! EXPIRE may delete provider fields and the final HINCRBYs recreate an unexpired totals hash.
//! These quirks are recorded, not corrected. Cache failures and non-durable ingest failures
//! return telemetry without failing the caller; require_durable_usage keeps the reference error.
//!
//! Ingest uses dima-billing's Ingest::ingest_usage in Batch mode through a small injectable
//! boundary. A deadline after admission is an unknown outcome; retry the SAME external id.
//! Retries require a caller-supplied entry_id; omitted ids keep billing's auto-ID behavior.
//! No environment, text spool, task or implicit retry. Clock/deadlines are supplied by caller.
//! Local adapter: dima-store has no typed HINCRBY/EXPIRE helpers, so use its query API here.
use dima_billing::{
    polar::{Ingest, IngestMode, IngestOutcome, UsageEventInput},
    usage::{AiUsageContextInput, ResourceType, Unit},
};
use dima_core::Clock;
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use futures_util::future::BoxFuture;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Piper,
    Fish,
    Kokoro,
}
impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Piper => "piper",
            Self::Fish => "fish",
            Self::Kokoro => "kokoro",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub characters: f64,
    pub credits_consumed: f64,
    pub polarsh_cost: f64,
    pub cost_usd: f64,
}
pub fn calculate_tts_usage(provider: &str, characters: f64) -> UsageResult {
    let credits_consumed = match provider {
        "fish" => (characters * 1.5).ceil(),
        "piper" => (characters / 50.0).ceil(),
        "kokoro" => (characters / 15.0).ceil(),
        _ => (characters / 100.0).ceil(),
    };
    UsageResult {
        characters,
        credits_consumed,
        polarsh_cost: dima_text::math_round((credits_consumed / 1000.0) * 100000.0) / 100000.0,
        cost_usd: dima_text::math_round((credits_consumed * 0.00001) * 100000.0) / 100000.0,
    }
}
/// The production implementation calls dima-billing; tests observe the exact admitted input.
pub trait UsageIngest: Send + Sync {
    fn ingest<'a>(
        &'a self,
        input: &'a UsageEventInput,
        mode: IngestMode,
    ) -> BoxFuture<'a, IngestOutcome>;
}
impl UsageIngest for Ingest<'_> {
    fn ingest<'a>(
        &'a self,
        input: &'a UsageEventInput,
        mode: IngestMode,
    ) -> BoxFuture<'a, IngestOutcome> {
        Box::pin(self.ingest_usage(input, mode))
    }
}
#[derive(Clone, Debug, Default)]
pub struct UsageContext {
    pub entry_id: Option<String>,
    pub request_id: Option<String>,
    pub source: Option<String>,
    pub resource_type: Option<ResourceType>,
    pub resource_id: Option<String>,
}
#[derive(Clone, Debug)]
pub struct TrackOptions {
    pub channel_id: String,
    pub customer_id: Option<dima_model::Private<String>>,
    pub provider: Provider,
    /// Already counted in the correct billing unit for the caller. Text is never needed here.
    pub characters: f64,
    pub require_durable_usage: bool,
    pub usage: UsageContext,
}
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub cache_deadline: Duration,
    pub ingest_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            cache_deadline: Duration::from_secs(5),
            ingest_deadline: Duration::from_secs(120),
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum CacheFailure {
    #[error("TTS cache deadline exceeded")]
    Deadline,
    #[error(transparent)]
    Store(#[from] DragonflyError),
}
#[derive(Debug)]
pub struct TrackResult {
    pub usage: UsageResult,
    pub cache_error: Option<CacheFailure>,
    pub ingestion: Option<IngestOutcome>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid TTS usage input or deadline")]
    Invalid,
    #[error("TTS usage recording unavailable")]
    DurableUnavailable(Box<TrackResult>),
}
fn valid(options: &TrackOptions, config: Config) -> bool {
    !config.cache_deadline.is_zero()
        && !config.ingest_deadline.is_zero()
        && !options.channel_id.is_empty()
        && options.channel_id.len() <= 256
        && options.characters.is_finite()
        && (0.0..=9_007_199_254_740_991.0).contains(&options.characters)
        && options
            .customer_id
            .as_ref()
            .is_none_or(|s| s.expose().len() <= 256)
        && [
            &options.usage.entry_id,
            &options.usage.request_id,
            &options.usage.source,
            &options.usage.resource_id,
        ]
        .into_iter()
        .all(|s| s.as_ref().is_none_or(|s| s.len() <= 1024))
}
async fn increment(
    cache: &Dragonfly,
    key: &str,
    field: &str,
    amount: f64,
) -> Result<(), DragonflyError> {
    let _: i64 = cache
        .query(
            redis::cmd("HINCRBY")
                .arg(key)
                .arg(field)
                .arg(dima_text::number_to_string(amount)),
        )
        .await?;
    Ok(())
}
async fn cache_usage(
    cache: &Dragonfly,
    clock: &dyn Clock,
    options: &TrackOptions,
    usage: UsageResult,
) -> Result<(), CacheFailure> {
    let key = format!("{}:tts:usage", options.channel_id);
    let p = options.provider.as_str();
    increment(cache, &key, &format!("{p}_characters"), usage.characters).await?;
    increment(cache, &key, &format!("{p}_credits"), usage.credits_consumed).await?;
    increment(
        cache,
        &key,
        &format!("{p}_cost"),
        dima_text::math_round(usage.cost_usd * 100000.0),
    )
    .await?;
    // Date's local calendar is UTC in the frozen runtime; milliseconds do not enter its TTL.
    let f = dima_text::utc_fields(clock.now_ms()).ok_or(CacheFailure::Deadline)?;
    let ttl = (30 - i64::from(f.day)) * 86400
        - i64::from(f.hour) * 3600
        - i64::from(f.minute) * 60
        - i64::from(f.second);
    let _: i64 = cache.query(redis::cmd("EXPIRE").arg(&key).arg(ttl)).await?;
    increment(cache, &key, "total_characters", usage.characters).await?;
    increment(cache, &key, "total_credits", usage.credits_consumed).await?;
    Ok(())
}
pub async fn track_tts_usage(
    cache: &Dragonfly,
    ingest: &dyn UsageIngest,
    clock: &dyn Clock,
    options: &TrackOptions,
    config: Config,
) -> Result<TrackResult, Error> {
    if !valid(options, config) {
        return Err(Error::Invalid);
    }
    let usage = calculate_tts_usage(options.provider.as_str(), options.characters);
    let cache_error = match tokio::time::timeout(
        config.cache_deadline,
        cache_usage(cache, clock, options, usage),
    )
    .await
    {
        Ok(result) => result.err(),
        Err(_) => Some(CacheFailure::Deadline),
    };
    let ingestion = if let Some(customer) = options
        .customer_id
        .as_ref()
        .filter(|s| !s.expose().is_empty() && usage.polarsh_cost > 0.0)
    {
        let input = UsageEventInput {
            customer_id: customer.clone(),
            channel_id: Some(options.channel_id.clone()),
            external_id: options.usage.entry_id.clone(),
            cost: usage.cost_usd,
            reason: format!("tts_{}", options.provider.as_str()),
            tts_cost: Some(usage.polarsh_cost),
            characters: Some(usage.characters),
            usage: Some(AiUsageContextInput {
                request_id: options.usage.request_id.clone(),
                source: options.usage.source.clone(),
                provider: Some(options.provider.as_str().into()),
                quantity: Some(usage.characters),
                unit: Some(Unit::Characters),
                resource_type: options.usage.resource_type,
                resource_id: options.usage.resource_id.clone(),
                ..Default::default()
            }),
            ..Default::default()
        };
        Some(
            tokio::time::timeout(
                config.ingest_deadline,
                ingest.ingest(&input, IngestMode::Batch),
            )
            .await
            .unwrap_or_else(|_| IngestOutcome::OutcomeUnknown {
                message: "TTS ingest deadline exceeded; retry with the same external id".into(),
            }),
        )
    } else {
        None
    };
    let failed = ingestion.as_ref().is_some_and(IngestOutcome::is_error);
    let report = TrackResult {
        usage,
        cache_error,
        ingestion,
    };
    if options.require_durable_usage && failed {
        Err(Error::DurableUnavailable(Box::new(report)))
    } else {
        Ok(report)
    }
}
