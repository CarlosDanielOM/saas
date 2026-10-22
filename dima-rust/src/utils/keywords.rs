//! Keyword validation, Unicode matching, and cache coordination, consolidated
//! from `keywords.ts` and `keyword_cache.ts`. No connections are opened here.
//!
//! [`KeywordStorage`] is the integration boundary for MongoDB, Redis and Pub/Sub;
//! its atomic operations are deliberately explicit. [`SharedKeywordLoader`]
//! connects it to the local cache. Applications subscribe to [`KEYWORD_TOPIC`]
//! and pass decoded events to [`apply_keyword_change`]; connection/subscription
//! ownership belongs to the application, not this library.
//!
//! Length means original UTF-16 code units, as in JS. NFC precedes lowercase;
//! whitespace is the ECMAScript set (including BOM, excluding NEL). Word
//! boundaries use L/N/M/underscore, not Rust `\\w` (which also includes joiners).
//! Unicode tables are those supplied by Rust/regex/unicode-normalization; new
//! codepoints may differ from a Node build using a different Unicode release.
//! Strings must be valid Unicode; isolated JS UTF-16 surrogates are not modeled.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::js_compat::{is_whitespace as js_whitespace, trim as js_trim};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use unicode_normalization::UnicodeNormalization;

pub const KEYWORD_TOPIC: &str = "keywords:changed";
pub const SHARED_INDEX_TTL_SECONDS: u64 = 86_400;
pub const BODY_TTL_SECONDS: u64 = 30;
pub const MAX_REVISION_ATTEMPTS: usize = 5;
pub const SET_IF_REVISION_SCRIPT: &str = "if (redis.call('get', KEYS[2]) or '0') == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 end; return 0";

pub fn normalize_keyword(text: &str) -> String {
    let lower = text.nfc().collect::<String>().to_lowercase();
    let mut result = String::with_capacity(lower.len());
    let mut space = false;
    for ch in js_trim(&lower).chars() {
        if js_whitespace(ch) {
            space = true;
        } else {
            if space {
                result.push(' ');
                space = false;
            }
            result.push(ch);
        }
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeywordMatchMode {
    Start,
    Anywhere,
    Exact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeywordEntry {
    pub id: String,
    /// Normalized when projected from MongoDB; index compilation itself does
    /// not normalize entries, matching the TypeScript helper.
    pub text: String,
    #[serde(rename = "matchMode")]
    pub match_mode: KeywordMatchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeywordValidationError {
    Text,
    MatchMode,
}
impl fmt::Display for KeywordValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Text => {
                "Keyword must contain words or a phrase, without !, and be at most 60 characters"
            }
            Self::MatchMode => "Keyword match mode must be start, anywhere, or exact",
        })
    }
}
impl std::error::Error for KeywordValidationError {}

fn valid_keyword_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\A[\p{L}\p{N}\p{M}_]+(?: [\p{L}\p{N}\p{M}_]+)*\z")
            .expect("constant keyword regex")
    })
}
fn words_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"[\p{L}\p{N}\p{M}_]+").expect("constant keyword words regex"))
}
fn word_char(ch: char) -> bool {
    let mut bytes = [0; 4];
    words_regex().is_match(ch.encode_utf8(&mut bytes))
}

fn validate_text(text: &Value) -> Result<(), KeywordValidationError> {
    let text = text.as_str().ok_or(KeywordValidationError::Text)?;
    if text.encode_utf16().count() > 60 || !valid_keyword_regex().is_match(&normalize_keyword(text))
    {
        return Err(KeywordValidationError::Text);
    }
    Ok(())
}

fn mode_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    mode_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

/// Exact unknown-input validation from TypeScript, including its `String(mode)`
/// check followed by returning the original value. For example `{matchMode:
/// ["start"]}` is accepted and returned unchanged; it is not a typed Start mode.
/// Use this at a JSON compatibility boundary; [`validate_keyword`] requires a
/// valid literal mode for new typed consumers.
pub fn validate_keyword_settings(
    text: &Value,
    settings: &Value,
) -> Result<Value, KeywordValidationError> {
    validate_text(text)?;
    let mode = settings
        .get("matchMode")
        .ok_or(KeywordValidationError::MatchMode)?;
    if !["start", "anywhere", "exact"].contains(&mode_string(mode).as_str()) {
        return Err(KeywordValidationError::MatchMode);
    }
    Ok(serde_json::json!({"matchMode": mode}))
}

