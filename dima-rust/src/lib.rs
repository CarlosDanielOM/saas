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
//!
//! Adding a dependency does not mean its backing service is configured or
//! connected, and this crate has no supported deployment target yet. Future
//! ports must preserve the existing application's collection names, field
//! types, defaults, and indexes.

pub mod utils;
