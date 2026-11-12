#![allow(clippy::expect_used)]
//! Clip HTTP, cache and queue contracts on disposable stores.
mod support;
use anyhow::Result;
use dima_core::{ManualClock, SystemRandom};
use dima_http::{guard::BoxFuture, testing::MockResponse};
use dima_store::dragonfly::SetOptions;
use dima_twitch::{TWITCH_BOT_ACCOUNT_ID, functions::clips::*};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
#[derive(Default)]
struct Publisher(Mutex<Vec<ClipRequestData>>);
impl ClipPublisher for Publisher {
    fn publish<'a>(
        &'a self,
        _channel: &'a str,
        data: &'a ClipRequestData,
    ) -> BoxFuture<'a, Result<(), ClipPublishError>> {
        self.0.lock().expect("published").push(data.clone());
        Box::pin(async { Ok(()) })
    }
}
fn clip() -> Value {
    json!({"id":"clip","url":"https://clips.twitch.tv/clip","embed_url":"","broadcaster_id":"123","creator_id":"456","video_id":"","created_at":"2026-11-11T00:00:00Z","thumbnail_url":"","duration":30.0,"vod_offset":null,"is_mutable":false,"game_id":"1","title":"Á🙂אב"})
}
#[tokio::test]
async fn clip_http_cache_and_queue() -> Result<()> {
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
        let reply = Arc::new(Mutex::new((
            202,
            json!({"data":[{"id":"new-clip","edit_url":"https://clips.twitch.tv/edit"}]})
                .to_string(),
        )));
        let source = reply.clone();
        let server = twitch_mock(Arc::default(), move |_, _| {
            let (s, b) = source.lock().expect("reply").clone();
            MockResponse::json(s, &b)
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        let t = &process.twitch;
        let created = create_clip(
            t,
            "123",
            CreateClipOptions {
                duration: Some(30.5),
                title: Some("  Á🙂אב  "),
            },
        )
        .await;
        assert_eq!(created.clip_id.as_deref(), Some("new-clip"));
        let req = server.requests().into_iter().last().expect("request");
        assert_eq!(req.method, "POST");
        assert_eq!(
            req.target,
            "/helix/clips?broadcaster_id=123&duration=30.5&title=%C3%81%F0%9F%99%82%D7%90%D7%91"
        );
        assert!(req.body.is_empty());
        assert_helix_headers(&req);
        for (status, body, message) in [
            (404, "{", "Broadcaster must be live to create a clip"),
            (
                202,
                r#"{"data":[]}"#,
                "Twitch accepted clip request but did not return a clip ID.",
            ),
            (
                401,
                r#"{"error":"Unauthorized","message":"denied"}"#,
                "denied",
            ),
            (503, r#"{"error":"Error","message":"later"}"#, "later"),
            (202, "{", "Internal server error"),
        ] {
            *reply.lock().expect("reply") = (status, body.into());
            assert_eq!(
                create_clip(t, "123", CreateClipOptions::default())
                    .await
                    .response
                    .message
                    .as_deref(),
                Some(message)
            );
        }
        for (status, body, message) in [
            (200, json!({"data":[clip()]}).to_string(), "Success"),
            (200, r#"{"data":[]}"#.into(), "Clip not found"),
            (
                401,
                r#"{"error":"Unauthorized","message":"denied","status":401}"#.into(),
                "denied",
            ),
            (
                500,
                r#"{"error":"Error","message":"later","status":500}"#.into(),
                "later",
            ),
            (200, "{".into(), "Internal server error"),
        ] {
            *reply.lock().expect("reply") = (status, body);
            let result = get_clip(t, "clip").await;
            assert_eq!(result.message.as_deref(), Some(message));
            if let Some(clip) = result.data {
                assert_eq!(clip.extra["game_id"], "1");
            }
            let req = server.requests().into_iter().last().expect("request");
            assert_eq!(req.method, "GET");
            assert_eq!(req.target, "/helix/clips?id=clip");
            assert!(req.body.is_empty());
            assert_helix_headers(&req);
        }
        assert_eq!(get_clip(t, "").await.status, Some(400));
        let store = ClipStore {
            dragonfly: &stores.dragonfly,
            prefix: stores.keys.prefix(),
        };
        *reply.lock().expect("reply") = (200, json!({"data":[clip()]}).to_string());
        assert_eq!(
            get_channel_clips(t, &store, "123", None, false)
                .await
                .message
                .as_deref(),
            Some("Success")
        );
        let req = server.requests().into_iter().last().expect("request");
        assert_eq!(req.target, "/helix/clips?broadcaster_id=123&first=50");
        assert_helix_headers(&req);
        let count = server.requests().len();
        assert_eq!(
            get_channel_clips(t, &store, "123", Some(1.0), false)
                .await
                .message
                .as_deref(),
            Some("Success (from cache)")
        );
        assert_eq!(count, server.requests().len());
        for (status, body, message) in [
            (200, r#"{"data":[]}"#, "Success"),
            (
                401,
                r#"{"error":"Unauthorized","message":"denied","status":401}"#,
                "denied",
            ),
            (
                503,
                r#"{"error":"Error","message":"later","status":503}"#,
                "later",
            ),
            (200, "{", "Internal server error"),
        ] {
            *reply.lock().expect("reply") = (status, body.into());
            assert_eq!(
                get_channel_clips(t, &store, "123", Some(0.0), true)
                    .await
                    .message
                    .as_deref(),
                Some(message)
            );
            assert_eq!(
                server.requests().last().expect("request").target,
                "/helix/clips?broadcaster_id=123"
            );
        }
        let publisher = Publisher::default();
        let clock = ManualClock::new(NOW_MS);
        let data = ClipRequestData {
            clip_id: Some("fixture".into()),
            timestamp: None,
            fields: serde_json::Map::new(),
        };
        assert!(!check_clip_connection(&store, "123").await);
        assert_eq!(
            request_clip(
                &store,
                &publisher,
                &clock,
                &SystemRandom,
                "123",
                data.clone(),
                false
            )
            .await
            .response
            .message
            .as_deref(),
            Some("OBS not connected - cannot show clips")
        );
        let connected = format!("{}twitch:123:clips:connected", store.prefix);
        stores
            .dragonfly
            .set(&connected, b"true", SetOptions::default())
            .await?;
        assert!(check_clip_connection(&store, "123").await);
        let result = request_clip(
            &store,
            &publisher,
            &clock,
            &SystemRandom,
            "123",
            data,
            false,
        )
        .await;
        assert_eq!(result.clip_id.as_deref(), Some("fixture"));
        assert_eq!(publisher.0.lock().expect("published").len(), 1);
        let raw = stores
            .dragonfly
            .get(&format!(
                "{}twitch:123:clips:queue:data:fixture",
                store.prefix
            ))
            .await?
            .expect("persisted");
        assert_eq!(serde_json::from_slice::<Value>(&raw)?["timestamp"], NOW_MS);
        assert_eq!(
            stores
                .dragonfly
                .zcard(&format!("{}twitch:123:clips:queue", store.prefix))
                .await?,
            1
        );
        let id = generate_random_clip_id(&SystemRandom)?;
        assert_eq!(id.len(), 6);
        assert!(
            id.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
        );
        let cap_key = format!("{}twitch:cap:clips:queue", store.prefix);
        let ids = (0..10_000).map(|n| format!("id{n}")).collect::<Vec<_>>();
        let members = ids
            .iter()
            .enumerate()
            .map(|(n, id)| (n as f64, id.as_bytes()))
            .collect::<Vec<_>>();
        stores.dragonfly.zadd(&cap_key, &members).await?;
        stores
            .dragonfly
            .set(
                &format!("{}twitch:cap:clips:connected", store.prefix),
                b"true",
                SetOptions::default(),
            )
            .await?;
        let data = ClipRequestData {
            clip_id: Some("over-capacity".into()),
            timestamp: None,
            fields: Default::default(),
        };
        assert!(
            request_clip(
                &store,
                &publisher,
                &clock,
                &SystemRandom,
                "cap",
                data,
                false
            )
            .await
            .response
            .error
        );
        assert_eq!(stores.dragonfly.zcard(&cap_key).await?, 10_000);
        assert!(
            stores
                .dragonfly
                .get(&format!(
                    "{}twitch:cap:clips:queue:data:over-capacity",
                    store.prefix
                ))
                .await?
                .is_none()
        );
        let data = ClipRequestData {
            clip_id: Some("id0".into()),
            timestamp: None,
            fields: Default::default(),
        };
        assert!(
            !request_clip(
                &store,
                &publisher,
                &clock,
                &SystemRandom,
                "cap",
                data,
                false
            )
            .await
            .response
            .error
        );
        assert_eq!(stores.dragonfly.zcard(&cap_key).await?, 10_000);
        t.shutdown().await;
        Ok(())
    })
    .await
}
