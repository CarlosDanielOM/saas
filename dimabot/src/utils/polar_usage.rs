//! Concrete `ingestPolarSHEvent` and `grantPolarAiCredits`.
//!
//! Batch mode reuses the shared [`PolarCacheUsage`] prefix: validate, lock,
//! migrate, queue, and project, then flush through `POST /v1/events/ingest`.
//! Immediate mode acquires Redis first, sends one event with no queue or lease,
//! and projects only after the SDK accepts it. Grants call the same process-wide
//! client, then analytics, and open Redis only after success when a channel is
//! present. The public factory reads `POLARSH_OAT` only and does not open Redis.
//!
//! There is no application-level replay of an uncertain Redis mutation or
//! provider call. The event HTTP client does not retry. A dropped batch flush
//! does not release the ingest lease; the lock key expires by its TTL.

use super::{
    ai_credit_projection::AiCreditProjection,
    ai_usage_lossless::{create_ai_usage_context_json, enrich_polar_usage_metadata_json},
    ai_usage_producer::AiUsageProducer,
    js_string::JsString,
    logger::{
        CacheRecord, CacheSink, ConsoleSink, Destination, Level, LogOptions, Logger, LoggerConfig,
        SinkError, SinkFuture, SinkHandles, StdConsole, SystemClock, UuidSource,
    },
    lossless_json::{JsonValue, parse_json},
    polar::{PolarClient, PolarConfig, PolarConfigError, PolarError, PolarPolicy},
    polar_cache_usage::{
        CacheUsageOptions, CacheUsageResponse, IngestLease, PolarCacheUsage, enqueue_usage_receipt,
        prepare_event, track_recorded,
    },
    posthog_tracking::PosthogTracking,
    redis::get_redis_client,
};
use redis::aio::ConnectionManager;
use reqwest::{
    Method,
    header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT},
};
use std::{
    sync::{Arc, Mutex, OnceLock, PoisonError},
    time::Duration,
};

const PROJECTION_DEADLINE: Duration = Duration::from_secs(2);
const GRANT_SOURCE_FALLBACK: &str = "admin_credit_grant";
const IMMEDIATE_CALLER: &str = "ingestPolarSHEvent immediate mode";
const GRANT_CALLER: &str = "grantPolarAiCredits";

pub const POLAR_EVENTS_INGEST_PATH: &str = "/v1/events/ingest";
pub const POLAR_EVENTS_USER_AGENT: &str =
    "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk";

const CALLER: &str = "ingestPolarSHEvent batch/cache mode";
const VALIDATION_FAILED: &str = "Input validation failed";

type ClientFactory = Arc<dyn Fn() -> Result<PolarClient, PolarError> + Send + Sync>;

/// `polarsh.ts` passes only the OAT to the SDK. Other billing helper
/// environment overrides do not change this client's SDK-default endpoint.
pub fn source_polar_config(
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> Result<PolarConfig, PolarConfigError> {
    PolarConfig::from_lookup(|name| {
        if name == "POLARSH_OAT" {
            lookup(name)
        } else {
            None
        }
    })
}

struct TransportState {
    client: Option<PolarClient>,
    creations: u64,
    announce: bool,
}

fn default_transport() -> Arc<Mutex<TransportState>> {
    static TRANSPORT: OnceLock<Arc<Mutex<TransportState>>> = OnceLock::new();
    Arc::clone(TRANSPORT.get_or_init(|| {
        Arc::new(Mutex::new(TransportState {
            client: None,
            creations: 0,
            announce: true,
        }))
    }))
}

/// Batch ingest over a shared durable prefix and a shared Polar connection pool.
#[derive(Clone)]
pub struct PolarUsage {
    durable: PolarCacheUsage,
    factory: Option<ClientFactory>,
    transport: Arc<Mutex<TransportState>>,
    logger: Logger,
}

/// Parsed queue rows. Malformed text is omitted; successfully parsed JSON,
/// including non-objects, is kept in order.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedPending {
    pub parsed: Vec<JsonValue>,
    pub raw_len: usize,
}

impl PolarUsage {
    /// Builds a client from `POLARSH_OAT` on the first flush that needs HTTP.
    /// A missing token is not cached, so a later call can succeed. The client
    /// is the process-wide pool from [`get_polar_sh_client`].
    pub fn lazy(durable: PolarCacheUsage, logger: Logger) -> Self {
        Self {
            durable,
            factory: None,
            transport: default_transport(),
            logger,
        }
    }

    /// Uses an already constructed client. The pool is the client's pool.
    /// Construction does not log the lazy-init line.
    pub fn shared(durable: PolarCacheUsage, client: PolarClient, logger: Logger) -> Self {
        Self {
            durable,
            factory: None,
            transport: Arc::new(Mutex::new(TransportState {
                client: Some(client),
                creations: 0,
                announce: false,
            })),
            logger,
        }
    }

