//! The keyword index cache (reference: `KeywordIndexCache` in `utils/keywords.ts` and
//! `utils/keyword_cache.ts`).
//!
//! Two levels, as in the reference: a per-process cache of compiled indexes
//! ([`KeywordIndexCache`]) over a Dragonfly copy shared by every process, fenced by a revision
//! counter so a load that raced an edit never republishes an obsolete list. [`KeywordStorage`]
//! is the store boundary; its implementation (MongoDB query, Dragonfly Lua, pub/sub) belongs to
//! the caller. The Dragonfly keys are a *rebuilt* family (`MIGRATION.md` section 3): their
//! values are this crate's JSON and are reloaded from MongoDB on a miss.
//!
//! Reference values kept: 30 s local time to live, 2,000 channels locally, 5 revision attempts,
//! 86,400 s for the shared index, 30 s for a cached body.
//!
//! Bounds the reference does not have (see [`KeywordCacheLimits`]): at most 1,000 keywords and
//! 1 MiB per channel (a channel over either is refused, the refusal cached for the time to live,
//! and its messages are handled as if it had no keywords), 64 MiB for all indexes (whole
//! channels evicted, oldest first), and 256 loads in flight.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use dima_core::Clock;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use super::{KeywordEntry, KeywordIndex, KeywordMatchMode, normalize_keyword};

/// The pub/sub topic announcing a channel's keyword change, as the reference names it. Pub/sub
/// is server-wide, so the [`KeywordStorage::publish`] implementation and the subscriber apply
/// the workspace's naming for Rust channels.
pub const KEYWORD_TOPIC: &str = "keywords:changed";
/// Time to live of the shared index, in seconds.
pub const SHARED_INDEX_TTL_SECONDS: u64 = 86_400;
/// Time to live of a cached keyword body, in seconds.
pub const BODY_TTL_SECONDS: u64 = 30;
/// Loads retried while the revision keeps moving.
pub const MAX_REVISION_ATTEMPTS: usize = 5;
/// Publishes the shared index (`KEYS[1]`, `EX 86400`) only while the revision (`KEYS[2]`,
/// missing reads `'0'`) still equals `ARGV[1]`. Verbatim from `loadSharedIndex`.
pub const SHARED_INDEX_SCRIPT: &str = "if (redis.call('get', KEYS[2]) or '0') == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', 86400); return 1 end; return 0";
/// The same fence for a keyword body (`EX 30`). Verbatim from `getKeywordBody`.
pub const BODY_SCRIPT: &str = "if (redis.call('get', KEYS[2]) or '0') == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', 30); return 1 end; return 0";

/// The local time to live of a compiled index, in milliseconds.
const LOCAL_TTL_MS: i64 = 30_000;
/// The most channels kept locally.
const LOCAL_CAPACITY: usize = 2_000;
/// The most keywords one channel's index may hold. The reference's API sets no limit on keyword
/// commands per channel (for any plan), so this is this crate's own hard cap: far above the
/// production copy (at most 3 per channel), and what 60-character keywords fit in
/// [`MAX_KEYWORD_INDEX_BYTES`] with room to spare.
pub const MAX_KEYWORDS_PER_CHANNEL: usize = 1_000;
/// The largest index of one channel, in bytes ([`KeywordIndex::heap_bytes`]).
pub const MAX_KEYWORD_INDEX_BYTES: usize = 1024 * 1024;
/// The most bytes all cached indexes together may hold; whole channels are evicted, oldest
/// first, to stay under it.
pub const MAX_CACHED_KEYWORD_BYTES: usize = 64 * 1024 * 1024;
/// The most channels loading at the same time (callers waiting on a load in flight do not
/// count).
pub const MAX_KEYWORD_LOADS_IN_FLIGHT: usize = 256;
/// The largest shared index read from Dragonfly, in bytes, before it is parsed.
pub const MAX_SHARED_INDEX_JSON_BYTES: usize = 1024 * 1024;

/// `keywords:index:{channel}`.
pub fn keyword_index_key(channel_id: &str) -> String {
    format!("keywords:index:{channel_id}")
}

/// `keywords:revision:{channel}`.
pub fn keyword_revision_key(channel_id: &str) -> String {
    format!("keywords:revision:{channel_id}")
}

