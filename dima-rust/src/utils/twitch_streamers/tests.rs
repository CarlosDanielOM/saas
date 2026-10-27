use super::*;
use mongodb::bson::{self, DateTime, doc};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicUsize, Ordering},
};

fn metadata(id: &str) -> StreamerMetadata {
    StreamerMetadata {
        id: id.into(),
        name: "owner".into(),
        email: String::new(),
        plan_tier: "free".into(),
        plan_tier_until: String::new(),
        polar_sh_customer_id: String::new(),
        actived: "true".into(),
        chat_enabled: "true".into(),
        plan_version: String::new(),
    }
}
#[test]
fn metadata_mapper_matches_current_typescript_fixture() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/twitch_streamers_parity.json"
    ))
    .unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let mut input = bson::serialize_to_document(&case["input"]).unwrap();
        for field in ["plan_tier_until", "polar_plan_event_at"] {
            if let Some(date_string) = input.get_str(field).ok().map(str::to_owned) {
                input.insert(field, DateTime::parse_rfc3339_str(&date_string).unwrap());
            }
        }
        let account = metadata_from_document(&input, "fixture-user")
            .unwrap()
            .unwrap();
        let value = serde_json::to_value(&account).unwrap();
        for field in [
            "id",
            "name",
            "email",
            "plan_tier",
            "plan_tier_until",
            "polar_sh_customer_id",
            "actived",
            "chat_enabled",
        ] {
            assert_eq!(
                value[field], case["expected"][field],
                "{}: {field}",
                case["name"]
            );
        }
        assert_eq!(account.plan_version, case["version"].as_str().unwrap());
        for (field, _) in account.cache_fields() {
            assert!(!matches!(
                field.as_str(),
                "access_token"
                    | "refresh_token"
                    | "expires_at"
                    | "has_permissions"
                    | "up_to_date_permissions"
            ));
        }
    }
}
#[test]
fn mapper_binds_platform_and_identity_and_supports_multiple_twitch_accounts() {
    let user = doc! {"accounts":[{"type":"kick","id":"1","name":"wrong"},{"type":"twitch","id":"2","name":"other"},{"type":"twitch","id":"1","name":"correct"}],"plan_tier":"premium"};
    let account = metadata_from_document(&user, "1").unwrap().unwrap();
    assert_eq!(account.name, "correct");
    assert_eq!(account.actived, "false");
    assert_eq!(account.plan_tier, "premium");
    assert!(metadata_from_document(&user, "missing").unwrap().is_none());
    assert_eq!(
        metadata_from_document(
            &doc! {"accounts":[{"type":"twitch","id":"1"},{"type":"twitch","id":"1"}]},
            "1"
        ),
        Err(DirectoryError::InvalidData)
    );
}
#[test]
fn date_spelling_covers_epoch_expanded_years_and_invalid_dates() {
    assert_eq!(format_plan_date(None), "");
    assert_eq!(format_plan_date(Some(0)), "Thu Jan 01 1970");
    assert_eq!(format_plan_date(Some(-1)), "Wed Dec 31 1969");
    assert_eq!(
        format_plan_date(Some(8_640_000_000_000_000)),
        "Sat Sep 13 275760"
    );
    assert_eq!(
        format_plan_date(Some(-8_640_000_000_000_000)),
        "Tue Apr 20 -271821"
    );
    assert_eq!(format_plan_date(Some(i64::MAX)), "Invalid Date");
}
#[tokio::test]
async fn same_key_work_and_errors_are_shared_and_completed_keys_retry() {
    let flights = Flights::<usize>::new(2);
    let calls = Arc::new(AtomicUsize::new(0));
    let make = || {
        let calls = calls.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(42)
        }
    };
    let (a, b) = tokio::join!(
        flights.run("id".into(), make()),
        flights.run("id".into(), make())
    );
    assert_eq!(a, Ok(42));
    assert_eq!(b, Ok(42));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        flights
            .run("id".into(), async { Err(DirectoryError::StoreUnavailable) })
            .await,
        Err(DirectoryError::StoreUnavailable)
    );
    assert_eq!(flights.run("id".into(), async { Ok(5) }).await, Ok(5));
}
#[tokio::test]
async fn completed_work_is_removed_even_when_an_older_waiter_remains_unpolled() {
    let flights = Flights::<usize>::new(2);
    let (ready, wait) = tokio::sync::oneshot::channel::<()>();
    let mut first = Box::pin(flights.run("id".into(), async move {
        wait.await.unwrap();
        Ok(1)
    }));
    assert!(futures_util::poll!(&mut first).is_pending());
    let mut second = Box::pin(flights.run("id".into(), async { Ok(2) }));
    assert!(futures_util::poll!(&mut second).is_pending());
    ready.send(()).unwrap();
    assert_eq!(first.await, Ok(1));
    assert_eq!(flights.run("id".into(), async { Ok(3) }).await, Ok(3));
    assert_eq!(second.await, Ok(1));
}
#[tokio::test]
async fn cancellation_cleans_weak_entries_and_capacity_is_bounded() {
    let flights = Flights::<usize>::new(1);
    let mut first = Box::pin(flights.run("first".into(), std::future::pending()));
    assert!(futures_util::poll!(&mut first).is_pending());
    assert_eq!(
        flights.run("second".into(), async { Ok(2) }).await,
        Err(DirectoryError::Busy)
    );
    drop(first);
    assert_eq!(flights.run("second".into(), async { Ok(3) }).await, Ok(3));
    for index in 0..100 {
        assert_eq!(flights.run(index.to_string(), async { Ok(4) }).await, Ok(4));
    }
    assert!(flights.entries.lock().unwrap().len() <= 1);
}

