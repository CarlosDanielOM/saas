#![cfg(feature = "moderation-spam")]
use dima_rust::utils::moderation::spam::{SpamService, chatter_marker_id};
use mongodb::{Client, Database, bson::doc};
use redis::aio::ConnectionManager;

// This fixture requires exclusively task-owned disposable servers. The exact
// global key is part of the source contract; never run on shared Redis. The
// fixture owner destroys both containers even on panic or process interruption.
async fn fixture() -> (Client, Database, ConnectionManager, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );
    assert_eq!(
        std::env::var("DIMA_SPAM_PRIVATE_FIXTURE_OWNER").as_deref(),
        Ok(ns.as_str())
    );
    let mut options = mongodb::options::ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let client = Client::with_options(options).unwrap();
    let db = client.database(&format!(
        "{}_spam",
        ns.trim_end_matches(':').replace('-', "_")
    ));
    let cache = ConnectionManager::new(redis::Client::open("redis://keyword-redis:6379/").unwrap())
        .await
        .unwrap();
    (client, db, cache, ns)
}
fn seen(channel: &str, user: &str) -> String {
    format!(
        "moderation:seen:{}",
        chatter_marker_id(&channel.into(), &user.into())
    )
}
async fn ttl(cache: &mut ConnectionManager, key: &str, max: i64) {
    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(cache).await.unwrap();
    assert!(
        (max - 2..=max).contains(&ttl),
        "unexpected TTL {key}: {ttl}"
    );
}
async fn time_window(cache: &mut ConnectionManager) -> i64 {
    let (seconds, _): (i64, i64) = redis::cmd("TIME").query_async(cache).await.unwrap();
    seconds / 60
}
async fn del(cache: &mut ConnectionManager, keys: &[String]) {
    if !keys.is_empty() {
        let _: i64 = redis::cmd("DEL")
            .arg(keys)
            .query_async(cache)
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires fresh private keyword MongoDB and Redis fixture"]
async fn durable_races_cache_truthiness_and_budgets() {
    let (_client, db, mut cache, ns) = fixture().await;
    let service = SpamService::new(db.clone(), cache.clone());
    let channel = format!("{ns}channel");
    let mut keys = Vec::new();
    let marker = seen(&channel, "user");
    keys.push(marker.clone());
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let svc = service.clone();
        let c = channel.clone();
        tasks.push(tokio::spawn(async move {
            svc.claim_first_observed_message(&c.into(), &"user".into())
                .await
                .unwrap()
        }));
    }
    let mut firsts = 0;
    for task in tasks {
        firsts += usize::from(task.await.unwrap());
    }
    assert_eq!(firsts, 1);
    assert_eq!(
        db.collection::<mongodb::bson::Document>("moderation_chatters")
            .count_documents(doc! {})
            .await
            .unwrap(),
        1
    );
    ttl(&mut cache, &marker, 86400).await;
    // Empty strings are falsey and fall through to the durable marker; "0" is truthy.
    let _: String = redis::cmd("SET")
        .arg(&marker)
        .arg("")
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(
        !service
            .claim_first_observed_message(&channel.as_str().into(), &"user".into())
            .await
            .unwrap()
    );
    let val: String = redis::cmd("GET")
        .arg(&marker)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(val, "1");
    ttl(&mut cache, &marker, 86400).await;
    let truthy = seen(&channel, "truthy");
    keys.push(truthy.clone());
    let _: String = redis::cmd("SET")
        .arg(&truthy)
        .arg("0")
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(
        !service
            .claim_first_observed_message(&channel.as_str().into(), &"truthy".into())
            .await
            .unwrap()
    );
    assert_eq!(
        db.collection::<mongodb::bson::Document>("moderation_chatters")
            .count_documents(doc! {})
            .await
            .unwrap(),
        1
    );
    // A GET error prevents the Mongo write and is propagated.
    let wrong = seen(&channel, "wrongtype");
    keys.push(wrong.clone());
    let _: i64 = redis::cmd("LPUSH")
        .arg(&wrong)
        .arg("x")
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(
        service
            .claim_first_observed_message(&channel.as_str().into(), &"wrongtype".into())
            .await
            .is_err()
    );
    assert_eq!(
        db.collection::<mongodb::bson::Document>("moderation_chatters")
            .count_documents(doc! {})
            .await
            .unwrap(),
        1
    );

    let global = "moderation:spam-budget:global".to_owned();
    keys.push(global.clone());
    let channels: Vec<String> = (0..11).map(|i| format!("{ns}budget:{i}")).collect();
    let budget_keys: Vec<String> = channels
        .iter()
        .map(|c| format!("moderation:spam-budget:channel:{c}"))
        .collect();
    keys.extend(budget_keys.clone());
    // Recreate the phase if the server's minute changes during the 301 calls;
    // no sleeps or altered clock are necessary.
    let mut completed = false;
    for _ in 0..4 {
        let mut budget_cleanup = budget_keys.clone();
        budget_cleanup.push(global.clone());
        del(&mut cache, &budget_cleanup).await;
        let before = time_window(&mut cache).await;
        let mut actual = Vec::new();
        for _ in 0..30 {
            actual.push(
                service
                    .claim_spam_review_budget(&channels[0].as_str().into())
                    .await
                    .unwrap(),
            );
        }
        let over_channel = service
            .claim_spam_review_budget(&channels[0].as_str().into())
            .await
            .unwrap();
        for c in channels.iter().take(10).skip(1) {
            for _ in 0..30 {
                actual.push(
                    service
                        .claim_spam_review_budget(&c.as_str().into())
                        .await
                        .unwrap(),
                );
            }
        }
        let over_global = service
            .claim_spam_review_budget(&channels[10].as_str().into())
            .await
            .unwrap();
        if time_window(&mut cache).await != before {
            continue;
        }
        assert!(actual.into_iter().all(|v| v));
        assert!(!over_channel);
        assert!(!over_global);
        ttl(&mut cache, &global, 120).await;
        ttl(&mut cache, &budget_keys[0], 120).await;
        completed = true;
        break;
    }
    assert!(
        completed,
        "server minute rolled over on every quota attempt"
    );
    // Explicitly seed stale windows; admission must reset each counter based on
    // Redis TIME, then increment both and renew the expiry atomically.
    let past = time_window(&mut cache).await - 1;
    for key in [&global, &budget_keys[0]] {
        let _: i64 = redis::cmd("HSET")
            .arg(key)
            .arg("window")
            .arg(past)
            .arg("count")
            .arg(999)
            .query_async(&mut cache)
            .await
            .unwrap();
    }
    assert!(
        service
            .claim_spam_review_budget(&channels[0].as_str().into())
            .await
            .unwrap()
    );
    for key in [&global, &budget_keys[0]] {
        let count: i64 = redis::cmd("HGET")
            .arg(key)
            .arg("count")
            .query_async(&mut cache)
            .await
            .unwrap();
        assert_eq!(count, 1);
        ttl(&mut cache, key, 120).await;
    }
    // Script error must propagate instead of spending a budget.
    del(&mut cache, &[budget_keys[10].clone()]).await;
    let _: String = redis::cmd("SET")
        .arg(&budget_keys[10])
        .arg("wrongtype")
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(
        service
            .claim_spam_review_budget(&channels[10].as_str().into())
            .await
            .is_err()
    );
    del(&mut cache, &keys).await;
    db.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires exclusive private MongoDB with enableTestCommands=1 and failpoint ownership"]
async fn mongo_command_duplicate_and_errors_preserve_order() {
    let (client, db, mut cache, ns) = fixture().await;
    assert_eq!(
        std::env::var("DIMA_SPAM_FAILPOINT_OWNER").as_deref(),
        Ok(ns.as_str())
    );
    let service = SpamService::new(db.clone(), cache.clone());
    let channel = format!("{ns}failpoint");
    let admin = client.database("admin");
    // The owner must tear down the private server after any panic so no failpoint survives.
    for (user, code, expected) in [("duplicate", 11000, Some(false)), ("failure", 91, None)] {
        let mut data = doc! {"failCommands":["update"], "errorCode":code};
        if code == 11000 {
            data.insert(
                "errorExtraInfo",
                doc! {"keyPattern":{"_id":1},"keyValue":{"_id":"fixture-duplicate"}},
            );
        }
        admin
            .run_command(doc! {"configureFailPoint":"failCommand", "mode":{"times":1}, "data":data})
            .await
            .unwrap();
        let result = service
            .claim_first_observed_message(&channel.as_str().into(), &user.into())
            .await;
        match expected {
            Some(v) => assert_eq!(result.unwrap(), v),
            None => assert!(result.is_err()),
        }
        let key = seen(&channel, user);
        let value: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut cache)
            .await
            .unwrap();
        if code == 11000 {
            assert_eq!(value.as_deref(), Some("1"));
            ttl(&mut cache, &key, 86400).await;
        } else {
            assert_eq!(value, None);
        }
        del(&mut cache, &[key]).await;
    }
    admin
        .run_command(doc! {"configureFailPoint":"failCommand", "mode":"off"})
        .await
        .unwrap();
    db.drop().await.unwrap();
}