/// `keywords:body:{channel}:{id}`.
pub fn keyword_body_key(channel_id: &str, id: &str) -> String {
    format!("keywords:body:{channel_id}:{id}")
}

/// The source of a channel's keyword entries for [`KeywordIndexCache`].
pub trait KeywordLoader: Send + Sync {
    /// A load failure.
    type Error: Send + Sync;

    /// The channel's keywords. A loader may stop after
    /// [`KeywordCacheLimits::keywords_per_channel`] + 1 entries: one more than the limit is
    /// enough for the cache to refuse the channel.
    fn load<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Vec<KeywordEntry>, Self::Error>> + Send + 'a;
}

/// Why the cache answered without an index. The caller logs it and handles the message as if
/// the channel had no keywords; nothing here blocks chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Overload {
    /// The channel has more keywords than [`KeywordCacheLimits::keywords_per_channel`]. The
    /// refusal is cached for the time to live, like an index.
    #[error("the channel has more than {limit} keywords")]
    TooManyKeywords {
        /// The limit.
        limit: usize,
    },
    /// The channel's index is larger than [`KeywordCacheLimits::index_bytes`]. Cached likewise.
    #[error("the channel's keyword index takes {bytes} bytes, over {limit}")]
    IndexTooLarge {
        /// The index's size.
        bytes: usize,
        /// The limit.
        limit: usize,
    },
    /// [`KeywordCacheLimits::loads_in_flight`] other channels are loading. Not cached.
    #[error("{limit} keyword loads are already in flight")]
    LoadsInFlight {
        /// The limit.
        limit: usize,
    },
}

/// A lookup that returned no index.
#[derive(Debug, thiserror::Error)]
pub enum KeywordCacheError<E> {
    /// The load failed (shared by every caller that waited for it).
    #[error("keyword load failed")]
    Load(Arc<E>),
    /// A bound was reached.
    #[error("keyword cache overloaded: {0}")]
    Overloaded(Overload),
}

impl<E> Clone for KeywordCacheError<E> {
    fn clone(&self) -> Self {
        match self {
            Self::Load(error) => Self::Load(Arc::clone(error)),
            Self::Overloaded(overload) => Self::Overloaded(*overload),
        }
    }
}

type LoadResult<E> = Result<Arc<KeywordIndex>, KeywordCacheError<E>>;

/// The bounds of a [`KeywordIndexCache`]. [`Default`] is the reference's time to live and
/// channel count plus this crate's own bounds (the constants of this module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeywordCacheLimits {
    /// Time to live of an index (and of a cached refusal), in milliseconds.
    pub ttl_ms: i64,
    /// The most channels kept.
    pub channels: usize,
    /// The most keywords one channel may have.
    pub keywords_per_channel: usize,
    /// The largest index of one channel, in bytes.
    pub index_bytes: usize,
    /// The most bytes all indexes together may hold.
    pub total_bytes: usize,
    /// The most channels loading at once.
    pub loads_in_flight: usize,
}

impl Default for KeywordCacheLimits {
    fn default() -> Self {
        Self {
            ttl_ms: LOCAL_TTL_MS,
            channels: LOCAL_CAPACITY,
            keywords_per_channel: MAX_KEYWORDS_PER_CHANNEL,
            index_bytes: MAX_KEYWORD_INDEX_BYTES,
            total_bytes: MAX_CACHED_KEYWORD_BYTES,
            loads_in_flight: MAX_KEYWORD_LOADS_IN_FLIGHT,
        }
    }
}

struct Cached {
    outcome: Result<Arc<KeywordIndex>, Overload>,
    bytes: usize,
    expires_ms: i64,
}

struct Pending<E> {
    id: u64,
    sender: watch::Sender<Option<LoadResult<E>>>,
}

struct CacheState<E> {
    entries: HashMap<String, Cached>,
    /// Insertion order of `entries`, oldest first.
    order: VecDeque<String>,
    /// The bytes of every cached entry.
    bytes: usize,
    pending: HashMap<String, Pending<E>>,
    next_id: u64,
}

impl<E> Default for CacheState<E> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            pending: HashMap::new(),
            next_id: 0,
        }
    }
}

