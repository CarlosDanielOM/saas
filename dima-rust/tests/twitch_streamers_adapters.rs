#![cfg(feature = "twitch-streamers")]

//! Explicit disposable native fixtures only. No application client, environment
//! file, production address, default connection or runtime consumer is used.

use dima_rust::utils::{
    credential_crypto::{CredentialCipher, StoredCredential},
    plan_cache_fence::{MAX_ACCOUNT_FIELDS, PLAN_CACHE_VERSION_FIELD, plan_cache_fence_key},
    twitch::{AccessToken, OAuthFailure, OAuthTokens, RefreshPolicy},
    twitch_streamers::{
        CachedStreamer, CallerContext, DirectoryCache, DirectoryConfig, DirectoryError,
        MetadataStore, MongoStreamerStore, NativeCredentials, Platform, RedisStreamerCache,
        TwitchStreamers,
    },
    twitch_tokens::{
        CredentialStore, MongoCredentialStore, OAuthExchange, RedisTokenCache, StorageFuture,
        TokenCache, TokenClock, TwitchTokenStorage,
    },
};
use futures_util::{FutureExt, future::join_all};
use mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use redis::aio::ConnectionManager;
use std::{
    collections::BTreeMap,
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

struct FixtureClock(Instant);
impl TokenClock for FixtureClock {
    fn now_seconds(&self) -> i64 {
        1000
    }
    fn monotonic_millis(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
    fn sleep(&self, duration: Duration) -> StorageFuture<'_, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}
#[derive(Default)]
struct FixtureOAuth {
    exchanges: AtomicUsize,
}
impl OAuthExchange for FixtureOAuth {
    fn refresh<'a>(
        &'a self,
        refresh: &'a str,
        id: &'a str,
        _: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async move {
            assert_eq!(refresh, "mongo-refresh");
            self.exchanges.fetch_add(1, Ordering::SeqCst);
            // A ready concurrent caller must coordinate with the real Redis
            // owner; this delay models an in-flight provider response.
            tokio::time::sleep(if id == "long-refresh" {
                Duration::from_secs(6)
            } else {
                Duration::from_millis(40)
            })
            .await;
            Ok(OAuthTokens {
                access_token: AccessToken::user("oauth-access", id),
                refresh_token: Some("oauth-refresh".into()),
                expires_in: 3600.0,
            })
        })
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async { panic!("directory must never request application OAuth") })
    }
}
fn cipher() -> CredentialCipher {
    CredentialCipher::new("streamer-native-fixture").unwrap()
}
fn envelope(value: &StoredCredential) -> Bson {
    Bson::Document(doc! {
        "iv": value.iv.clone().map(Bson::String).unwrap_or(Bson::Null),
        "content": value.content.clone().map(Bson::String).unwrap_or(Bson::Null)
    })
}
fn user(id: &str, expiry: f64) -> Document {
    let cipher = cipher();
    doc! {
        "accounts": [{ "type": "twitch", "id": id, "name": format!("name-{id}"),
            "email": format!("{id}@fixture.invalid"),
            "access_token": envelope(&cipher.encrypt("mongo-access").unwrap()),
            "refresh_token": envelope(&cipher.encrypt("mongo-refresh").unwrap()),
            "access_token_expires_at": expiry,
            "has_permissions": true, "up_to_date_permissions": false }]
    }
}
fn directory(
    database: &Database,
    connection: &ConnectionManager,
    namespace: &str,
    oauth: &Arc<FixtureOAuth>,
    clock: &Arc<FixtureClock>,
) -> TwitchStreamers {
    let storage = TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(database)),
        Arc::new(RedisTokenCache::with_namespace(
            connection.clone(),
            namespace,
        )),
        oauth.clone(),
        clock.clone(),
        cipher(),
    );
    TwitchStreamers::new(
        Arc::new(MongoStreamerStore::new(database)),
        Arc::new(RedisStreamerCache::with_namespace(
            connection.clone(),
            namespace,
        )),
        Arc::new(NativeCredentials::new(storage).unwrap()),
        clock.clone(),
        DirectoryConfig {
            page_size: 1,
            ..Default::default()
        },
    )
    .unwrap()
}
async fn hash(connection: &mut ConnectionManager, key: &str) -> BTreeMap<String, String> {
    redis::cmd("HGETALL")
        .arg(key)
        .query_async(connection)
        .await
        .unwrap()
}
async fn set_hash(connection: &mut ConnectionManager, key: &str, fields: &[(&str, &str)]) {
    let mut command = redis::cmd("HSET");
    command.arg(key);
    for (field, value) in fields {
        command.arg(field).arg(value);
    }
    let _: i64 = command.query_async(connection).await.unwrap();
}
async fn scan_owned(connection: &mut ConnectionManager, namespace: &str) -> Vec<String> {
    let mut cursor = 0u64;
    let mut keys = std::collections::BTreeSet::new();
    for _ in 0..4096 {
        let (next, page): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{namespace}*"))
            .arg("COUNT")
            .arg(128)
            .query_async(connection)
            .await
            .unwrap();
        for key in page {
            assert!(key.starts_with(namespace));
            keys.insert(key);
        }
        assert!(keys.len() <= 8192, "fixture cleanup must remain bounded");
        cursor = next;
        if cursor == 0 {
            return keys.into_iter().collect();
        }
    }
    panic!("fixture SCAN exceeded page bound")
}
fn command_calls(info: &str, command: &str) -> Option<u64> {
    let prefix = format!("cmdstat_{command}:calls=");
    info.lines()
        .find_map(|line| line.strip_prefix(&prefix))?
        .split(',')
        .next()?
        .parse()
        .ok()
}

