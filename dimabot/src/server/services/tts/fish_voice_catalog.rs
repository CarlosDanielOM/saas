//! Fish voice validation, normalization and pooled catalog transport.
//!
//! Credentials and endpoints are explicit. Clones share the parsed-response FIFO
//! cache, and neither HTTP requests nor normalization hold its mutex.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{
    fish_tts::{DEFAULT_FISH_TTS_REFERENCE_ID, FISH_VOICES},
    http_support,
};
use crate::utils::{
    js_compat,
    js_string::JsString,
    json_number::{number_string, string_number},
};
use regex::Regex;

pub use super::lossless_json::{JsonValue, parse_json};

pub const FISH_CATALOG_TIMEOUT: Duration = Duration::from_secs(12);
pub const FISH_CATALOG_CACHE_TTL: Duration = Duration::from_secs(60);
pub const FISH_CATALOG_CACHE_CAPACITY: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceRequestError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}
impl fmt::Display for VoiceRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for VoiceRequestError {}

/// Only `Request` corresponds to the source's VoiceRequestError. JSON syntax,
/// body-read and JavaScript coercion failures remain ordinary failure categories.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FishCatalogError {
    Request(VoiceRequestError),
    Json(String),
    Body(String),
    Coercion(String),
    Limit(&'static str),
}
impl fmt::Display for FishCatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => error.fmt(f),
            Self::Json(message) | Self::Body(message) | Self::Coercion(message) => {
                f.write_str(message)
            }
            Self::Limit(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for FishCatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(error) => Some(error),
            _ => None,
        }
    }
}
impl From<VoiceRequestError> for FishCatalogError {
    fn from(error: VoiceRequestError) -> Self {
        Self::Request(error)
    }
}
fn request_error(status: u16, code: &'static str, message: &'static str) -> FishCatalogError {
    VoiceRequestError {
        status,
        code,
        message,
    }
    .into()
}
fn invalid_filters() -> FishCatalogError {
    request_error(400, "invalid_filters", "Invalid voice search filters")
}
fn primitive_error() -> FishCatalogError {
    FishCatalogError::Coercion("Cannot convert object to primitive value".into())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FishVoiceSearch {
    pub name: JsString,
    pub gender: String,
    pub language: String,
    pub license: String,
    pub page: u8,
}
impl FishVoiceSearch {
    pub fn to_json_string(&self) -> String {
        format!(
            "{{\"name\":{},\"gender\":{},\"language\":{},\"license\":{},\"page\":{}}}",
            self.name.to_json_string(),
            quote(&self.gender),
            quote(&self.language),
            quote(&self.license),
            self.page
        )
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Empty or absent input selects the default. Whitespace-only input is invalid.
pub fn resolve_fish_voice(value: Option<&str>) -> Option<String> {
    let Some(value) = value.filter(|s| !s.is_empty()) else {
        return Some(DEFAULT_FISH_TTS_REFERENCE_ID.to_owned());
    };
    let id = js_compat::trim(value);
    if let Some((_, reference)) = FISH_VOICES.iter().find(|(alias, _)| *alias == id) {
        return Some((*reference).to_owned());
    }
    valid_id(id).then(|| id.to_ascii_lowercase())
}

/// UTF-8 convenience adapter. Use `parse_voice_search_json` for escaped lone
/// surrogates, which serde_json::Value's String cannot represent.
pub fn parse_voice_search(
    query: &HashMap<String, serde_json::Value>,
) -> Result<FishVoiceSearch, FishCatalogError> {
    let json =
        serde_json::to_string(query).map_err(|error| FishCatalogError::Json(error.to_string()))?;
    parse_voice_search_json(&json)
}

pub fn parse_voice_search_json(query: &str) -> Result<FishVoiceSearch, FishCatalogError> {
    parse_voice_search_value(&parse_json(query).map_err(FishCatalogError::Json)?)
}

/// Implements the source's validation order, including String(value) failures
/// before its final string-only check for the filter and page fields.
pub fn parse_voice_search_value(query: &JsonValue) -> Result<FishVoiceSearch, FishCatalogError> {
    if matches!(query, JsonValue::Null) {
        return Err(FishCatalogError::Coercion(
            "Cannot read properties of null (reading 'name')".into(),
        ));
    }
    let empty = JsonValue::String(JsString::from(""));
    let all = JsonValue::String(JsString::from("all"));
    let one = JsonValue::String(JsString::from("1"));
    let name = query.get("name").unwrap_or(&empty);
    let gender = query.get("gender").unwrap_or(&all);
    let language = query.get("language").unwrap_or(&all);
    let license = query.get("license").unwrap_or(&all);
    let page = query.get("page").unwrap_or(&one);
    let Some(name) = string(Some(name)).filter(|name| name.len() <= 100) else {
        return Err(invalid_filters());
    };
    let gender_text = js_string(gender)?;
    if !["all", "female", "male"]
        .iter()
        .any(|s| gender_text.as_str() == Some(*s))
    {
        return Err(invalid_filters());
    }
    let language_text = js_string(language)?;
    if !["all", "en", "es"]
        .iter()
        .any(|s| language_text.as_str() == Some(*s))
    {
        return Err(invalid_filters());
    }
    let license_text = js_string(license)?;
    if !["all", "licensed", "unlicensed"]
        .iter()
        .any(|s| license_text.as_str() == Some(*s))
    {
        return Err(invalid_filters());
    }
    let page_text = js_string(page)?;
    let Some(page_text) = page_text
        .as_str()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    else {
        return Err(invalid_filters());
    };
    let page_number = string_number(page_text);
    if !(1.0..=50.0).contains(&page_number)
        || [gender, language, license, page]
            .iter()
            .any(|value| !matches!(value, JsonValue::String(_)))
    {
        return Err(invalid_filters());
    }
    Ok(FishVoiceSearch {
        name: name.trim(),
        gender: gender_text.as_str().expect("validated gender").to_owned(),
        language: language_text
            .as_str()
            .expect("validated language")
            .to_owned(),
        license: license_text.as_str().expect("validated license").to_owned(),
        page: page_number as u8,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct FishVoice {
    pub id: String,
    pub name: JsString,
    pub languages: Vec<JsString>,
    pub gender: Option<String>,
    pub licensed: Option<bool>,
    pub description: JsString,
    pub tags: Vec<String>,
    pub cover_url: Option<String>,
    pub sample: Option<FishSample>,
    pub uses: Option<f64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FishSample {
    pub url: String,
    pub text: JsString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FishSearchResult {
    pub items: Vec<FishVoice>,
    pub page: u8,
    /// The source's &&/?? expression can return any non-null JSON value.
    pub has_more: JsonValue,
}
impl FishSearchResult {
    pub fn to_json_string(&self) -> String {
        format!(
            "{{\"items\":[{}],\"page\":{},\"hasMore\":{}}}",
            self.items
                .iter()
                .map(FishVoice::to_json_string)
                .collect::<Vec<_>>()
                .join(","),
            self.page,
            self.has_more.to_json_string()
        )
    }
}

fn string(value: Option<&JsonValue>) -> Option<&JsString> {
    match value {
        Some(JsonValue::String(value)) => Some(value),
        _ => None,
    }
}
fn text(value: Option<&JsonValue>) -> Option<&str> {
    string(value).and_then(JsString::as_str)
}
fn array(value: Option<&JsonValue>) -> &[JsonValue] {
    match value {
        Some(JsonValue::Array(values)) => values,
        _ => &[],
    }
}

/// String(value) for JSON-parsed values. A JSON object's own non-callable
/// toString shadows Object.prototype.toString and cannot produce a primitive.
fn js_string(value: &JsonValue) -> Result<JsString, FishCatalogError> {
    match value {
        JsonValue::Null => Ok(JsString::from("null")),
        JsonValue::Bool(value) => Ok(JsString::from(if *value { "true" } else { "false" })),
        JsonValue::Number(value) => Ok(JsString::from(number_string(*value))),
        JsonValue::String(value) => Ok(value.clone()),
        JsonValue::Object(_) if value.get("toString").is_some() => Err(primitive_error()),
        JsonValue::Object(_) => Ok(JsString::from("[object Object]")),
        JsonValue::Array(values) => {
            let mut units = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(value, JsonValue::Null) {
                    units.extend(js_string(value)?.code_units());
                }
            }
            Ok(JsString::from_units(units))
        }
    }
}
fn js_number(value: &JsonValue) -> Result<f64, FishCatalogError> {
    match value {
        JsonValue::Null => Ok(0.0),
        JsonValue::Bool(value) => Ok(f64::from(u8::from(*value))),
        JsonValue::Number(value) => Ok(*value),
        other => Ok(js_string(other)?.as_str().map_or(f64::NAN, string_number)),
    }
}

fn cover_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i-u)^coverimage/[a-f0-9]{32}$").expect("constant cover pattern")
    })
}
fn sample_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)^https://platform\.r2\.fish\.audio/tasks?/(?:[0-9]{4}-[0-9]{2}-[0-9]{2}/)?[a-f0-9]{32}\.(?:mp3|wav|opus)$").expect("constant sample pattern"))
}
fn style_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z-]{1,23}$").expect("constant style pattern"))
}