/// Validate and extract a literal mode for a typed [`KeywordEntry`]. Arrays or
/// objects accepted by JS's coercing validation remain outside this typed API;
/// [`validate_keyword_settings`] preserves that boundary behavior explicitly.
pub fn validate_keyword(
    text: &Value,
    settings: &Value,
) -> Result<KeywordMatchMode, KeywordValidationError> {
    let settings = validate_keyword_settings(text, settings)?;
    match settings.get("matchMode").and_then(Value::as_str) {
        Some("start") => Ok(KeywordMatchMode::Start),
        Some("anywhere") => Ok(KeywordMatchMode::Anywhere),
        Some("exact") => Ok(KeywordMatchMode::Exact),
        _ => Err(KeywordValidationError::MatchMode),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeywordIndex {
    buckets: HashMap<String, Vec<KeywordEntry>>,
}
impl KeywordIndex {
    pub fn bucket(&self, first_word: &str) -> &[KeywordEntry] {
        self.buckets
            .get(first_word)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }
    pub fn word_count(&self) -> usize {
        self.buckets.len()
    }
}

pub fn compile_keyword_index(entries: impl IntoIterator<Item = KeywordEntry>) -> KeywordIndex {
    let mut index = KeywordIndex::default();
    for entry in entries {
        let first = entry.text.split(' ').next().unwrap_or("").to_owned();
        index.buckets.entry(first).or_default().push(entry);
    }
    index
}

fn matches_normalized(message: &str, entry: &KeywordEntry) -> bool {
    if entry.match_mode == KeywordMatchMode::Exact {
        return message == entry.text;
    }
    // Check every Unicode boundary, including overlapping phrase occurrences.
    // `match_indices` would skip the second 'a a' in 'xa a a'.
    let test_at = |offset: usize| {
        let tail = &message[offset..];
        tail.starts_with(&entry.text)
            && !tail[entry.text.len()..]
                .chars()
                .next()
                .is_some_and(word_char)
            && (offset == 0 || !message[..offset].chars().next_back().is_some_and(word_char))
    };
    if entry.match_mode == KeywordMatchMode::Start {
        return test_at(0);
    }
    message.char_indices().any(|(offset, _)| test_at(offset)) || test_at(message.len())
}

pub fn keyword_matches(message: &str, entry: &KeywordEntry) -> bool {
    matches_normalized(&normalize_keyword(message), entry)
}

/// Match order follows first occurrence of each word in the message, then
/// insertion order within its bucket. Duplicate IDs replace their value without
/// moving their first output position, matching JS Set/Map iteration semantics.
pub fn match_keywords(index: &KeywordIndex, message: &str) -> Vec<KeywordEntry> {
    let text = normalize_keyword(message);
    let mut seen = HashSet::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut result = Vec::new();
    for word in words_regex().find_iter(&text).map(|word| word.as_str()) {
        if !seen.insert(word) {
            continue;
        }
        for entry in index.bucket(word) {
            if matches_normalized(&text, entry) {
                if let Some(&position) = positions.get(&entry.id) {
                    result[position] = entry.clone();
                } else {
                    positions.insert(entry.id.clone(), result.len());
                    result.push(entry.clone());
                }
            }
        }
    }
    result
}

pub trait KeywordLoader: Send + Sync {
    type Error: Send + Sync;
    fn load<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Vec<KeywordEntry>, Self::Error>> + Send + 'a;
}

type LoadResult<E> = Result<Arc<KeywordIndex>, Arc<E>>;
struct Cached {
    index: Arc<KeywordIndex>,
    expires: Instant,
}
struct Pending<E> {
    id: u64,
    sender: watch::Sender<Option<LoadResult<E>>>,
}
struct CacheState<E> {
    entries: HashMap<String, Cached>,
    order: VecDeque<String>,
    pending: HashMap<String, Pending<E>>,
    next_id: u64,
}
impl<E> Default for CacheState<E> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            pending: HashMap::new(),
            next_id: 0,
        }
    }
}

/// Cold loads coalesce, including empty results and errors. Invalidation
/// detaches in-flight loads; successful stale loads retry without repopulating
/// old data, while failures still reject every original coalesced caller.
/// The cache owns no background tasks. Dropping a load future wakes its waiters
/// so another get can retry instead of waiting indefinitely. Capacity bounds
/// completed entries; simultaneous cold loads are bounded by the caller.
/// TTL uses monotonic Instant rather than Date.now, so wall-clock adjustments
/// do not expire or extend local entries.
pub struct KeywordIndexCache<L: KeywordLoader> {
    loader: L,
    ttl: Duration,
    capacity: usize,
    state: Arc<Mutex<CacheState<L::Error>>>,
}

struct PendingGuard<E> {
    state: Arc<Mutex<CacheState<E>>>,
    channel: String,
    id: u64,
}
impl<E> Drop for PendingGuard<E> {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .pending
            .get(&self.channel)
            .is_some_and(|p| p.id == self.id)
        {
            state.pending.remove(&self.channel);
        }
    }
}

enum CacheAction<E> {
    Wait(watch::Receiver<Option<LoadResult<E>>>),
    Load(u64, watch::Sender<Option<LoadResult<E>>>),
}

