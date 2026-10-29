//! Application payloads for all six `posthog_events.ts` exports.
//!
//! The plain-value builders accept owned JSON values (including arbitrary UTF-16
//! strings and binary64 numbers). Required properties must be present (except
//! the userID/username fallback fields); distinct
//! IDs and template-literal components must be strings. Other property values
//! pass through verbatim, including out-of-declaration JSON casts. Undefined is
//! represented by absence: required undefined is outside this contract. Optional
//! absence/null becomes null; user identity uses JavaScript falsiness. No context
//! normalization, date policy, pricing, or number formatting is duplicated here.
//!
//! Native callers can use `NativeUsageRecorded` with an existing AiUsageContext.
//! Conversion visits fields directly, retaining raw numeric bits until the wire
//! boundary. SDK compatibility explicitly rejects unpaired UTF-16; the default
//! concrete lossless backend preserves it. Capture success means enqueue only.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use posthog_rs::{Client, Event};
use serde_json::Value;
use tokio::sync::OnceCell;

use super::{
    ai_usage::{AI_USAGE_SCHEMA_VERSION, AiUsageContext},
    js_string::JsString,
    lossless_json::JsonValue,
    posthog::{FLUSH_AT, FLUSH_INTERVAL_MS, POSTHOG_HOST, POSTHOG_PROJECT_KEY, StreamerIdentities},
    posthog_lossless::{PosthogLosslessConfig, PosthogLosslessTransport},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    InvalidInput(&'static str),
    UnrepresentableUtf16,
    Transport(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedEvent {
    pub event: &'static str,
    pub distinct_id: JsString,
    pub properties: JsonValue,
}

fn key(s: &'static str) -> JsString {
    JsString::from_static(s)
}
fn text(s: &str) -> JsonValue {
    JsonValue::String(JsString::from(s))
}
fn static_text(s: &'static str) -> JsonValue {
    JsonValue::String(JsString::from_static(s))
}
fn required<'a>(v: &'a JsonValue, name: &'static str) -> Result<&'a JsonValue, CaptureError> {
    v.get(name).ok_or(CaptureError::InvalidInput(name))
}
fn required_string(v: &JsonValue, name: &'static str) -> Result<JsString, CaptureError> {
    match required(v, name)? {
        JsonValue::String(s) => Ok(s.clone()),
        _ => Err(CaptureError::InvalidInput(name)),
    }
}
fn optional(v: &JsonValue, name: &str) -> JsonValue {
    v.get(name).cloned().unwrap_or(JsonValue::Null)
}
fn field(v: &JsonValue, name: &'static str) -> Result<JsonValue, CaptureError> {
    Ok(required(v, name)?.clone())
}
fn falsy(v: &JsonValue) -> bool {
    match v {
        JsonValue::Null => true,
        JsonValue::Bool(b) => !b,
        JsonValue::Number(n) => *n == 0.0 || n.is_nan(),
        JsonValue::String(s) => s.is_empty(),
        _ => false,
    }
}
fn fallback(v: &JsonValue, name: &str, other: &str) -> JsonValue {
    match v.get(name) {
        Some(value) if !falsy(value) => value.clone(),
        _ => optional(v, other),
    }
}
fn object(fields: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (key(k), v)).collect())
}

pub fn command(p: &JsonValue) -> Result<PreparedEvent, CaptureError> {
    Ok(PreparedEvent {
        event: "command_executed",
        distinct_id: required_string(p, "channelID")?,
        properties: object([
            ("channel_id", field(p, "channelID")?),
            ("channel_name", field(p, "channelName")?),
            ("command", field(p, "command")?),
            ("status", field(p, "status")?),
            ("user_id", fallback(p, "userID", "channelID")),
            ("username", fallback(p, "username", "channelName")),
            ("arguments", optional(p, "arguments")),
            ("error_message", optional(p, "errorMessage")),
        ]),
    })
}

pub fn tts(p: &JsonValue) -> Result<PreparedEvent, CaptureError> {
    Ok(PreparedEvent {
        event: "tts_executed",
        distinct_id: required_string(p, "channelID")?,
        properties: object([
            ("channel_id", field(p, "channelID")?),
            ("channel_name", field(p, "channelName")?),
            ("source", field(p, "source")?),
            ("tts_type", field(p, "ttsType")?),
            ("characters", field(p, "characters")?),
            ("message", field(p, "message")?),
            ("status", field(p, "status")?),
            ("mode", optional(p, "mode")),
            ("provider", optional(p, "provider")),
            ("user_id", fallback(p, "userID", "channelID")),
            ("username", fallback(p, "username", "channelName")),
            ("error_message", optional(p, "errorMessage")),
        ]),
    })
}

pub fn ai_usage_recorded(p: &JsonValue) -> Result<PreparedEvent, CaptureError> {
    let c = required(p, "context")?;
    if !matches!(c, JsonValue::Object(_)) {
        return Err(CaptureError::InvalidInput("context"));
    }
    prepare_usage_recorded(&PlainUsageRecorded {
        context: c,
        params: p,
    })
}

// Only field access differs between the two public usage builders. The final
// mapping and its evaluation/error order stay in one assembler. Native access
// constructs final values directly instead of cloning them through two owned
// intermediate JSON objects.
trait UsageRecordedSource {
    fn context_value(&self, name: &'static str) -> Option<JsonValue>;
    fn parameter_value(&self, name: &'static str) -> Option<JsonValue>;
}
struct PlainUsageRecorded<'a> {
    context: &'a JsonValue,
    params: &'a JsonValue,
}
impl UsageRecordedSource for PlainUsageRecorded<'_> {
    fn context_value(&self, name: &'static str) -> Option<JsonValue> {
        self.context.get(name).cloned()
    }
    fn parameter_value(&self, name: &'static str) -> Option<JsonValue> {
        self.params.get(name).cloned()
    }
}

fn prepare_usage_recorded(
    source: &impl UsageRecordedSource,
) -> Result<PreparedEvent, CaptureError> {
    let context = |name| {
        source
            .context_value(name)
            .ok_or(CaptureError::InvalidInput(name))
    };
    let parameter = |name| {
        source
            .parameter_value(name)
            .ok_or(CaptureError::InvalidInput(name))
    };
    let optional_context = |name| source.context_value(name).unwrap_or(JsonValue::Null);
    let optional_parameter = |name| source.parameter_value(name).unwrap_or(JsonValue::Null);
    let channel = optional_context("channelID");
    let distinct_id = if falsy(&channel) {
        let JsonValue::String(request_id) = context("requestId")? else {
            return Err(CaptureError::InvalidInput("requestId"));
        };
        let mut units: Vec<u16> = "billing:".encode_utf16().collect();
        units.extend(request_id.code_units());
        JsString::from_units(units)
    } else {
        let JsonValue::String(channel) = &channel else {
            return Err(CaptureError::InvalidInput("channelID"));
        };
        channel.clone()
    };
    Ok(PreparedEvent {
        event: "ai_usage_recorded",
        distinct_id,
        properties: object([
            ("$insert_id", context("entryId")?),
            ("schema_version", context("schemaVersion")?),
            ("pricing_version", context("pricingVersion")?),
            ("entry_id", context("entryId")?),
            ("request_id", context("requestId")?),
            ("parent_request_id", optional_context("parentRequestId")),
            ("entry_kind", context("entryKind")?),
            ("category", context("category")?),
            ("operation", context("operation")?),
            ("source", context("source")?),
            ("provider", context("provider")?),
            ("model", optional_context("model")),
            ("channel_id", channel),
            ("credits", parameter("credits")?),
            ("reason", parameter("reason")?),
            ("polar_cost_amount", optional_parameter("polarCostAmount")),
            ("quantity", optional_context("quantity")),
            ("unit", optional_context("unit")),
            ("resource_type", optional_context("resourceType")),
            ("resource_id", optional_context("resourceId")),
            ("input_tokens", optional_parameter("inputTokens")),
            ("output_tokens", optional_parameter("outputTokens")),
            ("total_tokens", optional_parameter("totalTokens")),
        ]),
    })
}

/// Direct native DTO conversion; optional absence stays absent. In particular,
/// this does not serialize quantities through JSON (which loses -0/nonfinite).
pub fn native_context(c: &AiUsageContext) -> Result<JsonValue, CaptureError> {
    let mut fields = vec![
        (
            "schemaVersion",
            JsonValue::Number(f64::from(c.schema_version)),
        ),
        ("pricingVersion", text(&c.pricing_version)),
        ("entryId", text(&c.entry_id)),
        ("requestId", text(&c.request_id)),
        ("entryKind", static_text(c.entry_kind.as_str())),
        ("category", static_text(c.category.as_str())),
        ("operation", text(&c.operation)),
        ("source", text(&c.source)),
        ("provider", text(&c.provider)),
    ];
    for (name, value) in [
        ("parentRequestId", c.parent_request_id.as_deref()),
        ("model", c.model.as_deref()),
        ("channelID", c.channel_id.as_deref()),
        ("resourceId", c.resource_id.as_deref()),
        ("unit", c.unit.map(|v| v.as_str())),
        ("resourceType", c.resource_type.map(|v| v.as_str())),
    ] {
        if let Some(value) = value {
            fields.push((name, text(value)));
        }
    }
    if let Some(value) = c.quantity {
        fields.push(("quantity", JsonValue::Number(value)));
    }
    Ok(object(fields))
}

/// Native typed contract: strings are Unicode scalar text; numeric fields are
/// binary64, including -0/NaN/infinity. The source wrapper performs no rounding.
pub struct NativeUsageRecorded<'a> {
    pub context: &'a AiUsageContext,
    pub credits: f64,
    pub reason: &'a str,
    pub polar_cost_amount: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
}
impl NativeUsageRecorded<'_> {
    pub fn prepare(&self) -> Result<PreparedEvent, CaptureError> {
        prepare_usage_recorded(self)
    }
}
impl UsageRecordedSource for NativeUsageRecorded<'_> {
    // Each assembler call supplies a literal name, allowing direct DTO field
    // access after inlining rather than constructing an owned context object.
    #[inline]
    fn context_value(&self, name: &'static str) -> Option<JsonValue> {
        let c = self.context;
        match name {
            "schemaVersion" => Some(JsonValue::Number(f64::from(c.schema_version))),
            "pricingVersion" => Some(text(&c.pricing_version)),
            "entryId" => Some(text(&c.entry_id)),
            "requestId" => Some(text(&c.request_id)),
            "parentRequestId" => c.parent_request_id.as_deref().map(text),
            "entryKind" => Some(static_text(c.entry_kind.as_str())),
            "category" => Some(static_text(c.category.as_str())),
            "operation" => Some(text(&c.operation)),
            "source" => Some(text(&c.source)),
            "provider" => Some(text(&c.provider)),
            "model" => c.model.as_deref().map(text),
            "channelID" => c.channel_id.as_deref().map(text),
            "quantity" => c.quantity.map(JsonValue::Number),
            "unit" => c.unit.map(|v| static_text(v.as_str())),
            "resourceType" => c.resource_type.map(|v| static_text(v.as_str())),
            "resourceId" => c.resource_id.as_deref().map(text),
            _ => None,
        }
    }
    #[inline]
    fn parameter_value(&self, name: &'static str) -> Option<JsonValue> {
        match name {
            "credits" => Some(JsonValue::Number(self.credits)),
            "reason" => Some(text(self.reason)),
            "polarCostAmount" => self.polar_cost_amount.map(JsonValue::Number),
            "inputTokens" => self.input_tokens.map(JsonValue::Number),
            "outputTokens" => self.output_tokens.map(JsonValue::Number),
            "totalTokens" => self.total_tokens.map(JsonValue::Number),
            _ => None,
        }
    }
}

