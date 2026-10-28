#![cfg(feature = "keyword-store")]
//! Run only against task-owned containers at keyword-mongo / keyword-redis.
//! Never uses application environment variables, credentials or shared clients.

use dima_rust::utils::keywords::{
    self, KeywordRow, KeywordStorage, KeywordStorageError,
    native::{
        KeywordNativeError, KeywordSubscriptionStatus, MongoRedisKeywordStorage, NativeKeywordCache,
    },
};
use futures_util::FutureExt;
use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};
use serde_json::{Value, json};
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

async fn wait_status(
    status: &mut tokio::sync::watch::Receiver<KeywordSubscriptionStatus>,
    predicate: impl Fn(&KeywordSubscriptionStatus) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if predicate(&status.borrow()) {
                return;
            }
            status
                .changed()
                .await
                .expect("subscriber status stays open");
        }
    })
    .await
    .expect("subscriber reaches expected state");
}

struct RacingStore {
    inner: Arc<MongoRedisKeywordStorage>,
    reject_queries: AtomicUsize,
    queries: AtomicUsize,
}
impl KeywordStorage for RacingStore {
    type Error = KeywordNativeError;
    async fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
        self.inner.get(key).await
    }
    async fn query_index(&self, channel: &str) -> Result<Vec<KeywordRow>, Self::Error> {
        self.queries.fetch_add(1, Ordering::SeqCst);
        let rows = self.inner.query_index(channel).await?;
        if self
            .reject_queries
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            self.inner
                .invalidate_shared(
                    &keywords::keyword_revision_key(channel),
                    &keywords::keyword_index_key(channel),
                    None,
                )
                .await?;
        }
        Ok(rows)
    }
    async fn query_body(&self, channel: &str, id: &str) -> Result<Option<Value>, Self::Error> {
        self.inner.query_body(channel, id).await
    }
    fn serialize_body_for_cache(&self, body: &Value) -> Result<String, serde_json::Error> {
        self.inner.serialize_body_for_cache(body)
    }
    async fn set_if_revision(
        &self,
        data: &str,
        revision_key: &str,
        revision: &str,
        value: &str,
        ttl: u64,
    ) -> Result<bool, Self::Error> {
        self.inner
            .set_if_revision(data, revision_key, revision, value, ttl)
            .await
    }
    async fn invalidate_shared(
        &self,
        revision: &str,
        index: &str,
        body: Option<&str>,
    ) -> Result<(), Self::Error> {
        self.inner.invalidate_shared(revision, index, body).await
    }
    async fn publish(&self, topic: &str, value: &str) -> Result<(), Self::Error> {
        self.inner.publish(topic, value).await
    }
    async fn update_keyword_count(
        &self,
        channel: &str,
        id: &str,
        count: f64,
    ) -> Result<(), Self::Error> {
        self.inner.update_keyword_count(channel, id, count).await
    }
    async fn delete(&self, key: &str) -> Result<(), Self::Error> {
        self.inner.delete(key).await
    }
}