    /// Test and explicit factories. Only a successful client is cached.
    pub fn from_factory(
        durable: PolarCacheUsage,
        logger: Logger,
        factory: impl Fn() -> Result<PolarClient, PolarError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            durable,
            factory: Some(Arc::new(factory)),
            transport: Arc::new(Mutex::new(TransportState {
                client: None,
                creations: 0,
                announce: true,
            })),
            logger,
        }
    }

    /// Successful lazy constructions. An injected client stays at zero.
    pub fn client_creations(&self) -> u64 {
        self.transport
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .creations
    }

    /// Whether this value uses the process-wide SDK pool.
    pub fn uses_process_transport(&self) -> bool {
        Arc::ptr_eq(&self.transport, &default_transport())
    }

    /// Batch ingest. Cache-only callers keep using [`PolarCacheUsage::ingest`].
    /// The TTS caller reads [`CacheUsageResponse::error`] and does not need
    /// provider details.
    pub async fn ingest(&self, options: &CacheUsageOptions) -> CacheUsageResponse {
        self.ingest_delivery(options).await.response
    }

    /// Batch ingest including the source `details` object on an incomplete
    /// provider response.
    pub async fn ingest_event(&self, options: &CacheUsageOptions) -> PolarEventResponse {
        let delivery = self.ingest_delivery(options).await;
        PolarEventResponse {
            error: delivery.response.error,
            message: delivery.response.message,
            details: delivery.details,
        }
    }

    async fn ingest_delivery(&self, options: &CacheUsageOptions) -> IngestDelivery {
        let queued = self.durable.enqueue_durable(options).await;
        let Some(lease) = queued.lease else {
            return IngestDelivery {
                response: queued.response,
                details: None,
            };
        };
        let delivery = self.flush(&lease, &options.channel_id).await;
        self.durable.release_lease(&lease).await;
        delivery
    }

    async fn flush(&self, lease: &IngestLease, channel: &JsString) -> IngestDelivery {
        let raw = match self.durable.list_pending(&lease.queue_key).await {
            Ok(raw) => raw,
            Err(error) => return self.fail(channel, error).await,
        };
        if raw.is_empty() {
            return IngestDelivery::done(CacheUsageResponse::ok(None));
        }
        let pending = classify_pending(&raw);
        if pending.parsed.is_empty() {
            return match self.durable.delete_queue(&lease.queue_key).await {
                Ok(()) => IngestDelivery::done(CacheUsageResponse::ok(None)),
                Err(error) => self.fail(channel, error).await,
            };
        }
        // Source acquires the client before SDK validation. A missing token is
        // reported after the durable queue and projection, with the queue intact.
        let client = match self.client().await {
            Ok(client) => client,
            Err(error) => return self.fail(channel, error.to_string()).await,
        };
        let outcome = match post_events(&client, &pending.parsed).await {
            Ok(outcome) => outcome,
            Err(error) => return self.fail(channel, error).await,
        };
        match outcome {
            ProviderOutcome::Complete => {}
            ProviderOutcome::Incomplete(result) => {
                self.log(
                    channel,
                    serde_json::json!({
                        "function": "ingestPolarSHEvent",
                        "error": "PolarSH ingest incomplete",
                        "expected": pending.parsed.len(),
                        "ingestResult": result.clone(),
                    }),
                )
                .await;
                return IngestDelivery {
                    response: CacheUsageResponse::error("PolarSH ingest incomplete"),
                    details: Some(result),
                };
            }
        }
        match self
            .durable
            .trim_pending(&lease.queue_key, pending.raw_len as i64)
            .await
        {
            Ok(()) => IngestDelivery::done(CacheUsageResponse::ok(None)),
            Err(error) => self.fail(channel, error).await,
        }
    }

    async fn client(&self) -> Result<PolarClient, PolarError> {
        let factory = if Arc::ptr_eq(&self.transport, &default_transport()) {
            process_factory()
        } else if let Some(factory) = &self.factory {
            Arc::clone(factory)
        } else {
            // `shared` already installed a client. The factory is not called.
            Arc::new(|| Err(missing_token()))
        };
        acquire_client(&self.transport, &factory, &self.logger, CALLER).await
    }

    async fn fail(&self, channel: &JsString, message: impl Into<String>) -> IngestDelivery {
        let message = message.into();
        self.log(
            channel,
            serde_json::json!({
                "function": "ingestPolarSHEvent",
                "error": message,
            }),
        )
        .await;
        IngestDelivery {
            response: CacheUsageResponse::error(message),
            details: None,
        }
    }

    async fn log(&self, channel: &JsString, data: serde_json::Value) {
        let _ = self
            .logger
            .log(
                Level::Error,
                data,
                LogOptions {
                    destination: Destination::Both,
                    channel_id: Some(channel.to_utf8_lossy()),
                    ..LogOptions::default()
                },
            )
            .await;
    }
}

