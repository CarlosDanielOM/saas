//! Basic Rust library scaffold for incremental future worker and server
//! migrations.
//!
//! The crate currently exposes one narrow database utility: a lazily
//! initialized, process-wide MongoDB client in [`utils::mongo`]. It does not
//! implement workers, servers, routes, or a generic database framework. The
//! remaining dependencies establish the foundational set so later ports can be
//! added deliberately:
//!
//! - [`mongodb`] for MongoDB, including [`mongodb::bson`] for BSON documents
//! - [`serde`] for mapping BSON documents into explicit structs
//! - [`garde`] for additional field and business validation
//! - [`tokio`] as the asynchronous runtime
//! - [`sqlx`] with PostgreSQL support
//! - [`redis`] (redis-rs) for Dragonfly-compatible Redis operations
//! - [`axum`] for future HTTP surfaces
//! - [`dotenvy`] for explicitly loading environment files from a future executable
//!
//! Adding a dependency does not mean its backing service is configured or
//! connected, and this crate has no supported deployment target yet. Future
//! ports must preserve the existing application's collection names, field
//! types, defaults, and indexes.
//!
//! Adding `dotenvy` does not load files automatically. A future executable should load
//! its explicitly selected files synchronously in `main`, before constructing
//! the Tokio runtime and before calling [`utils::mongo::get_mongo_client`].
//! `from_path` propagates missing-file and parse errors; existing process
//! variables (including values provided by Docker) win, and earlier files win
//! over later files. The library currently has no runnable entry point.
//!
//! ```no_run
//! async fn run_application() -> Result<(), Box<dyn std::error::Error>> {
//!     // Start the application and use dima_rust::utils::mongo::get_mongo_client() here.
//!     Ok(())
//! }
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     dotenvy::from_path("path/to/.env.local")?;
//!     dotenvy::from_path("path/to/.env")?;
//!
//!     let runtime = tokio::runtime::Builder::new_multi_thread()
//!         .enable_all()
//!         .build()?;
//!     runtime.block_on(run_application())?;
//!     Ok(())
//! }
//! ```

pub mod utils;
