#![cfg(feature = "twitch-tokens")]

use dima_rust::utils::{
    credential_crypto::CredentialCipher,
    twitch::{
        AccessToken, OAuthFailure, OAuthTokens, RefreshFailureKind, RefreshPolicy,
        TWITCH_BOT_ACCOUNT_ID, TokenSource, TokenSourceError, TwitchAuth, build_headers,
    },
    twitch_tokens::*,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Barrier;

#[path = "../src/utils/test_http.rs"]
mod test_http;

#[derive(Default)]
struct State {
    stored: Option<StoredAccount>,
    cached: Option<CachedAccount>,
    app: Option<(String, i64)>,
    bot: String,
    now_ms: i64,
    cache_read_ms: i64,
    lease: Option<String>,
    acquire_script: VecDeque<bool>,
    held_script: VecDeque<bool>,
    sleeps: Vec<u64>,
    oauth_results: VecDeque<Result<OAuthTokens, OAuthFailure>>,
    exchanges: usize,
    app_exchanges: usize,
    store_writes: usize,
    cache_writes: usize,
    acquisitions: usize,
    releases: usize,
    invalidations: usize,
    store_failure: bool,
    cache_failure: bool,
    delete_during_oauth: bool,
    rotate_during_oauth: Option<(StoredAccount, CachedAccount)>,
    rotate_before_replace: Option<(StoredAccount, CachedAccount)>,
    publish_on_sleep: Option<CachedAccount>,
    publish_on_acquire: Option<CachedAccount>,
    load_barriers: Option<(Arc<Barrier>, Arc<Barrier>)>,
    invalidation_failures: usize,
    aggregate: bool,
    rotate_before_invalidate: Option<(StoredAccount, CachedAccount)>,
}
#[derive(Clone)]
struct Fixture(Arc<Mutex<State>>);
impl Fixture {
    fn new(id: &str) -> Self {
        let account = account(id, "old-access", "old-refresh", 1000.0, true);
        Self(Arc::new(Mutex::new(State {
            cached: Some(decode(&account)),
            stored: Some(account),
            now_ms: 1_000_000,
            ..Default::default()
        })))
    }
    fn manager(&self) -> TwitchTokenStorage {
        TwitchTokenStorage::new(
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            cipher(),
        )
    }
    fn success(&self, id: &str, ttl: f64) {
        self.0
            .lock()
            .unwrap()
            .oauth_results
            .push_back(Ok(OAuthTokens {
                access_token: AccessToken::user("new-access", id),
                refresh_token: Some("new-refresh".into()),
                expires_in: ttl,
            }));
    }
    fn failure(&self, kind: RefreshFailureKind) {
        self.0
            .lock()
            .unwrap()
            .oauth_results
            .push_back(Err(OAuthFailure {
                kind,
                status: Some(400),
                message: "provider-canary-never-exposed".into(),
                attempts: 1,
            }));
    }
}
fn cipher() -> CredentialCipher {
    CredentialCipher::new("fixture").unwrap()
}
fn account(id: &str, access: &str, refresh: &str, expiry: f64, permissions: bool) -> StoredAccount {
    StoredAccount {
        id: id.into(),
        access_token: Some(cipher().encrypt_with_iv(access, [1; 16]).unwrap()),
        refresh_token: Some(cipher().encrypt_with_iv(refresh, [2; 16]).unwrap()),
        expires_at: Some(expiry),
        has_permissions: permissions,
        up_to_date_permissions: false,
    }
}
fn decode(account: &StoredAccount) -> CachedAccount {
    CachedAccount {
        id: account.id.clone(),
        access_token: cipher()
            .decrypt(account.access_token.as_ref())
            .unwrap()
            .unwrap_or_default(),
        refresh_token: cipher()
            .decrypt(account.refresh_token.as_ref())
            .unwrap()
            .unwrap_or_default(),
        expires_at: account
            .expires_at
            .map(|v| v.to_string())
            .unwrap_or_default(),
        has_permissions: account.has_permissions,
        up_to_date_permissions: account.up_to_date_permissions,
    }
}
fn auth() -> TwitchAuth {
    TwitchAuth::Streamer("user".into())
}
fn revoked(stored: &StoredAccount) -> StoredAccount {
    StoredAccount {
        access_token: Some(Default::default()),
        refresh_token: Some(Default::default()),
        expires_at: None,
        has_permissions: false,
        up_to_date_permissions: false,
        ..stored.clone()
    }
}
impl CredentialStore for Fixture {
    fn load<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<StoredAccount>, TokenStorageError>> {
        Box::pin(async {
            let (snapshot, barriers) = {
                let mut s = self.0.lock().unwrap();
                (s.stored.clone(), s.load_barriers.take())
            };
            if let Some((captured, resume)) = barriers {
                captured.wait().await;
                resume.wait().await;
            }
            Ok(snapshot)
        })
    }
    fn replace<'a>(
        &'a self,
        expected: &'a StoredAccount,
        replacement: &'a StoredAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            if s.store_failure {
                return Err(TokenStorageError::StoreUnavailable);
            }
            if let Some((stored, cached)) = s.rotate_before_replace.take() {
                s.stored = Some(stored);
                s.cached = Some(cached);
            }
            if s.stored.as_ref().map(|v| (&v.id, &v.refresh_token))
                != Some((&expected.id, &expected.refresh_token))
            {
                return Ok(false);
            }
            s.stored = Some(replacement.clone());
            s.store_writes += 1;
            Ok(true)
        })
    }
}
impl TokenCache for Fixture {
    fn account<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<CachedAccount>, TokenStorageError>> {
        Box::pin(async {
            let mut s = self.0.lock().unwrap();
            let latency = s.cache_read_ms;
            s.now_ms += latency;
            Ok(s.cached.clone())
        })
    }
    fn put_account<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            if s.cache_failure {
                return Err(TokenStorageError::CacheUnavailable);
            }
            if s.cached.as_ref() != expected {
                return Ok(false);
            }
            s.cached = Some(account.clone());
            s.cache_writes += 1;
            Ok(true)
        })
    }
    fn invalidate<'a>(
        &'a self,
        expected: &'a CachedAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            if s.invalidation_failures > 0 {
                s.invalidation_failures -= 1;
                return Err(TokenStorageError::CacheUnavailable);
            }
            if let Some((stored, cached)) = s.rotate_before_invalidate.take() {
                s.stored = Some(stored);
                s.bot = cached.access_token.clone();
                s.cached = Some(cached);
                s.aggregate = true;
            }
            if s.cached.as_ref().is_some_and(|v| v != expected) {
                return Ok(false);
            }
            s.cached = Some(CachedAccount {
                id: expected.id.clone(),
                ..Default::default()
            });
            if expected.id == TWITCH_BOT_ACCOUNT_ID {
                s.bot.clear();
            }
            s.aggregate = false;
            s.invalidations += 1;
            Ok(true)
        })
    }
    fn acquire<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
        ttl: u64,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            assert_eq!(ttl, 5000);
            let mut s = self.0.lock().unwrap();
            s.acquisitions += 1;
            let acquire = s.acquire_script.pop_front().unwrap_or(s.lease.is_none());
            if acquire {
                s.lease = Some(owner.into());
                if let Some(account) = s.publish_on_acquire.take() {
                    s.cached = Some(account);
                }
            }
            Ok(acquire)
        })
    }
    fn held<'a>(&'a self, _: &'a str) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async {
            let mut s = self.0.lock().unwrap();
            Ok(s.held_script.pop_front().unwrap_or(s.lease.is_some()))
        })
    }
    fn release<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            s.releases += 1;
            if s.lease.as_deref() == Some(owner) {
                s.lease = None;
            }
            Ok(())
        })
    }
    fn app<'a>(&'a self) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>> {
        Box::pin(async {
            let s = self.0.lock().unwrap();
            Ok(s.app
                .as_ref()
                .filter(|(_, expiry)| *expiry > s.now_ms)
                .map(|(token, _)| token.clone()))
        })
    }
    fn put_app<'a>(
        &'a self,
        token: &'a str,
        ttl: u64,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            let expiry = s.now_ms + ttl as i64 * 1000;
            s.app = Some((token.into(), expiry));
            Ok(())
        })
    }
    fn put_bot<'a>(&'a self, token: &'a str) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            if !token.is_empty()
                && s.cached.as_ref().is_some_and(|account| {
                    account.id == TWITCH_BOT_ACCOUNT_ID && account.access_token == token
                })
            {
                s.bot = token.into();
            }
            Ok(())
        })
    }
}
impl TokenClock for Fixture {
    fn now_seconds(&self) -> i64 {
        self.0.lock().unwrap().now_ms / 1000
    }
    fn monotonic_millis(&self) -> u64 {
        self.0.lock().unwrap().now_ms as u64
    }
    fn sleep(&self, duration: Duration) -> StorageFuture<'_, ()> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            s.sleeps.push(duration.as_millis() as u64);
            s.now_ms += duration.as_millis() as i64;
            if let Some(account) = s.publish_on_sleep.take() {
                s.cached = Some(account);
            }
        })
    }
}
impl OAuthExchange for Fixture {
    fn refresh<'a>(
        &'a self,
        refresh: &'a str,
        id: &'a str,
        _: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async move {
            assert_eq!(refresh, "old-refresh");
            assert!(id == "user" || id == TWITCH_BOT_ACCOUNT_ID);
            let mut s = self.0.lock().unwrap();
            s.exchanges += 1;
            if s.delete_during_oauth {
                s.stored = None;
            }
            if let Some((stored, cached)) = s.rotate_during_oauth.take() {
                s.stored = Some(stored);
                s.cached = Some(cached);
            }
            s.oauth_results
                .pop_front()
                .expect("scripted OAuth response required")
        })
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async {
            let mut s = self.0.lock().unwrap();
            s.app_exchanges += 1;
            s.oauth_results
                .pop_front()
                .expect("scripted app response required")
        })
    }
}

