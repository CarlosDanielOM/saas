//! Logger, trace context, metrics and log export for every Rust binary.
//!
//! One [`Telemetry`] handle per process carries everything: the application logger
//! ([`logger`]), the per-task trace context ([`trace`]), metrics and spans aggregated in
//! 10-second buckets ([`aggregate`]) and exported to the Dragonfly inbox the analytics service
//! drains, process and runtime figures ([`process`]), per-worker figures for the cron binary
//! ([`worker`]), log export to PostHog ([`otlp`]), and the four seams of the other crates
//! ([`hooks`]). Nothing on a request path waits for the network: every destination sits behind a
//! bounded queue, and what does not fit is dropped and counted (the admin page shows the count as
//! `telemetry_dropped`).
//!
//! **Cost on hot paths** (measured by `tests/overhead.rs`, release-like numbers are lower): a
//! filtered log call is one comparison; a counter increment hashes a stack key and updates an
//! existing series under an uncontended shard lock; a span that is not kept reads the clock twice
//! and updates its series. None of them allocates.
//!
//! **Wiring** a binary (API shown; the bot is the same without the web parts, the cron binary
//! adds a [`Worker`] per supervised task):
//!
//! ```no_run
//! use dima_telemetry::{LogOptions, PosthogConfig, Telemetry, TelemetryConfig};
//! use std::time::Duration;
//!
//! # async fn demo(env: &std::collections::HashMap<&str, String>) -> Result<(), Box<dyn std::error::Error>> {
//! let get = |name: &str| env.get(name).map(String::as_str);
//! let mut config = TelemetryConfig::new("api", "index").with_env_values(
//!     get("OBSERVABILITY_DISABLED"),
//!     get("DRAGONFLY_HOST"),
//!     get("DRAGONFLY_PORT"),
//!     get("SECRET_KEY"),
//! );
//! config.posthog = Some(PosthogConfig::reference()); // API and bot only
//! let telemetry = Telemetry::new(config)?;
//! let running = telemetry.start();
//!
//! // Stores and the outbound client report through the same handle.
//! let dragonfly_config = dima_store::dragonfly::DragonflyConfig::from_env_values(
//!     get("DRAGONFLY_HOST"), get("DRAGONFLY_PORT"), "server");
//! let dragonfly = dima_store::dragonfly::Dragonfly::connect(dragonfly_config, telemetry.dragonfly_hooks()).await?;
//! # let mongo_config: dima_store::mongo::MongoConfig = todo!();
//! let mongo = dima_store::mongo::MongoStore::connect(&mongo_config, Some(telemetry.mongo_hook())).await?;
//! let http = dima_http::HttpClient::builder()
//!     .observer(telemetry.http_observer())
//!     .trace_injector(telemetry.trace_injector())
//!     .build()?;
//!
//! // The inbound edge: the observer ends each request's span, the wrapper makes the request's
//! // context current while its handlers run.
//! # let router: dima_web::Router<()> = todo!();
//! let app = dima_web::App::new(router, ())?.observe(telemetry.web_observer());
//! let service = telemetry.traced_service(app);
//! # let listener: tokio::net::TcpListener = todo!();
//! # let shutdown = dima_core::Shutdown::new();
//! dima_web::serve(listener, service, shutdown.cancellation_token(), Default::default()).await?;
//!
//! // Anywhere: logs, metrics, spans.
//! telemetry.info(&serde_json::json!({"function": "boot", "step": "listening"}), LogOptions::console());
//! telemetry.count("lifecycle", "stream.started");
//! let _ = telemetry
//!     .traced("command", "!uptime", async { Ok::<_, std::io::Error>(()) })
//!     .await;
//!
//! // Last thing before exit: final flush of everything, bounded.
//! running.shutdown(Duration::from_secs(5)).await;
//! # let _ = (dragonfly, mongo, http);
//! # Ok(())
//! # }
//! ```
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod aggregate;
pub mod hooks;
pub mod label;
pub mod logger;
pub mod otlp;
pub mod process;
pub mod redact;
pub mod span;
mod telemetry;
pub mod trace;
pub mod worker;

pub use hooks::{HttpSpan, TracedService, WebObserver};
pub use logger::{ConsoleTarget, Destination, Level, LogOptions};
pub use otlp::PosthogConfig;
pub use span::Span;
pub use telemetry::{
    ENQUEUE, FLUSH_DEADLINE, Running, ShutdownReport, Snapshot, Stats, TELEMETRY_INBOX,
    TELEMETRY_OVERFLOW, Telemetry, TelemetryConfig, TelemetryError,
};
pub use trace::{SavedTrace, SpanIds, TraceContext};
pub use worker::{RunOutcome, Worker, WorkerState};
