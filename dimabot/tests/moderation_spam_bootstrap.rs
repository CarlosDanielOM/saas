#![cfg(feature = "moderation-spam")]
#[path = "support/redis_response_loss.rs"]
mod response_loss;
#[path = "ai_credit_projection_support/mod.rs"]
mod support;

use dima_rust::utils::{
    moderation::spam::{BUDGET_LUA, SpamService, chatter_marker_id},
    redis_application_runtime,
};
use mongodb::{
    bson::{Document, doc},
    event::{EventHandler, command::CommandEvent},
};
use redis::AsyncCommands;
use std::{
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn guard() -> String {
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
    ns
}
fn db_name(ns: &str, suffix: &str) -> String {
    format!(
        "{}_spam_{suffix}",
        ns.trim_end_matches(':').replace('-', "_")
    )
}
fn marker(channel: &str, user: &str) -> String {
    format!(
        "moderation:seen:{}",
        chatter_marker_id(&channel.into(), &user.into())
    )
}
async fn connection() -> redis::aio::ConnectionManager {
    redis::aio::ConnectionManager::new(redis::Client::open("redis://keyword-redis:6379/").unwrap())
        .await
        .unwrap()
}
async fn ttl(cache: &mut redis::aio::ConnectionManager, key: &str, max: i64) {
    let remaining: i64 = redis::cmd("TTL").arg(key).query_async(cache).await.unwrap();
    assert!((max - 10..=max).contains(&remaining), "{key}: {remaining}");
}
async fn owner(db: &mongodb::Database, ns: &str) {
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fresh owned database required"
    );
    db.collection::<Document>("_owner")
        .insert_one(doc! {"_id":"owner", "namespace":ns, "owner":"dimabot-migration"})
        .await
        .unwrap();
}
async fn cleanup(db: &mongodb::Database, ns: &str) {
    let record = db
        .collection::<Document>("_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.get_str("namespace").unwrap(), ns);
    assert_eq!(record.get_str("owner").unwrap(), "dimabot-migration");
    db.drop().await.unwrap();
}

#[test]
#[ignore = "requires owned fresh keyword MongoDB and private Dragonfly"]
fn isolated_bootstrap_probes() {
    guard();
    for (case, host, port) in [
        ("offline", "127.0.0.1", "1"),
        ("online", "keyword-redis", "6379"),
    ] {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "bootstrap_child", "--nocapture"])
            .env("SPAM_BOOTSTRAP_CASE", case)
            .env("DRAGONFLY_HOST", host)
            .env("DRAGONFLY_PORT", port)
            .env("OBSERVABILITY_DISABLED", "true")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = support::child_output(child, Duration::from_secs(30));
        assert!(
            output.status.success(),
            "{case}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
#[ignore = "child only; requires owned private fixtures"]
fn bootstrap_child() {
    let ns = guard();
    let case = std::env::var("SPAM_BOOTSTRAP_CASE").unwrap();
    assert!(case == "offline" || case == "online");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mongo = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
                .await
                .unwrap();
            let db = mongo.database(&db_name(&ns, &case));
            owner(&db, &ns).await;
            let mut check = connection().await;
            let channel = format!("{ns}{case}");
            let seen = marker(&channel, "user");
            let budget = format!("moderation:spam-budget:channel:{channel}");
            let global = "moderation:spam-budget:global";
            assert!(!check.exists::<_, bool>(&seen).await.unwrap());
            assert!(!check.exists::<_, bool>(&budget).await.unwrap());
            assert!(!check.exists::<_, bool>(global).await.unwrap());
            let service = SpamService::from_application(db.clone());
            assert_eq!(
                db.collection::<Document>("moderation_chatters")
                    .count_documents(doc! {})
                    .await
                    .unwrap(),
                0
            );
            let first = tokio::time::timeout(
                Duration::from_secs(8),
                service.claim_first_observed_message(&channel.as_str().into(), &"user".into()),
            )
            .await
            .unwrap();
            let quota = tokio::time::timeout(
                Duration::from_secs(8),
                service.claim_spam_review_budget(&channel.as_str().into()),
            )
            .await
            .unwrap();
            if case == "offline" {
                assert!(first.is_err() && quota.is_err());
                assert_eq!(
                    db.collection::<Document>("moderation_chatters")
                        .count_documents(doc! {})
                        .await
                        .unwrap(),
                    0
                );
                for key in [&seen, &budget, &global.to_owned()] {
                    assert!(!check.exists::<_, bool>(key).await.unwrap());
                }
            } else {
                assert!(first.unwrap() && quota.unwrap());
                let (mut a, _) = redis_application_runtime::acquire().await.unwrap();
                let (mut b, _) = redis_application_runtime::acquire().await.unwrap();
                let id_a: i64 = redis::cmd("CLIENT")
                    .arg("ID")
                    .query_async(&mut a)
                    .await
                    .unwrap();
                let id_b: i64 = redis::cmd("CLIENT")
                    .arg("ID")
                    .query_async(&mut b)
                    .await
                    .unwrap();
                assert_eq!(id_a, id_b);
                assert_eq!(check.get::<_, String>(&seen).await.unwrap(), "1");
                assert_eq!(check.hget::<_, _, i64>(&budget, "count").await.unwrap(), 1);
                assert_eq!(check.hget::<_, _, i64>(global, "count").await.unwrap(), 1);
                let _: usize = check.del(&[seen, budget, global.to_owned()]).await.unwrap();
            }
            cleanup(&db, &ns).await;
        });
}

