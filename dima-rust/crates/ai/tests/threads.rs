use dima_ai::threads::*;
use dima_core::{ManualClock, Random, RandomError};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
#[derive(Debug)]
struct Sequence(AtomicU8);
impl Random for Sequence {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), RandomError> {
        bytes.fill(0);
        if let Some(b) = bytes.last_mut() {
            *b = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        }
        Ok(())
    }
}
#[tokio::test]
async fn reference_dragonfly_snapshots_and_router() -> anyhow::Result<()> {
    let required = std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1");
    let address = std::env::var("DIMA_TEST_DRAGONFLY").unwrap_or("127.0.0.1:6379".into());
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("store address"))?;
    let config =
        DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/5")), "ai-tests");
    let cache = match Dragonfly::connect(config, Hooks::default()).await {
        Ok(c) => c,
        Err(e) => {
            if required {
                return Err(e.into());
            }
            return Ok(());
        }
    };
    let clock = Arc::new(ManualClock::new(1700000000000));
    let store = Store {
        cache: cache.clone(),
        clock: clock.clone(),
        random: Arc::new(Sequence(AtomicU8::new(0))),
        prefix: format!("ai-rust-{}:", std::process::id()),
    };
    let fixture: Vec<Value> = serde_json::from_str(include_str!("threads_reference.json"))?;
    let mut keys = vec![store.channel_key("c"), store.user_key("c", "u")];
    for n in 1..=8 {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        keys.push(store.meta_key("c", &id));
        keys.push(store.turns_key("c", &id));
    }
    let task_store = store.clone();
    let result = tokio::spawn(async move {
        let store = task_store;
        let limits = get_thread_limits_for_tier(Tier::Free);
        let m = store
            .create_thread("c", "u", "Alice", "I love chess", 1700000000000)
            .await?;
        store
            .touch_thread_indexes("c", "u", &m.thread_id, 1700000000000)
            .await?;
        for n in 0..22 {
            store
                .append_thread_turn(
                    "c",
                    &m.thread_id,
                    &Turn {
                        role: "user".into(),
                        user_id: Some("u".into()),
                        username: Some("Alice".into()),
                        message: format!("message {n}"),
                        timestamp: 1700000000000 + n,
                        source_message_id: None,
                        delivered: None,
                    },
                    limits,
                )
                .await?;
        }
        store
            .append_thread_turn(
                "c",
                &m.thread_id,
                &Turn {
                    role: "assistant".into(),
                    user_id: None,
                    username: Some("DomDimaBot".into()),
                    message: "😀 é مرحبا".into(),
                    timestamp: 1700000000023,
                    source_message_id: None,
                    delivered: Some(false),
                },
                limits,
            )
            .await?;
        assert_eq!(
            json!(
                store
                    .get_thread_prompt_context("c", &m.thread_id, 10)
                    .await?
            ),
            fixture[0]["context"]
        );
        compare(&store, &fixture[0]).await?;
        for n in 1..=4 {
            let m = store
                .create_thread("c", "u", "Alice", &format!("seed {n}"), 1700000000100 + n)
                .await?;
            store
                .touch_thread_indexes("c", "u", &m.thread_id, 1700000000100 + n)
                .await?;
        }
        assert_eq!(store.enforce_thread_limits("c", "u", limits).await?, (2, 0));
        compare(&store, &fixture[1]).await?;
        let p = ResolveInput {
            channel_id: "c".into(),
            user_id: "u".into(),
            username: "Alice".into(),
            message: "a follow up".into(),
            plan_tier: Tier::Free,
            source_message_id: None,
        };
        clock.set(1700000000200);
        let reused = store.resolve_user_thread_for_message(&p).await?;
        assert!(!reused.created_new_thread);
        assert_eq!(reused.selected_score, 1.0);
        // Beyond recency horizon with no lexical overlap creates a new thread.
        clock.set(1700000000000 + 86400001);
        let mut p = p;
        p.message = "unrelated astronomy galaxies".into();
        let fresh = store.resolve_user_thread_for_message(&p).await?;
        assert!(fresh.created_new_thread);
        Ok::<(), anyhow::Error>(())
    })
    .await;
    cache
        .del(&keys.iter().map(String::as_str).collect::<Vec<_>>())
        .await?;
    for key in keys {
        assert!(cache.get_text(&key).await.is_err() || cache.exists(&[&key]).await? == 0);
    }
    result?
}
#[allow(clippy::unwrap_used, clippy::panic)]
async fn compare(store: &Store, snapshot: &Value) -> anyhow::Result<()> {
    for (key, expected) in snapshot["values"].as_object().unwrap() {
        let key = format!("{}{key}", store.prefix);
        let ttl: i64 = store.cache.query(redis::cmd("TTL").arg(&key)).await?;
        assert!((86395..=86400).contains(&ttl));
        let actual = match expected["type"].as_str().unwrap() {
            "string" => serde_json::from_str::<Value>(&store.cache.get_text(&key).await?.unwrap())?,
            "list" => {
                let rows: Vec<String> = store
                    .cache
                    .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                    .await?;
                Value::Array(
                    rows.iter()
                        .map(|s| serde_json::from_str(s).unwrap())
                        .collect(),
                )
            }
            "zset" => {
                let rows: Vec<(String, f64)> = store
                    .cache
                    .query(
                        redis::cmd("ZRANGE")
                            .arg(&key)
                            .arg(0)
                            .arg(-1)
                            .arg("WITHSCORES"),
                    )
                    .await?;
                json!(
                    rows.into_iter()
                        .map(|(value, score)| json!({"value":value,"score":score}))
                        .collect::<Vec<_>>()
                )
            }
            _ => panic!("key type"),
        };
        assert_eq!(
            dima_text::to_js_json(&actual),
            dima_text::to_js_json(&expected["data"]),
            "key {key}"
        );
    }
    Ok(())
}