struct IngestDelivery {
    response: CacheUsageResponse,
    details: Option<serde_json::Value>,
}

impl IngestDelivery {
    fn done(response: CacheUsageResponse) -> Self {
        Self {
            response,
            details: None,
        }
    }
}

enum ProviderOutcome {
    Complete,
    Incomplete(serde_json::Value),
}

/// Source `ingestPolarSHEvent` response, including `details` only when the
/// provider accepted the body but stored fewer events than were sent.
#[derive(Debug, Clone, PartialEq)]
pub struct PolarEventResponse {
    pub error: bool,
    pub message: Option<String>,
    pub details: Option<serde_json::Value>,
}

impl PolarEventResponse {
    /// Object key order is `error`, then `message`, then `details`. Absent
    /// optional fields are omitted, matching the source return objects.
    pub fn to_source_json(&self) -> serde_json::Value {
        let mut fields = serde_json::Map::new();
        fields.insert("error".into(), serde_json::Value::Bool(self.error));
        if let Some(message) = &self.message {
            fields.insert("message".into(), serde_json::Value::String(message.clone()));
        }
        if let Some(details) = &self.details {
            fields.insert("details".into(), details.clone());
        }
        serde_json::Value::Object(fields)
    }
}

/// Source default is `batch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IngestMode {
    Immediate,
    #[default]
    Batch,
    Cache,
}

/// Source `grantPolarAiCredits` arguments. Empty `channel_id` is the omitted
/// channel. `credits` is a binary64 value, floored the way `Math.floor(Number)`
/// floors a finite number.
#[derive(Debug, Clone)]
pub struct GrantPolarAiCreditsOptions {
    pub customer_id: JsString,
    pub channel_id: JsString,
    pub credits: f64,
    pub reason: JsString,
    pub admin_login: Option<JsString>,
    pub external_id: Option<JsString>,
    pub source: Option<JsString>,
}

/// Provider event built with the shared context and metadata helpers.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedGrant {
    pub credits: f64,
    pub source: JsString,
    pub context: JsonValue,
    pub event: JsonValue,
    pub analytics: JsonValue,
}

#[derive(Clone)]
enum RedisSlot {
    Process,
    Ready(ConnectionManager),
}

#[derive(Clone)]
enum ClientSlot {
    Process,
    Ready(PolarClient),
}

/// Production adapter for the three ingest modes and credit grants.
///
/// The process client is the same pool as [`get_polar_sh_client`]. Redis is
/// the process client from [`get_redis_client`] or a caller-supplied manager.
/// Grants do not construct [`PolarUsage`] and do not open Redis until the
/// provider has accepted the event and a channel is present.
#[derive(Clone)]
pub struct PolarRuntime {
    redis: RedisSlot,
    client: ClientSlot,
    logger: Logger,
    posthog: Option<PosthogTracking>,
}

impl PolarRuntime {
    /// Lazy OAT client, lazy Redis, and the process console logger.
    /// Analytics uses the process PostHog client when this value has none.
    pub fn production() -> Self {
        Self {
            redis: RedisSlot::Process,
            client: ClientSlot::Process,
            logger: process_logger().clone(),
            posthog: None,
        }
    }

    /// Injected Redis and Polar client. Neither process pool is touched.
    pub fn with_ready(
        cache: ConnectionManager,
        client: PolarClient,
        logger: Logger,
        posthog: Option<PosthogTracking>,
    ) -> Self {
        Self {
            redis: RedisSlot::Ready(cache),
            client: ClientSlot::Ready(client),
            logger,
            posthog,
        }
    }

    /// Process Redis with an injected Polar client. Used when the provider
    /// must stay on loopback while acquisition still goes through
    /// [`get_redis_client`].
    pub fn with_process_redis(
        client: PolarClient,
        logger: Logger,
        posthog: Option<PosthogTracking>,
    ) -> Self {
        Self {
            redis: RedisSlot::Process,
            client: ClientSlot::Ready(client),
            logger,
            posthog,
        }
    }

    pub async fn ingest(&self, options: &CacheUsageOptions) -> PolarEventResponse {
        self.ingest_mode(options, IngestMode::Batch).await
    }

    pub async fn ingest_mode(
        &self,
        options: &CacheUsageOptions,
        mode: IngestMode,
    ) -> PolarEventResponse {
        match mode {
            IngestMode::Immediate => self.ingest_immediate(options).await,
            IngestMode::Batch => self.ingest_durable(options, false).await,
            IngestMode::Cache => self.ingest_durable(options, true).await,
        }
    }

