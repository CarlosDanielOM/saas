#![allow(clippy::expect_used)]
//! Every Helix wrapper is exercised with a hung server and a dropped connection.
mod support;
use anyhow::Result;
use dima_core::{ManualClock, SecretString, Shutdown, SystemRandom};
use dima_http::{HttpClient, testing::MockResponse};
use dima_twitch::{
    TWITCH_BOT_ACCOUNT_ID, Twitch, TwitchConfig, TwitchDeps,
    functions::{chats::*, clips::*, search::*, users::*},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use support::*;
async fn call(t: &Twitch, op: usize, store: &ClipStore<'_>) -> Value {
    match op {
        0 => serde_json::to_value(send_announcement(t, "123", "456", "text", None).await),
        1 => serde_json::to_value(send_shoutout(t, "123", "789", "456").await),
        2 => serde_json::to_value(clear_chat(t, "123", "456").await),
        3 => serde_json::to_value(delete_message(t, "msg", "123", "456").await),
        4 => serde_json::to_value(get_chatters(t, "123", "456").await),
        5 => serde_json::to_value(get_chat_settings(t, "123", "456").await),
        6 => serde_json::to_value(get_only_emotes(t, "123", "456").await),
        7 => serde_json::to_value(set_only_emotes(t, "123", true, "456").await),
        8 => serde_json::to_value(get_user_color(t, "123").await),
        9 => serde_json::to_value(get_pinned_chat_message(t, "123", "456").await),
        10 => serde_json::to_value(pin_chat_message(t, "123", "msg", None, "456").await),
        11 => serde_json::to_value(update_pinned_chat_message(t, "123", "msg", None, "456").await),
        12 => serde_json::to_value(unpin_chat_message(t, "123", "msg", "456").await),
        13 => serde_json::to_value(create_clip(t, "123", CreateClipOptions::default()).await),
        14 => serde_json::to_value(get_clip(t, "clip").await),
        15 => serde_json::to_value(get_channel_clips(t, store, "123", None, true).await),
        16 => serde_json::to_value(search_categories(t, "test").await),
        17 => serde_json::to_value(search_game_by_id(t, "1").await),
        18 => serde_json::to_value(search_game_by_name(t, "test").await),
        19 => serde_json::to_value(search_game_by_igdb_id(t, "1").await),
        20 => serde_json::to_value(get_twitch_user_by_id(t, "123").await),
        21 => serde_json::to_value(get_twitch_user_by_login(t, "test", false).await),
        _ => serde_json::to_value(get_scopes(t, "123").await),
    }
    .expect("serialize")
}
#[tokio::test]
async fn timeouts_and_dropped_connections_never_escape_or_retry() -> Result<()> {
    with_stores(|stores| async move {
        insert_user(
            &stores,
            user_document(
                TWITCH_BOT_ACCOUNT_ID,
                "bot",
                "access",
                "refresh",
                Some(NOW_MS / 1000 + 3600),
            ),
        )
        .await?;
        let drop_connection = Arc::new(AtomicBool::new(false));
        let drop = drop_connection.clone();
        let server = twitch_mock(Default::default(), move |_, _| {
            if drop.load(Ordering::Relaxed) {
                MockResponse::drop_connection()
            } else {
                MockResponse::json(200, r#"{"data":[]}"#).delay(Duration::from_millis(200))
            }
        })
        .await?;
        let shutdown = Shutdown::new();
        let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
        config.keys = stores.keys.clone();
        config.timings = fast_timings();
        let events = Arc::new(dima_twitch::events::RecordingEvents::default());
        let t = Twitch::new(
            config,
            TwitchDeps {
                http: HttpClient::builder().shutdown(shutdown.clone()).build()?,
                exchange_http: dima_twitch::exchange_client(HttpClient::builder())?,
                helix: server.provider(
                    dima_twitch::helix_provider(CLIENT_ID)
                        .timeout(Duration::from_millis(25))
                        .headers_timeout(Duration::from_millis(25)),
                )?,
                oauth: server.provider(dima_twitch::oauth_provider())?,
                mongo: stores.mongo.clone(),
                dragonfly: stores.dragonfly.clone(),
                cipher: cipher(),
                clock: Arc::new(ManualClock::new(NOW_MS)),
                random: Arc::new(SystemRandom),
                events: events.clone(),
                shutdown,
            },
        );
        t.load_streamers().await?;
        assert!(t.app_token().await.is_some());
        let store = ClipStore {
            dragonfly: &stores.dragonfly,
            prefix: stores.keys.prefix(),
        };
        for dropped in [false, true] {
            drop_connection.store(dropped, Ordering::Relaxed);
            for op in 0..23 {
                let before = server.requests().len();
                let result = call(&t, op, &store).await;
                assert_eq!(result["error"], true, "operation {op}: {result}");
                assert_eq!(
                    result["message"],
                    json!("Internal server error"),
                    "operation {op}"
                );
                assert_eq!(server.requests().len(), before + 1, "operation {op}");
            }
        }
        assert_no_secrets(&events, &["access", "refresh"]);
        t.shutdown().await;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn missing_bot_credentials_preserve_reference_messages_and_types() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(Default::default(), helix_ok).await?;
        let p = process(&stores, &server, fast_timings())?;
        let store = ClipStore {
            dragonfly: &stores.dragonfly,
            prefix: stores.keys.prefix(),
        };
        for op in [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13] {
            let result = call(&p.twitch, op, &store).await;
            assert_eq!(result["error"], true);
            assert_eq!(result["status"], 403);
            assert_eq!(
                result["message"],
                "Bot's account does not have the permissions required"
            );
            assert_eq!(
                result["type"],
                if op == 13 {
                    json!("permission_error")
                } else if [5, 6].contains(&op) {
                    Value::Null
                } else {
                    json!("error")
                }
            );
        }
        assert!(
            server.requests().is_empty(),
            "missing credential never sends a Helix request"
        );
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}