impl<E> CacheState<E> {
    fn remove(&mut self, channel_id: &str) {
        if let Some(cached) = self.entries.remove(channel_id) {
            self.bytes = self.bytes.saturating_sub(cached.bytes);
            self.order.retain(|channel| channel != channel_id);
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(oldest) = self.order.pop_front()
            && let Some(cached) = self.entries.remove(&oldest)
        {
            self.bytes = self.bytes.saturating_sub(cached.bytes);
        }
    }
}

/// Compiled keyword indexes per channel.
///
/// Concurrent cold loads of a channel share one load, and an empty channel is cached like any
/// other. [`invalidate`](Self::invalidate) detaches a load in flight: when it succeeds its
/// result is discarded and the callers get a fresh load instead; when it fails they get the failure. A caller that drops its future wakes
/// the others, which then load again. Entries expire after their time to live by the injected
/// clock; beyond the channel count or the byte budget the oldest insertions are evicted, whole
/// channels at a time. A channel over its keyword or byte limit is refused (and the refusal
/// cached), and a new load is refused while too many are in flight ([`KeywordCacheLimits`]).
/// The cache owns no task.
pub struct KeywordIndexCache<L: KeywordLoader> {
    loader: L,
    clock: Arc<dyn Clock>,
    limits: KeywordCacheLimits,
    state: Arc<Mutex<CacheState<L::Error>>>,
}

impl<L: KeywordLoader> fmt::Debug for KeywordIndexCache<L> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordIndexCache")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

struct PendingGuard<E> {
    state: Arc<Mutex<CacheState<E>>>,
    channel: String,
    id: u64,
}

impl<E> Drop for PendingGuard<E> {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state
            .pending
            .get(&self.channel)
            .is_some_and(|pending| pending.id == self.id)
        {
            state.pending.remove(&self.channel);
        }
    }
}

enum Action<E> {
    Done(LoadResult<E>),
    Wait(watch::Receiver<Option<LoadResult<E>>>),
    Load(u64, watch::Sender<Option<LoadResult<E>>>),
}

fn publish<E>(
    relays: &[watch::Sender<Option<LoadResult<E>>>],
    result: LoadResult<E>,
) -> LoadResult<E> {
    for relay in relays {
        relay.send_replace(Some(result.clone()));
    }
    result
}

impl<L: KeywordLoader> KeywordIndexCache<L> {
    /// The default limits ([`KeywordCacheLimits::default`]).
    pub fn new(loader: L, clock: Arc<dyn Clock>) -> Self {
        Self::with_limits(loader, clock, KeywordCacheLimits::default())
    }

    /// Chosen limits.
    pub fn with_limits(loader: L, clock: Arc<dyn Clock>, limits: KeywordCacheLimits) -> Self {
        Self {
            loader,
            clock,
            limits,
            state: Arc::new(Mutex::new(CacheState::default())),
        }
    }

    /// The loader.
    pub fn loader(&self) -> &L {
        &self.loader
    }

    /// The limits.
    pub fn limits(&self) -> &KeywordCacheLimits {
        &self.limits
    }

    /// Forgets the channel's index and detaches a load in flight.
    pub fn invalidate(&self, channel_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.remove(channel_id);
        state.pending.remove(channel_id);
    }

