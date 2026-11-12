//! Publish/subscribe: a raw subscriber with its own connection, and the pub/sub manager's JSON
//! envelope on top.
//!
//! # Raw layer
//!
//! A [`Subscriber`] owns one connection in subscribe mode and a background task. Each
//! [`Subscription`] (a channel or a pattern) receives [`Event`]s through its own bounded buffer
//! ([`super::DragonflyConfig::subscription_buffer`] messages). The reader task never waits for a
//! slow consumer, so one slow subscription cannot stall the others.
//!
//! # Overflow policy
//!
//! Pub/sub is at most once: a message is lost when a buffer is full or while the connection is
//! down. Every subscription states what it does about that ([`Overflow`]; there is no default):
//!
//! - [`Overflow::DropNewest`]: a message that finds the buffer full is dropped and counted
//!   ([`Subscription::dropped`]); nothing tells the consumer. For **samples replaced by the next
//!   one** and **wake-up hints with a fallback**: `domain-events:wakeup:v1` and
//!   `pet:runtime:wake:v1` (an undelivered wake-up is already in the buffer, and Mongo polling
//!   covers the rest).
//! - [`Overflow::Gap`]: nothing is lost silently. The subscription delivers an [`Event::Gap`] in
//!   place of what was lost (consecutive losses merge into one marker), then carries on; the
//!   consumer resynchronises from the source of truth. For **channels whose messages are state
//!   or work**: `widget-feed` (chat deletions and clears, terminal states: a missed one leaves a
//!   widget on screen for ever, `overlays/live.ts:278`), `twitch:{id}:clip:request`,
//!   `tts:session-ended:v1`, and invalidations such as `keywords:changed` (resync: drop the cached
//!   index). When unsure, choose `Gap`.
//!
//! A full `Gap` buffer holds at most one marker beyond its messages, so the bound is
//! `subscription_buffer + 1` events whatever the policy.
//!
//! # Connection
//!
//! - **Reconnect**: when the connection drops, the task reconnects with back-off
//!   (`min(50 ms × 2^attempt, 2 s)`, node-redis 5's default strategy without its random jitter) and
//!   subscribes again to every channel and pattern, as node-redis does. Messages published while it
//!   was disconnected are lost; a `Gap` subscription gets an [`Event::Gap`] with
//!   [`Gap::resubscribed`] set when it is subscribed again, and so does one that was registered
//!   while disconnected ([`Subscription::confirmed`] `false`) once it is live.
//! - **One handler per channel**: subscribing to a topic that already has a subscription replaces
//!   it (the old subscription's stream ends), mirroring the reference's `Map.set(channel, handler)`.
//!   Dropping a [`Subscription`] unsubscribes (only if it is still the current one).
//! - **Shutdown**: dropping the [`Subscriber`] (or [`Subscriber::shutdown`]) stops the task and
//!   closes the connection; every subscription's stream then ends.
//!
//! The driver beneath (redis-rs `PubSub`) moves messages from the socket into an unbounded queue
//! that this task drains without ever waiting on a consumer, so that queue stays short.
//!
//! # Envelope layer
//!
//! The reference's `PubSubManager.publish(channel, data)` sends `{...data, timestamp: now}` as
//! JSON and its subscribers parse each message and hand the value to the handler. [`envelope`]
//! builds that object, [`parse_envelope`] reads it, [`Subscriber::on_json`] runs a handler per
//! message. Only Rust publishes and subscribes after the cutover (and every Rust channel name
//! differs from the TypeScript one), so the bytes are Rust's own encoding; the shape (the spread
//! keys plus `timestamp`) is what subscribers read. Raw publishers (`keywords:changed`, the
//! domain-event wake-ups) add no envelope: use [`super::Dragonfly::publish`] with their payload.

use super::client::{Dragonfly, Shared};
use super::error::{DragonflyError, Result};
use dima_text::{js_key_order, sanitize_lone_surrogates, to_js_json};
use futures_util::StreamExt;
use redis::ConnectionAddr;
use redis::aio::{PubSub, PubSubSink};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;

/// Bound on queued subscribe/unsubscribe requests to the subscriber task.
const CONTROL_BUFFER: usize = 64;