fn publish_load_result<E>(
    relays: &[watch::Sender<Option<LoadResult<E>>>],
    result: LoadResult<E>,
) -> LoadResult<E> {
    for sender in relays {
        sender.send_replace(Some(result.clone()));
    }
    result
}
impl<L: KeywordLoader> KeywordIndexCache<L> {
    pub fn new(loader: L) -> Self {
        Self::with_limits(loader, Duration::from_secs(30), 2000)
    }
    pub fn with_limits(loader: L, ttl: Duration, capacity: usize) -> Self {
        Self {
            loader,
            ttl,
            capacity,
            state: Arc::new(Mutex::new(CacheState::default())),
        }
    }
    pub fn invalidate(&self, channel_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.entries.remove(channel_id);
        state.order.retain(|id| id != channel_id);
        state.pending.remove(channel_id);
    }
    pub async fn get(&self, channel_id: &str) -> LoadResult<L::Error> {
        // Keep each original load's subscribers attached until its final result,
        // including a successor result after successful invalidation. This is
        // the shared Promise behavior of the TypeScript cache.
        let mut relays = Vec::new();
        loop {
            let action = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(cached) = state
                    .entries
                    .get(channel_id)
                    .filter(|cached| cached.expires > Instant::now())
                {
                    return publish_load_result(&relays, Ok(Arc::clone(&cached.index)));
                }
                if let Some(pending) = state.pending.get(channel_id) {
                    CacheAction::Wait(pending.sender.subscribe())
                } else {
                    state.next_id = state.next_id.wrapping_add(1);
                    let id = state.next_id;
                    let (sender, _) = watch::channel(None);
                    state.pending.insert(
                        channel_id.into(),
                        Pending {
                            id,
                            sender: sender.clone(),
                        },
                    );
                    CacheAction::Load(id, sender)
                }
            };
            match action {
                CacheAction::Wait(mut receiver) => loop {
                    if let Some(result) = receiver.borrow().clone() {
                        return publish_load_result(&relays, result);
                    }
                    if receiver.changed().await.is_err() {
                        break;
                    }
                },
                CacheAction::Load(id, sender) => {
                    let guard = PendingGuard {
                        state: Arc::clone(&self.state),
                        channel: channel_id.into(),
                        id,
                    };
                    let result = self
                        .loader
                        .load(channel_id)
                        .await
                        .map(|entries| Arc::new(compile_keyword_index(entries)))
                        .map_err(Arc::new);
                    let accepted = {
                        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if state.pending.get(channel_id).is_some_and(|p| p.id == id) {
                            state
                                .pending
                                .remove(channel_id)
                                .expect("pending identity checked under lock");
                            if let Ok(index) = &result {
                                state.order.retain(|channel| channel != channel_id);
                                state.order.push_back(channel_id.into());
                                state.entries.insert(
                                    channel_id.into(),
                                    Cached {
                                        index: Arc::clone(index),
                                        expires: Instant::now() + self.ttl,
                                    },
                                );
                                if state.entries.len() > self.capacity {
                                    let oldest = state
                                        .order
                                        .pop_front()
                                        .expect("nonempty entries have an insertion order");
                                    state.entries.remove(&oldest);
                                }
                            }
                            true
                        } else {
                            false
                        }
                    };
                    drop(guard);
                    relays.push(sender);
                    if accepted || result.is_err() {
                        return publish_load_result(&relays, result);
                    }
                }
            }
        }
    }
}

pub fn keyword_index_key(channel_id: &str) -> String {
    format!("keywords:index:{channel_id}")
}
pub fn keyword_revision_key(channel_id: &str) -> String {
    format!("keywords:revision:{channel_id}")
}
pub fn keyword_body_key(channel_id: &str, id: &str) -> String {
    format!("keywords:body:{channel_id}:{id}")
}

#[derive(Debug, Clone)]
pub struct KeywordRow {
    /// String(row._id), not the complete command body.
    pub id: String,
    pub cmd: String,
    pub match_mode: Option<KeywordMatchMode>,
}

/// Storage contract for the original Mongo commands schema and Redis keys.
/// Implementations must not split atomic operations into independent commands.
/// Every future must report errors instead of silently accepting partial writes.
pub trait KeywordStorage: Send + Sync {
    type Error: Send + Sync;
    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send + 'a;
    /// `Commands.find({channelID, activation:'keyword', enabled:true})`
    /// projected to `_id cmd keywordSettings`. Preserve database row order.
    fn query_index<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Vec<KeywordRow>, Self::Error>> + Send + 'a;
    /// `Commands.findOne({channelID, _id:ObjectId(id), activation:'keyword'})`.
    /// Do not add an enabled filter; caller already resolves the shared index.
    /// Return the complete JSON-compatible command body, or None if absent.
    fn query_body<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
    ) -> impl Future<Output = Result<Option<Value>, Self::Error>> + Send + 'a;
    /// Atomic [`SET_IF_REVISION_SCRIPT`], with missing revision treated as '0'.
    /// Return true only if publication succeeded at the expected revision.
    fn set_if_revision<'a>(
        &'a self,
        data_key: &'a str,
        revision_key: &'a str,
        revision: &'a str,
        json: &'a str,
        ttl_seconds: u64,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;
    /// One MULTI/EXEC: INCR revision_key, DEL index_key, optional DEL body_key.
    fn invalidate_shared<'a>(
        &'a self,
        revision_key: &'a str,
        index_key: &'a str,
        body_key: Option<&'a str>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
    fn publish<'a>(
        &'a self,
        topic: &'a str,
        json: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
    /// `Commands.updateOne({channelID,_id:ObjectId(id),activation:'keyword'},
    /// {$set:{count}})`. This must not change the settings revision.
    fn update_keyword_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
    fn delete<'a>(
        &'a self,
        key: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

