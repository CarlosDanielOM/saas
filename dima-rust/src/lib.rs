//! Native worker and reusable data-store foundation for incremental migrations.
//!
//! Features select independent capabilities:
//!
//! - `mongo`: the lazy native MongoDB client, bounded stream-activity and raid
//!   summary projectors, and their explicitly invoked executables.
//! - `redis`: the lazy Dragonfly-compatible Redis connection manager.
//! - `postgres`: SQLx with PostgreSQL, Tokio, and rustls/ring, available for a
//!   future telemetry worker without compiling it into MongoDB-only workers.
//! - `http`: Axum's HTTP/JSON/Tokio foundation for future server surfaces.
//!
//! The default enables all four for existing manual/library consumers. Native
//! cron builds use `--no-default-features --features mongo` to omit unrelated
//! Redis, PostgreSQL, and HTTP dependencies. Each worker binary and the stream
//! fixture example requires `mongo`; disabled targets are skipped by Cargo.
//!
//! Utilities connect only when called. Projectors run only through their public
//! APIs or executables; deployment and supervision belong to the existing cron
//! host. Constructors do not create indexes or access application data. Ports
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

#[cfg(all(test, any(feature = "mongo", feature = "redis")))]
mod tls_feature_tests {
    #[test]
    fn tls_configuration_has_a_provider_without_other_database_features() {
        // Redis uses this exact builder. It panics without a selectable crypto
        // provider; no connection, certificate, or network fixture is needed.
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        assert!(!config.crypto_provider().cipher_suites.is_empty());
    }
}