#[tokio::test]
async fn success_encrypts_before_publication_and_reuses_cache_without_oauth() {
    let fixture = Fixture::new("user");
    fixture.success("user", 3600.0);
    let manager = fixture.manager();
    assert_eq!(
        manager
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "new-access"
    );
    assert_eq!(
        manager
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "new-access"
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.exchanges, 1);
    assert_eq!(s.store_writes, 1);
    assert_eq!(s.releases, 1);
    let saved = s.stored.as_ref().unwrap();
    assert_eq!(saved.expires_at, Some(4600.0));
    assert!(saved.has_permissions && saved.up_to_date_permissions);
    assert_eq!(decode(saved).refresh_token, "new-refresh");
    assert!(
        !saved
            .access_token
            .as_ref()
            .unwrap()
            .content
            .as_ref()
            .unwrap()
            .contains("new-access")
    );
}

#[tokio::test]
async fn cold_cache_reuses_persisted_token_with_its_own_expiry_intentional_extension() {
    let fixture = Fixture::new("user");
    {
        let mut s = fixture.0.lock().unwrap();
        s.cached = None;
        s.stored.as_mut().unwrap().expires_at = Some(1400.0);
    }
    assert_eq!(
        fixture
            .manager()
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "old-access"
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.exchanges, 0);
    assert_eq!(s.cached.as_ref().unwrap().expires_at, "1400");
}

