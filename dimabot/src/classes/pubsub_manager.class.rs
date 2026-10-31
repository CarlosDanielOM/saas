//! Native Pub/Sub manager, ported from
//! `dimabot/src/classes/pubsub_manager.class.ts`.
//!
//! The source keeps three module-level values: a `publisher` client, a
//! `subscriber` client and a `Map<channel, handler>` of at most one handler per
//! channel. [`PubSubManager`] is the same shape with real native handles:
//!
//! * one dedicated subscriber connection, split into a sink (SUBSCRIBE /
//!   UNSUBSCRIBE) and a stream driven by one dispatch task;
//! * one publisher connection used only for `PUBLISH`;
//! * a [`HandlerRegistry`] holding exactly one handler per channel, so a second
//!   `subscribe` on the same channel replaces the handler instead of adding a
//!   second listener.
//!
//! Payloads are built by [`payload_with_timestamp`], which reproduces the
//! source's `JSON.stringify({ ...data, timestamp: Date.now() })`: own enumerable
//! fields of `data` in JavaScript property order, then `timestamp`, replacing an
//! existing `timestamp` value **in place** (JavaScript object spread followed by
//! an assignment keeps the original key position). Strings, arrays and
//! non-objects spread the way JavaScript spreads them.
//!
//! Operational rules preserved from the source:
//!
//! * `publish` and `subscribe` initialize the manager on first use; a
//!   `publish`-only consumer therefore still opens the subscriber connection,
//!   exactly like `init()`.
//! * `unsubscribe` before initialization is a no-op, because the source guards
//!   on `if (subscriber)`.
//! * a handler that is absent for a channel means the message is dropped without
//!   parsing, which is what the live per-channel listener does.
//! * every failure is logged with the source's `function` name and rethrown; the
//!   logger's `destination` matches the source (`both` for errors, `console` for
//!   the initialization notice).
//!
//! Deliberate differences, each recorded with its evidence in
//! `migration-notes/pubsub-manager-handoff.md`:
//!
//! * The source's `subscriber.on('message', ...)` listener never fires on the
//!   pinned `redis` 5.12.1 (`@redis/client` 5.12.1): `#emitPubSubMessage`
//!   dispatches only to per-channel listeners and the client never emits a
//!   `'message'` event. Its `try/catch` is nevertheless the source's declared
//!   malformed-payload contract, so this port parses inside the dispatch loop,
//!   logs `PubSubManager.handleMessage` and keeps the subscription alive instead
//!   of letting a `JSON.parse` throw reach the socket reader.
//! * Re-subscribing to an already subscribed channel adds a listener in
//!   `@redis/client` while the source map keeps one handler, so the source calls
//!   that handler once per attached listener. This port dispatches once.
//! * A failed `subscribe` rolls the handler back out of the registry; the source
//!   leaves the entry behind.
//! * `init()` failures stay retryable, and the connection is rebuilt on the next
//!   operation if the dispatch stream closes. The source leaves its
//!   half-initialized clients in place.
//!
//! Construction performs no I/O and reads no environment. [`PubSubManager::new`]
//! takes an already opened [`redis::Client`]; the first operation connects. The
//! manager owns its connections and its dispatch task: dropping it aborts the
//! task and closes the subscriber socket. [`PubSubManager::shutdown`] does the
//! same explicitly and also forgets the registered handlers.

