//! Native commands collection, Redis cache protocol, and Pub/Sub lifecycle.
//!
//! Construction takes real native handles and performs no network activity.
//! Connections are shared by their native drivers; only the Pub/Sub subscriber
//! gets a dedicated socket. No global singleton, credentials or worker is added.
//! Local/body TTLs and five immediate revision retries stay in the shared core.

#[path = "hydration.rs"]
mod hydration;
pub use hydration::{command_body_cache_value, command_body_from_document};

use super::{
    KEYWORD_TOPIC, KeywordIndexCache, KeywordMatchMode, KeywordRow, KeywordStorage,
    KeywordStorageError, SET_IF_REVISION_SCRIPT, SharedKeywordLoader, apply_keyword_change,
    get_keyword_body, refresh_keyword_index, save_keyword_count,
};
use crate::utils::logger::{
    Destination, Level, LogOptions, Logger, LoggerConfig, SinkHandles, StdConsole, SystemClock,
    UuidSource, redis::RedisCacheSink,
};
use futures_util::StreamExt;
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use redis::{
    Client,
    aio::{ConnectionManager, PubSub},
};
use serde_json::{Value, json};
use std::{fmt, sync::Arc, time::Duration};
use tokio::{sync::watch, task::JoinHandle};

#[derive(Debug)]
pub enum KeywordNativeError {
    Mongo(mongodb::error::Error),
    Redis(redis::RedisError),
    Json(serde_json::Error),
    InvalidCommandId,
    InvalidCommandRow,
    InvalidClock,
}
impl fmt::Display for KeywordNativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mongo(_) => f.write_str("Keyword commands database operation failed"),
            Self::Redis(_) => f.write_str("Keyword cache operation failed"),
            Self::Json(_) => f.write_str("Keyword command JSON conversion failed"),
            Self::InvalidCommandId => f.write_str("Keyword command ID must be a valid ObjectId"),
            Self::InvalidCommandRow => f.write_str("Keyword command row has invalid fields"),
            Self::InvalidClock => f.write_str("Keyword command default date cannot be represented"),
        }
    }
}
impl std::error::Error for KeywordNativeError {}
impl From<mongodb::error::Error> for KeywordNativeError {
    fn from(value: mongodb::error::Error) -> Self {
        Self::Mongo(value)
    }
}
impl From<redis::RedisError> for KeywordNativeError {
    fn from(value: redis::RedisError) -> Self {
        Self::Redis(value)
    }
}