#[tokio::test]
async fn paused_cold_hydration_cannot_resurrect_a_completed_revocation() {
    let fixture = Fixture::new("user");
    let captured = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    {
        let mut s = fixture.0.lock().unwrap();
        s.cached = None;
        s.stored.as_mut().unwrap().expires_at = Some(4600.0);
        s.load_barriers = Some((captured.clone(), resume.clone()));
    }
    let manager = fixture.manager();
    let request = tokio::spawn(async move { manager.acquire_token(&auth()).await });
    tokio::time::timeout(Duration::from_secs(2), captured.wait())
        .await
        .unwrap();
    let original = fixture.0.lock().unwrap().stored.clone().unwrap();
    assert!(
        fixture
            .replace(&original, &revoked(&original))
            .await
            .unwrap()
    );
    assert!(fixture.invalidate(&decode(&original)).await.unwrap());
    resume.wait().await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
            .err(),
        Some(TokenStorageError::PermissionsDenied)
    );
    let s = fixture.0.lock().unwrap();
    let cached = s.cached.as_ref().unwrap();
    assert!(!cached.has_permissions && !cached.up_to_date_permissions);
    assert!(cached.access_token.is_empty() && cached.refresh_token.is_empty());
    assert_eq!(s.cache_writes, 0);
    assert_eq!(s.exchanges, 0);
}

