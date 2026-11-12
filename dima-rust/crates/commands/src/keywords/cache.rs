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

    /// The channel's keywords.
    fn load<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Vec<KeywordEntry>, Self::Error>> + Send + 'a;
}

/// A failed load, shared by every caller that waited for it.
pub type LoadError<E> = Arc<E>;
type LoadResult<E> = Result<Arc<KeywordIndex>, LoadError<E>>;

struct Cached {
    index: Arc<KeywordIndex>,
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

/// Compiled keyword indexes per channel.
///
/// Concurrent cold loads of a channel share one load, and an empty channel is cached like any
/// other. [`invalidate`](Self::invalidate) detaches a load in flight: when it succeeds its
/// result is discarded and the callers get a fresh load instead; when it fails they get the
/// failure. A caller that drops its future wakes the others, which then load again. Entries
/// expire after their time to live by the injected clock; beyond the capacity the oldest
/// insertion is evicted. The cache owns no task.
pub struct KeywordIndexCache<L: KeywordLoader> {
    loader: L,
    clock: Arc<dyn Clock>,
    ttl_ms: i64,
    capacity: usize,
    state: Arc<Mutex<CacheState<L::Error>>>,
}

impl<L: KeywordLoader> fmt::Debug for KeywordIndexCache<L> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordIndexCache")
            .field("ttl_ms", &self.ttl_ms)
            .field("capacity", &self.capacity)
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
    /// The reference's limits: 30 s, 2,000 channels.
    pub fn new(loader: L, clock: Arc<dyn Clock>) -> Self {
        Self::with_limits(loader, clock, LOCAL_TTL_MS, LOCAL_CAPACITY)
    }

    /// Custom time to live (milliseconds) and capacity.
    pub fn with_limits(loader: L, clock: Arc<dyn Clock>, ttl_ms: i64, capacity: usize) -> Self {
        Self {
            loader,
            clock,
            ttl_ms,
            capacity,
            state: Arc::new(Mutex::new(CacheState::default())),
        }
    }

    /// The loader.
    pub fn loader(&self) -> &L {
        &self.loader
    }

    /// Forgets the channel's index and detaches a load in flight.
    pub fn invalidate(&self, channel_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.entries.remove(channel_id);
        state.order.retain(|channel| channel != channel_id);
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
                    let result = self
                        .loader
                        .load(channel_id)
                        .await
                        .map(|entries| Arc::new(KeywordIndex::new(entries)))
                        .map_err(Arc::new);
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

    fn next_action(&self, channel_id: &str) -> Action<L::Error> {
        let now = self.clock.now_ms();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = state
            .entries
            .get(channel_id)
            .filter(|cached| cached.expires_ms > now)
        {
            return Action::Done(Ok(Arc::clone(&cached.index)));
        }
        if let Some(pending) = state.pending.get(channel_id) {
            return Action::Wait(pending.sender.subscribe());
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

    /// Stores a successful load that is still current. Returns whether the load was current.
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
        if let Ok(index) = result {
            state.order.retain(|channel| channel != channel_id);
            state.order.push_back(channel_id.to_owned());
            state.entries.insert(
                channel_id.to_owned(),
                Cached {
                    index: Arc::clone(index),
                    expires_ms: now.saturating_add(self.ttl_ms),
                },
            );
            if state.entries.len() > self.capacity
                && let Some(oldest) = state.order.pop_front()
            {
                state.entries.remove(&oldest);
            }
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
    /// `_id cmd keywordSettings`, in the database's order.
    fn query_index<'a>(
        &'a self,
        channel_id: &'a str,
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
            return serde_json::from_str(&json).map_err(|error| json_error(&error));
        }
        let revision = store
            .get(&revision_key)
            .await
            .map_err(KeywordStorageError::Storage)?
            .unwrap_or_else(|| "0".to_owned());
        let rows = store
            .query_index(channel_id)
            .await
            .map_err(KeywordStorageError::Storage)?;
        let entries: Vec<KeywordEntry> = rows
            .into_iter()
            .map(|row| KeywordEntry {
                id: row.id,
                text: normalize_keyword(&row.cmd),
                match_mode: row.match_mode,
            })
            .collect();
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
) -> Result<(), LoadError<KeywordStorageError<S::Error>>> {
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
        .map_err(|error| Arc::new(KeywordStorageError::Storage(error)))?;
    cache.invalidate(channel_id);
    let event = serde_json::json!({ "channelID": channel_id }).to_string();
    store
        .publish(KEYWORD_TOPIC, &event)
        .await
        .map_err(|error| Arc::new(KeywordStorageError::Storage(error)))?;
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
