//! Usage counters and durable billing hand-off from `utils/tts_usage.ts`.
//!
//! Pricing is not repeated here: [`calculate_tts_usage`] and
//! [`TtsUsageResult`] are re-exported from [`super::tts::usage`], the existing
//! source-proven port of `calculateTtsUsage`. This module adds the two
//! remaining source behaviors:
//!
//! * the six sequential `HINCRBY`/`EXPIRE` writes against
//!   `<channelID>:tts:usage`, with the source's *local-time* fixed
//!   thirty-day expiry formula; and
//! * the `ingestPolarSHEvent({ mode: "batch" })` hand-off, implemented by the
//!   concrete [`PolarUsage`] batch adapter (durable queue, projection, receipt,
//!   best-effort PostHog, then the Polar HTTP flush).
//!
//! Source semantics preserved deliberately:
//!
//! * Cache acquisition happens before the source `try`, so an acquisition
//!   failure escapes instead of being logged and swallowed.
//! * A failing cache step skips every later cache step. Nothing is replayed: an
//!   interrupted or uncertain write is never repeated by this module.
//! * Cache failures are logged with `function`/`error`/`channelID`/`provider`/
//!   `characters` for `channelId` at both destinations, then billing continues.
//! * Billing runs only when the customer ID is truthy and `polarshCost > 0`.
//!   A durable-ingestion error becomes [`TtsUsageTrackError::RecordingUnavailable`]
//!   only when `requireDurableUsage` is set; otherwise the priced usage returns.
//! * `text` is part of the source option type but is never read, logged, or
//!   forwarded. It stays here only so call sites keep the same shape.
//!
//! Construction performs no I/O. [`TtsUsageTracker`] holds the caller's shared
//! concrete handles; [`track_tts_usage`] is the lazy drop-in entry point that
//! acquires the process cache and logger on first use.

use super::{
    ai_credit_projection::AiCreditProjection,
    ai_usage_producer::AiUsageProducer,
    js_string::JsString,
    json_number::number_string,
    logger::{
        Clock, Destination, Level, LogOptions, Logger, LoggerConfig, SinkHandles, StdConsole,
        SystemClock, UuidSource, redis::RedisCacheSink,
    },
    lossless_json::JsonValue,
    polar::PolarClient,
    polar_cache_usage::{CacheUsageOptions, CacheUsageResponse, PolarCacheUsage},
    polar_usage::PolarUsage,
    posthog_tracking::PosthogTracking,
    tts_usage_pricing::js_round,
};
use redis::aio::ConnectionManager;
use std::{sync::Arc, time::Duration};

pub use super::tts::usage::{TtsUsageResult, calculate_tts_usage, calculate_tts_usage_js};

/// Bound for the local credit projection, matching the existing cache-sink and
/// fixture bound. Callers that own a tighter request budget may lower it.
pub const DEFAULT_USAGE_DEADLINE: Duration = Duration::from_secs(2);

/// Cache-failure logging destination timeout used by the lazy logger.
const LOGGER_SINK_TIMEOUT: Duration = Duration::from_secs(2);

const RECORDING_UNAVAILABLE: &str = "TTS usage recording unavailable";

/// `streamer` sub-document. `plan_tier` is declared by the source and unused by
/// tracking.
#[derive(Clone, Debug, Default)]
pub struct TtsUsageStreamer {
    pub polar_sh_customer_id: Option<JsString>,
    pub plan_tier: Option<JsString>,
}

/// Optional descriptive receipt metadata. It never affects pricing or credits.
#[derive(Clone, Debug, Default)]
pub struct TtsUsageContext {
    pub entry_id: Option<JsString>,
    pub request_id: Option<JsString>,
    pub source: Option<JsString>,
    pub resource_type: Option<JsString>,
    pub resource_id: Option<JsString>,
}