pub fn normalize_fish_voice_json(raw: &str) -> Result<Option<FishVoice>, FishCatalogError> {
    normalize_fish_voice(&parse_json(raw).map_err(FishCatalogError::Json)?)
}

/// Prepared-value entrypoint for callers that already parsed upstream JSON.
pub fn normalize_fish_voice(value: &JsonValue) -> Result<Option<FishVoice>, FishCatalogError> {
    let Some(id) = text(value.get("_id")).filter(|id| valid_id(id)) else {
        return Ok(None);
    };
    let Some(title) = string(value.get("title")) else {
        return Ok(None);
    };
    if text(value.get("type")) != Some("tts")
        || text(value.get("visibility")) != Some("public")
        || matches!(value.get("dmca_taken_down"), Some(JsonValue::Bool(true)))
        || text(value.get("state")) == Some("failed")
        || text(value.get("pvc_release_state")) == Some("retired")
    {
        return Ok(None);
    }
    // Mapping is eager in the source: a later throwing tag still fails even if
    // six earlier style tags would fill the visible output.
    let all_tags = array(value.get("tags"))
        .iter()
        .map(|tag| js_string(tag).map(|tag| tag.to_utf8_lossy().to_lowercase()))
        .collect::<Result<Vec<_>, _>>()?;
    let gender = if all_tags.iter().any(|tag| tag == "female") {
        Some("female".into())
    } else if all_tags.iter().any(|tag| tag == "male") {
        Some("male".into())
    } else {
        None
    };
    let mut tags = Vec::new();
    let mut seen = HashSet::new();
    for tag in all_tags {
        if style_pattern().is_match(&tag)
            && !["female", "male", "english", "spanish"].contains(&tag.as_str())
            && seen.insert(tag.clone())
        {
            tags.push(tag);
            if tags.len() == 6 {
                break;
            }
        }
    }
    let sample = array(value.get("samples")).iter().find_map(|sample| {
        let url = text(sample.get("audio"))?;
        if !sample_pattern().is_match(url) {
            return None;
        }
        Some(FishSample {
            url: url.to_owned(),
            text: string(sample.get("text"))
                .map(|text| text.trim().slice(0, 400))
                .unwrap_or_else(|| JsString::from("")),
        })
    });
    Ok(Some(FishVoice {
        id: id.to_owned(),
        name: title.slice(0, 200),
        languages: array(value.get("languages"))
            .iter()
            .filter_map(|value| string(Some(value)).cloned())
            .collect(),
        gender,
        licensed: match value.get("licensed") {
            Some(JsonValue::Bool(value)) => Some(*value),
            _ => None,
        },
        description: string(value.get("description"))
            .map(|text| text.trim().slice(0, 300))
            .unwrap_or_else(|| JsString::from("")),
        tags,
        cover_url: text(value.get("cover_image"))
            .filter(|path| cover_pattern().is_match(path))
            .map(|path| {
                format!("https://public-platform.r2.fish.audio/cdn-cgi/image/width=128/{path}")
            }),
        sample,
        uses: match value.get("task_count") {
            Some(JsonValue::Number(value)) if value.is_finite() && *value >= 0.0 => {
                Some(value.floor())
            }
            _ => None,
        },
    }))
}