#[derive(Debug)]
pub enum KeywordStorageError<E> {
    Storage(E),
    Json(serde_json::Error),
    RepeatedIndexChange,
    RepeatedBodyChange,
}
impl<E: fmt::Display> fmt::Display for KeywordStorageError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
            Self::RepeatedIndexChange => {
                f.write_str("Keyword settings changed repeatedly while loading")
            }
            Self::RepeatedBodyChange => f.write_str("Keyword changed repeatedly while loading"),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for KeywordStorageError<E> {}

pub async fn load_shared_index<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
) -> Result<Vec<KeywordEntry>, KeywordStorageError<S::Error>> {
    let key = keyword_index_key(channel_id);
    let rev_key = keyword_revision_key(channel_id);
    for _ in 0..MAX_REVISION_ATTEMPTS {
        if let Some(json) = store
            .get(&key)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            // Invalid cached shapes return a decoding error. TypeScript's cast
            // delays shape errors until use; neither implementation rewrites it.
            return serde_json::from_str(&json).map_err(KeywordStorageError::Json);
        }
        let revision = store
            .get(&rev_key)
            .await
            .map_err(KeywordStorageError::Storage)?
            .unwrap_or_else(|| "0".into());
        let rows = store
            .query_index(channel_id)
            .await
            .map_err(KeywordStorageError::Storage)?;
        let entries: Vec<_> = rows
            .into_iter()
            .map(|row| KeywordEntry {
                id: row.id,
                text: normalize_keyword(&row.cmd),
                match_mode: row.match_mode.unwrap_or(KeywordMatchMode::Start),
            })
            .collect();
        let json = serde_json::to_string(&entries).map_err(KeywordStorageError::Json)?;
        if store
            .set_if_revision(&key, &rev_key, &revision, &json, SHARED_INDEX_TTL_SECONDS)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            return Ok(entries);
        }
    }
    Err(KeywordStorageError::RepeatedIndexChange)
}

pub struct SharedKeywordLoader<S> {
    pub storage: Arc<S>,
}
impl<S: KeywordStorage> KeywordLoader for SharedKeywordLoader<S> {
    type Error = KeywordStorageError<S::Error>;
    async fn load(&self, channel_id: &str) -> Result<Vec<KeywordEntry>, Self::Error> {
        load_shared_index(self.storage.as_ref(), channel_id).await
    }
}

/// Apply a decoded Pub/Sub `keywords:changed` event without allocating a cold
/// channel entry. Returns whether a supported nonempty channel ID was handled.
pub fn apply_keyword_change<L: KeywordLoader>(cache: &KeywordIndexCache<L>, event: &Value) -> bool {
    if let Some(channel) = event
        .get("channelID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        cache.invalidate(channel);
        true
    } else {
        false
    }
}

/// Run after a successful keyword settings/add/delete write. Failure to publish
/// leaves the local cache invalidated and does not attempt the warm load, as in
/// the source. Other processes own their subscription lifecycles.
pub async fn refresh_keyword_index<S: KeywordStorage>(
    cache: &KeywordIndexCache<SharedKeywordLoader<S>>,
    channel_id: &str,
    id: Option<&str>,
) -> Result<(), Arc<KeywordStorageError<S::Error>>> {
    let store = cache.loader.storage.as_ref();
    let rev = keyword_revision_key(channel_id);
    let index = keyword_index_key(channel_id);
    let body = id
        .filter(|id| !id.is_empty())
        .map(|id| keyword_body_key(channel_id, id));
    store
        .invalidate_shared(&rev, &index, body.as_deref())
        .await
        .map_err(|e| Arc::new(KeywordStorageError::Storage(e)))?;
    cache.invalidate(channel_id);
    let event = serde_json::json!({"channelID": channel_id}).to_string();
    store
        .publish(KEYWORD_TOPIC, &event)
        .await
        .map_err(|e| Arc::new(KeywordStorageError::Storage(e)))?;
    cache.get(channel_id).await?;
    Ok(())
}

