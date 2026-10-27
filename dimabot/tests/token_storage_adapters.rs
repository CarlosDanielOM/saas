#![cfg(feature = "twitch-tokens")]

//! Ignored unless the lead explicitly supplies disposable fixture addresses.
//! Required: TOKEN_STORAGE_FIXTURE_MONGO_URI, TOKEN_STORAGE_FIXTURE_REDIS_URL,
//! TOKEN_STORAGE_FIXTURE_NAMESPACE (`token-storage-fixture-<unique>:`).
//! Accepted hosts: loopback or `token-storage-{mongo,redis}`, `{mongo,redis}-fixture`.
//! No application connection helper, environment file or production defaults.

use dima_rust::utils::{
    credential_crypto::{CredentialCipher, StoredCredential},
    twitch::TWITCH_BOT_ACCOUNT_ID,
    twitch_tokens::{
        CachedAccount, CredentialStore, MongoCredentialStore, RedisTokenCache, StoredAccount,
        TokenCache,
    },
};
use futures_util::FutureExt;
use mongodb::bson::{Bson, Document, doc};
use std::{collections::BTreeMap, panic::AssertUnwindSafe, time::Duration};

fn fixture_uri(name: &str) -> String {
    let raw = std::env::var(name).expect("explicit fixture address required");
    let url = reqwest::Url::parse(&raw).expect("valid fixture URI required");
    assert!(
        matches!(
            url.host_str(),
            Some(
                "127.0.0.1"
                    | "localhost"
                    | "[::1]"
                    | "::1"
                    | "token-storage-mongo"
                    | "token-storage-redis"
                    | "mongo-fixture"
                    | "redis-fixture"
            )
        ),
        "only explicitly named fixture or loopback hosts are accepted"
    );
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "fixture requires no credentials"
    );
    raw
}
fn encoded(token: &StoredCredential) -> Bson {
    Bson::Document(doc! {
        "iv": token.iv.clone().map(Bson::String).unwrap_or(Bson::Null),
        "content": token.content.clone().map(Bson::String).unwrap_or(Bson::Null)
    })
}

