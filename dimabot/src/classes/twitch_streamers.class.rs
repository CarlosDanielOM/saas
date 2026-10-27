//! Opt-in account directory. Handles, clock, diagnostics and credentials are
//! explicit; construction performs no I/O and installs no runtime consumers.
//!
//! Metadata never owns credentials or permission flags. Directory generations
//! fence cooperating mutations independently from billing's plan-version fence.
//! MongoDB and Redis are not a transaction: writers must call targeted refresh
//! or absence eviction after Mongo mutation. Uncoordinated legacy writers cannot
//! be made linearizable by this library; a failed comparison is a retryable error.

#[path = "twitch_streamers/adapters.rs"]
mod adapters;
#[path = "twitch_streamers/mapping.rs"]
mod mapping;
#[cfg(test)]
#[path = "twitch_streamers/tests.rs"]
mod tests;
#[cfg(feature = "twitch-streamers-posthog")]
pub use adapters::PosthogStreamerIdentities;
pub use adapters::{MongoStreamerStore, NativeCredentials, RedisStreamerCache};
pub use mapping::{format_plan_date, metadata_from_document};

use super::{
    logger::{Destination, Level, LogOptions, Logger},
    plan_cache_fence::{MAX_READ_BATCH_ACCOUNTS, PLAN_CACHE_VERSION_FIELD},
    twitch::AccessToken,
    twitch_tokens::{CachedAccount, TokenClock, TokenStorageError},
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

pub type DirectoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, DirectoryError>> + Send + 'a>>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryError {
    Missing,
    Stale,
    Busy,
    InvalidInput,
    InvalidData,
    TooLarge,
    StoreUnavailable,
    CacheUnavailable {
        write_outcome_unknown: bool,
    },
    DeadlineExceeded {
        write_outcome_unknown: bool,
    },
    UnsupportedRefresh,
    ReconciliationIncomplete {
        cursor: u64,
        published: usize,
        checked: usize,
        removed: usize,
    },
    Credentials(TokenStorageError),
}
impl fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "streamer directory operation failed ({self:?})")
    }
}
impl std::error::Error for DirectoryError {}
impl From<TokenStorageError> for DirectoryError {
    fn from(value: TokenStorageError) -> Self {
        match value {
            TokenStorageError::Missing => Self::Missing,
            TokenStorageError::RefreshBusy => Self::Busy,
            other => Self::Credentials(other),
        }
    }
}

/// Metadata matches the source wire strings. Permission fields come ONLY from
/// the joined current credential hash and are deliberately absent here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamerMetadata {
    pub id: String,
    pub name: String,
    pub email: String,
    pub plan_tier: String,
    pub plan_tier_until: String,
    pub polar_sh_customer_id: String,
    pub actived: String,
    pub chat_enabled: String,
    #[serde(skip)]
    pub plan_version: String,
}
impl StreamerMetadata {
    pub fn cache_fields(&self) -> Vec<(String, String)> {
        [
            ("name", &self.name),
            ("email", &self.email),
            ("plan_tier", &self.plan_tier),
            ("plan_tier_until", &self.plan_tier_until),
            ("polar_sh_customer_id", &self.polar_sh_customer_id),
            ("actived", &self.actived),
            ("chat_enabled", &self.chat_enabled),
            (PLAN_CACHE_VERSION_FIELD, &self.plan_version),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
    }
}
pub(crate) fn validate_metadata(account: &StreamerMetadata) -> Result<(), DirectoryError> {
    check_id(&account.id)?;
    if !matches!(account.plan_tier.as_str(), "free" | "premium" | "pro")
        || !matches!(account.actived.as_str(), "true" | "false")
        || !matches!(account.chat_enabled.as_str(), "true" | "false")
    {
        return Err(DirectoryError::InvalidData);
    }
    if account
        .cache_fields()
        .iter()
        .any(|(_, v)| v.len() > 16 * 1024)
    {
        return Err(DirectoryError::TooLarge);
    }
    Ok(())
}

/// Privileged source-compatible view. Serialization is explicit; Debug always
/// redacts the entire view, including email and OAuth credentials.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct StreamerAccount {
    #[serde(flatten)]
    pub metadata: StreamerMetadata,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
    pub has_permissions: String,
    pub up_to_date_permissions: String,
}
impl fmt::Debug for StreamerAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StreamerAccount(<redacted>)")
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "Reads are bounded to 64 accounts; inline records avoid a separate allocation per hit"
)]
pub enum CachedStreamer {
    Missing,
    Stale,
    Present(StreamerAccount),
}
/// Exact observed hash is retained solely for destructive eviction CAS.
#[derive(Clone, PartialEq, Eq)]
pub struct DirectorySnapshot {
    pub revision: String,
    pub generation: String,
    pub fields: Vec<(String, String)>,
}
impl fmt::Debug for DirectorySnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DirectorySnapshot(<redacted>)")
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetadataPage {
    pub accounts: Vec<StreamerMetadata>,
    pub next: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdPage {
    pub ids: Vec<String>,
    pub next: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    pub published: usize,
    pub removed: usize,
    pub checked: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrphanSweep {
    pub next: u64,
    pub checked: usize,
    pub removed: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Twitch,
    Kick,
}
impl Platform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Twitch => "twitch",
            Self::Kick => "kick",
        }
    }
}
#[derive(Clone, Debug)]
pub struct CallerContext {
    pub caller: String,
}
impl CallerContext {
    pub fn new(caller: impl Into<String>) -> Self {
        Self {
            caller: caller.into(),
        }
    }
}

