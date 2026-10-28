//! Native worker and reusable data-store foundation for incremental migrations.
//!
//! Features select independent capabilities:
//!
//! - `mongo`: the lazy native MongoDB client, bounded stream-activity and raid
//!   summary projectors, and their explicitly invoked executables.
//! - `redis`: the lazy Dragonfly-compatible Redis connection manager.
//! - `postgres`: SQLx with PostgreSQL, Tokio, and rustls/ring, available for a
//!   future telemetry worker without compiling it into MongoDB-only workers.
//! - `http`: Axum's HTTP/JSON/Tokio foundation for future server surfaces,
//!   plus tower-http CORS matching the legacy npm `cors()` defaults.
//! - `cron-supervisor`: an independently built native process supervisor and
//!   bounded telemetry, without selecting any worker or database profile.
//!
//! Opt-in service foundations for porting `dimabot/src/utils` helpers. None is
//! in `default` or in a deployed worker profile:
//!
//! - `email`: Resend delivery of rendered emails (`utils::email`).
//! - `posthog`: PostHog capture and `$identify` (`utils::posthog`).
//! - `qdrant`: the official gRPC Qdrant client (`utils::qdrant`).
//! - `s3`: S3-compatible uploads/deletes (`utils::s3`).
//! - `otel`: OpenTelemetry log export to PostHog (`utils::otel`).
//! - `jwt`: Node-compatible email activation tokens (`utils::jwt`).
//! - `re2-compat`: RE2-compatible user regexes on `regex` (`utils::re2_compat`).
//! - `socketio`: socketioxide with socket.io's server defaults (`utils::socketio`).
//! - `audio`: MP3/WAV durations for TTS playback (`utils::audio`).
//!
//! The default enables all four for existing manual/library consumers. Native
//! cron builds use `--no-default-features --features mongo` to omit unrelated
//! Redis, PostgreSQL, and HTTP dependencies. Each worker binary and the stream
//! fixture example requires `mongo`; disabled targets are skipped by Cargo.
//!
//! Utilities connect only when called. Projectors run only through their public
//! APIs or executables. The opt-in `cron_index` explicitly starts supervision;
//! worker/library imports do not. Constructors do not create indexes or access
//! application data. Ports
//! preserve the application's collection names, BSON types, defaults, and indexes.
//!
//! MongoDB reads `MONGO_URI`. Redis reads `DRAGONFLY_HOST`/`DRAGONFLY_PORT`, uses
//! plain TCP/database 0, and returns cheap clones sharing one multiplexed socket.
//! Initialization failures are retryable; failed Redis commands are not replayed.
//! Keep each utility within the long-lived Tokio runtime that initialized it.
//! Blocking Redis commands and Pub/Sub need separate connections. Neither utility
//! loads environment files. Executables load only repeatable `--env-file PATH`
//! arguments before runtime threads; existing variables and earlier files win.
//!
//! Both MongoDB-only and Redis-only feature sets select rustls/ring explicitly,
//! so Redis TLS does not rely on SQLx or MongoDB to supply its crypto provider.
//!
//! Redis commands can use the driver's `AsyncCommands` API:
//!
//! ```no_run
//! # #[cfg(feature = "redis")]
//! async fn read_cache_value() -> Result<Option<String>, Box<dyn std::error::Error>> {
//!     use redis::AsyncCommands;
//!
//!     let mut cache = dima_rust::utils::redis::get_redis_client().await?;
//!     let value: Option<String> = cache.get("example:key").await?;
//!     Ok(value)
//! }
//! ```

pub mod utils;
pub mod workers;

#[cfg(feature = "tts-services")]
#[path = "server/services/tts/mod.rs"]
pub mod tts_services;

#[cfg(feature = "bits-rules")]
pub mod bits_rules;

#[cfg(feature = "domain-events")]
#[path = "domain_events/mod.rs"]
pub mod domain_event_contracts;

#[cfg(feature = "application-schemas")]
pub mod schemas;

#[cfg(feature = "domain-event-runtime")]
#[path = "domain_events/runtime/mod.rs"]
pub mod domain_event_runtime;

#[cfg(feature = "twitch-functions")]
pub mod functions;

#[cfg(feature = "cron-supervisor")]
#[path = "workers/cron_supervisor/mod.rs"]
pub mod supervisor;

#[cfg(all(test, any(feature = "mongo", feature = "redis")))]
mod tls_feature_tests {
    #[test]
    fn tls_configuration_has_a_provider_without_other_database_features() {
        // These features add aws-lc-rs as a second provider; the documented
        // startup call selects ring again.
        #[cfg(any(
            feature = "email",
            feature = "posthog",
            feature = "s3",
            feature = "otel"
        ))]
        crate::utils::install_default_tls_provider();

        // Redis uses this exact builder. It panics without a selectable crypto
        // provider; no connection, certificate, or network fixture is needed.
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        assert!(!config.crypto_provider().cipher_suites.is_empty());
    }
}
