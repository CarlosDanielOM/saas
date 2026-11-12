//! Public site analytics (`utils/siteanalytics.ts`). Callers own scheduling and supply stores,
//! a clock and startup configuration. All calls have deadlines; this crate reads no environment.
//! Counter aliases retain their legacy mirror fields, including negative and unknown counters.
//!
//! Rebuilt cache families: `site:analytics:channels` (hash, no TTL),
//! `site:analytics:live:channels` (JSON string, 60 s by default, minimum 30),
//! `site:analytics:profile:<id>` (URL string, 24 h), `site:analytics:start` (string, no TTL).
//! Rust adds `site:analytics:refresh:lock` (random owner string, refresh deadline + store
//! deadline + 1 s, default 151 s, deleted after each operation). A busy caller reads the
//! previous board. Publication is atomic and fenced, preventing a slow partial refresh from
//! overwriting a newer complete board. Snapshot cache publication shares that fence.
//!
//! Streams and profiles are requested sequentially in 100-ID batches; the reference ignores
//! pagination cursors. A non-2xx/header timeout skips that batch and may publish an empty or
//! partial board; malformed JSON throws and leaves the previous board under its existing TTL.
//! The shared Twitch client owns app-token encryption and 401 refresh; unlike the reference's
//! cached-token reread, it can actually exchange the rejected credential. Site-level Helix
//! retries retain 1/3/5-second delays. There is no disk spool or background task here.
//!
//! The reference accepts invalid TTL configuration until Redis rejects it; `from_values`
//! rejects it at startup instead. A 100,000-channel default bound refuses oversized refreshes
//! before publication, and a 120-second whole-refresh deadline bounds stalled work. The
//! reference has neither bound. No UTF-16 lengths, truncations or text ordering are used.
use crate::{Error, bounded};
use bson::{Bson, Document, doc};
use dima_core::Clock;
use dima_http::Path;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::{Script, SetOptions, SetOutcome};
use dima_store::mongo::MongoStore;
use dima_twitch::{Auth, HelixRequest, Twitch};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::{sync::Arc, time::Duration};

pub const SITE_ANALYTICS_KEY: &str = "site:analytics:channels";
pub const LIVE_CHANNELS_KEY: &str = "site:analytics:live:channels";
pub const PROFILE_CACHE_PREFIX: &str = "site:analytics:profile:";
pub const START_KEY: &str = "site:analytics:start";

