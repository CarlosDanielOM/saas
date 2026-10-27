#![cfg(feature = "twitch-tokens")]

use dima_rust::utils::{
    credential_crypto::CredentialCipher,
    twitch::{AccessToken, OAuthFailure, OAuthTokens, RefreshPolicy, TwitchAuth},
    twitch_tokens::{
        CachedAccount, CredentialStore, OAuthExchange, StorageFuture, StoredAccount, TokenCache,
        TokenClock, TokenStorageError, TwitchTokenStorage,
    },
};
use std::{
    collections::VecDeque,
    future::{Future, pending},
    sync::{Arc, Mutex},
    time::Duration,
};

struct State {
    stored: StoredAccount,
    cached: Option<CachedAccount>,
    loads: usize,
    writes: usize,
    exchanges: usize,
    mirrors: usize,
    leases: Vec<u64>,
    acquire_results: VecDeque<bool>,
    owner: Option<String>,
    releases: usize,
    hang_after_oauth: bool,
    publish_race: Option<CachedAccount>,
}
#[derive(Clone)]
struct Fixture(Arc<Mutex<State>>);
impl Fixture {
    fn new(expiry: f64, permissions: bool) -> Self {
        let cipher = cipher();
        Self(Arc::new(Mutex::new(State {
            stored: StoredAccount {
                id: "user".into(),
                access_token: Some(cipher.encrypt("stored-access").unwrap()),
                refresh_token: Some(cipher.encrypt("stored-refresh").unwrap()),
                expires_at: Some(expiry),
                has_permissions: permissions,
                up_to_date_permissions: false,
            },
            cached: None,
            loads: 0,
            writes: 0,
            exchanges: 0,
            mirrors: 0,
            leases: Vec::new(),
            acquire_results: VecDeque::new(),
            owner: None,
            releases: 0,
            hang_after_oauth: false,
            publish_race: None,
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
}
fn cipher() -> CredentialCipher {
    CredentialCipher::new("streamer-token-fixture").unwrap()
}
impl CredentialStore for Fixture {
    fn load<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<StoredAccount>, TokenStorageError>> {
        Box::pin(async {
            let mut state = self.0.lock().unwrap();
            state.loads += 1;
            Ok(Some(state.stored.clone()))
        })
    }
    fn replace<'a>(
        &'a self,
        expected: &'a StoredAccount,
        replacement: &'a StoredAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let hang = self.0.lock().unwrap().hang_after_oauth;
            if hang {
                // Model a write accepted remotely while its response never
                // arrives. The caller cannot infer whether it committed.
                self.0.lock().unwrap().stored = replacement.clone();
                return pending().await;
            }
            let mut state = self.0.lock().unwrap();
            if state.stored.refresh_token != expected.refresh_token {
                return Ok(false);
            }
            state.stored = replacement.clone();
            state.writes += 1;
            Ok(true)
        })
    }
}
impl TokenCache for Fixture {
    fn account<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<CachedAccount>, TokenStorageError>> {
        Box::pin(async { Ok(self.0.lock().unwrap().cached.clone()) })
    }
    fn put_account<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if let Some(current) = state.publish_race.take() {
                state.cached = Some(current);
            }
            if state.cached.as_ref() != expected {
                return Ok(false);
            }
            state.cached = Some(account.clone());
            Ok(true)
        })
    }
    fn invalidate<'a>(
        &'a self,
        _: &'a CachedAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async { panic!("fixture must not revoke") })
    }
    fn acquire<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
        ttl_ms: u64,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            state.leases.push(ttl_ms);
            let acquired = state.acquire_results.pop_front().unwrap_or(true);
            if acquired {
                state.owner = Some(owner.into());
            }
            Ok(acquired)
        })
    }
    fn held<'a>(&'a self, _: &'a str) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async { Ok(false) })
    }
    fn release<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            state.releases += 1;
            assert_eq!(state.owner.as_deref(), Some(owner));
            state.owner = None;
            Ok(())
        })
    }
    fn app(&self) -> StorageFuture<'_, Result<Option<String>, TokenStorageError>> {
        Box::pin(async { panic!("account path must not use app auth") })
    }
    fn put_app<'a>(
        &'a self,
        _: &'a str,
        _: u64,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async { panic!("account path must not publish app auth") })
    }
    fn put_bot<'a>(&'a self, _: &'a str) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async {
            self.0.lock().unwrap().mirrors += 1;
            Ok(())
        })
    }
}
impl TokenClock for Fixture {
    fn now_seconds(&self) -> i64 {
        1000
    }
    fn monotonic_millis(&self) -> u64 {
        0
    }
    fn sleep(&self, _: Duration) -> StorageFuture<'_, ()> {
        Box::pin(async {})
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
            assert_eq!(refresh, "stored-refresh");
            self.0.lock().unwrap().exchanges += 1;
            Ok(OAuthTokens {
                access_token: AccessToken::user("refreshed-access", id),
                refresh_token: Some("refreshed-refresh".into()),
                expires_in: 3600.0,
            })
        })
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async { panic!("account path must not exchange app auth") })
    }
}