    pub async fn grant(&self, options: &GrantPolarAiCreditsOptions) -> PolarEventResponse {
        let prepared = match prepare_grant(options) {
            Ok(prepared) => prepared,
            Err(message)
                if message == "customerId is required"
                    || message == "credits must be a positive number" =>
            {
                return event_error(message);
            }
            Err(message) => {
                return self
                    .fail_grant(options, options.credits.floor(), message)
                    .await;
            }
        };
        let client = match self.sdk(GRANT_CALLER).await {
            Ok(client) => client,
            Err(error) => {
                return self
                    .fail_grant(options, prepared.credits, error.to_string())
                    .await;
            }
        };
        match post_events(&client, std::slice::from_ref(&prepared.event)).await {
            Err(error) => self.fail_grant(options, prepared.credits, error).await,
            Ok(ProviderOutcome::Incomplete(result)) => PolarEventResponse {
                error: true,
                message: Some("PolarSH grant credits ingest incomplete".into()),
                details: Some(result),
            },
            Ok(ProviderOutcome::Complete) => {
                track_recorded(self.posthog.as_ref(), &prepared.analytics).await;
                if !options.channel_id.is_empty() {
                    match self.redis().await {
                        Ok(cache) => {
                            let producer = AiUsageProducer::new(cache);
                            if let Err(error) = enqueue_usage_receipt(
                                &producer,
                                options.channel_id.clone(),
                                options.customer_id.clone(),
                                &prepared.context,
                                -prepared.credits,
                            )
                            .await
                            {
                                self.log_receipt(&options.channel_id, &error).await;
                            }
                        }
                        Err(error) => self.log_receipt(&options.channel_id, &error).await,
                    }
                }
                event_ok()
            }
        }
    }

    async fn ingest_immediate(&self, options: &CacheUsageOptions) -> PolarEventResponse {
        if options.customer_id.is_empty() {
            return event_error("customerId is required");
        }
        let channel = channel_log(&options.channel_id);
        // Source acquires Redis before the event is built and before HTTP.
        let cache = match self.redis().await {
            Ok(cache) => cache,
            Err(error) => return self.fail_ingest(channel, error).await,
        };
        let event = match prepare_event(options) {
            Ok(event) => event,
            Err(error) => return self.fail_ingest(channel, error).await,
        };
        let client = match self.sdk(IMMEDIATE_CALLER).await {
            Ok(client) => client,
            Err(error) => return self.fail_ingest(channel, error.to_string()).await,
        };
        let parsed = match parse_json(&event.wire) {
            Ok(parsed) => parsed,
            Err(error) => return self.fail_ingest(channel, error).await,
        };
        match post_events(&client, std::slice::from_ref(&parsed)).await {
            Err(error) => self.fail_ingest(channel, error).await,
            Ok(ProviderOutcome::Incomplete(result)) => PolarEventResponse {
                error: true,
                message: Some("PolarSH ingest incomplete".into()),
                details: Some(result),
            },
            Ok(ProviderOutcome::Complete) => {
                self.durable(&cache)
                    .project_accepted(options, &event, !options.channel_id.is_empty())
                    .await;
                event_ok()
            }
        }
    }

    async fn ingest_durable(
        &self,
        options: &CacheUsageOptions,
        cache_only: bool,
    ) -> PolarEventResponse {
        if options.customer_id.is_empty() {
            return event_error("customerId is required");
        }
        if options.channel_id.is_empty() {
            return event_error("channelID is required for batch/cache modes");
        }
        let cache = match self.redis().await {
            Ok(cache) => cache,
            Err(error) => return self.fail_ingest(Some(&options.channel_id), error).await,
        };
        let durable = self.durable(&cache);
        if cache_only {
            return from_cache(durable.ingest(options).await);
        }
        self.batch_usage(durable).ingest_event(options).await
    }

    fn durable(&self, cache: &ConnectionManager) -> PolarCacheUsage {
        PolarCacheUsage::with_optional_tracking(
            cache.clone(),
            AiCreditProjection::new(cache.clone(), PROJECTION_DEADLINE),
            AiUsageProducer::new(cache.clone()),
            self.posthog.clone(),
            self.logger.clone(),
        )
    }

    fn batch_usage(&self, durable: PolarCacheUsage) -> PolarUsage {
        match &self.client {
            ClientSlot::Process => PolarUsage::lazy(durable, self.logger.clone()),
            ClientSlot::Ready(client) => {
                PolarUsage::shared(durable, client.clone(), self.logger.clone())
            }
        }
    }

    async fn redis(&self) -> Result<ConnectionManager, String> {
        match &self.redis {
            RedisSlot::Ready(cache) => Ok(cache.clone()),
            RedisSlot::Process => get_redis_client().await.map_err(|error| error.to_string()),
        }
    }

    async fn sdk(&self, caller: &str) -> Result<PolarClient, PolarError> {
        match &self.client {
            ClientSlot::Ready(client) => Ok(client.clone()),
            ClientSlot::Process => get_polar_sh_client(caller).await,
        }
    }

