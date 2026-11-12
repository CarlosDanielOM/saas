//! The rules' state on the local stores (`tools/test-env`): offenses, permits, the
//! first-message marker and the spam review budget, raced and flooded.
//!
//! Dragonfly logical database 8 with a unique key prefix per test, removed afterwards; MongoDB
//! `dima_test_moderation_<random>`, dropped afterwards, also when the test fails. Without the
//! stores a test skips, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use dima_core::{Clock, ManualClock, Random, SystemRandom};
use dima_moderation::rules::offenses::{offense_key, offense_receipt_key};
use dima_moderation::rules::permit::{permit_channel_key, permit_user_key};
use dima_moderation::rules::spam::{chatter_marker_id, seen_key, spam_budget_keys};
use dima_moderation::rules::{RulesConfig, RulesStore};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks, Ttl};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use futures_util::future::join_all;

const DATABASE: u8 = 8;

fn required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

fn suffix() -> String {
    let mut bytes = [0_u8; 6];
    SystemRandom.fill(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn connect() -> Option<(Dragonfly, MongoStore, String)> {
    let (Ok(address), Ok(uri)) = (
        std::env::var("DIMA_TEST_DRAGONFLY"),
        std::env::var("DIMA_TEST_MONGO_URI"),
    ) else {
        assert!(
            !required(),
            "DIMA_TEST_DRAGONFLY / DIMA_TEST_MONGO_URI are not set"
        );
        eprintln!("skipped: the local stores are not configured");
        return None;
    };
    let (host, port) = address.rsplit_once(':').unwrap();
    let mut config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{DATABASE}")),
        "dima-moderation-tests",
    );
    config.response_timeout = Duration::from_secs(30);
    let dragonfly = match Dragonfly::connect(config, Hooks::default()).await {
        Ok(dragonfly) => dragonfly,
        Err(error) => {
            assert!(
                !required(),
                "the local Dragonfly cannot be reached: {error}"
            );
            return None;
        }
    };
    let database = format!("dima_test_moderation_{}", suffix());
    let mut mongo = MongoConfig::new(uri);
    mongo.database = Some(database.clone());
    let mongo = match MongoStore::connect(&mongo, None).await {
        Ok(store) => store,
        Err(error) => {
            assert!(!required(), "the local MongoDB cannot be reached: {error}");
            return None;
        }
    };
    Some((dragonfly, mongo, database))
}

async fn clean(dragonfly: &Dragonfly, prefix: &str) {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(500));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await.unwrap() {
        keys.extend(page.into_iter().map(|k| String::from_utf8(k).unwrap()));
    }
    for key in keys {
        dragonfly.del(&[&key]).await.unwrap();
    }
}

/// Runs `body` with a fresh store and removes what it wrote, also when it panics.
async fn with_store<F, Fut>(body: F)
where
    F: FnOnce(RulesStore, ManualClock) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some((dragonfly, mongo, database)) = connect().await else {
        return;
    };
    let prefix = format!("test:moderation:{}:", suffix());
    let clock = ManualClock::new(1_794_355_200_000);
    let store = RulesStore {
        dragonfly: dragonfly.clone(),
        mongo: mongo.clone(),
        key_prefix: prefix.clone(),
        clock: Arc::new(clock.clone()),
        config: RulesConfig::default(),
    };
    let result = AssertUnwindSafe(body(store, clock)).catch_unwind().await;
    clean(&dragonfly, &prefix).await;
    let _ = mongo.client().database(&database).drop().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

async fn ttl(store: &RulesStore, key: &str) -> Ttl {
    store
        .dragonfly
        .ttl(&format!("{}{key}", store.key_prefix))
        .await
        .unwrap()
}