/// Missing bodies are not negatively cached; this preserves the source's early
/// return even if the missing-row query raced an edit. Cached JSON null is also
/// represented as None, matching `ICommands | null`.
pub async fn get_keyword_body<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
    id: &str,
) -> Result<Option<Value>, KeywordStorageError<S::Error>> {
    let key = keyword_body_key(channel_id, id);
    let rev_key = keyword_revision_key(channel_id);
    for _ in 0..MAX_REVISION_ATTEMPTS {
        if let Some(json) = store
            .get(&key)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            let value: Value = serde_json::from_str(&json).map_err(KeywordStorageError::Json)?;
            return Ok(if value.is_null() { None } else { Some(value) });
        }
        let revision = store
            .get(&rev_key)
            .await
            .map_err(KeywordStorageError::Storage)?
            .unwrap_or_else(|| "0".into());
        let Some(row) = store
            .query_body(channel_id, id)
            .await
            .map_err(KeywordStorageError::Storage)?
        else {
            return Ok(None);
        };
        let json = serde_json::to_string(&row).map_err(KeywordStorageError::Json)?;
        if store
            .set_if_revision(&key, &rev_key, &revision, &json, BODY_TTL_SECONDS)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            return Ok(Some(row));
        }
    }
    Err(KeywordStorageError::RepeatedBodyChange)
}