    /// How many channels are cached.
    pub fn len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .len()
    }

    /// Whether no channel is cached.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The bytes the cached entries hold.
    pub fn heap_bytes(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .bytes
    }

    /// How many loads are in flight.
    pub fn loads_in_flight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pending
            .len()
    }

    /// The channel's compiled index.
    pub async fn get(&self, channel_id: &str) -> LoadResult<L::Error> {
        // Callers of a load that was invalidated keep waiting for its successor, as callers of
        // the reference's shared promise do.
        let mut relays = Vec::new();
        loop {
            match self.next_action(channel_id) {
                Action::Done(result) => return publish(&relays, result),
                Action::Wait(mut receiver) => loop {
                    let ready = receiver.borrow().clone();
                    if let Some(result) = ready {
                        return publish(&relays, result);
                    }
                    if receiver.changed().await.is_err() {
                        // The loading caller went away: load again.
                        break;
                    }
                },
                Action::Load(id, sender) => {
                    let guard = PendingGuard {
                        state: Arc::clone(&self.state),
                        channel: channel_id.to_owned(),
                        id,
                    };
                    let result = match self.loader.load(channel_id).await {
                        Ok(entries) => self.check(entries),
                        Err(error) => Err(KeywordCacheError::Load(Arc::new(error))),
                    };
                    let accepted = self.finish(channel_id, id, &result);
                    drop(guard);
                    relays.push(sender);
                    if accepted || result.is_err() {
                        return publish(&relays, result);
                    }
                }
            }
        }
    }

    /// Builds the index of a load, or refuses a channel over its limits.
    fn check(&self, entries: Vec<KeywordEntry>) -> LoadResult<L::Error> {
        let limit = self.limits.keywords_per_channel;
        if entries.len() > limit {
            return Err(KeywordCacheError::Overloaded(Overload::TooManyKeywords {
                limit,
            }));
        }
        let index = KeywordIndex::new(entries);
        if index.heap_bytes() > self.limits.index_bytes {
            return Err(KeywordCacheError::Overloaded(Overload::IndexTooLarge {
                bytes: index.heap_bytes(),
                limit: self.limits.index_bytes,
            }));
        }
        Ok(Arc::new(index))
    }

    fn next_action(&self, channel_id: &str) -> Action<L::Error> {
        let now = self.clock.now_ms();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = state
            .entries
            .get(channel_id)
            .filter(|cached| cached.expires_ms > now)
        {
            return Action::Done(match &cached.outcome {
                Ok(index) => Ok(Arc::clone(index)),
                Err(overload) => Err(KeywordCacheError::Overloaded(*overload)),
            });
        }
        if let Some(pending) = state.pending.get(channel_id) {
            return Action::Wait(pending.sender.subscribe());
        }
        if state.pending.len() >= self.limits.loads_in_flight {
            return Action::Done(Err(KeywordCacheError::Overloaded(
                Overload::LoadsInFlight {
                    limit: self.limits.loads_in_flight,
                },
            )));
        }
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        let (sender, _) = watch::channel(None);
        state.pending.insert(
            channel_id.to_owned(),
            Pending {
                id,
                sender: sender.clone(),
            },
        );
        Action::Load(id, sender)
    }

    /// Stores a load that is still current: an index, or the refusal of an oversized channel.
    /// Returns whether the load was current.
    fn finish(&self, channel_id: &str, id: u64, result: &LoadResult<L::Error>) -> bool {
        let now = self.clock.now_ms();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state
            .pending
            .get(channel_id)
            .is_some_and(|pending| pending.id == id)
        {
            return false;
        }
        state.pending.remove(channel_id);
        let outcome = match result {
            Ok(index) => Ok(Arc::clone(index)),
            Err(KeywordCacheError::Overloaded(
                overload @ (Overload::TooManyKeywords { .. } | Overload::IndexTooLarge { .. }),
            )) => Err(*overload),
            Err(_) => return true,
        };
        let bytes = outcome.as_ref().map_or(0, |index| index.heap_bytes()) + channel_id.len();
        state.remove(channel_id);
        state.order.push_back(channel_id.to_owned());
        state.bytes = state.bytes.saturating_add(bytes);
        state.entries.insert(
            channel_id.to_owned(),
            Cached {
                outcome,
                bytes,
                expires_ms: now.saturating_add(self.limits.ttl_ms),
            },
        );
        while state.entries.len() > self.limits.channels
            || (state.bytes > self.limits.total_bytes && !state.entries.is_empty())
        {
            state.evict_oldest();
        }
        true
    }
}

/// A keyword command as the shared index loads it.
#[derive(Debug, Clone)]
pub struct KeywordRow {
    /// `String(_id)`.
    pub id: String,
    /// `cmd`, the keyword as stored.
    pub cmd: String,
    /// `keywordSettings.matchMode` read with [`KeywordMatchMode::from_stored`].
    pub match_mode: KeywordMatchMode,
}

/// The MongoDB, Dragonfly and pub/sub operations of the keyword cache. Atomic operations must
/// stay atomic, and every failure is reported.
pub trait KeywordStorage: Send + Sync {
    /// A store failure.
    type Error: Send + Sync;
    /// The full keyword command document, as a cached body holds it.
    type Body: Serialize + DeserializeOwned + Send;

    /// `GET key`.
    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send + 'a;

    /// `Commands.find({channelID, activation: 'keyword', enabled: true})`, projected to
    /// `_id cmd keywordSettings`, in the database's order, at most `limit` rows (`.limit()`).
    fn query_index<'a>(
        &'a self,
        channel_id: &'a str,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<KeywordRow>, Self::Error>> + Send + 'a;

