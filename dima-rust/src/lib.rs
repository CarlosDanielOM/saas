//! Basic Rust library scaffold for incremental future worker and server
//! migrations.
//!
//! This crate currently defines no functions, types, workers, servers, routes,
//! clients, or database access. It only establishes the foundational dependency
//! set so later ports can be added deliberately:
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