/// A channel or a pattern.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Topic {
    /// `SUBSCRIBE channel`.
    Channel(String),
    /// `PSUBSCRIBE pattern`.
    Pattern(String),
}

/// One received message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    /// The channel it was published to (bytes: a pattern can match any channel name).
    pub channel: Vec<u8>,
    /// The pattern that matched, for a pattern subscription.
    pub pattern: Option<String>,
    /// The payload, exactly as published.
    pub payload: Vec<u8>,
}

/// What a subscription does when its buffer is full (see the module docs). Every subscription
/// chooses; there is no default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    /// Drop the new message and count it ([`Subscription::dropped`]). For samples replaced by
    /// the next one and hints with a fallback.
    DropNewest,
    /// Deliver an [`Event::Gap`] in place of what was lost, so the consumer resynchronises.
    Gap,
}

/// Messages were lost here: resynchronise from the source of truth.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Gap {
    /// Messages dropped because the buffer was full (0 when only a resubscription happened).
    pub overflowed: u64,
    /// The subscription was made again on a new connection (or for the first time after being
    /// registered while disconnected): anything published while it was not subscribed is lost,
    /// how much is unknown.
    pub resubscribed: bool,
}

/// What a subscription delivers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event<T = Message> {
    /// One message.
    Message(T),
    /// Messages were lost at this point (only for [`Overflow::Gap`] subscriptions).
    Gap(Gap),
}

/// A subscription's buffer: at most `capacity` messages plus one trailing gap marker.
struct Inbox {
    state: Mutex<InboxState>,
    notify: Notify,
    dropped: AtomicU64,
    capacity: usize,
    overflow: Overflow,
}

#[derive(Default)]
struct InboxState {
    events: VecDeque<Event>,
    sender_closed: bool,
    receiver_closed: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Push {
    Delivered,
    Dropped,
    Closed,
}

impl Inbox {
    fn new(capacity: usize, overflow: Overflow) -> Self {
        Self {
            state: Mutex::new(InboxState::default()),
            notify: Notify::new(),
            dropped: AtomicU64::new(0),
            capacity: capacity.max(1),
            overflow,
        }
    }

    fn lock(&self) -> MutexGuard<'_, InboxState> {
        // Nothing panics while the lock is held; a poisoned lock still holds valid state.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push_message(&self, message: Message) -> Push {
        let pushed = {
            let mut state = self.lock();
            if state.receiver_closed {
                return Push::Closed;
            }
            if state.events.len() < self.capacity {
                state.events.push_back(Event::Message(message));
                Push::Delivered
            } else {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                if self.overflow == Overflow::Gap {
                    match state.events.back_mut() {
                        Some(Event::Gap(gap)) => gap.overflowed = gap.overflowed.saturating_add(1),
                        _ => state.events.push_back(Event::Gap(Gap {
                            overflowed: 1,
                            resubscribed: false,
                        })),
                    }
                }
                Push::Dropped
            }
        };
        self.notify.notify_one();
        pushed
    }

    /// For a `Gap` subscription that just became live on a new connection.
    fn push_resubscribed(&self) -> Push {
        if self.overflow != Overflow::Gap {
            return Push::Delivered;
        }
        {
            let mut state = self.lock();
            if state.receiver_closed {
                return Push::Closed;
            }
            match state.events.back_mut() {
                Some(Event::Gap(gap)) => gap.resubscribed = true,
                _ => state.events.push_back(Event::Gap(Gap {
                    overflowed: 0,
                    resubscribed: true,
                })),
            }
        }
        self.notify.notify_one();
        Push::Delivered
    }

    fn close_sender(&self) {
        self.lock().sender_closed = true;
        self.notify.notify_one();
    }

    fn close_receiver(&self) {
        let mut state = self.lock();
        state.receiver_closed = true;
        state.events.clear();
    }