pub fn ai_operation(p: &JsonValue) -> Result<PreparedEvent, CaptureError> {
    let mut insert = Vec::new();
    for (i, name) in ["requestId", "operation", "lifecycle"].iter().enumerate() {
        if i != 0 {
            insert.push(b':' as u16);
        }
        insert.extend(required_string(p, name)?.code_units());
    }
    Ok(PreparedEvent {
        event: "ai_operation",
        distinct_id: required_string(p, "channelID")?,
        properties: object([
            (
                "$insert_id",
                JsonValue::String(JsString::from_units(insert)),
            ),
            (
                "schema_version",
                JsonValue::Number(f64::from(AI_USAGE_SCHEMA_VERSION)),
            ),
            ("request_id", field(p, "requestId")?),
            ("channel_id", field(p, "channelID")?),
            ("category", field(p, "category")?),
            ("operation", field(p, "operation")?),
            ("source", field(p, "source")?),
            ("lifecycle", field(p, "lifecycle")?),
            ("requested_provider", optional(p, "requestedProvider")),
            ("actual_provider", optional(p, "actualProvider")),
            ("fallback_reason", optional(p, "fallbackReason")),
            ("error_code", optional(p, "errorCode")),
            ("resource_type", optional(p, "resourceType")),
            ("resource_id", optional(p, "resourceId")),
            ("latency_ms", optional(p, "latencyMs")),
        ]),
    })
}

