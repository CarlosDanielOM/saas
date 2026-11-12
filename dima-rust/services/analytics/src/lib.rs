//! Observability backend. Environment is read only by the binary.
#![forbid(unsafe_code)]
pub mod batch;
pub mod store;
pub type Result<T> = std::result::Result<T,Error>;
#[derive(Debug,thiserror::Error)]
pub enum Error {
 #[error("{0}")] Invalid(&'static str),
 #[error("PostgreSQL unavailable")] Postgres(#[from]tokio_postgres::Error),
 #[error("Operation timed out")] Timeout,
 #[error("Dragonfly unavailable")] Dragonfly(#[from]dima_store::dragonfly::DragonflyError),
 #[error("Invalid configuration")] Config,
 #[error("HTTP unavailable")] Http(#[from]dima_http::Error),
}
pub mod service;
pub use service::{Config,State,build};
mod grants;
mod overview;