#[tokio::test]
#[ignore = "requires explicitly named disposable streamer Mongo and Dragonfly fixtures"]
async fn twitch_streamers_native_adapters_fixture() {
    let mongo_uri = std::env::var("STREAMER_FIXTURE_MONGO_URI").expect("explicit fixture URI");
    let redis_url = std::env::var("STREAMER_FIXTURE_REDIS_URL").expect("explicit fixture URL");
    assert_eq!(mongo_uri, "mongodb://streamer-mongo-fixture:27017");
    assert_eq!(redis_url, "redis://streamer-redis-fixture:6379");
    let namespace = std::env::var("STREAMER_FIXTURE_NAMESPACE").expect("unique fixture namespace");
    let token = namespace
        .strip_prefix("streamer-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("fixture namespace shape");
    assert!((6..=32).contains(&token.len()));
    assert!(token.bytes().all(|byte| byte.is_ascii_alphanumeric()));
    let database_name = format!("streamer_fixture_{token}");
    let mongo = mongodb::Client::with_uri_str(&mongo_uri).await.unwrap();
    let database = mongo.database(&database_name);
    assert!(database.list_collection_names().await.unwrap().is_empty());
    let redis = redis::Client::open(redis_url).unwrap();
    let connection = ConnectionManager::new(redis).await.unwrap();
    let mut raw = connection.clone();
    assert!(
        scan_owned(&mut raw, &namespace).await.is_empty(),
        "namespace must be fresh"
    );

    let result = AssertUnwindSafe(async {
        let key = |suffix: &str| format!("{namespace}{suffix}");
        let account_key = |id: &str| key(&format!("accounts:twitch:{id}:data"));
        let users = database.collection::<Document>("users");
        users.insert_many([user("cold", 4600.0), user("expired", 900.0), user("metadata-only", 4600.0)]).await.unwrap();
        users.insert_one(doc! { "accounts": [
            {"type":"kick", "id":"cross-array", "name":"must-not-match"},
            {"type":"twitch", "id":"actual-twitch", "name":"actual"}
        ]}).await.unwrap();
        let store = MongoStreamerStore::new(&database);
        assert!(store.account("cross-array").await.unwrap().is_none(), "point filter binds platform and id to the same array member");
        let defaults = store.account("actual-twitch").await.unwrap().unwrap();
        assert_eq!((defaults.actived.as_str(), defaults.chat_enabled.as_str()), ("false", "false"));
        assert_eq!(defaults.plan_tier, "free");
        let mut after = None;
        let mut paged = Vec::new();
        for _ in 0..8 {
            let page = store.page(after.as_deref(), 1).await.unwrap();
            paged.extend(page.accounts.into_iter().map(|account| account.id));
            after = page.next; if after.is_none() { break; }
        }
        assert!(after.is_none());
        paged.sort(); assert_eq!(paged, ["actual-twitch", "cold", "expired", "metadata-only"]);

        let oauth = Arc::new(FixtureOAuth::default());
        let clock = Arc::new(FixtureClock(Instant::now()));
        let service = directory(&database, &connection, &namespace, &oauth, &clock);
        let cache = RedisStreamerCache::with_namespace(connection.clone(), &namespace);
        let tokens = RedisTokenCache::with_namespace(connection.clone(), &namespace);
        let cold = service.account_by_id("cold").await.unwrap();
        assert_eq!(cold.access_token, "mongo-access");
        assert_eq!(cold.refresh_token, "mongo-refresh");
        assert_eq!(cold.expires_at, "4600");
        assert_eq!(cold.has_permissions, "true");
        assert_eq!(cold.up_to_date_permissions, "false");
        assert_eq!(oauth.exchanges.load(Ordering::SeqCst), 0);
        let persisted = MongoCredentialStore::new(&database).load("cold").await.unwrap().unwrap();
        assert_eq!(cipher().decrypt(persisted.access_token.as_ref()).unwrap().as_deref(), Some(cold.access_token.as_str()));
        assert_eq!(persisted.expires_at, Some(4600.0));

        // The deprecated name helper used SREM: its legacy list is a Redis set,
        // and DEL-only aggregate keys may also have other historical types.
        let _: i64 = redis::cmd("SADD").arg(key("streamers:by:name")).arg("legacy-name-member").query_async(&mut raw).await.unwrap();
        let before = tokens.account("cold").await.unwrap().unwrap();
        let rotated = dima_rust::utils::twitch_tokens::CachedAccount {
            access_token: "redis-rotated-access".into(), refresh_token: "redis-rotated-refresh".into(),
            expires_at: "5000".into(), has_permissions: false, up_to_date_permissions: true,
            ..before.clone()
        };
        assert!(tokens.put_account(&rotated, Some(&before)).await.unwrap());
        let _: i64 = redis::cmd("LPUSH").arg(key("twitch:accounts")).arg("legacy-list-value").query_async(&mut raw).await.unwrap();
        users.update_one(doc! {"accounts.id":"cold"}, doc! {"$set":{"accounts.$.name":"changed-metadata"}}).await.unwrap();
        let changed = service.refresh_account("cold").await.unwrap();
        assert_eq!(changed.metadata.name, "changed-metadata");
        assert_eq!(tokens.account("cold").await.unwrap().unwrap(), rotated, "metadata must preserve the live rotated tuple and flags");
        let legacy_exists: i64 = redis::cmd("EXISTS").arg(key("streamers:by:name")).arg(key("twitch:accounts")).query_async(&mut raw).await.unwrap();
        assert_eq!(legacy_exists, 0);

        // Two independently constructed services share only native Mongo/Redis.
        // Their concurrent expired-token calls must consume one refresh token.
        service.account_by_id("expired").await.unwrap();
        let other = directory(&database, &connection, &namespace, &oauth, &clock);
        let context = CallerContext::new("native-fixture");
        let results = join_all((0..16).map(|index| {
            let service = if index % 2 == 0 { service.clone() } else { other.clone() };
            let context = context.clone();
            async move { service.account_token("expired", Platform::Twitch, &context).await }
        })).await;
        for token in results { assert_eq!(token.unwrap().expose_secret(), "oauth-access"); }
        assert_eq!(oauth.exchanges.load(Ordering::SeqCst), 1);
        let renewed = MongoCredentialStore::new(&database).load("expired").await.unwrap().unwrap();
        assert_eq!(cipher().decrypt(renewed.refresh_token.as_ref()).unwrap().as_deref(), Some("oauth-refresh"));
        assert_eq!(renewed.expires_at, Some(4600.0));

        // Membership reconciliation publishes metadata without decrypting and
        // without claiming a full TS hydration marker for credential-less hashes.
        set_hash(&mut raw, &account_key("absent-indexed"), &[("name", "obsolete")]).await;
        set_hash(&mut raw, &account_key("absent-orphan"), &[("name", "obsolete")]).await;
        let _: String = redis::cmd("SET").arg(account_key("nonhash-legacy")).arg("preserve-wrong-type").query_async(&mut raw).await.unwrap();
        let _: i64 = redis::cmd("SADD").arg(key("streamers:by:id")).arg("absent-indexed").query_async(&mut raw).await.unwrap();
        let report = service.reconcile().await.unwrap();
        assert_eq!(report.published, 4);
        assert_eq!(report.removed, 2);
        let nonhash: String = redis::cmd("GET").arg(account_key("nonhash-legacy")).query_async(&mut raw).await.unwrap();
        assert_eq!(nonhash, "preserve-wrong-type", "orphan scans select hashes without reading undeclared Lua keys");
        let metadata_only = hash(&mut raw, &account_key("metadata-only")).await;
        assert_eq!(metadata_only.get("name").map(String::as_str), Some("name-metadata-only"));
        assert!(!metadata_only.contains_key("id"));
        assert!(!metadata_only.contains_key("access_token"));
        assert!(matches!(cache.read_accounts(&["metadata-only".into()]).await.unwrap()[0], CachedStreamer::Missing));
        let absent: i64 = redis::cmd("EXISTS").arg(account_key("absent-indexed")).arg(account_key("absent-orphan")).query_async(&mut raw).await.unwrap();
        assert_eq!(absent, 0);
        assert_eq!(service.streamer_ids().await.unwrap(), ["actual-twitch", "cold", "expired", "metadata-only"]);
        assert_eq!(service.accounts_from_cache().await.unwrap_err(), DirectoryError::Busy, "indexed metadata without complete credentials must not escape as a complete aggregate");

        // An exact-hash eviction cannot destroy a newly rotated tuple even
        // when metadata did not advance the directory generation.
        let observed = cache.observe("cold").await.unwrap();
        set_hash(&mut raw, &account_key("cold"), &[("access_token", "newer-rotation")]).await;
        assert_eq!(cache.evict("cold", &observed, None).await.unwrap_err(), DirectoryError::Stale);
        assert_eq!(hash(&mut raw, &account_key("cold")).await.get("access_token").map(String::as_str), Some("newer-rotation"));
        let old_generation = cache.observe("generation-only").await.unwrap();
        assert!(cache.evict("generation-only", &old_generation, None).await.unwrap());
        let mut metadata = store.account("cold").await.unwrap().unwrap(); metadata.id = "generation-only".into();
        assert_eq!(cache.publish(&metadata, &old_generation, None).await.unwrap_err(), DirectoryError::Stale, "an empty-hash tombstone must reject an older observation");
        assert!(hash(&mut raw, &account_key("generation-only")).await.is_empty());

        // Billing's version fence is independent from the directory generation.
        let before_fence = cache.observe("cold").await.unwrap();
        let old_hash = hash(&mut raw, &account_key("cold")).await;
        let _: String = redis::cmd("SET").arg(key(&plan_cache_fence_key("cold"))).arg("9999999999999:newer").query_async(&mut raw).await.unwrap();
        let cold_metadata = store.account("cold").await.unwrap().unwrap();
        assert_eq!(cache.publish(&cold_metadata, &before_fence, None).await.unwrap_err(), DirectoryError::Stale);
        assert_eq!(hash(&mut raw, &account_key("cold")).await, old_hash);
        assert!(matches!(cache.read_accounts(&["cold".into()]).await.unwrap()[0], CachedStreamer::Stale));
        let _: i64 = redis::cmd("DEL").arg(key(&plan_cache_fence_key("cold"))).query_async(&mut raw).await.unwrap();

        // Full-read final validation catches token/permission revocation without
        // relying on a metadata revision change or a billing fence update.
        let revoked = service.account_by_id("actual-twitch").await.unwrap();
        assert!(revoked.access_token.is_empty());
        assert_eq!((revoked.has_permissions.as_str(), revoked.up_to_date_permissions.as_str()), ("false", "false"));
        service.account_by_id("metadata-only").await.unwrap();
        let aggregate = service.accounts_from_cache().await.unwrap();
        let revision = cache.revision().await.unwrap();
        assert!(cache.validate_accounts(&revision, &aggregate).await.unwrap());
        let ids = service.streamer_ids().await.unwrap();
        assert!(cache.validate_ids(&revision, &ids).await.unwrap());
        let _: i64 = redis::cmd("SADD").arg(key("streamers:by:id")).arg("late-native-member").query_async(&mut raw).await.unwrap();
        assert_eq!(cache.revision().await.unwrap(), revision);
        assert!(!cache.validate_ids(&revision, &ids).await.unwrap());
        assert!(!cache.validate_accounts(&revision, &aggregate).await.unwrap());
        let _: i64 = redis::cmd("SREM").arg(key("streamers:by:id")).arg("late-native-member").query_async(&mut raw).await.unwrap();
        set_hash(&mut raw, &account_key("expired"), &[("access_token", ""), ("refresh_token", ""), ("has_permissions", "false"), ("up_to_date_permissions", "false")]).await;
        assert_eq!(cache.revision().await.unwrap(), revision);
        assert!(!cache.validate_accounts(&revision, &aggregate).await.unwrap());

        // A cold EVALSHA pipeline recovers only a confirmed NOSCRIPT. Repeating
        // the same read stays on the warm prepared path when stats expose it.
        let _: String = redis::cmd("SCRIPT").arg("FLUSH").query_async(&mut raw).await.unwrap();
        let ids = vec!["cold".to_owned(), "expired".to_owned()];
        assert_eq!(cache.read_accounts(&ids).await.unwrap().len(), 2);
        let stats_before: redis::RedisResult<String> = redis::cmd("INFO").arg("commandstats").query_async(&mut raw).await;
        assert_eq!(cache.read_accounts(&ids).await.unwrap().len(), 2);
        let stats_after: redis::RedisResult<String> = redis::cmd("INFO").arg("commandstats").query_async(&mut raw).await;
        if let (Ok(before), Ok(after)) = (stats_before, stats_after) {
            if let (Some(before), Some(after)) = (command_calls(&before, "evalsha"), command_calls(&after, "evalsha")) { assert!(after >= before + 2); }
            assert_eq!(command_calls(&before, "keys"), command_calls(&after, "keys"));
        }

        // Type validation must run before any Lua mutation; Lua has no rollback.
        let guard_namespace = format!("{namespace}typeguard:");
        let guard_cache = RedisStreamerCache::with_namespace(connection.clone(), &guard_namespace);
        let guard_key = format!("{guard_namespace}accounts:twitch:cold:data");
        set_hash(&mut raw, &guard_key, &[("name", "before")]).await;
        let _: String = redis::cmd("SET").arg(format!("{guard_namespace}streamers:by:id")).arg("wrong-type").query_async(&mut raw).await.unwrap();
        let observation = guard_cache.observe("cold").await.unwrap();
        assert!(matches!(guard_cache.publish(&cold_metadata, &observation, None).await, Err(DirectoryError::CacheUnavailable { write_outcome_unknown: false })));
        assert_eq!(hash(&mut raw, &guard_key).await, BTreeMap::from([("name".to_owned(), "before".to_owned())]));
        assert_eq!(guard_cache.revision().await.unwrap(), "");

        // Native adapters enforce request, hash and identifier bounds before
        // large cache responses escape the boundary.
        assert_eq!(cache.read_accounts(&vec!["cold".into(); 65]).await.unwrap_err(), DirectoryError::TooLarge);
        assert_eq!(store.page(None, 0).await.unwrap_err(), DirectoryError::InvalidInput);
        assert_eq!(cache.ids(0, 65).await.unwrap_err(), DirectoryError::InvalidInput);
        assert_eq!(cache.observe("bad\nidentifier").await.unwrap_err(), DirectoryError::InvalidInput);
        let mut large = redis::cmd("HSET"); large.arg(account_key("oversized"));
        for index in 0..=MAX_ACCOUNT_FIELDS { large.arg(format!("field-{index}")).arg("x"); }
        let _: i64 = large.query_async(&mut raw).await.unwrap();
        assert_eq!(cache.observe("oversized").await.unwrap_err(), DirectoryError::TooLarge);
        assert_eq!(cache.read_accounts(&["oversized".into()]).await.unwrap_err(), DirectoryError::TooLarge);

        let calls_before_kick = oauth.exchanges.load(Ordering::SeqCst);
        set_hash(&mut raw, &key("accounts:kick:kick-user:data"), &[("access_token", "kick-access"), ("refresh_token", "kick-refresh"), ("expires_at", "4600"), ("has_permissions", "false"), ("up_to_date_permissions", "false")]).await;
        assert_eq!(service.account_token("kick-user", Platform::Kick, &context).await.unwrap().expose_secret(), "kick-access");
        assert_eq!(service.refresh_token("kick-user", Platform::Kick).await.unwrap(), "kick-refresh");
        set_hash(&mut raw, &key("accounts:kick:kick-user:data"), &[("expires_at", "900")]).await;
        assert_eq!(service.account_token("kick-user", Platform::Kick, &context).await.unwrap_err(), DirectoryError::UnsupportedRefresh);
        assert_eq!(oauth.exchanges.load(Ordering::SeqCst), calls_before_kick);
        assert_eq!(hash(&mut raw, &account_key("cold")).await.get(PLAN_CACHE_VERSION_FIELD).map(String::as_str), Some(""));

        // A native refresh can outlast the former 5s lease. A second independent
        // caller arriving after 5.2s must still see the original 30s owner and
        // reuse its eventual persisted token instead of consuming refresh twice.
        users.insert_one(user("long-refresh", 900.0)).await.unwrap();
        service.account_by_id("long-refresh").await.unwrap();
        let before_long = oauth.exchanges.load(Ordering::SeqCst);
        let second_connection = connection.clone();
        let lock_key = key("locks:refresh:twitch:long-refresh");
        let (first, second) = tokio::join!(
            service.account_token("long-refresh", Platform::Twitch, &context),
            async {
                tokio::time::sleep(Duration::from_millis(5200)).await;
                let mut connection = second_connection;
                let ttl: i64 = redis::cmd("PTTL").arg(&lock_key).query_async(&mut connection).await.unwrap();
                assert!((20_000..=25_000).contains(&ttl), "a 30s native lease must retain about 24.8s after the 5.2s delayed caller; observed {ttl}ms");
                assert_eq!(oauth.exchanges.load(Ordering::SeqCst), before_long + 1);
                other.account_token("long-refresh", Platform::Twitch, &context).await
            }
        );
        assert_eq!(first.unwrap().expose_secret(), "oauth-access");
        assert_eq!(second.unwrap().expose_secret(), "oauth-access");
        assert_eq!(oauth.exchanges.load(Ordering::SeqCst), before_long + 1);
    }).catch_unwind().await;

    // Only the proven-unique task prefix and database are removed. Never FLUSHDB,
    // broad key deletion, application initialization or production credentials.
    let keys = scan_owned(&mut raw, &namespace).await;
    for batch in keys.chunks(128) {
        let _: i64 = redis::cmd("DEL")
            .arg(batch)
            .query_async(&mut raw)
            .await
            .expect("fixture Redis cleanup");
    }
    database.drop().await.expect("fixture Mongo cleanup");
    assert!(scan_owned(&mut raw, &namespace).await.is_empty());
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
