//! Native channel catalogs and global/channel TTS emote names.
//!
//! Constructors accept existing application handles and perform no I/O or
//! environment reads. Redis uses the source keys/TTLs; app credentials come
//! from the concrete native token storage. Helix GETs make one attempt, with
//! the source's three-second response/body deadline starting after credentials
//! are acquired. No catalog request falls back to global emotes.
//!
//! The ordinary-JSON cache boundary preserves UTF-16, extra cached properties,
//! and Date.parse input coercion. Executable hooks/custom prototypes are outside
//! that boundary. HTTP bodies have an explicit 16 MiB size limit and JSON
//! nesting uses the shared lossless parser's 128-level limit. Those bounds are
//! intentional native resource limits rather than source parity claims.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use reqwest::Client;
use tokio::sync::{OnceCell, watch};

use super::{
    js_date::parse_date_utf16,
    js_string::JsString,
    json_number::number_string,
    lossless_json::{JsonValue, parse_json},
    twitch::{TwitchAuth, TwitchEndpoints, build_headers},
    twitch_tokens::TwitchTokenStorage,
};

pub const MAX_EMOTE_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const EMOTE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
pub const EMOTE_CACHE_INIT_TIMEOUT: Duration = Duration::from_secs(5);
const GLOBAL_KEY: &str = "twitch:global:tts:emotes";
const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
const MAX_EMOTES: usize = 2000;

/// Wall-clock milliseconds, separate from token expiry's whole-second clock.
pub trait EmoteClock: Send + Sync {
    fn now_millis(&self) -> i64;
}