    async fn recv(&self) -> Option<Event> {
        loop {
            // `notify_one` stores a permit when nobody waits, so a push between the check and
            // the await is not missed.
            let notified = self.notify.notified();
            {
                let mut state = self.lock();
                if let Some(event) = state.events.pop_front() {
                    return Some(event);
                }
                if state.sender_closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

enum Control {
    Subscribe {
        topic: Topic,
        entry: Entry,
        ack: oneshot::Sender<bool>,
    },
    Unsubscribe {
        topic: Topic,
        id: u64,
    },
    Shutdown {
        ack: oneshot::Sender<()>,
    },
}

struct Entry {
    id: u64,
    inbox: Arc<Inbox>,
    /// Set when the subscription was not live on the server for a while (registered while
    /// disconnected, or the connection was lost): a `Gap` subscription gets a marker once it is
    /// live again.
    owe_gap: bool,
}

impl Drop for Entry {
    fn drop(&mut self) {
        // Replaced, unsubscribed, or the subscriber stopped: the stream ends after its buffer.
        self.inbox.close_sender();
    }
}

#[derive(Default)]
struct State {
    connection_id: AtomicI64,
    connections: AtomicU64,
    next_id: AtomicU64,
}

/// A subscriber: one connection in subscribe mode, owned by a background task.
pub struct Subscriber {
    control: mpsc::Sender<Control>,
    state: Arc<State>,
    buffer: usize,
    task: JoinHandle<()>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Subscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscriber")
            .field("connection_id", &self.connection_id())
            .field("connections", &self.connections())
            .finish()
    }
}

impl Drop for Subscriber {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A live subscription: a stream of messages for one topic.
pub struct Subscription {
    topic: Topic,
    id: u64,
    confirmed: bool,
    inbox: Arc<Inbox>,
    control: mpsc::Sender<Control>,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("topic", &self.topic)
            .field("overflow", &self.inbox.overflow)
            .field("confirmed", &self.confirmed)
            .field("dropped", &self.dropped())
            .finish()
    }
}

impl Subscription {
    /// The next event; `None` once the subscription was replaced or the subscriber stopped (after
    /// what was already buffered).
    pub async fn recv(&mut self) -> Option<Event> {
        self.inbox.recv().await
    }

    /// The overflow policy it was made with.
    pub fn overflow(&self) -> Overflow {
        self.inbox.overflow
    }

    /// The topic.
    pub fn topic(&self) -> &Topic {
        &self.topic
    }

    /// `true` when the server confirmed the subscription before [`Subscriber::subscribe`]
    /// returned; `false` when the subscriber was disconnected and will subscribe on reconnect.
    pub fn confirmed(&self) -> bool {
        self.confirmed
    }

    /// Messages dropped because this subscription's buffer was full (for a `Gap` subscription
    /// they were also reported through [`Event::Gap`]).
    pub fn dropped(&self) -> u64 {
        self.inbox.dropped.load(Ordering::Relaxed)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.inbox.close_receiver();
        // If the control buffer is full the task notices the closed receiver on the next message
        // for this topic and unsubscribes then.
        let _ = self.control.try_send(Control::Unsubscribe {
            topic: self.topic.clone(),
            id: self.id,
        });
    }
}

impl Subscriber {
    pub(crate) fn start(shared: Arc<Shared>) -> Self {
        let (control, receiver) = mpsc::channel(CONTROL_BUFFER);
        let state = Arc::new(State::default());
        let task = tokio::spawn(run(shared.clone(), receiver, state.clone()));
        Self {
            control,
            buffer: shared.config.subscription_buffer.max(1),
            state,
            task,
            shared,
        }
    }

    /// Subscribes to a topic with an overflow policy (see the module docs for which fits which
    /// channel). Returns once the server confirmed it, or at once when the subscriber is
    /// reconnecting (the subscription is then made on reconnect; see
    /// [`Subscription::confirmed`]).
    pub async fn subscribe(&self, topic: Topic, overflow: Overflow) -> Result<Subscription> {
        let inbox = Arc::new(Inbox::new(self.buffer, overflow));
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (ack, confirmed) = oneshot::channel();
        self.control
            .send(Control::Subscribe {
                topic: topic.clone(),
                entry: Entry {
                    id,
                    inbox: inbox.clone(),
                    owe_gap: false,
                },
                ack,
            })
            .await
            .map_err(|_| DragonflyError::SubscriberClosed)?;
        let confirmed = confirmed
            .await
            .map_err(|_| DragonflyError::SubscriberClosed)?;
        Ok(Subscription {
            topic,
            id,
            confirmed,
            inbox,
            control: self.control.clone(),
        })
    }

    /// Runs `handler` for every message of `topic` parsed as the envelope's JSON (see
    /// [`parse_envelope`]), and for every [`Event::Gap`] of a `Gap` subscription. A payload that is
    /// not JSON of type `T` is skipped and reported (the reference's `JSON.parse` throws inside its
    /// listener). Events are handled one at a time, in order. Dropping the returned guard stops
    /// the handler and unsubscribes.
    pub async fn on_json<T, F>(
        &self,
        topic: Topic,
        overflow: Overflow,
        handler: F,
    ) -> Result<HandlerGuard>
    where
        T: DeserializeOwned + Send + 'static,
        F: FnMut(Event<T>) + Send + 'static,
    {
        let mut subscription = self.subscribe(topic, overflow).await?;
        let shared = self.shared.clone();
        let mut handler = handler;
        let task = tokio::spawn(async move {
            while let Some(event) = subscription.recv().await {
                let message = match event {
                    Event::Message(message) => message,
                    Event::Gap(gap) => {
                        handler(Event::Gap(gap));
                        continue;
                    }
                };
                match parse_envelope::<T>(&message.payload) {
                    Ok(value) => handler(Event::Message(value)),
                    Err(error) => {
                        if let DragonflyError::Decode(decode) = &error {
                            shared
                                .hooks
                                .report_payload_error(&shared.config.caller, decode);
                        }
                    }
                }
            }
        });
        Ok(HandlerGuard { task })
    }

    /// The server's id for the current connection (`CLIENT ID`), 0 while disconnected.
    pub fn connection_id(&self) -> i64 {
        self.state.connection_id.load(Ordering::Relaxed)
    }

    /// How many connections the subscriber has opened so far (1 + reconnections).
    pub fn connections(&self) -> u64 {
        self.state.connections.load(Ordering::Relaxed)
    }

    /// Stops the task and closes the connection; waits until it has stopped.
    pub async fn shutdown(self) {
        let (ack, done) = oneshot::channel();
        if self.control.send(Control::Shutdown { ack }).await.is_ok() {
            let _ = done.await;
        }
    }
}

/// Keeps a handler running; dropping it stops the handler and unsubscribes.
#[derive(Debug)]
pub struct HandlerGuard {
    task: JoinHandle<()>,
}

impl Drop for HandlerGuard {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `{...data, timestamp: now_ms}` as compact JSON: the envelope's message bytes (Rust's own
/// encoding, see the module docs).
///
/// `data` must serialise to a JSON object (the reference's parameter type is `object`). Spread
/// semantics are kept: keys in `data`'s order, array-index keys first; a `timestamp` that `data`
/// already has keeps its position and takes the new value (clip requests carry one).
pub fn envelope<T: Serialize + ?Sized>(data: &T, now_ms: f64) -> Result<Vec<u8>> {
    let mut value = serde_json::to_value(data)?;
    let Value::Object(map) = &mut value else {
        return Err(DragonflyError::Reply(
            "pub/sub envelope data must be a JSON object",
        ));
    };
    let timestamp = serde_json::Number::from_f64(now_ms).map_or(Value::Null, Value::Number);
    map.insert("timestamp".to_owned(), timestamp);
    js_key_order(&mut value);
    Ok(to_js_json(&value).into_bytes())
}

/// `JSON.parse(message)` into `T`, lone surrogate escapes replaced first (text rule 3). A
/// failure is a [`DragonflyError::Decode`]: category and position, never the payload's text.
pub fn parse_envelope<T: DeserializeOwned>(payload: &[u8]) -> Result<T> {
    super::error::decode(&sanitize_lone_surrogates(payload))
}

impl Dragonfly {
    /// `PubSubManager.publish(channel, data)`: publishes [`envelope`]`(data, now_ms)`.
    pub async fn publish_envelope<T: Serialize + ?Sized>(
        &self,
        channel: &str,
        data: &T,
        now_ms: f64,
    ) -> Result<i64> {
        self.publish(channel, &envelope(data, now_ms)?).await
    }
}

impl super::hooks::Hooks {
    /// Reports a payload that did not decode: the fixed category and the position only.
    fn report_payload_error(&self, caller: &str, error: &super::error::DecodeError) {
        if let Some(hook) = &self.errors {
            let error = redis::RedisError::from(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("pub/sub {error}"),
            ));
            hook.connection_error(&super::hooks::ConnectionError {
                caller,
                code: "InvalidData".to_owned(),
                error: &error,
            });
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(50u64.saturating_mul(1u64 << attempt.min(16)).min(2000))
}

async fn run(shared: Arc<Shared>, mut control: mpsc::Receiver<Control>, state: Arc<State>) {
    let mut entries: HashMap<Topic, Entry> = HashMap::new();
    let mut attempt = 0_u32;
    loop {
        // Connect (and subscribe to everything registered), serving requests while waiting.
        let (mut sink, mut stream) = loop {
            match connect(&shared).await {
                Ok((pubsub, id)) => {
                    let (mut sink, stream) = pubsub.split();
                    match resubscribe(&mut sink, &entries).await {
                        Ok(()) => {
                            state.connection_id.store(id, Ordering::Relaxed);
                            state.connections.fetch_add(1, Ordering::Relaxed);
                            attempt = 0;
                            entries.retain(|_, entry| {
                                if std::mem::take(&mut entry.owe_gap) {
                                    entry.inbox.push_resubscribed() != Push::Closed
                                } else {
                                    true
                                }
                            });
                            break (sink, stream);
                        }
                        Err(error) => shared.hooks.report(&shared.config.caller, &error),
                    }
                }
                Err(error) => shared.hooks.report(&shared.config.caller, &error),
            }
            let sleep = tokio::time::sleep(backoff(attempt));
            attempt = attempt.saturating_add(1);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    () = &mut sleep => break,
                    request = control.recv() => match request {
                        None => return,
                        Some(Control::Shutdown { ack }) => {
                            let _ = ack.send(());
                            return;
                        }
                        Some(Control::Subscribe { topic, mut entry, ack }) => {
                            entry.owe_gap = true;
                            entries.insert(topic, entry);
                            let _ = ack.send(false);
                        }
                        Some(Control::Unsubscribe { topic, id }) => {
                            if entries.get(&topic).is_some_and(|entry| entry.id == id) {
                                entries.remove(&topic);
                            }
                        }
                    },
                }
            }
        };

        // Connected: deliver messages and serve requests until the connection drops.
        loop {
            tokio::select! {
                request = control.recv() => match request {
                    None => return,
                    Some(Control::Shutdown { ack }) => {
                        drop((sink, stream));
                        let _ = ack.send(());
                        return;
                    }
                    Some(Control::Subscribe { topic, mut entry, ack }) => {
                        // Replacing a live topic keeps the server subscription: the new
                        // subscription is live at once.
                        entry.owe_gap = false;
                        let fresh = entries.insert(topic.clone(), entry).is_none();
                        let result = if fresh { subscribe(&mut sink, &topic).await } else { Ok(()) };
                        let confirmed = result.is_ok();
                        let _ = ack.send(confirmed);
                        if let Err(error) = result {
                            shared.hooks.report(&shared.config.caller, &error);
                            break;
                        }
                    }
                    Some(Control::Unsubscribe { topic, id }) => {
                        if entries.get(&topic).is_some_and(|entry| entry.id == id) {
                            entries.remove(&topic);
                            if let Err(error) = unsubscribe(&mut sink, &topic).await {
                                shared.hooks.report(&shared.config.caller, &error);
                                break;
                            }
                        }
                    }
                },
                message = stream.next() => match message {
                    None => {
                        let error = redis::RedisError::from(std::io::Error::new(
                            std::io::ErrorKind::ConnectionReset,
                            "Dragonfly subscriber connection closed",
                        ));
                        shared.hooks.report(&shared.config.caller, &error);
                        break;
                    }
                    Some(message) => {
                        if let Some(topic) = deliver(&message, &mut entries)
                            && let Err(error) = unsubscribe(&mut sink, &topic).await
                        {
                            shared.hooks.report(&shared.config.caller, &error);
                            break;
                        }
                    }
                },
            }
        }
        state.connection_id.store(0, Ordering::Relaxed);
        for entry in entries.values_mut() {
            entry.owe_gap = true;
        }
    }
}

/// Hands one message to its subscription. Returns a topic whose subscription is gone (its
/// receiver was dropped without the unsubscribe request getting through) so the caller can
/// unsubscribe it.
fn deliver(message: &redis::Msg, entries: &mut HashMap<Topic, Entry>) -> Option<Topic> {
    let channel: Vec<u8> = message.get_channel().unwrap_or_default();
    let pattern: Option<Vec<u8>> = message.get_pattern().unwrap_or_default();
    let topic = match &pattern {
        Some(pattern) => Topic::Pattern(String::from_utf8(pattern.clone()).ok()?),
        None => Topic::Channel(String::from_utf8(channel.clone()).ok()?),
    };
    let entry = entries.get(&topic)?;
    let outgoing = Message {
        channel,
        pattern: match topic {
            Topic::Pattern(ref pattern) => Some(pattern.clone()),
            Topic::Channel(_) => None,
        },
        payload: message.get_payload_bytes().to_vec(),
    };
    match entry.inbox.push_message(outgoing) {
        Push::Delivered | Push::Dropped => None,
        Push::Closed => {
            entries.remove(&topic);
            Some(topic)
        }
    }
}

async fn subscribe(sink: &mut PubSubSink, topic: &Topic) -> redis::RedisResult<()> {
    match topic {
        Topic::Channel(channel) => sink.subscribe(channel).await,
        Topic::Pattern(pattern) => sink.psubscribe(pattern).await,
    }
}

async fn unsubscribe(sink: &mut PubSubSink, topic: &Topic) -> redis::RedisResult<()> {
    match topic {
        Topic::Channel(channel) => sink.unsubscribe(channel).await,
        Topic::Pattern(pattern) => sink.punsubscribe(pattern).await,
    }
}

async fn resubscribe(
    sink: &mut PubSubSink,
    entries: &HashMap<Topic, Entry>,
) -> redis::RedisResult<()> {
    for topic in entries.keys() {
        subscribe(sink, topic).await?;
    }
    Ok(())
}

/// Opens the subscriber connection on a socket of our own, so it can learn its `CLIENT ID` (for
/// diagnostics and tests) before the connection switches to subscribe mode.
async fn connect(shared: &Shared) -> redis::RedisResult<(PubSub, i64)> {
    let info = shared.client.get_connection_info();
    let ConnectionAddr::Tcp(host, port) = info.addr() else {
        return Err(redis::RedisError::from((
            redis::ErrorKind::InvalidClientConfig,
            "subscriber needs a TCP address",
        )));
    };
    let open = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), *port)).await?;
        stream.set_nodelay(true)?;
        let id = client_id(&mut stream).await?;
        let pubsub = PubSub::new(info.redis_settings(), stream).await?;
        Ok::<_, redis::RedisError>((pubsub, id))
    };
    match tokio::time::timeout(shared.config.connect_timeout, open).await {
        Ok(result) => result,
        Err(_) => Err(redis::RedisError::from(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Dragonfly subscriber connection did not open within the connect timeout",
        ))),
    }
}