#[tokio::test]
async fn paused_authoritative_cache_recovery_cannot_overwrite_a_later_revocation() {
    let fixture = Fixture::new("user");
    let captured = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    {
        let mut s = fixture.0.lock().unwrap();
        // Mongo committed a rotation whose Redis publication failed. The cache
        // still holds the old expired snapshot, so this request tries recovery.
        s.stored = Some(account(
            "user",
            "recovered-access",
            "recovered-refresh",
            4600.0,
            true,
        ));
        s.load_barriers = Some((captured.clone(), resume.clone()));
    }
    let manager = fixture.manager();
    let request = tokio::spawn(async move { manager.acquire_token(&auth()).await });
    tokio::time::timeout(Duration::from_secs(2), captured.wait())
        .await
        .unwrap();
    let (stored, cached) = {
        let s = fixture.0.lock().unwrap();
        (s.stored.clone().unwrap(), s.cached.clone().unwrap())
    };
    assert!(fixture.replace(&stored, &revoked(&stored)).await.unwrap());
    assert!(fixture.invalidate(&cached).await.unwrap());
    resume.wait().await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
            .err(),
        Some(TokenStorageError::PermissionsDenied)
    );
    let s = fixture.0.lock().unwrap();
    let cached = s.cached.as_ref().unwrap();
    assert!(
        !cached.has_permissions
            && cached.access_token.is_empty()
            && cached.refresh_token.is_empty()
    );
    assert_eq!(s.cache_writes, 0);
    assert_eq!(s.exchanges, 0);
}

#[tokio::test]
async fn failed_revocation_cache_write_is_repaired_on_retry_without_another_exchange() {
    let fixture = Fixture::new(TWITCH_BOT_ACCOUNT_ID);
    fixture.failure(RefreshFailureKind::Permanent);
    {
        let mut s = fixture.0.lock().unwrap();
        s.invalidation_failures = 1;
        s.bot = "older-mirror-access".into();
        s.aggregate = true;
    }
    let manager = fixture.manager();
    // Streamer(bot) leaves a bot mirror from an earlier getBotToken call.
    let streamer_bot = TwitchAuth::Streamer(TWITCH_BOT_ACCOUNT_ID.into());
    assert_eq!(
        manager.acquire_token(&streamer_bot).await.err(),
        Some(TokenStorageError::CacheUnavailable)
    );
    {
        let s = fixture.0.lock().unwrap();
        assert!(!s.stored.as_ref().unwrap().has_permissions);
        assert!(s.cached.as_ref().unwrap().has_permissions);
        assert!(s.aggregate);
        assert!(!s.bot.is_empty());
    }
    assert_eq!(
        manager.acquire_token(&streamer_bot).await.err(),
        Some(TokenStorageError::PermissionsDenied)
    );
    let s = fixture.0.lock().unwrap();
    let cached = s.cached.as_ref().unwrap();
    assert!(
        !cached.has_permissions
            && cached.access_token.is_empty()
            && cached.refresh_token.is_empty()
    );
    assert!(s.bot.is_empty());
    assert!(!s.aggregate);
    assert_eq!(s.exchanges, 1);
    assert_eq!(s.invalidations, 1);
}