#[tokio::test]
#[ignore = "requires exclusive fresh private MongoDB and Dragonfly"]
async fn applied_response_loss_is_not_retried() {
    let ns = guard();
    let updates = Arc::new(AtomicUsize::new(0));
    let captured = updates.clone();
    let mut options = mongodb::options::ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.retry_writes = Some(false);
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(e) = event
            && e.command_name == "update"
        {
            captured.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let mongo = mongodb::Client::with_options(options).unwrap();
    let db = mongo.database(&db_name(&ns, "loss"));
    owner(&db, &ns).await;
    let mut check = connection().await;
    let channel = format!("{ns}loss");
    let budget = format!("moderation:spam-budget:channel:{channel}");
    let global = "moderation:spam-budget:global";
    let seen = marker(&channel, "user");
    for key in [&seen, &budget, &global.to_owned()] {
        assert!(!check.exists::<_, bool>(key).await.unwrap());
    }
    let _: String = redis::cmd("SCRIPT")
        .arg("LOAD")
        .arg(BUDGET_LUA)
        .query_async(&mut check)
        .await
        .unwrap();
    let proxy = response_loss::RedisResponseLoss::start();
    let manager =
        redis::aio::ConnectionManager::new(redis::Client::open(proxy.url.as_str()).unwrap())
            .await
            .unwrap();
    let service = SpamService::new(db.clone(), manager);
    assert!(
        tokio::time::timeout(
            Duration::from_secs(3),
            service.claim_spam_review_budget(&channel.as_str().into())
        )
        .await
        .unwrap()
        .is_err()
    );
    assert_eq!(proxy.script_count.load(Ordering::SeqCst), 1);
    for key in [&budget, &global.to_owned()] {
        assert_eq!(check.hget::<_, _, i64>(key, "count").await.unwrap(), 1);
        ttl(&mut check, key, 120).await;
    }
    drop(service);
    drop(proxy);
    let proxy = response_loss::RedisResponseLoss::start_dropping_set(true);
    let manager =
        redis::aio::ConnectionManager::new(redis::Client::open(proxy.url.as_str()).unwrap())
            .await
            .unwrap();
    let service = SpamService::new(db.clone(), manager);
    assert!(
        tokio::time::timeout(
            Duration::from_secs(3),
            service.claim_first_observed_message(&channel.as_str().into(), &"user".into())
        )
        .await
        .unwrap()
        .is_err()
    );
    assert_eq!(proxy.set_count.load(Ordering::SeqCst), 1);
    assert_eq!(updates.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.collection::<Document>("moderation_chatters")
            .count_documents(doc! {})
            .await
            .unwrap(),
        1
    );
    assert_eq!(check.get::<_, String>(&seen).await.unwrap(), "1");
    ttl(&mut check, &seen, 86400).await;
    drop(service);
    drop(proxy);
    let retry = SpamService::new(db.clone(), check.clone());
    assert!(
        !retry
            .claim_first_observed_message(&channel.as_str().into(), &"user".into())
            .await
            .unwrap()
    );
    assert_eq!(updates.load(Ordering::SeqCst), 1);
    ttl(&mut check, &seen, 86400).await;
    let _: usize = check.del(&[seen, budget, global.to_owned()]).await.unwrap();
    cleanup(&db, &ns).await;
}

#[tokio::test]
#[ignore = "requires exclusive fresh private MongoDB and Dragonfly"]
async fn explicit_telemetry_records_success_errors_and_cache_lookup() {
    use dima_rust::utils::observability::{Telemetry, TraceContext, with_telemetry_context};

    let ns = guard();
    let mongo = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = mongo.database(&db_name(&ns, "telemetry"));
    owner(&db, &ns).await;
    let mut check = connection().await;
    let channel = format!("{ns}telemetry");
    let seen = marker(&channel, "user");
    let wrong_seen = marker(&channel, "wrongtype");
    let budget = format!("moderation:spam-budget:channel:{channel}");
    let wrong_channel = format!("{ns}telemetry-wrongtype");
    let wrong_budget = format!("moderation:spam-budget:channel:{wrong_channel}");
    let global = "moderation:spam-budget:global".to_owned();
    let keys = vec![
        seen.clone(),
        wrong_seen.clone(),
        budget.clone(),
        wrong_budget.clone(),
        global.clone(),
    ];
    for key in &keys {
        assert!(!check.exists::<_, bool>(key).await.unwrap());
    }

    // Telemetry flushes only to this loopback endpoint, never to the fixture's Redis.
    let telemetry_endpoint = support::Endpoint::new(|_| b"+OK\r\n".to_vec());
    let telemetry = Telemetry::new(
        redis::Client::open(telemetry_endpoint.url.as_str()).unwrap(),
        "spam-test",
        true,
    );
    let task = telemetry.start().unwrap();
    let parent = TraceContext {
        trace_id: "0123456789abcdef0123456789abcdef".into(),
        span_id: "0123456789abcdef".into(),
        sampled: true,
        channel: "spam-test".into(),
        outcome: None,
    };
    let service = SpamService::with_telemetry(db.clone(), check.clone(), telemetry.clone());
    let channel_value = channel.as_str().into();
    let wrong_channel_value = wrong_channel.as_str().into();
    let user = "user".into();
    let wrong_user = "wrongtype".into();
    let set_error_user = "set-error".into();
    let first = with_telemetry_context(
        parent.clone(),
        service.claim_first_observed_message(&channel_value, &user),
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), first)
            .await
            .unwrap()
            .unwrap()
    );
    let hit = with_telemetry_context(
        parent.clone(),
        service.claim_first_observed_message(&channel_value, &user),
    );
    assert!(
        !tokio::time::timeout(Duration::from_secs(3), hit)
            .await
            .unwrap()
            .unwrap()
    );
    let admitted = with_telemetry_context(
        parent.clone(),
        service.claim_spam_review_budget(&channel_value),
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), admitted)
            .await
            .unwrap()
            .unwrap()
    );
    let _: i64 = check.lpush(&wrong_seen, "wrongtype").await.unwrap();
    let bad_get = with_telemetry_context(
        parent.clone(),
        service.claim_first_observed_message(&channel_value, &wrong_user),
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), bad_get)
            .await
            .unwrap()
            .is_err()
    );
    let _: String = redis::cmd("SET")
        .arg(&wrong_budget)
        .arg("wrongtype")
        .query_async(&mut check)
        .await
        .unwrap();
    let bad_eval = with_telemetry_context(
        parent.clone(),
        service.claim_spam_review_budget(&wrong_channel_value),
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), bad_eval)
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(check.hget::<_, _, i64>(&global, "count").await.unwrap(), 1);

    // A separate loopback Redis gives a miss then rejects SET; Mongo remains real.
    let rejecting = support::Endpoint::new(|command| match command[0].as_str() {
        "PING" => b"+PONG\r\n".to_vec(),
        "GET" => b"$-1\r\n".to_vec(),
        "SET" => b"-ERR fixture set rejected\r\n".to_vec(),
        other => panic!("unexpected command {other}"),
    });
    let scripted =
        SpamService::with_telemetry(db.clone(), rejecting.manager().await, telemetry.clone());
    let rejected = with_telemetry_context(
        parent.clone(),
        scripted.claim_first_observed_message(&channel_value, &set_error_user),
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), rejected)
            .await
            .unwrap()
            .is_err()
    );
    let id = chatter_marker_id(&channel_value, &set_error_user);
    assert!(
        db.collection::<Document>("moderation_chatters")
            .find_one(doc! {"_id":id})
            .await
            .unwrap()
            .is_some()
    );
    let calls = rejecting.calls.lock().unwrap().clone();
    assert_eq!(calls.iter().filter(|c| c[0] == "GET").count(), 1);
    assert_eq!(calls.iter().filter(|c| c[0] == "SET").count(), 1);

    let snapshot = telemetry.snapshot();
    for (name, outcome, expected) in [
        ("get", "ok", 3),
        ("get", "error", 1),
        ("set", "ok", 1),
        ("set", "error", 1),
        ("eval", "ok", 1),
        ("eval", "error", 1),
    ] {
        let spans = snapshot
            .spans
            .iter()
            .filter(|s| s.kind == "cache" && s.name == name && s.outcome == outcome)
            .collect::<Vec<_>>();
        assert_eq!(spans.len(), expected, "{name} {outcome}");
        assert!(spans.iter().all(|s| s.context.sampled
            && s.context.trace_id == parent.trace_id
            && s.parent_id.as_deref() == Some(parent.span_id.as_str())
            && !s.partial));
    }
    for (outcome, expected) in [("miss", 2), ("hit", 1)] {
        let count: u64 = snapshot
            .metrics
            .iter()
            .filter(|m| m.kind == "cache_lookup" && m.name == "get" && m.outcome == outcome)
            .map(|m| m.count)
            .sum();
        assert_eq!(count, expected, "cache lookup {outcome}");
    }
    drop(scripted);
    drop(service);
    drop(task);
    let _: usize = check.del(&keys).await.unwrap();
    cleanup(&db, &ns).await;
}
