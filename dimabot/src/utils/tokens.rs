//! Explicit, opt-in Twitch credential lifecycle; no production initialization.
//!
//! Contracts: `tokens.ts`, `crypto.ts`, `twitch_streamers.class.ts`, `header.ts`
//! and `users.schema.ts`. OAuth transport/retries are reused from `utils::twitch`.
//! Constructors receive handles, cipher, OAuth client and clock; none reads env.
//!
//! Intentional safety changes: Mongo compares the encrypted refresh envelope on
//! both save and revoke, selectors bind platform+id to the same array element,
//! lock release is atomic compare-delete, and Redis publication compares the
//! observed credential snapshot. Cold hydration is insert-if-absent; a lost
//! comparison rereads current cache state instead of using a stale Mongo result.
//! Native publications and invalidations also compare the directory generation
//! captured before loading Mongo, including when eviction removed the hash.
//! Revocation clears the bot mirror and account-list cache, including an older
//! mirror, only after the account snapshot fence succeeds. Observing an already
//! revoked Mongo record repairs a failed cache invalidation using that same fence.
//! Cache hydration writes credential fields only, preserving metadata. It never
//! writes id into a cold hash: TypeScript must still perform full hydration.
//! A cold cache can reuse a valid persisted access token. Hydration uses the
//! persisted expiry rather than attaching a stale cached expiry to another token.
//! Streamer auth requires permissions (header.ts); bot auth mirrors getBotToken,
//! which has no pre-refresh permission gate. `up_to_date_permissions` is stored
//! but is not a second permission gate in the source.
//!
//! Redis/Mongo are not a transaction. OAuth success followed by persistence
//! failure is explicitly reported, and the unpersisted credential is never used.
//! Cache failure after persistence is distinguished so a retry can hydrate the
//! rotated token. Mixed TypeScript/Rust writers still require a migration review:
//! TypeScript does not participate in these CAS writes, and its 5s lease can
//! expire during an OAuth request. An opt-in longer native lease and refresh
//! budget do not make mixed writers participate in that coordination. No worker,
//! logger, debug-cache or refresh-all path is installed here. Numeric expiry
//! outside JS safe-integer magnitude is
//! rejected explicitly instead of reproducing scientific-notation parseInt quirks.

#[path = "tokens/adapters.rs"]
mod adapters;
pub use adapters::{MongoCredentialStore, RedisTokenCache};

use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use super::{
    credential_crypto::{CredentialCipher, CredentialCryptoError, StoredCredential, hex},
    twitch::{
        AccessToken, OAuthFailure, OAuthTokens, RefreshFailureKind, RefreshPolicy,
        TWITCH_BOT_ACCOUNT_ID, TokenFuture, TokenSource, TokenSourceError, TwitchAuth,
        TwitchOAuthClient,
    },
};

pub const REFRESH_LOCK_TTL_MS: u64 = 5000;
pub const REFRESH_WAIT_POLL_MS: u64 = 150;
pub const REFRESH_WAIT_TIMEOUT_MS: u64 = 4500;
pub const REFRESH_WAIT_POLLS: usize = 30;
pub const ACCESS_EXPIRY_SKEW_SECONDS: i64 = 300;
pub const WAITER_EXPIRY_SKEW_SECONDS: i64 = 60;

/// Shared with the directory adapter; its tombstone survives account hash DEL.
pub(crate) fn directory_generation_key(id: &str) -> String {
    format!("streamers:directory:generation:{id}")
}

pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Fixed categories only: never include driver errors, bodies or secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenStorageError {
    Missing,
    PermissionsDenied,
    IdentityMismatch,
    StoreUnavailable,
    CacheUnavailable,
    Crypto(CredentialCryptoError),
    RefreshTransient,
    Revoked,
    RefreshBusy,
    /// The refresh budget expired; OAuth or persistence may already have acted.
    RefreshOutcomeUnknown,
    InvalidRefreshGuard,
    RotatedTokenUnusable,
    PersistenceAfterOAuth,
    CacheAfterPersistence,
    InvalidExpiry,
}
impl fmt::Display for TokenStorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Twitch credential operation failed ({self:?})")
    }
}
impl std::error::Error for TokenStorageError {}
impl From<CredentialCryptoError> for TokenStorageError {
    fn from(error: CredentialCryptoError) -> Self {
        Self::Crypto(error)
    }
}

