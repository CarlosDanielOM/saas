//! Dragonfly (Redis protocol) access for the Rust backend: commands, pub/sub, Lua scripts,
//! queues. The bot, the API and every cron worker share it.
//!
//! After the one cutover only Rust reads and writes Dragonfly (`MIGRATION.md` section 3,
//! "Dragonfly is internal"), so queue items and pub/sub payloads are Rust's own encoding; nothing
//! here has to produce the bytes Node would have produced. What still matches the reference: the
//! Lua scripts (verbatim, data rule 7), the reply shapes the ported logic depends on, and the
//! *carried* key families the porting package names. Within Rust, a value matched by its bytes
//! (`LREM`, `LPOS`, Lua text comparison) is carried as the bytes that were read (data rule 6).
//!
//! The specification is `dima-rust/ledger/dragonfly.md` (flows, key families, reply
//! differences) and charter data rules 6 to 8. `tests/dragonfly_golden/record.mjs` records what
//! node-redis and the reference's Lua store; the golden tests pin the scripts and reply shapes.
//!
//! - [`config`]: [`DragonflyConfig`], the address built exactly as the reference builds it, and
//!   the timeout policy.
//! - [`client`]: [`Dragonfly`], the cloneable command handle on one multiplexed connection with
//!   reconnection and a response timeout.
//! - [`commands`]: typed helpers for the replies where node-redis and redis-rs differ, scored
//!   ranges, streams, counted pops and transactions with per-command results.
//! - [`blocking`]: [`BlockingConnection`], a cancel-safe dedicated connection for blocking commands.
//! - [`pubsub`]: [`Subscriber`] (bounded, deadline-driven, resubscribing; each subscription
//!   states its [`Overflow`] policy and may receive [`Event::Gap`]) and the JSON envelope.
//! - [`script`]: [`Script`], `EVALSHA` with the `EVAL` fallback; one `.lua` file per script;
//!   scripts with unbounded loops are refused before they are sent.
//! - [`queue`]: [`QueueItem`] and list / sorted-set queues that carry items as exact bytes; the
//!   unfenced processing-list helpers and [`FencedTransition`] for lease-checked transitions.
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
pub use pubsub::{Event, Gap, Message, Overflow, Subscriber, Subscription, Topic};
pub use queue::{
    DelayQueue, Fence, FencedTransition, ListQueue, ProcessingList, QueueItem, Transition,
};
pub use script::Script;
