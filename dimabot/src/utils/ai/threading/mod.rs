//! Ports the TypeScript AI threading store, router, limits and JSON contracts.
//! Connections are injected and construction performs no I/O; callers own
//! connection lifecycle and opt into the module through the Cargo feature.
pub mod thread_limits;
pub mod thread_types;
pub mod thread_store;
pub mod thread_router;