/// `TtsUsageTrackOptions`.
#[derive(Clone, Debug)]
pub struct TtsUsageTrackOptions {
    pub channel_id: JsString,
    pub streamer: TtsUsageStreamer,
    pub provider: JsString,
    pub characters: f64,
    /// Unused by the source tracker. Never logged and never forwarded.
    pub text: JsString,
    pub require_durable_usage: bool,
    pub usage: Option<TtsUsageContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtsUsageTrackError {
    /// The cache could not be acquired. Acquisition is outside the source `try`.
    Acquisition(String),
    /// `requireDurableUsage` was set and the durable ingestion reported an error.
    RecordingUnavailable,
}

impl std::fmt::Display for TtsUsageTrackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Acquisition(message) => formatter.write_str(message),
            Self::RecordingUnavailable => formatter.write_str(RECORDING_UNAVAILABLE),
        }
    }
}

impl std::error::Error for TtsUsageTrackError {}

/// Batch is the runtime path. Cache-only is an explicit injected adapter and
/// is not selected by [`TtsUsageTracker::from_cache`] or [`track_tts_usage`].
#[derive(Clone)]
enum Billing {
    Batch(Arc<PolarUsage>),
    CacheOnly(Arc<PolarCacheUsage>),
}

/// Shared concrete cache, billing adapter, logger, and clock handles.
#[derive(Clone)]
pub struct TtsUsageTracker {
    cache: ConnectionManager,
    billing: Billing,
    logger: Logger,
    clock: Arc<dyn Clock>,
}

