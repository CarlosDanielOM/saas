//! Native Site analytics collectors, snapshots, caches and scheduled refresh.
//! Construction is I/O-free; startup and orderly shutdown are explicit.
use mongodb::{
    Database,
    bson::{Document, doc},
};
use redis::aio::ConnectionManager;
use std::{collections::HashMap, fmt, future::IntoFuture, time::Duration};

pub const SITE_ANALYTICS_KEY: &str = "site:analytics:channels";
pub const SITE_ANALYTICS_LIVE_CHANNELS_KEY: &str = "site:analytics:live:channels";
pub const SITE_ANALYTICS_PROFILE_CACHE_PREFIX: &str = "site:analytics:profile:";
pub const SITE_ANALYTICS_SINGLETON_KEY: &str = "global";
pub const SITE_ANALYTICS_START_KEY: &str = "site:analytics:start";
pub const LIVE_CHANNELS_REFRESH_MS: u64 = 15_000;
pub const PROFILE_CACHE_TTL_SECONDS: u64 = 86_400;
pub const PERSISTENCE_INTERVAL_MS: u64 = 3_600_000;

/// Source aliases only; an unknown filter is passed to Redis unchanged.
pub fn resolve_analytics_field(filter: &str) -> &str {
    match filter {
        "registered" | "registered_users" => "registered_users",
        "live" | "live_users" => "live_users",
        "active" | "authorized_accounts" => "authorized_accounts",
        other => other,
    }
}

pub fn legacy_analytics_field(field: &str) -> Option<&'static str> {
    match field {
        "registered_users" => Some("registered"),
        "live_users" => Some("live"),
        "authorized_accounts" => Some("active"),
        _ => None,
    }
}

pub fn profile_cache_key(channel_id: &str) -> String {
    format!("{SITE_ANALYTICS_PROFILE_CACHE_PREFIX}{channel_id}")
}

pub fn authorized_accounts_pipeline() -> Vec<Document> {
    vec![
        doc! {"$unwind": "$accounts"},
        doc! {"$match": {"accounts.actived": true}},
        doc! {"$count": "count"},
    ]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SiteAnalyticsError {
    Configuration,
    Runtime,
    RuntimeDetail(String),
    Validation,
    NotFound,
    Timeout,
}

impl fmt::Display for SiteAnalyticsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeDetail(message) => f.write_str(message),
            Self::Configuration => f.write_str("site analytics configuration error"),
            Self::Runtime => f.write_str("site analytics runtime error"),
            Self::Validation => f.write_str("site analytics validation error"),
            Self::NotFound => f.write_str("site analytics item not found"),
            Self::Timeout => f.write_str("site analytics operation timed out"),
        }
    }
}
impl std::error::Error for SiteAnalyticsError {}