    async fn fail_ingest(
        &self,
        channel: Option<&JsString>,
        message: impl Into<String>,
    ) -> PolarEventResponse {
        let message = message.into();
        log_both(
            &self.logger,
            channel,
            serde_json::json!({
                "function": "ingestPolarSHEvent",
                "error": message,
            }),
        )
        .await;
        event_error(message)
    }

    async fn fail_grant(
        &self,
        options: &GrantPolarAiCreditsOptions,
        credits: f64,
        message: impl Into<String>,
    ) -> PolarEventResponse {
        let message = message.into();
        let _ = self
            .logger
            .log(
                Level::Error,
                serde_json::json!({
                    "function": "grantPolarAiCredits",
                    "customerId": options.customer_id.to_utf8_lossy(),
                    "credits": credits,
                    "error": message,
                }),
                LogOptions {
                    destination: Destination::Both,
                    ..LogOptions::default()
                },
            )
            .await;
        event_error(message)
    }

    async fn log_receipt(&self, channel: &JsString, message: &str) {
        log_both(
            &self.logger,
            Some(channel),
            serde_json::json!({
                "function": "grantPolarAiCredits.receipt",
                "error": message,
            }),
        )
        .await;
    }
}

/// `Math.floor(Number(credits))`, then the source positive-finite check.
pub fn grant_credit_count(credits: f64) -> Result<f64, &'static str> {
    let credits = credits.floor();
    if !credits.is_finite() || credits <= 0.0 {
        Err("credits must be a positive number")
    } else {
        Ok(credits)
    }
}

/// `String(source || "admin_credit_grant").trim().slice(0, 96)`, with the
/// same empty fallback. The slice counts UTF-16 code units.
pub fn grant_source_name(source: Option<&JsString>) -> JsString {
    let Some(source) = source.filter(|value| !value.is_empty()) else {
        return JsString::from(GRANT_SOURCE_FALLBACK);
    };
    let trimmed = source.trim().slice(0, 96);
    if trimmed.is_empty() {
        JsString::from(GRANT_SOURCE_FALLBACK)
    } else {
        trimmed
    }
}

/// Builds the grant event without Redis or HTTP. Validation failures use the
/// source messages and do not log.
pub fn prepare_grant(options: &GrantPolarAiCreditsOptions) -> Result<PreparedGrant, String> {
    if options.customer_id.is_empty() {
        return Err("customerId is required".into());
    }
    let credits = grant_credit_count(options.credits).map_err(str::to_owned)?;
    let source = grant_source_name(options.source.as_ref());
    let admin = options
        .admin_login
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| JsString::from("unknown"));
    let mut input = Vec::new();
    if let Some(id) = options.external_id.as_ref().filter(|id| !id.is_empty()) {
        input.push((JsString::from("entryId"), js_text(id)));
        input.push((JsString::from("requestId"), js_text(id)));
    }
    for (key, value) in [
        ("entryKind", "adjustment"),
        ("category", "credit_adjustment"),
        ("operation", "grant"),
    ] {
        input.push((JsString::from(key), js_static(value)));
    }
    input.push((JsString::from("source"), js_text(&source)));
    input.push((JsString::from("provider"), js_static("polar")));
    let context = create_ai_usage_context_json(&options.reason, &JsonValue::Object(input))
        .map_err(|error| error.to_string())?;
    let entry_id = match context.get("entryId") {
        Some(JsonValue::String(entry_id)) => entry_id.clone(),
        _ => return Err("context missing entryId".into()),
    };
    let accounting = JsonValue::Object(vec![
        (JsString::from("credits"), JsonValue::Number(-credits)),
        (JsString::from("cost"), JsonValue::Number(0.0)),
        (JsString::from("currency"), js_static("usd")),
        (JsString::from("reason"), js_text(&options.reason)),
        (JsString::from("source"), js_text(&source)),
        (JsString::from("adminLogin"), js_text(&admin)),
    ]);
    let metadata = enrich_polar_usage_metadata_json(&accounting, &context)
        .map_err(|error| error.to_string())?;
    let event = JsonValue::Object(vec![
        (JsString::from("name"), js_static("ai_usage")),
        (JsString::from("customerId"), js_text(&options.customer_id)),
        (JsString::from("externalId"), js_text(&entry_id)),
        (JsString::from("metadata"), metadata),
    ]);
    let analytics = JsonValue::Object(vec![
        (JsString::from("context"), context.clone()),
        (JsString::from("credits"), JsonValue::Number(-credits)),
        (JsString::from("reason"), js_text(&options.reason)),
    ]);
    Ok(PreparedGrant {
        credits,
        source,
        context,
        event,
        analytics,
    })
}

/// Process-wide SDK client. The first successful caller is logged once.
/// A missing token is not cached. This does not open Redis.
pub async fn get_polar_sh_client(caller: &str) -> Result<PolarClient, PolarError> {
    acquire_client(
        &default_transport(),
        &process_factory(),
        process_logger(),
        caller,
    )
    .await
}