/// Source process identity state, independent of SDK string representability.
/// Updates before enqueue just as the source updates its Map before identify.
#[derive(Default)]
pub struct StreamerIdentityState(Mutex<HashMap<JsString, JsString>>);
impl StreamerIdentityState {
    pub fn identify(&self, id: &JsString, name: &JsString) -> Option<PreparedEvent> {
        if id.is_empty() || name.is_empty() {
            return None;
        }
        let mut seen = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if seen.get(id) == Some(name) {
            return None;
        }
        seen.insert(id.clone(), name.clone());
        Some(PreparedEvent {
            event: "$identify",
            distinct_id: id.clone(),
            properties: object([
                (
                    "$set",
                    object([("channel_name", JsonValue::String(name.clone()))]),
                ),
                ("$set_once", object([])),
            ]),
        })
    }
}

/// Walk representable values directly into SDK values, without stringify/parse.
/// JSON wire semantics normalize -0 to 0 and nonfinite numbers to null.
pub fn sdk_value(v: &JsonValue) -> Result<Value, CaptureError> {
    Ok(match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(v) => Value::Bool(*v),
        JsonValue::Number(n) => {
            if *n == 0.0 {
                Value::from(0)
            } else {
                serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number)
            }
        }
        JsonValue::String(s) => Value::String(
            s.as_str()
                .ok_or(CaptureError::UnrepresentableUtf16)?
                .to_owned(),
        ),
        JsonValue::Array(items) => {
            Value::Array(items.iter().map(sdk_value).collect::<Result<_, _>>()?)
        }
        JsonValue::Object(items) => Value::Object(
            items
                .iter()
                .map(|(k, v)| {
                    Ok((
                        k.as_str()
                            .ok_or(CaptureError::UnrepresentableUtf16)?
                            .to_owned(),
                        sdk_value(v)?,
                    ))
                })
                .collect::<Result<_, CaptureError>>()?,
        ),
    })
}