#[derive(Clone)]
pub struct StoredAccount {
    pub id: String,
    pub access_token: Option<StoredCredential>,
    pub refresh_token: Option<StoredCredential>,
    pub expires_at: Option<f64>,
    pub has_permissions: bool,
    pub up_to_date_permissions: bool,
}
impl fmt::Debug for StoredAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredAccount(<redacted>)")
    }
}

#[derive(Clone, Default, PartialEq)]
pub struct CachedAccount {
    pub id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
    pub has_permissions: bool,
    pub up_to_date_permissions: bool,
}
impl fmt::Debug for CachedAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CachedAccount(<redacted>)")
    }
}

pub trait CredentialStore: Send + Sync {
    fn load<'a>(
        &'a self,
        id: &'a str,
    ) -> StorageFuture<'a, Result<Option<StoredAccount>, TokenStorageError>>;
    /// Compare the encrypted refresh envelope, not a re-encryption of its secret.
    /// False means missing account or a concurrent writer; never upsert.
    fn replace<'a>(
        &'a self,
        expected: &'a StoredAccount,
        replacement: &'a StoredAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>>;
}

pub trait TokenCache: Send + Sync {
    fn account<'a>(
        &'a self,
        id: &'a str,
    ) -> StorageFuture<'a, Result<Option<CachedAccount>, TokenStorageError>>;
    /// None preserves adapters without native directory-generation support.
    /// Some("") is a supported, presently absent generation and must be fenced.
    /// Adapters returning Some must implement both fenced mutations atomically.
    fn fence<'a>(
        &'a self,
        _id: &'a str,
    ) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>> {
        Box::pin(async { Ok(None) })
    }
    /// Compare the complete observed credential state. None requires all
    /// credential fields to remain absent, including permission flags. Preserve
    /// metadata and never add an id marker to an otherwise partial shared hash.
    fn put_account<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>>;
    fn put_account_fenced<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
        _fence: Option<&'a str>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        self.put_account(account, expected)
    }
    /// Atomically clear only an unchanged/absent credential snapshot, revoke
    /// permission flags, invalidate the aggregate and remove any bot mirror.
    fn invalidate<'a>(
        &'a self,
        expected: &'a CachedAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>>;
    fn invalidate_fenced<'a>(
        &'a self,
        expected: &'a CachedAccount,
        _fence: Option<&'a str>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        self.invalidate(expected)
    }
    fn acquire<'a>(
        &'a self,
        id: &'a str,
        owner: &'a str,
        ttl_ms: u64,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>>;
    fn held<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Result<bool, TokenStorageError>>;
    fn release<'a>(
        &'a self,
        id: &'a str,
        owner: &'a str,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>>;
    fn app<'a>(&'a self) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>>;
    fn put_app<'a>(
        &'a self,
        token: &'a str,
        ttl_seconds: u64,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>>;
    /// Publish only if the bot account's current access token still matches.
    /// A stale publication is a successful no-op; no streamer permission gate.
    fn put_bot<'a>(&'a self, token: &'a str) -> StorageFuture<'a, Result<(), TokenStorageError>>;
}