#[derive(Clone)]
pub struct FishCatalogConfig {
    pub endpoint: String,
    pub key: Option<String>,
    pub timeout: Duration,
    pub cache_ttl: Duration,
    /// Zero explicitly disables caching for disposable tests.
    pub cache_capacity: usize,
    pub max_response_bytes: usize,
}
impl FishCatalogConfig {
    pub fn new(key: Option<String>) -> Self {
        Self {
            endpoint: "https://api.fish.audio/model".into(),
            key,
            timeout: FISH_CATALOG_TIMEOUT,
            cache_ttl: FISH_CATALOG_CACHE_TTL,
            cache_capacity: FISH_CATALOG_CACHE_CAPACITY,
            max_response_bytes: 8 * 1024 * 1024,
        }
    }
}
impl fmt::Debug for FishCatalogConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FishCatalogConfig")
            .field("endpoint", &"[REDACTED]")
            .field("key", &self.key.as_ref().map(|_| "[REDACTED]"))
            .field("timeout", &self.timeout)
            .field("cache_ttl", &self.cache_ttl)
            .field("cache_capacity", &self.cache_capacity)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

struct CacheEntry {
    until: Duration,
    value: Arc<JsonValue>,
}
#[derive(Default)]
struct CatalogCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
}
/// Duration since the clock's epoch. The default clock is Date.now's system
/// epoch; an injected clock makes expiry boundaries deterministic in fixtures.
pub type FishCatalogClock = Arc<dyn Fn() -> Duration + Send + Sync>;