#[derive(Default)]
struct CacheState {
    revision: u64,
    records: BTreeMap<String, BTreeMap<String, String>>,
    generations: BTreeMap<String, String>,
    ids: BTreeSet<String>,
    lease: Option<String>,
    plan_fences: BTreeMap<String, String>,
    validate_stale: bool,
    revoke_on_validate: bool,
    add_member_on_validate: bool,
}
#[derive(Default)]
struct Cache(Mutex<CacheState>);
impl Cache {
    fn credentials(&self, id: &str, token: &str) {
        let mut state = self.0.lock().unwrap();
        let fields = state.records.entry(id.into()).or_default();
        for (k, v) in [
            ("access_token", token),
            ("refresh_token", "refresh"),
            ("expires_at", "9999999999"),
            ("has_permissions", "true"),
            ("up_to_date_permissions", "false"),
        ] {
            fields.insert(k.into(), v.into());
        }
    }
}
impl DirectoryCache for Cache {
    fn revision(&self) -> DirectoryFuture<'_, String> {
        Box::pin(async move { Ok(self.0.lock().unwrap().revision.to_string()) })
    }
    fn observe<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, DirectorySnapshot> {
        Box::pin(async move {
            let state = self.0.lock().unwrap();
            Ok(DirectorySnapshot {
                revision: state.revision.to_string(),
                generation: state.generations.get(id).cloned().unwrap_or_default(),
                fields: state
                    .records
                    .get(id)
                    .map(|v| v.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default(),
            })
        })
    }
    fn read_accounts<'a>(&'a self, ids: &'a [String]) -> DirectoryFuture<'a, Vec<CachedStreamer>> {
        Box::pin(async move {
            let state = self.0.lock().unwrap();
            ids.iter()
                .map(|id| {
                    let Some(fields) = state.records.get(id).filter(|f| f.contains_key("id"))
                    else {
                        return Ok(CachedStreamer::Missing);
                    };
                    if state.plan_fences.get(id).is_some_and(|f| {
                        f > fields
                            .get(PLAN_CACHE_VERSION_FIELD)
                            .unwrap_or(&String::new())
                    }) {
                        return Ok(CachedStreamer::Stale);
                    }
                    Ok(CachedStreamer::Present(
                        super::mapping::account_from_fields(
                            id,
                            fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                        )?,
                    ))
                })
                .collect()
        })
    }
    fn publish<'a>(
        &'a self,
        account: &'a StreamerMetadata,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, String> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if (lease.is_some() && state.revision.to_string() != expected.revision)
                || state
                    .generations
                    .get(&account.id)
                    .cloned()
                    .unwrap_or_default()
                    != expected.generation
            {
                return Err(DirectoryError::Stale);
            }
            if lease.is_some() && lease != state.lease.as_deref() {
                return Err(DirectoryError::Busy);
            }
            if state
                .plan_fences
                .get(&account.id)
                .is_some_and(|f| f > &account.plan_version)
            {
                return Err(DirectoryError::Stale);
            }
            let fields = state.records.entry(account.id.clone()).or_default();
            for (k, v) in account.cache_fields() {
                fields.insert(k, v);
            }
            if [
                "access_token",
                "refresh_token",
                "has_permissions",
                "up_to_date_permissions",
            ]
            .iter()
            .all(|k| fields.contains_key(*k))
            {
                fields.insert("id".into(), account.id.clone());
            } else {
                fields.remove("id");
            }
            state.ids.insert(account.id.clone());
            state.revision += 1;
            let revision = state.revision.to_string();
            state
                .generations
                .insert(account.id.clone(), revision.clone());
            Ok(revision)
        })
    }
    fn evict<'a>(
        &'a self,
        id: &'a str,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            let fields = state
                .records
                .get(id)
                .map(|v| {
                    v.iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if state.revision.to_string() != expected.revision
                || state.generations.get(id).cloned().unwrap_or_default() != expected.generation
                || fields != expected.fields
            {
                return Err(DirectoryError::Stale);
            }
            if lease.is_some() && lease != state.lease.as_deref() {
                return Err(DirectoryError::Busy);
            }
            state.records.remove(id);
            state.ids.remove(id);
            state.revision += 1;
            let rev = state.revision.to_string();
            state.generations.insert(id.into(), rev);
            Ok(true)
        })
    }
    fn ids<'a>(&'a self, cursor: u64, count: usize) -> DirectoryFuture<'a, IdPage> {
        Box::pin(async move {
            let state = self.0.lock().unwrap();
            let all = state.ids.iter().cloned().collect::<Vec<_>>();
            let end = (cursor as usize + count).min(all.len());
            Ok(IdPage {
                ids: all[cursor as usize..end].to_vec(),
                next: if end == all.len() { 0 } else { end as u64 },
            })
        })
    }
    fn hash_ids<'a>(&'a self, _cursor: u64, _count: usize) -> DirectoryFuture<'a, IdPage> {
        Box::pin(async move {
            Ok(IdPage {
                ids: self.0.lock().unwrap().records.keys().cloned().collect(),
                next: 0,
            })
        })
    }
    fn validate<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [(String, String)],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let state = self.0.lock().unwrap();
            Ok(!state.validate_stale
                && state.revision.to_string() == revision
                && accounts.iter().all(|(id, v)| {
                    state.ids.contains(id) && state.plan_fences.get(id).is_none_or(|f| f <= v)
                }))
        })
    }
    fn validate_ids<'a>(
        &'a self,
        revision: &'a str,
        ids: &'a [String],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.add_member_on_validate {
                state.ids.insert("late-native-hydration".into());
            }
            Ok(!state.validate_stale
                && state.revision.to_string() == revision
                && state.ids.len() == ids.len()
                && ids.iter().all(|id| state.ids.contains(id)))
        })
    }
    fn validate_accounts<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [StreamerAccount],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.add_member_on_validate {
                state.ids.insert("late-native-hydration".into());
            }
            if state.revoke_on_validate
                && let Some(fields) = state.records.get_mut("1")
            {
                fields.insert("access_token".into(), String::new());
                fields.insert("has_permissions".into(), "false".into());
            }
            Ok(!state.validate_stale
                && state.revision.to_string() == revision
                && state.ids.len() == accounts.len()
                && accounts.iter().all(|account| {
                    let id = &account.metadata.id;
                    let Some(fields) = state.records.get(id) else {
                        return false;
                    };
                    state.ids.contains(id)
                        && state
                            .plan_fences
                            .get(id)
                            .is_none_or(|f| f <= &account.metadata.plan_version)
                        && [
                            ("id", id),
                            ("access_token", &account.access_token),
                            ("refresh_token", &account.refresh_token),
                            ("expires_at", &account.expires_at),
                            ("has_permissions", &account.has_permissions),
                            ("up_to_date_permissions", &account.up_to_date_permissions),
                        ]
                        .iter()
                        .all(|(key, value)| fields.get(*key) == Some(*value))
                }))
        })
    }
    fn acquire_lease<'a>(&'a self, owner: &'a str, _ttl: Duration) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.lease.is_some() {
                Ok(false)
            } else {
                state.lease = Some(owner.into());
                Ok(true)
            }
        })
    }
    fn release_lease<'a>(&'a self, owner: &'a str) -> DirectoryFuture<'a, ()> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.lease.as_deref() == Some(owner) {
                state.lease = None;
            }
            Ok(())
        })
    }
    fn kick_credentials<'a>(&'a self, _id: &'a str) -> DirectoryFuture<'a, Option<CachedAccount>> {
        Box::pin(async { Ok(None) })
    }
}
#[derive(Default)]
struct Store {
    rows: Mutex<BTreeMap<String, StreamerMetadata>>,
    reads: AtomicUsize,
    reads_by_id: Mutex<BTreeMap<String, usize>>,
    fail: bool,
}
impl MetadataStore for Store {
    fn account<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>> {
        Box::pin(async move {
            self.reads.fetch_add(1, Ordering::SeqCst);
            *self
                .reads_by_id
                .lock()
                .unwrap()
                .entry(id.to_owned())
                .or_default() += 1;
            tokio::task::yield_now().await;
            if self.fail {
                Err(DirectoryError::StoreUnavailable)
            } else {
                Ok(self.rows.lock().unwrap().get(id).cloned())
            }
        })
    }
    fn page<'a>(
        &'a self,
        after: Option<&'a str>,
        limit: usize,
    ) -> DirectoryFuture<'a, MetadataPage> {
        Box::pin(async move {
            if self.fail {
                return Err(DirectoryError::StoreUnavailable);
            }
            let rows = self
                .rows
                .lock()
                .unwrap()
                .values()
                .filter(|a| after.is_none_or(|after| a.id.as_str() > after))
                .take(limit)
                .cloned()
                .collect::<Vec<_>>();
            let next = if rows.len() == limit {
                rows.last().map(|a| a.id.clone())
            } else {
                None
            };
            Ok(MetadataPage {
                accounts: rows,
                next,
            })
        })
    }
}
struct Credentials {
    cache: Arc<Cache>,
    calls: AtomicUsize,
    partial: bool,
}
impl StreamerCredentials for Credentials {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.partial {
                self.cache.credentials(id, "latest");
            }
            Ok(CachedAccount {
                id: id.into(),
                ..Default::default()
            })
        })
    }
    fn token<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, AccessToken> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(AccessToken::user("secret", id))
        })
    }
}
struct Clock;
impl TokenClock for Clock {
    fn now_seconds(&self) -> i64 {
        100
    }
    fn monotonic_millis(&self) -> u64 {
        0
    }
    fn sleep(&self, _duration: Duration) -> super::super::twitch_tokens::StorageFuture<'_, ()> {
        Box::pin(async {})
    }
}
fn service(
    store: Arc<Store>,
    cache: Arc<Cache>,
    partial: bool,
) -> (TwitchStreamers, Arc<Credentials>) {
    let credentials = Arc::new(Credentials {
        cache: cache.clone(),
        calls: AtomicUsize::new(0),
        partial,
    });
    (
        TwitchStreamers::new(
            store,
            cache,
            credentials.clone(),
            Arc::new(Clock),
            DirectoryConfig {
                page_size: 1,
                ..Default::default()
            },
        )
        .unwrap(),
        credentials,
    )
}