use std::{
    collections::HashMap,
    fmt,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use futures_util::StreamExt;
use redis::{
    Client,
    aio::{ConnectionManager, PubSubSink, PubSubStream},
};
use tokio::{sync::RwLock, task::JoinHandle};

use crate::utils::{
    js_string::JsString,
    logger::{Clock, Destination, Level, LogOptions, Logger, SystemClock},
    lossless_json::{JsonValue, parse_json},
};

/// Payload channel of the clip request queue (`twitch:<channelID>:clip:request`).
pub const CLIP_REQUEST_TEMPLATE: &str = "twitch:{}:clip:request";

/// One message handler. The source hands the parsed value to a possibly `async`
/// callback without awaiting it; a native handler is synchronous, and a consumer
/// that needs async work must spawn it, exactly as the source's returned promise
/// is dropped.
pub type Handler = Arc<dyn Fn(&JsonValue) + Send + Sync>;

/// `twitch:${channelID}:clip:request`.
pub fn clip_request_channel(channel_id: &str) -> String {
    CLIP_REQUEST_TEMPLATE.replacen("{}", channel_id, 1)
}

/// The source's `JSON.stringify({ ...data, timestamp: Date.now() })`.
///
/// `timestamp_millis` is the caller's `Date.now()` value. Field order follows
/// ECMAScript: canonical array indices ascending, then the remaining keys in
/// insertion order, with `timestamp` keeping an existing position.
pub fn payload_with_timestamp(data: &JsonValue, timestamp_millis: i64) -> String {
    let mut fields = spread_fields(data);
    upsert(
        &mut fields,
        JsString::from_static("timestamp"),
        JsonValue::Number(timestamp_millis as f64),
    );
    JsonValue::Object(fields).to_json_string()
}

/// Own enumerable properties that a JavaScript object spread copies.
fn spread_fields(data: &JsonValue) -> Vec<(JsString, JsonValue)> {
    let mut fields: Vec<(JsString, JsonValue)> = Vec::new();
    match data {
        JsonValue::Object(values) => {
            for (key, value) in values {
                upsert(&mut fields, key.clone(), value.clone());
            }
        }
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                upsert(&mut fields, index_key(index), value.clone());
            }
        }
        // `{ ...'ab' }` yields `{0: 'a', 1: 'b'}`: one property per UTF-16 code
        // unit, so a surrogate pair becomes two one-unit strings.
        JsonValue::String(text) => {
            for (index, unit) in text.units().into_iter().enumerate() {
                upsert(
                    &mut fields,
                    index_key(index),
                    JsonValue::String(JsString::from_units(vec![unit])),
                );
            }
        }
        // `{ ...null }`, `{ ...true }` and `{ ...1 }` copy no own enumerable
        // properties.
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => {}
    }
    fields
}

fn index_key(index: usize) -> JsString {
    JsString::from(index.to_string())
}

/// Assignment semantics: an existing key keeps its position and takes the new
/// value; a new key is appended.
fn upsert(fields: &mut Vec<(JsString, JsonValue)>, key: JsString, value: JsonValue) {
    match fields.iter_mut().find(|(name, _)| name == &key) {
        Some(slot) => slot.1 = value,
        None => fields.push((key, value)),
    }
}

/// One handler per channel, matching the source's `Map<string, handler>`.
#[derive(Clone, Default)]
pub struct HandlerRegistry {
    handlers: HashMap<String, Handler>,
}

impl HandlerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the handler for `channel` and returns the previous one.
    pub fn set(&mut self, channel: &str, handler: Handler) -> Option<Handler> {
        self.handlers.insert(channel.to_owned(), handler)
    }

    pub fn remove(&mut self, channel: &str) -> Option<Handler> {
        self.handlers.remove(channel)
    }

    pub fn get(&self, channel: &str) -> Option<Handler> {
        self.handlers.get(channel).cloned()
    }

    pub fn contains(&self, channel: &str) -> bool {
        self.handlers.contains_key(channel)
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// Channels in unspecified order; used only to restore subscriptions after a
    /// reconnect.
    pub fn channels(&self) -> Vec<String> {
        self.handlers.keys().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.handlers.clear();
    }
}

/// Snapshot of the manager's message counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PubSubStats {
    /// Successful `PUBLISH` calls.
    pub published: u64,
    /// Messages read from the subscriber stream, including ones dropped for an
    /// unregistered channel.
    pub received: u64,
    /// Messages whose payload was not valid UTF-8 JSON.
    pub malformed: u64,
    /// Handlers that panicked; the subscription stays alive.
    pub handler_failures: u64,
}

#[derive(Default)]
struct Counters {
    published: AtomicU64,
    received: AtomicU64,
    malformed: AtomicU64,
    handler_failures: AtomicU64,
}

#[derive(Debug)]
pub enum PubSubError {
    Redis(redis::RedisError),
    /// The manager was shut down between initialization and the operation.
    Unavailable,
}

impl fmt::Display for PubSubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Redis(error) => error.fmt(formatter),
            Self::Unavailable => formatter.write_str("Pub/Sub manager is not available"),
        }
    }
}

impl std::error::Error for PubSubError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Redis(error) => Some(error),
            Self::Unavailable => None,
        }
    }
}

impl From<redis::RedisError> for PubSubError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

