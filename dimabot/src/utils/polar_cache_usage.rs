//! Cache-only branch of `ingestPolarSHEvent`. This does not call Polar HTTP.
//! Construction shares concrete Redis/PostHog handles and performs no IO.
//! Unknown mutation outcomes are never retried at the application layer.
use super::{
    ai_credit_projection::AiCreditProjection,
    ai_usage_lossless::{create_ai_usage_context_json, enrich_polar_usage_metadata_json},
    ai_usage_producer::{AiUsageProducer, build_queued_ai_usage_receipt_json},
    js_string::JsString,
    json_number::number_string,
    logger::{
        Destination, Level, LogOptions, Logger, LoggerConfig, SinkHandles, StdConsole, SystemClock,
        UuidSource, redis::RedisCacheSink,
    },
    lossless_json::{JsonValue, parse_json},
    posthog_tracking::PosthogTracking,
    tts::settings::js_number,
    tts_usage_pricing::js_round,
};
use redis::aio::ConnectionManager;
use std::{sync::Arc, time::Duration};

pub const LOCK_TTL: Duration = Duration::from_millis(8000);
pub const LOCK_WAIT: Duration = Duration::from_millis(2500);
pub const LOCK_POLL: Duration = Duration::from_millis(350);

#[derive(Debug, Clone)]
pub struct LlmUsage {
    pub prompt_tokens: f64,
    pub completion_tokens: f64,
    pub total_tokens: f64,
}
#[derive(Debug, Clone)]
pub struct LlmMetadata {
    pub model: JsString,
    pub usage: LlmUsage,
}
/// Declared TS types; usage is a plain object with declared optional fields.
#[derive(Debug, Clone)]
pub struct CacheUsageOptions {
    pub customer_id: JsString,
    pub channel_id: JsString,
    pub external_id: Option<JsString>,
    pub cost: f64,
    pub reason: JsString,
    pub llm: Option<LlmMetadata>,
    pub polar_cost: Option<f64>,
    pub characters: Option<f64>,
    pub usage: JsonValue,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheUsageResponse {
    pub error: bool,
    pub message: Option<String>,
}
impl CacheUsageResponse {
    fn ok(message: Option<&str>) -> Self {
        Self {
            error: false,
            message: message.map(str::to_owned),
        }
    }
    fn error(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
        }
    }
}
#[derive(Debug, Clone)]
pub struct PreparedCacheEvent {
    pub context: JsonValue,
    pub external_id: JsString,
    pub credits: f64,
    pub wire: String,
    pub polar_cost_amount: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
}
fn parse_float_prefix(s: &str) -> f64 {
    for end in (1..=s.len()).rev() {
        if let Ok(value) = s[..end].parse::<f64>() {
            return value;
        }
    }
    f64::NAN
}
fn rounded_truncated(cost: f64, scale: f64, limit: usize) -> f64 {
    let n = js_round(cost * 100.0 * scale) / scale;
    let text = number_string(n);
    if text.len() > limit {
        parse_float_prefix(&text[..limit])
    } else {
        n
    }
}
fn field(key: &str, value: JsonValue) -> (JsString, JsonValue) {
    (key.into(), value)
}
fn string(s: &str) -> JsonValue {
    JsonValue::String(s.into())
}
fn number(n: f64) -> JsonValue {
    JsonValue::Number(n)
}
fn text(s: &JsString) -> JsonValue {
    JsonValue::String(s.clone())
}
fn set(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: JsonValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k.as_str() == Some(key)) {
        *old = value;
    } else {
        fields.push(field(key, value));
    }
}
fn nonempty_string(v: Option<&JsonValue>) -> bool {
    matches!(v,Some(JsonValue::String(s)) if !s.is_empty())
}
fn nullable(v: Option<&JsonValue>) -> bool {
    matches!(v, None | Some(JsonValue::Null))
}
/// Creates the event without IO. Errors cover invalid declared context input.
pub fn prepare_event(options: &CacheUsageOptions) -> Result<PreparedCacheEvent, String> {
    let JsonValue::Object(mut input) = options.usage.clone() else {
        return Err("usage must be an object".into());
    };
    if let Some(id) = options.external_id.as_ref().filter(|id| !id.is_empty()) {
        set(&mut input, "entryId", text(id));
    }
    let get = |fields: &Vec<(JsString, JsonValue)>, key: &str| {
        fields
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v.clone())
    };
    if !nonempty_string(get(&input, "channelID").as_ref()) {
        set(&mut input, "channelID", text(&options.channel_id));
    }
    if !nonempty_string(get(&input, "model").as_ref())
        && let Some(llm) = &options.llm
    {
        set(&mut input, "model", text(&llm.model));
    }
    if nullable(get(&input, "quantity").as_ref())
        && let Some(n) = options
            .characters
            .or_else(|| options.llm.as_ref().map(|x| x.usage.total_tokens))
    {
        set(&mut input, "quantity", number(n));
    }
    if nullable(get(&input, "unit").as_ref()) {
        if options.characters.is_some() {
            set(&mut input, "unit", string("characters"));
        } else if options.llm.is_some() {
            set(&mut input, "unit", string("tokens"));
        }
    }
    let context = create_ai_usage_context_json(&options.reason, &JsonValue::Object(input))
        .map_err(|e| e.to_string())?;
    let Some(JsonValue::String(external_id)) = context.get("entryId") else {
        return Err("context missing entryId".into());
    };
    let external_id = external_id.clone();
    let mut polar_cost_amount = None;
    let mut tokens = None;
    let (cost, credits, mut accounting) = if let Some(llm) = &options.llm {
        let amount = rounded_truncated(options.cost, 1e10, 17);
        let cost = rounded_truncated(options.cost, 1e8, 12);
        let units = llm.model.units();
        let slash = units.iter().position(|c| *c == b'/' as u16);
        let first = slash.unwrap_or(units.len());
        let vendor = if first == 0 {
            JsString::from("unknown")
        } else {
            JsString::from_units(units[..first].to_vec())
        };
        let second = slash
            .map(|i| i + 1)
            .filter(|i| *i < units.len() && units[*i] != b'/' as u16);
        let selected = if let Some(second) = second {
            let end = units[second..]
                .iter()
                .position(|c| *c == b'/' as u16)
                .map_or(units.len(), |i| second + i);
            &units[second..end]
        } else {
            &units[..]
        };
        let colon = selected
            .iter()
            .position(|c| *c == b':' as u16)
            .unwrap_or(selected.len());
        let model = if units.is_empty() {
            JsString::from("unknown")
        } else {
            JsString::from_units(selected[..colon].to_vec())
        };
        let nonzero = |n: f64| if n == 0.0 || n.is_nan() { 0.0 } else { n };
        let (a, b, c) = (
            nonzero(llm.usage.prompt_tokens),
            nonzero(llm.usage.completion_tokens),
            nonzero(llm.usage.total_tokens),
        );
        polar_cost_amount = Some(amount);
        tokens = Some((a, b, c));
        let credits = (cost * 1000.0).ceil();
        (
            cost,
            credits,
            vec![
                field(
                    "_cost",
                    JsonValue::Object(vec![
                        field("amount", number(amount)),
                        field("currency", string("usd")),
                    ]),
                ),
                field(
                    "_llm",
                    JsonValue::Object(vec![
                        field("vendor", text(&vendor)),
                        field("model", text(&model)),
                        field("inputTokens", number(a)),
                        field("outputTokens", number(b)),
                        field("totalTokens", number(c)),
                    ]),
                ),
            ],
        )
    } else if let Some(amount) = options.polar_cost {
        polar_cost_amount = Some(amount);
        (
            options.cost,
            (amount * 1000.0).ceil(),
            vec![field(
                "_cost",
                JsonValue::Object(vec![
                    field("amount", number(amount)),
                    field("currency", string("usd")),
                ]),
            )],
        )
    } else {
        (options.cost, (options.cost * 1000.0).ceil(), vec![])
    };
    accounting.push(field("cost", number(cost)));
    if options.llm.is_none() && options.polar_cost.is_none() {
        accounting.push(field("currency", string("usd")));
    }
    accounting.push(field("credits", number(credits)));
    if options.llm.is_some() || options.polar_cost.is_some() {
        accounting.push(field("currency", string("usd")));
    }
    accounting.push(field("reason", text(&options.reason)));
    if options.llm.is_none()
        && options.polar_cost.is_some()
        && let Some(n) = options.characters
    {
        accounting.push(field("characters", number(n)));
    }
    let metadata = enrich_polar_usage_metadata_json(&JsonValue::Object(accounting), &context)
        .map_err(|e| e.to_string())?;
    let wire = JsonValue::Object(vec![
        field("name", string("ai_usage")),
        field("customerId", text(&options.customer_id)),
        field("externalId", text(&external_id)),
        field("metadata", metadata),
    ])
    .to_json_string();
    Ok(PreparedCacheEvent {
        context,
        external_id,
        credits,
        wire,
        polar_cost_amount,
        input_tokens: tokens.map(|x| x.0),
        output_tokens: tokens.map(|x| x.1),
        total_tokens: tokens.map(|x| x.2),
    })
}

