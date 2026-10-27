//! Uses an explicitly supplied SDK logger; never builds a provider/exporter.
//! SDK emission confirms local acceptance only, not collector delivery. The
//! caller owns flushing/shutdown of its provider, outside logger shutdown.
use super::{Level, OtelRecord, OtelSink, SinkError, SinkFuture};
use opentelemetry::logs::{AnyValue, LogRecord, Logger as _, LoggerProvider, Severity};
use opentelemetry_sdk::logs::{SdkLogger, SdkLoggerProvider};
use serde_json::Value;

pub struct OtelLoggerSink {
    logger: SdkLogger,
}
impl OtelLoggerSink {
    pub fn new(logger: SdkLogger) -> Self {
        Self { logger }
    }
    /// No exporter configuration or I/O is performed here.
    pub fn from_provider(provider: &SdkLoggerProvider) -> Self {
        Self::new(provider.logger(crate::utils::otel::SERVICE_NAME))
    }
}
impl OtelSink for OtelLoggerSink {
    fn emit(&self, event: OtelRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let value: Value =
                serde_json::from_str(&event.body_json).map_err(|_| SinkError::Rejected)?;
            let mut record = self.logger.create_log_record();
            record.set_severity_text(event.level.as_str());
            record.set_severity_number(match event.level {
                Level::Trace => Severity::Trace,
                Level::Debug => Severity::Debug,
                Level::Info => Severity::Info,
                Level::Warn => Severity::Warn,
                Level::Error => Severity::Error,
                Level::Fatal => Severity::Fatal,
            });
            record.set_body(any_value(value));
            record.add_attribute(
                "destination",
                match event.destination {
                    super::Destination::Cache => "cache",
                    super::Destination::Console => "console",
                    super::Destination::Both => "both",
                },
            );
            record.add_attribute("platform", event.platform);
            if let Some(channel) = event.channel_id {
                record.add_attribute("channelId", channel);
            }
            if let Some(trace) = event.trace_id {
                record.add_attribute("traceId", trace);
            }
            self.logger.emit(record);
            Ok(())
        })
    }
}
fn any_value(value: Value) -> AnyValue {
    match value {
        // OTEL AnyValue has no JSON null variant. Preserve its spelling.
        Value::Null => AnyValue::String("null".into()),
        Value::Bool(v) => AnyValue::Boolean(v),
        Value::Number(v) => match v.as_i64() {
            Some(v) => AnyValue::Int(v),
            None => AnyValue::Double(v.as_f64().unwrap_or(0.0)),
        },
        Value::String(v) => AnyValue::String(v.into()),
        Value::Array(v) => AnyValue::ListAny(Box::new(v.into_iter().map(any_value).collect())),
        Value::Object(v) => AnyValue::Map(Box::new(
            v.into_iter()
                .map(|(k, v)| (k.into(), any_value(v)))
                .collect(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::{
        logger::{
            ConsoleRecord, ConsoleSink, Destination, LogOptions, Logger, LoggerConfig, SinkHandles,
            SinkStatus, SystemClock, UuidSource,
        },
        test_http::{CannedResponse, Recorder},
    };
    use serde_json::json;
    use std::{sync::Arc, time::Duration};

    struct SilentConsole;
    impl ConsoleSink for SilentConsole {
        fn write(&self, _record: ConsoleRecord) -> SinkFuture<'_> {
            Box::pin(async { Ok(()) })
        }
    }
    fn contains(body: &[u8], value: &str) -> bool {
        body.windows(value.len())
            .any(|part| part == value.as_bytes())
    }
    #[test]
    fn logger_adapter_exports_actual_event_through_explicit_loopback_provider() {
        let recorder = Recorder::start(|_| CannedResponse {
            status: 200,
            headers: vec![("content-type", "application/x-protobuf".into())],
            body: Vec::new(),
        });
        // Provider startup, flush and shutdown use its blocking transport outside
        // the async runtime, matching the existing shared OTEL provider contract.
        let provider = crate::utils::otel::logger_provider(
            &format!("{}/i/v1/logs", recorder.base_url),
            "logger-fixture-key",
        )
        .unwrap();
        let logger = Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(Arc::new(SilentConsole)),
                otel: Some(Arc::new(OtelLoggerSink::from_provider(&provider))),
                ..SinkHandles::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let report = logger
                .log(
                    Level::Warn,
                    json!({"function":"logger.fixture", "message":"actual-adapter-event"}),
                    LogOptions {
                        destination: Destination::Console,
                        channel_id: Some("adapter-fixture-channel".into()),
                        ..LogOptions::default()
                    },
                )
                .await;
            assert!(report.success(), "{report:?}");
            assert_eq!(report.otel, SinkStatus::Succeeded);
            assert!(logger.shutdown(Duration::from_secs(1)).await.drained);
        });
        provider.force_flush().unwrap();
        let request = recorder.next(Duration::from_secs(20));
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/i/v1/logs");
        assert_eq!(
            request.header("authorization"),
            Some("Bearer logger-fixture-key")
        );
        assert_eq!(
            request.header("content-type"),
            Some("application/x-protobuf")
        );
        for value in [
            crate::utils::otel::SERVICE_NAME,
            "actual-adapter-event",
            "logger.fixture",
            "destination",
            "console",
            "channelId",
            "adapter-fixture-channel",
            "warn",
        ] {
            assert!(contains(&request.body, value), "OTLP body missing {value}");
        }
        provider.shutdown().unwrap();
    }
}