#[tokio::test]
async fn snapshots_reuse_cold_credentials_without_permission_gate_or_refresh() {
    for expiry in [900.0, 4600.0] {
        let fixture = Fixture::new(expiry, false);
        let snapshot = fixture.manager().account_snapshot("user").await.unwrap();
        assert_eq!(snapshot.access_token, "stored-access");
        assert_eq!(snapshot.refresh_token, "stored-refresh");
        assert_eq!(snapshot.expires_at, expiry.to_string());
        assert!(!snapshot.has_permissions);
        let state = fixture.0.lock().unwrap();
        assert_eq!(state.loads, 1);
        assert_eq!(state.exchanges, 0);
        assert!(state.leases.is_empty());
        assert_eq!(state.writes, 0);
    }
}

#[tokio::test]
async fn snapshot_preserves_partial_tuple_and_rejects_wrong_identity() {
    let fixture = Fixture::new(4600.0, true);
    let partial = CachedAccount {
        id: "user".into(),
        has_permissions: true,
        ..Default::default()
    };
    fixture.0.lock().unwrap().cached = Some(partial.clone());
    assert_eq!(
        fixture.manager().account_snapshot("user").await.unwrap(),
        partial
    );
    assert_eq!(fixture.0.lock().unwrap().loads, 0);
    fixture.0.lock().unwrap().cached.as_mut().unwrap().id = "other".into();
    assert_eq!(
        fixture
            .manager()
            .account_snapshot("user")
            .await
            .unwrap_err(),
        TokenStorageError::IdentityMismatch
    );
    assert_eq!(
        fixture
            .manager()
            .acquire_account_token("user")
            .await
            .unwrap_err(),
        TokenStorageError::IdentityMismatch
    );
    fixture.0.lock().unwrap().cached = None;
    fixture.0.lock().unwrap().stored.id = "other".into();
    assert_eq!(
        fixture
            .manager()
            .account_snapshot("user")
            .await
            .unwrap_err(),
        TokenStorageError::IdentityMismatch
    );
}

#[tokio::test]
async fn cold_snapshot_losing_cas_returns_current_cache_instead_of_stale_store() {
    let fixture = Fixture::new(4600.0, true);
    let current = CachedAccount {
        id: "user".into(),
        access_token: "concurrent-access".into(),
        ..Default::default()
    };
    fixture.0.lock().unwrap().publish_race = Some(current.clone());
    assert_eq!(
        fixture.manager().account_snapshot("user").await.unwrap(),
        current
    );
    assert_eq!(fixture.0.lock().unwrap().exchanges, 0);
}

#[tokio::test]
async fn class_account_tokens_skip_header_gate_and_never_mirror_bot_tokens() {
    for (expiry, expected, exchanges) in
        [(4600.0, "stored-access", 0), (900.0, "refreshed-access", 1)]
    {
        let fixture = Fixture::new(expiry, false);
        let manager = fixture.manager();
        assert_eq!(
            manager
                .acquire_token(&TwitchAuth::Streamer("user".into()))
                .await
                .unwrap_err(),
            TokenStorageError::PermissionsDenied
        );
        assert_eq!(fixture.0.lock().unwrap().exchanges, 0);
        assert_eq!(
            manager
                .acquire_account_token("user")
                .await
                .unwrap()
                .expose_secret(),
            expected
        );
        let state = fixture.0.lock().unwrap();
        assert_eq!(state.exchanges, exchanges);
        assert_eq!(state.mirrors, 0);
    }
}