#[derive(Clone)]
pub struct MongoRedisKeywordStorage {
    commands: Collection<Document>,
    connection: ConnectionManager,
    namespace: String,
}
impl MongoRedisKeywordStorage {
    pub fn new(database: &Database, connection: ConnectionManager) -> Self {
        Self::with_namespace(database, connection, "")
    }
    /// Prefixes cache keys and topic only; the supplied database must itself be
    /// disposable for fixtures. Production-compatible construction uses no prefix.
    pub fn with_namespace(
        database: &Database,
        connection: ConnectionManager,
        namespace: &str,
    ) -> Self {
        Self {
            commands: database.collection("commands"),
            connection,
            namespace: namespace.into(),
        }
    }
    pub fn namespaced_key(&self, key: &str) -> String {
        format!("{}{key}", self.namespace)
    }
    pub fn topic(&self) -> String {
        self.namespaced_key(KEYWORD_TOPIC)
    }
    pub fn connection(&self) -> ConnectionManager {
        self.connection.clone()
    }
}
impl KeywordStorage for MongoRedisKeywordStorage {
    type Error = KeywordNativeError;
    async fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
        Ok(redis::cmd("GET")
            .arg(self.namespaced_key(key))
            .query_async(&mut self.connection.clone())
            .await?)
    }
    async fn query_index(&self, channel_id: &str) -> Result<Vec<KeywordRow>, Self::Error> {
        let mut rows = self
            .commands
            .find(doc! {"channelID":channel_id,"activation":"keyword","enabled":true})
            .projection(doc! {"_id":1,"cmd":1,"keywordSettings":1})
            .await?;
        let mut result = Vec::new();
        while let Some(row) = rows.try_next().await? {
            let id = row
                .get_object_id("_id")
                .map_err(|_| KeywordNativeError::InvalidCommandRow)?
                .to_hex();
            let cmd = row
                .get_str("cmd")
                .map_err(|_| KeywordNativeError::InvalidCommandRow)?
                .to_owned();
            let mode = row
                .get_document("keywordSettings")
                .ok()
                .and_then(|settings| settings.get("matchMode"));
            let match_mode = match mode {
                None | Some(Bson::Null) => None,
                Some(Bson::String(mode)) if mode == "start" => Some(KeywordMatchMode::Start),
                Some(Bson::String(mode)) if mode == "anywhere" => Some(KeywordMatchMode::Anywhere),
                Some(Bson::String(mode)) if mode == "exact" => Some(KeywordMatchMode::Exact),
                _ => return Err(KeywordNativeError::InvalidCommandRow),
            };
            result.push(KeywordRow {
                id,
                cmd,
                match_mode,
            });
        }
        Ok(result)
    }
    async fn query_body(&self, channel_id: &str, id: &str) -> Result<Option<Value>, Self::Error> {
        let id = ObjectId::parse_str(id).map_err(|_| KeywordNativeError::InvalidCommandId)?;
        let row = self
            .commands
            .find_one(doc! {"channelID":channel_id,"_id":id,"activation":"keyword"})
            .projection(doc! {"blocks":0,"availability":0,"availabilityLease":0})
            .await?;
        row.map(|row| command_body_from_document(row, DateTime::now()))
            .transpose()
    }
    fn serialize_body_for_cache(&self, body: &Value) -> Result<String, serde_json::Error> {
        serde_json::to_string(&command_body_cache_value(body))
    }
    async fn set_if_revision(
        &self,
        data_key: &str,
        revision_key: &str,
        revision: &str,
        value: &str,
        ttl_seconds: u64,
    ) -> Result<bool, Self::Error> {
        let result: i64 = redis::Script::new(SET_IF_REVISION_SCRIPT)
            .key(self.namespaced_key(data_key))
            .key(self.namespaced_key(revision_key))
            .arg(revision)
            .arg(value)
            .arg(ttl_seconds)
            .invoke_async(&mut self.connection.clone())
            .await?;
        Ok(result == 1)
    }
    async fn invalidate_shared(
        &self,
        revision_key: &str,
        index_key: &str,
        body_key: Option<&str>,
    ) -> Result<(), Self::Error> {
        let mut transaction = redis::pipe();
        transaction
            .atomic()
            .cmd("INCR")
            .arg(self.namespaced_key(revision_key))
            .ignore()
            .cmd("DEL")
            .arg(self.namespaced_key(index_key))
            .ignore();
        if let Some(body_key) = body_key {
            transaction
                .cmd("DEL")
                .arg(self.namespaced_key(body_key))
                .ignore();
        }
        transaction
            .query_async::<()>(&mut self.connection.clone())
            .await?;
        Ok(())
    }
    async fn publish(&self, topic: &str, value: &str) -> Result<(), Self::Error> {
        let _: i64 = redis::cmd("PUBLISH")
            .arg(self.namespaced_key(topic))
            .arg(value)
            .query_async(&mut self.connection.clone())
            .await?;
        Ok(())
    }
    async fn update_keyword_count(
        &self,
        channel_id: &str,
        id: &str,
        count: f64,
    ) -> Result<(), Self::Error> {
        // Mongoose rejects NaN for a Number path; infinity remains a valid BSON double.
        if count.is_nan() {
            return Err(KeywordNativeError::InvalidCommandRow);
        }
        let id = ObjectId::parse_str(id).map_err(|_| KeywordNativeError::InvalidCommandId)?;
        self.commands
            .update_one(
                doc! {"channelID":channel_id,"_id":id,"activation":"keyword"},
                doc! {"$set":{"count":crate::utils::bson_compat::js_number(count)}},
            )
            .await?;
        Ok(())
    }
    async fn delete(&self, key: &str) -> Result<(), Self::Error> {
        let _: i64 = redis::cmd("DEL")
            .arg(self.namespaced_key(key))
            .query_async(&mut self.connection.clone())
            .await?;
        Ok(())
    }
}

