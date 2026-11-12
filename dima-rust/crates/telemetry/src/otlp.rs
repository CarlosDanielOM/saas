//! Log export to PostHog over OTLP/HTTP in its JSON encoding (`utils/opentelemetry_posthog.ts`,
//! `ledger/runtime.md` 6.7), sent with `dima-http`. No OpenTelemetry SDK.
//!
//! The reference installs `BatchLogRecordProcessor(OTLPLogExporter)` with resource
//! `service.name=DomDimaBot` and emits every log call there from the API and the bot. Kept: the
//! endpoint, the bearer header, the resource and scope names, one record per log call. The batch
//! processor's defaults are kept as bounds: a queue of 2048 records, batches of at most 512, one
//! export at least every second. Changed: the queue is flushed on shutdown (the reference never
//! calls `sdk.shutdown()`), and an export is retried at most twice (1 s, then 2 s) on 429, 5xx and
//! network failures, each attempt bounded by [`EXPORT_TIMEOUT`]; after that the batch is dropped
//! and counted.

use crate::logger::{Level, LogRecord};
use dima_core::SecretString;
use dima_http::{HttpClient, Provider, RetryPolicy};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// The reference's endpoint host.
pub const POSTHOG_BASE_URL: &str = "https://us.i.posthog.com";
/// The OTLP logs path.
pub const POSTHOG_LOGS_PATH: &str = "/i/v1/logs";
/// The reference's project key. It is PostHog's public client key (it is in the reference's
/// source), not a secret.
pub const POSTHOG_PROJECT_KEY: &str = "phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP";
/// The reference's resource `service.name` and logger name.
pub const SERVICE_NAME: &str = "DomDimaBot";
/// Records per export (`maxExportBatchSize`).
pub const MAX_BATCH: usize = 512;
/// Longest wait before a partial batch is exported (`scheduledDelayMillis`).
pub const EXPORT_INTERVAL: Duration = Duration::from_secs(1);
/// Bound on one attempt.
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);
/// Delays before the retries.
pub const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(2)];

/// Where and how logs are exported.
#[derive(Clone, Debug)]
pub struct PosthogConfig {
    /// Base URL (the rig points it at a mock).
    pub base_url: String,
    /// The bearer token.
    pub token: SecretString,
    /// Resource `service.name`.
    pub service_name: String,
    /// Entries below this level are not exported (counted as
    /// [`crate::Stats::posthog_below_level`]). `None`, the default: every entry the logger's own
    /// minimum level lets through, as the reference exports every log call whatever its level.
    pub min_level: Option<Level>,
}

impl PosthogConfig {
    /// The reference's endpoint, key and resource.
    pub fn reference() -> Self {
        Self {
            base_url: POSTHOG_BASE_URL.to_owned(),
            token: SecretString::new(POSTHOG_PROJECT_KEY.to_owned()),
            service_name: SERVICE_NAME.to_owned(),
            min_level: None,
        }
    }
}

/// OTLP severity numbers.
fn severity(level: Level) -> u8 {
    match level {
        Level::Trace => 1,
        Level::Debug => 5,
        Level::Info => 9,
        Level::Warn => 13,
        Level::Error => 17,
        Level::Fatal => 21,
    }
}

/// A JSON value as an OTLP `AnyValue`.
pub fn any_value(value: &Value) -> Value {
    match value {
        // AnyValue has no null; the reference's SDK drops it. Keep its spelling visible.
        Value::Null => json!({ "stringValue": "null" }),
        Value::Bool(flag) => json!({ "boolValue": flag }),
        Value::Number(number) => match number.as_i64() {
            // int64 is a string in OTLP JSON.
            Some(integer) => json!({ "intValue": integer.to_string() }),
            None => json!({ "doubleValue": number.as_f64().unwrap_or(0.0) }),
        },
        Value::String(text) => json!({ "stringValue": text }),
        Value::Array(items) => {
            json!({ "arrayValue": { "values": items.iter().map(any_value).collect::<Vec<_>>() } })
        }
        Value::Object(fields) => {
            json!({ "kvlistValue": { "values": fields.iter().map(|(key, item)| json!({ "key": key, "value": any_value(item) })).collect::<Vec<_>>() } })
        }
    }
}

