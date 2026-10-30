#![cfg(feature = "ai-credit-reader")]
use dima_rust::utils::{
    ai_credit_reader::cached_payload,
    lossless_json::{JsonValue, parse_json},
};

fn cached(raw: &str, verified: bool) -> JsonValue {
    cached_payload(&parse_json(raw).unwrap(), verified)
        .unwrap()
        .unwrap()
}

#[test]
fn v3_cache_validation_and_verified_status() {
    assert!(
        cached_payload(
            &parse_json(r#"{"version":2,"used":0,"limit":25000}"#).unwrap(),
            true
        )
        .unwrap()
        .is_none()
    );
    assert!(
        cached_payload(
            &parse_json(r#"{"version":3,"used":"0","limit":25000}"#).unwrap(),
            true
        )
        .unwrap()
        .is_none()
    );
    let value = cached(
        r#"{"version":3,"used":7,"limit":25000,"available":false,"status":"unavailable","updatedAt":"fixed"}"#,
        true,
    );
    assert_eq!(value.get("balance"), Some(&JsonValue::Number(24993.0)));
    assert_eq!(value.get("available"), Some(&JsonValue::Bool(false)));
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String("unavailable".into()))
    );
    let value = cached(
        r#"{"version":3,"used":7,"limit":25000,"available":false,"status":"unavailable","updatedAt":"fixed"}"#,
        false,
    );
    assert_eq!(value.get("available"), Some(&JsonValue::Bool(true)));
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String("available".into()))
    );
}

#[test]
fn partial_cache_defaults_and_preserves_wire_values() {
    let value = cached(
        r#"{"version":3,"used":8,"limit":5,"balance":null,"meterId":"\ud800","updatedAt":"fixed"}"#,
        true,
    );
    assert_eq!(value.get("balance"), Some(&JsonValue::Number(0.0)));
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String("unavailable".into()))
    );
    assert!(value.to_json_string().contains(r#""meterId":"\ud800""#));
    let value = cached(
        r#"{"version":3,"used":8,"limit":5,"balance":"-1","updatedAt":"fixed"}"#,
        false,
    );
    assert_eq!(value.get("balance"), Some(&JsonValue::Number(0.0)));
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String("exhausted".into()))
    );
}

#[test]
fn source_cache_status_precedes_positive_balance() {
    let value = cached(
        r#"{"version":3,"used":0,"limit":25000,"balance":100,"available":true,"status":"exhausted","updatedAt":"fixed"}"#,
        true,
    );
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String("exhausted".into()))
    );
    assert_eq!(value.get("balance"), Some(&JsonValue::Number(100.0)));
}