    /// `Commands.findOne({channelID, _id, activation: 'keyword'})` (no `enabled` filter).
    fn query_body<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
    ) -> impl Future<Output = Result<Option<Self::Body>, Self::Error>> + Send + 'a;

    /// `EVAL script` ([`SHARED_INDEX_SCRIPT`] or [`BODY_SCRIPT`]) with
    /// `KEYS = [data_key, revision_key]` and `ARGV = [revision, json]`; `true` when the script
    /// returned 1 (written).
    fn set_if_revision<'a>(
        &'a self,
        script: &'static str,
        data_key: &'a str,
        revision_key: &'a str,
        revision: &'a str,
        json: &'a str,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// One `MULTI`: `INCR revision_key`, `DEL index_key`, and `DEL body_key` when given.
    fn invalidate_shared<'a>(
        &'a self,
        revision_key: &'a str,
        index_key: &'a str,
        body_key: Option<&'a str>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `PUBLISH topic json`.
    fn publish<'a>(
        &'a self,
        topic: &'a str,
        json: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `Commands.updateOne({channelID, _id, activation: 'keyword'}, {$set: {count}})`.
    fn update_keyword_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `DEL key`.
    fn delete<'a>(
        &'a self,
        key: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

/// A failure of the shared keyword cache.
#[derive(Debug, thiserror::Error)]
pub enum KeywordStorageError<E> {
    /// The store failed.
    #[error("keyword storage failed")]
    Storage(E),
    /// A cached value is not the expected JSON (the position, never the text).
    #[error("cached keyword data is malformed at line {line}, column {column}")]
    Json {
        /// Line of the error.
        line: usize,
        /// Column of the error.
        column: usize,
    },
    /// The index kept changing while it loaded.
    #[error("Keyword settings changed repeatedly while loading")]
    RepeatedIndexChange,
    /// The body kept changing while it loaded.
    #[error("Keyword changed repeatedly while loading")]
    RepeatedBodyChange,
    /// The shared index in Dragonfly is longer than [`MAX_SHARED_INDEX_JSON_BYTES`]; it is not
    /// parsed.
    #[error("the shared keyword index takes {bytes} bytes, over {MAX_SHARED_INDEX_JSON_BYTES}")]
    SharedIndexTooLarge {
        /// Its length.
        bytes: usize,
    },
}

fn json_error<E>(error: &serde_json::Error) -> KeywordStorageError<E> {
    KeywordStorageError::Json {
        line: error.line(),
        column: error.column(),
    }
}

/// `loadSharedIndex`: the shared copy when present; otherwise MongoDB, published under the
/// revision read before the query (an edit racing the query makes the write fail and the load
/// retry, at most [`MAX_REVISION_ATTEMPTS`] times).
///
/// Bounded where the reference is not: a shared copy over [`MAX_SHARED_INDEX_JSON_BYTES`] is
/// refused unparsed, and MongoDB is asked for at most [`MAX_KEYWORDS_PER_CHANNEL`] + 1 rows; a
/// channel with more is returned with that many (so the cache refuses it) and never published.
pub async fn load_shared_index<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
) -> Result<Vec<KeywordEntry>, KeywordStorageError<S::Error>> {
    let key = keyword_index_key(channel_id);
    let revision_key = keyword_revision_key(channel_id);
    for _ in 0..MAX_REVISION_ATTEMPTS {
        if let Some(json) = store
            .get(&key)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            if json.len() > MAX_SHARED_INDEX_JSON_BYTES {
                return Err(KeywordStorageError::SharedIndexTooLarge { bytes: json.len() });
            }
            return serde_json::from_str(&json).map_err(|error| json_error(&error));
        }
        let revision = store
            .get(&revision_key)
            .await
            .map_err(KeywordStorageError::Storage)?
            .unwrap_or_else(|| "0".to_owned());
        let rows = store
            .query_index(channel_id, MAX_KEYWORDS_PER_CHANNEL + 1)
            .await
            .map_err(KeywordStorageError::Storage)?;
        let over_limit = rows.len() > MAX_KEYWORDS_PER_CHANNEL;
        let entries: Vec<KeywordEntry> = rows
            .into_iter()
            .map(|row| KeywordEntry {
                id: row.id,
                text: normalize_keyword(&row.cmd),
                match_mode: row.match_mode,
            })
            .collect();
        if over_limit {
            return Ok(entries);
        }
        let json = serde_json::to_string(&entries).map_err(|error| json_error(&error))?;
        if store
            .set_if_revision(SHARED_INDEX_SCRIPT, &key, &revision_key, &revision, &json)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            return Ok(entries);
        }
    }
    Err(KeywordStorageError::RepeatedIndexChange)
}