#[tokio::test]
async fn revoked_state_repair_does_not_clear_a_newer_publication_or_bot_mirror() {
    let fixture = Fixture::new(TWITCH_BOT_ACCOUNT_ID);
    fixture.failure(RefreshFailureKind::Permanent);
    fixture.0.lock().unwrap().invalidation_failures = 1;
    let manager = fixture.manager();
    let streamer_bot = TwitchAuth::Streamer(TWITCH_BOT_ACCOUNT_ID.into());
    assert_eq!(
        manager.acquire_token(&streamer_bot).await.err(),
        Some(TokenStorageError::CacheUnavailable)
    );
    let winner = account(
        TWITCH_BOT_ACCOUNT_ID,
        "winner-access",
        "winner-refresh",
        4600.0,
        true,
    );
    fixture.0.lock().unwrap().rotate_before_invalidate = Some((winner.clone(), decode(&winner)));
    assert_eq!(
        manager.acquire_token(&streamer_bot).await.err(),
        Some(TokenStorageError::PermissionsDenied)
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.cached.as_ref().unwrap().refresh_token, "winner-refresh");
    assert_eq!(s.bot, "winner-access");
    assert!(s.aggregate);
    assert_eq!(s.invalidations, 0);
}

#[tokio::test]
async fn transient_and_missing_refresh_do_not_revoke_permissions() {
    for missing in [false, true] {
        let fixture = Fixture::new("user");
        fixture.failure(RefreshFailureKind::Transient);
        if missing {
            fixture
                .0
                .lock()
                .unwrap()
                .stored
                .as_mut()
                .unwrap()
                .refresh_token = None;
        }
        assert_eq!(
            fixture.manager().acquire_token(&auth()).await.err(),
            Some(if missing {
                TokenStorageError::Missing
            } else {
                TokenStorageError::RefreshTransient
            })
        );
        let s = fixture.0.lock().unwrap();
        assert_eq!(s.invalidations, 0);
        assert_eq!(s.store_writes, 0);
        assert_eq!(s.releases, 1);
    }
}

#[tokio::test]
async fn permanent_failure_revokes_both_permissions_and_stored_and_cached_tokens() {
    let fixture = Fixture::new("user");
    fixture.failure(RefreshFailureKind::Permanent);
    assert_eq!(
        fixture.manager().acquire_token(&auth()).await.err(),
        Some(TokenStorageError::Revoked)
    );
    let s = fixture.0.lock().unwrap();
    let stored = s.stored.as_ref().unwrap();
    assert!(!stored.has_permissions && !stored.up_to_date_permissions);
    assert_eq!(stored.expires_at, None);
    assert_eq!(stored.access_token.as_ref().unwrap().iv, None);
    assert_eq!(stored.refresh_token.as_ref().unwrap().content, None);
    assert!(s.cached.as_ref().unwrap().access_token.is_empty());
    assert_eq!(s.invalidations, 1);
}

#[tokio::test]
async fn rotated_token_protection_covers_usable_expired_and_cas_race() {
    for (expires, during_replace) in [(4600.0, false), (1050.0, false), (4600.0, true)] {
        let fixture = Fixture::new("user");
        fixture.failure(RefreshFailureKind::Permanent);
        let winner = account("user", "winner-access", "winner-refresh", expires, true);
        {
            let mut s = fixture.0.lock().unwrap();
            if during_replace {
                s.rotate_before_replace = Some((winner.clone(), decode(&winner)));
            } else {
                s.rotate_during_oauth = Some((winner.clone(), decode(&winner)));
            }
        }
        let result = fixture.manager().acquire_token(&auth()).await;
        if expires > 1060.0 {
            assert_eq!(result.unwrap().expose_secret(), "winner-access");
        } else {
            assert_eq!(result.err(), Some(TokenStorageError::RotatedTokenUnusable));
        }
        let s = fixture.0.lock().unwrap();
        assert_eq!(s.invalidations, 0);
        assert_eq!(s.store_writes, 0);
        assert_eq!(
            decode(s.stored.as_ref().unwrap()).refresh_token,
            "winner-refresh"
        );
    }
}

#[tokio::test]
async fn success_cas_race_reuses_already_persisted_winner_and_never_overwrites_it() {
    let fixture = Fixture::new("user");
    fixture.success("user", 3600.0);
    let winner = account("user", "winner-access", "winner-refresh", 4600.0, true);
    fixture.0.lock().unwrap().rotate_before_replace = Some((winner.clone(), decode(&winner)));
    assert_eq!(
        fixture
            .manager()
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "winner-access"
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.store_writes, 0);
    assert_eq!(s.cached.as_ref().unwrap().refresh_token, "winner-refresh");
}