/// Batch ingest through the process client and process Redis.
pub async fn ingest_polar_sh_event(options: &CacheUsageOptions) -> PolarEventResponse {
    PolarRuntime::production().ingest(options).await
}

/// `mode` defaults to batch at [`ingest_polar_sh_event`].
pub async fn ingest_polar_sh_event_mode(
    options: &CacheUsageOptions,
    mode: IngestMode,
) -> PolarEventResponse {
    PolarRuntime::production().ingest_mode(options, mode).await
}

/// Provider grant. Local credit projection is not updated.
pub async fn grant_polar_ai_credits(options: &GrantPolarAiCreditsOptions) -> PolarEventResponse {
    PolarRuntime::production().grant(options).await
}

/// Installs the console sink used by the process factory logger. Returns
/// false when that logger was already created. The sink is not a Redis client.
pub fn install_process_console(sink: Arc<dyn ConsoleSink>) -> bool {
    if PROCESS_LOGGER.get().is_some() {
        return false;
    }
    PROCESS_CONSOLE.set(sink).is_ok()
}

fn missing_token() -> PolarError {
    PolarError::Configuration {
        policy: PolarPolicy::Billing,
        kind: PolarConfigError::MissingToken,
    }
}

fn process_factory() -> ClientFactory {
    static FACTORY: OnceLock<ClientFactory> = OnceLock::new();
    Arc::clone(FACTORY.get_or_init(|| {
        Arc::new(|| -> Result<PolarClient, PolarError> {
            let config = source_polar_config(|name| std::env::var(name).ok()).map_err(|kind| {
                PolarError::Configuration {
                    policy: PolarPolicy::Billing,
                    kind,
                }
            })?;
            PolarClient::new(config, PolarPolicy::Billing)
        })
    }))
}

static PROCESS_CONSOLE: OnceLock<Arc<dyn ConsoleSink>> = OnceLock::new();
static PROCESS_LOGGER: OnceLock<Logger> = OnceLock::new();

fn process_console_sink() -> Arc<dyn ConsoleSink> {
    PROCESS_CONSOLE
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(StdConsole) as Arc<dyn ConsoleSink>)
}

fn process_logger() -> &'static Logger {
    PROCESS_LOGGER.get_or_init(|| {
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(Arc::new(LazyRedisCache)),
                console: Some(process_console_sink()),
                ..SinkHandles::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .expect("default logger limits")
    })
}

struct LazyRedisCache;

impl CacheSink for LazyRedisCache {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let cache = get_redis_client()
                .await
                .map_err(|_| SinkError::Unavailable)?;
            let sink = super::logger::redis::RedisCacheSink::new(cache, Duration::from_secs(2))
                .map_err(|_| SinkError::Unavailable)?;
            sink.store(record).await
        })
    }
}

enum BuiltClient {
    Cached(PolarClient),
    Fresh(PolarClient),
}

async fn acquire_client(
    transport: &Arc<Mutex<TransportState>>,
    factory: &ClientFactory,
    logger: &Logger,
    caller: &str,
) -> Result<PolarClient, PolarError> {
    let built = {
        let mut guard = transport.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(client) = guard.client.clone() {
            BuiltClient::Cached(client)
        } else {
            // The factory is synchronous and must not call back into this
            // transport. Failed construction is not cached.
            let client = factory()?;
            guard.client = Some(client.clone());
            guard.creations += 1;
            let announce = guard.announce;
            guard.announce = false;
            if announce {
                BuiltClient::Fresh(client)
            } else {
                BuiltClient::Cached(client)
            }
        }
    };
    match built {
        BuiltClient::Cached(client) => Ok(client),
        BuiltClient::Fresh(client) => {
            let _ = logger
                .log(
                    Level::Info,
                    serde_json::json!({
                        "message": format!("PolarSH client initialized for {caller}"),
                    }),
                    LogOptions {
                        destination: Destination::Console,
                        ..LogOptions::default()
                    },
                )
                .await;
            Ok(client)
        }
    }
}

async fn post_events(
    client: &PolarClient,
    events: &[JsonValue],
) -> Result<ProviderOutcome, String> {
    let body = events_ingest_body(events)?;
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(POLAR_EVENTS_USER_AGENT),
    );
    let result = client
        .request_json_text::<serde_json::Value>(
            Method::POST,
            POLAR_EVENTS_INGEST_PATH,
            Some(&body),
            &headers,
        )
        .await
        .map_err(|error| error.to_string())?;
    if !sdk_ingest_response_valid(&result) {
        return Err("Polar provider returned invalid response".into());
    }
    if !ingest_complete(&result, events.len()) {
        return Ok(ProviderOutcome::Incomplete(result));
    }
    Ok(ProviderOutcome::Complete)
}

fn event_ok() -> PolarEventResponse {
    PolarEventResponse {
        error: false,
        message: None,
        details: None,
    }
}

