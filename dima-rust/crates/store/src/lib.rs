//! MongoDB and Dragonfly access: connections, BSON rules, queues, pub/sub, Lua.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
#![forbid(unsafe_code)]

pub mod dragonfly;
pub mod mongo;
