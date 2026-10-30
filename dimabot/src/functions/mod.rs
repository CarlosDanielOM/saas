//! Native Twitch function adapters. Construction performs no I/O; callers
//! provide their long-lived clients, account directory, logger and database.
//!
//! These functions reuse the native token lifecycle and pooled Helix client.
//! Each HTTP operation makes one attempt, matching the source's raw fetch.
//! Moderation always pairs the bot token with the bot's moderator identity.

pub mod chats;
pub mod moderation;
pub mod polls;
pub mod predictions;

use crate::utils::{
    logger::{Level, LogOptions, Logger},
    twitch::{
        AccessToken, HelixRequest, HelixRetryPolicy, TokenFuture, TokenSource, TwitchAuth,
        TwitchClient,
    },
    twitch_streamers::{CallerContext, DirectoryError, Platform, TwitchStreamers},
    twitch_tokens::TwitchTokenStorage,
};
use mongodb::Database;
use reqwest::{Method, Response};
use serde_json::{Map, Value, json};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::{OnceCell, watch};

pub type FunctionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FunctionFailure {
    Denied(String),
    Internal,
}

/// Test seams retain a concrete production implementation below; supplying
/// fixture credentials never substitutes for the native application adapter.
pub trait FunctionAuth: Send + Sync {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>>;
}