pub fn sdk_event(p: &PreparedEvent) -> Result<Event, CaptureError> {
    let id = p
        .distinct_id
        .as_str()
        .ok_or(CaptureError::UnrepresentableUtf16)?;
    let JsonValue::Object(properties) = &p.properties else {
        return Err(CaptureError::InvalidInput("properties"));
    };
    let mut event = Event::new(p.event, id);
    for (name, value) in properties {
        event
            .insert_prop(
                name.as_str().ok_or(CaptureError::UnrepresentableUtf16)?,
                sdk_value(value)?,
            )
            .map_err(|_| CaptureError::InvalidInput("properties"))?;
    }
    Ok(event)
}

enum Backend {
    Sdk {
        client: Box<Client>,
        identities: StreamerIdentities,
    },
    Lossless {
        transport: PosthogLosslessTransport,
        identities: StreamerIdentityState,
    },
}

/// Clones share the concrete backend, queue, shutdown state and identity map.
#[derive(Clone)]
pub struct PosthogTracking {
    backend: Arc<Backend>,
}
impl PosthogTracking {
    pub fn new(client: Client) -> Self {
        Self {
            backend: Arc::new(Backend::Sdk {
                client: Box::new(client),
                identities: StreamerIdentities::default(),
            }),
        }
    }
    pub fn with_lossless_transport(transport: PosthogLosslessTransport) -> Self {
        Self {
            backend: Arc::new(Backend::Lossless {
                transport,
                identities: StreamerIdentityState::default(),
            }),
        }
    }
    pub fn from_lossless_config(config: PosthogLosslessConfig) -> Result<Self, CaptureError> {
        PosthogLosslessTransport::new(config)
            .map(Self::with_lossless_transport)
            .map_err(|e| CaptureError::Transport(e.to_string()))
    }
    pub fn identify_streamer(&self, id: &JsString, name: &JsString) -> Result<(), CaptureError> {
        if id.is_empty() || name.is_empty() {
            return Ok(());
        }
        match self.backend.as_ref() {
            Backend::Sdk { client, identities } => {
                let id = id.as_str().ok_or(CaptureError::UnrepresentableUtf16)?;
                let name = name.as_str().ok_or(CaptureError::UnrepresentableUtf16)?;
                if let Some(event) = identities.identify(id, name) {
                    client.capture(event);
                }
            }
            Backend::Lossless { identities, .. } => {
                if let Some(event) = identities.identify(id, name) {
                    self.capture(event)?;
                }
            }
        }
        Ok(())
    }
    pub fn capture(&self, p: PreparedEvent) -> Result<(), CaptureError> {
        match self.backend.as_ref() {
            Backend::Sdk { client, .. } => {
                client.capture(sdk_event(&p)?);
                Ok(())
            }
            Backend::Lossless { transport, .. } => transport
                .capture(p.event, &p.distinct_id, &p.properties)
                .map_err(|e| CaptureError::Transport(e.to_string())),
        }
    }
    pub fn track_command(&self, p: &JsonValue) -> Result<(), CaptureError> {
        self.capture(command(p)?)
    }
    pub fn track_tts(&self, p: &JsonValue) -> Result<(), CaptureError> {
        self.capture(tts(p)?)
    }
    pub fn track_ai_usage_recorded(&self, p: &JsonValue) -> Result<(), CaptureError> {
        self.capture(ai_usage_recorded(p)?)
    }
    pub fn track_native_ai_usage_recorded(
        &self,
        p: &NativeUsageRecorded<'_>,
    ) -> Result<(), CaptureError> {
        self.capture(p.prepare()?)
    }
    pub fn track_ai_operation(&self, p: &JsonValue) -> Result<(), CaptureError> {
        self.capture(ai_operation(p)?)
    }
    pub async fn flush(&self) -> Result<(), CaptureError> {
        match self.backend.as_ref() {
            Backend::Sdk { client, .. } => {
                client.flush().await;
                Ok(())
            }
            Backend::Lossless { transport, .. } => transport
                .flush()
                .await
                .map_err(|e| CaptureError::Transport(e.to_string())),
        }
    }
    pub async fn shutdown_posthog(&self) -> Result<(), CaptureError> {
        match self.backend.as_ref() {
            Backend::Sdk { client, .. } => {
                client.shutdown().await;
                Ok(())
            }
            Backend::Lossless { transport, .. } => transport
                .shutdown()
                .await
                .map_err(|e| CaptureError::Transport(e.to_string())),
        }
    }
}