pub trait TokenClock: Send + Sync {
    fn now_seconds(&self) -> i64;
    /// Monotonic time for lease waiting, separate from wall-clock token expiry.
    fn monotonic_millis(&self) -> u64;
    fn sleep(&self, duration: Duration) -> StorageFuture<'_, ()>;
}
pub struct SystemTokenClock {
    origin: Instant,
}
impl Default for SystemTokenClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}
impl TokenClock for SystemTokenClock {
    fn now_seconds(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }
    fn monotonic_millis(&self) -> u64 {
        self.origin.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn sleep(&self, duration: Duration) -> StorageFuture<'_, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// Test seam; the real implementation delegates every network operation to the
/// existing OAuth client, including its 400/900ms transient retry policy.
pub trait OAuthExchange: Send + Sync {
    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
        id: &'a str,
        policy: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>>;
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>>;
}
impl OAuthExchange for TwitchOAuthClient {
    fn refresh<'a>(
        &'a self,
        token: &'a str,
        id: &'a str,
        policy: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(TwitchOAuthClient::refresh(self, token, id, policy))
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(TwitchOAuthClient::app_token(self))
    }
}

pub struct TwitchTokenStorage {
    store: Arc<dyn CredentialStore>,
    cache: Arc<dyn TokenCache>,
    oauth: Arc<dyn OAuthExchange>,
    clock: Arc<dyn TokenClock>,
    cipher: CredentialCipher,
    refresh_policy: RefreshPolicy,
    refresh_lease_ms: u64,
    refresh_budget: Option<Duration>,
}
impl TwitchTokenStorage {
    pub fn new(
        store: Arc<dyn CredentialStore>,
        cache: Arc<dyn TokenCache>,
        oauth: Arc<dyn OAuthExchange>,
        clock: Arc<dyn TokenClock>,
        cipher: CredentialCipher,
    ) -> Self {
        Self {
            store,
            cache,
            oauth,
            clock,
            cipher,
            refresh_policy: RefreshPolicy::default(),
            refresh_lease_ms: REFRESH_LOCK_TTL_MS,
            refresh_budget: None,
        }
    }
    pub fn with_refresh_policy(mut self, policy: RefreshPolicy) -> Self {
        self.refresh_policy = policy;
        self
    }

    /// Bound work under the native refresh lease, leaving at least one second
    /// for release and scheduling. Existing callers keep the source's 5s lease
    /// and unbounded refresh behavior unless they opt in. No lease renewal task
    /// is spawned: cancellation leaves the owner lease to expire naturally.
    pub fn with_refresh_guard(
        mut self,
        lease: Duration,
        budget: Duration,
    ) -> Result<Self, TokenStorageError> {
        let millis = |duration: Duration| {
            if duration.is_zero() || !duration.subsec_nanos().is_multiple_of(1_000_000) {
                return Err(TokenStorageError::InvalidRefreshGuard);
            }
            u64::try_from(duration.as_millis()).map_err(|_| TokenStorageError::InvalidRefreshGuard)
        };
        let lease_ms = millis(lease)?;
        millis(budget)?;
        let guarded = budget
            .checked_add(Duration::from_secs(1))
            .ok_or(TokenStorageError::InvalidRefreshGuard)?;
        let now = Instant::now();
        if guarded > lease || now.checked_add(lease).is_none() || now.checked_add(budget).is_none()
        {
            return Err(TokenStorageError::InvalidRefreshGuard);
        }
        self.refresh_lease_ms = lease_ms;
        self.refresh_budget = Some(budget);
        Ok(self)
    }

    /// Read or CAS-hydrate credentials without refreshing or checking scopes.
    /// A partial shared cache tuple is returned as observed: replacing it from
    /// Mongo could overwrite a concurrent TypeScript writer or revocation.
    pub async fn account_snapshot(&self, id: &str) -> Result<CachedAccount, TokenStorageError> {
        let account = self.cached_or_hydrate(id).await?;
        Self::check_account(&account, id, false)?;
        Ok(account)
    }

    /// Missing refresh fields use Mongo without replacing an existing partial
    /// credential tuple. A cold account still uses the guarded hydration path.
    /// Recheck the current cache after Mongo: a winning current secret is safe
    /// to reuse, while a changed partial state or deletion must be retried.
    pub async fn refresh_secret(&self, id: &str) -> Result<String, TokenStorageError> {
        let observed = match self.cache.account(id).await? {
            Some(account) => account,
            None => self.account_snapshot(id).await?,
        };
        Self::check_account(&observed, id, false)?;
        if !observed.refresh_token.is_empty() {
            return Ok(observed.refresh_token);
        }
        if Self::revocation_tombstone(&observed) {
            return Err(TokenStorageError::Revoked);
        }
        let fence = self.cache.fence(id).await?;
        let authoritative = self.authoritative(id).await;
        let current = self.cache.account(id).await?;
        if let Some(account) = &current {
            Self::check_account(account, id, false)?;
            if !account.refresh_token.is_empty() {
                return Ok(account.refresh_token.clone());
            }
            if Self::revocation_tombstone(account) {
                return Err(TokenStorageError::Revoked);
            }
        }
        if current.as_ref() != Some(&observed) || self.cache.fence(id).await? != fence {
            return Err(TokenStorageError::CacheUnavailable);
        }
        let (_, account) = authoritative?;
        if account.refresh_token.is_empty() {
            return Err(TokenStorageError::Missing);
        }
        Ok(account.refresh_token)
    }

