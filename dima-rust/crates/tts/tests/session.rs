#![allow(clippy::unwrap_used)]
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks, SetOptions, Ttl};
use dima_tts::session::*;
use serde_json::{Value, json};
#[tokio::test]
async fn actual_lua_session_reset_preserves_stream_identity() {
    let required = std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1");
    let endpoint = std::env::var("DIMA_TEST_DRAGONFLY").unwrap_or_else(|_| "127.0.0.1:6379".into());
    let Some((host, port)) = endpoint.rsplit_once(':') else {
        assert!(!required);
        return;
    };
    assert!(matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
    let mut config =
        DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/2")), "tts-tests");
    config.reconnect_retries = 0;
    let store = match Dragonfly::connect(config, Hooks::default()).await {
        Ok(s) => s,
        Err(e) => {
            assert!(!required, "required Dragonfly: {e}");
            return;
        }
    };
    let channel = format!(
        "test-tts-{}",
        dima_core::Random::uuid_v4(&dima_core::SystemRandom).unwrap()
    );
    let result = exercise(&store, &channel).await;
    let mut scan = store.scan(&format!("twitch:{channel}:tts:*"), Some(100));
    while let Some(keys) = scan.next_page().await.unwrap() {
        let refs: Vec<_> = keys
            .iter()
            .map(|k| std::str::from_utf8(k).unwrap())
            .collect();
        store.del(&refs).await.unwrap();
    }
    result.unwrap();
}
async fn exercise(store: &Dragonfly, channel: &str) -> anyhow::Result<()> {
    enqueue(
        store,
        channel,
        "first",
        20.0,
        &json!({"speechID":"first"}).to_string(),
    )
    .await?;
    enqueue(
        store,
        channel,
        "minimum",
        5.0,
        &json!({"speechID":"minimum"}).to_string(),
    )
    .await?;
    assert_eq!(store.ttl(&key(channel, "queue")).await?, Ttl::NoExpiry);
    let first = pop(store, channel).await?.unwrap();
    assert_eq!(first.value, "minimum");
    assert_eq!(first.session, None);
    let reference: Value = serde_json::from_str(include_str!("session.json"))?;
    let payload: Value = serde_json::from_str(&first.payload)?;
    assert_eq!(payload, reference["first"]["payload"]);
    assert_eq!(first.value, reference["first"]["value"]);
    assert_eq!(
        first.session,
        serde_json::from_value::<Option<String>>(reference["first"]["session"].clone())?
    );
    assert!(payload["queueSession"].is_null());
    let orphan = key(channel, "queue:data:orphan");
    store.set(&orphan, b"{}", SetOptions::default()).await?;
    store
        .set(&key(channel, "processing"), b"active", SetOptions::ex(150))
        .await?;
    store
        .set(
            &key(channel, "queue:data:active"),
            b"{}",
            SetOptions::default(),
        )
        .await?;
    reset(store, channel, "new-session", std::slice::from_ref(&orphan)).await?;
    assert_eq!(
        store.get_text(&key(channel, "session")).await?.as_deref(),
        Some("new-session")
    );
    assert_eq!(store.ttl(&key(channel, "session")).await?, Ttl::NoExpiry);
    assert_eq!(store.zcard(&key(channel, "queue")).await?, 0);
    assert_eq!(store.get(&orphan).await?, None);
    assert_eq!(store.get(&key(channel, "queue:data:first")).await?, None);
    assert_eq!(store.get(&key(channel, "queue:data:active")).await?, None);
    enqueue(store, channel, "first", 1.0, "{\"speechID\":\"first\"}").await?;
    let next = pop(store, channel).await?.unwrap();
    assert_eq!(next.session.as_deref(), Some("new-session"));
    assert_eq!(
        serde_json::from_str::<Value>(&next.payload)?["queueSession"],
        "new-session"
    );
    assert!(pop(store, channel).await?.is_none());
    Ok(())
}