#[tokio::test]
async fn guarded_refresh_uses_selected_lease_on_first_acquisition_and_takeover() {
    for takeover in [false, true] {
        let fixture = Fixture::new(900.0, true);
        if takeover {
            fixture.0.lock().unwrap().acquire_results = VecDeque::from([false, true]);
        }
        let manager = fixture
            .manager()
            .with_refresh_guard(Duration::from_secs(30), Duration::from_secs(25))
            .unwrap();
        assert_eq!(
            manager
                .acquire_account_token("user")
                .await
                .unwrap()
                .expose_secret(),
            "refreshed-access"
        );
        let state = fixture.0.lock().unwrap();
        assert_eq!(state.leases, vec![30_000; if takeover { 2 } else { 1 }]);
        assert_eq!(state.releases, 1);
    }
    let fixture = Fixture::new(900.0, true);
    fixture
        .manager()
        .acquire_account_token("user")
        .await
        .unwrap();
    assert_eq!(fixture.0.lock().unwrap().leases, vec![5000]);
}

#[tokio::test]
async fn budget_expiry_after_oauth_and_remote_write_reports_unknown_and_releases_owner() {
    let fixture = Fixture::new(900.0, true);
    fixture.0.lock().unwrap().hang_after_oauth = true;
    let manager = fixture
        .manager()
        .with_refresh_guard(Duration::from_secs(2), Duration::from_millis(10))
        .unwrap();
    assert_eq!(
        manager.acquire_account_token("user").await.unwrap_err(),
        TokenStorageError::RefreshOutcomeUnknown
    );
    let state = fixture.0.lock().unwrap();
    assert_eq!(
        state.exchanges, 1,
        "do not retry an indeterminate operation"
    );
    assert_eq!(state.releases, 1);
    assert!(state.owner.is_none());
    assert_eq!(state.cached.as_ref().unwrap().access_token, "stored-access");
    assert_eq!(
        cipher()
            .decrypt(state.stored.access_token.as_ref())
            .unwrap()
            .as_deref(),
        Some("refreshed-access")
    );
}

#[tokio::test]
async fn cancelling_guarded_refresh_leaves_lease_for_expiry_without_background_work() {
    let fixture = Fixture::new(900.0, true);
    fixture.0.lock().unwrap().hang_after_oauth = true;
    let manager = fixture
        .manager()
        .with_refresh_guard(Duration::from_secs(30), Duration::from_secs(25))
        .unwrap();
    let mut operation = Box::pin(manager.acquire_account_token("user"));
    std::future::poll_fn(|cx| {
        assert!(operation.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(operation);
    let state = fixture.0.lock().unwrap();
    assert_eq!(state.exchanges, 1);
    assert_eq!(state.releases, 0);
    assert!(
        state.owner.is_some(),
        "a cancelled caller relies on the bounded Redis lease"
    );
    assert_eq!(state.leases, vec![30_000]);
}

#[test]
fn refresh_guard_rejects_nonintegral_zero_overflow_and_insufficient_margin() {
    let fixture = Fixture::new(4600.0, true);
    let second = Duration::from_secs(1);
    for (lease, budget) in [
        (Duration::ZERO, second),
        (second, Duration::ZERO),
        (Duration::from_nanos(2_000_000_001), second),
        (Duration::from_secs(2), Duration::from_nanos(1)),
        (second, second),
        (Duration::from_millis(1999), second),
        (Duration::MAX, second),
        (Duration::MAX, Duration::MAX),
        (Duration::from_secs(u64::MAX), second),
    ] {
        assert!(matches!(
            fixture.manager().with_refresh_guard(lease, budget),
            Err(TokenStorageError::InvalidRefreshGuard)
        ));
    }
    assert!(
        fixture
            .manager()
            .with_refresh_guard(Duration::from_secs(2), second)
            .is_ok()
    );
}