    fn revocation_tombstone(account: &CachedAccount) -> bool {
        account.access_token.is_empty()
            && account.refresh_token.is_empty()
            && account.expires_at.is_empty()
            && !account.has_permissions
            && !account.up_to_date_permissions
    }

    /// Class-level getAccountTokenById behavior; header construction applies
    /// its own streamer permission gate. This never publishes the bot mirror.
    pub async fn acquire_account_token(&self, id: &str) -> Result<AccessToken, TokenStorageError> {
        self.account_token(id, false).await
    }

    /// Publish an already acquired bot credential without repeating acquisition.
    /// The cache adapter retains its compare-before-publish protection.
    pub async fn publish_bot_token(&self, token: &AccessToken) -> Result<(), TokenStorageError> {
        super::twitch::build_headers("identity-check", token, &TwitchAuth::Bot)
            .map_err(|_| TokenStorageError::IdentityMismatch)?;
        self.cache.put_bot(token.expose_secret()).await
    }

    pub async fn acquire_token(&self, auth: &TwitchAuth) -> Result<AccessToken, TokenStorageError> {
        if *auth == TwitchAuth::App {
            return self.app_token().await;
        }
        let id = auth.user_id().ok_or(TokenStorageError::IdentityMismatch)?;
        let gate_permissions = matches!(auth, TwitchAuth::Streamer(_));
        let token = self.account_token(id, gate_permissions).await?;
        if matches!(auth, TwitchAuth::Bot) {
            self.publish_bot_token(&token).await?;
        }
        Ok(token)
    }

    async fn account_token(&self, id: &str, gate: bool) -> Result<AccessToken, TokenStorageError> {
        let account = self.cached_or_hydrate(id).await?;
        Self::check_account(&account, id, gate)?;
        let token = if access_is_usable(
            &account,
            self.clock.now_seconds(),
            ACCESS_EXPIRY_SKEW_SECONDS,
        ) {
            account.access_token
        } else {
            self.smart_refresh(id, gate).await?
        };
        Ok(AccessToken::user(token, id))
    }

    async fn app_token(&self) -> Result<AccessToken, TokenStorageError> {
        if let Some(token) = self.cache.app().await?.filter(|value| !value.is_empty()) {
            return Ok(AccessToken::app(token));
        }
        let tokens = self
            .oauth
            .app_token()
            .await
            .map_err(|_| TokenStorageError::RefreshTransient)?;
        let ttl = tokens.expires_in;
        // Redis EX accepts integral positive TTLs; never publish an immortal app token.
        if !ttl.is_finite() || ttl <= 0.0 || ttl.fract() != 0.0 || ttl > 9_007_199_254_740_991.0 {
            return Err(TokenStorageError::InvalidExpiry);
        }
        super::twitch::build_headers("identity-check", &tokens.access_token, &TwitchAuth::App)
            .map_err(|_| TokenStorageError::IdentityMismatch)?;
        self.cache
            .put_app(tokens.access_token.expose_secret(), ttl as u64)
            .await?;
        Ok(tokens.access_token)
    }