#[tokio::test]
async fn lease_winner_double_checks_cache_before_consuming_a_refresh_token() {
    let fixture = Fixture::new("user");
    fixture.0.lock().unwrap().publish_on_acquire = Some(decode(&account(
        "user",
        "winner-access",
        "winner-refresh",
        4600.0,
        true,
    )));
    assert_eq!(
        fixture
            .manager()
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "winner-access"
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.exchanges, 0);
    assert_eq!(s.acquisitions, 1);
    assert_eq!(s.releases, 1);
}

#[tokio::test]
async fn oauth_success_then_store_failure_returns_no_unpersisted_credential() {
    let fixture = Fixture::new("user");
    fixture.success("user", 3600.0);
    fixture.0.lock().unwrap().store_failure = true;
    let error = fixture.manager().acquire_token(&auth()).await.unwrap_err();
    assert_eq!(error, TokenStorageError::PersistenceAfterOAuth);
    assert!(!format!("{error:?} {error}").contains("new-access"));
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.cached.as_ref().unwrap().refresh_token, "old-refresh");
    assert_eq!(s.cache_writes, 0);
    assert_eq!(s.releases, 1);
}

#[tokio::test]
async fn cache_failure_after_persistence_recovers_from_mongo_without_reusing_consumed_token() {
    let fixture = Fixture::new("user");
    fixture.success("user", 3600.0);
    fixture.0.lock().unwrap().cache_failure = true;
    let manager = fixture.manager();
    assert_eq!(
        manager.acquire_token(&auth()).await.err(),
        Some(TokenStorageError::CacheAfterPersistence)
    );
    fixture.0.lock().unwrap().cache_failure = false;
    assert_eq!(
        manager
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "new-access"
    );
    assert_eq!(fixture.0.lock().unwrap().exchanges, 1);
}

#[tokio::test]
async fn waiter_accepts_60_second_skew_then_single_takeover_or_busy_after_4500ms() {
    let fixture = Fixture::new("user");
    {
        let mut s = fixture.0.lock().unwrap();
        s.acquire_script.push_back(false);
        s.publish_on_sleep = Some(decode(&account(
            "user",
            "winner-access",
            "winner-refresh",
            1100.0,
            true,
        )));
    }
    assert_eq!(
        fixture
            .manager()
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "winner-access"
    );
    {
        let s = fixture.0.lock().unwrap();
        assert_eq!(s.sleeps, vec![150]);
        assert_eq!(s.acquisitions, 1);
        assert_eq!(s.exchanges, 0);
    }
    for held in [false, true] {
        let fixture = Fixture::new("user");
        {
            let mut s = fixture.0.lock().unwrap();
            s.acquire_script = [false, !held].into();
            s.held_script = vec![held; 30].into();
        }
        if !held {
            fixture.success("user", 3600.0);
        }
        let result = fixture.manager().acquire_token(&auth()).await;
        if held {
            assert_eq!(result.err(), Some(TokenStorageError::RefreshBusy));
        } else {
            assert_eq!(result.unwrap().expose_secret(), "new-access");
        }
        let s = fixture.0.lock().unwrap();
        assert_eq!(s.acquisitions, 2);
        assert_eq!(s.sleeps.len(), if held { 30 } else { 1 });
    }
}

#[tokio::test]
async fn slow_cache_rtt_counts_toward_wait_deadline_with_only_final_iteration_overshoot() {
    let fixture = Fixture::new("user");
    {
        let mut s = fixture.0.lock().unwrap();
        s.cache_read_ms = 1100;
        s.acquire_script = [false, false].into();
        s.held_script = vec![true; 30].into();
    }
    assert_eq!(
        fixture.manager().acquire_token(&auth()).await.err(),
        Some(TokenStorageError::RefreshBusy)
    );
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.sleeps, vec![150; 4]);
    assert_eq!(s.acquisitions, 2);
    // Initial cache read 1100ms occurs before waiting. Four 1250ms iterations
    // cross the 4500ms deadline; a fifth iteration must never begin.
    assert_eq!(s.now_ms, 1_006_100);
    assert_eq!(s.exchanges, 0);
}