#[derive(Debug, Default)]
pub struct SystemEmoteClock;
impl EmoteClock for SystemEmoteClock {
    fn now_millis(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(elapsed) => elapsed.as_millis().min(i64::MAX as u128) as i64,
            Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogStatus {
    Ready,
    Stale,
    Unavailable,
}
impl CatalogStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Cached rows retain their original properties for source-compatible output.
#[derive(Clone, Debug, PartialEq)]
pub struct Emote {
    pub id: JsString,
    pub name: JsString,
    original: JsonValue,
}
impl Emote {
    pub fn to_json_value(&self) -> JsonValue {
        let mut value = self.original.clone();
        replace_field(&mut value, "id", JsonValue::String(self.id.clone()));
        replace_field(&mut value, "name", JsonValue::String(self.name.clone()));
        value
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChannelEmoteCatalog {
    pub emotes: Vec<Emote>,
    pub status: CatalogStatus,
    /// Retains ordinary JSON values accepted by Date.parse, including numbers
    /// and arrays. Null denotes an unavailable check time.
    pub checked_at: JsonValue,
    early_unavailable: bool,
}
impl ChannelEmoteCatalog {
    fn unavailable() -> Self {
        Self {
            emotes: Vec::new(),
            status: CatalogStatus::Unavailable,
            checked_at: JsonValue::Null,
            early_unavailable: true,
        }
    }

    pub fn to_json_value(&self) -> JsonValue {
        let emotes = JsonValue::Array(self.emotes.iter().map(Emote::to_json_value).collect());
        let status = text(self.status.as_str());
        if self.early_unavailable {
            object([
                ("emotes", emotes),
                ("status", status),
                ("checkedAt", self.checked_at.clone()),
            ])
        } else {
            object([
                ("emotes", emotes),
                ("checkedAt", self.checked_at.clone()),
                ("status", status),
            ])
        }
    }

    pub fn to_json_string(&self) -> String {
        self.to_json_value().to_json_string()
    }
}

/// Lazy concrete cache boundary. Construction performs no I/O or environment
/// reads. Supply an application-owned token storage and an unconnected Redis
/// client; this wrapper does not initialize Mongo, indexes, or background jobs.
/// Clones share successful initialization and all catalog singleflights. A
/// failed initialization is retryable, and its detached leader survives waiter
/// cancellation. The application still owns logging, telemetry and bootstrap.
#[derive(Clone)]
pub struct TwitchEmoteRuntime {
    config: Arc<RuntimeConfig>,
    ready: Arc<OnceCell<TwitchEmoteCatalog>>,
    initializing: SingleFlight<Option<TwitchEmoteCatalog>>,
}

struct RuntimeConfig {
    client_id: String,
    endpoints: TwitchEndpoints,
    http: Client,
    tokens: Arc<TwitchTokenStorage>,
    redis: redis::Client,
    clock: Arc<dyn EmoteClock>,
    connect_timeout: Duration,
    request_timeout: Duration,
}

impl TwitchEmoteRuntime {
    pub fn new(
        client_id: impl Into<String>,
        endpoints: TwitchEndpoints,
        http: Client,
        tokens: Arc<TwitchTokenStorage>,
        redis: redis::Client,
    ) -> Self {
        Self::from_config(RuntimeConfig {
            client_id: client_id.into(),
            endpoints,
            http,
            tokens,
            redis,
            clock: Arc::new(SystemEmoteClock),
            connect_timeout: EMOTE_CACHE_INIT_TIMEOUT,
            request_timeout: EMOTE_REQUEST_TIMEOUT,
        })
    }

    fn from_config(config: RuntimeConfig) -> Self {
        Self {
            config: Arc::new(config),
            ready: Arc::new(OnceCell::new()),
            initializing: SingleFlight::default(),
        }
    }

    /// Reconfiguration creates a separate initialization and flight scope.
    pub fn with_clock(self, clock: Arc<dyn EmoteClock>) -> Self {
        self.reconfigure(Some(clock), None, None)
    }

    /// Override the connect-and-PING bound, for isolated fixtures.
    pub fn with_connect_timeout(self, timeout: Duration) -> Self {
        self.reconfigure(None, Some(timeout), None)
    }

    /// Override the HTTP response/body bound independently of initialization.
    pub fn with_request_timeout(self, timeout: Duration) -> Self {
        self.reconfigure(None, None, Some(timeout))
    }

    fn reconfigure(
        self,
        clock: Option<Arc<dyn EmoteClock>>,
        connect: Option<Duration>,
        request: Option<Duration>,
    ) -> Self {
        let c = &self.config;
        Self::from_config(RuntimeConfig {
            client_id: c.client_id.clone(),
            endpoints: c.endpoints.clone(),
            http: c.http.clone(),
            tokens: c.tokens.clone(),
            redis: c.redis.clone(),
            clock: clock.unwrap_or_else(|| c.clock.clone()),
            connect_timeout: connect.unwrap_or(c.connect_timeout),
            request_timeout: request.unwrap_or(c.request_timeout),
        })
    }

    async fn catalog(&self) -> Option<TwitchEmoteCatalog> {
        if let Some(catalog) = self.ready.get() {
            return Some(catalog.clone());
        }
        let config = self.config.clone();
        let ready = self.ready.clone();
        self.initializing
            .run(JsString::from(""), None, async move {
                ready
                    .get_or_try_init(|| async {
                        let manager = tokio::time::timeout(config.connect_timeout, async {
                            let options = ConnectionManagerConfig::new().set_response_timeout(None);
                            let mut manager = config
                                .redis
                                .get_connection_manager_with_config(options)
                                .await
                                .map_err(|_| ())?;
                            let _: String = redis::cmd("PING")
                                .query_async(&mut manager)
                                .await
                                .map_err(|_| ())?;
                            Ok::<_, ()>(manager)
                        })
                        .await
                        .map_err(|_| ())??;
                        Ok::<_, ()>(
                            TwitchEmoteCatalog::new(
                                config.client_id.clone(),
                                config.endpoints.clone(),
                                config.http.clone(),
                                config.tokens.clone(),
                                manager,
                            )
                            .with_clock(config.clock.clone())
                            .with_request_timeout(config.request_timeout),
                        )
                    })
                    .await
                    .ok()
                    .cloned()
            })
            .await
    }

    pub async fn get_channel_emote_catalog(&self, channel_id: &JsString) -> ChannelEmoteCatalog {
        if !valid_channel_id(channel_id) {
            return ChannelEmoteCatalog::unavailable();
        }
        match self.catalog().await {
            Some(catalog) => catalog.get_channel_emote_catalog(channel_id).await,
            None => ChannelEmoteCatalog::unavailable(),
        }
    }

    pub async fn get_tts_emote_names(&self, channel_id: &JsString) -> Vec<JsString> {
        match self.catalog().await {
            Some(catalog) => catalog.get_tts_emote_names(channel_id).await,
            None => Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct TwitchEmoteCatalog {
    inner: Arc<CatalogInner>,
    catalogs: SingleFlight<ChannelEmoteCatalog>,
    names: SingleFlight<Vec<JsString>>,
}
struct CatalogInner {
    client_id: String,
    endpoints: TwitchEndpoints,
    client: Client,
    tokens: Arc<TwitchTokenStorage>,
    cache: ConnectionManager,
    clock: Arc<dyn EmoteClock>,
    request_timeout: Duration,
}
impl TwitchEmoteCatalog {
    pub fn new(
        client_id: impl Into<String>,
        endpoints: TwitchEndpoints,
        client: Client,
        token_storage: Arc<TwitchTokenStorage>,
        cache: ConnectionManager,
    ) -> Self {
        Self {
            inner: Arc::new(CatalogInner {
                client_id: client_id.into(),
                endpoints,
                client,
                tokens: token_storage,
                cache,
                clock: Arc::new(SystemEmoteClock),
                request_timeout: EMOTE_REQUEST_TIMEOUT,
            }),
            catalogs: SingleFlight::default(),
            names: SingleFlight::default(),
        }
    }

    /// Configure before sharing the service. Clones made afterward share all
    /// in-flight work. Reconfiguration starts a separate in-flight scope.
    pub fn with_clock(self, clock: Arc<dyn EmoteClock>) -> Self {
        self.reconfigure(Some(clock), None)
    }

    /// Fixture deadline override; ordinary callers retain three seconds.
    pub fn with_request_timeout(self, timeout: Duration) -> Self {
        self.reconfigure(None, Some(timeout))
    }

    fn reconfigure(self, clock: Option<Arc<dyn EmoteClock>>, timeout: Option<Duration>) -> Self {
        Self {
            inner: Arc::new(CatalogInner {
                client_id: self.inner.client_id.clone(),
                endpoints: self.inner.endpoints.clone(),
                client: self.inner.client.clone(),
                tokens: self.inner.tokens.clone(),
                cache: self.inner.cache.clone(),
                clock: clock.unwrap_or_else(|| self.inner.clock.clone()),
                request_timeout: timeout.unwrap_or(self.inner.request_timeout),
            }),
            catalogs: SingleFlight::default(),
            names: SingleFlight::default(),
        }
    }

    pub async fn get_channel_emote_catalog(&self, channel_id: &JsString) -> ChannelEmoteCatalog {
        let owner = self.clone();
        let channel = channel_id.clone();
        self.catalogs
            .run(
                channel_id.clone(),
                ChannelEmoteCatalog::unavailable(),
                async move { owner.load_catalog(&channel).await },
            )
            .await
    }

    /// Global names precede channel names, with lossless JavaScript Set order.
    pub async fn get_tts_emote_names(&self, channel_id: &JsString) -> Vec<JsString> {
        let global = JsString::from("");
        let (global_names, channel_names) =
            tokio::join!(self.cached_names(&global), self.cached_names(channel_id));
        let mut seen = HashSet::new();
        global_names
            .into_iter()
            .chain(channel_names)
            .filter(|name| seen.insert(name.clone()))
            .collect()
    }

    async fn cached_names(&self, channel_id: &JsString) -> Vec<JsString> {
        let owner = self.clone();
        let channel = channel_id.clone();
        self.names
            .run(channel_id.clone(), Vec::new(), async move {
                if channel.is_empty() {
                    owner.load_global_names().await
                } else {
                    owner
                        .get_channel_emote_catalog(&channel)
                        .await
                        .emotes
                        .into_iter()
                        .map(|emote| emote.name)
                        .collect()
                }
            })
            .await
    }

    async fn load_catalog(&self, channel_id: &JsString) -> ChannelEmoteCatalog {
        if !valid_channel_id(channel_id) {
            return ChannelEmoteCatalog::unavailable();
        }
        // Validation proves this value is ASCII, so no lossy ID conversion.
        let channel = channel_id.as_str().expect("validated ASCII channel");
        let key = format!("twitch:{channel}:emote-catalog:v1");
        // A failed GET and corrupt JSON are repairable on this channel path.
        let previous = self
            .inner
            .get(&key)
            .await
            .ok()
            .flatten()
            .and_then(|raw| parse_json(&raw).ok())
            .and_then(CachedCatalog::parse);
        if let Some(previous) = &previous
            && previous.retry_at > self.inner.clock.now_millis() as f64
        {
            return previous.view(self.inner.clock.as_ref());
        }

        let fetched = async {
            let query = format!("broadcaster_id={channel}");
            let body = self.inner.fetch("chat/emotes", Some(&query)).await?;
            let emotes = parse_fetched_emotes(&body)?;
            let checked_at = native_date_iso(self.inner.clock.now_millis()).ok_or(())?;
            let saved = CachedCatalog::new(
                emotes,
                JsonValue::String(JsString::from(checked_at)),
                self.inner.clock.now_millis() as f64 + HOUR_MS,
            );
            self.inner.set(&key, &saved.raw, 86_400).await?;
            Ok::<_, ()>(saved)
        }
        .await;
        if let Ok(saved) = fetched {
            return saved.view(self.inner.clock.as_ref());
        }

        // This nested fallback is deliberate: even a successful fetch whose
        // cache SET failed falls back to the previous catalog. If this SET also
        // fails, the outer source catch returns the early unavailable shape.
        let mut saved =
            previous.unwrap_or_else(|| CachedCatalog::new(Vec::new(), JsonValue::Null, 0.0));
        saved.retry_at = self.inner.clock.now_millis() as f64 + 60_000.0;
        replace_field(&mut saved.raw, "retryAt", JsonValue::Number(saved.retry_at));
        if self.inner.set(&key, &saved.raw, 86_400).await.is_err() {
            return ChannelEmoteCatalog::unavailable();
        }
        saved.view(self.inner.clock.as_ref())
    }

    async fn load_global_names(&self) -> Vec<JsString> {
        // Unlike channel catalogs, a global GET or JSON parse error ends the
        // request without attempting Helix or writing a fallback cache value.
        let cached = match self.inner.get(GLOBAL_KEY).await {
            Ok(cached) => cached,
            Err(()) => return Vec::new(),
        };
        if let Some(raw) = cached.filter(|raw| !raw.is_empty()) {
            let value = match parse_json(&raw) {
                Ok(value) => value,
                Err(_) => return Vec::new(),
            };
            if let JsonValue::Array(values) = &value
                && values
                    .iter()
                    .all(|value| matches!(value, JsonValue::String(_)))
            {
                return values
                    .iter()
                    .filter_map(|value| match value {
                        JsonValue::String(name) => Some(name.clone()),
                        _ => None,
                    })
                    .collect();
            }
        }
        let fetched = match self.inner.fetch("chat/emotes/global", None).await {
            Ok(body) => parse_global_names(&body),
            Err(()) => Err(()),
        };
        let succeeded = fetched.is_ok();
        let names = fetched.unwrap_or_default();
        let value = JsonValue::Array(names.iter().cloned().map(JsonValue::String).collect());
        if self
            .inner
            .set(GLOBAL_KEY, &value, if succeeded { 3600 } else { 60 })
            .await
            .is_err()
        {
            return Vec::new();
        }
        names
    }
}

impl CatalogInner {
    async fn get(&self, key: &str) -> Result<Option<String>, ()> {
        let mut cache = self.cache.clone();
        redis::cmd("GET")
            .arg(key)
            .query_async(&mut cache)
            .await
            .map_err(|_| ())
    }

    async fn set(&self, key: &str, value: &JsonValue, ttl: u64) -> Result<(), ()> {
        let mut cache = self.cache.clone();
        redis::cmd("SET")
            .arg(key)
            .arg(value.to_json_string())
            .arg("EX")
            .arg(ttl)
            .query_async::<()>(&mut cache)
            .await
            .map_err(|_| ())
    }

    async fn fetch(&self, endpoint: &str, query: Option<&str>) -> Result<JsonValue, ()> {
        let token = self
            .tokens
            .acquire_token(&TwitchAuth::App)
            .await
            .map_err(|_| ())?;
        let headers = build_headers(&self.client_id, &token, &TwitchAuth::App).map_err(|_| ())?;
        let url = self.endpoints.helix_url(endpoint, query).map_err(|_| ())?;
        tokio::time::timeout(self.request_timeout, async {
            let mut response = self
                .client
                .get(url)
                .headers(headers)
                .send()
                .await
                .map_err(|_| ())?;
            let ok = response.status().is_success();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
                if chunk.len() > MAX_EMOTE_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            // Fetch's JSON boundary decodes UTF-8 with replacement and removes
            // one leading UTF-8 BOM, irrespective of Content-Type charset.
            let decoded = String::from_utf8_lossy(&bytes);
            let value =
                parse_json(decoded.strip_prefix('\u{feff}').unwrap_or(&decoded)).map_err(|_| ())?;
            if !ok {
                return Err(());
            }
            Ok(value)
        })
        .await
        .map_err(|_| ())?
    }
}

struct CachedCatalog {
    raw: JsonValue,
    emotes: Vec<Emote>,
    checked_at: JsonValue,
    retry_at: f64,
}
impl CachedCatalog {
    fn parse(raw: JsonValue) -> Option<Self> {
        let JsonValue::Array(rows) = raw.get("emotes")? else {
            return None;
        };
        if rows.len() > MAX_EMOTES {
            return None;
        }
        let emotes = rows
            .iter()
            .map(parse_cached_emote)
            .collect::<Option<Vec<_>>>()?;
        let checked_at = raw.get("checkedAt")?.clone();
        if !matches!(checked_at, JsonValue::Null) && parsed_date(&checked_at).is_none() {
            return None;
        }
        let JsonValue::Number(retry_at) = raw.get("retryAt")? else {
            return None;
        };
        if !retry_at.is_finite() {
            return None;
        }
        let retry_at = *retry_at;
        Some(Self {
            raw,
            emotes,
            checked_at,
            retry_at,
        })
    }

    fn new(emotes: Vec<Emote>, checked_at: JsonValue, retry_at: f64) -> Self {
        let raw = object([
            (
                "emotes",
                JsonValue::Array(emotes.iter().map(Emote::to_json_value).collect()),
            ),
            ("checkedAt", checked_at.clone()),
            ("retryAt", JsonValue::Number(retry_at)),
        ]);
        Self {
            raw,
            emotes,
            checked_at,
            retry_at,
        }
    }

    fn view(&self, clock: &dyn EmoteClock) -> ChannelEmoteCatalog {
        let age = if truthy(&self.checked_at) {
            parsed_date(&self.checked_at).map_or(f64::NAN, |checked| {
                clock.now_millis() as f64 - checked as f64
            })
        } else {
            f64::INFINITY
        };
        ChannelEmoteCatalog {
            emotes: if age < DAY_MS {
                self.emotes.clone()
            } else {
                Vec::new()
            },
            checked_at: self.checked_at.clone(),
            status: if age >= DAY_MS {
                CatalogStatus::Unavailable
            } else if age < HOUR_MS {
                CatalogStatus::Ready
            } else {
                CatalogStatus::Stale
            },
            early_unavailable: false,
        }
    }
}

fn valid_channel_id(value: &JsString) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    (1..=30).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_emote_id(value: &JsString) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn parse_cached_emote(row: &JsonValue) -> Option<Emote> {
    let JsonValue::String(id) = row.get("id")? else {
        return None;
    };
    let JsonValue::String(name) = row.get("name")? else {
        return None;
    };
    valid_emote_id(id).then(|| Emote {
        id: id.clone(),
        name: name.clone(),
        original: row.clone(),
    })
}

fn parse_fetched_emotes(body: &JsonValue) -> Result<Vec<Emote>, ()> {
    let Some(JsonValue::Array(rows)) = body.get("data") else {
        return Err(());
    };
    if rows.len() > MAX_EMOTES {
        return Err(());
    }
    rows.iter()
        .map(|row| {
            let parsed = parse_cached_emote(row).ok_or(())?;
            let name = parsed.name.slice(0, 64);
            let original = object([
                ("id", JsonValue::String(parsed.id.clone())),
                ("name", JsonValue::String(name.clone())),
            ]);
            Ok(Emote {
                id: parsed.id,
                name,
                original,
            })
        })
        .collect()
}

fn parse_global_names(body: &JsonValue) -> Result<Vec<JsString>, ()> {
    let Some(JsonValue::Array(rows)) = body.get("data") else {
        return Err(());
    };
    let mut names = Vec::new();
    for row in rows {
        // JS property access on null throws, invalidating the whole map.
        if matches!(row, JsonValue::Null) {
            return Err(());
        }
        if let Some(JsonValue::String(name)) = row.get("name")
            && !name.is_empty()
        {
            names.push(name.clone());
        }
    }
    Ok(names)
}

fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsonValue::String(value) => !value.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}

// Date.parse first performs String(value). This is the ordinary-JSON subset of
// the same coercion in tts::settings, kept independent of schema normalization.
fn ordinary_string(value: &JsonValue) -> Option<JsString> {
    match value {
        JsonValue::Null => Some(JsString::from("null")),
        JsonValue::Bool(value) => Some(JsString::from(if *value { "true" } else { "false" })),
        JsonValue::Number(value) => Some(JsString::from(number_string(*value))),
        JsonValue::String(value) => Some(value.clone()),
        JsonValue::Object(_) if value.get("toString").is_some() => None,
        JsonValue::Object(_) => Some(JsString::from("[object Object]")),
        JsonValue::Array(values) => {
            let mut units = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(value, JsonValue::Null) {
                    units.extend(ordinary_string(value)?.code_units());
                }
            }
            Some(JsString::from_units(units))
        }
    }
}

fn parsed_date(value: &JsonValue) -> Option<i64> {
    parse_date_utf16(&ordinary_string(value)?.units())
}

fn object<const N: usize>(fields: [(&str, JsonValue); N]) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (JsString::from(key), value))
            .collect(),
    )
}
fn text(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}
fn replace_field(value: &mut JsonValue, key: &str, replacement: JsonValue) {
    if let JsonValue::Object(fields) = value {
        if let Some((_, current)) = fields
            .iter_mut()
            .find(|(name, _)| name.as_str() == Some(key))
        {
            *current = replacement;
        } else {
            fields.push((JsString::from(key), replacement));
        }
    }
}

// Same Gregorian/expanded-year arithmetic as domain_events::time::native_date_iso.
// Kept local to avoid enabling the unrelated domain-event feature graph.
fn native_date_iso(timestamp: i64) -> Option<String> {
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&timestamp) {
        return None;
    }
    let days = timestamp.div_euclid(86_400_000);
    let millis = timestamp.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year >= 0 {
        format!("+{year:06}")
    } else {
        format!("-{year:06}", year = -year)
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z",
        hour = millis / 3_600_000,
        minute = (millis / 60_000) % 60,
        second = (millis / 1000) % 60,
        fraction = millis % 1000,
    ))
}