/// Live connections of one successful initialization.
struct Live {
    publisher: ConnectionManager,
    sink: PubSubSink,
}

/// Concrete publisher/subscriber over one injected [`redis::Client`].
pub struct PubSubManager {
    client: Client,
    /// Caller-supplied publisher connection, used instead of opening one from
    /// `client` (for example the process-wide `get_redis_client()` manager).
    publisher_override: Option<ConnectionManager>,
    clock: Arc<dyn Clock>,
    logger: Option<Arc<Logger>>,
    handlers: Arc<RwLock<HandlerRegistry>>,
    counters: Arc<Counters>,
    connected: Arc<AtomicBool>,
    live: tokio::sync::Mutex<Option<Live>>,
    task: StdMutex<Option<JoinHandle<()>>>,
}

impl PubSubManager {
    /// No I/O: `client` may be built without connecting, and nothing is opened
    /// until the first `init`, `publish` or `subscribe`.
    pub fn new(client: Client, logger: Option<Arc<Logger>>) -> Self {
        Self {
            client,
            publisher_override: None,
            clock: Arc::new(SystemClock),
            logger,
            handlers: Arc::new(RwLock::new(HandlerRegistry::new())),
            counters: Arc::new(Counters::default()),
            connected: Arc::new(AtomicBool::new(false)),
            live: tokio::sync::Mutex::new(None),
            task: StdMutex::new(None),
        }
    }

    /// Reuses an existing multiplexed connection for `PUBLISH` instead of
    /// opening a second one. `PUBLISH` is an ordinary command, so the shared
    /// socket is safe; only the subscriber needs a dedicated connection.
    pub fn with_publisher(mut self, publisher: ConnectionManager) -> Self {
        self.publisher_override = Some(publisher);
        self
    }

    /// Injects the clock used for the `timestamp` field.
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn handlers(&self) -> &Arc<RwLock<HandlerRegistry>> {
        &self.handlers
    }