#[tokio::test]
async fn streamer_permission_gate_bot_identity_and_app_ttl_are_distinct() {
    let fixture = Fixture::new("user");
    fixture
        .0
        .lock()
        .unwrap()
        .cached
        .as_mut()
        .unwrap()
        .has_permissions = false;
    assert_eq!(
        fixture.manager().token(&auth()).await.err(),
        Some(TokenSourceError::PermissionsDenied)
    );
    assert_eq!(fixture.0.lock().unwrap().exchanges, 0);
    let fixture = Fixture::new(TWITCH_BOT_ACCOUNT_ID);
    {
        let mut s = fixture.0.lock().unwrap();
        s.cached.as_mut().unwrap().has_permissions = false;
        s.stored.as_mut().unwrap().has_permissions = false;
    }
    fixture.success(TWITCH_BOT_ACCOUNT_ID, 3600.0);
    let token = fixture.manager().token(&TwitchAuth::Bot).await.unwrap();
    assert!(build_headers("fixture", &token, &TwitchAuth::Bot).is_ok());
    assert!(build_headers("fixture", &token, &auth()).is_err());
    assert_eq!(fixture.0.lock().unwrap().bot, "new-access");
    let fixture = Fixture::new("user");
    {
        let mut s = fixture.0.lock().unwrap();
        for value in ["app-one", "app-two"] {
            s.oauth_results.push_back(Ok(OAuthTokens {
                access_token: AccessToken::app(value),
                refresh_token: None,
                expires_in: 2.0,
            }));
        }
    }
    let manager = fixture.manager();
    assert_eq!(
        manager
            .token(&TwitchAuth::App)
            .await
            .unwrap()
            .expose_secret(),
        "app-one"
    );
    assert_eq!(
        manager
            .token(&TwitchAuth::App)
            .await
            .unwrap()
            .expose_secret(),
        "app-one"
    );
    fixture.0.lock().unwrap().now_ms += 2000;
    assert_eq!(
        manager
            .token(&TwitchAuth::App)
            .await
            .unwrap()
            .expose_secret(),
        "app-two"
    );
    assert_eq!(fixture.0.lock().unwrap().app_exchanges, 2);
}

#[tokio::test]
async fn rejects_identity_poisoning_and_invalid_app_ttls_without_publishing() {
    let fixture = Fixture::new("user");
    fixture.0.lock().unwrap().cached.as_mut().unwrap().id = "other".into();
    assert_eq!(
        fixture.manager().acquire_token(&auth()).await.err(),
        Some(TokenStorageError::IdentityMismatch)
    );
    for ttl in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
        let fixture = Fixture::new("user");
        fixture
            .0
            .lock()
            .unwrap()
            .oauth_results
            .push_back(Ok(OAuthTokens {
                access_token: AccessToken::app("app"),
                refresh_token: None,
                expires_in: ttl,
            }));
        assert_eq!(
            fixture
                .manager()
                .acquire_token(&TwitchAuth::App)
                .await
                .err(),
            Some(TokenStorageError::InvalidExpiry)
        );
        assert!(fixture.0.lock().unwrap().app.is_none());
    }
}