/// Counters invalidate only the body. They deliberately do not increment the
/// shared settings revision or invalidate/publish the match index. This retains
/// the TypeScript counter/cache race boundary; it adds no stronger consistency.
pub async fn save_keyword_count<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
    id: &str,
    count: f64,
) -> Result<(), S::Error> {
    store.update_keyword_count(channel_id, id, count).await?;
    store.delete(&keyword_body_key(channel_id, id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::Semaphore;

    fn entry(text: &str, mode: KeywordMatchMode, id: &str) -> KeywordEntry {
        KeywordEntry {
            id: id.into(),
            text: text.into(),
            match_mode: mode,
        }
    }
    fn ids(entries: Vec<KeywordEntry>) -> Vec<String> {
        entries.into_iter().map(|e| e.id).collect()
    }

    #[test]
    fn source_matching_and_unicode_fixtures() {
        use KeywordMatchMode::*;
        let index = compile_keyword_index([
            entry("f", Anywhere, "f"),
            entry("hormiga", Anywhere, "hormiga"),
            entry("éxito", Anywhere, "éxito"),
        ]);
        for (text, expected) in [
            ("failure hormiguero", vec![]),
            ("F! f f", vec!["f"]),
            ("vi una HORMIGA hoy", vec!["hormiga"]),
            ("¡ÉXITO!", vec!["éxito"]),
            ("éxitosa", vec![]),
            ("E\u{301}XITO!", vec!["éxito"]),
            ("f\u{301}", vec![]),
            ("f_ f2", vec![]),
            ("\u{200d}f\u{200c}", vec!["f"]),
        ] {
            assert_eq!(ids(match_keywords(&index, text)), expected, "{text:?}");
        }
        let index = compile_keyword_index([
            entry("f", Start, "f"),
            entry("f", Exact, "exact"),
            entry("hola mundo", Anywhere, "phrase"),
        ]);
        for (text, expected) in [
            (" f ", vec!["f", "exact"]),
            ("f otra falla", vec!["f"]),
            ("otra falla f", vec![]),
            ("¡hola mundo!", vec!["phrase"]),
            ("hola mundoso", vec![]),
            ("HOLA\tMUNDO", vec!["phrase"]),
        ] {
            assert_eq!(ids(match_keywords(&index, text)), expected);
        }
        assert!(keyword_matches(
            "xa a a",
            &entry("a a", Anywhere, "overlap")
        ));
        assert!(keyword_matches(
            "x!",
            &entry("", Anywhere, "empty-direct-helper")
        ));
        assert_eq!(
            normalize_keyword("\u{feff} HOLA\u{00a0}\tMundo \n"),
            "hola mundo"
        );
        assert_eq!(normalize_keyword("\u{0085}X\u{0085}"), "\u{0085}x\u{0085}");
        assert_eq!(normalize_keyword("ΟΣ İ"), "ος i\u{307}");
        let ordered = compile_keyword_index([
            entry("a", Anywhere, "same"),
            entry("b", Anywhere, "second"),
            entry("b", Anywhere, "same"),
        ]);
        let matches = match_keywords(&ordered, "a b a");
        assert_eq!(
            matches.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["same", "second"]
        );
        assert_eq!(matches[0].text, "b");
    }

    #[test]
    fn source_validation_checks_original_js_length() {
        let mode = json!({"matchMode":"anywhere"});
        for bad in [
            json!(""),
            json!("!f"),
            json!("a.*"),
            json!("a".repeat(61)),
            Value::Null,
            json!(5),
            json!("a\u{0085}b"),
        ] {
            assert_eq!(
                validate_keyword(&bad, &mode),
                Err(KeywordValidationError::Text)
            );
        }
        assert_eq!(
            validate_keyword(&json!("hola mundo"), &mode),
            Ok(KeywordMatchMode::Anywhere)
        );
        for mode in [json!(["start"]), json!([["anywhere"]])] {
            let settings = json!({"matchMode": mode});
            assert_eq!(
                validate_keyword_settings(&json!("f"), &settings),
                Ok(settings.clone())
            );
            assert_eq!(
                validate_keyword(&json!("f"), &settings),
                Err(KeywordValidationError::MatchMode)
            );
        }
        assert!(validate_keyword(&json!(" _变量 １２٣ \u{0301} "), &mode).is_ok());
        assert!(validate_keyword(&json!("𐐀".repeat(30)), &mode).is_ok());
        assert!(validate_keyword(&json!("𐐀".repeat(31)), &mode).is_err());
        // NFC shrinks this to 31 characters, but source checks the raw 62 units.
        assert!(validate_keyword(&json!("e\u{301}".repeat(31)), &mode).is_err());
        for settings in [
            Value::Null,
            json!({}),
            json!({"matchMode":"regex"}),
            json!({"matchMode":false}),
        ] {
            assert_eq!(
                validate_keyword(&json!("f"), &settings),
                Err(KeywordValidationError::MatchMode)
            );
        }
    }

    struct Loader {
        reads: AtomicUsize,
        started: Semaphore,
        finish: Semaphore,
        block_first: bool,
        fail_first: bool,
    }
    impl Loader {
        fn new(block_first: bool, fail_first: bool) -> Self {
            Self {
                reads: AtomicUsize::new(0),
                started: Semaphore::new(0),
                finish: Semaphore::new(0),
                block_first,
                fail_first,
            }
        }
    }
    impl KeywordLoader for Loader {
        type Error = &'static str;
        async fn load(&self, _: &str) -> Result<Vec<KeywordEntry>, Self::Error> {
            let read = self.reads.fetch_add(1, Ordering::SeqCst);
            if read == 0 {
                self.started.add_permits(1);
                if self.block_first {
                    self.finish.acquire().await.unwrap().forget();
                }
                if self.fail_first {
                    return Err("unavailable");
                }
                return Ok(vec![]);
            }
            Ok(vec![entry("new", KeywordMatchMode::Start, "new")])
        }
    }

    #[tokio::test]
    async fn cold_loads_coalesce_and_cache_empty_channels() {
        let cache = Arc::new(KeywordIndexCache::new(Loader::new(true, false)));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..50 {
            let cache = Arc::clone(&cache);
            tasks.spawn(async move { cache.get("channel").await.unwrap() });
        }
        cache.loader.started.acquire().await.unwrap().forget();
        // Deterministically wait until every other request is a subscriber.
        for _ in 0..1000 {
            let subscribers = cache
                .state
                .lock()
                .unwrap()
                .pending
                .get("channel")
                .unwrap()
                .sender
                .receiver_count();
            if subscribers == 49 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            cache
                .state
                .lock()
                .unwrap()
                .pending
                .get("channel")
                .unwrap()
                .sender
                .receiver_count(),
            49
        );
        cache.loader.finish.add_permits(1);
        while let Some(result) = tasks.join_next().await {
            assert!(result.unwrap().is_empty());
        }
        assert!(cache.get("channel").await.unwrap().is_empty());
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidation_discards_inflight_read_and_preserves_successor() {
        let cache = KeywordIndexCache::new(Loader::new(true, false));
        let old = cache.get("channel");
        let edit = async {
            cache.loader.started.acquire().await.unwrap().forget();
            assert!(apply_keyword_change(
                &cache,
                &json!({"channelID":"channel"})
            ));
            let new = cache.get("channel").await.unwrap();
            assert_eq!(new.bucket("new")[0].id, "new");
            cache.loader.finish.add_permits(1);
            new
        };
        let (old, new) = tokio::join!(old, edit);
        assert!(Arc::ptr_eq(&old.unwrap(), &new));
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 2);
        for event in [json!({}), json!({"channelID":""}), json!({"channelID":3})] {
            assert!(!apply_keyword_change(&cache, &event));
        }
    }

    #[tokio::test]
    async fn invalidated_failed_load_preserves_original_rejection() {
        let cache = KeywordIndexCache::new(Loader::new(true, true));
        let old = cache.get("channel");
        let edit = async {
            cache.loader.started.acquire().await.unwrap().forget();
            cache.invalidate("channel");
            let new = cache.get("channel").await.unwrap();
            cache.loader.finish.add_permits(1);
            new
        };
        let (old, new) = tokio::join!(old, edit);
        assert_eq!(*old.unwrap_err(), "unavailable");
        assert!(Arc::ptr_eq(&cache.get("channel").await.unwrap(), &new));
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidated_failure_rejects_all_original_waiters() {
        let cache = Arc::new(KeywordIndexCache::new(Loader::new(true, true)));
        let leader_cache = Arc::clone(&cache);
        let leader = tokio::spawn(async move { leader_cache.get("channel").await });
        cache.loader.started.acquire().await.unwrap().forget();
        let waiter_cache = Arc::clone(&cache);
        let waiter = tokio::spawn(async move { waiter_cache.get("channel").await });
        for _ in 0..1000 {
            if cache.state.lock().unwrap().pending["channel"]
                .sender
                .receiver_count()
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            cache.state.lock().unwrap().pending["channel"]
                .sender
                .receiver_count(),
            1
        );
        cache.invalidate("channel");
        tokio::task::yield_now().await;
        cache.loader.finish.add_permits(1);
        assert_eq!(*leader.await.unwrap().unwrap_err(), "unavailable");
        assert_eq!(*waiter.await.unwrap().unwrap_err(), "unavailable");
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidated_success_shares_successor_even_without_completed_cache() {
        let cache = Arc::new(KeywordIndexCache::with_limits(
            Loader::new(true, false),
            Duration::ZERO,
            0,
        ));
        let leader_cache = Arc::clone(&cache);
        let leader = tokio::spawn(async move { leader_cache.get("channel").await });
        cache.loader.started.acquire().await.unwrap().forget();
        let waiter_cache = Arc::clone(&cache);
        let waiter = tokio::spawn(async move { waiter_cache.get("channel").await });
        for _ in 0..1000 {
            if cache.state.lock().unwrap().pending["channel"]
                .sender
                .receiver_count()
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            cache.state.lock().unwrap().pending["channel"]
                .sender
                .receiver_count(),
            1
        );
        cache.invalidate("channel");
        tokio::task::yield_now().await;
        cache.loader.finish.add_permits(1);
        let leader = leader.await.unwrap().unwrap();
        let waiter = waiter.await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&leader, &waiter));
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failure_ttl_capacity_and_cancelled_load_retry() {
        let cache = KeywordIndexCache::new(Loader::new(false, true));
        assert_eq!(*cache.get("a").await.unwrap_err(), "unavailable");
        assert!(cache.get("a").await.is_ok());
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 2);
        let cache = KeywordIndexCache::with_limits(Loader::new(false, false), Duration::ZERO, 1);
        cache.get("a").await.unwrap();
        cache.get("a").await.unwrap();
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 2);
        let cache =
            KeywordIndexCache::with_limits(Loader::new(false, false), Duration::from_secs(60), 1);
        cache.get("a").await.unwrap();
        cache.get("b").await.unwrap();
        cache.get("a").await.unwrap();
        assert_eq!(cache.loader.reads.load(Ordering::SeqCst), 3);
        let cache = Arc::new(KeywordIndexCache::new(Loader::new(true, false)));
        let task_cache = Arc::clone(&cache);
        let task = tokio::spawn(async move { task_cache.get("cancel").await });
        cache.loader.started.acquire().await.unwrap().forget();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(cache.state.lock().unwrap().pending.is_empty());
        assert_eq!(
            cache.get("cancel").await.unwrap().bucket("new")[0].id,
            "new"
        );
    }

    #[derive(Default)]
    struct MemoryStorage {
        values: Mutex<HashMap<String, String>>,
        effects: Mutex<Vec<String>>,
        index_queries: AtomicUsize,
        body_queries: AtomicUsize,
        reject_cas: AtomicUsize,
        missing_body: AtomicBool,
        fail_publish: AtomicBool,
    }
    impl KeywordStorage for MemoryStorage {
        type Error = &'static str;
        async fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        async fn query_index(&self, channel: &str) -> Result<Vec<KeywordRow>, Self::Error> {
            assert_eq!(channel, "c");
            self.index_queries.fetch_add(1, Ordering::SeqCst);
            Ok(vec![KeywordRow {
                id: "id".into(),
                cmd: " HOLA \tMundo ".into(),
                match_mode: None,
            }])
        }
        async fn query_body(&self, channel: &str, id: &str) -> Result<Option<Value>, Self::Error> {
            assert_eq!((channel, id), ("c", "id"));
            self.body_queries.fetch_add(1, Ordering::SeqCst);
            Ok(if self.missing_body.load(Ordering::SeqCst) {
                None
            } else {
                Some(json!({"_id":"id","activation":"keyword","enabled":false,"count":5}))
            })
        }
        async fn set_if_revision(
            &self,
            data: &str,
            revision: &str,
            expected: &str,
            json: &str,
            ttl: u64,
        ) -> Result<bool, Self::Error> {
            assert_eq!(revision, "keywords:revision:c");
            assert_eq!(
                ttl,
                if data.starts_with("keywords:index:") {
                    86400
                } else {
                    30
                }
            );
            let mut values = self.values.lock().unwrap();
            if self
                .reject_cas
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                let next = values
                    .get(revision)
                    .map(|n| n.parse::<u64>().unwrap())
                    .unwrap_or(0)
                    + 1;
                values.insert(revision.into(), next.to_string());
            }
            if values.get(revision).map(String::as_str).unwrap_or("0") != expected {
                return Ok(false);
            }
            values.insert(data.into(), json.into());
            Ok(true)
        }
        async fn invalidate_shared(
            &self,
            revision: &str,
            index: &str,
            body: Option<&str>,
        ) -> Result<(), Self::Error> {
            let mut values = self.values.lock().unwrap();
            let next = values
                .get(revision)
                .map(|n| n.parse::<u64>().unwrap())
                .unwrap_or(0)
                + 1;
            values.insert(revision.into(), next.to_string());
            values.remove(index);
            if let Some(body) = body {
                values.remove(body);
            }
            self.effects.lock().unwrap().push("invalidate".into());
            Ok(())
        }
        async fn publish(&self, topic: &str, event: &str) -> Result<(), Self::Error> {
            assert_eq!(topic, "keywords:changed");
            assert_eq!(
                serde_json::from_str::<Value>(event).unwrap(),
                json!({"channelID":"c"})
            );
            self.effects.lock().unwrap().push("publish".into());
            if self.fail_publish.load(Ordering::SeqCst) {
                Err("publish failed")
            } else {
                Ok(())
            }
        }
        async fn update_keyword_count(
            &self,
            channel: &str,
            id: &str,
            count: f64,
        ) -> Result<(), Self::Error> {
            assert_eq!((channel, id, count), ("c", "id", 7.0));
            self.effects.lock().unwrap().push("count".into());
            Ok(())
        }
        async fn delete(&self, key: &str) -> Result<(), Self::Error> {
            assert_eq!(key, "keywords:body:c:id");
            self.values.lock().unwrap().remove(key);
            self.effects.lock().unwrap().push("delete-body".into());
            Ok(())
        }
    }

    #[tokio::test]
    async fn shared_revision_retries_projection_and_ttl() {
        let store = MemoryStorage::default();
        store.reject_cas.store(2, Ordering::SeqCst);
        let entries = load_shared_index(&store, "c").await.unwrap();
        assert_eq!(
            entries,
            vec![entry("hola mundo", KeywordMatchMode::Start, "id")]
        );
        assert_eq!(store.index_queries.load(Ordering::SeqCst), 3);
        assert_eq!(load_shared_index(&store, "c").await.unwrap(), entries);
        assert_eq!(store.index_queries.load(Ordering::SeqCst), 3);
        store.values.lock().unwrap().remove("keywords:index:c");
        store.reject_cas.store(5, Ordering::SeqCst);
        assert!(matches!(
            load_shared_index(&store, "c").await,
            Err(KeywordStorageError::RepeatedIndexChange)
        ));
        assert_eq!(store.index_queries.load(Ordering::SeqCst), 8);
        store
            .values
            .lock()
            .unwrap()
            .insert("keywords:index:c".into(), "{".into());
        assert!(matches!(
            load_shared_index(&store, "c").await,
            Err(KeywordStorageError::Json(_))
        ));
    }

    #[tokio::test]
    async fn body_refresh_pubsub_and_counter_invalidation_effects() {
        let store = Arc::new(MemoryStorage::default());
        let cache = KeywordIndexCache::new(SharedKeywordLoader {
            storage: Arc::clone(&store),
        });
        cache.get("c").await.unwrap();
        store.reject_cas.store(1, Ordering::SeqCst);
        let body = get_keyword_body(store.as_ref(), "c", "id")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body["enabled"], false);
        assert_eq!(store.body_queries.load(Ordering::SeqCst), 2);
        get_keyword_body(store.as_ref(), "c", "id").await.unwrap();
        assert_eq!(store.body_queries.load(Ordering::SeqCst), 2);
        refresh_keyword_index(&cache, "c", Some("id"))
            .await
            .unwrap();
        assert_eq!(
            store.effects.lock().unwrap().as_slice(),
            ["invalidate", "publish"]
        );
        assert!(
            !store
                .values
                .lock()
                .unwrap()
                .contains_key("keywords:body:c:id")
        );
        assert_eq!(store.index_queries.load(Ordering::SeqCst), 2);
        let revision = store.values.lock().unwrap()["keywords:revision:c"].clone();
        get_keyword_body(store.as_ref(), "c", "id").await.unwrap();
        save_keyword_count(store.as_ref(), "c", "id", 7.0)
            .await
            .unwrap();
        assert_eq!(
            store.values.lock().unwrap()["keywords:revision:c"],
            revision
        );
        assert!(
            store
                .values
                .lock()
                .unwrap()
                .contains_key("keywords:index:c")
        );
        assert_eq!(
            &store.effects.lock().unwrap()[2..],
            ["count", "delete-body"]
        );
        store.missing_body.store(true, Ordering::SeqCst);
        assert_eq!(
            get_keyword_body(store.as_ref(), "c", "id").await.unwrap(),
            None
        );
        assert_eq!(
            get_keyword_body(store.as_ref(), "c", "id").await.unwrap(),
            None
        );
        assert!(
            !store
                .values
                .lock()
                .unwrap()
                .contains_key("keywords:body:c:id")
        );
        store.missing_body.store(false, Ordering::SeqCst);
        store.reject_cas.store(5, Ordering::SeqCst);
        assert!(matches!(
            get_keyword_body(store.as_ref(), "c", "id").await,
            Err(KeywordStorageError::RepeatedBodyChange)
        ));
        store.fail_publish.store(true, Ordering::SeqCst);
        let before = store.index_queries.load(Ordering::SeqCst);
        assert!(refresh_keyword_index(&cache, "c", None).await.is_err());
        assert_eq!(store.index_queries.load(Ordering::SeqCst), before);
        assert!(!cache.state.lock().unwrap().entries.contains_key("c"));
    }
}