pub type NativeKeywordIndexCache = KeywordIndexCache<SharedKeywordLoader<MongoRedisKeywordStorage>>;
pub type NativeKeywordError = KeywordStorageError<KeywordNativeError>;

pub struct NativeKeywordCache {
    pub storage: Arc<MongoRedisKeywordStorage>,
    pub index: Arc<NativeKeywordIndexCache>,
    subscriber_client: Client,
    logger: Logger,
}
impl NativeKeywordCache {
    /// Installs concrete console/Redis diagnostics. `with_logger` accepts an
    /// application's existing logger to retain its metadata/OTEL integrations.
    pub fn new(storage: MongoRedisKeywordStorage, subscriber_client: Client) -> Self {
        let sink = RedisCacheSink::new(storage.connection(), Duration::from_secs(2))
            .expect("fixed nonzero logger timeout");
        let logger = Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(Arc::new(StdConsole)),
                cache: Some(Arc::new(sink)),
                ..SinkHandles::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .expect("default logger limits");
        Self::with_logger(storage, subscriber_client, logger)
    }
    pub fn with_logger(
        storage: MongoRedisKeywordStorage,
        subscriber_client: Client,
        logger: Logger,
    ) -> Self {
        let storage = Arc::new(storage);
        let index = Arc::new(KeywordIndexCache::new(SharedKeywordLoader {
            storage: Arc::clone(&storage),
        }));
        Self {
            storage,
            index,
            subscriber_client,
            logger,
        }
    }
    pub async fn refresh(
        &self,
        channel_id: &str,
        id: Option<&str>,
    ) -> Result<(), Arc<NativeKeywordError>> {
        refresh_keyword_index(self.index.as_ref(), channel_id, id).await
    }
    pub async fn body(
        &self,
        channel_id: &str,
        id: &str,
    ) -> Result<Option<Value>, NativeKeywordError> {
        get_keyword_body(self.storage.as_ref(), channel_id, id).await
    }
    pub async fn save_count(
        &self,
        channel_id: &str,
        id: &str,
        count: f64,
    ) -> Result<(), KeywordNativeError> {
        save_keyword_count(self.storage.as_ref(), channel_id, id, count).await
    }
    /// Returns only after Redis confirms subscription, so an edit immediately
    /// after this method cannot race the initial subscription handshake.
    pub async fn start_subscription(&self) -> Result<KeywordSubscription, KeywordNativeError> {
        let topic = self.storage.topic();
        let pubsub = match connect_subscriber(&self.subscriber_client, &topic).await {
            Ok(pubsub) => pubsub,
            Err(error) => {
                diagnostic(
                    &self.logger,
                    Level::Error,
                    "Keyword subscriber startup failed",
                )
                .await;
                return Err(error.into());
            }
        };
        diagnostic(&self.logger, Level::Info, "PubSub manager initialized").await;
        let (stop, stop_rx) = watch::channel(false);
        let initial = KeywordSubscriptionStatus {
            connected: true,
            connections: 1,
            ..KeywordSubscriptionStatus::default()
        };
        let (status_tx, status) = watch::channel(initial);
        let task = tokio::spawn(run_subscriber(
            pubsub,
            self.subscriber_client.clone(),
            topic,
            Arc::clone(&self.index),
            self.logger.clone(),
            stop_rx,
            status_tx,
        ));
        Ok(KeywordSubscription {
            stop,
            status,
            task: Some(task),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeywordSubscriptionStatus {
    pub connected: bool,
    pub connections: u64,
    pub disconnects: u64,
    pub messages: u64,
    pub invalidations: u64,
    pub malformed_messages: u64,
    pub last_error: Option<&'static str>,
}

pub struct KeywordSubscription {
    stop: watch::Sender<bool>,
    pub status: watch::Receiver<KeywordSubscriptionStatus>,
    task: Option<JoinHandle<()>>,
}
impl KeywordSubscription {
    pub async fn shutdown(mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for KeywordSubscription {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn diagnostic(logger: &Logger, level: Level, message: &'static str) {
    let destination = if level == Level::Info {
        Destination::Console
    } else {
        Destination::Both
    };
    let _ = logger
        .log(
            level,
            json!({"function":"PubSubManager.keywordCache","message":message}),
            LogOptions {
                destination,
                ..LogOptions::default()
            },
        )
        .await;
}
async fn connect_subscriber(client: &Client, topic: &str) -> Result<PubSub, redis::RedisError> {
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(topic).await?;
    Ok(pubsub)
}
async fn run_subscriber(
    mut pubsub: PubSub,
    client: Client,
    topic: String,
    cache: Arc<NativeKeywordIndexCache>,
    logger: Logger,
    mut stop: watch::Receiver<bool>,
    status: watch::Sender<KeywordSubscriptionStatus>,
) {
    loop {
        {
            let mut messages = pubsub.on_message();
            loop {
                let message = tokio::select! {
                    biased;
                    changed = stop.changed() => { if changed.is_err() || *stop.borrow() { return; } else { continue; } }
                    message = messages.next() => message,
                };
                let Some(message) = message else {
                    break;
                };
                let parsed = message
                    .get_payload::<String>()
                    .ok()
                    .and_then(|body| serde_json::from_str::<Value>(&body).ok());
                status.send_modify(|state| state.messages += 1);
                if let Some(event) = parsed {
                    if apply_keyword_change(cache.as_ref(), &event) {
                        status.send_modify(|state| state.invalidations += 1);
                    }
                } else {
                    status.send_modify(|state| {
                        state.malformed_messages += 1;
                        state.last_error = Some("Invalid keyword change payload");
                    });
                    diagnostic(&logger, Level::Error, "Invalid keyword change payload").await;
                }
            }
        }
        cache.invalidate_all();
        status.send_modify(|state| {
            state.connected = false;
            state.disconnects += 1;
            state.last_error = Some("Keyword subscriber disconnected");
        });
        tokio::select! {
            biased;
            _ = stop.changed() => return,
            _ = diagnostic(&logger,Level::Error,"Keyword subscriber disconnected") => {}
        }
        let mut delay = Duration::from_millis(250);
        loop {
            tokio::select! {
                biased;
                _ = stop.changed() => return,
                _ = tokio::time::sleep(delay) => {}
            }
            let connected = tokio::select! {
                biased;
                _ = stop.changed() => return,
                connected = connect_subscriber(&client,&topic) => connected,
            };
            match connected {
                Ok(connected) => {
                    pubsub = connected;
                    // Cold data loaded during the gap may precede the last edit.
                    cache.invalidate_all();
                    status.send_modify(|state| {
                        state.connected = true;
                        state.connections += 1;
                        state.last_error = None;
                    });
                    break;
                }
                Err(_) => {
                    status.send_modify(|state| {
                        state.last_error = Some("Keyword subscriber reconnect failed")
                    });
                    tokio::select! {
                        biased;
                        _ = stop.changed() => return,
                        _ = diagnostic(&logger,Level::Error,"Keyword subscriber reconnect failed") => {}
                    }
                    delay = (delay * 2).min(Duration::from_secs(5));
                }
            }
        }
    }
}