#[tokio::test]
async fn cold_point_hydration_coalesces_and_rereads_current_credentials() {
    let store = Arc::new(Store::default());
    store.rows.lock().unwrap().insert("1".into(), metadata("1"));
    let cache = Arc::new(Cache::default());
    let (service, credentials) = service(store.clone(), cache, false);
    let (a, b) = tokio::join!(service.account_by_id("1"), service.account_by_id("1"));
    let a = a.unwrap();
    assert_eq!(b.unwrap(), a);
    assert_eq!(a.access_token, "latest");
    assert_eq!(a.up_to_date_permissions, "false");
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
    service.account_by_id("1").await.unwrap();
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert!(!format!("{a:?}").contains("latest"));
}
#[tokio::test]
async fn independent_cold_accounts_do_not_retry_for_unrelated_directory_mutations() {
    let store = Arc::new(Store::default());
    let ids = (0..16).map(|index| index.to_string()).collect::<Vec<_>>();
    for id in &ids {
        store.rows.lock().unwrap().insert(id.clone(), metadata(id));
    }
    let cache = Arc::new(Cache::default());
    let (service, credentials) = service(store.clone(), cache, false);
    let results =
        futures_util::future::join_all(ids.iter().map(|id| service.account_by_id(id))).await;
    for (id, account) in ids.iter().zip(results) {
        assert_eq!(&account.unwrap().metadata.id, id);
    }
    assert_eq!(store.reads.load(Ordering::SeqCst), ids.len());
    let per_id = store.reads_by_id.lock().unwrap();
    assert_eq!(per_id.len(), ids.len());
    assert!(per_id.values().all(|count| *count == 1));
    assert_eq!(credentials.calls.load(Ordering::SeqCst), ids.len());
}
#[tokio::test]
async fn incomplete_credentials_are_never_marked_complete() {
    let store = Arc::new(Store::default());
    store.rows.lock().unwrap().insert("1".into(), metadata("1"));
    let cache = Arc::new(Cache::default());
    let (service, _) = service(store, cache.clone(), true);
    assert_eq!(service.account_by_id("1").await, Err(DirectoryError::Busy));
    assert!(!cache.0.lock().unwrap().records["1"].contains_key("id"));
    assert_eq!(service.streamer_ids().await.unwrap(), vec!["1"]);
}
#[tokio::test]
async fn reconciliation_is_incremental_metadata_only_and_evicts_orphans() {
    let store = Arc::new(Store::default());
    for id in ["1", "2", "3"] {
        store.rows.lock().unwrap().insert(id.into(), metadata(id));
    }
    let cache = Arc::new(Cache::default());
    cache.credentials("orphan", "old");
    cache.credentials("1", "rotated");
    let (service, credentials) = service(store, cache.clone(), false);
    let report = service.reconcile().await.unwrap();
    assert_eq!(report.published, 3);
    assert_eq!(report.removed, 1);
    assert_eq!(credentials.calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.streamer_ids().await.unwrap(), vec!["1", "2", "3"]);
    let state = cache.0.lock().unwrap();
    assert_eq!(state.records["1"]["access_token"], "rotated");
    assert!(!state.records.contains_key("orphan"));
    assert!(state.lease.is_none());
}
#[tokio::test]
async fn generations_prevent_pending_snapshot_resurrection_and_eviction_preserves_rotation() {
    let cache = Cache::default();
    cache.credentials("1", "old");
    let before = cache.observe("1").await.unwrap();
    cache.credentials("1", "rotated");
    assert_eq!(
        cache.evict("1", &before, None).await,
        Err(DirectoryError::Stale)
    );
    let before = cache.observe("1").await.unwrap();
    cache.evict("1", &before, None).await.unwrap();
    assert_eq!(
        cache.publish(&metadata("1"), &before, None).await,
        Err(DirectoryError::Stale)
    );
}
#[tokio::test]
async fn errors_remain_errors_and_failed_reconciliation_releases_lease() {
    let store = Arc::new(Store {
        fail: true,
        ..Default::default()
    });
    let cache = Arc::new(Cache::default());
    let (service, _) = service(store, cache.clone(), false);
    assert_eq!(
        service.account_by_id("1").await,
        Err(DirectoryError::StoreUnavailable)
    );
    assert_eq!(
        service.reconcile().await,
        Err(DirectoryError::StoreUnavailable)
    );
    assert!(cache.0.lock().unwrap().lease.is_none());
}
#[tokio::test]
async fn final_list_fence_rejects_stale_and_token_calls_coalesce() {
    let cache = Arc::new(Cache::default());
    let (service, credentials) = service(Arc::new(Store::default()), cache.clone(), false);
    cache.0.lock().unwrap().validate_stale = true;
    assert_eq!(
        service.accounts_from_cache().await,
        Err(DirectoryError::Stale)
    );
    let context = CallerContext::new("fixture");
    let (a, b) = tokio::join!(
        service.account_token("1", Platform::Twitch, &context),
        service.account_token("1", Platform::Twitch, &context)
    );
    assert_eq!(a.unwrap().expose_secret(), "secret");
    assert_eq!(b.unwrap().expose_secret(), "secret");
    assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn privileged_list_rejects_mid_read_revocation_without_metadata_generation_change() {
    let store = Arc::new(Store::default());
    store.rows.lock().unwrap().insert("1".into(), metadata("1"));
    let cache = Arc::new(Cache::default());
    let (service, _) = service(store, cache.clone(), false);
    service.account_by_id("1").await.unwrap();
    let revision = cache.0.lock().unwrap().revision;
    cache.0.lock().unwrap().revoke_on_validate = true;
    assert_eq!(
        service.accounts_from_cache().await,
        Err(DirectoryError::Stale)
    );
    assert_eq!(cache.0.lock().unwrap().revision, revision);
}
#[tokio::test]
async fn id_list_rejects_native_membership_addition_without_revision_change() {
    let cache = Arc::new(Cache::default());
    cache.0.lock().unwrap().ids.insert("1".into());
    let (service, _) = service(Arc::new(Store::default()), cache.clone(), false);
    let revision = cache.0.lock().unwrap().revision;
    cache.0.lock().unwrap().add_member_on_validate = true;
    assert_eq!(service.streamer_ids().await, Err(DirectoryError::Stale));
    assert_eq!(cache.0.lock().unwrap().revision, revision);
    assert_eq!(cache.0.lock().unwrap().ids.len(), 2);
}
#[tokio::test]
async fn privileged_list_rejects_native_membership_addition_without_revision_change() {
    let store = Arc::new(Store::default());
    store.rows.lock().unwrap().insert("1".into(), metadata("1"));
    let cache = Arc::new(Cache::default());
    let (service, _) = service(store, cache.clone(), false);
    service.account_by_id("1").await.unwrap();
    let revision = cache.0.lock().unwrap().revision;
    cache.0.lock().unwrap().add_member_on_validate = true;
    assert_eq!(
        service.accounts_from_cache().await,
        Err(DirectoryError::Stale)
    );
    assert_eq!(cache.0.lock().unwrap().revision, revision);
    assert_eq!(cache.0.lock().unwrap().ids.len(), 2);
}
#[test]
fn redacted_snapshots_and_static_errors_do_not_expose_secrets() {
    let snapshot = DirectorySnapshot {
        revision: String::new(),
        generation: String::new(),
        fields: vec![("access_token".into(), "secret-sentinel".into())],
    };
    assert!(!format!("{snapshot:?}").contains("secret-sentinel"));
    assert!(
        !DirectoryError::CacheUnavailable {
            write_outcome_unknown: true
        }
        .to_string()
        .contains("secret-sentinel")
    );
}