#[tokio::test]
#[ignore = "requires explicit task-owned keyword-mongo/keyword-redis containers and namespace"]
async fn native_keyword_adapters_revision_ttl_count_subscription_and_reconnect() {
    let mongo_uri =
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").expect("explicit fixture Mongo address");
    let redis_url =
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").expect("explicit fixture Redis address");
    assert_eq!(
        mongo_uri, "mongodb://keyword-mongo:27017",
        "only the private fixture alias is allowed"
    );
    assert_eq!(
        redis_url, "redis://keyword-redis:6379/",
        "only the private fixture alias is allowed"
    );
    let namespace =
        std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("explicit unique task-owned namespace");
    assert!(
        namespace.starts_with("keyword-fixture-")
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
    let mongo = mongodb::Client::with_uri_str(&mongo_uri).await.unwrap();
    let database = mongo.database(&database_name);
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fixture database must be fresh"
    );
    let client = redis::Client::open(redis_url).unwrap();
    let connection = redis::aio::ConnectionManager::new_with_config(
        client.clone(),
        redis::aio::ConnectionManagerConfig::new().set_response_timeout(None),
    )
    .await
    .unwrap();
    let store = MongoRedisKeywordStorage::with_namespace(&database, connection.clone(), &namespace);
    let mut raw = connection;
    let keys = [
        keywords::keyword_index_key("channel"),
        keywords::keyword_revision_key("channel"),
        keywords::keyword_body_key("channel", "0123456789abcdef01234567"),
    ];
    let existing: i64 = redis::cmd("EXISTS")
        .arg(
            keys.iter()
                .map(|key| store.namespaced_key(key))
                .collect::<Vec<_>>(),
        )
        .query_async(&mut raw)
        .await
        .unwrap();
    assert_eq!(existing, 0, "fixture cache prefix must be unused");

    let result=AssertUnwindSafe(async {
        let commands=database.collection::<Document>("commands");
        let id=ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let disabled=ObjectId::parse_str("1123456789abcdef01234567").unwrap();
        let missing_enabled=ObjectId::parse_str("2123456789abcdef01234567").unwrap();
        commands.insert_many([
            doc!{"_id":id,"channelID":"channel","activation":"keyword","enabled":true,"cmd":" HELLO\tWorld ","keywordSettings":{"matchMode":"anywhere"},"blocks":{"secret":true},"availability":{"token":"hidden"},"count":2,"createdAt":DateTime::from_millis(0)},
            doc!{"_id":disabled,"channelID":"channel","activation":"keyword","enabled":false,"cmd":"disabled"},
            doc!{"_id":missing_enabled,"channelID":"channel","activation":"keyword","cmd":"implicit"},
            doc!{"channelID":"channel","activation":"command","enabled":true,"cmd":"ordinary"},
            doc!{"channelID":"other","activation":"keyword","enabled":true,"cmd":"elsewhere"},
        ]).await.unwrap();
        let service=NativeKeywordCache::new(store.clone(),client.clone());
        let entries=keywords::load_shared_index(&store,"channel").await.unwrap();
        assert_eq!(entries.len(),1); assert_eq!(entries[0].text,"hello world");
        let ttl:i64=redis::cmd("TTL").arg(store.namespaced_key(&keys[0])).query_async(&mut raw).await.unwrap();
        assert!((86_398..=86_400).contains(&ttl));
        let first=service.body("channel",&id.to_hex()).await.unwrap().unwrap();
        assert_eq!(first["permissions"],json!({}));assert!(first.get("blocks").is_none()&&first.get("availability").is_none());
        let cached=service.body("channel",&id.to_hex()).await.unwrap().unwrap();
        assert!(cached.get("permissions").is_none(),"Mongoose minimizes empty permissions in cached JSON");
        let ttl:i64=redis::cmd("TTL").arg(store.namespaced_key(&keys[2])).query_async(&mut raw).await.unwrap();assert!((28..=30).contains(&ttl));
        assert_eq!(service.body("channel",&disabled.to_hex()).await.unwrap().unwrap()["enabled"],false);
        assert_eq!(service.body("channel",&missing_enabled.to_hex()).await.unwrap().unwrap()["enabled"],true);
        assert!(service.body("other",&id.to_hex()).await.unwrap().is_none());
        assert!(matches!(store.query_body("channel","bad-id").await,Err(KeywordNativeError::InvalidCommandId)));
        let revision=store.get(&keys[1]).await.unwrap();
        service.save_count("channel",&id.to_hex(),9.0).await.unwrap();
        assert_eq!(store.get(&keys[1]).await.unwrap(),revision);assert!(store.get(&keys[0]).await.unwrap().is_some());assert!(store.get(&keys[2]).await.unwrap().is_none());
        assert_eq!(commands.find_one(doc!{"_id":id}).await.unwrap().unwrap().get_i32("count").unwrap(),9);
        assert!(matches!(service.save_count("channel",&id.to_hex(),f64::NAN).await,Err(KeywordNativeError::InvalidCommandRow)));

        store.delete(&keys[0]).await.unwrap();
        let racing=RacingStore{inner:Arc::new(store.clone()),reject_queries:AtomicUsize::new(2),queries:AtomicUsize::new(0)};
        assert_eq!(keywords::load_shared_index(&racing,"channel").await.unwrap(),entries);
        assert_eq!(racing.queries.load(Ordering::SeqCst),3,"real Redis revision races force fresh queries");
        store.delete(&keys[0]).await.unwrap();racing.reject_queries.store(5,Ordering::SeqCst);
        assert!(matches!(keywords::load_shared_index(&racing,"channel").await,Err(KeywordStorageError::RepeatedIndexChange)));
        assert_eq!(racing.queries.load(Ordering::SeqCst),8);

        let observer=NativeKeywordCache::new(store.clone(),client.clone());
        let old=observer.index.get("channel").await.unwrap();
        let subscription=observer.start_subscription().await.unwrap();
        let mut status=subscription.status.clone();
        commands.update_one(doc!{"_id":id},doc!{"$set":{"cmd":"new keyword"}}).await.unwrap();
        service.refresh("channel",Some(&id.to_hex())).await.unwrap();
        wait_status(&mut status,|state|state.invalidations>=1).await;
        let new=observer.index.get("channel").await.unwrap();
        assert!(!Arc::ptr_eq(&old,&new));assert_eq!(new.bucket("new")[0].text,"new keyword");
        let messages=status.borrow().messages;
        store.publish(keywords::KEYWORD_TOPIC,&json!({"channelID":"other"}).to_string()).await.unwrap();
        wait_status(&mut status,|state|state.messages>messages).await;
        assert!(Arc::ptr_eq(&new,&observer.index.get("channel").await.unwrap()),"unrelated channel does not evict current index");
        store.publish(keywords::KEYWORD_TOPIC,"malformed").await.unwrap();
        wait_status(&mut status,|state|state.malformed_messages==1).await;
        assert!(status.borrow().connected);
        let connections=status.borrow().connections;
        let clients:String=redis::cmd("CLIENT").arg("LIST").query_async(&mut raw).await.unwrap();
        let subscribers:Vec<_>=clients.lines().filter(|row|row.split_whitespace().any(|field|field.strip_prefix("flags=").is_some_and(|flags|flags.contains('P')))).collect();
        assert_eq!(subscribers.len(),1,"only the task-owned subscriber can be disconnected");
        let subscriber_id=subscribers[0].split_whitespace().find_map(|field|field.strip_prefix("id=")).expect("fixture subscriber has an ID").parse::<u64>().unwrap();
        let killed:i64=redis::cmd("CLIENT").arg("KILL").arg("ID").arg(subscriber_id).query_async(&mut raw).await.unwrap();
        assert_eq!(killed,1,"only this task-owned Redis subscriber exists");
        wait_status(&mut status,|state|state.disconnects>=1).await;
        commands.update_one(doc!{"_id":id},doc!{"$set":{"cmd":"after reconnect"}}).await.unwrap();
        store.invalidate_shared(&keys[1],&keys[0],Some(&keys[2])).await.unwrap();
        wait_status(&mut status,|state|state.connections>connections&&state.connected).await;
        let reconnected=observer.index.get("channel").await.unwrap();
        assert_eq!(reconnected.bucket("after")[0].text,"after reconnect");
        let invalidations=status.borrow().invalidations;
        store.publish(keywords::KEYWORD_TOPIC,&json!({"channelID":"channel"}).to_string()).await.unwrap();
        wait_status(&mut status,|state|state.invalidations>invalidations).await;
        assert!(tokio::time::timeout(Duration::from_millis(50),status.changed()).await.is_err(),"idle subscriber waits without status polling or artificial event cadence");
        tokio::time::timeout(Duration::from_secs(1),subscription.shutdown()).await.expect("shutdown cancels idle stream immediately");
        println!("Keyword native adapters: collection filters, schema/default cache distinction, TTLs, count writes, five-attempt CAS race, publication, malformed input, unrelated-channel stability, reconnect/resubscribe and idle shutdown passed");
    }).catch_unwind().await;
    database
        .drop()
        .await
        .expect("remove only task-owned fixture database");
    let mut cursor = 0_u64;
    loop {
        let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{namespace}*"))
            .arg("COUNT")
            .arg(100)
            .query_async(&mut raw)
            .await
            .unwrap();
        if !found.is_empty() {
            let _: i64 = redis::cmd("DEL")
                .arg(found)
                .query_async(&mut raw)
                .await
                .unwrap();
        }
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