#[tokio::test]
async fn racing_offenses_get_consecutive_counts_and_a_decision_counts_once() {
    with_store(|store, _| async move {
        let store = Arc::new(store);
        // 50 decisions about the same viewer at once: each gets its own number.
        let mut counts: Vec<i64> = join_all((0..50).map(|i| {
            let store = Arc::clone(&store);
            async move {
                store
                    .record_offense("c1", "r1", "u1", 3600.0, &format!("d{i}"))
                    .await
                    .unwrap()
            }
        }))
        .await;
        counts.sort_unstable();
        assert_eq!(counts, (1..=50).collect::<Vec<_>>());
        // The same decision delivered 20 times at once counts once.
        let repeats = join_all((0..20).map(|_| {
            let store = Arc::clone(&store);
            async move {
                store
                    .record_offense("c1", "r1", "u1", 3600.0, "same")
                    .await
                    .unwrap()
            }
        }))
        .await;
        assert!(repeats.iter().all(|&count| count == 51), "{repeats:?}");
        assert_eq!(
            store
                .record_offense("c1", "r1", "u1", 3600.0, "next")
                .await
                .unwrap(),
            52
        );
        // The window started with the first offense and is not extended.
        let Ttl::Seconds(window) = ttl(&store, &offense_key("c1", "r1", "u1")).await else {
            panic!()
        };
        assert!((3500..=3600).contains(&window), "{window}");
        let Ttl::Seconds(receipt) = ttl(&store, &offense_receipt_key("same")).await else {
            panic!()
        };
        assert!((86_300..=86_400).contains(&receipt));
        // Other rules and viewers have their own ladders; the window is clamped to 60..86400.
        assert_eq!(
            store
                .record_offense("c1", "r2", "u1", 10.0, "x1")
                .await
                .unwrap(),
            1
        );
        let Ttl::Seconds(short) = ttl(&store, &offense_key("c1", "r2", "u1")).await else {
            panic!()
        };
        assert!((50..=60).contains(&short));
        assert_eq!(
            store
                .record_offense("c1", "r1", "u2", 1e12, "x2")
                .await
                .unwrap(),
            1
        );
        let Ttl::Seconds(long) = ttl(&store, &offense_key("c1", "r1", "u2")).await else {
            panic!()
        };
        assert!(long <= 86_400);
    })
    .await;
}

#[tokio::test]
async fn an_offense_flood_creates_only_expiring_keys() {
    with_store(|store, _| async move {
        let store = Arc::new(store);
        join_all((0..500).map(|i| {
            let store = Arc::clone(&store);
            async move {
                store
                    .record_offense("c1", "r1", &format!("u{i}"), 120.0, &format!("d{i}"))
                    .await
                    .unwrap()
            }
        }))
        .await;
        let mut scan = store
            .dragonfly
            .scan(&format!("{}*", store.key_prefix), Some(500));
        let mut keys = 0;
        while let Some(page) = scan.next_page().await.unwrap() {
            for key in page {
                let key = String::from_utf8(key).unwrap();
                let Ttl::Seconds(left) = store.dragonfly.ttl(&key).await.unwrap() else {
                    panic!("{key} has no lifetime")
                };
                assert!(left <= 86_400);
                keys += 1;
            }
        }
        // One counter per viewer and one receipt per decision.
        assert_eq!(keys, 1000);
    })
    .await;
}

#[tokio::test]
async fn permits_are_their_lifetime() {
    with_store(|store, clock| async move {
        assert!(!store.has_active_permit("c1", "viewer").await.unwrap());
        store.grant_permit("c1", 30, Some("ViEwEr")).await.unwrap();
        assert!(store.has_active_permit("c1", "viewer").await.unwrap());
        assert!(!store.has_active_permit("c1", "other").await.unwrap());
        assert!(!store.has_active_permit("c2", "viewer").await.unwrap());
        let key = format!("{}{}", store.key_prefix, permit_user_key("c1", "viewer"));
        let value = store.dragonfly.get_text(&key).await.unwrap().unwrap();
        assert_eq!(value, (clock.now_ms() + 30_000).to_string());
        let Ttl::Seconds(left) = ttl(&store, &permit_user_key("c1", "viewer")).await else {
            panic!()
        };
        assert!((25..=30).contains(&left));
        // Channel-wide (no login, or an empty one).
        store.grant_permit("c1", 600, Some("")).await.unwrap();
        assert!(store.has_active_permit("c1", "anyone").await.unwrap());
        let Ttl::Seconds(left) = ttl(&store, &permit_channel_key("c1")).await else {
            panic!()
        };
        assert!((595..=600).contains(&left));
        // Two grants racing leave one permit.
        let (a, b) = tokio::join!(
            store.grant_permit("c3", 10, None),
            store.grant_permit("c3", 20, None)
        );
        a.unwrap();
        b.unwrap();
        let Ttl::Seconds(left) = ttl(&store, &permit_channel_key("c3")).await else {
            panic!()
        };
        assert!(left <= 20);
    })
    .await;
}

