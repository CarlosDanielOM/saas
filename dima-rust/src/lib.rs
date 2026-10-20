//! Basic Rust library scaffold for incremental future worker and server
//! migrations.
//!
//! The crate exposes two narrow data-store utilities: a lazily initialized,
//! process-wide MongoDB client in [`utils::mongo`] and a Redis/Dragonfly
//! connection manager in [`utils::redis`]. It also provides the bounded MongoDB
//! stream-activity projector in [`workers::stream_activity`] and a manual
//! `stream_activity` binary. The binary is not registered with dimabot's worker
//! supervisor or Compose services, and this crate has no supported deployment
//! target. The remaining dependencies establish the foundational set for
//! deliberate ports:
//!
//! - [`mongodb`] for MongoDB, including [`mongodb::bson`] for BSON documents
//! - [`serde`] for mapping BSON documents into explicit structs
//! - [`garde`] for additional field and business validation
//! - [`tokio`] as the asynchronous runtime
//! - [`sqlx`] with PostgreSQL support
//! - [`redis`] (redis-rs) for Dragonfly-compatible Redis operations
//! - [`axum`] for future HTTP surfaces
//! - [`dotenvy`] for explicitly loading environment files in a binary
//!
//! Merely adding or importing a dependency does not connect to its service.
//! The MongoDB and Redis utilities connect only when explicitly called, and the
//! projector runs only when its public API is called or its manual binary is
//! invoked. Nothing starts these paths automatically. This crate has no
//! supported deployment target. Future ports must preserve the existing
//! application's collection names, field types, defaults, and indexes.
//!
//! [`utils::redis::get_redis_client`] reads `DRAGONFLY_HOST` and
//! `DRAGONFLY_PORT` from the process environment and connects over plain TCP to
//! database 0. It caches a `redis::aio::ConnectionManager` after a successful
//! connection and `PING`; initialization failures can be retried. The returned
//! manager is an owned, cheap clone sharing a multiplexed socket. The five
//! second timeout bounds initialization only. The driver's reconnect support
//! does not replay a command that fails during a disconnect. Use the manager
//! within the long-lived Tokio runtime that initialized it, and do not reuse it
//! after that runtime shuts down. Its response timeout is unset to preserve
//! blocking command semantics; blocking commands and Pub/Sub should use
//! separate dedicated connections when implemented. The utility does not load
//! dotenv files.
//!
//! Adding `dotenvy` does not load files automatically. The manual
//! `stream_activity` binary loads only paths passed with repeatable
//! `--env-file PATH` arguments, synchronously before its two-thread Tokio
//! runtime. Existing process variables take precedence; when files are loaded
//! in sequence, earlier files take precedence over later ones. The client
//! utilities themselves do not load dotenv files.
//!
//! Redis commands can use the driver's `AsyncCommands` API:
//!
//! ```no_run
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
