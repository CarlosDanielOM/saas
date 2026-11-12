//! The pub/sub manager: JSON messages between the processes over Dragonfly pub/sub. Package
//! **P4-BOT-INGRESS**.
//!
//! TypeScript it ports (baseline `0c71108e`): `classes/pubsub_manager.class.ts` (107 lines,
//! `pubSubManager`). The bot, the API and the cron all load it, so it lives in the crate all
//! three link (lead's decision). The transport, the envelope and the overflow policy are
//! `dima_store::dragonfly::pubsub`'s; this is the reference's surface on top.
//!
//! | Reference | Here |
//! |---|---|
//! | `init()` (a publisher and a subscriber duplicated from the client) | [`PubSub::new`]: publishes on the command connection, subscribes on a connection of its own |
//! | `publish(channel, data)`: `{...data, timestamp: Date.now()}` as JSON | [`PubSub::publish`] |
//! | `subscribe(channel, handler)`: one handler per channel | [`PubSub::subscribe`] |
//! | `unsubscribe(channel)` | [`PubSub::unsubscribe`] |
//! | `publishClipRequest`, `subscribeToClipRequests` (`twitch:{id}:clip:request`) | [`PubSub::publish_clip_request`], [`PubSub::subscribe_to_clip_requests`] |
//!
//! # Channel names
//!
//! Channels are server-wide (they ignore the logical database), and Rust never shares one with
//! TypeScript (`MIGRATION.md` section 3): every name a caller gives is published and subscribed
//! as [`RUST_CHANNEL_PREFIX`] + name (`rust:tts:session-ended:v1`, `rust:widget-feed`,
//! `rust:twitch:{id}:clip:request`, `rust:keywords:changed`...), the convention
//! `dima_events::wakeups` set. Callers keep using the reference's names.
//!
//! # What is never lost silently
//!
//! Pub/sub is at most once. Each subscription states its [`Overflow`] policy (there is no
//! default): [`Overflow::Gap`] delivers [`Event::Gap`] in place of what was lost (a full buffer,
//! or messages published while the connection was down), so the subscriber resynchronises from
//! its source of truth; [`Overflow::DropNewest`] drops and counts, for samples and hints with a
//! fallback. Clip requests are `Gap`. Buffers are bounded (1,024 messages per subscription, at
//! most 10,000 subscriptions, 1 MiB per message: the store's limits).
//!
//! # Differences from the reference
//!
//! - Subscribing twice to one channel replaces the handler, as `subscriptions.set` intends; the
//!   reference also added a second node-redis listener, so the newest handler then ran twice per
//!   message (a Node quirk nothing depends on).
//! - A message that is not JSON is skipped and reported through the store's error hook; the
//!   reference's `JSON.parse` threw inside the listener.
//! - Errors are returned to the caller after being logged (`function: PubSubManager.publish`...),
//!   as the reference logs and rethrows.

use dima_core::Clock;
use dima_store::dragonfly::{Dragonfly, DragonflyError, Event, Overflow, Subscriber, Topic};
use dima_telemetry::{LogOptions, Telemetry};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

/// Prepended to every channel name (see the module documentation).
pub const RUST_CHANNEL_PREFIX: &str = "rust:";

/// The channel Rust uses for the reference's channel `name`.
pub fn channel_name(name: &str) -> String {
    format!("{RUST_CHANNEL_PREFIX}{name}")
}

/// `twitch:${channelID}:clip:request`.
pub fn clip_request_channel(channel_id: &str) -> String {
    format!("twitch:{channel_id}:clip:request")
}

/// `ClipRequestData`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ClipRequest {
    /// `clipID`.
    #[serde(rename = "clipID")]
    pub clip_id: String,
    /// `streamerLogin`.
    #[serde(rename = "streamerLogin")]
    pub streamer_login: String,
    /// `duration` (seconds).
    pub duration: f64,
    /// `clipUrl`.
    #[serde(rename = "clipUrl")]
    pub clip_url: String,
    /// `title`.
    pub title: String,
    /// `game`.
    pub game: String,
    /// `streamer`.
    pub streamer: String,
    /// `profileImage`.
    #[serde(rename = "profileImage")]
    pub profile_image: String,
    /// `description`.
    pub description: String,
    /// `streamerColor`.
    #[serde(rename = "streamerColor")]
    pub streamer_color: String,
    /// `timestamp`: replaced by the publication time when published, as the reference's
    /// envelope does.
    pub timestamp: f64,
}

/// The pub/sub manager (cheap to clone: one shared state).
#[derive(Clone)]
pub struct PubSub {
    inner: Arc<Inner>,
}

struct Inner {
    dragonfly: Dragonfly,
    subscriber: Subscriber,
    clock: Arc<dyn Clock>,
    telemetry: Option<Telemetry>,
    handlers: Mutex<HashMap<String, dima_store::dragonfly::pubsub::HandlerGuard>>,
}

impl std::fmt::Debug for PubSub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PubSub")
            .field("subscriber", &self.inner.subscriber)
            .field("channels", &self.channels())
            .finish()
    }
}