#[tokio::test]
#[ignore = "requires explicit disposable Mongo and Redis fixture addresses and namespace"]
async fn token_storage_native_adapters_fixture() {
    let mongo_uri = fixture_uri("TOKEN_STORAGE_FIXTURE_MONGO_URI");
    let redis_url = fixture_uri("TOKEN_STORAGE_FIXTURE_REDIS_URL");
    let namespace = std::env::var("TOKEN_STORAGE_FIXTURE_NAMESPACE")
        .expect("explicit unique fixture namespace required");
    assert!(
        namespace.starts_with("token-storage-fixture-")
            && namespace.ends_with(':')
            && (24..=60).contains(&namespace.len())
    );
    assert!(
        namespace
            .trim_end_matches(':')
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let database_name = namespace.trim_end_matches(':').replace('-', "_");
    let client = mongodb::Client::with_uri_str(&mongo_uri)
        .await
        .expect("fixture Mongo connects");
    let database = client.database(&database_name);
    // Refuse to reuse a nonempty database, even in the fixture namespace.
    assert!(
        database
            .list_collection_names()
            .await
            .expect("list fixture collections")
            .is_empty()
    );
    let redis_client = redis::Client::open(redis_url).expect("fixture Redis URL");
    let connection = redis::aio::ConnectionManager::new(redis_client)
        .await
        .expect("fixture Redis connects");
    let mut raw = connection.clone();
    let cache = RedisTokenCache::with_namespace(connection, &namespace);
    let store = MongoCredentialStore::new(&database);
    let key = |suffix: &str| format!("{namespace}{suffix}");
    let keys = [
        key("accounts:twitch:user:data"),
        key(&format!("accounts:twitch:{TWITCH_BOT_ACCOUNT_ID}:data")),
        key("streamers:by:id"),
        key("twitch:accounts"),
        key("app:twitch:token"),
        key("app:twitch:bot"),
        key("locks:refresh:twitch:user"),
    ];
    let existing: i64 = redis::cmd("EXISTS")
        .arg(&keys)
        .query_async(&mut raw)
        .await
        .expect("fixture Redis key check");
    assert_eq!(existing, 0, "fixture namespace must be unused");

    let result = AssertUnwindSafe(async {
        let cipher = CredentialCipher::new("fixture").unwrap();
        let access = cipher.encrypt("old-access").unwrap();
        let refresh = cipher.encrypt("old-refresh").unwrap();
        database.collection::<Document>("users").insert_one(doc! { "accounts": [
            { "id": "user", "type": "kick", "access_token": encoded(&access), "name": "kick-metadata" },
            { "id": "user", "type": "twitch", "name": "streamer-metadata", "email": "fixture@example.invalid",
              "access_token": encoded(&access), "refresh_token": encoded(&refresh), "access_token_expires_at": 1000.5,
              "has_permissions": true, "up_to_date_permissions": false },
        ]}).await.expect("insert disposable fixture");
        database.collection::<Document>("users").insert_one(doc! { "accounts": [
            { "id": "cross-array-id", "type": "kick" }, { "id": "other-id", "type": "twitch" }
        ]}).await.expect("insert cross-array fixture");
        assert!(store.load("cross-array-id").await.unwrap().is_none(), "platform and id must match one array element");
        let original = store.load("user").await.unwrap().unwrap();
        assert_eq!(original.expires_at, Some(1000.5));
        let updated = StoredAccount { id: "user".into(), access_token: Some(cipher.encrypt("new-access").unwrap()),
            refresh_token: Some(cipher.encrypt("new-refresh").unwrap()), expires_at: Some(4600.0),
            has_permissions: true, up_to_date_permissions: true };
        assert!(store.replace(&original, &updated).await.unwrap());
        assert!(!store.replace(&original, &updated).await.unwrap(), "Mongo CAS rejects stale encrypted envelope");
        let loaded = store.load("user").await.unwrap().unwrap();
        assert_eq!(cipher.decrypt(loaded.refresh_token.as_ref()).unwrap().as_deref(), Some("new-refresh"));
        let doc = database.collection::<Document>("users").find_one(doc! { "accounts.id": "user" }).await.unwrap().unwrap();
        let accounts = doc.get_array("accounts").unwrap();
        assert_eq!(accounts[0].as_document().unwrap().get_str("name").unwrap(), "kick-metadata");
        assert_eq!(accounts[0].as_document().unwrap().get("access_token"), Some(&encoded(&access)));
        assert_eq!(accounts[1].as_document().unwrap().get_str("name").unwrap(), "streamer-metadata");
        assert_eq!(accounts[1].as_document().unwrap().get_str("email").unwrap(), "fixture@example.invalid");

        let old = CachedAccount { id: "user".into(), access_token: "old-access".into(), refresh_token: "old-refresh".into(),
            expires_at: "1000".into(), has_permissions: true, up_to_date_permissions: false };
        let _: i64 = redis::cmd("HSET").arg(&keys[0]).arg("has_permissions").arg("false")
            .query_async(&mut raw).await.unwrap();
        assert!(cache.account("user").await.unwrap().is_some(), "permission-only state is a credential snapshot");
        assert!(!cache.put_account(&old, None).await.unwrap(), "a permission flag prevents absent-state hydration");
        let _: i64 = redis::cmd("HDEL").arg(&keys[0]).arg("has_permissions").query_async(&mut raw).await.unwrap();
        assert!(cache.put_account(&old, None).await.unwrap());
        let id_marker: Option<String> = redis::cmd("HGET").arg(&keys[0]).arg("id").query_async(&mut raw).await.unwrap();
        assert_eq!(id_marker, None, "Rust partial hydration must leave TS's full-hydration marker absent");
        assert_eq!(cache.account("user").await.unwrap().unwrap().id, "user", "Rust infers id from the requested key");
        let _: i64 = redis::cmd("HSET").arg(&keys[0]).arg("id").arg("user").arg("name").arg("metadata-name")
            .arg("email").arg("metadata-email").arg("plan_tier").arg("pro").query_async(&mut raw).await.unwrap();
        let _: String = redis::cmd("SET").arg(&keys[3]).arg("old-list").query_async(&mut raw).await.unwrap();
        let new = CachedAccount { access_token: "new-access".into(), refresh_token: "new-refresh".into(),
            expires_at: "4600".into(), up_to_date_permissions: true, ..old.clone() };
        assert!(cache.put_account(&new, Some(&old)).await.unwrap());
        assert!(!cache.put_account(&old, Some(&old)).await.unwrap(), "stale publication cannot overwrite rotated cache");
        assert!(!cache.put_account(&old, None).await.unwrap(), "cold hydration requires still-absent credential fields");
        assert!(!cache.invalidate(&old).await.unwrap(), "stale failure cannot revoke rotated cache");
        let fields: BTreeMap<String, String> = redis::cmd("HGETALL").arg(&keys[0]).query_async(&mut raw).await.unwrap();
        assert_eq!(fields.get("id").unwrap(), "user"); assert_eq!(fields.get("name").unwrap(), "metadata-name");
        assert_eq!(fields.get("email").unwrap(), "metadata-email"); assert_eq!(fields.get("plan_tier").unwrap(), "pro");
        assert_eq!(fields.get("access_token").unwrap(), "new-access");
        let list: Option<String> = redis::cmd("GET").arg(&keys[3]).query_async(&mut raw).await.unwrap(); assert!(list.is_none());
        let ttl: i64 = redis::cmd("TTL").arg(&keys[0]).query_async(&mut raw).await.unwrap(); assert_eq!(ttl, -1, "source account hashes have no key TTL");

        assert!(cache.acquire("user", "first-owner", 50).await.unwrap());
        assert!(!cache.acquire("user", "second-owner", 5000).await.unwrap());
        cache.release("user", "wrong-owner").await.unwrap(); assert!(cache.held("user").await.unwrap());
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(cache.acquire("user", "second-owner", 5000).await.unwrap());
        cache.release("user", "first-owner").await.unwrap(); assert!(cache.held("user").await.unwrap());
        cache.release("user", "second-owner").await.unwrap(); assert!(!cache.held("user").await.unwrap());
        cache.put_app("app-fixture", 1).await.unwrap(); assert_eq!(cache.app().await.unwrap().as_deref(), Some("app-fixture"));
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(cache.app().await.unwrap(), None);
        let bot = CachedAccount { id: TWITCH_BOT_ACCOUNT_ID.into(), has_permissions: false, ..old.clone() };
        cache.put_account(&bot, None).await.unwrap(); cache.put_bot(&bot.access_token).await.unwrap();
        let mirror: Option<String> = redis::cmd("HGET").arg(&keys[5]).arg("access_token").query_async(&mut raw).await.unwrap();
        assert_eq!(mirror.as_deref(), Some("old-access"), "bot mirror publication has no streamer permission gate");
        // Streamer(bot) refresh publishes A2 without updating getBotToken's A1
        // mirror. Revoking A2 must remove the older mirror under the account fence.
        let refreshed_bot = CachedAccount { id: TWITCH_BOT_ACCOUNT_ID.into(), ..new.clone() };
        assert!(cache.put_account(&refreshed_bot, Some(&bot)).await.unwrap());
        let _: String = redis::cmd("SET").arg(&keys[3]).arg("cached-list").query_async(&mut raw).await.unwrap();
        assert!(cache.invalidate(&refreshed_bot).await.unwrap());
        let mirror: Option<String> = redis::cmd("HGET").arg(&keys[5]).arg("access_token").query_async(&mut raw).await.unwrap(); assert!(mirror.is_none());
        cache.put_bot(&bot.access_token).await.unwrap();
        cache.put_bot(&refreshed_bot.access_token).await.unwrap();
        let mirror: Option<String> = redis::cmd("HGET").arg(&keys[5]).arg("access_token").query_async(&mut raw).await.unwrap();
        assert!(mirror.is_none(), "delayed old bot publication cannot recreate a revoked mirror");
        let tombstone = cache.account(TWITCH_BOT_ACCOUNT_ID).await.unwrap().unwrap();
        assert!(!cache.put_account(&refreshed_bot, None).await.unwrap(), "revocation tombstone blocks stale cold hydration");
        let newer_bot = CachedAccount { access_token: "newer-access".into(), expires_at: "4700".into(), ..refreshed_bot.clone() };
        assert!(cache.put_account(&newer_bot, Some(&tombstone)).await.unwrap());
        cache.put_bot(&newer_bot.access_token).await.unwrap();
        cache.put_bot(&bot.access_token).await.unwrap();
        cache.put_bot(&refreshed_bot.access_token).await.unwrap();
        let mirror: Option<String> = redis::cmd("HGET").arg(&keys[5]).arg("access_token").query_async(&mut raw).await.unwrap();
        assert_eq!(mirror.as_deref(), Some("newer-access"), "delayed old bot publication cannot overwrite the newer mirror");
        let _: String = redis::cmd("SET").arg(&keys[3]).arg("newer-list").query_async(&mut raw).await.unwrap();
        assert!(!cache.invalidate(&refreshed_bot).await.unwrap(), "newer publication with even the same refresh token is fenced");
        let mirror: Option<String> = redis::cmd("HGET").arg(&keys[5]).arg("access_token").query_async(&mut raw).await.unwrap();
        assert_eq!(mirror.as_deref(), Some("newer-access"));
        let aggregate: Option<String> = redis::cmd("GET").arg(&keys[3]).query_async(&mut raw).await.unwrap();
        assert_eq!(aggregate.as_deref(), Some("newer-list"));
        assert_eq!(cache.account(TWITCH_BOT_ACCOUNT_ID).await.unwrap().unwrap(), newer_bot);
        let revoked = StoredAccount { access_token: Some(StoredCredential::default()), refresh_token: Some(StoredCredential::default()),
            expires_at: None, has_permissions: false, up_to_date_permissions: false, ..updated.clone() };
        assert!(store.replace(&updated, &revoked).await.unwrap());
        assert!(cache.invalidate(&new).await.unwrap());
        let cached = cache.account("user").await.unwrap().unwrap();
        assert!(!cached.has_permissions && !cached.up_to_date_permissions); assert!(cached.refresh_token.is_empty());
        assert!(!cache.put_account(&new, None).await.unwrap(), "cold hydration cannot resurrect a revoked account");
    }).catch_unwind().await;
    let redis_cleanup: redis::RedisResult<i64> =
        redis::cmd("DEL").arg(&keys).query_async(&mut raw).await;
    let mongo_cleanup = database.drop().await;
    redis_cleanup.expect("remove exact task-owned fixture keys");
    mongo_cleanup.expect("drop exact task-owned fixture database");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
