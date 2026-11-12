//! `promo` against the Twitch mock: the reads in the reference's order, the clip shown through
//! the seam, and each step's failure message.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod message_support;

use anyhow::Result;
use dima_chat::promo::{ShowClip, ShownClip, promo};
use dima_http::testing::{MockResponse, RecordedRequest};
use dima_twitch::functions::clips::{ClipStore, TwitchClip};
use dima_twitch::functions::users::TwitchUser;
use futures_util::future::BoxFuture;
use message_support::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Shown(Mutex<Vec<(String, usize, String, String)>>, bool);

impl ShowClip for Shown {
    fn show_clip<'a>(
        &'a self,
        channel_id: &'a str,
        clips: &'a [TwitchClip],
        streamer: &'a TwitchUser,
        broadcaster: &'a TwitchUser,
    ) -> BoxFuture<'a, ShownClip> {
        self.0.lock().unwrap().push((
            channel_id.to_owned(),
            clips.len(),
            streamer.login.clone(),
            broadcaster.login.clone(),
        ));
        let failed = self.1;
        Box::pin(async move {
            ShownClip {
                error: failed,
                message: failed.then(String::new),
                status: failed.then_some(500),
                answer: json!({"error": failed, "clip": "c1"}),
            }
        })
    }
}

fn user(id: &str, login: &str) -> serde_json::Value {
    json!({"id": id, "login": login, "display_name": login, "type": "", "broadcaster_type": "affiliate",
        "description": "", "profile_image_url": "", "offline_image_url": "", "view_count": 0,
        "created_at": "2020-01-01T00:00:00Z"})
}

#[test]
fn a_promo_reads_the_streamer_then_shows_one_of_its_clips() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        twitch.server.fallback(|request: &RecordedRequest| {
            let query = request.target.split_once('?').map(|(_, q)| q).unwrap_or_default().to_owned();
            match request.path() {
                "/oauth2/token" => MockResponse::json(200, r#"{"access_token":"app-token-1","expires_in":5011271,"token_type":"bearer"}"#),
                "/helix/users" if query == "login=otrocanal" => {
                    MockResponse::json(200, &json!({"data": [user("777", "otrocanal")]}).to_string())
                }
                "/helix/users" if query == "id=990090001" => {
                    MockResponse::json(200, &json!({"data": [user("990090001", "canal990090001")]}).to_string())
                }
                "/helix/users" => MockResponse::json(200, r#"{"data":[]}"#),
                "/helix/channels" => MockResponse::json(200, &json!({"data": [{"broadcaster_id": "777",
                    "broadcaster_login": "otrocanal", "broadcaster_name": "OtroCanal", "game_name": "Just Chatting",
                    "title": "Directo de prueba"}]}).to_string()),
                "/helix/clips" => MockResponse::json(200, &json!({"data": [{"id": "c1", "url": "https://clips.example/c1",
                    "embed_url": "", "broadcaster_id": "777", "creator_id": "1", "video_id": "", "created_at": "2026-01-01T00:00:00Z",
                    "thumbnail_url": "", "duration": 12.5, "vod_offset": null, "is_mutable": false}], "pagination": {}}).to_string()),
                _ => MockResponse::json(404, r#"{"error":"Not Found","status":404,"message":"unexpected"}"#),
            }
        });
        let process = process(
            &stores,
            &twitch,
            seeded(1),
            Seams::default(),
            test_config(),
            "promo",
        )?;
        let host = process.delivery.host();
        let clips = ClipStore {
            dragonfly: &stores.dragonfly,
            prefix: &stores.prefix,
        };
        let shown = Arc::new(Shown::default());
        let reply = promo(
            &host.twitch,
            &clips,
            shown.as_ref(),
            "990090001",
            "otrocanal",
            true,
        )
        .await;
        assert!(!reply.error, "{reply:?}");
        assert_eq!(reply.message, "Success");
        let (info, clip) = reply.data.expect("data");
        assert_eq!(
            (info.login.as_str(), info.name.as_str(), info.title.as_str()),
            ("otrocanal", "OtroCanal", "Directo de prueba")
        );
        assert_eq!(clip, Some(json!({"error": false, "clip": "c1"})));
        assert_eq!(
            shown.0.lock().unwrap().clone(),
            [(
                "990090001".to_owned(),
                1,
                "otrocanal".to_owned(),
                "canal990090001".to_owned()
            )]
        );
        let paths: Vec<String> = twitch
            .server
            .requests()
            .into_iter()
            .filter(|r| r.path().starts_with("/helix/"))
            .map(|r| r.target.clone())
            .collect();
        // The reference's order: the streamer, the channel's account, the streamer's channel, its
        // clips (one page of 50, cached for the overlay).
        assert_eq!(
            paths,
            [
                "/helix/users?login=otrocanal",
                "/helix/users?id=990090001",
                "/helix/channels?broadcaster_id=777",
                "/helix/clips?broadcaster_id=777&first=50",
            ]
        );

        // An unknown streamer ends at the first read, with its message.
        let reply = promo(
            &host.twitch,
            &clips,
            shown.as_ref(),
            "990090001",
            "nadie",
            true,
        )
        .await;
        assert!(reply.error);
        assert_eq!(reply.message, "User not found");
        // A clip that cannot be shown: the fallback message.
        let failing = Shown(Mutex::default(), true);
        let reply = promo(
            &host.twitch,
            &clips,
            &failing,
            "990090001",
            "otrocanal",
            true,
        )
        .await;
        assert_eq!(
            (reply.error, reply.message.as_str(), reply.status),
            (true, "Failed to show clip", Some(500))
        );
        // Without the clip, nothing is shown and the clips are not read.
        let reply = promo(
            &host.twitch,
            &clips,
            &failing,
            "990090001",
            "otrocanal",
            false,
        )
        .await;
        assert_eq!(
            (reply.error, reply.data.map(|(_, clip)| clip)),
            (false, Some(None))
        );
        Ok(())
    }))
}