/// `CLIENT ID` over the raw socket: the request, then one `:<integer>\r\n` reply.
async fn client_id(stream: &mut tokio::net::TcpStream) -> std::io::Result<i64> {
    stream
        .write_all(b"*2\r\n$6\r\nCLIENT\r\n$2\r\nID\r\n")
        .await?;
    let mut line = Vec::with_capacity(24);
    loop {
        let byte = stream.read_u8().await?;
        line.push(byte);
        if line.ends_with(b"\r\n") {
            break;
        }
        if line.len() > 32 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "CLIENT ID reply too long",
            ));
        }
    }
    let digits = line
        .strip_prefix(b":")
        .and_then(|rest| rest.strip_suffix(b"\r\n"))
        .and_then(|digits| std::str::from_utf8(digits).ok())
        .and_then(|digits| digits.parse::<i64>().ok());
    digits.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unexpected CLIENT ID reply",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_spreads_and_appends_timestamp() {
        let bytes = envelope(
            &json!({"channelID": "1", "session": "s"}),
            1_700_000_000_123.0,
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"channelID":"1","session":"s","timestamp":1700000000123}"#
        );
    }

    #[test]
    fn envelope_keeps_an_existing_timestamp_in_place() {
        let bytes = envelope(&json!({"clipID": "c", "timestamp": 1, "title": "t"}), 5.0).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"clipID":"c","timestamp":5,"title":"t"}"#
        );
    }

    #[test]
    fn envelope_moves_index_keys_first_like_a_spread() {
        let bytes = envelope(&json!({"b": 1, "7": 2, "a": 3}), 0.0).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"7":2,"b":1,"a":3,"timestamp":0}"#
        );
    }

    #[test]
    fn envelope_refuses_non_objects() {
        assert!(envelope(&json!([1, 2]), 0.0).is_err());
        assert!(envelope(&"text", 0.0).is_err());
    }

    #[test]
    fn parse_envelope_accepts_what_json_parse_accepts() {
        let value: Value = parse_envelope(br#"{"t":"\udc00"}"#).unwrap();
        assert_eq!(value["t"], "\u{fffd}");
        assert!(parse_envelope::<Value>(b"not json").is_err());
    }

    fn message(n: u64) -> Message {
        Message {
            channel: b"c".to_vec(),
            pattern: None,
            payload: n.to_string().into_bytes(),
        }
    }

    fn drain(inbox: &Inbox) -> Vec<Event> {
        inbox.lock().events.drain(..).collect()
    }

    #[test]
    fn drop_newest_keeps_the_oldest_and_counts() {
        let inbox = Inbox::new(2, Overflow::DropNewest);
        for n in 0..5 {
            inbox.push_message(message(n));
        }
        assert_eq!(
            drain(&inbox),
            vec![Event::Message(message(0)), Event::Message(message(1))]
        );
        assert_eq!(inbox.dropped.load(Ordering::Relaxed), 3);
        assert_eq!(inbox.push_resubscribed(), Push::Delivered);
        assert!(drain(&inbox).is_empty(), "no markers for DropNewest");
    }

    #[test]
    fn gap_replaces_what_was_lost_and_merges() {
        let inbox = Inbox::new(2, Overflow::Gap);
        for n in 0..5 {
            inbox.push_message(message(n));
        }
        inbox.push_resubscribed();
        let events = drain(&inbox);
        assert_eq!(
            events,
            vec![
                Event::Message(message(0)),
                Event::Message(message(1)),
                Event::Gap(Gap {
                    overflowed: 3,
                    resubscribed: true
                })
            ]
        );
        // After a resubscription on an empty buffer the marker comes first.
        inbox.push_resubscribed();
        inbox.push_message(message(9));
        assert_eq!(
            drain(&inbox),
            vec![
                Event::Gap(Gap {
                    overflowed: 0,
                    resubscribed: true
                }),
                Event::Message(message(9))
            ]
        );
    }

    #[test]
    fn the_buffer_never_holds_more_than_capacity_plus_one() {
        for capacity in [1, 2, 5] {
            let inbox = Inbox::new(capacity, Overflow::Gap);
            // A deterministic mix of pushes, pops and resubscriptions.
            let mut state = 7_u64;
            for n in 0..2_000 {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                match state >> 61 {
                    0 => {
                        inbox.lock().events.pop_front();
                    }
                    1 => {
                        inbox.push_resubscribed();
                    }
                    _ => {
                        inbox.push_message(message(n));
                    }
                }
                let guard = inbox.lock();
                let events = &guard.events;
                assert!(
                    events.len() <= capacity + 1,
                    "{} > {capacity} + 1",
                    events.len()
                );
                assert!(
                    events
                        .iter()
                        .zip(events.iter().skip(1))
                        .all(|pair| !matches!(pair, (Event::Gap(_), Event::Gap(_)))),
                    "markers merge"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_dropped_receiver_closes_and_a_closed_sender_ends_the_stream() {
        let inbox = Inbox::new(2, Overflow::Gap);
        inbox.push_message(message(1));
        inbox.close_sender();
        assert_eq!(inbox.recv().await, Some(Event::Message(message(1))));
        assert_eq!(inbox.recv().await, None);
        let other = Inbox::new(2, Overflow::Gap);
        other.close_receiver();
        assert_eq!(other.push_message(message(1)), Push::Closed);
    }

    #[test]
    fn backoff_matches_node_redis_without_jitter() {
        assert_eq!(backoff(0), Duration::from_millis(50));
        assert_eq!(backoff(1), Duration::from_millis(100));
        assert_eq!(backoff(5), Duration::from_millis(1600));
        assert_eq!(backoff(6), Duration::from_millis(2000));
        assert_eq!(backoff(40), Duration::from_millis(2000));
    }
}