#[derive(Clone)]
pub struct PolarCacheUsage {
    cache: ConnectionManager,
    projection: AiCreditProjection,
    producer: AiUsageProducer,
    posthog: Option<PosthogTracking>,
    logger: Logger,
}
impl PolarCacheUsage {
    pub fn new(
        cache: ConnectionManager,
        projection: AiCreditProjection,
        producer: AiUsageProducer,
        posthog: PosthogTracking,
    ) -> Self {
        let logger = default_logger(cache.clone());
        Self::with_logger(cache, projection, producer, posthog, logger)
    }
    /// Supply the application's long-lived concrete logger and sinks.
    pub fn with_logger(
        cache: ConnectionManager,
        projection: AiCreditProjection,
        producer: AiUsageProducer,
        posthog: PosthogTracking,
        logger: Logger,
    ) -> Self {
        Self {
            cache,
            projection,
            producer,
            posthog: Some(posthog),
            logger,
        }
    }
    async fn diagnostic(
        &self,
        channel: &JsString,
        function: &str,
        message: &str,
        detail: Option<&str>,
    ) {
        diagnostic(&self.logger, channel, function, message, detail).await;
    }
    pub async fn ingest(&self, options: &CacheUsageOptions) -> CacheUsageResponse {
        if options.customer_id.is_empty() {
            return CacheUsageResponse::error("customerId is required");
        }
        if options.channel_id.is_empty() {
            return CacheUsageResponse::error("channelID is required for batch/cache modes");
        }
        let event = match prepare_event(options) {
            Ok(event) => event,
            Err(e) => {
                self.diagnostic(&options.channel_id, "ingestPolarSHEvent", &e, None)
                    .await;
                return CacheUsageResponse::error(e);
            }
        };
        let lock_key = format!("locks:polar-ingest:{}", options.channel_id.to_utf8_lossy());
        let key = format!(
            "twitch:{}:ai:polarshevent",
            options.channel_id.to_utf8_lossy()
        );
        let owner = uuid::Uuid::new_v4().to_string();
        let mut cache = self.cache.clone();
        let deadline = tokio::time::Instant::now() + LOCK_WAIT;
        let acquired = loop {
            let result: redis::RedisResult<Option<String>> = redis::cmd("SET")
                .arg(&lock_key)
                .arg(&owner)
                .arg("NX")
                .arg("PX")
                .arg(LOCK_TTL.as_millis() as u64)
                .query_async(&mut cache)
                .await;
            match result {
                Err(e) => {
                    let message = e.to_string();
                    self.diagnostic(&options.channel_id, "ingestPolarSHEvent", &message, None)
                        .await;
                    return CacheUsageResponse::error(message);
                }
                Ok(Some(v)) if v == "OK" => break true,
                _ => {}
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break false;
            }
            tokio::time::sleep(remaining.min(LOCK_POLL)).await;
            if tokio::time::Instant::now() >= deadline {
                break false;
            }
        };
        let result = self
            .queue_and_project(&mut cache, &key, options, &event)
            .await;
        if acquired {
            // Accepted migration improvement: owner-fenced atomic release.
            // A lost EVAL reply is unknown and is never replayed here.
            let _ = redis::cmd("EVAL")
                .arg(super::ai_usage_lock::RELEASE_SCRIPT)
                .arg(1)
                .arg(&lock_key)
                .arg(&owner)
                .query_async::<i64>(&mut cache)
                .await;
        }
        match result {
            Ok(()) => CacheUsageResponse::ok(if acquired {
                None
            } else {
                Some("queued (flush in progress)")
            }),
            Err(e) if !acquired => {
                self.diagnostic(
                    &options.channel_id,
                    "ingestPolarSHEvent",
                    "Failed to queue AI event while flush in progress",
                    Some(&e),
                )
                .await;
                CacheUsageResponse::error("Failed to queue AI event")
            }
            Err(e) => {
                self.diagnostic(&options.channel_id, "ingestPolarSHEvent", &e, None)
                    .await;
                CacheUsageResponse::error(e)
            }
        }
    }
    async fn queue_and_project(
        &self,
        cache: &mut ConnectionManager,
        key: &str,
        options: &CacheUsageOptions,
        event: &PreparedCacheEvent,
    ) -> Result<(), String> {
        let kind: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(cache)
            .await
            .map_err(|e: redis::RedisError| e.to_string())?;
        if kind == "string" {
            let raw: Option<String> = redis::cmd("GET")
                .arg(key)
                .query_async(cache)
                .await
                .map_err(|e: redis::RedisError| e.to_string())?;
            let parsed = raw
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|s| parse_json(s).ok())
                .unwrap_or(JsonValue::Array(vec![]));
            // `.length` is evaluated after DEL; an invalid array-like value with
            // positive length subsequently fails at `.map` in the source.
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(cache)
                .await
                .map_err(|e| e.to_string())?;
            match parsed {
                JsonValue::Array(items) if !items.is_empty() => {
                    let wires: Vec<_> = items.iter().map(JsonValue::to_json_string).collect();
                    redis::cmd("RPUSH")
                        .arg(key)
                        .arg(wires)
                        .query_async::<i64>(cache)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                JsonValue::Null => {
                    return Err("Cannot read properties of null (reading 'length')".into());
                }
                JsonValue::String(s) if !s.is_empty() => {
                    return Err("legacy.map is not a function".into());
                }
                JsonValue::Object(ref fields) => {
                    let length = fields
                        .iter()
                        .find(|(key, _)| key.as_str() == Some("length"))
                        .map(|(_, value)| value);
                    let length = js_number(length).map_err(|e| e.to_string())?;
                    if length > 0.0 {
                        return Err("legacy.map is not a function".into());
                    }
                }
                _ => {}
            }
        }
        redis::cmd("RPUSH")
            .arg(key)
            .arg(&event.wire)
            .query_async::<i64>(cache)
            .await
            .map_err(|e| e.to_string())?;
        self.projection
            .record_ai_credit_usage(&options.channel_id, event.credits, Some(&event.external_id))
            .await;
        let receipt = build_queued_ai_usage_receipt_json(
            options.channel_id.clone(),
            options.customer_id.clone(),
            None,
            &event.context,
            event.credits,
        );
        if let Err(e) = self.producer.enqueue(receipt.as_ref()).await {
            self.diagnostic(
                &options.channel_id,
                "projectAcceptedUsage",
                &e.to_string(),
                None,
            )
            .await;
        }
        let tracking = match &self.posthog {
            Some(p) => Some(p),
            None => super::posthog_tracking::get_posthog_tracking().await.ok(),
        };
        if let Some(tracking) = tracking {
            let mut fields = vec![
                field("context", event.context.clone()),
                field("credits", number(event.credits)),
                field("reason", text(&options.reason)),
            ];
            for (key, value) in [
                ("polarCostAmount", event.polar_cost_amount),
                ("inputTokens", event.input_tokens),
                ("outputTokens", event.output_tokens),
                ("totalTokens", event.total_tokens),
            ] {
                if let Some(n) = value {
                    fields.push(field(key, number(n)));
                }
            }
            let _ = tracking.track_ai_usage_recorded(&JsonValue::Object(fields));
        }
        Ok(())
    }
}
async fn diagnostic(
    logger: &Logger,
    channel: &JsString,
    function: &str,
    message: &str,
    detail: Option<&str>,
) {
    let mut data = serde_json::Map::new();
    data.insert("function".into(), function.into());
    data.insert("error".into(), message.into());
    if let Some(detail) = detail {
        data.insert("err".into(), detail.into());
    }
    let _ = logger
        .log(
            Level::Error,
            serde_json::Value::Object(data),
            LogOptions {
                destination: Destination::Both,
                channel_id: Some(channel.to_utf8_lossy()),
                ..LogOptions::default()
            },
        )
        .await;
}
fn console_logger() -> Logger {
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            console: Some(Arc::new(StdConsole)),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("default logger limits")
}
fn default_logger(cache: ConnectionManager) -> Logger {
    let sink =
        RedisCacheSink::new(cache, Duration::from_secs(2)).expect("fixed nonzero logger timeout");
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
/// Lazy default acquisition only after validation; cache mode has no Polar client.
pub async fn ingest_polar_cache_usage(
    options: &CacheUsageOptions,
    deadline: Duration,
) -> CacheUsageResponse {
    if options.customer_id.is_empty() {
        return CacheUsageResponse::error("customerId is required");
    }
    if options.channel_id.is_empty() {
        return CacheUsageResponse::error("channelID is required for batch/cache modes");
    }
    let cache = match super::redis::get_redis_client().await {
        Ok(c) => c,
        Err(e) => {
            let message = e.to_string();
            diagnostic(
                &console_logger(),
                &options.channel_id,
                "ingestPolarSHEvent",
                &message,
                None,
            )
            .await;
            return CacheUsageResponse::error(message);
        }
    };
    let logger = default_logger(cache.clone());
    let adapter = PolarCacheUsage {
        projection: AiCreditProjection::new(cache.clone(), deadline),
        producer: AiUsageProducer::new(cache.clone()),
        cache,
        posthog: None,
        logger,
    };
    adapter.ingest(options).await
}
