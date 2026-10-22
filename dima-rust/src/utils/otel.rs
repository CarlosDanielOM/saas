//! OpenTelemetry log export to PostHog, mirroring
//! `dimabot/src/utils/opentelemetry_posthog.ts`.
//!
//! [`posthog_logger_provider`] builds a batch log pipeline with the same
//! `service.name` (`DomDimaBot`), OTLP/HTTP protobuf endpoint, and bearer
//! project key as the TypeScript `NodeSDK`. The endpoint is used as given;
//! `OTEL_EXPORTER_OTLP_*` endpoint variables do not override it.
//!
//! The Rust OTLP *log exporter* is still marked release-candidate upstream
//! (the logs API and SDK are stable). The batch processor exports from its
//! own thread with a blocking HTTP client, so build and shut the provider down
//! outside async tasks (or inside `spawn_blocking`). Call
//! `shutdown()` before exit to flush buffered records.

use std::collections::HashMap;

use opentelemetry_otlp::{LogExporter, Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{Resource, logs::SdkLoggerProvider};

pub use opentelemetry_otlp::ExporterBuildError;

/// Same service name as the TypeScript resource.
pub const SERVICE_NAME: &str = "DomDimaBot";
/// PostHog's OTLP logs intake, as configured in TypeScript.
pub const POSTHOG_LOGS_ENDPOINT: &str = "https://us.i.posthog.com/i/v1/logs";

/// Builds a provider that batches logs to PostHog's logs endpoint.
pub fn posthog_logger_provider() -> Result<SdkLoggerProvider, ExporterBuildError> {
    logger_provider(POSTHOG_LOGS_ENDPOINT, crate::utils::POSTHOG_PROJECT_KEY)
}

/// Builds a provider for an explicit OTLP/HTTP logs endpoint and bearer token.
pub fn logger_provider(
    endpoint: &str,
    bearer_token: &str,
) -> Result<SdkLoggerProvider, ExporterBuildError> {
    let exporter = LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_headers(HashMap::from([(
            "Authorization".to_owned(),
            format!("Bearer {bearer_token}"),
        )]))
        .build()?;
    let resource = Resource::builder().with_service_name(SERVICE_NAME).build();
    Ok(SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(exporter)
        .build())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use opentelemetry::logs::{LogRecord, Logger, LoggerProvider, Severity};

    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn exports_batched_logs_with_service_name_and_bearer_token() {
        let recorder = Recorder::start(|_| CannedResponse {
            status: 200,
            headers: vec![("content-type", "application/x-protobuf".to_owned())],
            body: Vec::new(),
        });
        let endpoint = format!("{}/i/v1/logs", recorder.base_url);
        let provider = logger_provider(&endpoint, "phc_test").expect("exporter builds");

        let logger = provider.logger("dima-rust-test");
        let mut record = logger.create_log_record();
        record.set_severity_number(Severity::Info);
        record.set_body("worker started".into());
        logger.emit(record);
        provider.force_flush().expect("flush succeeds");

        let request = recorder.next(Duration::from_secs(20));
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/i/v1/logs");
        assert_eq!(request.header("authorization"), Some("Bearer phc_test"));
        assert_eq!(
            request.header("content-type"),
            Some("application/x-protobuf")
        );
        assert!(contains(&request.body, SERVICE_NAME.as_bytes()));
        assert!(contains(&request.body, b"worker started"));
        provider.shutdown().expect("shutdown succeeds");
    }
}