/// Configuration inspection is inert: it creates no client, task or connection.
pub fn default_config() -> PosthogLosslessConfig {
    let mut config =
        PosthogLosslessConfig::new(POSTHOG_PROJECT_KEY, format!("{POSTHOG_HOST}/batch/"));
    config.flush_at = FLUSH_AT;
    config.flush_interval = Duration::from_millis(FLUSH_INTERVAL_MS);
    config
}

/// Configurable lazy concrete factory for fixture/local consumers. Acquisition
/// requires the application's long-lived Tokio runtime; do not reuse after its
/// runtime or the shared transport has shut down. Failed init remains retryable.
pub struct PosthogTrackingRuntime {
    config: PosthogLosslessConfig,
    instance: OnceCell<PosthogTracking>,
}
impl PosthogTrackingRuntime {
    pub const fn new(config: PosthogLosslessConfig) -> Self {
        Self {
            config,
            instance: OnceCell::const_new(),
        }
    }
    pub async fn get(&self) -> Result<&PosthogTracking, CaptureError> {
        self.instance
            .get_or_try_init(|| async {
                let c = &self.config;
                // Do not require the separately owned configuration DTO to be Clone.
                let mut config = PosthogLosslessConfig::new(c.api_key.clone(), c.endpoint.clone());
                config.flush_at = c.flush_at;
                config.flush_interval = c.flush_interval;
                config.max_batch_size = c.max_batch_size;
                config.max_queue_size = c.max_queue_size;
                config.request_timeout = c.request_timeout;
                config.shutdown_timeout = c.shutdown_timeout;
                PosthogTracking::from_lossless_config(config)
            })
            .await
    }
}
static DEFAULT: OnceCell<PosthogTrackingRuntime> = OnceCell::const_new();
pub async fn get_posthog_tracking() -> Result<&'static PosthogTracking, CaptureError> {
    DEFAULT
        .get_or_init(|| async { PosthogTrackingRuntime::new(default_config()) })
        .await
        .get()
        .await
}

// Source-facing names are also exported below. The lazy wrappers are async to
// make runtime acquisition explicit; methods on an acquired handle are sync.
pub async fn identify_streamer(id: &JsString, name: &JsString) -> Result<(), CaptureError> {
    get_posthog_tracking().await?.identify_streamer(id, name)
}
pub async fn track_command(p: &JsonValue) -> Result<(), CaptureError> {
    get_posthog_tracking().await?.track_command(p)
}
pub async fn track_tts(p: &JsonValue) -> Result<(), CaptureError> {
    get_posthog_tracking().await?.track_tts(p)
}
pub async fn track_ai_usage_recorded(p: &JsonValue) -> Result<(), CaptureError> {
    get_posthog_tracking().await?.track_ai_usage_recorded(p)
}
pub async fn track_ai_operation(p: &JsonValue) -> Result<(), CaptureError> {
    get_posthog_tracking().await?.track_ai_operation(p)
}
pub async fn shutdown_posthog() -> Result<(), CaptureError> {
    get_posthog_tracking().await?.shutdown_posthog().await
}
pub use identify_streamer as identifyStreamer;
pub use shutdown_posthog as shutdownPosthog;
pub use track_ai_operation as trackAiOperation;
pub use track_ai_usage_recorded as trackAiUsageRecorded;
pub use track_command as trackCommand;
pub use track_tts as trackTts;