fn event_error(message: impl Into<String>) -> PolarEventResponse {
    PolarEventResponse {
        error: true,
        message: Some(message.into()),
        details: None,
    }
}

fn from_cache(response: CacheUsageResponse) -> PolarEventResponse {
    PolarEventResponse {
        error: response.error,
        message: response.message,
        details: None,
    }
}

fn channel_log(channel: &JsString) -> Option<&JsString> {
    (!channel.is_empty()).then_some(channel)
}

async fn log_both(logger: &Logger, channel: Option<&JsString>, data: serde_json::Value) {
    let channel_id = channel
        .filter(|value| !value.is_empty())
        .map(|value| value.to_utf8_lossy());
    let _ = logger
        .log(
            Level::Error,
            data,
            LogOptions {
                destination: Destination::Both,
                channel_id,
                ..LogOptions::default()
            },
        )
        .await;
}

fn js_text(value: &JsString) -> JsonValue {
    JsonValue::String(value.clone())
}

fn js_static(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}

/// Splits a Redis list the way the source loop does: skip text that is not
/// JSON, keep every successful `JSON.parse`, and remember the raw length for
/// `LTRIM`.
pub fn classify_pending(raw: &[String]) -> ClassifiedPending {
    let parsed = raw.iter().filter_map(|row| parse_json(row).ok()).collect();
    ClassifiedPending {
        parsed,
        raw_len: raw.len(),
    }
}

/// Serializes `events.ingest` the way `@polar-sh/sdk` 0.42.5 outbound schemas do.
/// The string is sent verbatim so object key order survives.
pub fn events_ingest_body(events: &[JsonValue]) -> Result<String, String> {
    let mut encoded = Vec::with_capacity(events.len());
    for event in events {
        encoded.push(outbound_event(event).map_err(|()| VALIDATION_FAILED.to_owned())?);
    }
    Ok(JsonValue::Object(vec![("events".into(), JsonValue::Array(encoded))]).to_json_string())
}

fn ingest_complete(result: &serde_json::Value, expected: usize) -> bool {
    json_number(result, "inserted") + json_number(result, "duplicates") >= expected as f64
}

fn sdk_ingest_response_valid(result: &serde_json::Value) -> bool {
    fn safe_integer(value: &serde_json::Value) -> bool {
        value.as_f64().is_some_and(|number| {
            number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
        })
    }
    result.is_object()
        && result.get("inserted").is_some_and(safe_integer)
        && result.get("duplicates").is_none_or(safe_integer)
}