// This integration test requires dedicated fixture aliases on a private network;
// the parent must provision/identify the resources and run it only in the capped
// isolated harness. No environment-derived production client or credential is used.
#[tokio::test]
#[ignore = "requires private task-owned Mongo and Redis fixtures"]
async fn private_mongo_redis_and_loopback_provider() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    use dima_rust::utils::{
        ai_credit_projection::PlanTier,
        ai_credit_reader::{AiCreditReader, CreditOwner},
        plan_cache_fence::{credits_cache_key, exhaustion_cache_keys, plan_cache_fence_key},
        polar::{PolarClient, PolarConfig, PolarPolicy},
    };
    use futures_util::FutureExt;
    use mongodb::{
        Client,
        bson::{DateTime, doc, oid::ObjectId},
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    assert_eq!(
        std::env::var("AI_CREDIT_READER_FIXTURE_ACK").as_deref(),
        Ok("private-task-owned-only")
    );
    assert_eq!(
        std::env::var("AI_CREDIT_READER_MONGO_URL").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("AI_CREDIT_READER_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("AI_CREDIT_READER_FIXTURE_NAMESPACE")
        .expect("unique task namespace required");
    assert!(namespace.starts_with("credit-reader-fixture-") && namespace.len() <= 55);
    assert!(
        namespace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let id = ObjectId::new();
    let channel = format!("{namespace}-{}", id.to_hex());
    let client = Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("credit_reader_{}", id.to_hex()));
    // Never drop a pre-existing database: the generated task namespace must be empty.
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let users = db.collection::<mongodb::bson::Document>("users");
    let mut redis = redis::aio::ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").unwrap(),
    )
    .await
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let mode = Arc::new(AtomicUsize::new(0));
    let thread_stop = stop.clone();
    let thread_mode = mode.clone();
    let server = std::thread::spawn(move || {
        while !thread_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
                    let mut buffer = [0; 4096];
                    let _ = socket.read(&mut buffer);
                    let provider_mode = thread_mode.load(Ordering::SeqCst);
                    if provider_mode == 3 {
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    let (status, body) = match provider_mode {
                        0 => (
                            "200 OK",
                            r#"{"active_meters":[{"meter_id":"5103e79b-fd74-4ba8-a287-f95574f9addf","consumed_units":42}]}"#,
                        ),
                        1 => ("200 OK", r#"{"active_meters":[]}"#),
                        _ => ("503 Service Unavailable", "{}"),
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes());
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::park_timeout(Duration::from_millis(2))
                }
                Err(_) => break,
            }
        }
    });
    let outcome = std::panic::AssertUnwindSafe(async {
        let polar = PolarClient::new(PolarConfig::new(&base, "private-fixture-token").unwrap(), PolarPolicy::Billing).unwrap();
        let reader = AiCreditReader::new(redis.clone(), db.clone(), polar, Duration::from_secs(3)).unwrap();
        let owner = CreditOwner { tier: Some(PlanTier::Premium), customer_id: Some("customer".into()) };
        let [canonical, legacy] = exhaustion_cache_keys(&channel);
        let cache = credits_cache_key(&channel);
        let fence = plan_cache_fence_key(&channel);
        users.insert_one(doc! {"_id":id,"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"free","polar_sh_customer_id":"customer","polar_plan_event_at":DateTime::from_millis(1),"polar_plan_event_key":"event"}).await.unwrap();
        let value = reader.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("used"), Some(&JsonValue::Number(42.0)));
        assert_eq!(value.get("limit"), Some(&JsonValue::Number(200000.0)));
        let _: () = redis::cmd("DEL").arg(&cache).query_async(&mut redis).await.unwrap();
        let _: () = redis::cmd("SET").arg(&fence).arg("0000000000001:event").query_async(&mut redis).await.unwrap();
        let value = reader.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("limit"), Some(&JsonValue::Number(25000.0)));
        let _: () = redis::cmd("DEL").arg(&cache).query_async(&mut redis).await.unwrap();
        let wrong = CreditOwner { tier: Some(PlanTier::Pro), customer_id: Some("wrong".into()) };
        let value = reader.get_ai_credits(&wrong, &channel, true).await.unwrap();
        assert_eq!(value.get("status"), Some(&JsonValue::String("unavailable".into())));
        mode.store(1, Ordering::SeqCst);
        let value = reader.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("status"), Some(&JsonValue::String("unavailable".into())));
        let _: () = redis::cmd("DEL").arg(&[&cache, &fence]).query_async(&mut redis).await.unwrap();
        mode.store(2, Ordering::SeqCst);
        let _: () = redis::cmd("SET").arg(&legacy).arg("true").query_async(&mut redis).await.unwrap();
        let value = reader.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("status"), Some(&JsonValue::String("exhausted".into())));
        let _: () = redis::cmd("DEL").arg(&legacy).query_async(&mut redis).await.unwrap();
        let _: () = redis::cmd("SET").arg(&canonical).arg("true").query_async(&mut redis).await.unwrap();
        let value = reader.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("balance"), Some(&JsonValue::Number(0.0)));
        let _: usize = redis::cmd("DEL").arg(&[&cache, &fence, &canonical, &legacy]).query_async(&mut redis).await.unwrap();
        mode.store(3, Ordering::SeqCst);
        let timed = reader.clone().with_provider_timeout(Duration::from_millis(20)).unwrap();
        let value = timed.get_ai_credits(&owner, &channel, true).await.unwrap();
        assert_eq!(value.get("status"), Some(&JsonValue::String("unavailable".into())));
        assert_eq!(value.get("limit"), Some(&JsonValue::Number(200000.0)));

        // Replay every emitted source case against real isolated adapters. The
        // parent prepares this JSON by running the pinned source oracle offline.
        use sha2::{Digest, Sha256};
        let corpus_path = std::env::var("AI_CREDIT_READER_ORACLE_JSON").expect("source oracle corpus path required");
        let corpus_bytes = std::fs::read(corpus_path).unwrap();
        let corpus_pin = std::env::var("AI_CREDIT_READER_ORACLE_SHA256").expect("independent fixture SHA-256 required");
        assert_eq!(format!("{:x}", Sha256::digest(&corpus_bytes)), corpus_pin);
        let corpus: serde_json::Value = serde_json::from_slice(&corpus_bytes).unwrap();
        let hashes = &corpus["hashes"];
        assert_eq!(hashes["source"], "2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f");
        assert_eq!(hashes["fenceSource"], "2639f0021342fba252e7c9ef331dc42cdb9cc4eb19b5e063eda7d167ac7787ee");
        assert_eq!(hashes["node"], "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108");
        assert_eq!(hashes["oracle"].as_str().unwrap(), format!("{:x}", Sha256::digest(include_bytes!("fixtures/ai_credit_reader_reference.cjs"))));
        let records = corpus["records"].as_array().unwrap();
        assert_eq!(records.len(), 13);
        let fixed = std::time::UNIX_EPOCH + Duration::from_millis(1767323045000);
        let reader = reader.with_fixed_clock(fixed);
        for record in records {
            let input = &record["input"];
            let name = record["name"].as_str().unwrap();
            let _: usize = redis::cmd("DEL").arg(&[&cache, &fence, &canonical, &legacy]).query_async(&mut redis).await.unwrap();
            users.delete_one(doc! {"_id":id}).await.unwrap();
            if let Some(raw) = input["cache"].as_str() {
                let _: () = redis::cmd("SET").arg(&cache).arg(raw).query_async(&mut redis).await.unwrap();
            }
            if let Some(raw) = input["fence"].as_str() {
                let _: () = redis::cmd("SET").arg(&fence).arg(raw).query_async(&mut redis).await.unwrap();
            }
            for (field, key) in [("canonical", &canonical), ("legacy", &legacy)] {
                if input[field].as_i64() == Some(1) {
                    let _: () = redis::cmd("SET").arg(key).arg("true").query_async(&mut redis).await.unwrap();
                }
            }
            if input["current"].is_object() {
                let current = &input["current"];
                users.insert_one(doc! {"_id":id,"accounts":[{"type":"twitch","id":&channel}],
                    "plan_tier":current["plan_tier"].as_str().unwrap(),
                    "polar_sh_customer_id":current["polar_sh_customer_id"].as_str().unwrap(),
                    "polar_plan_event_at":DateTime::from_millis(1),
                    "polar_plan_event_key":current["polar_plan_event_key"].as_str().unwrap()}).await.unwrap();
            }
            let provider_mode = if input["failure"] == true { 2 } else if input["state"]["active_meters"].as_array().is_some_and(|a| a.is_empty()) { 1 } else { 0 };
            mode.store(provider_mode, Ordering::SeqCst);
            let tier = match input["tier"].as_str().unwrap_or("premium") { "free" => PlanTier::Free, "pro" => PlanTier::Pro, _ => PlanTier::Premium };
            let owner = CreditOwner { tier: Some(tier), customer_id: Some(input["customer"].as_str().unwrap_or("customer").to_owned()) };
            let actual = reader.get_ai_credits(&owner, &channel, input["verified"].as_bool().unwrap_or(false)).await.unwrap();
            let expected = parse_json(record["wire"].as_str().unwrap()).unwrap();
            assert_eq!(actual, expected, "source replay {name}");
            assert_eq!(actual.to_json_string(), expected.to_json_string(), "wire replay {name}");
        }
    }).catch_unwind().await;
    // Only exact task keys and the freshly created unique database, even after panic.
    stop.store(true, Ordering::SeqCst);
    server.thread().unpark();
    server.join().unwrap();
    let [canonical, legacy] = exhaustion_cache_keys(&channel);
    let cleanup_redis: redis::RedisResult<usize> = redis::cmd("DEL")
        .arg(&[
            credits_cache_key(&channel),
            plan_cache_fence_key(&channel),
            canonical,
            legacy,
        ])
        .query_async(&mut redis)
        .await;
    let cleanup_mongo = db.drop().await;
    cleanup_redis.unwrap();
    cleanup_mongo.unwrap();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