    /// `true` while the dispatch stream is live. A closed stream flips this to
    /// `false`, and the next operation rebuilds the connection.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> PubSubStats {
        PubSubStats {
            published: self.counters.published.load(Ordering::Relaxed),
            received: self.counters.received.load(Ordering::Relaxed),
            malformed: self.counters.malformed.load(Ordering::Relaxed),
            handler_failures: self.counters.handler_failures.load(Ordering::Relaxed),
        }
    }

    /// `pubSubManager.init()`. Idempotent, retryable after a failure, and
    /// reconnecting when the previous dispatch stream has closed.
    pub async fn init(&self) -> Result<(), PubSubError> {
        self.ensure().await.map(|_| ())
    }

    /// `pubSubManager.publish(channel, data)`.
    pub async fn publish(&self, channel: &str, data: &JsonValue) -> Result<(), PubSubError> {
        match self.publish_inner(channel, data).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.failure("PubSubManager.publish", Some(channel), &error)
                    .await;
                Err(error)
            }
        }
    }

    /// `pubSubManager.subscribe(channel, handler)`. A second call on the same
    /// channel replaces the handler and keeps the existing subscription.
    pub async fn subscribe(&self, channel: &str, handler: Handler) -> Result<(), PubSubError> {
        match self.subscribe_inner(channel, handler).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.failure("PubSubManager.subscribe", Some(channel), &error)
                    .await;
                Err(error)
            }
        }
    }

    /// `pubSubManager.unsubscribe(channel)`. A no-op before initialization,
    /// like the source's `if (subscriber)` guard.
    pub async fn unsubscribe(&self, channel: &str) -> Result<(), PubSubError> {
        match self.unsubscribe_inner(channel).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.failure("PubSubManager.unsubscribe", Some(channel), &error)
                    .await;
                Err(error)
            }
        }
    }

    /// `publishClipRequest(channelID, clipData)`.
    pub async fn publish_clip_request(
        &self,
        channel_id: &str,
        data: &JsonValue,
    ) -> Result<(), PubSubError> {
        self.publish(&clip_request_channel(channel_id), data).await
    }

    /// `subscribeToClipRequests(channelID, handler)`.
    pub async fn subscribe_to_clip_requests(
        &self,
        channel_id: &str,
        handler: Handler,
    ) -> Result<(), PubSubError> {
        self.subscribe(&clip_request_channel(channel_id), handler)
            .await
    }

    /// Stops the dispatch task, closes the subscriber connection and forgets
    /// every handler. A later `init` starts from an empty registry.
    pub async fn shutdown(&self) {
        self.connected.store(false, Ordering::Release);
        let live = self.live.lock().await.take();
        self.abort_task();
        drop(live);
        self.handlers.write().await.clear();
    }

    async fn publish_inner(&self, channel: &str, data: &JsonValue) -> Result<(), PubSubError> {
        let mut publisher = self.ensure().await?;
        let payload = payload_with_timestamp(data, self.clock.now_millis());
        // The subscriber count is not part of the source contract.
        let _: i64 = redis::cmd("PUBLISH")
            .arg(channel)
            .arg(&payload)
            .query_async(&mut publisher)
            .await?;
        self.counters.published.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn subscribe_inner(&self, channel: &str, handler: Handler) -> Result<(), PubSubError> {
        self.ensure().await?;
        let mut live = self.live.lock().await;
        let Some(live) = live.as_mut() else {
            return Err(PubSubError::Unavailable);
        };
        if self
            .handlers
            .write()
            .await
            .set(channel, handler)
            .is_some()
        {
            // Already subscribed: only the handler changed.
            return Ok(());
        }
        if let Err(error) = live.sink.subscribe(channel).await {
            // Roll the handler back so a failed subscription leaves no entry.
            self.handlers.write().await.remove(channel);
            return Err(error.into());
        }
        Ok(())
    }

    async fn unsubscribe_inner(&self, channel: &str) -> Result<(), PubSubError> {
        if !self.connected.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut live = self.live.lock().await;
        let Some(live) = live.as_mut() else {
            return Ok(());
        };
        live.sink.unsubscribe(channel).await?;
        self.handlers.write().await.remove(channel);
        Ok(())
    }

    /// Returns a publisher connection, initializing or reconnecting as needed.
    async fn ensure(&self) -> Result<ConnectionManager, PubSubError> {
        {
            // The guard must be released before `reconnect` takes the same lock.
            let live = self.live.lock().await;
            if self.connected.load(Ordering::Acquire)
                && let Some(live) = live.as_ref()
            {
                return Ok(live.publisher.clone());
            }
        }
        match self.reconnect().await {
            Ok(publisher) => Ok(publisher),
            Err(error) => {
                self.failure("PubSubManager.init", None, &error).await;
                Err(error)
            }
        }
    }

    async fn reconnect(&self) -> Result<ConnectionManager, PubSubError> {
        let mut live = self.live.lock().await;
        // Another caller may have finished while this one waited for the lock.
        if self.connected.load(Ordering::Acquire)
            && let Some(live) = live.as_ref()
        {
            return Ok(live.publisher.clone());
        }
        self.connected.store(false, Ordering::Release);
        drop(live.take());
        self.abort_task();
        let created = self.connect().await?;
        let publisher = created.publisher.clone();
        *live = Some(created);
        Ok(publisher)
    }

    async fn connect(&self) -> Result<Live, PubSubError> {
        // The source connects the subscriber first, then the publisher.
        let pubsub = self.client.get_async_pubsub().await?;
        let (sink, stream) = pubsub.split();
        let publisher = match &self.publisher_override {
            Some(publisher) => publisher.clone(),
            None => self.client.get_connection_manager().await?,
        };
        // Restore every registered channel, matching node-redis resubscribing
        // its listeners after a reconnect.
        let channels = self.handlers.read().await.channels();
        let mut sink = sink;
        for channel in channels {
            sink.subscribe(&channel).await?;
        }
        self.connected.store(true, Ordering::Release);
        let task = tokio::spawn(dispatch(
            stream,
            Arc::clone(&self.handlers),
            Arc::clone(&self.counters),
            self.logger.clone(),
            Arc::clone(&self.connected),
        ));
        match self.task.lock() {
            Ok(mut slot) => *slot = Some(task),
            Err(_) => {
                // A poisoned slot would leave the stream alive with nobody able
                // to stop it; tear the attempt down and report it.
                task.abort();
                self.connected.store(false, Ordering::Release);
                return Err(PubSubError::Unavailable);
            }
        }
        self.notice().await;
        Ok(Live { publisher, sink })
    }

    fn abort_task(&self) {
        if let Ok(mut slot) = self.task.lock()
            && let Some(task) = slot.take()
        {
            task.abort();
        }
    }

    async fn notice(&self) {
        let Some(logger) = &self.logger else {
            return;
        };
        let _ = logger
            .log(
                Level::Info,
                serde_json::json!({ "message": "PubSub manager initialized" }),
                LogOptions {
                    destination: Destination::Console,
                    ..LogOptions::default()
                },
            )
            .await;
    }

    async fn failure(&self, function: &'static str, channel: Option<&str>, error: &PubSubError) {
        let Some(logger) = &self.logger else {
            match channel {
                Some(channel) => {
                    eprintln!(
                        "[DEV NOTIFICATION - ERROR]: {function} failed for {channel}: {error}"
                    )
                }
                None => eprintln!("[DEV NOTIFICATION - ERROR]: {function} failed: {error}"),
            }
            return;
        };
        let mut payload = serde_json::json!({ "function": function });
        if let Some(channel) = channel
            && let Some(object) = payload.as_object_mut()
        {
            object.insert(
                "channel".into(),
                serde_json::Value::String(channel.to_owned()),
            );
        }
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "error".into(),
                serde_json::Value::String(error.to_string()),
            );
        }
        let _ = logger
            .log(
                Level::Error,
                payload,
                LogOptions {
                    destination: Destination::Both,
                    ..LogOptions::default()
                },
            )
            .await;
    }
}

