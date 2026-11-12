//! Dragonfly (Redis protocol) access that interoperates byte for byte with the TypeScript
//! processes (node-redis 5) sharing the same keys, queues, channels and Lua scripts.
//!
//! The specification is `dima-rust/ledger/dragonfly.md` (cross-process flows, byte-sensitive
//! items, the node-redis / redis-rs reply differences and the rules a Rust implementation must
//! follow) and charter data rules 6 to 8. `tests/dragonfly_golden/record.mjs` records what
//! node-redis and the reference's Lua actually store; the `dragonfly_*` tests replay it and run a
//! Node process beside Rust on the same keys.
//!
//! - [`config`]: [`DragonflyConfig`], the address built exactly as the reference builds it, and
//!   the timeout policy.
//! - [`client`]: [`Dragonfly`], the cloneable command handle on one multiplexed connection with
//!   reconnection and a response timeout.
//! - [`commands`]: typed helpers for the replies where node-redis and redis-rs differ.
//! - [`blocking`]: [`BlockingConnection`], a cancel-safe dedicated connection for blocking commands.
//! - [`pubsub`]: [`Subscriber`] (raw, bounded, resubscribing) and the pub/sub manager's envelope.
//! - [`script`]: [`Script`], `EVALSHA` with the `EVAL` fallback; one `.lua` file per script.
//! - [`queue`]: [`QueueItem`] and list / sorted-set queues that carry items as exact bytes.
//! - [`hooks`]: command spans and connection-error reporting, so telemetry attaches from outside.
//! - [`plan_cache_fence`], [`cron_queue`]: the two protocols ported from the pre-existing crate.
//!
//! RESP2 only, as both reference clients speak it.
#![warn(missing_docs)]

pub mod blocking;
pub mod client;
pub mod commands;
pub mod config;
pub mod cron_queue;
pub mod error;
pub mod hooks;
pub mod plan_cache_fence;
pub mod pubsub;
pub mod queue;
pub mod script;

pub use blocking::BlockingConnection;
pub use client::Dragonfly;
pub use commands::{End, SetCondition, SetExpiry, SetOptions, SetOutcome, Ttl};
pub use config::DragonflyConfig;
pub use error::{DecodeCategory, DecodeError, DragonflyError};
pub use hooks::{CommandHook, ErrorHook, Hooks};
pub use pubsub::{Message, Subscriber, Subscription, Topic};
pub use queue::{DelayQueue, ListQueue, ProcessingList, QueueItem};
pub use script::Script;