    fn check_account(
        account: &CachedAccount,
        id: &str,
        gate: bool,
    ) -> Result<(), TokenStorageError> {
        if account.id != id {
            return Err(TokenStorageError::IdentityMismatch);
        }
        if gate && !account.has_permissions {
            return Err(TokenStorageError::PermissionsDenied);
        }
        Ok(())
    }
    fn decode(&self, account: &StoredAccount) -> Result<CachedAccount, TokenStorageError> {
        Ok(CachedAccount {
            id: account.id.clone(),
            access_token: self
                .cipher
                .decrypt(account.access_token.as_ref())?
                .unwrap_or_default(),
            refresh_token: self
                .cipher
                .decrypt(account.refresh_token.as_ref())?
                .unwrap_or_default(),
            expires_at: account
                .expires_at
                .map(|value| value.to_string())
                .unwrap_or_default(),
            has_permissions: account.has_permissions,
            up_to_date_permissions: account.up_to_date_permissions,
        })
    }
    async fn authoritative(
        &self,
        id: &str,
    ) -> Result<(StoredAccount, CachedAccount), TokenStorageError> {
        let stored = self
            .store
            .load(id)
            .await?
            .ok_or(TokenStorageError::Missing)?;
        if stored.id != id {
            return Err(TokenStorageError::IdentityMismatch);
        }
        let cached = self.decode(&stored)?;
        Ok((stored, cached))
    }
    async fn cached_or_hydrate(&self, id: &str) -> Result<CachedAccount, TokenStorageError> {
        if let Some(account) = self.cache.account(id).await? {
            return Ok(account);
        }
        let fence = self.cache.fence(id).await?;
        let (_, account) = self.authoritative(id).await?;
        if self
            .repair_revoked(&account, None, fence.as_deref())
            .await?
        {
            return self
                .cache
                .account(id)
                .await?
                .ok_or(TokenStorageError::CacheUnavailable);
        }
        Ok(self
            .publish_or_current(&account, None, fence.as_deref())
            .await?
            .0)
    }

    async fn publish_or_current(
        &self,
        account: &CachedAccount,
        expected: Option<&CachedAccount>,
        fence: Option<&str>,
    ) -> Result<(CachedAccount, bool), TokenStorageError> {
        if self
            .cache
            .put_account_fenced(account, expected, fence)
            .await?
        {
            return Ok((account.clone(), true));
        }
        // A newer publication or tombstone won. Never return the stale decoded
        // Mongo snapshot after a lost comparison, even if it looked usable.
        let current = self
            .cache
            .account(&account.id)
            .await?
            .ok_or(TokenStorageError::CacheUnavailable)?;
        Ok((current, false))
    }

    async fn repair_revoked(
        &self,
        authoritative: &CachedAccount,
        observed: Option<&CachedAccount>,
        fence: Option<&str>,
    ) -> Result<bool, TokenStorageError> {
        if authoritative.has_permissions
            || !authoritative.access_token.is_empty()
            || !authoritative.refresh_token.is_empty()
        {
            return Ok(false);
        }
        // The snapshot must be captured BEFORE loading Mongo. Rereading here
        // could mistake a concurrently reauthorized cache for the stale state.
        self.cache
            .invalidate_fenced(observed.unwrap_or(authoritative), fence)
            .await?;
        Ok(true)
    }

    async fn smart_refresh(&self, id: &str, gate: bool) -> Result<String, TokenStorageError> {
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy).map_err(|_| CredentialCryptoError::EntropyUnavailable)?;
        let owner = hex(&entropy);
        if !self
            .cache
            .acquire(id, &owner, self.refresh_lease_ms)
            .await?
        {
            // 4.5s bounded wait, 150ms polling, then one takeover, as in TS.
            // Check elapsed time before each iteration, including Redis RTTs;
            // the last in-flight iteration may overshoot, as with TS's deadline.
            let deadline = self
                .clock
                .monotonic_millis()
                .saturating_add(REFRESH_WAIT_TIMEOUT_MS);
            for _ in 0..REFRESH_WAIT_POLLS {
                if self.clock.monotonic_millis() >= deadline {
                    break;
                }
                self.clock
                    .sleep(Duration::from_millis(REFRESH_WAIT_POLL_MS))
                    .await;
                if let Some(account) = self.cache.account(id).await? {
                    Self::check_account(&account, id, gate)?;
                    if access_is_usable(
                        &account,
                        self.clock.now_seconds(),
                        WAITER_EXPIRY_SKEW_SECONDS,
                    ) {
                        return Ok(account.access_token);
                    }
                }
                if !self.cache.held(id).await? {
                    break;
                }
            }
            if !self
                .cache
                .acquire(id, &owner, self.refresh_lease_ms)
                .await?
            {
                return Err(TokenStorageError::RefreshBusy);
            }
        }
        let result = match self.refresh_budget {
            Some(budget) => tokio::time::timeout(budget, self.refresh_under_lock(id, gate))
                .await
                .unwrap_or(Err(TokenStorageError::RefreshOutcomeUnknown)),
            None => self.refresh_under_lock(id, gate).await,
        };
        // A failed release leaves a bounded TTL; it must not hide persisted success.
        let _ = self.cache.release(id, &owner).await;
        result
    }