#[derive(Debug, Clone)]
pub struct Config {
    /// Empty in production; tests isolate keys with an owned prefix.
    pub key_prefix: String,
    /// No deadline in the reference. Thirty seconds bounds a hung store operation.
    pub store_deadline: Duration,
    pub live_cache_ttl_seconds: u64,
    pub stale_after_ms: f64,
    /// Reference has no request timeout. Bounds a hung Twitch call, including body reads.
    pub request_deadline: Duration,
    /// Whole refresh bound. Its lease lasts this long plus one store deadline.
    pub refresh_deadline: Duration,
    /// Refuse an excessive board before publishing any part of it.
    pub max_channels: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            key_prefix: String::new(),
            store_deadline: Duration::from_secs(30),
            live_cache_ttl_seconds: 60,
            stale_after_ms: 60_000.0,
            request_deadline: Duration::from_secs(60),
            refresh_deadline: Duration::from_secs(120),
            max_channels: 100_000,
        }
    }
}
#[derive(Clone)]
pub struct SiteAnalytics {
    cache: Dragonfly,
    random: Arc<dyn dima_core::Random>,
    clock: Arc<dyn Clock>,
    config: Config,
    persistence_guard: Arc<tokio::sync::Mutex<()>>,
    started: Arc<std::sync::atomic::AtomicBool>,
}
fn field(filter: &str) -> &str {
    match filter {
        "registered" => "registered_users",
        "live" => "live_users",
        "active" => "authorized_accounts",
        _ => filter,
    }
}
fn mirror(filter: &str) -> Option<&str> {
    match filter {
        "registered_users" => Some("registered"),
        "live_users" => Some("live"),
        "authorized_accounts" => Some("active"),
        _ => None,
    }
}
impl SiteAnalytics {
    pub fn new(cache: Dragonfly, clock: Arc<dyn Clock>, config: Config) -> Self {
        Self {
            cache,
            random: Arc::new(dima_core::SystemRandom),
            clock,
            config,
            persistence_guard: Arc::new(tokio::sync::Mutex::new(())),
            started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    /// Overrides lease-token randomness; the default is the operating system generator.
    pub fn with_random(mut self, random: Arc<dyn dima_core::Random>) -> Self {
        self.random = random;
        self
    }
    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.config.key_prefix)
    }
    /// A scalar string or null for a nonempty filter; an object of strings for absent/empty.
    pub async fn get_site_analytics(&self, filter: Option<&str>) -> Result<Value, Error> {
        let key = self.key(SITE_ANALYTICS_KEY);
        if let Some(filter) = filter.filter(|s| !s.is_empty()) {
            let value = bounded(
                self.config.store_deadline,
                self.cache.hget(&key, field(filter)),
            )
            .await?;
            return Ok(value
                .map(|v| json!(String::from_utf8_lossy(&v)))
                .unwrap_or(Value::Null));
        }
        let pairs = bounded(self.config.store_deadline, self.cache.hgetall(&key)).await?;
        Ok(Value::Object(
            pairs.into_iter().map(|(k, v)| (k, json!(v))).collect(),
        ))
    }
    pub async fn increment_site_analytics(&self, filter: &str, value: i64) -> Result<(), Error> {
        let field = field(filter);
        let key = self.key(SITE_ANALYTICS_KEY);
        let mut command = redis::cmd("HINCRBY");
        command.arg(&key).arg(field).arg(value);
        bounded(
            self.config.store_deadline,
            self.cache.query::<i64>(&command),
        )
        .await?;
        if let Some(legacy) = mirror(field) {
            let mut command = redis::cmd("HINCRBY");
            command.arg(&key).arg(legacy).arg(value);
            bounded(
                self.config.store_deadline,
                self.cache.query::<i64>(&command),
            )
            .await?;
        }
        Ok(())
    }
    pub async fn decrement_site_analytics(&self, filter: &str, value: i64) -> Result<(), Error> {
        let negative = value
            .checked_neg()
            .ok_or_else(|| Error::Invalid("counter amount out of range".into()))?;
        self.increment_site_analytics(filter, negative).await
    }
}