pub trait MetadataStore: Send + Sync {
    fn account<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>>;
    /// Opaque continuation token; bounded users/page and bounded accounts/user.
    fn page<'a>(
        &'a self,
        after: Option<&'a str>,
        limit: usize,
    ) -> DirectoryFuture<'a, MetadataPage>;
}
pub trait DirectoryCache: Send + Sync {
    fn revision(&self) -> DirectoryFuture<'_, String>;
    fn observe<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, DirectorySnapshot>;
    fn read_accounts<'a>(&'a self, ids: &'a [String]) -> DirectoryFuture<'a, Vec<CachedStreamer>>;
    /// Metadata only, plan + independent directory CAS, atomic membership update.
    /// Returns new global revision. `id` is only published for complete credentials.
    fn publish<'a>(
        &'a self,
        account: &'a StreamerMetadata,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, String>;
    /// Compares exact hash + both generations, atomically evicts and tombstones.
    fn evict<'a>(
        &'a self,
        id: &'a str,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, bool>;
    fn ids<'a>(&'a self, cursor: u64, count: usize) -> DirectoryFuture<'a, IdPage>;
    /// Bounded SCAN of owned account hashes, including legacy orphan hashes.
    fn hash_ids<'a>(&'a self, cursor: u64, count: usize) -> DirectoryFuture<'a, IdPage>;
    /// ONE final atomic check, including all plan versions and membership revision.
    fn validate<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [(String, String)],
    ) -> DirectoryFuture<'a, bool>;
    /// Validate exact membership, including additions made by credential writers
    /// that intentionally do not mutate the metadata directory revision.
    fn validate_ids<'a>(
        &'a self,
        revision: &'a str,
        ids: &'a [String],
    ) -> DirectoryFuture<'a, bool>;
    /// Also compare the current credential tuple: token revocation/rotation is
    /// independent from metadata generations and must fence privileged lists.
    fn validate_accounts<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [StreamerAccount],
    ) -> DirectoryFuture<'a, bool>;
    fn acquire_lease<'a>(&'a self, owner: &'a str, ttl: Duration) -> DirectoryFuture<'a, bool>;
    fn release_lease<'a>(&'a self, owner: &'a str) -> DirectoryFuture<'a, ()>;
    fn kick_credentials<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, Option<CachedAccount>>;
}
pub trait StreamerCredentials: Send + Sync {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount>;
    fn token<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, AccessToken>;
    /// Credential providers may recover an absent cached refresh secret without
    /// replacing the currently observed access token, expiry or permissions.
    fn refresh_secret<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, String> {
        Box::pin(async move {
            let account = self.snapshot(id).await?;
            if account.refresh_token.is_empty() {
                Err(DirectoryError::Missing)
            } else {
                Ok(account.refresh_token)
            }
        })
    }
}
pub trait StreamerIdentitySink: Send + Sync {
    fn identify<'a>(&'a self, id: &'a str, name: &'a str) -> DirectoryFuture<'a, ()>;
}