fn attribute(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

#[derive(Serialize)]
struct LogRecordJson {
    #[serde(rename = "timeUnixNano")]
    time: String,
    #[serde(rename = "observedTimeUnixNano")]
    observed: String,
    #[serde(rename = "severityNumber")]
    severity_number: u8,
    #[serde(rename = "severityText")]
    severity_text: &'static str,
    body: Value,
    attributes: Vec<Value>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
    #[serde(rename = "spanId", skip_serializing_if = "Option::is_none")]
    span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flags: Option<u8>,
}

fn record_json(record: &LogRecord) -> LogRecordJson {
    let nanos = (u128::try_from(record.at_ms.max(0)).unwrap_or_default() * 1_000_000).to_string();
    // The reference passes the call's options as attributes.
    let mut attributes = vec![
        attribute("destination", record.destination.as_str()),
        attribute("platform", record.platform.as_str()),
    ];
    if let Some(channel) = &record.channel_id {
        attributes.push(attribute("channelId", channel.as_str()));
    }
    LogRecordJson {
        time: nanos.clone(),
        observed: nanos,
        severity_number: severity(record.level),
        severity_text: record.level.as_str(),
        body: any_value(&record.data),
        attributes,
        trace_id: record
            .trace
            .map(|ids| ids.trace_id.hex().as_str().to_owned()),
        span_id: record
            .trace
            .map(|ids| ids.span_id.hex().as_str().to_owned()),
        flags: record.trace.map(|ids| u8::from(ids.sampled)),
    }
}

/// The `ExportLogsServiceRequest` for a batch.
pub(crate) fn request_body(service_name: &str, records: &[Arc<LogRecord>]) -> Value {
    let mut resource = Map::new();
    resource.insert(
        "attributes".to_owned(),
        Value::Array(vec![attribute("service.name", service_name)]),
    );
    json!({
        "resourceLogs": [{
            "resource": resource,
            "scopeLogs": [{
                "scope": { "name": service_name },
                "logRecords": records.iter().map(|record| record_json(record)).collect::<Vec<_>>(),
            }],
        }],
    })
}

/// The exporter: owns its HTTP client (and so its own shutdown, so the final flush is not
/// cancelled by the application's shutdown).
pub(crate) struct Exporter {
    client: HttpClient,
    provider: Provider,
    service_name: String,
    token: SecretString,
}

/// Why an export failed (never carries the token).
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    /// The configuration is unusable.
    #[error("PostHog export is misconfigured: {0}")]
    Config(String),
    /// The request failed after its retries.
    #[error("PostHog export failed: {0}")]
    Failed(String),
}

impl Exporter {
    pub(crate) fn new(config: &PosthogConfig) -> Result<Self, ExportError> {
        let provider = Provider::builder("posthog", &config.base_url)
            .timeout(EXPORT_TIMEOUT)
            .max_bytes(64 * 1024)
            .retry(RetryPolicy::fetch_with_retry(&RETRY_DELAYS))
            .build()
            .map_err(|error| ExportError::Config(error.to_string()))?;
        let client = HttpClient::builder()
            .build()
            .map_err(|error| ExportError::Config(error.to_string()))?;
        Ok(Self {
            client,
            provider,
            service_name: config.service_name.clone(),
            token: config.token.clone(),
        })
    }

    pub(crate) async fn export(&self, records: &[Arc<LogRecord>]) -> Result<(), ExportError> {
        let body = request_body(&self.service_name, records);
        let response = self
            .client
            .post(&self.provider, POSTHOG_LOGS_PATH)
            .bearer(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|error| ExportError::Failed(error.to_string()))?;
        if response.status().is_success() {
            let _ = response.bytes().await;
            Ok(())
        } else {
            Err(ExportError::Failed(format!(
                "status {}",
                response.status().as_u16()
            )))
        }
    }
}

/// The export loop: a batch every [`EXPORT_INTERVAL`] or [`MAX_BATCH`] records, until the queue
/// closes or `stop` fires; then whatever is queued is exported once more.
pub(crate) async fn run(
    exporter: Exporter,
    rx: tokio::sync::mpsc::Receiver<Arc<LogRecord>>,
    stop: dima_core::Shutdown,
    telemetry: crate::Telemetry,
) {
    // A batch in flight and the queue are counted as dropped if this task is aborted.
    let mut drain = crate::telemetry::Drain::new(&telemetry, rx, MAX_BATCH, |drops| &drops.posthog);
    let crate::telemetry::Drain { rx, batch, .. } = &mut drain;
    let mut stopping = false;
    loop {
        if !stopping {
            let deadline = tokio::time::sleep(EXPORT_INTERVAL);
            tokio::pin!(deadline);
            while batch.len() < MAX_BATCH {
                tokio::select! {
                    biased;
                    () = stop.wait() => { stopping = true; break; }
                    record = rx.recv() => match record {
                        Some(record) => batch.push(record),
                        None => { stopping = true; break; }
                    },
                    () = &mut deadline => break,
                }
            }
        }
        if stopping {
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(record) => batch.push(record),
                    Err(_) => break,
                }
            }
        }
        if !batch.is_empty() {
            if exporter.export(batch).await.is_err() {
                telemetry
                    .0
                    .sinks
                    .drops
                    .posthog
                    .fetch_add(batch.len() as u64, Ordering::Relaxed);
            }
            batch.clear();
        } else if stopping {
            return;
        }
    }
}