/// Reference's 15-second refresh cadence; the process owning the schedule calls refresh.
pub const LIVE_REFRESH_INTERVAL: Duration = Duration::from_secs(15);
pub const REFRESH_LOCK_KEY: &str = "site:analytics:refresh:lock";
const PROFILE_TTL: u64 = 86_400;
static PUBLISH_BOARD: Script = Script::new(
    "site analytics publish",
    include_str!("site_analytics_publish.lua"),
);
static RELEASE_REFRESH: Script = Script::new(
    "site analytics release",
    include_str!("site_analytics_release.lua"),
);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChannelNormalized {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub channel: String,
    pub stream_id: String,
    pub title: String,
    pub game_name: String,
    pub viewers: f64,
    pub profile_image_url: String,
    pub started_at: String,
    pub fetched_at: String,
    pub bot_platforms: Vec<String>,
    pub plan_tier: String,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct BoardOptions {
    pub require_fresh: bool,
    pub max_age_ms: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLiveStatus {
    pub is_live: bool,
    pub checked_at: String,
    pub stream: Option<CachedStream>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CachedStream {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    pub viewer_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}
fn text(value: Option<&Value>) -> String {
    value
        .map(dima_text::string_of)
        .unwrap_or_else(|| "undefined".into())
}
fn fallback_text(value: Option<&Value>, fallback: &str) -> String {
    value
        .filter(|v| dima_text::js_truthy(*v))
        .map(dima_text::string_of)
        .unwrap_or_else(|| fallback.into())
}
fn integer(value: Option<&Value>) -> f64 {
    let value = value
        .filter(|v| !v.is_null())
        .map(dima_text::string_of)
        .unwrap_or_else(|| "0".into());
    let number = dima_text::parse_int(&value, dima_text::Radix::Decimal);
    if number.is_finite() { number } else { 0.0 }
}
fn tier(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("premium") => "premium",
        Some("pro") => "pro",
        _ => "free",
    }
    .into()
}
fn nonnegative(number: f64) -> f64 {
    if number <= 0.0 { 0.0 } else { number }
}
fn normalized(raw: &Value) -> Option<LiveChannelNormalized> {
    raw.as_object()?.get("channelID")?;
    let channel_id = text(raw.get("channelID"));
    Some(LiveChannelNormalized {
        channel: fallback_text(raw.get("channel"), &channel_id),
        channel_id,
        stream_id: fallback_text(raw.get("streamId"), ""),
        title: fallback_text(raw.get("title"), ""),
        game_name: fallback_text(raw.get("gameName"), ""),
        viewers: nonnegative(integer(raw.get("viewers"))),
        profile_image_url: fallback_text(raw.get("profileImageUrl"), ""),
        started_at: fallback_text(raw.get("startedAt"), ""),
        fetched_at: fallback_text(raw.get("fetchedAt"), ""),
        bot_platforms: raw
            .get("botPlatforms")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|v| dima_text::string_of(v).to_lowercase())
            .filter(|v| v == "twitch" || v == "kick")
            .collect(),
        plan_tier: tier(raw.get("planTier")),
    })
}
fn document_json(document: Document) -> Value {
    // Read-only projection. BSON numbers keep their JavaScript numeric meaning.
    dima_events::value::Value::from_bson(&Bson::Document(document))
        .to_json()
        .unwrap_or(Value::Null)
}
impl SiteAnalytics {
    fn now_iso(&self) -> Result<String, Error> {
        dima_text::to_iso_string(self.clock.now_ms())
            .ok_or_else(|| Error::Invalid("Invalid clock".into()))
    }
    pub async fn get_live_channels_board(
        &self,
        options: BoardOptions,
    ) -> Result<Vec<LiveChannelNormalized>, Error> {
        let raw = bounded(
            self.config.store_deadline,
            self.cache.get(&self.key(LIVE_CHANNELS_KEY)),
        )
        .await?;
        let Some(parsed) = raw.and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            return Ok(Vec::new());
        };
        let mut channels: Vec<_> = parsed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(normalized)
            .collect();
        if channels.len() > self.config.max_channels {
            return Err(Error::Invalid("live board exceeds configured bound".into()));
        }
        if options.require_fresh {
            let age = options
                .max_age_ms
                .filter(|n| *n != 0.0 && !n.is_nan())
                .unwrap_or(self.config.stale_after_ms);
            let age = if age.is_nan() { f64::NAN } else { age.max(1.0) };
            channels.retain(|channel| {
                dima_text::parse_date(&channel.fetched_at)
                    .is_some_and(|ms| ms > 0 && self.clock.now_ms() as f64 - ms as f64 <= age)
            });
        }
        Ok(channels)
    }
    pub async fn get_live_channels_by_channel_id_map(
        &self,
    ) -> Result<HashMap<String, LiveChannelNormalized>, Error> {
        Ok(self
            .get_live_channels_board(BoardOptions {
                require_fresh: true,
                ..Default::default()
            })
            .await?
            .into_iter()
            .map(|c| (c.channel_id.clone(), c))
            .collect())
    }
    /// Accepts the caller's string/number JSON value, as the public helper does.
    pub async fn get_cached_live_status(&self, channel: &Value) -> Result<CachedLiveStatus, Error> {
        let id = fallback_text(Some(channel), "");
        let id = dima_text::trim(&id);
        let mut status = CachedLiveStatus {
            is_live: false,
            checked_at: self.now_iso()?,
            stream: None,
        };
        if id.is_empty() {
            return Ok(status);
        }
        if let Some(channel) = self.get_live_channels_by_channel_id_map().await?.remove(id) {
            let optional = |s: String| if s.is_empty() { None } else { Some(s) };
            status.is_live = true;
            status.checked_at = channel.fetched_at;
            status.stream = Some(CachedStream {
                title: optional(channel.title),
                game_name: optional(channel.game_name),
                viewer_count: channel.viewers,
                started_at: optional(channel.started_at),
            });
        }
        Ok(status)
    }
    async fn acquire_refresh(&self) -> Result<Option<String>, Error> {
        let token = self
            .random
            .uuid_v4()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let ttl = self
            .config
            .refresh_deadline
            .saturating_add(self.config.store_deadline)
            .as_secs()
            .saturating_add(1);
        let result = bounded(
            self.config.store_deadline,
            self.cache.set(
                &self.key(REFRESH_LOCK_KEY),
                token.as_bytes(),
                SetOptions::if_missing_ex(ttl),
            ),
        )
        .await?;
        Ok(matches!(result, SetOutcome::Written).then_some(token))
    }
    async fn release_refresh(&self, token: &str) -> Result<(), Error> {
        bounded(
            self.config.store_deadline,
            RELEASE_REFRESH.run::<i64, _, _>(&self.cache, &[self.key(REFRESH_LOCK_KEY)], &[token]),
        )
        .await?;
        Ok(())
    }
    /// Distributed single flight: the loser reads the existing board. Build off-cache and
    /// atomically publish the full candidate plus its counters only while still holding the
    /// lease. Unlike the reference, an expired/slower refresh cannot replace a newer board.
    /// Single-refresh failure behavior stays: non-2xx/network failures skip a batch; invalid
    /// JSON throws before publication. Profile-cache writes already done are retained.
    pub async fn refresh_live_channels_board(
        &self,
        store: &MongoStore,
        twitch: &Twitch,
    ) -> Result<Vec<LiveChannelNormalized>, Error> {
        let Some(token) = self.acquire_refresh().await? else {
            return self.get_live_channels_board(BoardOptions::default()).await;
        };
        let result = tokio::time::timeout(
            self.config.refresh_deadline,
            self.refresh_board_inner(store, twitch, &token),
        )
        .await
        .map_err(|_| Error::Deadline)
        .and_then(|r| r);
        let released = self.release_refresh(&token).await;
        match result {
            Ok(value) => {
                released?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
    async fn helix_data(
        &self,
        twitch: &Twitch,
        path: Path,
        query: Vec<(&str, String)>,
    ) -> Result<Vec<Value>, Error> {
        let mut request = HelixRequest::get(path, Auth::App)
            .retry_on_401()
            .timeout(self.config.request_deadline)
            .worker("site_analytics");
        for (k, v) in query {
            request = request.query(k, v);
        }
        // Header/network failures are caught by executeHelixAppRequestWith401Retry in TS.
        let response = match twitch.helix(request).await {
            Ok(r) if r.status().is_success() => r,
            _ => return Ok(Vec::new()),
        };
        let value: Value = response
            .into_response()
            .json()
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
        Ok(value
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
    async fn refresh_board_inner(
        &self,
        store: &MongoStore,
        twitch: &Twitch,
        token: &str,
    ) -> Result<Vec<LiveChannelNormalized>, Error> {
        let mut cursor = bounded(
            self.config.store_deadline,
            store
                .documents(dima_model::users::COLLECTION)
                .find(doc! {"accounts.type":"twitch"})
                .projection(doc! {"accounts":1,"plan_tier":1}),
        )
        .await?;
        let mut accounts = Vec::<(String, String, Vec<String>, String)>::new();
        let mut positions = HashMap::new();
        while let Some(user) = bounded(self.config.store_deadline, cursor.try_next()).await? {
            let user = document_json(user);
            let all = user["accounts"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let Some(twitch) = all
                .iter()
                .find(|a| a["type"] == "twitch" && a.get("id").is_some_and(dima_text::js_truthy))
            else {
                continue;
            };
            let id = text(twitch.get("id"));
            let channel = fallback_text(twitch.get("name"), &id);
            let mut platforms = Vec::new();
            for a in all {
                if a.get("chat_enabled").is_some_and(dima_text::js_truthy)
                    && matches!(a["type"].as_str(), Some("twitch" | "kick"))
                {
                    let p = text(a.get("type"));
                    if !platforms.contains(&p) {
                        platforms.push(p);
                    }
                }
            }
            let entry = (id.clone(), channel, platforms, tier(user.get("plan_tier")));
            if let Some(index) = positions.get(&id).copied() {
                accounts[index] = entry;
            } else {
                positions.insert(id, accounts.len());
                accounts.push(entry);
            }
            if accounts.len() > self.config.max_channels {
                return Err(Error::Invalid("live board exceeds configured bound".into()));
            }
        }
        let mut streams = Vec::new();
        for batch in accounts.chunks(100) {
            let mut query = vec![("type", "live".into())];
            query.extend(batch.iter().map(|a| ("user_id", a.0.clone())));
            streams.extend(
                self.helix_data(twitch, Path::fixed("/streams"), query)
                    .await?,
            );
            if streams.len() > self.config.max_channels {
                return Err(Error::Invalid(
                    "Twitch board exceeds configured bound".into(),
                ));
            }
        }
        let mut ids = Vec::new();
        for stream in &streams {
            if let Some(id) = stream.get("user_id").filter(|v| dima_text::js_truthy(*v)) {
                let id = text(Some(id));
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        let mut profiles = HashMap::<String, String>::new();
        let mut missing = Vec::new();
        if !ids.is_empty() {
            let mut command = redis::cmd("MGET");
            for id in &ids {
                command.arg(self.key(&format!("{PROFILE_CACHE_PREFIX}{id}")));
            }
            let cached = bounded(
                self.config.store_deadline,
                self.cache.query::<Vec<Option<String>>>(&command),
            )
            .await?;
            for (id, value) in ids.into_iter().zip(cached) {
                if let Some(value) = value.filter(|v| !v.is_empty()) {
                    profiles.insert(id, value);
                } else {
                    missing.push(id);
                }
            }
        }
        for batch in missing.chunks(100) {
            let data = self
                .helix_data(
                    twitch,
                    Path::fixed("/users"),
                    batch.iter().map(|id| ("id", id.clone())).collect(),
                )
                .await?;
            for user in data {
                let image = fallback_text(user.get("profile_image_url"), "");
                let id = text(user.get("id"));
                if !image.is_empty() {
                    bounded(
                        self.config.store_deadline,
                        self.cache.set(
                            &self.key(&format!("{PROFILE_CACHE_PREFIX}{id}")),
                            image.as_bytes(),
                            SetOptions::ex(PROFILE_TTL),
                        ),
                    )
                    .await?;
                }
                profiles.insert(id, image);
            }
        }
        let fetched_at = self.now_iso()?;
        let mut channels = Vec::new();
        for stream in streams
            .iter()
            .filter(|s| s.get("user_id").is_some_and(dima_text::js_truthy))
        {
            let id = text(stream.get("user_id"));
            let account = positions.get(&id).and_then(|i| accounts.get(*i));
            let viewers = stream
                .get("viewer_count")
                .filter(|v| dima_text::js_truthy(*v))
                .map(dima_text::js_number)
                .unwrap_or(0.0);
            channels.push(LiveChannelNormalized {
                channel: fallback_text(
                    stream.get("user_login"),
                    &fallback_text(stream.get("user_name"), account.map_or(&id, |a| &a.1)),
                ),
                channel_id: id.clone(),
                stream_id: fallback_text(stream.get("id"), ""),
                title: fallback_text(stream.get("title"), ""),
                game_name: fallback_text(stream.get("game_name"), ""),
                viewers: nonnegative(viewers),
                profile_image_url: profiles.get(&id).cloned().unwrap_or_default(),
                started_at: fallback_text(stream.get("started_at"), ""),
                fetched_at: fetched_at.clone(),
                bot_platforms: account.map(|a| a.2.clone()).unwrap_or_default(),
                plan_tier: account
                    .map(|a| a.3.clone())
                    .unwrap_or_else(|| "free".into()),
            });
        }
        channels.sort_by(|a, b| {
            b.viewers
                .partial_cmp(&a.viewers)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let json = dima_text::to_js_json(&serde_json::to_value(&channels)?);
        let total = channels.iter().fold(0.0, |sum, c| sum + c.viewers);
        let published = bounded(
            self.config.store_deadline,
            PUBLISH_BOARD.run::<i64, _, _>(
                &self.cache,
                &[
                    self.key(REFRESH_LOCK_KEY),
                    self.key(LIVE_CHANNELS_KEY),
                    self.key(SITE_ANALYTICS_KEY),
                ],
                &[
                    token.to_owned(),
                    json,
                    self.config.live_cache_ttl_seconds.max(30).to_string(),
                    channels.len().to_string(),
                    dima_text::number_to_string(total),
                ],
            ),
        )
        .await?;
        if published != 1 {
            return Err(Error::Invalid(
                "refresh lease lost before publication".into(),
            ));
        }
        Ok(channels)
    }
}

/// The process owning analytics must call the persistence tick every hour and refresh the
/// live board every 15 seconds. The reference uses unref'd setInterval callbacks; it has no
/// overlap guard, so slow hourly writes can overlap. Rust serializes ticks on clones of this
/// handle; a required unique Mongo singleton index makes writes from separate processes safe.
/// No timer or detached task is started by this module.
pub const PERSISTENCE_INTERVAL: Duration = Duration::from_secs(3600);
static PUBLISH_SNAPSHOT: Script = Script::new(
    "site analytics snapshot",
    include_str!("site_analytics_snapshot.lua"),
);
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteAnalyticsSnapshot {
    pub registered_users: f64,
    pub live_users: f64,
    pub total_live_viewers: f64,
    pub authorized_accounts: f64,
    pub total_messages: f64,
    pub total_commands: f64,
    pub live_channels: Vec<LiveChannelNormalized>,
}
impl SiteAnalytics {
    pub async fn get_site_analytics_snapshot(&self) -> Result<SiteAnalyticsSnapshot, Error> {
        let all = self.get_site_analytics(None).await?;
        let live_channels = self
            .get_live_channels_board(BoardOptions::default())
            .await?;
        let from = |key: &str, legacy: &str| {
            integer(
                all.get(key)
                    .filter(|v| dima_text::js_truthy(*v))
                    .or_else(|| all.get(legacy)),
            )
        };
        Ok(SiteAnalyticsSnapshot {
            registered_users: from("registered_users", "registered"),
            live_users: if live_channels.is_empty() {
                from("live_users", "live")
            } else {
                live_channels.len() as f64
            },
            total_live_viewers: live_channels.iter().fold(0.0, |sum, c| sum + c.viewers),
            authorized_accounts: from("authorized_accounts", "active"),
            total_messages: integer(all.get("total_messages")),
            total_commands: integer(all.get("total_commands")),
            live_channels,
        })
    }
    async fn set_snapshot(
        &self,
        snapshot: &SiteAnalyticsSnapshot,
        token: &str,
    ) -> Result<(), Error> {
        let board = dima_text::to_js_json(&serde_json::to_value(&snapshot.live_channels)?);
        let args = vec![
            token.to_owned(),
            board,
            self.config.live_cache_ttl_seconds.max(30).to_string(),
            dima_text::number_to_string(snapshot.registered_users),
            dima_text::number_to_string(snapshot.live_users),
            dima_text::number_to_string(snapshot.total_live_viewers),
            dima_text::number_to_string(snapshot.authorized_accounts),
            dima_text::number_to_string(snapshot.total_messages),
            dima_text::number_to_string(snapshot.total_commands),
        ];
        let result = bounded(
            self.config.store_deadline,
            PUBLISH_SNAPSHOT.run::<i64, _, _>(
                &self.cache,
                &[
                    self.key(REFRESH_LOCK_KEY),
                    self.key(LIVE_CHANNELS_KEY),
                    self.key(SITE_ANALYTICS_KEY),
                ],
                &args,
            ),
        )
        .await?;
        if result != 1 {
            return Err(Error::Invalid(
                "refresh lease lost before snapshot publication".into(),
            ));
        }
        Ok(())
    }
    pub async fn refresh_site_analytics_snapshot(
        &self,
        store: &MongoStore,
    ) -> Result<SiteAnalyticsSnapshot, Error> {
        let Some(token) = self.acquire_refresh().await? else {
            return self.get_site_analytics_snapshot().await;
        };
        let result = tokio::time::timeout(self.config.refresh_deadline, async {
            let users = store.documents(dima_model::users::COLLECTION);
            let command_collection = store.documents(dima_model::commands::COLLECTION);
            let (registered, mut authorized, commands) = tokio::try_join!(
                bounded(self.config.store_deadline, users.count_documents(doc! {})),
                bounded(
                    self.config.store_deadline,
                    users.aggregate([
                        doc! {"$unwind":"$accounts"},
                        doc! {"$match":{"accounts.actived":true}},
                        doc! {"$count":"count"}
                    ])
                ),
                bounded(
                    self.config.store_deadline,
                    command_collection.count_documents(doc! {})
                ),
            )?;
            let authorized = bounded(self.config.store_deadline, authorized.try_next())
                .await?
                .map(document_json)
                .unwrap_or(Value::Null);
            let existing = self.get_site_analytics_snapshot().await?;
            let live_channels = self
                .get_live_channels_board(BoardOptions::default())
                .await?;
            let snapshot = SiteAnalyticsSnapshot {
                registered_users: registered as f64,
                live_users: live_channels.len() as f64,
                total_live_viewers: live_channels.iter().fold(0.0, |sum, c| sum + c.viewers),
                authorized_accounts: authorized
                    .get("count")
                    .map(dima_text::js_number)
                    .unwrap_or(0.0),
                total_messages: existing.total_messages,
                total_commands: commands as f64,
                live_channels,
            };
            self.set_snapshot(&snapshot, &token).await?;
            Ok(snapshot)
        })
        .await
        .map_err(|_| Error::Deadline)
        .and_then(|r| r);
        let released = self.release_refresh(&token).await;
        match result {
            Ok(v) => {
                released?;
                Ok(v)
            }
            Err(e) => Err(e),
        }
    }
    /// One upsert, with the schema's defaults, BSON numbers, snake-case timestamps and __v.
    /// Startup must ensure the singleton index and supply its report; no index is created here.
    pub async fn persist_site_analytics_snapshot(
        &self,
        store: &MongoStore,
        indexes: &dima_model::IndexReport,
    ) -> Result<(), Error> {
        use dima_model::site_analytics::{COLLECTION, INDEXES, INFO};
        use dima_store::mongo::{
            WriteContext,
            update::{Returned, UpdateOptions},
        };
        dima_events::indexes::require_unique(indexes, COLLECTION, INDEXES)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let _guard =
            tokio::time::timeout(self.config.store_deadline, self.persistence_guard.lock())
                .await
                .map_err(|_| Error::Deadline)?;
        let snapshot = self.get_site_analytics_snapshot().await?;
        let snapshot =
            bson::serialize_to_document(&snapshot).map_err(|e| Error::Invalid(e.to_string()))?;
        let mut context = WriteContext::new(self.clock.now_ms());
        let prepared = INFO.prepare_find_one_and_update(
            &doc! {"singletonKey":"global"},
            doc! {"$set":snapshot},
            UpdateOptions::upsert(),
            Returned::After,
            &mut context,
        )?;
        bounded(
            self.config.store_deadline,
            store.writes(COLLECTION).find_one_and_update(&prepared),
        )
        .await?;
        Ok(())
    }
    /// The hourly worker's one tick. The process owns the interval and shutdown token.
    pub async fn site_analytics_persistence_tick(
        &self,
        store: &MongoStore,
        indexes: &dima_model::IndexReport,
    ) -> Result<(), Error> {
        self.persist_site_analytics_snapshot(store, indexes).await
    }
    pub async fn start_site_analytics(
        &self,
        store: &MongoStore,
        twitch: &Twitch,
        indexes: &dima_model::IndexReport,
    ) -> Result<bool, Error> {
        let started = bounded(
            self.config.store_deadline,
            self.cache.exists(&[&self.key(START_KEY)]),
        )
        .await?
            > 0;
        let all = self.get_site_analytics(None).await?;
        if all.as_object().is_some_and(|o| o.is_empty()) {
            let persisted = bounded(
                self.config.store_deadline,
                store
                    .documents(dima_model::site_analytics::COLLECTION)
                    .find_one(doc! {"singletonKey":"global"}),
            )
            .await?;
            if let Some(persisted) = persisted {
                let value = document_json(persisted);
                let number = |key: &str| {
                    value
                        .get(key)
                        .filter(|v| dima_text::js_truthy(*v))
                        .map(dima_text::js_number)
                        .unwrap_or(0.0)
                };
                let snapshot = SiteAnalyticsSnapshot {
                    registered_users: number("registeredUsers"),
                    live_users: number("liveUsers"),
                    total_live_viewers: number("totalLiveViewers"),
                    authorized_accounts: number("authorizedAccounts"),
                    total_messages: number("totalMessages"),
                    total_commands: number("totalCommands"),
                    live_channels: value["liveChannels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(normalized)
                        .collect(),
                };
                if let Some(token) = self.acquire_refresh().await? {
                    let result = self.set_snapshot(&snapshot, &token).await;
                    let released = self.release_refresh(&token).await;
                    result?;
                    released?;
                }
            }
        }
        if self
            .get_live_channels_board(BoardOptions::default())
            .await?
            .is_empty()
        {
            self.refresh_live_channels_board(store, twitch).await?;
        }
        self.refresh_site_analytics_snapshot(store).await?;
        if !started {
            bounded(
                self.config.store_deadline,
                self.cache
                    .set(&self.key(START_KEY), b"1", SetOptions::default()),
            )
            .await?;
        }
        self.persist_site_analytics_snapshot(store, indexes).await?;
        // The reference's live worker performs an immediate, failure-isolated refresh before
        // its 15 s interval. Await it here so no detached task outlives this caller.
        if !self.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let _ = self.refresh_live_channels_board(store, twitch).await;
        }
        Ok(true)
    }
}
impl Config {
    /// Startup values of SITE_ANALYTICS_LIVE_CHANNELS_CACHE_TTL_SECONDS and
    /// SITE_ANALYTICS_LIVE_CHANNELS_STALE_AFTER_MS. Invalid TTLs fail startup instead of a SET.
    pub fn from_values(ttl: Option<&str>, stale: Option<&str>) -> Result<Self, Error> {
        let parse = |text: Option<&str>, default: f64| {
            text.filter(|s| !s.is_empty())
                .map(dima_text::parse_number)
                .unwrap_or(default)
        };
        let ttl = parse(ttl, 60.0);
        let ttl = if ttl.is_nan() { ttl } else { ttl.max(30.0) };
        if !ttl.is_finite() || ttl.fract() != 0.0 || ttl > u64::MAX as f64 {
            return Err(Error::Invalid("invalid site analytics cache TTL".into()));
        }
        let stale = parse(stale, 60000.0);
        Ok(Self {
            live_cache_ttl_seconds: ttl.max(30.0) as u64,
            stale_after_ms: if stale.is_nan() {
                stale
            } else {
                stale.max(30000.0)
            },
            ..Default::default()
        })
    }
}