/// [`KeywordLoader`] over the shared index.
#[derive(Debug)]
pub struct SharedKeywordLoader<S> {
    /// The store.
    pub storage: Arc<S>,
}

impl<S: KeywordStorage> KeywordLoader for SharedKeywordLoader<S> {
    type Error = KeywordStorageError<S::Error>;

    async fn load(&self, channel_id: &str) -> Result<Vec<KeywordEntry>, Self::Error> {
        load_shared_index(self.storage.as_ref(), channel_id).await
    }
}

/// Handles a decoded `keywords:changed` message: invalidates the channel locally (no warm-up:
/// a channel that is not active here allocates nothing). Returns whether it named a channel.
pub fn apply_keyword_change<L: KeywordLoader>(cache: &KeywordIndexCache<L>, event: &Value) -> bool {
    match event.get("channelID").and_then(Value::as_str) {
        Some(channel) if !channel.is_empty() => {
            cache.invalidate(channel);
            true
        }
        _ => false,
    }
}

/// `refreshKeywordIndex`, after every keyword settings, add or delete write: bumps the
/// revision, drops the shared index (and the body of `id`), invalidates locally, announces the
/// change, and warms this process's cache.
pub async fn refresh_keyword_index<S: KeywordStorage>(
    cache: &KeywordIndexCache<SharedKeywordLoader<S>>,
    channel_id: &str,
    id: Option<&str>,
) -> Result<(), KeywordCacheError<KeywordStorageError<S::Error>>> {
    let store = cache.loader().storage.as_ref();
    let body = id
        .filter(|id| !id.is_empty())
        .map(|id| keyword_body_key(channel_id, id));
    store
        .invalidate_shared(
            &keyword_revision_key(channel_id),
            &keyword_index_key(channel_id),
            body.as_deref(),
        )
        .await
        .map_err(|error| KeywordCacheError::Load(Arc::new(KeywordStorageError::Storage(error))))?;
    cache.invalidate(channel_id);
    let event = serde_json::json!({ "channelID": channel_id }).to_string();
    store
        .publish(KEYWORD_TOPIC, &event)
        .await
        .map_err(|error| KeywordCacheError::Load(Arc::new(KeywordStorageError::Storage(error))))?;
    cache.get(channel_id).await.map(|_| ())
}

/// `getKeywordBody`: the cached command body, or MongoDB under the revision fence. A missing
/// command is not cached.
pub async fn get_keyword_body<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
    id: &str,
) -> Result<Option<S::Body>, KeywordStorageError<S::Error>> {
    let key = keyword_body_key(channel_id, id);
    let revision_key = keyword_revision_key(channel_id);
    for _ in 0..MAX_REVISION_ATTEMPTS {
        if let Some(json) = store
            .get(&key)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            return serde_json::from_str::<Option<S::Body>>(&json)
                .map_err(|error| json_error(&error));
        }
        let revision = store
            .get(&revision_key)
            .await
            .map_err(KeywordStorageError::Storage)?
            .unwrap_or_else(|| "0".to_owned());
        let Some(body) = store
            .query_body(channel_id, id)
            .await
            .map_err(KeywordStorageError::Storage)?
        else {
            return Ok(None);
        };
        let json = serde_json::to_string(&body).map_err(|error| json_error(&error))?;
        if store
            .set_if_revision(BODY_SCRIPT, &key, &revision_key, &revision, &json)
            .await
            .map_err(KeywordStorageError::Storage)?
        {
            return Ok(Some(body));
        }
    }
    Err(KeywordStorageError::RepeatedBodyChange)
}

/// `saveKeywordCount`: the counter changes only the body, never the settings revision.
pub async fn save_keyword_count<S: KeywordStorage>(
    store: &S,
    channel_id: &str,
    id: &str,
    count: f64,
) -> Result<(), S::Error> {
    store.update_keyword_count(channel_id, id, count).await?;
    store.delete(&keyword_body_key(channel_id, id)).await
}