#[derive(Clone)]
pub struct FishCatalog {
    client: reqwest::Client,
    pub config: FishCatalogConfig,
    clock: FishCatalogClock,
    cache: Arc<Mutex<CatalogCache>>,
}
impl FishCatalog {
    pub fn new(config: FishCatalogConfig) -> Self {
        Self::with_client(config, http_support::new_client())
    }
    /// An injected client retains its redirect, proxy, TLS and pooling policy.
    pub fn with_client(config: FishCatalogConfig, client: reqwest::Client) -> Self {
        Self::with_clock(
            config,
            client,
            Arc::new(|| {
                Duration::from_millis(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64,
                )
            }),
        )
    }
    pub fn with_clock(
        config: FishCatalogConfig,
        client: reqwest::Client,
        clock: FishCatalogClock,
    ) -> Self {
        Self {
            client,
            config,
            clock,
            cache: Arc::new(Mutex::new(CatalogCache::default())),
        }
    }
    async fn get(&self, endpoint: &str) -> Result<Arc<JsonValue>, FishCatalogError> {
        {
            let cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(entry) = cache
                .entries
                .get(endpoint)
                .filter(|entry| entry.until > (self.clock)())
            {
                return Ok(Arc::clone(&entry.value));
            }
        }
        let key = self
            .config
            .key
            .as_deref()
            .map(js_compat::trim)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| {
                request_error(503, "catalog_unavailable", "Voice catalog is unavailable")
            })?;
        let unavailable = || {
            request_error(
                503,
                "catalog_unavailable",
                "Voice catalog is temporarily unavailable",
            )
        };
        let deadline = tokio::time::Instant::now() + self.config.timeout;
        let mut response = tokio::time::timeout_at(
            deadline,
            self.client
                .get(format!("{}{endpoint}", self.config.endpoint))
                .bearer_auth(key)
                .send(),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            let is_404 = response.status().as_u16() == 404;
            return Err(request_error(
                if is_404 { 404 } else { 503 },
                if is_404 {
                    "voice_unavailable"
                } else {
                    "catalog_unavailable"
                },
                "Voice catalog request failed",
            ));
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::time::timeout_at(deadline, response.chunk())
                .await
                .map_err(|_| FishCatalogError::Body("Catalog response body timed out".into()))?
                .map_err(|error| FishCatalogError::Body(http_support::transport_error(error)))?;
            let Some(chunk) = chunk else {
                break;
            };
            if chunk.len() > self.config.max_response_bytes.saturating_sub(bytes.len()) {
                return Err(FishCatalogError::Limit(
                    "Catalog response exceeds byte limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let decoded = String::from_utf8_lossy(&bytes);
        let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
        let value = Arc::new(parse_json(decoded).map_err(FishCatalogError::Json)?);
        if self.config.cache_capacity > 0 {
            let until = (self.clock)().saturating_add(self.config.cache_ttl);
            let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
            // Match Map.delete(firstKey) before Map.set, even for a refresh of
            // an existing expired entry at capacity. Hits never promote keys.
            if cache.entries.len() >= self.config.cache_capacity
                && let Some(oldest) = cache.order.pop_front()
            {
                cache.entries.remove(&oldest);
            }
            if !cache.entries.contains_key(endpoint) {
                cache.order.push_back(endpoint.to_owned());
            }
            cache.entries.insert(
                endpoint.to_owned(),
                CacheEntry {
                    until,
                    value: Arc::clone(&value),
                },
            );
        }
        Ok(value)
    }

    pub async fn get_fish_voice(&self, id: &str) -> Result<FishVoice, FishCatalogError> {
        if !valid_id(id) {
            return Err(request_error(400, "invalid_voice", "Invalid voice ID"));
        }
        let value = self.get(&format!("/{id}")).await?;
        normalize_fish_voice(&value)?.ok_or_else(|| {
            request_error(
                404,
                "voice_unavailable",
                "This voice is no longer available",
            )
        })
    }

    pub async fn search_fish_voices(
        &self,
        search: &FishVoiceSearch,
    ) -> Result<FishSearchResult, FishCatalogError> {
        let value = self.get(&search_endpoint(search)).await?;
        normalize_fish_search(&value, search)
    }
}

/// The source uses URLSearchParams: UTF-16 input becomes a USVString (unpaired
/// units become U+FFFD), spaces become +, and punctuation follows form encoding.
pub fn search_endpoint(search: &FishVoiceSearch) -> String {
    let mut params = reqwest::Url::parse("https://catalog.invalid/").expect("constant URL");
    {
        let mut query = params.query_pairs_mut();
        query
            .append_pair("page_size", "20")
            .append_pair("page_number", &search.page.to_string())
            .append_pair("sort_by", "score");
        if !search.name.is_empty() {
            query.append_pair("title", &search.name.to_utf8_lossy());
        }
        if search.gender != "all" {
            query.append_pair("tag", &search.gender);
        }
        if search.language != "all" {
            query.append_pair("language", &search.language);
        }
        if search.license == "licensed" {
            query.append_pair("licensed", "true");
        }
    }
    format!("?{}", params.query().unwrap_or(""))
}

/// Normalize then apply the source's local license/gender/language filters.
/// Keep the nullish pagination expression lossless for invalid upstream types.
pub fn normalize_fish_search(
    value: &JsonValue,
    search: &FishVoiceSearch,
) -> Result<FishSearchResult, FishCatalogError> {
    let Some(JsonValue::Array(raw_items)) = value.get("items") else {
        return Err(request_error(
            503,
            "catalog_unavailable",
            "Invalid catalog response",
        ));
    };
    let mut items = Vec::new();
    for raw in raw_items {
        if let Some(voice) = normalize_fish_voice(raw)?
            && (search.license == "all" || voice.licensed == Some(search.license == "licensed"))
            && (search.gender == "all" || voice.gender.as_deref() == Some(search.gender.as_str()))
            && (search.language == "all"
                || voice
                    .languages
                    .iter()
                    .any(|language| language.as_str() == Some(search.language.as_str())))
        {
            items.push(voice);
        }
    }
    let has_more = if search.page >= 50 {
        JsonValue::Bool(false)
    } else if let Some(value) = value
        .get("has_more")
        .filter(|value| !matches!(value, JsonValue::Null))
    {
        value.clone()
    } else {
        JsonValue::Bool(
            match value
                .get("total")
                .filter(|value| !matches!(value, JsonValue::Null))
            {
                Some(total) => f64::from(search.page) * 20.0 < js_number(total)?,
                None => false,
            },
        )
    };
    Ok(FishSearchResult {
        items,
        page: search.page,
        has_more,
    })
}

fn quote(value: &str) -> String {
    JsString::from(value).to_json_string()
}
impl FishVoice {
    /// No generic Serialize implementation may replace lone UTF-16 code units.
    pub fn to_json_string(&self) -> String {
        let languages = self
            .languages
            .iter()
            .map(JsString::to_json_string)
            .collect::<Vec<_>>()
            .join(",");
        let tags = self
            .tags
            .iter()
            .map(|tag| quote(tag))
            .collect::<Vec<_>>()
            .join(",");
        let gender = self
            .gender
            .as_deref()
            .map(quote)
            .unwrap_or_else(|| "null".into());
        let licensed = self
            .licensed
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".into());
        let cover = self
            .cover_url
            .as_deref()
            .map(quote)
            .unwrap_or_else(|| "null".into());
        let sample = self
            .sample
            .as_ref()
            .map(|sample| {
                format!(
                    "{{\"url\":{},\"text\":{}}}",
                    quote(&sample.url),
                    sample.text.to_json_string()
                )
            })
            .unwrap_or_else(|| "null".into());
        let uses = self
            .uses
            .map(number_string)
            .unwrap_or_else(|| "null".into());
        format!(
            "{{\"id\":{},\"name\":{},\"languages\":[{}],\"gender\":{},\"licensed\":{},\"description\":{},\"tags\":[{}],\"coverUrl\":{},\"sample\":{},\"uses\":{}}}",
            quote(&self.id),
            self.name.to_json_string(),
            languages,
            gender,
            licensed,
            self.description.to_json_string(),
            tags,
            cover,
            sample,
            uses
        )
    }
}