#[derive(Clone, Debug)]
pub struct DirectoryConfig {
    pub max_accounts: usize,
    pub page_size: usize,
    pub max_inflight_keys: usize,
    pub operation_timeout: Duration,
    pub reconcile_timeout: Duration,
    pub reconcile_lease: Duration,
}
impl Default for DirectoryConfig {
    fn default() -> Self {
        Self {
            max_accounts: 4096,
            page_size: 64,
            max_inflight_keys: 256,
            operation_timeout: Duration::from_secs(28),
            reconcile_timeout: Duration::from_secs(20),
            reconcile_lease: Duration::from_secs(30),
        }
    }
}
type FlightResult<T> = Shared<BoxFuture<'static, Result<T, DirectoryError>>>;
struct Flight<T: Clone> {
    future: FlightResult<T>,
}
struct Flights<T: Clone> {
    entries: Mutex<HashMap<String, Weak<Flight<T>>>>,
    capacity: usize,
}
impl<T: Clone + Send + Sync + 'static> Flights<T> {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capacity,
        }
    }
    async fn run(
        &self,
        key: String,
        task: impl Future<Output = Result<T, DirectoryError>> + Send + 'static,
    ) -> Result<T, DirectoryError> {
        let flight = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            entries.retain(|_, v| v.strong_count() > 0);
            if let Some(existing) = entries.get(&key).and_then(Weak::upgrade) {
                existing
            } else {
                if entries.len() >= self.capacity {
                    return Err(DirectoryError::Busy);
                }
                let flight = Arc::new(Flight {
                    future: task.boxed().shared(),
                });
                entries.insert(key.clone(), Arc::downgrade(&flight));
                flight
            }
        };
        // Holding the owner through await keeps its weak entry live. Last-waiter
        // cancellation drops the shared future; the next call removes dead keys.
        let result = flight.future.clone().await;
        // Other waiters retain their own shared result. A fresh request must
        // start new work even if an older completed waiter has not polled again.
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if entries
            .get(&key)
            .is_some_and(|entry| Weak::ptr_eq(entry, &Arc::downgrade(&flight)))
        {
            entries.remove(&key);
        }
        result
    }
}
#[derive(Clone)]
pub struct TwitchStreamers {
    inner: Arc<Inner>,
}
struct Inner {
    store: Arc<dyn MetadataStore>,
    cache: Arc<dyn DirectoryCache>,
    credentials: Arc<dyn StreamerCredentials>,
    clock: Arc<dyn TokenClock>,
    config: DirectoryConfig,
    logger: Option<Arc<Logger>>,
    identities: Option<Arc<dyn StreamerIdentitySink>>,
    hydration: Flights<StreamerAccount>,
    tokens: Flights<AccessToken>,
}
impl TwitchStreamers {
    pub fn new(
        store: Arc<dyn MetadataStore>,
        cache: Arc<dyn DirectoryCache>,
        credentials: Arc<dyn StreamerCredentials>,
        clock: Arc<dyn TokenClock>,
        config: DirectoryConfig,
    ) -> Result<Self, DirectoryError> {
        if config.max_accounts == 0
            || config.max_accounts > 4096
            || config.page_size == 0
            || config.page_size > 64
            || config.max_inflight_keys == 0
            || config.max_inflight_keys > 4096
            || config.operation_timeout.is_zero()
            || config.operation_timeout > Duration::from_secs(30)
            || config.reconcile_timeout.is_zero()
            || config.reconcile_timeout >= config.reconcile_lease
            || config.reconcile_lease > Duration::from_secs(60)
        {
            return Err(DirectoryError::InvalidInput);
        }
        let capacity = config.max_inflight_keys;
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                cache,
                credentials,
                clock,
                config,
                logger: None,
                identities: None,
                hydration: Flights::new(capacity),
                tokens: Flights::new(capacity),
            }),
        })
    }
    /// Configure diagnostics before cloning the service.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Result<Self, DirectoryError> {
        Arc::get_mut(&mut self.inner)
            .ok_or(DirectoryError::Busy)?
            .logger = Some(logger);
        Ok(self)
    }
    pub fn with_identities(
        mut self,
        sink: Arc<dyn StreamerIdentitySink>,
    ) -> Result<Self, DirectoryError> {
        Arc::get_mut(&mut self.inner)
            .ok_or(DirectoryError::Busy)?
            .identities = Some(sink);
        Ok(self)
    }
    pub async fn account_by_id(&self, id: &str) -> Result<StreamerAccount, DirectoryError> {
        self.bounded(true, self.account_by_id_inner(id)).await
    }
    async fn account_by_id_inner(&self, id: &str) -> Result<StreamerAccount, DirectoryError> {
        check_id(id)?;
        let mut read = self.inner.cache.read_accounts(&[id.to_owned()]).await?;
        if let Some(CachedStreamer::Present(account)) = read.pop() {
            return Ok(account);
        }
        self.refresh_account(id).await
    }
    pub async fn metadata_by_id(&self, id: &str) -> Result<StreamerMetadata, DirectoryError> {
        Ok(self.account_by_id(id).await?.metadata)
    }
    pub async fn refresh_account(&self, id: &str) -> Result<StreamerAccount, DirectoryError> {
        check_id(id)?;
        let service = self.clone();
        let id_owned = id.to_owned();
        self.inner
            .hydration
            .run(id.to_owned(), async move {
                tokio::time::timeout(
                    service.inner.config.operation_timeout,
                    service.hydrate(&id_owned),
                )
                .await
                .map_err(|_| DirectoryError::DeadlineExceeded {
                    write_outcome_unknown: true,
                })?
            })
            .await
    }
    async fn hydrate(&self, id: &str) -> Result<StreamerAccount, DirectoryError> {
        for _ in 0..2 {
            // Capture BEFORE Mongo so a pending read cannot resurrect a tombstone.
            let observed = self.inner.cache.observe(id).await?;
            let Some(metadata) = self.inner.store.account(id).await? else {
                if self.inner.store.account(id).await?.is_some() {
                    return Err(DirectoryError::Stale);
                }
                self.inner.cache.evict(id, &observed, None).await?;
                return Err(DirectoryError::Missing);
            };
            if metadata.id != id {
                return Err(DirectoryError::InvalidData);
            }
            validate_metadata(&metadata)?;
            // Existing lifecycle does insert-if-absent/CAS; metadata never decrypts.
            self.inner.credentials.snapshot(id).await?;
            match self.inner.cache.publish(&metadata, &observed, None).await {
                Err(DirectoryError::Stale) => continue,
                result => {
                    result?;
                }
            }
            let mut records = self.inner.cache.read_accounts(&[id.to_owned()]).await?;
            match records.pop() {
                Some(CachedStreamer::Present(account)) => {
                    self.identify(&account.metadata).await;
                    return Ok(account);
                }
                Some(CachedStreamer::Stale) => continue,
                Some(CachedStreamer::Missing) => return Err(DirectoryError::Busy),
                None => return Err(DirectoryError::InvalidData),
            }
        }
        Err(DirectoryError::Stale)
    }
    pub async fn streamer_ids(&self) -> Result<Vec<String>, DirectoryError> {
        self.bounded(false, self.streamer_ids_inner()).await
    }
    async fn streamer_ids_inner(&self) -> Result<Vec<String>, DirectoryError> {
        let revision = self.inner.cache.revision().await?;
        let ids = self.collect_ids().await?;
        if !self.inner.cache.validate_ids(&revision, &ids).await? {
            return Err(DirectoryError::Stale);
        }
        Ok(ids)
    }
    async fn collect_ids(&self) -> Result<Vec<String>, DirectoryError> {
        let mut cursor = 0;
        let mut ids = std::collections::BTreeSet::new();
        let mut scans = 0;
        loop {
            scans += 1;
            if scans > self.inner.config.max_accounts.saturating_mul(4) {
                return Err(DirectoryError::TooLarge);
            }
            let page = self
                .inner
                .cache
                .ids(cursor, self.inner.config.page_size)
                .await?;
            if page.ids.len() > self.inner.config.max_accounts {
                return Err(DirectoryError::TooLarge);
            }
            for id in page.ids {
                check_id(&id)?;
                ids.insert(id);
                if ids.len() > self.inner.config.max_accounts {
                    return Err(DirectoryError::TooLarge);
                }
            }
            cursor = page.next;
            if cursor == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        Ok(ids.into_iter().collect())
    }
    pub async fn accounts_from_cache(&self) -> Result<Vec<StreamerAccount>, DirectoryError> {
        self.bounded(false, self.accounts_from_cache_inner()).await
    }
    async fn accounts_from_cache_inner(&self) -> Result<Vec<StreamerAccount>, DirectoryError> {
        let revision = self.inner.cache.revision().await?;
        let ids = self.collect_ids().await?;
        let mut result = Vec::new();
        let mut bytes = 0usize;
        for batch in ids.chunks(MAX_READ_BATCH_ACCOUNTS) {
            let records = self.inner.cache.read_accounts(batch).await?;
            if records.len() != batch.len() {
                return Err(DirectoryError::InvalidData);
            }
            for record in records {
                match record {
                    CachedStreamer::Missing => return Err(DirectoryError::Busy),
                    CachedStreamer::Stale => return Err(DirectoryError::Stale),
                    CachedStreamer::Present(account) => {
                        bytes = bytes.saturating_add(
                            account.access_token.len()
                                + account.refresh_token.len()
                                + account
                                    .metadata
                                    .cache_fields()
                                    .iter()
                                    .map(|(k, v)| k.len() + v.len())
                                    .sum::<usize>(),
                        );
                        if bytes > 4 * 1024 * 1024 {
                            return Err(DirectoryError::TooLarge);
                        }
                        result.push(account);
                    }
                }
            }
            tokio::task::yield_now().await;
        }
        if !self
            .inner
            .cache
            .validate_accounts(&revision, &result)
            .await?
        {
            return Err(DirectoryError::Stale);
        }
        Ok(result)
    }
    pub async fn evict_if_absent(&self, id: &str) -> Result<bool, DirectoryError> {
        self.bounded(true, self.evict_absent(id, None)).await
    }
    async fn evict_absent(&self, id: &str, lease: Option<&str>) -> Result<bool, DirectoryError> {
        check_id(id)?;
        let observed = self.inner.cache.observe(id).await?;
        if self.inner.store.account(id).await?.is_some() {
            return Ok(false);
        }
        // Recheck authoritative absence immediately before the exact-hash CAS.
        if self.inner.store.account(id).await?.is_some() {
            return Err(DirectoryError::Stale);
        }
        self.inner.cache.evict(id, &observed, lease).await
    }
    pub async fn reconcile(&self) -> Result<ReconcileReport, DirectoryError> {
        let owner = uuid::Uuid::new_v4().to_string();
        if !self
            .inner
            .cache
            .acquire_lease(&owner, self.inner.config.reconcile_lease)
            .await?
        {
            return Err(DirectoryError::Busy);
        }
        let mut progress = None;
        let result = tokio::time::timeout(
            self.inner.config.reconcile_timeout,
            self.reconcile_owned(&owner, &mut progress),
        )
        .await
        .map_err(|_| {
            progress.map_or(
                DirectoryError::DeadlineExceeded {
                    write_outcome_unknown: true,
                },
                |cursor| DirectoryError::ReconciliationIncomplete {
                    cursor,
                    published: 0,
                    checked: 0,
                    removed: 0,
                },
            )
        })
        .and_then(|v| v);
        let release = self.inner.cache.release_lease(&owner).await;
        match result {
            Ok(report) => {
                release?;
                self.log(Level::Info, "reconciled", None, None).await;
                Ok(report)
            }
            Err(e) => {
                self.log(Level::Error, "reconcile_failed", None, Some(e))
                    .await;
                Err(e)
            }
        }
    }
    async fn reconcile_owned(
        &self,
        owner: &str,
        progress: &mut Option<u64>,
    ) -> Result<ReconcileReport, DirectoryError> {
        let mut report = ReconcileReport::default();
        let mut after = None;
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > self.inner.config.max_accounts {
                return Err(DirectoryError::TooLarge);
            }
            let mut revision = self.inner.cache.revision().await?;
            let page = self
                .inner
                .store
                .page(after.as_deref(), self.inner.config.page_size)
                .await?;
            for account in page.accounts {
                validate_metadata(&account)?;
                report.checked += 1;
                if report.checked > self.inner.config.max_accounts {
                    return Err(DirectoryError::TooLarge);
                }
                let observed = self.inner.cache.observe(&account.id).await?;
                if observed.revision != revision {
                    return Err(DirectoryError::Stale);
                }
                revision = self
                    .inner
                    .cache
                    .publish(&account, &observed, Some(owner))
                    .await?;
                report.published += 1;
                self.identify(&account).await;
            }
            match page.next {
                Some(next) => {
                    if after.as_ref() == Some(&next) {
                        return Err(DirectoryError::InvalidData);
                    }
                    after = Some(next);
                }
                None => break,
            }
            tokio::task::yield_now().await;
        }
        // Absence is checked per indexed id; no fullscan snapshot authorizes DEL.
        for id in self.collect_ids().await? {
            if self.evict_absent(&id, Some(owner)).await? {
                report.removed += 1;
            }
            tokio::task::yield_now().await;
        }
        let sweep = self.sweep_owned(owner, 0, 64, progress).await?;
        report.removed += sweep.removed;
        if sweep.next != 0 {
            return Err(DirectoryError::ReconciliationIncomplete {
                cursor: sweep.next,
                published: report.published,
                checked: report.checked + sweep.checked,
                removed: report.removed,
            });
        }
        Ok(report)
    }
    /// Continue a bounded orphan-hash pass without repeating Mongo metadata
    /// reload. A nonzero `next` is an explicit continuation, never completion.
    pub async fn sweep_orphan_hashes(
        &self,
        cursor: u64,
        page_budget: usize,
    ) -> Result<OrphanSweep, DirectoryError> {
        if page_budget == 0 || page_budget > 64 {
            return Err(DirectoryError::InvalidInput);
        }
        let owner = uuid::Uuid::new_v4().to_string();
        if !self
            .inner
            .cache
            .acquire_lease(&owner, self.inner.config.reconcile_lease)
            .await?
        {
            return Err(DirectoryError::Busy);
        }
        let mut progress = Some(cursor);
        let result = tokio::time::timeout(
            self.inner.config.reconcile_timeout,
            self.sweep_owned(&owner, cursor, page_budget, &mut progress),
        )
        .await
        .map_err(|_| DirectoryError::ReconciliationIncomplete {
            cursor: progress.unwrap_or(cursor),
            published: 0,
            checked: 0,
            removed: 0,
        })
        .and_then(|v| v);
        let release = self.inner.cache.release_lease(&owner).await;
        match result {
            Ok(sweep) => {
                release?;
                Ok(sweep)
            }
            Err(error) => Err(error),
        }
    }
    async fn sweep_owned(
        &self,
        owner: &str,
        mut cursor: u64,
        page_budget: usize,
        progress: &mut Option<u64>,
    ) -> Result<OrphanSweep, DirectoryError> {
        let mut checked = 0;
        let mut removed = 0;
        for _ in 0..page_budget {
            *progress = Some(cursor);
            let page = self
                .inner
                .cache
                .hash_ids(cursor, self.inner.config.page_size)
                .await?;
            for id in page.ids {
                check_id(&id)?;
                checked += 1;
                if checked > self.inner.config.max_accounts {
                    return Err(DirectoryError::TooLarge);
                }
                if self.evict_absent(&id, Some(owner)).await? {
                    removed += 1;
                }
            }
            cursor = page.next;
            *progress = Some(cursor);
            if cursor == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        Ok(OrphanSweep {
            next: cursor,
            checked,
            removed,
        })
    }
    pub async fn account_token(
        &self,
        id: &str,
        platform: Platform,
        context: &CallerContext,
    ) -> Result<AccessToken, DirectoryError> {
        check_id(id)?;
        if context.caller.len() > 512 {
            return Err(DirectoryError::InvalidInput);
        }
        let service = self.clone();
        let id_owned = id.to_owned();
        let result = self
            .inner
            .tokens
            .run(format!("{}:{id}", platform.as_str()), async move {
                let operation = async {
                    if platform == Platform::Twitch {
                        return service.inner.credentials.token(&id_owned).await;
                    }
                    let account = service
                        .inner
                        .cache
                        .kick_credentials(&id_owned)
                        .await?
                        .ok_or(DirectoryError::Missing)?;
                    if super::twitch_tokens::access_is_usable(
                        &account,
                        service.inner.clock.now_seconds(),
                        300,
                    ) {
                        Ok(AccessToken::user(account.access_token, &id_owned))
                    } else {
                        Err(DirectoryError::UnsupportedRefresh)
                    }
                };
                tokio::time::timeout(service.inner.config.operation_timeout, operation)
                    .await
                    .map_err(|_| DirectoryError::DeadlineExceeded {
                        write_outcome_unknown: true,
                    })?
            })
            .await;
        self.log(
            if result.is_ok() {
                Level::Debug
            } else {
                Level::Error
            },
            if result.is_ok() {
                "token_acquired"
            } else {
                "token_failed"
            },
            Some((id, context)),
            result.as_ref().err().copied(),
        )
        .await;
        result
    }
    pub async fn refresh_token(
        &self,
        id: &str,
        platform: Platform,
    ) -> Result<String, DirectoryError> {
        self.bounded(true, self.refresh_token_inner(id, platform))
            .await
    }
    async fn refresh_token_inner(
        &self,
        id: &str,
        platform: Platform,
    ) -> Result<String, DirectoryError> {
        check_id(id)?;
        if platform == Platform::Twitch {
            return self.inner.credentials.refresh_secret(id).await;
        }
        let account = self
            .inner
            .cache
            .kick_credentials(id)
            .await?
            .ok_or(DirectoryError::Missing)?;
        if account.refresh_token.is_empty() {
            Err(DirectoryError::Missing)
        } else {
            Ok(account.refresh_token)
        }
    }
    async fn identify(&self, metadata: &StreamerMetadata) {
        if let Some(sink) = &self.inner.identities
            && let Err(error) = sink.identify(&metadata.id, &metadata.name).await
        {
            self.log(Level::Warn, "identify_failed", None, Some(error))
                .await;
        }
    }
    async fn bounded<T>(
        &self,
        write: bool,
        operation: impl Future<Output = Result<T, DirectoryError>>,
    ) -> Result<T, DirectoryError> {
        tokio::time::timeout(self.inner.config.operation_timeout, operation)
            .await
            .map_err(|_| DirectoryError::DeadlineExceeded {
                write_outcome_unknown: write,
            })?
    }
    async fn log(
        &self,
        level: Level,
        action: &'static str,
        context: Option<(&str, &CallerContext)>,
        error: Option<DirectoryError>,
    ) {
        if let Some(logger) = &self.inner.logger {
            let (id, caller) = context
                .map(|(id, c)| (Some(id.to_owned()), Some(c.caller.as_str())))
                .unwrap_or((None, None));
            let _=logger.log(level,serde_json::json!({"function":"TwitchStreamers","action":action,"caller":caller,"error":error.map(|e|e.to_string())}),LogOptions {destination:Destination::Cache,platform:Some("twitch".into()),channel_id:id,..Default::default()}).await;
        }
    }
}
pub(crate) fn check_id(id: &str) -> Result<(), DirectoryError> {
    if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        Err(DirectoryError::InvalidInput)
    } else {
        Ok(())
    }
}
