//! Concrete `ingestPolarSHEvent` batch mode.
//!
//! The shared [`PolarCacheUsage`] prefix validates, locks, migrates, queues, and
//! projects. This module then flushes the pending list through the installed
//! Polar events ingest contract: `POST /v1/events/ingest`, SDK field order, and
//! `inserted + duplicates >=` the number of parsed events. Immediate mode and
//! credit grants are not implemented. There is no application-level replay of
//! an uncertain Redis mutation or provider call. The HTTP client itself does
//! not retry.
//!
//! A dropped flush does not release the ingest lease. The lock key expires by
//! its TTL, which is the safe cancellation behavior.

use super::{
    js_string::JsString,
    logger::{Destination, Level, LogOptions, Logger},
    lossless_json::{JsonValue, parse_json},
    polar::{PolarClient, PolarConfig, PolarConfigError, PolarError, PolarPolicy},
    polar_cache_usage::{CacheUsageOptions, CacheUsageResponse, IngestLease, PolarCacheUsage},
};
use reqwest::{
    Method,
    header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT},
};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

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
    /// A missing token is not cached, so a later call can succeed.
    pub fn lazy(durable: PolarCacheUsage, logger: Logger) -> Self {
        let factory = || {
            let config = source_polar_config(|name| std::env::var(name).ok()).map_err(|kind| {
                PolarError::Configuration {
                    policy: PolarPolicy::Billing,
                    kind,
                }
            })?;
            PolarClient::new(config, PolarPolicy::Billing)
        };
        Self {
            durable,
            factory: Some(Arc::new(factory)),
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

    /// Batch ingest. Cache-only callers keep using [`PolarCacheUsage::ingest`].
    pub async fn ingest(&self, options: &CacheUsageOptions) -> CacheUsageResponse {
        let queued = self.durable.enqueue_durable(options).await;
        let Some(lease) = queued.lease else {
            return queued.response;
        };
        let response = self.flush(&lease, &options.channel_id).await;
        self.durable.release_lease(&lease).await;
        response
    }

    async fn flush(&self, lease: &IngestLease, channel: &JsString) -> CacheUsageResponse {
        let raw = match self.durable.list_pending(&lease.queue_key).await {
            Ok(raw) => raw,
            Err(error) => return self.fail(channel, error).await,
        };
        if raw.is_empty() {
            return CacheUsageResponse::ok(None);
        }
        let pending = classify_pending(&raw);
        if pending.parsed.is_empty() {
            return match self.durable.delete_queue(&lease.queue_key).await {
                Ok(()) => CacheUsageResponse::ok(None),
                Err(error) => self.fail(channel, error).await,
            };
        }
        // Source acquires the client before SDK validation. A missing token is
        // reported after the durable queue and projection, with the queue intact.
        let client = match self.client().await {
            Ok(client) => client,
            Err(error) => return self.fail(channel, error.to_string()).await,
        };
        let body = match events_ingest_body(&pending.parsed) {
            Ok(body) => body,
            Err(error) => return self.fail(channel, error).await,
        };
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(POLAR_EVENTS_USER_AGENT),
        );
        let result = match client
            .request_json_text(
                Method::POST,
                POLAR_EVENTS_INGEST_PATH,
                Some(&body),
                &headers,
            )
            .await
        {
            Ok(result) => result,
            Err(error) => return self.fail(channel, error.to_string()).await,
        };
        if !sdk_ingest_response_valid(&result) {
            return self
                .fail(channel, "Polar provider returned invalid response")
                .await;
        }
        if !ingest_complete(&result, pending.parsed.len()) {
            self.log(
                channel,
                serde_json::json!({
                    "function": "ingestPolarSHEvent",
                    "error": "PolarSH ingest incomplete",
                    "expected": pending.parsed.len(),
                    "ingestResult": result,
                }),
            )
            .await;
            return CacheUsageResponse::error("PolarSH ingest incomplete");
        }
        match self
            .durable
            .trim_pending(&lease.queue_key, pending.raw_len as i64)
            .await
        {
            Ok(()) => CacheUsageResponse::ok(None),
            Err(error) => self.fail(channel, error).await,
        }
    }

    async fn client(&self) -> Result<PolarClient, PolarError> {
        let factory = self.factory.clone().ok_or(PolarError::Configuration {
            policy: PolarPolicy::Billing,
            kind: PolarConfigError::MissingToken,
        });
        let (created, announce) = {
            let mut guard = self
                .transport
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(client) = &guard.client {
                return Ok(client.clone());
            }
            // Construction is synchronous, so serialize it while holding the
            // mutex without holding a lock across an await. Clones must not
            // create independent pools on concurrent first use.
            let created = (factory?)()?;
            guard.client = Some(created.clone());
            guard.creations += 1;
            let announce = guard.announce;
            guard.announce = false;
            (created, announce)
        };
        if announce {
            let _ = self
                .logger
                .log(
                    Level::Info,
                    serde_json::json!({
                        "message": format!("PolarSH client initialized for {CALLER}"),
                    }),
                    LogOptions {
                        destination: Destination::Console,
                        ..LogOptions::default()
                    },
                )
                .await;
        }
        Ok(created)
    }

    async fn fail(&self, channel: &JsString, message: impl Into<String>) -> CacheUsageResponse {
        let message = message.into();
        self.log(
            channel,
            serde_json::json!({
                "function": "ingestPolarSHEvent",
                "error": message,
            }),
        )
        .await;
        CacheUsageResponse::error(message)
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
