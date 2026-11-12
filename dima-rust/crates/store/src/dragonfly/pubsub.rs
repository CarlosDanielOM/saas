//! Publish/subscribe: a raw subscriber with its own connection, and the pub/sub manager's JSON
//! envelope on top.
//!
//! # Raw layer
//!
//! A [`Subscriber`] owns one connection in subscribe mode and a background task. Each
//! [`Subscription`] (a channel or a pattern) receives its messages through its own bounded buffer
//! ([`super::DragonflyConfig::subscription_buffer`]).
//!
//! - **Overflow**: when a subscription's buffer is full, the new message is dropped and counted
//!   ([`Subscription::dropped`]); the reader task never waits for a slow consumer, so one slow
//!   subscription cannot stall the others or make the server's output buffer grow. Every channel in
//!   the reference is a hint or an invalidation with a fallback (Mongo polling, cache TTLs), and
//!   pub/sub is at-most-once anyway: the reference loses messages during a reconnect too.
//! - **Reconnect**: when the connection drops, the task reconnects with back-off
//!   (`min(50 ms × 2^attempt, 2 s)`, node-redis 5's default strategy without its random jitter) and
//!   subscribes again to every channel and pattern, as node-redis does. Messages published while it
//!   was disconnected are lost.
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
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
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
    sender: mpsc::Sender<Message>,
    dropped: Arc<AtomicU64>,
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
    receiver: mpsc::Receiver<Message>,
    dropped: Arc<AtomicU64>,
    control: mpsc::Sender<Control>,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("topic", &self.topic)
            .field("confirmed", &self.confirmed)
            .field("dropped", &self.dropped())
            .finish()
    }
}

impl Subscription {
    /// The next message; `None` once the subscription was replaced or the subscriber stopped.
    pub async fn recv(&mut self) -> Option<Message> {
        self.receiver.recv().await
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

    /// Messages dropped because this subscription's buffer was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
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

    /// Subscribes to a topic. Returns once the server confirmed it, or at once when the
    /// subscriber is reconnecting (the subscription is then made on reconnect; see
    /// [`Subscription::confirmed`]).
    pub async fn subscribe(&self, topic: Topic) -> Result<Subscription> {
        let (sender, receiver) = mpsc::channel(self.buffer);
        let dropped = Arc::new(AtomicU64::new(0));
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (ack, confirmed) = oneshot::channel();
        self.control
            .send(Control::Subscribe {
                topic: topic.clone(),
                entry: Entry {
                    id,
                    sender,
                    dropped: dropped.clone(),
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
            receiver,
            dropped,
            control: self.control.clone(),
        })
    }

    /// Runs `handler` for every message of `topic` parsed as the pub/sub manager's JSON (see
    /// [`parse_envelope`]). A payload that is not JSON of type `T` is skipped (the reference's
    /// `JSON.parse` throws inside its listener). Messages are handled one at a time, in order.
    /// Dropping the returned guard stops the handler and unsubscribes.
    pub async fn on_json<T, F>(&self, topic: Topic, handler: F) -> Result<HandlerGuard>
    where
        T: DeserializeOwned + Send + 'static,
        F: FnMut(T) + Send + 'static,
    {
        let mut subscription = self.subscribe(topic).await?;
        let shared = self.shared.clone();
        let mut handler = handler;
        let task = tokio::spawn(async move {
            while let Some(message) = subscription.recv().await {
                match parse_envelope::<T>(&message.payload) {
                    Ok(value) => handler(value),
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
                        Some(Control::Subscribe { topic, entry, ack }) => {
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
                    Some(Control::Subscribe { topic, entry, ack }) => {
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
    match entry.sender.try_send(outgoing) {
        Ok(()) => None,
        Err(mpsc::error::TrySendError::Full(_)) => {
            entry.dropped.fetch_add(1, Ordering::Relaxed);
            None
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
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

    #[test]
    fn backoff_matches_node_redis_without_jitter() {
        assert_eq!(backoff(0), Duration::from_millis(50));
        assert_eq!(backoff(1), Duration::from_millis(100));
        assert_eq!(backoff(5), Duration::from_millis(1600));
        assert_eq!(backoff(6), Duration::from_millis(2000));
        assert_eq!(backoff(40), Duration::from_millis(2000));
    }
}