#[tokio::test]
async fn source_refresh_traces_match_observable_success_revocation_and_failure_categories() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/token_storage_parity.json")).unwrap();
    for case in corpus["refreshCases"].as_array().unwrap() {
        let scenario = case["scenario"].as_str().unwrap();
        let fixture = Fixture::new("user");
        match scenario {
            "success" => fixture.success("user", 3600.0),
            "default_expiry" => fixture.success("user", 7200.0),
            "permanent" | "rotated_usable" | "rotated_expired" => {
                fixture.failure(RefreshFailureKind::Permanent)
            }
            "transient" | "incomplete" => fixture.failure(RefreshFailureKind::Transient),
            "store_failure" => {
                fixture.success("user", 3600.0);
                fixture.0.lock().unwrap().store_failure = true;
            }
            "missing_user" => {
                fixture.success("user", 3600.0);
                fixture.0.lock().unwrap().delete_during_oauth = true;
            }
            _ => panic!("unrecognized source scenario"),
        }
        if scenario.starts_with("rotated") {
            let winner = account(
                "user",
                "winner-access",
                "winner-refresh",
                if scenario == "rotated_usable" {
                    4600.0
                } else {
                    1050.0
                },
                true,
            );
            fixture.0.lock().unwrap().rotate_during_oauth = Some((winner.clone(), decode(&winner)));
        }
        let result = fixture.manager().acquire_token(&auth()).await;
        if scenario == "missing_user" {
            assert_eq!(
                result.as_ref().err().copied(),
                Some(TokenStorageError::PersistenceAfterOAuth)
            );
        }
        match case["result"]["kind"].as_str().unwrap() {
            "success" => {
                assert_eq!(
                    result.unwrap().expose_secret(),
                    case["result"]["token"].as_str().unwrap()
                );
                assert_eq!(
                    fixture
                        .0
                        .lock()
                        .unwrap()
                        .cached
                        .as_ref()
                        .unwrap()
                        .refresh_token,
                    case["result"]["refreshToken"].as_str().unwrap()
                );
            }
            "permanent_failure" => assert_eq!(result.err(), Some(TokenStorageError::Revoked)),
            "transient_failure" => assert!(matches!(
                result.err(),
                Some(
                    TokenStorageError::RefreshTransient
                        | TokenStorageError::RotatedTokenUnusable
                        | TokenStorageError::PersistenceAfterOAuth
                )
            )),
            _ => panic!("unrecognized source outcome"),
        }
    }
}

#[tokio::test]
async fn account_refresh_preserves_zero_negative_and_fractional_numeric_expiry_like_source() {
    for ttl in [0.0, -1.0, 0.5, 3600.25] {
        let fixture = Fixture::new("user");
        fixture.success("user", ttl);
        assert_eq!(
            fixture
                .manager()
                .acquire_token(&auth())
                .await
                .unwrap()
                .expose_secret(),
            "new-access"
        );
        let s = fixture.0.lock().unwrap();
        assert_eq!(s.stored.as_ref().unwrap().expires_at, Some(1000.0 + ttl));
    }
}

#[tokio::test]
async fn existing_oauth_transport_retries_then_persists_and_publishes_integration() {
    use dima_rust::utils::twitch::{TwitchCredentials, TwitchEndpoints, TwitchOAuthClient};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use test_http::{CannedResponse, Recorder};
    let attempts = AtomicUsize::new(0);
    let recorder = Recorder::start(move |_| {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            CannedResponse::json(503, r#"{"message":"busy"}"#)
        } else {
            CannedResponse::json(
                200,
                r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":"3600"}"#,
            )
        }
    });
    let endpoints = TwitchEndpoints::new(
        &format!("{}/helix/", recorder.base_url),
        &format!("{}/oauth2/", recorder.base_url),
    )
    .unwrap();
    let oauth = TwitchOAuthClient::new(
        TwitchCredentials::new("fixture-id", "fixture-secret").unwrap(),
        endpoints,
        Some(Duration::from_secs(2)),
    )
    .unwrap();
    let fixture = Fixture::new("user");
    let manager = TwitchTokenStorage::new(
        Arc::new(fixture.clone()),
        Arc::new(fixture.clone()),
        Arc::new(oauth),
        Arc::new(fixture.clone()),
        cipher(),
    )
    .with_refresh_policy(RefreshPolicy::from_millis(&[0]));
    assert_eq!(
        manager
            .acquire_token(&auth())
            .await
            .unwrap()
            .expose_secret(),
        "new-access"
    );
    for _ in 0..2 {
        let request = recorder.next(Duration::from_secs(1));
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/oauth2/token");
        assert!(
            String::from_utf8(request.body)
                .unwrap()
                .contains("refresh_token=old-refresh")
        );
    }
    // Source defaults a string expires_in to 7200, through the reused transport.
    let s = fixture.0.lock().unwrap();
    assert_eq!(s.stored.as_ref().unwrap().expires_at, Some(8200.0));
    assert_eq!(s.cache_writes, 1);
    assert_eq!(s.store_writes, 1);
}