    async fn refresh_under_lock(&self, id: &str, gate: bool) -> Result<String, TokenStorageError> {
        let observed = self.cache.account(id).await?;
        if let Some(account) = &observed {
            Self::check_account(account, id, gate)?;
            if access_is_usable(
                account,
                self.clock.now_seconds(),
                ACCESS_EXPIRY_SKEW_SECONDS,
            ) {
                return Ok(account.access_token.clone());
            }
        }
        // Mongo is authoritative: a cache failure after a previous rotation must
        // not cause reuse of the consumed refresh token from stale cache data.
        let fence = self.cache.fence(id).await?;
        let (stored, account) = self.authoritative(id).await?;
        if self
            .repair_revoked(&account, observed.as_ref(), fence.as_deref())
            .await?
        {
            return Err(if gate {
                TokenStorageError::PermissionsDenied
            } else {
                TokenStorageError::Revoked
            });
        }
        Self::check_account(&account, id, gate)?;
        if access_is_usable(
            &account,
            self.clock.now_seconds(),
            ACCESS_EXPIRY_SKEW_SECONDS,
        ) {
            let (current, _) = self
                .publish_or_current(&account, observed.as_ref(), fence.as_deref())
                .await?;
            Self::check_account(&current, id, gate)?;
            if !access_is_usable(
                &current,
                self.clock.now_seconds(),
                WAITER_EXPIRY_SKEW_SECONDS,
            ) {
                return Err(TokenStorageError::RotatedTokenUnusable);
            }
            return Ok(current.access_token);
        }
        if account.refresh_token.is_empty() {
            return Err(TokenStorageError::Missing);
        }
        let tokens = match self
            .oauth
            .refresh(&account.refresh_token, id, &self.refresh_policy)
            .await
        {
            Ok(tokens) => tokens,
            Err(failure) if failure.kind == RefreshFailureKind::Permanent => {
                return self
                    .permanent_failure(&stored, &account, observed.as_ref(), gate, fence.as_deref())
                    .await;
            }
            Err(_) => return Err(TokenStorageError::RefreshTransient),
        };
        super::twitch::build_headers(
            "identity-check",
            &tokens.access_token,
            &TwitchAuth::Streamer(id.to_owned()),
        )
        .map_err(|_| TokenStorageError::IdentityMismatch)?;
        let refresh = tokens
            .refresh_token
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(TokenStorageError::RefreshTransient)?;
        let expires_at = self.clock.now_seconds() as f64 + tokens.expires_in;
        if !expires_at.is_finite() || expires_at.abs() > 9_007_199_254_740_991.0 {
            return Err(TokenStorageError::InvalidExpiry);
        }
        let replacement = StoredAccount {
            id: id.to_owned(),
            access_token: Some(self.cipher.encrypt(tokens.access_token.expose_secret())?),
            refresh_token: Some(self.cipher.encrypt(refresh)?),
            expires_at: Some(expires_at),
            has_permissions: true,
            up_to_date_permissions: true,
        };
        if !self
            .store
            .replace(&stored, &replacement)
            .await
            .map_err(|_| TokenStorageError::PersistenceAfterOAuth)?
        {
            return self
                .reuse_rotated(id, &account.refresh_token, gate)
                .await
                .map_err(|error| match error {
                    TokenStorageError::Missing | TokenStorageError::StoreUnavailable => {
                        TokenStorageError::PersistenceAfterOAuth
                    }
                    other => other,
                });
        }
        let cached = self.decode(&replacement)?;
        let (current, published) = self
            .publish_or_current(&cached, observed.as_ref(), fence.as_deref())
            .await
            .map_err(|_| TokenStorageError::CacheAfterPersistence)?;
        Self::check_account(&current, id, gate)?;
        if !published
            && !access_is_usable(
                &current,
                self.clock.now_seconds(),
                WAITER_EXPIRY_SKEW_SECONDS,
            )
        {
            return Err(TokenStorageError::RotatedTokenUnusable);
        }
        Ok(current.access_token)
    }

