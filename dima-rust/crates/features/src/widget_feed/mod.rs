//! Bounded custom-widget feed without sockets (P4-FEAT-WIDGETS).
//!
//! Ingress calls `FeedPublisher::chat`; commands call `signal`; bot producers use
//! `publish` with the pure pet/duel/session constructors. Callers own and await futures:
//! failures are values, never exceptions on the chat path. The realtime package owns
//! routing and resynchronization; `subscribe` uses the store's `Overflow::Gap`, so a
//! session receives `Event::Gap { overflowed, resubscribed }` and should invalidate its
//! transient display/reload authoritative session state rather than assume continuity.
//! A gap on this shared topic has no channel attribution: realtime should resync all
//! sessions served by that subscription. Ephemeral chat cannot be recovered completely.
//!
//! Channel gates cover badge lookup through publish. Dragonfly reserves one of at most
//! 64 FIFO positions before asynchronous normalization; commit atomically checks its
//! ticket/nonce, server-time lease and queue head. This orders independent bot processes
//! too. Abandoned positions expire within two seconds. Only waiting successors poll
//! (20 ms coordination wait, max 100 attempts); no ready work is deliberately delayed.
//! Concurrent sources are ordered at reservation, not by Twitch timestamps.
//! Channels are `rust:widget-feed`. Keys are rebuilt; test prefixes isolate all keys.
//! The optional bounded outbox implements the existing duel-event trait; startup owns its
//! worker and calls flush before shutdown. Signal admission deliberately avoids the reference
//! bug that allocated day-long dedupe keys even for rejected signals. Demand is checked
//! directly instead of caching absence for five seconds.
//! Scalar-value text limits follow MIGRATION.md; extra metadata and message bounds are
//! explicit in `model`. No environment is read and no worker/task is spawned here.
pub mod badges;
pub mod outbox;
pub use outbox::{FeedOutbox, FeedWorker, PublishReceipt};
pub mod model;
pub mod publisher;
pub mod subscriptions;
pub use model::{
    FeedError, FeedMessage, SignalInput, build_signal, duel_event, normalize_chat, normalize_clear,
    normalize_delete, pet_event, replay_chat, session_refresh,
};
pub use publisher::{FeedConfig, FeedPublisher, PublishResult};

/// Server-wide Rust pubsub channel (Redis logical databases do not isolate it).
pub const WIDGET_FEED_CHANNEL: &str = publisher::CHANNEL;
/// Unprefixed rebuilt demand key; startup/test prefixes are applied by the publisher/lease registry.
pub fn widget_feed_demand_key(channel: &str) -> String {
    format!("widget-feed:demand:{channel}")
}