pub struct NativeFunctionAuth {
    tokens: Arc<TwitchTokenStorage>,
    directory: Arc<TwitchStreamers>,
    logger: Arc<Logger>,
}
impl NativeFunctionAuth {
    pub fn new(
        tokens: Arc<TwitchTokenStorage>,
        directory: Arc<TwitchStreamers>,
        logger: Arc<Logger>,
    ) -> Self {
        Self {
            tokens,
            directory,
            logger,
        }
    }
    async fn debug(&self, channel: &str, data: Value) {
        let _ = self
            .logger
            .log(
                Level::Debug,
                data,
                LogOptions {
                    channel_id: Some(channel.into()),
                    destination: crate::utils::logger::Destination::Cache,
                    ..Default::default()
                },
            )
            .await;
    }
}
impl FunctionAuth for NativeFunctionAuth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            match auth {
                TwitchAuth::Streamer(id)=>{
                    let account=match self.directory.account_by_id(id).await {
                        Ok(account)=>account,
                        Err(DirectoryError::Missing)=>{
                            self.debug(id,json!({"function":"getTwitchStreamerHeaderById","streamerId":id,"error":"Streamer not found"})).await;
                            return Err(FunctionFailure::Denied(format!("[⚠️] Streamer not found for ID: {id} [/⚠️]")));
                        },
                        Err(_)=>return Err(FunctionFailure::Internal),
                    };
                    if account.has_permissions!="true" {
                        self.debug(id,json!({"function":"getTwitchStreamerHeaderById","streamerId":id,"error":"No permissions","has_permissions":account.has_permissions})).await;
                        return Err(FunctionFailure::Denied("[⚠️] Streamer does not have valid permissions to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]".into()));
                    }
                    match self.directory.account_token(id,Platform::Twitch,&CallerContext::new("getTwitchStreamerHeaderById")).await {
                        Ok(token)=>{
                            self.debug(id,json!({"function":"getTwitchStreamerHeaderById","streamerId":id,"success":true,"tokenLength":token.expose_secret().len()})).await;
                            Ok(token)
                        },
                        Err(_)=>{
                            self.debug(id,json!({"function":"getTwitchStreamerHeaderById","streamerId":id,"error":"Failed to get access token (refresh may have failed)"})).await;
                            Err(FunctionFailure::Denied("[⚠️] Streamer does not have valid permissions token to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]".into()))
                        }
                    }
                },
                TwitchAuth::Bot=>self.tokens.acquire_token(auth).await.map_err(|_|{
                    // notifications.ts intentionally only emits this console diagnostic.
                    eprintln!("[DEV NOTIFICATION - ERROR]: Bot does not have valid authentication. Please authorize the bot account.");
                    FunctionFailure::Denied("Bot's account does not have the permissions required".into())
                }),
                TwitchAuth::App=>self.tokens.acquire_token(auth).await.map_err(|_|FunctionFailure::Internal),
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheCommand {
    Acquire,
    Get(String),
    Set {
        key: String,
        value: String,
        ttl: Option<u64>,
    },
    Delete(String),
    Members(String),
    IsMember {
        key: String,
        value: String,
    },
    Exists(String),
    AddMembers {
        key: String,
        values: Vec<String>,
    },
    Hash {
        key: String,
        entries: Vec<(String, String)>,
    },
    Expire {
        key: String,
        seconds: u64,
    },
    SetIfAbsent {
        key: String,
        value: String,
        seconds: u64,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheValue {
    Unit,
    Text(Option<String>),
    Strings(Vec<String>),
    Flag(bool),
}
pub trait FunctionCache: Send + Sync {
    fn execute<'a>(
        &'a self,
        command: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>>;
}
/// Dedicated lazy native Redis adapter. Cheap manager clones share one
/// multiplexed connection; failed initialization is retryable.
pub struct RedisFunctionCache {
    client: redis::Client,
    connection: OnceCell<redis::aio::ConnectionManager>,
}
impl RedisFunctionCache {
    pub fn new(client: redis::Client) -> Self {
        Self {
            client,
            connection: OnceCell::new(),
        }
    }
}
impl FunctionCache for RedisFunctionCache {
    fn execute<'a>(
        &'a self,
        command: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async move {
            let mut connection = self
                .connection
                .get_or_try_init(|| redis::aio::ConnectionManager::new(self.client.clone()))
                .await
                .map_err(|_| FunctionFailure::Internal)?
                .clone();
            use CacheCommand::*;
            let result: redis::RedisResult<CacheValue> = async {
                Ok(match command {
                    Acquire => CacheValue::Unit,
                    Get(key) => CacheValue::Text(
                        redis::cmd("GET")
                            .arg(key)
                            .query_async(&mut connection)
                            .await?,
                    ),
                    Set { key, value, ttl } => {
                        let mut cmd = redis::cmd("SET");
                        cmd.arg(key).arg(value);
                        if let Some(ttl) = ttl {
                            cmd.arg("EX").arg(ttl);
                        }
                        let _: String = cmd.query_async(&mut connection).await?;
                        CacheValue::Unit
                    }
                    Delete(key) => {
                        let _: i64 = redis::cmd("DEL")
                            .arg(key)
                            .query_async(&mut connection)
                            .await?;
                        CacheValue::Unit
                    }
                    Members(key) => CacheValue::Strings(
                        redis::cmd("SMEMBERS")
                            .arg(key)
                            .query_async(&mut connection)
                            .await?,
                    ),
                    IsMember { key, value } => CacheValue::Flag(
                        redis::cmd("SISMEMBER")
                            .arg(key)
                            .arg(value)
                            .query_async::<bool>(&mut connection)
                            .await?,
                    ),
                    Exists(key) => CacheValue::Flag(
                        redis::cmd("EXISTS")
                            .arg(key)
                            .query_async::<i64>(&mut connection)
                            .await?
                            == 1,
                    ),
                    AddMembers { key, values } => {
                        let _: i64 = redis::cmd("SADD")
                            .arg(key)
                            .arg(values)
                            .query_async(&mut connection)
                            .await?;
                        CacheValue::Unit
                    }
                    Hash { key, entries } => {
                        let mut cmd = redis::cmd("HSET");
                        cmd.arg(key);
                        for (k, v) in entries {
                            cmd.arg(k).arg(v);
                        }
                        let _: i64 = cmd.query_async(&mut connection).await?;
                        CacheValue::Unit
                    }
                    Expire { key, seconds } => {
                        let _: i64 = redis::cmd("EXPIRE")
                            .arg(key)
                            .arg(seconds)
                            .query_async(&mut connection)
                            .await?;
                        CacheValue::Unit
                    }
                    SetIfAbsent {
                        key,
                        value,
                        seconds,
                    } => CacheValue::Flag(
                        redis::cmd("SET")
                            .arg(key)
                            .arg(value)
                            .arg("NX")
                            .arg("EX")
                            .arg(seconds)
                            .query_async::<Option<String>>(&mut connection)
                            .await?
                            .is_some(),
                    ),
                })
            }
            .await;
            result.map_err(|_| FunctionFailure::Internal)
        })
    }
}

/// Explicit native cancellation handle. A cancellation noticed during token
/// acquisition prevents a late HTTP request; in-flight HTTP futures are dropped.
#[derive(Clone, Debug)]
pub struct RequestCancellation {
    sender: Arc<watch::Sender<bool>>,
}
impl Default for RequestCancellation {
    fn default() -> Self {
        Self::new()
    }
}
impl RequestCancellation {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }
    async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        loop {
            if *receiver.borrow() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

#[derive(Clone)]
pub struct TwitchFunctions {
    client: TwitchClient,
    auth: Arc<dyn FunctionAuth>,
    cache: Arc<dyn FunctionCache>,
    database: Option<Database>,
    logger: Option<Arc<Logger>>,
}
impl TwitchFunctions {
    /// Complete application wiring; the adapter seams below remain available
    /// for isolated tests with no production configuration or resources.
    pub fn native(
        client: TwitchClient,
        tokens: Arc<TwitchTokenStorage>,
        directory: Arc<TwitchStreamers>,
        redis: redis::Client,
        database: Database,
        logger: Arc<Logger>,
    ) -> Self {
        let auth = Arc::new(NativeFunctionAuth::new(tokens, directory, logger.clone()));
        Self {
            client,
            auth,
            cache: Arc::new(RedisFunctionCache::new(redis)),
            database: Some(database),
            logger: Some(logger),
        }
    }
    pub fn with_adapters(
        client: TwitchClient,
        auth: Arc<dyn FunctionAuth>,
        cache: Arc<dyn FunctionCache>,
        database: Option<Database>,
        logger: Option<Arc<Logger>>,
    ) -> Self {
        Self {
            client,
            auth,
            cache,
            database,
            logger,
        }
    }
    async fn request(
        &self,
        auth: TwitchAuth,
        method: Method,
        endpoint: &str,
        params: Option<&str>,
        body: Option<&Value>,
        cancel: Option<&RequestCancellation>,
    ) -> Result<Response, FunctionFailure> {
        let acquired = self.auth.acquire(&auth).await;
        if cancel.is_some_and(RequestCancellation::is_cancelled) {
            return Err(FunctionFailure::Internal);
        }
        let token = acquired?;
        let source = FixedTokenSource(token);
        let policy = HelixRetryPolicy::single_attempt();
        let request = self.client.request(
            &source,
            &auth,
            HelixRequest {
                method,
                endpoint,
                params,
                body,
            },
            &policy,
        );
        let response = if let Some(cancel) = cancel {
            tokio::select! {biased;_ = cancel.cancelled()=>return Err(FunctionFailure::Internal),result=request=>result}
        } else {
            request.await
        };
        response
            .map(|result| result.response)
            .map_err(|_| FunctionFailure::Internal)
    }
    async fn diagnose(&self, operation: &str, channel: &str) {
        let data = json!({"function":operation,"channelID":channel,"error":"Native Twitch operation failed"});
        if let Some(logger) = &self.logger {
            let _ = logger
                .log(
                    Level::Error,
                    data,
                    LogOptions {
                        channel_id: Some(channel.into()),
                        ..Default::default()
                    },
                )
                .await;
        } else {
            eprintln!("Native Twitch operation {operation} failed");
        }
    }
    async fn finish(
        &self,
        operation: &str,
        channel: &str,
        result: Result<Value, FunctionFailure>,
        internal: Value,
        permission_type: Option<&str>,
    ) -> Value {
        match result {
            Ok(result) => result,
            Err(FunctionFailure::Denied(message)) => {
                let mut result = json!({"error":true,"message":message,"status":403});
                if let Some(kind) = permission_type {
                    result["type"] = kind.into();
                }
                result
            }
            Err(FunctionFailure::Internal) => {
                self.diagnose(operation, channel).await;
                internal
            }
        }
    }
    async fn cached(&self, key: &str) -> Result<Option<Value>, FunctionFailure> {
        let CacheValue::Text(value) = self.cache.execute(CacheCommand::Get(key.into())).await?
        else {
            return Err(FunctionFailure::Internal);
        };
        value
            .filter(|value| !value.is_empty())
            .map(|value| serde_json::from_str(&value).map_err(|_| FunctionFailure::Internal))
            .transpose()
    }
    async fn cache_value(
        &self,
        key: String,
        value: &Value,
        ttl: Option<u64>,
    ) -> Result<(), FunctionFailure> {
        self.cache
            .execute(CacheCommand::Set {
                key,
                value: serde_json::to_string(value).map_err(|_| FunctionFailure::Internal)?,
                ttl,
            })
            .await?;
        Ok(())
    }
    fn cleanup_cache_later(&self, key: String, operation: &'static str, channel: String) {
        let service = self.clone();
        tokio::spawn(async move {
            if service
                .cache
                .execute(CacheCommand::Delete(key))
                .await
                .is_err()
            {
                service.diagnose(operation, &channel).await;
            }
        });
    }
}

struct FixedTokenSource(AccessToken);
impl TokenSource for FixedTokenSource {
    fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}

pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
pub(crate) fn copy_fields(input: &Value, fields: &[(&str, &str)]) -> Map<String, Value> {
    fields
        .iter()
        .filter_map(|(source, destination)| {
            input
                .get(source)
                .cloned()
                .map(|value| ((*destination).to_owned(), value))
        })
        .collect()
}
pub(crate) fn remote_error(data: &Value, status: u16) -> Option<Value> {
    data.get("error").filter(|value| truthy(value)).map(|kind| {
        let mut error = json!({"error":true,"status":status,"type":kind});
        if let Some(message) = data.get("message") {
            error["message"] = message.clone();
        }
        error
    })
}
pub(crate) fn query(pairs: impl IntoIterator<Item = (String, String)>) -> String {
    let mut url = reqwest::Url::parse("http://fixture.invalid/").expect("constant URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_owned()
}
pub(crate) fn prefix_utf16(text: &str, units: usize) -> String {
    let mut remaining = units;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if width > remaining {
            let mut prefix = text[..index].to_owned();
            if remaining != 0 {
                prefix.push('\u{fffd}');
            }
            return prefix;
        }
        remaining -= width;
    }
    text.to_owned()
}
pub(crate) fn internal(kind: bool) -> Value {
    if kind {
        json!({"error":true,"message":"Internal server error","type":"error"})
    } else {
        json!({"error":true,"message":"Internal server error"})
    }
}
