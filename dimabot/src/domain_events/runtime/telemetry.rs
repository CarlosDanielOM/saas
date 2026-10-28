//! Domain journal adapter over the shared native observability core.
pub use crate::utils::observability::{
    Telemetry as JournalTelemetry, TelemetryTask as JournalTelemetryTask, TraceContext,
    telemetry_context, with_telemetry_context,
};