impl TtsUsageTracker {
    /// The clock only supplies the source's `new Date()` local-time components.
    /// This is the normal batch constructor.
    pub fn with_batch_clock(
        cache: ConnectionManager,
        polar: PolarUsage,
        logger: Logger,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            cache,
            billing: Billing::Batch(Arc::new(polar)),
            logger,
            clock,
        }
    }

    /// Explicit cache-only ingestion. It does not call Polar HTTP. Normal
    /// tracking does not use this constructor.
    pub fn with_cache_only(
        cache: ConnectionManager,
        polar: PolarCacheUsage,
        logger: Logger,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            cache,
            billing: Billing::CacheOnly(Arc::new(polar)),
            logger,
            clock,
        }
    }

    /// Builds the batch adapter from a shared cache. PostHog stays lazy on the
    /// best-effort projection path, so analytics setup cannot block counters
    /// or the durable queue. This constructor performs no I/O.
    pub fn from_cache(cache: ConnectionManager, logger: Logger, deadline: Duration) -> Self {
        let durable = PolarCacheUsage::with_optional_tracking(
            cache.clone(),
            AiCreditProjection::new(cache.clone(), deadline),
            AiUsageProducer::new(cache.clone()),
            None,
            logger.clone(),
        );
        let polar = PolarUsage::lazy(durable, logger.clone());
        Self::with_batch_clock(cache, polar, logger, Arc::new(SystemClock))
    }

    /// Explicit composition with an already-acquired PostHog handle and Polar
    /// client. Tests use this; [`Self::from_cache`] does not require either.
    pub fn from_parts(
        cache: ConnectionManager,
        logger: Logger,
        deadline: Duration,
        posthog: PosthogTracking,
        client: PolarClient,
    ) -> Self {
        let durable = PolarCacheUsage::with_logger(
            cache.clone(),
            AiCreditProjection::new(cache.clone(), deadline),
            AiUsageProducer::new(cache.clone()),
            posthog,
            logger.clone(),
        );
        let polar = PolarUsage::shared(durable, client, logger.clone());
        Self::with_batch_clock(cache, polar, logger, Arc::new(SystemClock))
    }

    /// Drop-in `trackTtsUsage`.
    pub async fn track(
        &self,
        options: &TtsUsageTrackOptions,
    ) -> Result<TtsUsageResult, TtsUsageTrackError> {
        let usage = calculate_tts_usage_js(&options.provider, options.characters);
        let key = format!("{}:tts:usage", options.channel_id.to_utf8_lossy());
        if let Err(error) = self.write_counters(options, &usage, &key).await {
            self.log_cache_error(options, &error).await;
        }
        if let Some(customer_id) = options
            .streamer
            .polar_sh_customer_id
            .as_ref()
            .filter(|customer| !customer.is_empty())
            && usage.polarsh_cost > 0.0
        {
            let ingestion = self
                .bill(&billing_options(options, &usage, customer_id))
                .await;
            if options.require_durable_usage && ingestion.error {
                return Err(TtsUsageTrackError::RecordingUnavailable);
            }
        }
        Ok(usage)
    }

    /// Six independent commands, in source order. The first failure stops the
    /// block; applied writes are retained and never replayed.
    async fn write_counters(
        &self,
        options: &TtsUsageTrackOptions,
        usage: &TtsUsageResult,
        key: &str,
    ) -> Result<(), String> {
        let mut cache = self.cache.clone();
        let provider = options.provider.to_utf8_lossy();
        increment(
            &mut cache,
            key,
            &format!("{provider}_characters"),
            options.characters,
        )
        .await?;
        increment(
            &mut cache,
            key,
            &format!("{provider}_credits"),
            usage.credits_consumed,
        )
        .await?;
        increment(
            &mut cache,
            key,
            &format!("{provider}_cost"),
            js_round(usage.cost_usd * 100_000.0),
        )
        .await?;
        // The source reads the clock for the expiry argument, after the three
        // provider writes and before the totals.
        let ttl = generate_time_left_to_next_month_in_seconds(self.clock.now_millis())?;
        redis::cmd("EXPIRE")
            .arg(key)
            .arg(ttl)
            .query_async::<i64>(&mut cache)
            .await
            .map_err(|error| error.to_string())?;
        increment(&mut cache, key, "total_characters", options.characters).await?;
        increment(&mut cache, key, "total_credits", usage.credits_consumed).await?;
        Ok(())
    }

    async fn bill(&self, options: &CacheUsageOptions) -> CacheUsageResponse {
        match &self.billing {
            Billing::Batch(polar) => polar.ingest(options).await,
            Billing::CacheOnly(polar) => polar.ingest(options).await,
        }
    }

    async fn log_cache_error(&self, options: &TtsUsageTrackOptions, error: &str) {
        let mut data = serde_json::Map::new();
        data.insert("function".into(), "trackTtsUsage".into());
        data.insert("error".into(), error.into());
        data.insert(
            "channelID".into(),
            options.channel_id.to_utf8_lossy().into(),
        );
        data.insert("provider".into(), options.provider.to_utf8_lossy().into());
        // `Value::from(f64)` mirrors JSON.stringify's NaN/Infinity null.
        data.insert(
            "characters".into(),
            serde_json::Value::from(options.characters),
        );
        let _ = self
            .logger
            .log(
                Level::Error,
                serde_json::Value::Object(data),
                LogOptions {
                    destination: Destination::Both,
                    channel_id: Some(options.channel_id.to_utf8_lossy()),
                    ..LogOptions::default()
                },
            )
            .await;
    }
}

/// `trackTtsUsage`. Cache acquisition happens before the source `try`, so its
/// error escapes as [`TtsUsageTrackError::Acquisition`].
pub async fn track_tts_usage(
    options: &TtsUsageTrackOptions,
) -> Result<TtsUsageResult, TtsUsageTrackError> {
    let cache = super::redis::get_redis_client()
        .await
        .map_err(|error| TtsUsageTrackError::Acquisition(error.to_string()))?;
    let logger = default_logger(cache.clone());
    let tracker = TtsUsageTracker::from_cache(cache, logger, DEFAULT_USAGE_DEADLINE);
    tracker.track(options).await
}

/// The source's fixed local-time formula, not a true next-month calculation:
/// `(30 - dayOfMonth) * 24 * 3600 - hours * 3600 - minutes * 60 - seconds`.
/// Days 30 and 31 therefore produce zero or negative expiries.
pub fn generate_time_left_to_next_month_in_seconds(now_millis: i64) -> Result<i64, String> {
    let (day, hour, minute, second) =
        local_parts(now_millis).ok_or_else(|| "local wall-clock time is unavailable".to_owned())?;
    Ok((30 - day) * 24 * 3600 - hour * 3600 - minute * 60 - second)
}

