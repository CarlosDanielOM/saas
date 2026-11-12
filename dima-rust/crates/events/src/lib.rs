//! The durable domain event journal: when something happens (a Twitch EventSub notification, a
//! Polar billing webhook, a custom goal contribution), a producer writes one event to MongoDB,
//! exactly once however many times the outside world delivers it, and consumers act on it later.
//! It also holds the durable cron-job intents that hand work from the API and the bot to the
//! cron workers.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`. The reference is the
//! TypeScript at commit `0c71108e`: `dimabot/src/domain_events/*` and the journal utilities in
//! `dimabot/src/utils/` (each module names its files).
//!
//! - [`contracts`]: every event type, its envelope, the contract validator, the delivery policy
//!   of every consumer.
//! - [`identity`]: the stored identities (event key, receipt ids, intent keys) and the owner of an
//!   event.
//! - [`producers`]: Twitch, Polar and custom goal notifications to events, and the journal append.
//! - [`dispatch`]: the fan-out of journaled events into one delivery per consumer.
//! - [`wakeups`]: the hint that tells consumers there is work, and why losing it only delays it.
//! - [`health`]: the admin page's journal health report.
//! - [`jobs`]: durable cron-job intents on the store's cron queue.
//! - [`value`]: JavaScript-shaped values (payloads, metadata, SDK data).
//! - [`store`]: deadlines and errors of every store call.
//! - [`config`]: typed configuration.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod config;
pub mod contracts;
pub mod dispatch;
pub mod envelope;
pub mod identity;
pub mod jobs;
pub mod producers;
pub mod store;
pub mod value;
pub mod wakeups;