type Pending<T> = Arc<Mutex<HashMap<JsString, watch::Receiver<Option<T>>>>>;

#[derive(Clone)]
struct SingleFlight<T> {
    pending: Pending<T>,
}
impl<T> Default for SingleFlight<T> {
    fn default() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
struct FlightGuard<T> {
    pending: Pending<T>,
    key: JsString,
}
impl<T> Drop for FlightGuard<T> {
    fn drop(&mut self) {
        lock(&self.pending).remove(&self.key);
    }
}
impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    async fn run(
        &self,
        key: JsString,
        fallback: T,
        load: impl Future<Output = T> + Send + 'static,
    ) -> T {
        let mut receiver = {
            let mut pending = lock(&self.pending);
            if let Some(receiver) = pending.get(&key) {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                pending.insert(key.clone(), receiver.clone());
                let guard = FlightGuard {
                    pending: self.pending.clone(),
                    key,
                };
                // The leader is owned by the runtime, so dropping any or all
                // waiter futures cannot cancel cache repair or leak an entry.
                let _leader = tokio::spawn(async move {
                    let value = load.await;
                    drop(guard);
                    let _ = sender.send_replace(Some(value));
                });
                receiver
            }
        };
        loop {
            if let Some(value) = receiver.borrow_and_update().clone() {
                return value;
            }
            if receiver.changed().await.is_err() {
                return fallback;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedClock(i64);
    impl EmoteClock for FixedClock {
        fn now_millis(&self) -> i64 {
            self.0
        }
    }

    #[test]
    fn ordinary_dates_retain_values_and_use_javascript_truthiness() {
        let raw = parse_json(r#"{"emotes":[{"id":"x","name":"old","extra":"\ud800"}],"checkedAt":0,"retryAt":1e20,"extra":true}"#).unwrap();
        let previous = CachedCatalog::parse(raw).unwrap();
        let view = previous.view(&FixedClock(0));
        assert_eq!(view.status, CatalogStatus::Unavailable);
        assert!(view.emotes.is_empty());
        assert_eq!(view.checked_at, JsonValue::Number(0.0));
        assert_eq!(
            ordinary_string(&parse_json("[2020]").unwrap())
                .unwrap()
                .as_str(),
            Some("2020")
        );
        assert!(parsed_date(&parse_json("[2020]").unwrap()).is_some());
        assert!(parsed_date(&parse_json("[]").unwrap()).is_none());
        assert!(parsed_date(&parse_json(r#"{"toString":null}"#).unwrap()).is_none());
        assert!(previous.raw.to_json_string().contains(r#""extra":true"#));
    }

    #[test]
    fn source_wire_order_and_cached_extra_emote_properties_survive() {
        let now = super::super::js_date::parse_date("2026-10-29T12:00:00Z").unwrap();
        let raw = parse_json(r#"{"emotes":[{"name":"\ud800","id":"x","extra":7}],"checkedAt":"2026-10-29T12:00:00.000Z","retryAt":1e20}"#).unwrap();
        let catalog = CachedCatalog::parse(raw).unwrap().view(&FixedClock(now));
        assert_eq!(
            catalog.to_json_string(),
            r#"{"emotes":[{"name":"\ud800","id":"x","extra":7}],"checkedAt":"2026-10-29T12:00:00.000Z","status":"ready"}"#
        );
        assert_eq!(
            ChannelEmoteCatalog::unavailable().to_json_string(),
            r#"{"emotes":[],"status":"unavailable","checkedAt":null}"#
        );
    }

    #[test]
    fn names_use_utf16_slicing_only_on_the_http_channel_path() {
        let name = format!("{}😀", "a".repeat(63));
        let body = object([(
            "data",
            JsonValue::Array(vec![object([
                ("id", text("valid_-09")),
                ("name", text(&name)),
                ("extra", text("removed")),
            ])]),
        )]);
        let fetched = parse_fetched_emotes(&body).unwrap();
        assert_eq!(fetched[0].name.len(), 64);
        assert_eq!(fetched[0].name.code_units().last(), Some(0xd83d));
        assert!(fetched[0].to_json_value().get("extra").is_none());
        let Some(JsonValue::Array(rows)) = body.get("data") else {
            panic!("array fixture");
        };
        let cached = parse_cached_emote(&rows[0]).unwrap();
        assert_eq!(cached.name.len(), 65);
        assert_eq!(
            parse_global_names(&body).unwrap(),
            vec![JsString::from(name)]
        );
        assert!(
            parse_global_names(&object([("data", JsonValue::Array(vec![JsonValue::Null]))]))
                .is_err()
        );
    }

    #[test]
    fn catalog_age_boundaries_and_expanded_iso_dates() {
        let checked = "2026-10-29T12:00:00.000Z";
        let now = super::super::js_date::parse_date(checked).unwrap();
        let saved = CachedCatalog::new(vec![], text(checked), 0.0);
        for (age, status) in [
            (-1, CatalogStatus::Ready),
            (3_599_999, CatalogStatus::Ready),
            (3_600_000, CatalogStatus::Stale),
            (86_399_999, CatalogStatus::Stale),
            (86_400_000, CatalogStatus::Unavailable),
        ] {
            assert_eq!(saved.view(&FixedClock(now + age)).status, status);
        }
        for (millis, expected) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
            (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
        ] {
            assert_eq!(native_date_iso(millis).as_deref(), Some(expected));
        }
        assert!(native_date_iso(i64::MAX).is_none());
    }

    #[test]
    fn ids_reject_non_ascii_and_line_terminators() {
        for value in ["1\n", "1\r", "1\u{2028}", "1\u{2029}", "１２", ""] {
            assert!(!valid_channel_id(&JsString::from(value)));
        }
        for value in ["a\n", "a\r", "a\u{2028}", "a\u{2029}", "é", ""] {
            assert!(!valid_emote_id(&JsString::from(value)));
        }
        assert!(valid_channel_id(&JsString::from("0".repeat(30))));
        assert!(!valid_channel_id(&JsString::from("0".repeat(31))));
        assert!(valid_emote_id(&JsString::from("x".repeat(64))));
        assert!(!valid_emote_id(&JsString::from("x".repeat(65))));
    }

    #[tokio::test]
    async fn detached_leader_survives_waiter_cancellation_and_cleans_up() {
        let flights = SingleFlight::<usize>::default();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let first_map = flights.clone();
        let first = tokio::spawn(async move {
            first_map
                .run(JsString::from("x"), 0, async move {
                    let _ = started_sender.send(());
                    let _ = release_receiver.await;
                    7
                })
                .await
        });
        started_receiver.await.unwrap();
        first.abort();
        let second = flights.run(JsString::from("x"), 0, async {
            panic!("duplicate leader");
        });
        tokio::pin!(second);
        // Poll the joining waiter before releasing the leader. This proves
        // registration without relying on scheduler order or a timing delay.
        tokio::select! {
            biased;
            _ = &mut second => panic!("leader should still be gated"),
            _ = std::future::ready(()) => {}
        }
        release_sender.send(()).unwrap();
        assert_eq!(second.await, 7);
        assert!(lock(&flights.pending).is_empty());
        assert_eq!(flights.run(JsString::from("x"), 0, async { 9 }).await, 9);
    }
}