fn json_number(value: &serde_json::Value, key: &str) -> f64 {
    match value.get(key) {
        Some(serde_json::Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn outbound_event(value: &JsonValue) -> Result<JsonValue, ()> {
    let JsonValue::Object(fields) = value else {
        return Err(());
    };
    if field(fields, "timestamp").is_some() {
        // The SDK accepts a Date, not a queued JSON timestamp. Reject it
        // before any HTTP so the queue stays intact.
        return Err(());
    }
    let JsonValue::String(name) = field(fields, "name").ok_or(())? else {
        return Err(());
    };
    let organization_id = optional_nullable_string(fields, "organizationId")?;
    let external_id = optional_nullable_string(fields, "externalId")?;
    let parent_id = optional_nullable_string(fields, "parentId")?;
    let metadata = match field(fields, "metadata") {
        None => None,
        Some(value) => Some(outbound_metadata(value)?),
    };
    let customer = id_field(fields, "customerId");
    let external_customer = id_field(fields, "externalCustomerId");
    // Equal field counts keep the first schema, which is the customer variant.
    let use_customer = match (&customer, &external_customer) {
        (IdField::Value(_), _) => true,
        (IdField::Absent | IdField::Invalid, IdField::Value(_)) => false,
        _ => return Err(()),
    };
    let mut out = Vec::new();
    out.push(("name".into(), JsonValue::String(name.clone())));
    push_optional(&mut out, "organization_id", organization_id);
    push_optional(&mut out, "external_id", external_id);
    push_optional(&mut out, "parent_id", parent_id);
    push_optional(&mut out, "metadata", metadata);
    match (use_customer, customer, external_customer) {
        (true, IdField::Value(id), _) => {
            out.push(("customer_id".into(), JsonValue::String(id)));
        }
        (false, _, IdField::Value(id)) => {
            out.push(("external_customer_id".into(), JsonValue::String(id)));
        }
        _ => return Err(()),
    }
    Ok(JsonValue::Object(out))
}

fn outbound_metadata(value: &JsonValue) -> Result<JsonValue, ()> {
    let JsonValue::Object(entries) = value else {
        return Err(());
    };
    let mut out = Vec::with_capacity(entries.len());
    for (key, item) in entries {
        out.push((key.clone(), outbound_metadata_value(item)?));
    }
    Ok(JsonValue::Object(out))
}

fn outbound_metadata_value(value: &JsonValue) -> Result<JsonValue, ()> {
    match value {
        JsonValue::Object(fields) => {
            let llm = try_llm(fields);
            let cost = try_cost(fields);
            match (llm, cost) {
                (Some(llm), Some(cost)) => {
                    if count_fields(&cost) > count_fields(&llm) {
                        Ok(cost)
                    } else {
                        Ok(llm)
                    }
                }
                (Some(llm), None) => Ok(llm),
                (None, Some(cost)) => Ok(cost),
                (None, None) => Err(()),
            }
        }
        JsonValue::String(text) => Ok(JsonValue::String(text.clone())),
        JsonValue::Number(number) if number.is_finite() => Ok(JsonValue::Number(*number)),
        JsonValue::Bool(value) => Ok(JsonValue::Bool(*value)),
        _ => Err(()),
    }
}

fn try_llm(fields: &[(JsString, JsonValue)]) -> Option<JsonValue> {
    let vendor = match field(fields, "vendor")? {
        JsonValue::String(text) => text.clone(),
        _ => return None,
    };
    let model = match field(fields, "model")? {
        JsonValue::String(text) => text.clone(),
        _ => return None,
    };
    let prompt = optional_nullable_string(fields, "prompt").ok()?;
    let response = optional_nullable_string(fields, "response").ok()?;
    let input_tokens = required_int(fields, "inputTokens")?;
    let cached_input_tokens = optional_int(fields, "cachedInputTokens")?;
    let output_tokens = required_int(fields, "outputTokens")?;
    let total_tokens = required_int(fields, "totalTokens")?;
    let mut out = vec![
        ("vendor".into(), JsonValue::String(vendor)),
        ("model".into(), JsonValue::String(model)),
    ];
    push_optional(&mut out, "prompt", prompt);
    push_optional(&mut out, "response", response);
    out.push(("input_tokens".into(), JsonValue::Number(input_tokens)));
    if let Some(cached) = cached_input_tokens {
        out.push(("cached_input_tokens".into(), JsonValue::Number(cached)));
    }
    out.push(("output_tokens".into(), JsonValue::Number(output_tokens)));
    out.push(("total_tokens".into(), JsonValue::Number(total_tokens)));
    Some(JsonValue::Object(out))
}

fn try_cost(fields: &[(JsString, JsonValue)]) -> Option<JsonValue> {
    let amount = match field(fields, "amount")? {
        JsonValue::Number(number) if number.is_finite() => JsonValue::Number(*number),
        JsonValue::String(text) => JsonValue::String(text.clone()),
        _ => return None,
    };
    let JsonValue::String(currency) = field(fields, "currency")? else {
        return None;
    };
    Some(JsonValue::Object(vec![
        ("amount".into(), amount),
        ("currency".into(), JsonValue::String(currency.clone())),
    ]))
}

fn count_fields(value: &JsonValue) -> usize {
    match value {
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => 1,
        JsonValue::Array(items) => items.iter().map(count_fields).sum(),
        JsonValue::Object(fields) => fields.iter().map(|(_, item)| count_fields(item)).sum(),
    }
}

enum IdField {
    Absent,
    Invalid,
    Value(JsString),
}

fn id_field(fields: &[(JsString, JsonValue)], key: &str) -> IdField {
    match field(fields, key) {
        None => IdField::Absent,
        Some(JsonValue::String(text)) => IdField::Value(text.clone()),
        Some(_) => IdField::Invalid,
    }
}

fn optional_nullable_string(
    fields: &[(JsString, JsonValue)],
    key: &str,
) -> Result<Option<JsonValue>, ()> {
    match field(fields, key) {
        None => Ok(None),
        Some(JsonValue::Null) => Ok(Some(JsonValue::Null)),
        Some(JsonValue::String(text)) => Ok(Some(JsonValue::String(text.clone()))),
        Some(_) => Err(()),
    }
}

fn required_int(fields: &[(JsString, JsonValue)], key: &str) -> Option<f64> {
    js_int(field(fields, key)?)
}

fn optional_int(fields: &[(JsString, JsonValue)], key: &str) -> Option<Option<f64>> {
    match field(fields, key) {
        None => Some(None),
        Some(value) => js_int(value).map(Some),
    }
}

fn js_int(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(number) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

fn field<'a>(fields: &'a [(JsString, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    fields
        .iter()
        .find(|(name, _)| name.as_str() == Some(key))
        .map(|(_, value)| value)
}

fn push_optional(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: Option<JsonValue>) {
    if let Some(value) = value {
        fields.push((key.into(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::default_transport;
    use std::sync::Arc;

    #[test]
    fn normal_factories_share_an_idle_process_transport() {
        let first = default_transport();
        let second = default_transport();
        assert!(Arc::ptr_eq(&first, &second));
        let state = first.lock().unwrap();
        assert!(state.client.is_none());
        assert_eq!(state.creations, 0);
    }
}