impl SiteAnalyticsError {
    fn from_error(error: &(dyn std::error::Error + 'static)) -> Self {
        let mut messages = Vec::new();
        let mut current = Some(error);
        while let Some(error) = current {
            let message = error.to_string();
            let lower = message.to_ascii_lowercase();
            if [
                "://",
                "password",
                "secret",
                "bearer ",
                "token",
                "authorization",
            ]
            .iter()
            .any(|word| lower.contains(word))
            {
                messages.push("sensitive error details redacted".to_owned());
            } else {
                messages.push(message);
            }
            if messages.len() == 8 {
                break;
            }
            current = error.source();
        }
        Self::RuntimeDetail(messages.join(": "))
    }
}

pub fn collector_failure_payload(function: &str, error: &SiteAnalyticsError) -> serde_json::Value {
    let timestamp = crate::domain_event_contracts::time::native_date_iso(
        mongodb::bson::DateTime::now().timestamp_millis(),
    );
    serde_json::json!({"function": function, "step": "site-analytics-init", "phase": "cache-warmup",
        "impact": "landing-page-stats-may-show-zeros-until-recovery", "error": error.to_string(), "timestamp": timestamp})
}

#[derive(Clone)]
pub struct SiteAnalyticsService {
    redis: ConnectionManager,
    database: Database,
    logger: crate::utils::logger::Logger,
    deadline: Duration,
    persistence_started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    live_started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: tokio::sync::watch::Sender<bool>,
    tasks: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl SiteAnalyticsService {
    /// Accepts initialized native handles without doing I/O.
    pub fn new(
        redis: ConnectionManager,
        database: Database,
        logger: crate::utils::logger::Logger,
    ) -> Self {
        Self {
            redis,
            database,
            logger,
            deadline: Duration::from_secs(12),
            persistence_started: Default::default(),
            live_started: Default::default(),
            stop: tokio::sync::watch::channel(false).0,
            tasks: Default::default(),
        }
    }

    /// Initializes the shared runtime clients explicitly, then selects the
    /// caller-supplied database. Neither this method nor `new` creates indexes.
    pub async fn from_runtime(
        database_name: &str,
        logger: crate::utils::logger::Logger,
    ) -> Result<Self, SiteAnalyticsError> {
        if database_name.trim().is_empty() {
            return Err(SiteAnalyticsError::Configuration);
        }
        let redis = crate::utils::redis::get_redis_client()
            .await
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let client = crate::utils::mongo::get_mongo_client()
            .await
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        Ok(Self::new(redis, client.database(database_name), logger))
    }

    async fn log_failure(&self, function: &str, error: &SiteAnalyticsError) {
        use crate::utils::logger::{Destination, Level, LogOptions};
        let payload = collector_failure_payload(function, error);
        let _ = self
            .logger
            .log(
                Level::Error,
                payload,
                LogOptions {
                    destination: Destination::Both,
                    ..Default::default()
                },
            )
            .await;
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub fn site_analytics_collection(&self) -> mongodb::Collection<Document> {
        crate::schemas::site_analytics::schema().native_collection(&self.database)
    }

    /// `None` or an empty filter corresponds to the source's `HGETALL` branch.
    pub async fn get_site_analytics(
        &self,
        filter: Option<&str>,
    ) -> Result<SiteAnalyticsValue, SiteAnalyticsError> {
        let mut redis = self.redis.clone();
        tokio::time::timeout(self.deadline, async {
            if let Some(field) = filter.filter(|field| !field.is_empty()) {
                let value: Option<String> = redis::cmd("HGET")
                    .arg(SITE_ANALYTICS_KEY)
                    .arg(resolve_analytics_field(field))
                    .query_async(&mut redis)
                    .await
                    .map_err(|error| SiteAnalyticsError::from_error(&error))?;
                Ok(SiteAnalyticsValue::Field(value))
            } else {
                let values: HashMap<String, String> = redis::cmd("HGETALL")
                    .arg(SITE_ANALYTICS_KEY)
                    .query_async(&mut redis)
                    .await
                    .map_err(|error| SiteAnalyticsError::from_error(&error))?;
                Ok(SiteAnalyticsValue::All(values))
            }
        })
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
    }

    pub async fn increment_site_analytics(
        &self,
        filter: &str,
        value: i64,
    ) -> Result<(), SiteAnalyticsError> {
        self.change_counter(filter, value).await
    }

    pub async fn decrement_site_analytics(
        &self,
        filter: &str,
        value: i64,
    ) -> Result<(), SiteAnalyticsError> {
        let delta = value.checked_neg().ok_or(SiteAnalyticsError::Validation)?;
        self.change_counter(filter, delta).await
    }

    async fn change_counter(&self, filter: &str, delta: i64) -> Result<(), SiteAnalyticsError> {
        let mut redis = self.redis.clone();
        let field = resolve_analytics_field(filter);
        tokio::time::timeout(self.deadline, async {
            let _: i64 = redis::cmd("HINCRBY")
                .arg(SITE_ANALYTICS_KEY)
                .arg(field)
                .arg(delta)
                .query_async(&mut redis)
                .await
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            if let Some(legacy) = legacy_analytics_field(field) {
                let _: i64 = redis::cmd("HINCRBY")
                    .arg(SITE_ANALYTICS_KEY)
                    .arg(legacy)
                    .arg(delta)
                    .query_async(&mut redis)
                    .await
                    .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            }
            Ok(())
        })
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SiteAnalyticsValue {
    Field(Option<String>),
    All(HashMap<String, String>),
}

/// Pure portion of the call-time environment policy. Invalid or fractional
/// values cannot be represented as Redis expiry seconds; see the handoff.
pub fn configured_floor(raw: Option<&str>, default: u64, floor: u64) -> u64 {
    raw.filter(|value| !value.is_empty())
        .and_then(|value| {
            if value.trim().is_empty() {
                Some(0.0)
            } else {
                value.trim().parse::<f64>().ok()
            }
        })
        .filter(|value| value.is_finite())
        .map(|value| value.max(floor as f64) as u64)
        .unwrap_or(default.max(floor))
}
pub fn live_channels_cache_ttl_seconds() -> u64 {
    configured_floor(
        std::env::var("SITE_ANALYTICS_LIVE_CHANNELS_CACHE_TTL_SECONDS")
            .ok()
            .as_deref(),
        60,
        30,
    )
}
pub fn live_channels_stale_after_ms() -> u64 {
    configured_floor(
        std::env::var("SITE_ANALYTICS_LIVE_CHANNELS_STALE_AFTER_MS")
            .ok()
            .as_deref(),
        60_000,
        LIVE_CHANNELS_REFRESH_MS * 2,
    )
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChannelNormalized {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub channel: String,
    pub stream_id: String,
    pub title: String,
    pub game_name: String,
    pub viewers: i64,
    pub profile_image_url: String,
    pub started_at: String,
    pub fetched_at: String,
    pub bot_platforms: Vec<String>,
    pub plan_tier: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteAnalyticsSnapshot {
    pub registered_users: i64,
    pub live_users: i64,
    pub total_live_viewers: i64,
    pub authorized_accounts: i64,
    pub total_messages: i64,
    pub total_commands: i64,
    pub live_channels: Vec<LiveChannelNormalized>,
}
fn source_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Object(_) => "[object Object]".into(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    source_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}
fn source_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(v) => *v,
        serde_json::Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        serde_json::Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn parse_source_int(value: &str) -> i64 {
    let value = value.trim_start();
    let start = usize::from(value.starts_with('-') || value.starts_with('+'));
    let digits = value[start..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if digits == 0 {
        0
    } else {
        value[..start + digits].parse().unwrap_or(0)
    }
}
/// Normalizes a cache entry. A missing `channelID` drops the entry.
pub fn normalize_live_channel(value: &serde_json::Value) -> Option<LiveChannelNormalized> {
    let object = value.as_object()?;
    let id = source_string(object.get("channelID")?);
    let string = |name: &str| {
        object
            .get(name)
            .filter(|v| source_truthy(v))
            .map(source_string)
            .unwrap_or_default()
    };
    let channel = object
        .get("channel")
        .filter(|v| source_truthy(v))
        .map(source_string)
        .unwrap_or_else(|| id.clone());
    let viewers = object
        .get("viewers")
        .filter(|v| !v.is_null())
        .map(source_string)
        .map(|v| parse_source_int(&v))
        .unwrap_or(0)
        .max(0);
    let bot_platforms = object
        .get("botPlatforms")
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .map(|value| source_string(value).to_lowercase())
                .filter(|value| value == "twitch" || value == "kick")
                .collect()
        })
        .unwrap_or_default();
    let plan = string("planTier");
    Some(LiveChannelNormalized {
        channel_id: id,
        channel,
        stream_id: string("streamId"),
        title: string("title"),
        game_name: string("gameName"),
        viewers,
        profile_image_url: string("profileImageUrl"),
        started_at: string("startedAt"),
        fetched_at: string("fetchedAt"),
        bot_platforms,
        plan_tier: if plan == "premium" || plan == "pro" {
            plan
        } else {
            "free".into()
        },
    })
}

impl SiteAnalyticsService {
    pub async fn increment_site_analytics_default(
        &self,
        filter: &str,
    ) -> Result<(), SiteAnalyticsError> {
        self.increment_site_analytics(filter, 1).await
    }
    pub async fn decrement_site_analytics_default(
        &self,
        filter: &str,
    ) -> Result<(), SiteAnalyticsError> {
        self.decrement_site_analytics(filter, 1).await
    }
    pub async fn get_live_channels_board(
        &self,
        require_fresh: bool,
        max_age_ms: Option<u64>,
    ) -> Result<Vec<LiveChannelNormalized>, SiteAnalyticsError> {
        let mut redis = self.redis.clone();
        let raw: Option<String> = tokio::time::timeout(
            self.deadline,
            redis::cmd("GET")
                .arg(SITE_ANALYTICS_LIVE_CHANNELS_KEY)
                .query_async(&mut redis),
        )
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
        .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let values = raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let mut channels: Vec<_> = values
            .as_ref()
            .and_then(|value| value.as_array())
            .map(|values| values.iter().filter_map(normalize_live_channel).collect())
            .unwrap_or_default();
        if require_fresh {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| SiteAnalyticsError::from_error(&error))?
                .as_millis() as i64;
            let age = max_age_ms
                .filter(|v| *v != 0)
                .unwrap_or_else(live_channels_stale_after_ms)
                .max(1);
            channels.retain(|channel| {
                crate::utils::js_date::parse_date(&channel.fetched_at)
                    .is_some_and(|at| at > 0 && (now as i128 - at as i128) <= age as i128)
            });
        }
        Ok(channels)
    }
    pub async fn get_site_analytics_snapshot(
        &self,
    ) -> Result<SiteAnalyticsSnapshot, SiteAnalyticsError> {
        let values = match self.get_site_analytics(None).await? {
            SiteAnalyticsValue::All(values) => values,
            _ => return Err(SiteAnalyticsError::Runtime),
        };
        let channels = self.get_live_channels_board(false, None).await?;
        let get = |name: &str, legacy: &str| {
            values
                .get(name)
                .filter(|v| !v.is_empty())
                .or_else(|| values.get(legacy))
                .map(|v| parse_source_int(v))
                .unwrap_or(0)
        };
        Ok(SiteAnalyticsSnapshot {
            registered_users: get("registered_users", "registered"),
            live_users: if channels.is_empty() {
                get("live_users", "live")
            } else {
                channels.len() as i64
            },
            total_live_viewers: channels.iter().map(|c| c.viewers).sum(),
            authorized_accounts: get("authorized_accounts", "active"),
            total_messages: get("total_messages", "total_messages"),
            total_commands: get("total_commands", "total_commands"),
            live_channels: channels,
        })
    }
    pub async fn persist_site_analytics_snapshot(&self) -> Result<(), SiteAnalyticsError> {
        let snapshot = self.get_site_analytics_snapshot().await?;
        let fields = mongodb::bson::serialize_to_document(&snapshot)
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let now = mongodb::bson::DateTime::now();
        let mut fields = fields;
        fields.insert("updated_at", now);
        let collection = self.site_analytics_collection();
        let operation = collection
            .update_one(
                doc! {"singletonKey": SITE_ANALYTICS_SINGLETON_KEY},
                doc! {"$set": fields, "$setOnInsert": {"created_at": now, "__v": 0}},
            )
            .upsert(true);
        tokio::time::timeout(self.deadline, operation.into_future())
            .await
            .map_err(|_| SiteAnalyticsError::Timeout)?
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        Ok(())
    }
}

impl SiteAnalyticsService {
    async fn set_analytics_snapshot(
        &self,
        snapshot: &SiteAnalyticsSnapshot,
    ) -> Result<(), SiteAnalyticsError> {
        let mut redis = self.redis.clone();
        let fields = [
            ("registered_users", snapshot.registered_users),
            ("live_users", snapshot.live_users),
            ("total_live_viewers", snapshot.total_live_viewers),
            ("authorized_accounts", snapshot.authorized_accounts),
            ("total_messages", snapshot.total_messages),
            ("total_commands", snapshot.total_commands),
            ("registered", snapshot.registered_users),
            ("live", snapshot.live_users),
            ("active", snapshot.authorized_accounts),
        ];
        let channels = serde_json::to_string(&snapshot.live_channels)
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        tokio::time::timeout(self.deadline, async {
            for (field, value) in fields {
                let _: i64 = redis::cmd("HSET")
                    .arg(SITE_ANALYTICS_KEY)
                    .arg(field)
                    .arg(value)
                    .query_async(&mut redis)
                    .await
                    .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            }
            let _: () = redis::cmd("SET")
                .arg(SITE_ANALYTICS_LIVE_CHANNELS_KEY)
                .arg(channels)
                .arg("EX")
                .arg(live_channels_cache_ttl_seconds())
                .query_async(&mut redis)
                .await
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            Ok(())
        })
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
    }
    pub async fn refresh_site_analytics_snapshot(
        &self,
    ) -> Result<SiteAnalyticsSnapshot, SiteAnalyticsError> {
        use futures_util::TryStreamExt;
        let users = self.database.collection::<Document>("users");
        let commands = self.database.collection::<Document>("commands");
        let result = tokio::time::timeout(self.deadline, async {
            let (users_count, commands_count, cursor) = tokio::try_join!(
                users.count_documents(doc! {}).into_future(),
                commands.count_documents(doc! {}).into_future(),
                users
                    .aggregate(authorized_accounts_pipeline())
                    .into_future()
            )
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            let rows: Vec<Document> = cursor
                .try_collect()
                .await
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            let authorized = rows
                .first()
                .and_then(|row| match row.get("count") {
                    Some(mongodb::bson::Bson::Int32(n)) => Some(i64::from(*n)),
                    Some(mongodb::bson::Bson::Int64(n)) => Some(*n),
                    _ => None,
                })
                .unwrap_or(0);
            Ok::<_, SiteAnalyticsError>((users_count, commands_count, authorized))
        })
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)??;
        let channels = self.get_live_channels_board(false, None).await?;
        let old = self.get_site_analytics_snapshot().await?;
        let snapshot = SiteAnalyticsSnapshot {
            registered_users: result.0 as i64,
            live_users: channels.len() as i64,
            total_live_viewers: channels.iter().map(|channel| channel.viewers).sum(),
            authorized_accounts: result.2,
            total_messages: old.total_messages,
            total_commands: result.1 as i64,
            live_channels: channels,
        };
        self.set_analytics_snapshot(&snapshot).await?;
        Ok(snapshot)
    }
}

impl SiteAnalyticsService {
    /// Fetches the source's sequential 100-ID Helix batches. Token storage is
    /// the existing concrete adapter; a failed batch is ignored as in TS.
    async fn fetch_helix_data(
        &self,
        twitch: &crate::utils::twitch::TwitchClient,
        tokens: &dyn crate::utils::twitch::TokenSource,
        endpoint: &str,
        parameter: &str,
        ids: &[String],
        live: bool,
    ) -> Result<Vec<serde_json::Value>, SiteAnalyticsError> {
        use crate::utils::twitch::{HelixRequest, HelixRetryPolicy, TwitchAuth};
        let mut output = Vec::new();
        let mut unique = Vec::new();
        for id in ids {
            if !id.is_empty() && !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        for batch in unique.chunks(100) {
            let mut url = reqwest::Url::parse("http://localhost/")
                .map_err(|_| SiteAnalyticsError::Configuration)?;
            {
                let mut query = url.query_pairs_mut();
                if live {
                    query.append_pair("type", "live");
                }
                for id in batch {
                    query.append_pair(parameter, id);
                }
            }
            let query = url.query().unwrap_or("");
            let response = twitch
                .request(
                    tokens,
                    &TwitchAuth::App,
                    HelixRequest {
                        method: reqwest::Method::GET,
                        endpoint,
                        params: Some(query),
                        body: None,
                    },
                    &HelixRetryPolicy::default(),
                )
                .await;
            let Ok(response) = response else {
                continue;
            };
            if !response.response.status().is_success() {
                continue;
            }
            let payload: serde_json::Value = response
                .response
                .json()
                .await
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            if let Some(data) = payload.get("data").and_then(|data| data.as_array()) {
                output.extend(data.iter().cloned());
            }
        }
        Ok(output)
    }

    pub async fn refresh_live_channels_board(
        &self,
        twitch: &crate::utils::twitch::TwitchClient,
        tokens: &dyn crate::utils::twitch::TokenSource,
    ) -> Result<Vec<LiveChannelNormalized>, SiteAnalyticsError> {
        use futures_util::TryStreamExt;
        let collection = self.database.collection::<Document>("users");
        let cursor = tokio::time::timeout(
            self.deadline,
            collection
                .find(doc! {"accounts.type": "twitch"})
                .projection(doc! {"accounts": 1, "plan_tier": 1})
                .into_future(),
        )
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
        .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let users: Vec<Document> = tokio::time::timeout(self.deadline, cursor.try_collect())
            .await
            .map_err(|_| SiteAnalyticsError::Timeout)?
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let mut order = Vec::<String>::new();
        let mut accounts = HashMap::<String, (String, Vec<String>, String)>::new();
        for user in users {
            let list = user.get_array("accounts").cloned().unwrap_or_default();
            let twitch_account = list.iter().filter_map(|v| v.as_document()).find(|a| {
                a.get_str("type").ok() == Some("twitch")
                    && a.get_str("id").is_ok_and(|s| !s.is_empty())
            });
            let Some(account) = twitch_account else {
                continue;
            };
            let id = account.get_str("id").unwrap_or_default().to_owned();
            let name = account
                .get_str("name")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_owned();
            let mut platforms = Vec::new();
            for account in list.iter().filter_map(|v| v.as_document()) {
                if account.get_bool("chat_enabled").unwrap_or(false)
                    && let Ok(platform @ ("twitch" | "kick")) = account.get_str("type")
                    && !platforms.iter().any(|value| value == platform)
                {
                    platforms.push(platform.to_owned());
                }
            }
            let plan = user
                .get_str("plan_tier")
                .ok()
                .filter(|s| *s == "premium" || *s == "pro")
                .unwrap_or("free")
                .to_owned();
            if !accounts.contains_key(&id) {
                order.push(id.clone());
            }
            accounts.insert(id, (name, platforms, plan));
        }
        let streams = self
            .fetch_helix_data(twitch, tokens, "streams", "user_id", &order, true)
            .await?;
        let ids: Vec<String> = streams
            .iter()
            .filter_map(|stream| stream.get("user_id"))
            .map(source_string)
            .collect();
        let mut redis = self.redis.clone();
        let keys: Vec<String> = ids.iter().map(|id| profile_cache_key(id)).collect();
        let cached: Vec<Option<String>> = if keys.is_empty() {
            vec![]
        } else {
            tokio::time::timeout(
                self.deadline,
                redis::cmd("MGET").arg(&keys).query_async(&mut redis),
            )
            .await
            .map_err(|_| SiteAnalyticsError::Timeout)?
            .map_err(|error| SiteAnalyticsError::from_error(&error))?
        };
        let mut profiles = HashMap::new();
        let mut missing = Vec::new();
        for (id, value) in ids.iter().zip(cached) {
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                profiles.insert(id.clone(), value);
            } else {
                missing.push(id.clone());
            }
        }
        let users = self
            .fetch_helix_data(twitch, tokens, "users", "id", &missing, false)
            .await?;
        for user in users {
            let id = user.get("id").map(source_string).unwrap_or_default();
            let profile = user
                .get("profile_image_url")
                .filter(|v| source_truthy(v))
                .map(source_string)
                .unwrap_or_default();
            profiles.insert(id.clone(), profile.clone());
            if !profile.is_empty() {
                let _: () = tokio::time::timeout(
                    self.deadline,
                    redis::cmd("SET")
                        .arg(profile_cache_key(&id))
                        .arg(profile)
                        .arg("EX")
                        .arg(PROFILE_CACHE_TTL_SECONDS)
                        .query_async(&mut redis),
                )
                .await
                .map_err(|_| SiteAnalyticsError::Timeout)?
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| SiteAnalyticsError::from_error(&error))?
            .as_millis() as i64;
        let fetched_at = crate::domain_event_contracts::time::native_date_iso(now);
        let mut channels = Vec::new();
        for stream in streams {
            let get = |key: &str| {
                stream
                    .get(key)
                    .filter(|value| source_truthy(value))
                    .map(source_string)
                    .unwrap_or_default()
            };
            let id = get("user_id");
            if id.is_empty() {
                continue;
            }
            let account = accounts.get(&id);
            let login = get("user_login");
            let name = get("user_name");
            let channel = if !login.is_empty() {
                login
            } else if !name.is_empty() {
                name
            } else {
                account.map(|a| a.0.clone()).unwrap_or_else(|| id.clone())
            };
            let viewers = stream
                .get("viewer_count")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(0);
            channels.push(LiveChannelNormalized {
                channel_id: id.clone(),
                channel,
                stream_id: get("id"),
                title: get("title"),
                game_name: get("game_name"),
                viewers,
                profile_image_url: profiles.get(&id).cloned().unwrap_or_default(),
                started_at: get("started_at"),
                fetched_at: fetched_at.clone(),
                bot_platforms: account.map(|a| a.1.clone()).unwrap_or_default(),
                plan_tier: account
                    .map(|a| a.2.clone())
                    .unwrap_or_else(|| "free".into()),
            });
        }
        channels.sort_by_key(|a| std::cmp::Reverse(a.viewers));
        let data = serde_json::to_string(&channels)
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        tokio::time::timeout(self.deadline, async {
            let _: () = redis::cmd("SET")
                .arg(SITE_ANALYTICS_LIVE_CHANNELS_KEY)
                .arg(data)
                .arg("EX")
                .arg(live_channels_cache_ttl_seconds())
                .query_async(&mut redis)
                .await
                .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            for (field, value) in [
                ("live_users", channels.len() as i64),
                ("live", channels.len() as i64),
                (
                    "total_live_viewers",
                    channels.iter().map(|c| c.viewers).sum(),
                ),
            ] {
                let _: i64 = redis::cmd("HSET")
                    .arg(SITE_ANALYTICS_KEY)
                    .arg(field)
                    .arg(value)
                    .query_async(&mut redis)
                    .await
                    .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            }
            Ok::<_, SiteAnalyticsError>(())
        })
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)??;
        Ok(channels)
    }
}

impl SiteAnalyticsService {
    pub async fn start_site_analytics(
        &self,
        twitch: crate::utils::twitch::TwitchClient,
        tokens: std::sync::Arc<dyn crate::utils::twitch::TokenSource>,
    ) -> Result<bool, SiteAnalyticsError> {
        let result = self.start_site_analytics_inner(twitch, tokens).await;
        if let Err(ref error) = result {
            self.log_failure("startSiteAnalytics", error).await;
        }
        result
    }
    /// Warm the cache and explicitly start the two background refresh loops.
    /// Clones share the one-time worker flags; separate service instances do not.
    async fn start_site_analytics_inner(
        &self,
        twitch: crate::utils::twitch::TwitchClient,
        tokens: std::sync::Arc<dyn crate::utils::twitch::TokenSource>,
    ) -> Result<bool, SiteAnalyticsError> {
        use std::sync::atomic::Ordering;
        let mut redis = self.redis.clone();
        let started: bool = tokio::time::timeout(
            self.deadline,
            redis::cmd("EXISTS")
                .arg(SITE_ANALYTICS_START_KEY)
                .query_async(&mut redis),
        )
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
        .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        let hash: HashMap<String, String> = tokio::time::timeout(
            self.deadline,
            redis::cmd("HGETALL")
                .arg(SITE_ANALYTICS_KEY)
                .query_async(&mut redis),
        )
        .await
        .map_err(|_| SiteAnalyticsError::Timeout)?
        .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        if hash.is_empty() {
            let collection = self.site_analytics_collection();
            let stored = tokio::time::timeout(
                self.deadline,
                collection
                    .find_one(doc! {"singletonKey": SITE_ANALYTICS_SINGLETON_KEY})
                    .into_future(),
            )
            .await
            .map_err(|_| SiteAnalyticsError::Timeout)?
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
            if let Some(stored) = stored {
                let snapshot: SiteAnalyticsSnapshot =
                    mongodb::bson::deserialize_from_document(stored)
                        .map_err(|error| SiteAnalyticsError::from_error(&error))?;
                self.set_analytics_snapshot(&snapshot).await?;
            }
        }
        if self.get_live_channels_board(false, None).await?.is_empty() {
            self.refresh_live_channels_board(&twitch, tokens.as_ref())
                .await?;
        }
        self.refresh_site_analytics_snapshot().await?;
        if !started {
            let _: () = tokio::time::timeout(
                self.deadline,
                redis::cmd("SET")
                    .arg(SITE_ANALYTICS_START_KEY)
                    .arg("1")
                    .query_async(&mut redis),
            )
            .await
            .map_err(|_| SiteAnalyticsError::Timeout)?
            .map_err(|error| SiteAnalyticsError::from_error(&error))?;
        }
        self.persist_site_analytics_snapshot().await?;
        self.start_site_analytics_persistence_worker();
        if !self.live_started.swap(true, Ordering::SeqCst) {
            let service = self.clone();
            let mut stop = self.stop.subscribe();
            let task = tokio::spawn(async move {
                let mut ticks =
                    analytics_interval(Duration::from_millis(LIVE_CHANNELS_REFRESH_MS), true);
                loop {
                    if !wait_for_analytics_tick(&mut ticks, &mut stop).await {
                        break;
                    }
                    if let Err(error) = service
                        .refresh_live_channels_board(&twitch, tokens.as_ref())
                        .await
                    {
                        service
                            .log_failure("refreshLiveChannelsBoard", &error)
                            .await;
                    }
                }
            });
            self.tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(task);
        }
        Ok(true)
    }
}

#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedLiveStatus {
    pub is_live: bool,
    pub checked_at: String,
    pub stream: Option<CachedLiveStream>,
}
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct CachedLiveStream {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    pub viewer_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}
impl SiteAnalyticsService {
    pub async fn get_live_channels_by_channel_id_map(
        &self,
    ) -> Result<HashMap<String, LiveChannelNormalized>, SiteAnalyticsError> {
        Ok(self
            .get_live_channels_board(true, None)
            .await?
            .into_iter()
            .map(|channel| (channel.channel_id.clone(), channel))
            .collect())
    }
    pub async fn get_cached_live_status(
        &self,
        channel_id: &str,
    ) -> Result<CachedLiveStatus, SiteAnalyticsError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| SiteAnalyticsError::from_error(&error))?
            .as_millis() as i64;
        let checked_at = crate::domain_event_contracts::time::native_date_iso(now);
        let id = crate::utils::js_compat::trim(channel_id);
        if id.is_empty() {
            return Ok(CachedLiveStatus {
                is_live: false,
                checked_at,
                stream: None,
            });
        }
        let mut channels = self.get_live_channels_by_channel_id_map().await?;
        let Some(channel) = channels.remove(id) else {
            return Ok(CachedLiveStatus {
                is_live: false,
                checked_at,
                stream: None,
            });
        };
        Ok(CachedLiveStatus {
            is_live: true,
            checked_at: if channel.fetched_at.is_empty() {
                checked_at
            } else {
                channel.fetched_at
            },
            stream: Some(CachedLiveStream {
                title: (!channel.title.is_empty()).then_some(channel.title),
                game_name: (!channel.game_name.is_empty()).then_some(channel.game_name),
                viewer_count: channel.viewers,
                started_at: (!channel.started_at.is_empty()).then_some(channel.started_at),
            }),
        })
    }
}

impl SiteAnalyticsService {
    /// Explicit counterpart of the source persistence-worker export. Starts
    /// once per shared service and waits for the genuinely future hourly tick.
    pub fn start_site_analytics_persistence_worker(&self) {
        use std::sync::atomic::Ordering;
        if !self.persistence_started.swap(true, Ordering::SeqCst) {
            let service = self.clone();
            let mut stop = self.stop.subscribe();
            let task = tokio::spawn(async move {
                let mut ticks =
                    analytics_interval(Duration::from_millis(PERSISTENCE_INTERVAL_MS), false);
                loop {
                    if !wait_for_analytics_tick(&mut ticks, &mut stop).await {
                        break;
                    }
                    if let Err(error) = service.persist_site_analytics_snapshot().await {
                        service
                            .log_failure("persistSiteAnalyticsSnapshot", &error)
                            .await;
                    }
                }
            });
            self.tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(task);
        }
    }
}

/// Fixed future deadlines. A late tick runs once immediately, then skips missed
/// deadlines to the next future tick; work stays sequential and never overlaps.
/// `immediate` preserves the first live refresh; persistence waits one hour.
pub fn analytics_interval(period: Duration, immediate: bool) -> tokio::time::Interval {
    let now = tokio::time::Instant::now();
    let mut ticks = tokio::time::interval_at(if immediate { now } else { now + period }, period);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticks
}
/// Shutdown wins over a simultaneously ready tick. In-flight units finish;
/// no uncertain database write is cancelled or retried by stopping the worker.
pub async fn wait_for_analytics_tick(
    ticks: &mut tokio::time::Interval,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> bool {
    if *stop.borrow() {
        return false;
    }
    tokio::select! { biased;
        _ = stop.changed() => false,
        _ = ticks.tick() => true,
    }
}
impl SiteAnalyticsService {
    /// Terminal orderly stop shared by clones. The owning application should
    /// call this before closing the supplied Mongo/Redis/Twitch dependencies.
    pub async fn stop_site_analytics(&self) {
        self.stop.send_replace(true);
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        for task in tasks {
            let _ = task.await;
        }
    }
}
