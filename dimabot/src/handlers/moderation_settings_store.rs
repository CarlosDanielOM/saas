//! Native settings/cache dependency of the moderation message handler.
//! Construction is I/O-free; cloned stores share clients and compiled patterns.
use crate::utils::{
    bson_js_json::bson_js_json,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    moderation::{
        blacklist::{BlacklistPattern, compile_blacklist_pattern},
        spam::{default_spam_moderation_settings, spam_protection_settings_value},
    },
};
use mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use redis::aio::ConnectionManager;
use std::{
    collections::HashMap,
    future::{Future, IntoFuture},
    sync::{Arc, Mutex},
};
use tokio::{
    sync::watch,
    time::{Instant, timeout_at},
};

pub const SETTINGS_CACHE_TTL_SECONDS: u64 = 300;
pub const NO_SETTINGS_SENTINEL: &str = "{\"none\":true}";
pub fn moderation_settings_cache_key(channel: &str) -> String {
    format!("moderation:{channel}:settings")
}

#[derive(Debug)]
pub enum StoreError {
    Cancelled,
    Deadline,
    Redis(redis::RedisError),
    Mongo(mongodb::error::Error),
    Projection(String),
}

/// Deadline is absolute for the whole operation. Dropping a command on timeout
/// cannot undo a Redis write already sent; never retry an uncertain mutation.
pub struct OperationControl<'a> {
    pub deadline: Instant,
    pub abort: &'a mut watch::Receiver<bool>,
}
impl OperationControl<'_> {
    async fn run<T>(&mut self, f: impl Future<Output = T>) -> Result<T, StoreError> {
        if *self.abort.borrow() {
            return Err(StoreError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(StoreError::Deadline);
        }
        tokio::select! { biased;
            _ = async {
                loop {
                    if *self.abort.borrow() { break; }
                    if self.abort.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
            } => Err(StoreError::Cancelled),
            result = timeout_at(self.deadline, f) => result.map_err(|_| StoreError::Deadline),
        }
    }
}

/// Raw lossless JSON projection, plus the actual lean BSON when the database
/// was read. Cached/default values have no BSON document. Arc avoids deep
/// clones on hot consumers and keeps composite JS version identity alive.
#[derive(Clone, Debug)]
pub struct LoadedSettings {
    pub value: Arc<JsonValue>,
    pub mongo_document: Option<Arc<Document>>,
}
impl LoadedSettings {
    fn json(value: JsonValue) -> Self {
        Self {
            value: Arc::new(value),
            mongo_document: None,
        }
    }
}

enum Version {
    Missing,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Composite(Arc<JsonValue>),
}
impl Version {
    fn capture(settings: &Arc<JsonValue>) -> Self {
        match settings.get("settingsVersion") {
            None => Self::Missing,
            Some(JsonValue::Null) => Self::Null,
            Some(JsonValue::Bool(v)) => Self::Bool(*v),
            Some(JsonValue::Number(v)) => Self::Number(*v),
            Some(JsonValue::String(v)) => Self::String(v.clone()),
            Some(JsonValue::Array(_) | JsonValue::Object(_)) => Self::Composite(settings.clone()),
        }
    }
    fn matches(&self, settings: &JsonValue) -> bool {
        match (self, settings.get("settingsVersion")) {
            (Self::Missing, None) | (Self::Null, Some(JsonValue::Null)) => true,
            (Self::Bool(a), Some(JsonValue::Bool(b))) => a == b,
            (Self::Number(a), Some(JsonValue::Number(b))) => a == b,
            (Self::String(a), Some(JsonValue::String(b))) => a == b,
            (Self::Composite(parent), Some(b @ (JsonValue::Array(_) | JsonValue::Object(_)))) => {
                parent
                    .get("settingsVersion")
                    .is_some_and(|a| std::ptr::eq(a, b))
            }
            _ => false,
        }
    }
}
struct Entry {
    version: Version,
    patterns: HashMap<JsString, Option<Arc<BlacklistPattern>>>,
}
/// Process-local compiled patterns. Clones share the exact source-style map.
#[derive(Clone, Default)]
pub struct CompiledBlacklistCache {
    patterns: Arc<Mutex<HashMap<String, Entry>>>,
}
impl CompiledBlacklistCache {
    pub fn clear(&self) {
        self.patterns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
    pub fn remove_channel(&self, channel: &str) {
        self.patterns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(channel);
    }
    pub fn pattern(
        &self,
        channel: &str,
        settings: &Arc<JsonValue>,
        id: &JsString,
        terms: Option<&[JsString]>,
    ) -> Option<Arc<BlacklistPattern>> {
        let mut map = self.patterns.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(channel.to_owned()).or_insert_with(|| Entry {
            version: Version::capture(settings),
            patterns: HashMap::new(),
        });
        if !entry.version.matches(settings) {
            *entry = Entry {
                version: Version::capture(settings),
                patterns: HashMap::new(),
            };
        }
        entry
            .patterns
            .entry(id.clone())
            .or_insert_with(|| compile_blacklist_pattern(terms).map(Arc::new))
            .clone()
    }
}
#[derive(Clone)]
pub struct ModerationSettingsStore {
    redis: ConnectionManager,
    database: Database,
    patterns: CompiledBlacklistCache,
}
impl ModerationSettingsStore {
    pub fn new(redis: ConnectionManager, database: Database) -> Self {
        Self {
            redis,
            database,
            patterns: CompiledBlacklistCache::default(),
        }
    }
    pub fn clear_patterns(&self) {
        self.patterns.clear();
    }
    pub fn remove_channel_patterns(&self, channel: &str) {
        self.patterns.remove_channel(channel);
    }
    pub async fn invalidate(
        &self,
        channel: &str,
        control: &mut OperationControl<'_>,
    ) -> Result<(), StoreError> {
        let mut redis = self.redis.clone();
        control
            .run(
                redis::cmd("DEL")
                    .arg(moderation_settings_cache_key(channel))
                    .query_async::<i64>(&mut redis),
            )
            .await?
            .map_err(StoreError::Redis)?;
        self.remove_channel_patterns(channel);
        Ok(())
    }
    pub async fn prime(
        &self,
        channel: &str,
        settings: &JsonValue,
        control: &mut OperationControl<'_>,
    ) -> Result<(), StoreError> {
        self.remove_channel_patterns(channel);
        let mut redis = self.redis.clone();
        control
            .run(
                redis::cmd("SET")
                    .arg(moderation_settings_cache_key(channel))
                    .arg(settings.to_json_string())
                    .arg("EX")
                    .arg(SETTINGS_CACHE_TTL_SECONDS)
                    .query_async::<String>(&mut redis),
            )
            .await?
            .map_err(StoreError::Redis)?;
        Ok(())
    }
    async fn get(
        &self,
        key: &str,
        control: &mut OperationControl<'_>,
    ) -> Result<Option<String>, StoreError> {
        let mut redis = self.redis.clone();
        control
            .run(
                redis::cmd("GET")
                    .arg(key)
                    .query_async::<Option<String>>(&mut redis),
            )
            .await?
            .map_err(StoreError::Redis)
    }
    pub async fn load(
        &self,
        channel: &str,
        control: &mut OperationControl<'_>,
    ) -> Result<LoadedSettings, StoreError> {
        let key = moderation_settings_cache_key(channel);
        if let Some(cached) = self.get(&key, control).await?
            && !cached.is_empty()
        {
            if cached == NO_SETTINGS_SENTINEL {
                return Ok(default_settings(channel));
            }
            if let Ok(value) = parse_json(&cached) {
                return Ok(LoadedSettings::json(value));
            }
        }
        let collection = self
            .database
            .collection::<Document>("channel_moderation_settings");
        let doc = control
            .run(
                collection
                    .find_one(doc! {"channelID": channel})
                    .into_future(),
            )
            .await?
            .map_err(StoreError::Mongo)?;
        let mut redis = self.redis.clone();
        if let Some(document) = doc {
            let owned = Bson::Document(document);
            let value = bson_js_json(&owned).map_err(|e| StoreError::Projection(e.to_string()))?;
            let Bson::Document(document) = owned else {
                unreachable!("constructed document")
            };
            control
                .run(
                    redis::cmd("SET")
                        .arg(&key)
                        .arg(value.to_json_string())
                        .arg("EX")
                        .arg(SETTINGS_CACHE_TTL_SECONDS)
                        .query_async::<String>(&mut redis),
                )
                .await?
                .map_err(StoreError::Redis)?;
            Ok(LoadedSettings {
                value: Arc::new(value),
                mongo_document: Some(Arc::new(document)),
            })
        } else {
            let wrote = control
                .run(
                    redis::cmd("SET")
                        .arg(&key)
                        .arg(NO_SETTINGS_SENTINEL)
                        .arg("EX")
                        .arg(SETTINGS_CACHE_TTL_SECONDS)
                        .arg("NX")
                        .query_async::<Option<String>>(&mut redis),
                )
                .await?
                .map_err(StoreError::Redis)?;
            if wrote.as_deref() != Some("OK")
                && let Some(raced) = self.get(&key, control).await?
                && !raced.is_empty()
                && raced != NO_SETTINGS_SENTINEL
                && let Ok(value) = parse_json(&raced)
            {
                return Ok(LoadedSettings::json(value));
            }
            Ok(default_settings(channel))
        }
    }
    /// Uses rule identity, not terms, as the source does. A cached None is a
    /// real hit. Composite versions use JS reference identity; scalar numbers
    /// use binary64 equality, including +0 == -0 and NaN != NaN.
    pub fn blacklist_pattern(
        &self,
        channel: &str,
        settings: &Arc<JsonValue>,
        id: &JsString,
        terms: Option<&[JsString]>,
    ) -> Option<Arc<BlacklistPattern>> {
        self.patterns.pattern(channel, settings, id, terms)
    }
}
fn default_settings(channel: &str) -> LoadedSettings {
    let defaults = default_spam_moderation_settings(channel.into());
    let empty = JsonValue::Object(vec![]);
    let protection = spam_protection_settings_value(&empty).expect("empty settings are valid");
    let fields = vec![
        ("enabled".into(), JsonValue::Bool(defaults.enabled)),
        (
            "offenseWindowSeconds".into(),
            JsonValue::Number(defaults.offense_window_seconds),
        ),
        (
            "settingsVersion".into(),
            JsonValue::Number(defaults.settings_version),
        ),
        ("channelID".into(), JsonValue::String(defaults.channel_id)),
        ("channel".into(), JsonValue::String(defaults.channel)),
        ("rules".into(), JsonValue::Array(vec![])),
        ("spamProtection".into(), protection),
        (
            "createdAt".into(),
            JsonValue::String("1970-01-01T00:00:00.000Z".into()),
        ),
        (
            "updatedAt".into(),
            JsonValue::String("1970-01-01T00:00:00.000Z".into()),
        ),
    ];
    LoadedSettings::json(JsonValue::Object(fields))
}