/// Source `usage` argument: undefined members are omitted, so the key order and
/// absence match `JSON.stringify` of the source object literal.
fn billing_options(
    options: &TtsUsageTrackOptions,
    usage: &TtsUsageResult,
    customer_id: &JsString,
) -> CacheUsageOptions {
    // Template-literal concatenation keeps unpaired UTF-16 units intact.
    let mut reason: Vec<u16> = "tts_".encode_utf16().collect();
    reason.extend(options.provider.code_units());
    let reason = JsString::from_units(reason);
    let mut fields: Vec<(JsString, JsonValue)> = Vec::new();
    if let Some(context) = &options.usage {
        push_present(&mut fields, "requestId", context.request_id.as_ref());
        push_present(&mut fields, "source", context.source.as_ref());
    }
    fields.push((
        "provider".into(),
        JsonValue::String(options.provider.clone()),
    ));
    fields.push(("quantity".into(), JsonValue::Number(options.characters)));
    fields.push(("unit".into(), JsonValue::String("characters".into())));
    if let Some(context) = &options.usage {
        push_present(&mut fields, "resourceType", context.resource_type.as_ref());
        push_present(&mut fields, "resourceId", context.resource_id.as_ref());
    }
    CacheUsageOptions {
        customer_id: customer_id.clone(),
        channel_id: options.channel_id.clone(),
        external_id: options
            .usage
            .as_ref()
            .and_then(|context| context.entry_id.clone()),
        cost: usage.cost_usd,
        reason,
        llm: None,
        polar_cost: Some(usage.polarsh_cost),
        characters: Some(options.characters),
        usage: JsonValue::Object(fields),
    }
}

fn push_present(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: Option<&JsString>) {
    if let Some(value) = value {
        fields.push((key.into(), JsonValue::String(value.clone())));
    }
}

/// The increment travels as the source's JavaScript number text, so a
/// non-integral value is rejected by the cache exactly as in the source instead
/// of being silently truncated.
async fn increment(
    cache: &mut ConnectionManager,
    key: &str,
    field: &str,
    value: f64,
) -> Result<(), String> {
    redis::cmd("HINCRBY")
        .arg(key)
        .arg(field)
        .arg(number_string(value))
        .query_async::<i64>(cache)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn default_logger(cache: ConnectionManager) -> Logger {
    let sink =
        RedisCacheSink::new(cache, LOGGER_SINK_TIMEOUT).expect("fixed nonzero logger timeout");
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(Arc::new(sink)),
            console: Some(Arc::new(StdConsole)),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("default logger limits")
}

#[cfg(target_os = "linux")]
fn local_parts(millis: i64) -> Option<(i64, i64, i64, i64)> {
    let seconds = millis.div_euclid(1_000);
    // The pinned libc marks time_t deprecated during its musl ABI transition.
    #[allow(deprecated, clippy::useless_conversion)]
    let timestamp = libc::time_t::try_from(seconds).ok()?;
    let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
    // `timestamp` is a valid time_t and `local` is aligned, writable storage.
    let result = unsafe { libc::localtime_r(&timestamp, local.as_mut_ptr()) };
    if result.is_null() {
        return None;
    }
    // SAFETY: localtime_r returned success and initialized the output struct.
    let local = unsafe { local.assume_init() };
    Some((
        i64::from(local.tm_mday),
        i64::from(local.tm_hour),
        i64::from(local.tm_min),
        i64::from(local.tm_sec),
    ))
}

/// Non-Linux hosts have no configured-zone reader in this crate; use UTC parts
/// and document the difference. Production and fixture runs are Linux/musl.
#[cfg(not(target_os = "linux"))]
fn local_parts(millis: i64) -> Option<(i64, i64, i64, i64)> {
    let seconds = millis.div_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    Some((day, rest / 3600, rest % 3600 / 60, rest % 60))
}
