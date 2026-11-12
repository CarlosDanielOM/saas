//! Ordered publication: a server FIFO position is reserved before async normalization.
//! Ticket/nonce/head checks and at most two-second server-time leases fence commit across
//! processes. Only a blocked successor waits (20ms coordination polling, max 100 polls).
//! Local gates include normalization/badge fetching, preventing local clears overtaking chat.
//! Concurrent processes have no common Twitch source order: order is Redis admission order.
//! Existing signal receipts are checked before admission. New receipts are created only
//! for admitted signals, fixing Node's unbounded day-long keys for rejected signals.
use super::{
    badges::Badges,
    model::{self, FeedError, FeedMessage, SignalInput},
};
use dima_core::{Clock, Random};
use dima_store::dragonfly::{Dragonfly, Overflow, Script, Subscriber, Subscription, Topic};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
/// Rust's server-wide channel name; logical Redis database does not isolate pubsub.
pub const CHANNEL: &str = "rust:widget-feed";
static PUBLISH: Script = Script::new("WIDGET_FEED_PUBLISH", include_str!("lua/publish.lua"));
static COUNT: Script = Script::new("WIDGET_SIGNAL_COUNT", include_str!("lua/count.lua"));
static RESERVE: Script = Script::new("WIDGET_FEED_RESERVE", include_str!("lua/reserve.lua"));
static ABANDON: Script = Script::new("WIDGET_FEED_ABANDON", include_str!("lua/abandon.lua"));
struct Ticket {
    index: i64,
    nonce: String,
}
/// Startup configuration; a prefix is useful for isolated store tests and must be shared
/// by all production producers/sessions (empty in production).
#[derive(Clone, Debug)]
pub struct FeedConfig {
    /// Prefix before rebuilt Dragonfly key names.
    pub key_prefix: String,
    /// Each publish, demand read/write or subscription operation, default two seconds.
    pub deadline: Duration,
    /// Simultaneous admitted calls, including waiting channel gates, at most 256.
    pub capacity: usize,
}
impl Default for FeedConfig {
    fn default() -> Self {
        Self {
            key_prefix: String::new(),
            deadline: Duration::from_secs(2),
            capacity: 256,
        }
    }
}
/// Publication never rejects the chat future; every failure/overload is a value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishResult {
    /// Atomically published (pubsub can have zero receivers).
    Sent,
    /// No active chat demand.
    NoDemand,
    /// This signal action was already seen in the 24-hour window.
    Duplicate,
    /// Admission or the 100 messages/channel/second bound was exhausted.
    Limited,
    /// Invalid input, backend failure, or deadline. A timed-out publish may have landed.
    Failed(FeedError),
}
/// Cloneable publisher. No hidden tasks; the ingress/cron owns each future.
#[derive(Clone)]
pub struct FeedPublisher {
    store: Dragonfly,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    badges: Arc<dyn Badges>,
    config: FeedConfig,
    gates: Arc<Mutex<BTreeMap<String, Weak<AsyncMutex<()>>>>>,
    capacity: Arc<Semaphore>,
}
impl FeedPublisher {
    /// Construct from startup resources. Capacity is clamped to 1–256.
    pub fn new(
        store: Dragonfly,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        badges: Arc<dyn Badges>,
        mut config: FeedConfig,
    ) -> Self {
        config.capacity = config.capacity.clamp(1, 256);
        config.deadline = config.deadline.min(Duration::from_secs(2));
        let capacity = Arc::new(Semaphore::new(config.capacity));
        Self {
            store,
            clock,
            random,
            badges,
            config,
            gates: Arc::new(Mutex::new(BTreeMap::new())),
            capacity,
        }
    }
    /// Shared rebuilt key family, also used by realtime's demand lease registry.
    pub fn key(&self, family: &str, channel: &str) -> String {
        format!("{}{family}:{channel}", self.config.key_prefix)
    }
    fn gate(&self, channel: &str) -> Result<Arc<AsyncMutex<()>>, FeedError> {
        let mut gates = self
            .gates
            .lock()
            .map_err(|_| FeedError("widget_feed_gate_failed"))?;
        if let Some(g) = gates.get(channel).and_then(Weak::upgrade) {
            return Ok(g);
        }
        gates.retain(|_, g| g.strong_count() > 0);
        if gates.len() >= 2000 {
            return Err(FeedError("widget_feed_channels_limit"));
        }
        let g = Arc::new(AsyncMutex::new(()));
        gates.insert(channel.into(), Arc::downgrade(&g));
        Ok(g)
    }
    async fn reserve(&self, channel: &str, demand: bool) -> Result<Ticket, PublishResult> {
        let nonce = self
            .random
            .uuid_v4()
            .map_err(|_| PublishResult::Failed(FeedError("widget_feed_random_failed")))?;
        let args = [
            nonce.clone(),
            self.config.deadline.as_millis().clamp(1, 2000).to_string(),
            if demand { "1" } else { "0" }.into(),
        ];
        let result = RESERVE
            .run::<Vec<i64>, _, _>(
                &self.store,
                &[
                    self.key("widget-feed:order", channel),
                    self.key("widget-feed:demand", channel),
                ],
                &args,
            )
            .await
            .map_err(|_| PublishResult::Failed(FeedError("widget_feed_store_failed")))?;
        match result.as_slice() {
            [1, index] => Ok(Ticket {
                index: *index,
                nonce,
            }),
            [0, _] => Err(PublishResult::NoDemand),
            [3, _] => Err(PublishResult::Limited),
            _ => Err(PublishResult::Failed(FeedError("widget_feed_store_failed"))),
        }
    }
    async fn abandon(&self, channel: &str, ticket: &Ticket) {
        let args = [ticket.index.to_string(), ticket.nonce.clone()];
        let _ = ABANDON
            .run::<i64, _, _>(
                &self.store,
                &[self.key("widget-feed:order", channel)],
                &args,
            )
            .await;
    }
    async fn send(
        &self,
        message: FeedMessage,
        action_key: Option<&str>,
        demand: bool,
        ticket: &Ticket,
    ) -> PublishResult {
        if let Err(e) = model::id(&message.channel) {
            return PublishResult::Failed(e);
        }
        if !matches!(
            message.kind.as_str(),
            "chat"
                | "chat.delete"
                | "chat.clear"
                | "signal"
                | "session.refresh"
                | "pet"
                | "duel"
                | "reward"
        ) {
            return PublishResult::Failed(FeedError("invalid_widget_feed_type"));
        }
        if action_key.is_some() && message.kind != "signal" {
            return PublishResult::Failed(FeedError("invalid_widget_signal_action_key"));
        }
        if action_key.is_some_and(|s| s.is_empty() || s.chars().count() > 256) {
            return PublishResult::Failed(FeedError("invalid_widget_signal_action_key"));
        }
        let payload =
            match dima_store::dragonfly::pubsub::envelope(&message, self.clock.now_ms() as f64) {
                Ok(p) if p.len() <= model::MAX_BYTES => p,
                _ => return PublishResult::Failed(FeedError("widget_feed_size_limit")),
            };
        let body = serde_json::to_value(&message).unwrap_or(Value::Null);
        if let Err(e) = model::bound(&body) {
            return PublishResult::Failed(e);
        }
        let channel = &message.channel;
        let keys = [
            self.key("widget-feed:rate", channel),
            self.key("widget-signal:rate", channel),
            self.key("widget-signal:skipped", channel),
            self.key("widget-signal:seen", action_key.unwrap_or("unused")),
            self.key("widget-feed:demand", channel),
            self.key("widget-feed:order", channel),
        ];
        let index = ticket.index.to_string();
        let args: [&[u8]; 7] = [
            &payload,
            CHANNEL.as_bytes(),
            if message.kind == "signal" { b"1" } else { b"0" },
            if action_key.is_some() { b"1" } else { b"0" },
            if demand { b"1" } else { b"0" },
            index.as_bytes(),
            ticket.nonce.as_bytes(),
        ];
        for _ in 0..100 {
            match PUBLISH.run::<i64, _, _>(&self.store, &keys, &args).await {
                Ok(1) => return PublishResult::Sent,
                Ok(0) => return PublishResult::NoDemand,
                Ok(2) => return PublishResult::Duplicate,
                Ok(3) => return PublishResult::Limited,
                Ok(4) => tokio::time::sleep(Duration::from_millis(20)).await,
                Ok(5) => return PublishResult::Failed(FeedError("widget_feed_ticket_expired")),
                _ => return PublishResult::Failed(FeedError("widget_feed_store_failed")),
            }
        }
        PublishResult::Failed(FeedError("widget_feed_deadline"))
    }
    /// Publish a bounded public bot event. Await or enqueue through a caller-owned bounded task;
    /// never detach an unbounded task per event. This method returns within `deadline`.
    pub async fn publish(&self, message: FeedMessage, action_key: Option<&str>) -> PublishResult {
        if let Err(e) = model::validate_message(&message) {
            return PublishResult::Failed(e);
        }
        let Ok(_permit) = self.capacity.clone().try_acquire_owned() else {
            return PublishResult::Limited;
        };
        let gate = match self.gate(&message.channel) {
            Ok(g) => g,
            Err(e) => return PublishResult::Failed(e),
        };
        match tokio::time::timeout(self.config.deadline, async {
            let _guard = gate.lock().await;
            let ticket = match self.reserve(&message.channel, false).await {
                Ok(t) => t,
                Err(result) => return result,
            };
            let channel = message.channel.clone();
            let result = self.send(message, action_key, false, &ticket).await;
            if matches!(result,PublishResult::Failed(FeedError(code)) if !matches!(code,"widget_feed_store_failed"|"widget_feed_deadline"|"widget_feed_ticket_expired")) {
                self.abandon(&channel, &ticket).await;
            }
            result
        })
        .await
        {
            Ok(r) => r,
            Err(_) => PublishResult::Failed(FeedError("widget_feed_deadline")),
        }
    }
    /// Chat/message-delete/clear ingress. The gate is acquired before badge lookup; failures are
    /// typed values and must be ignored or counted by the chat host, never propagated as chat errors.
    pub async fn chat(&self, channel: &str, kind: &str, event: &Value) -> PublishResult {
        if let Err(e) = model::id(channel).and_then(|()| model::bound(event)) {
            return PublishResult::Failed(e);
        }
        let Ok(_permit) = self.capacity.clone().try_acquire_owned() else {
            return PublishResult::Limited;
        };
        let gate = match self.gate(channel) {
            Ok(g) => g,
            Err(e) => return PublishResult::Failed(e),
        };
        let future = async {
            let _guard = gate.lock().await;
            let ticket = match self.reserve(channel, true).await {
                Ok(t) => t,
                Err(result) => return result,
            };
            let data = match kind {
                "chat" => match self.badges.lookup(channel).await {
                    Ok(b) => model::normalize_chat(event, &b, self.clock.now_ms()),
                    Err(e) => Err(e),
                },
                "chat.delete" => model::normalize_delete(event),
                "chat.clear" => model::normalize_clear(
                    if event.get("target_user_id").is_some() {
                        "channel.chat.clear_user_messages"
                    } else {
                        "channel.chat.clear"
                    },
                    event,
                ),
                _ => Err(FeedError("invalid_widget_chat_type")),
            };
            let result = match data {
                Ok(data) => {
                    self.send(
                        FeedMessage {
                            channel: channel.into(),
                            kind: kind.into(),
                            data,
                        },
                        None,
                        true,
                        &ticket,
                    )
                    .await
                }
                Err(e) => PublishResult::Failed(e),
            };
            if matches!(result,PublishResult::Failed(FeedError(code)) if !matches!(code,"widget_feed_store_failed"|"widget_feed_deadline"|"widget_feed_ticket_expired"))
            {
                self.abandon(channel, &ticket).await;
            }
            result
        };
        tokio::time::timeout(self.config.deadline, future)
            .await
            .unwrap_or(PublishResult::Failed(FeedError("widget_feed_deadline")))
    }
    /// Build and publish a command/Studio signal, preserving the reference's 30/10-second quota.
    pub async fn signal(
        &self,
        channel: &str,
        input: &SignalInput,
        action_key: Option<&str>,
    ) -> PublishResult {
        match model::build_signal(input, None, self.clock.now_ms(), self.random.as_ref()) {
            Ok(data) => {
                self.publish(
                    FeedMessage {
                        channel: channel.into(),
                        kind: "signal".into(),
                        data,
                    },
                    action_key,
                )
                .await
            }
            Err(e) => PublishResult::Failed(e),
        }
    }
    /// Studio admission before direct local delivery. Do not call before `signal`, which
    /// already admits atomically. `Ok(false)` maps to Studio's existing 429.
    pub async fn admit_signal(&self, channel: &str) -> Result<bool, FeedError> {
        model::id(channel)?;
        let future = async {
            let key = self.key("widget-signal:rate", channel);
            let count = COUNT
                .run::<i64, _, _>(&self.store, &[key], &["10"])
                .await
                .map_err(|_| FeedError("widget_feed_store_failed"))?;
            if count > 30 {
                self.count_skipped_inner(channel).await?;
                return Ok(false);
            }
            Ok(true)
        };
        tokio::time::timeout(self.config.deadline, future)
            .await
            .map_err(|_| FeedError("widget_feed_deadline"))?
    }
    async fn count_skipped_inner(&self, channel: &str) -> Result<(), FeedError> {
        COUNT
            .run::<i64, _, _>(
                &self.store,
                &[self.key("widget-signal:skipped", channel)],
                &["600"],
            )
            .await
            .map(|_| ())
            .map_err(|_| FeedError("widget_feed_store_failed"))
    }
    /// Host per-run budget drops are diagnostics only; errors never fail command execution.
    pub async fn count_skipped(&self, channel: &str) {
        if model::id(channel).is_ok() {
            let _ =
                tokio::time::timeout(self.config.deadline, self.count_skipped_inner(channel)).await;
        }
    }
    /// Diagnostic drop count, zero on a cache outage, matching Studio's best-effort diagnostics.
    pub async fn skipped_signals(&self, channel: &str) -> u64 {
        let read = async {
            self.store
                .get_text(&self.key("widget-signal:skipped", channel))
                .await
                .ok()
                .flatten()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        tokio::time::timeout(self.config.deadline, read)
            .await
            .unwrap_or(0)
    }
    /// Attach the one realtime subscriber to the shared feed. It owns the returned handle and
    /// receives `Event::Gap` on overflow or resubscription. Keep the `Subscriber` alive until shutdown.
    pub async fn subscribe(&self, subscriber: &Subscriber) -> Result<Subscription, FeedError> {
        tokio::time::timeout(
            self.config.deadline,
            subscriber.subscribe(Topic::Channel(CHANNEL.into()), Overflow::Gap),
        )
        .await
        .map_err(|_| FeedError("widget_feed_deadline"))?
        .map_err(|_| FeedError("widget_feed_subscribe_failed"))
    }
}