impl PubSub {
    /// `init()`: a subscriber connection of its own (started now; it must run inside a Tokio
    /// runtime) and publications on `dragonfly`'s command connection. Errors are logged through
    /// `telemetry` when given.
    pub fn new(dragonfly: Dragonfly, clock: Arc<dyn Clock>, telemetry: Option<Telemetry>) -> Self {
        let subscriber = dragonfly.subscriber();
        Self {
            inner: Arc::new(Inner {
                dragonfly,
                subscriber,
                clock,
                telemetry,
                handlers: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn log(&self, function: &str, channel: &str, error: &DragonflyError) {
        if let Some(telemetry) = &self.inner.telemetry {
            telemetry.error(
                &json!({ "function": function, "channel": channel, "error": error.to_string() }),
                LogOptions::console(),
            );
        }
    }

    /// `publish(channel, data)`: `{...data, timestamp: now}` on [`channel_name`]`(channel)`.
    /// `data` must serialise to a JSON object. The number of subscribers that received it.
    pub async fn publish<T: Serialize + ?Sized>(
        &self,
        channel: &str,
        data: &T,
    ) -> Result<i64, DragonflyError> {
        let now = self.inner.clock.now_ms() as f64;
        let name = channel_name(channel);
        let published = self
            .inner
            .dragonfly
            .publish_envelope(&name, data, now)
            .await;
        if let Err(error) = &published {
            self.log("PubSubManager.publish", channel, error);
        }
        published
    }

    /// `subscribe(channel, handler)`: runs `handler` for each message of `channel` (parsed as
    /// `T`) and for each gap of an [`Overflow::Gap`] subscription, one at a time, in order. A
    /// second subscription to the same channel replaces the first.
    pub async fn subscribe<T, F>(
        &self,
        channel: &str,
        overflow: Overflow,
        handler: F,
    ) -> Result<(), DragonflyError>
    where
        T: DeserializeOwned + Send + 'static,
        F: FnMut(Event<T>) + Send + 'static,
    {
        let subscribed = self
            .inner
            .subscriber
            .on_json(Topic::Channel(channel_name(channel)), overflow, handler)
            .await;
        match subscribed {
            Ok(guard) => {
                let replaced = self
                    .inner
                    .handlers
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(channel.to_owned(), guard);
                // The store already replaced the subscription; dropping the old guard only stops
                // its task.
                drop(replaced);
                Ok(())
            }
            Err(error) => {
                self.log("PubSubManager.subscribe", channel, &error);
                Err(error)
            }
        }
    }

    /// `unsubscribe(channel)`: stops the handler and unsubscribes.
    pub fn unsubscribe(&self, channel: &str) {
        let removed = self
            .inner
            .handlers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(channel);
        drop(removed);
    }

    /// The channels with a handler (the reference's names), sorted.
    pub fn channels(&self) -> Vec<String> {
        let mut channels: Vec<String> = self
            .inner
            .handlers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        channels.sort();
        channels
    }

    /// `publishClipRequest(channelID, clipData)`.
    pub async fn publish_clip_request(
        &self,
        channel_id: &str,
        clip: &ClipRequest,
    ) -> Result<i64, DragonflyError> {
        self.publish(&clip_request_channel(channel_id), clip).await
    }

    /// `subscribeToClipRequests(channelID, handler)`, with gaps reported: a lost clip request
    /// is work, so the subscriber must resynchronise.
    pub async fn subscribe_to_clip_requests<F>(
        &self,
        channel_id: &str,
        handler: F,
    ) -> Result<(), DragonflyError>
    where
        F: FnMut(Event<ClipRequest>) + Send + 'static,
    {
        self.subscribe(&clip_request_channel(channel_id), Overflow::Gap, handler)
            .await
    }

    /// Stops every handler and closes the subscriber connection.
    pub async fn shutdown(self) {
        let handlers = std::mem::take(
            &mut *self
                .inner
                .handlers
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        drop(handlers);
        if let Ok(inner) = Arc::try_unwrap(self.inner) {
            inner.subscriber.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_channels_never_share_a_name_with_typescript() {
        assert_eq!(
            channel_name("tts:session-ended:v1"),
            "rust:tts:session-ended:v1"
        );
        assert_eq!(clip_request_channel("1001"), "twitch:1001:clip:request");
        assert_eq!(
            channel_name(&clip_request_channel("1001")),
            "rust:twitch:1001:clip:request"
        );
    }

    #[test]
    fn clip_requests_keep_the_reference_field_names() {
        let clip = ClipRequest {
            clip_id: "c".into(),
            duration: 30.0,
            ..ClipRequest::default()
        };
        let json = serde_json::to_value(&clip).unwrap_or_default();
        let keys: Vec<&str> = json
            .as_object()
            .map(|map| map.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            keys,
            [
                "clipID",
                "streamerLogin",
                "duration",
                "clipUrl",
                "title",
                "game",
                "streamer",
                "profileImage",
                "description",
                "streamerColor",
                "timestamp"
            ]
        );
    }
}