/// Waits until the server's clock is not within 5 s of a minute boundary (the budget's window).
async fn away_from_minute_boundary(dragonfly: &Dragonfly) {
    for _ in 0..20 {
        let reply = dragonfly.query_value(&redis::cmd("TIME")).await.unwrap();
        let seconds: u64 = match reply {
            redis::Value::Array(parts) => match parts.first() {
                Some(redis::Value::BulkString(bytes)) => {
                    String::from_utf8_lossy(bytes).parse().unwrap()
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        };
        if (5..50).contains(&(seconds % 60)) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn the_review_budget_is_never_overspent() {
    with_store(|store, _| async move {
        away_from_minute_boundary(&store.dragonfly).await;
        let store = Arc::new(store);
        // One channel's flood: 30 of 60 reviews admitted.
        let admitted = join_all((0..60).map(|_| {
            let store = Arc::clone(&store);
            async move { store.claim_spam_review_budget("c1").await.unwrap() }
        }))
        .await;
        assert_eq!(admitted.iter().filter(|&&a| a).count(), 30);
        // 20 channels of 20: the global 300 binds (30 already taken by c1).
        let admitted = join_all((0..400).map(|i| {
            let store = Arc::clone(&store);
            async move {
                store
                    .claim_spam_review_budget(&format!("ch{}", i % 20))
                    .await
                    .unwrap()
            }
        }))
        .await;
        assert_eq!(admitted.iter().filter(|&&a| a).count(), 270);
        for key in spam_budget_keys("c1") {
            let Ttl::Seconds(left) = ttl(&store, &key).await else {
                panic!()
            };
            assert!(left <= 120);
        }
    })
    .await;
}

#[tokio::test]
async fn a_chatter_is_first_exactly_once() {
    with_store(|store, _| async move {
        let store = Arc::new(store);
        let firsts = join_all((0..20).map(|_| {
            let store = Arc::clone(&store);
            async move {
                store
                    .claim_first_observed_message("c1", "u1")
                    .await
                    .unwrap()
            }
        }))
        .await;
        assert_eq!(firsts.iter().filter(|&&f| f).count(), 1);
        assert!(
            !store
                .claim_first_observed_message("c1", "u1")
                .await
                .unwrap()
        );
        let marker = seen_key(&chatter_marker_id("c1", "u1"));
        let Ttl::Seconds(left) = ttl(&store, &marker).await else {
            panic!()
        };
        assert!(left <= 86_400);
        // Cold start: the marker is gone (cutover) but MongoDB still knows the chatter.
        store
            .dragonfly
            .del(&[&format!("{}{marker}", store.key_prefix)])
            .await
            .unwrap();
        assert!(
            !store
                .claim_first_observed_message("c1", "u1")
                .await
                .unwrap()
        );
        assert!(
            store
                .claim_first_observed_message("c1", "u2")
                .await
                .unwrap()
        );
        let stored = store
            .mongo
            .documents("moderation_chatters")
            .find_one(bson::doc! { "_id": chatter_marker_id("c1", "u2") })
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            stored.get("firstSeenAt"),
            Some(bson::Bson::DateTime(_))
        ));
        assert_eq!(stored.len(), 2, "{stored:?}");
    })
    .await;
}

fn decision(
    mode: dima_moderation::rules::DecisionMode,
    message: &str,
    deadline_ms: i64,
) -> dima_moderation::rules::decisions::NewDecision {
    use dima_moderation::rules::advanced::ModerationMatch;
    dima_moderation::rules::decisions::NewDecision {
        channel_id: "c1".into(),
        user_id: "u1".into(),
        username: "viewer".into(),
        message_id: message.into(),
        message_text: "zorp 😀".into(),
        rule_id: "r1".into(),
        rule: bson::doc! {
            "id": "r1", "type": "blacklist", "terms": ["zorp"],
            "semantic": { "enabled": true, "policy": "No zorp." },
            "variations": { "mode": "common", "allowSpaces": true, "entries": [
                bson::serialize_to_bson(&dima_moderation::rules::variations::build_variation("rinn", &serde_json::json!(["rin"])).unwrap()).unwrap()
            ] },
        },
        settings_version: 3.0,
        matches: vec![ModerationMatch {
            matcher_id: "literal".into(),
            text: "zorp".into(),
            start: 0,
            end: 4,
        }],
        context: Vec::new(),
        mode,
        deadline_ms,
        review_source: None,
    }
}

#[tokio::test]
async fn decisions_are_created_once_and_semantic_waits_are_fenced() {
    use dima_moderation::rules::DecisionMode;
    use dima_moderation::rules::decisions::moderation_decision_id;
    with_store(|store, clock| async move {
        let now = clock.now_ms();
        let store = Arc::new(store);
        // Two deliveries of the same message create one decision.
        let input = decision(DecisionMode::Literal, "m1", now + 4000);
        let (a, b) = tokio::join!(store.create_moderation_decision(&input), store.create_moderation_decision(&input));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a, b);
        assert_eq!(a.get_str("_id").unwrap(), moderation_decision_id("c1", "m1", "r1"));
        assert_eq!(a.get_str("state").unwrap(), "completed");
        assert_eq!(a.get_str("verdict").unwrap(), "violation");
        assert_eq!(a.get_str("status").unwrap(), "matched");
        assert_eq!(a.get_str("reviewSource").unwrap(), "rule");
        assert_eq!(a.get_str("model").unwrap(), "");
        assert_eq!(a.get_document("consequence").unwrap().get_str("status").unwrap(), "none");
        let expires = a.get_datetime("expiresAt").unwrap().timestamp_millis();
        assert_eq!(expires, now + 180 * 86_400_000);
        // The rule is stored with its variations compiled for spaces.
        let entry = a.get_document("rule").unwrap().get_document("variations").unwrap().get_array("entries").unwrap()[0].as_document().unwrap().clone();
        assert_eq!(entry.get_bool("allowSpaces").unwrap(), true);
        assert!(entry.get("symbolVersion").is_none());
        assert_eq!(a.get_array("matches").unwrap()[0].as_document().unwrap().get("end"), Some(&bson::Bson::Int32(4)));

        // A semantic decision the worker completes in time.
        let pending = store.create_moderation_decision(&decision(DecisionMode::Semantic, "m2", now + 4000)).await.unwrap();
        assert_eq!(pending.get_str("state").unwrap(), "pending");
        assert_eq!(pending.get_document("rule").unwrap().get_document("semantic").unwrap().get("thresholdPercent"), Some(&bson::Bson::Int32(85)));
        let id = pending.get_str("_id").unwrap().to_owned();
        let worker = {
            let store = Arc::clone(&store);
            let id = id.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                store.mongo.documents("moderation_decisions")
                    .update_one(bson::doc! { "_id": &id }, bson::doc! { "$set": { "state": "completed", "verdict": "violation", "status": "scored" } })
                    .await.unwrap();
            }
        };
        let (done, ()) = tokio::join!(store.await_semantic_decision(&id, now + 4000), worker);
        assert_eq!(done.unwrap().unwrap().get_str("verdict").unwrap(), "violation");

        // Past its deadline, a pending decision is fenced to a timeout.
        let late = store.create_moderation_decision(&decision(DecisionMode::Semantic, "m3", now - 1)).await.unwrap();
        let fenced = store.await_semantic_decision(late.get_str("_id").unwrap(), now - 1).await.unwrap().unwrap();
        assert_eq!(fenced.get_str("status").unwrap(), "timeout");
        assert_eq!(fenced.get_str("verdict").unwrap(), "uncertain");
        assert_eq!(fenced.get_document("consequence").unwrap().get_str("status").unwrap(), "allowed_fallback");
        // A completed one is never overwritten by the fence.
        let completed = store.await_semantic_decision(&id, now - 1).await.unwrap().unwrap();
        assert_eq!(completed.get_str("status").unwrap(), "scored");
    })
    .await;
}