impl Drop for PubSubManager {
    fn drop(&mut self) {
        self.connected.store(false, Ordering::Release);
        self.abort_task();
    }
}

/// Reads messages until the stream closes, then marks the manager disconnected
/// so the next operation rebuilds the connection.
async fn dispatch(
    mut stream: PubSubStream,
    handlers: Arc<RwLock<HandlerRegistry>>,
    counters: Arc<Counters>,
    logger: Option<Arc<Logger>>,
    connected: Arc<AtomicBool>,
) {
    while let Some(message) = stream.next().await {
        counters.received.fetch_add(1, Ordering::Relaxed);
        let channel = message.get_channel_name().to_owned();
        // An unregistered channel drops the message without parsing, exactly
        // like the source's live per-channel listener.
        let Some(handler) = handlers.read().await.get(&channel) else {
            continue;
        };
        let payload = match message.get_payload::<String>() {
            Ok(payload) => payload,
            Err(_) => {
                counters.malformed.fetch_add(1, Ordering::Relaxed);
                malformed(&logger, "Pub/Sub payload is not valid UTF-8").await;
                continue;
            }
        };
        match parse_json(&payload) {
            Ok(value) => {
                // `handleMessage` catches every handler failure; a panic in a
                // native handler must not kill the dispatch task.
                if catch_unwind(AssertUnwindSafe(|| handler(&value))).is_err() {
                    counters.handler_failures.fetch_add(1, Ordering::Relaxed);
                    malformed(&logger, "Pub/Sub handler panicked").await;
                }
            }
            Err(error) => {
                counters.malformed.fetch_add(1, Ordering::Relaxed);
                malformed(&logger, &error).await;
            }
        }
    }
    connected.store(false, Ordering::Release);
    // The source's `subscriber.on('error')` listener.
    let Some(logger) = &logger else {
        eprintln!("[DEV NOTIFICATION - ERROR]: PubSubManager.subscriber: stream closed");
        return;
    };
    let _ = logger
        .log(
            Level::Error,
            serde_json::json!({
                "function": "PubSubManager.subscriber",
                "error": "Pub/Sub subscription stream closed",
            }),
            LogOptions {
                destination: Destination::Both,
                ..LogOptions::default()
            },
        )
        .await;
}

/// The source logs malformed payloads with `function: 'PubSubManager.handleMessage'`
/// and no channel.
async fn malformed(logger: &Option<Arc<Logger>>, error: &str) {
    let Some(logger) = logger else {
        eprintln!("[DEV NOTIFICATION - ERROR]: PubSubManager.handleMessage: {error}");
        return;
    };
    let _ = logger
        .log(
            Level::Error,
            serde_json::json!({
                "function": "PubSubManager.handleMessage",
                "error": error,
            }),
            LogOptions {
                destination: Destination::Both,
                ..LogOptions::default()
            },
        )
        .await;
}