    async fn permanent_failure(
        &self,
        stored: &StoredAccount,
        account: &CachedAccount,
        observed: Option<&CachedAccount>,
        gate: bool,
        fence: Option<&str>,
    ) -> Result<String, TokenStorageError> {
        let (latest, cached) = self.authoritative(&stored.id).await?;
        if self.repair_revoked(&cached, observed, fence).await? {
            return Err(TokenStorageError::Revoked);
        }
        if !cached.refresh_token.is_empty() && cached.refresh_token != account.refresh_token {
            return self
                .reuse_rotated(&stored.id, &account.refresh_token, gate)
                .await;
        }
        // A changed ciphertext is a concurrent write even if the plaintext is the
        // same. Do not overwrite it using a stale Mongo snapshot.
        if latest.refresh_token != stored.refresh_token {
            return Err(TokenStorageError::RotatedTokenUnusable);
        }
        let revoked = StoredAccount {
            id: stored.id.clone(),
            access_token: Some(StoredCredential::default()),
            refresh_token: Some(StoredCredential::default()),
            expires_at: None,
            has_permissions: false,
            up_to_date_permissions: false,
        };
        if !self.store.replace(stored, &revoked).await? {
            return self
                .reuse_rotated(&stored.id, &account.refresh_token, gate)
                .await;
        }
        self.cache
            .invalidate_fenced(observed.unwrap_or(account), fence)
            .await?;
        Err(TokenStorageError::Revoked)
    }

    async fn reuse_rotated(
        &self,
        id: &str,
        old_refresh: &str,
        gate: bool,
    ) -> Result<String, TokenStorageError> {
        let observed = self.cache.account(id).await?;
        let fence = self.cache.fence(id).await?;
        let (_, current) = self.authoritative(id).await?;
        if self
            .repair_revoked(&current, observed.as_ref(), fence.as_deref())
            .await?
        {
            return Err(if gate {
                TokenStorageError::PermissionsDenied
            } else {
                TokenStorageError::Revoked
            });
        }
        Self::check_account(&current, id, gate)?;
        if current.refresh_token.is_empty()
            || current.refresh_token == old_refresh
            || !access_is_usable(
                &current,
                self.clock.now_seconds(),
                WAITER_EXPIRY_SKEW_SECONDS,
            )
        {
            return Err(TokenStorageError::RotatedTokenUnusable);
        }
        let (current, _) = self
            .publish_or_current(&current, observed.as_ref(), fence.as_deref())
            .await?;
        Self::check_account(&current, id, gate)?;
        if current.refresh_token.is_empty()
            || current.refresh_token == old_refresh
            || !access_is_usable(
                &current,
                self.clock.now_seconds(),
                WAITER_EXPIRY_SKEW_SECONDS,
            )
        {
            return Err(TokenStorageError::RotatedTokenUnusable);
        }
        Ok(current.access_token)
    }
}

impl TokenSource for TwitchTokenStorage {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a> {
        Box::pin(async move {
            self.acquire_token(auth).await.map_err(|error| match error {
                TokenStorageError::Missing => TokenSourceError::Missing,
                TokenStorageError::PermissionsDenied | TokenStorageError::Revoked => {
                    TokenSourceError::PermissionsDenied
                }
                TokenStorageError::IdentityMismatch => TokenSourceError::IdentityMismatch,
                _ => TokenSourceError::Unavailable,
            })
        })
    }
}

/// Source's Number.parseInt(raw, 10), including prefixes, followed by finite
/// expiry check. Strict `<` preserves the 300s/60s boundary and missing expiry
/// always refreshes. Account hashes deliberately have no key TTL in TypeScript.
pub fn access_is_usable(account: &CachedAccount, now: i64, skew_seconds: i64) -> bool {
    if account.access_token.is_empty() {
        return false;
    }
    let text = super::js_compat::trim(&account.expires_at);
    let digits = text
        .strip_prefix('+')
        .or_else(|| text.strip_prefix('-'))
        .unwrap_or(text)
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if digits == 0 {
        return false;
    }
    let sign = usize::from(text.starts_with('+') || text.starts_with('-'));
    let expiry = text[..sign + digits].parse::<f64>().unwrap_or(f64::NAN);
    expiry.is_finite() && (now as f64) < expiry - skew_seconds as f64
}
