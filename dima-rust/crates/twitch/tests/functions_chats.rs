#![allow(clippy::expect_used)]
//! Chat functions against the local Twitch mock.
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::functions::chats::*;
use dima_twitch::{TWITCH_BOT_ACCOUNT_ID, Twitch};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
async fn call(t: &Twitch, op: &str) -> Value {
    match op {
        "announcement" => {
            serde_json::to_value(send_announcement(t, "123", "456", "Á🙂אב", None).await)
        }
        "shoutout" => serde_json::to_value(send_shoutout(t, "123", "789", "456").await),
        "clear" => serde_json::to_value(clear_chat(t, "123", "456").await),
        "delete" => serde_json::to_value(delete_message(t, "msg", "123", "456").await),
        "chatters" => serde_json::to_value(get_chatters(t, "123", "456").await),
        "settings" => serde_json::to_value(get_chat_settings(t, "123", "456").await),
        "emotes" => serde_json::to_value(get_only_emotes(t, "123", "456").await),
        "set_emotes" => serde_json::to_value(set_only_emotes(t, "123", true, "456").await),
        "color" => serde_json::to_value(get_user_color(t, "123").await),
        "pins" => serde_json::to_value(get_pinned_chat_message(t, "123", "456").await),
        "pin" => serde_json::to_value(pin_chat_message(t, "123", "msg", Some(30.0), "456").await),
        "update_pin" => serde_json::to_value(
            update_pinned_chat_message(t, "123", "msg", Some(1800.0), "456").await,
        ),
        "unpin" => serde_json::to_value(unpin_chat_message(t, "123", "msg", "456").await),
        _ => unreachable!(),
    }
    .expect("serialize")
}
#[tokio::test]
async fn chat_request_shapes_and_response_branches() -> Result<()> {
    with_stores(|stores| async move {
        insert_user(
            &stores,
            user_document(
                TWITCH_BOT_ACCOUNT_ID,
                "bot",
                "bot-access",
                "refresh",
                Some(NOW_MS / 1000 + 3600),
            ),
        )
        .await?;
        let reply = Arc::new(Mutex::new((204, String::new())));
        let source = reply.clone();
        let server = twitch_mock(Arc::default(), move |_, _| {
            let (s, b) = source.lock().expect("reply").clone();
            MockResponse::json(s, &b)
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        for (op, method, path, query, body, status, answer, success) in [
            (
                "announcement",
                "POST",
                "chat/announcements",
                format!("broadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                Some(json!({"message":"Á🙂אב","color":"purple"})),
                204,
                "",
                "Announcement sent",
            ),
            (
                "shoutout",
                "POST",
                "chat/shoutouts",
                "from_broadcaster_id=123&to_broadcaster_id=789&moderator_id=456".into(),
                None,
                204,
                "",
                "Shoutout sent",
            ),
            (
                "clear",
                "DELETE",
                "moderation/chat",
                format!("broadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                None,
                204,
                "",
                "Chat cleared",
            ),
            (
                "delete",
                "DELETE",
                "moderation/chat",
                format!("broadcaster_id=123&message_id=msg&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                None,
                204,
                "",
                "Message deleted",
            ),
            (
                "chatters",
                "GET",
                "chat/chatters",
                format!("broadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                None,
                200,
                r#"{"data":[]}"#,
                "Success",
            ),
            (
                "settings",
                "GET",
                "chat/settings",
                format!("broadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                None,
                200,
                r#"{"data":[{"emote_mode":true}]}"#,
                "success",
            ),
            (
                "emotes",
                "GET",
                "chat/settings",
                format!("%3Fbroadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                None,
                200,
                r#"{"data":[{"emote_mode":true}]}"#,
                "Success",
            ),
            (
                "set_emotes",
                "PATCH",
                "chat/settings",
                format!("broadcaster_id=123&moderator_id={TWITCH_BOT_ACCOUNT_ID}"),
                Some(json!({"emote_mode":true})),
                200,
                r#"{"data":[{"emote_mode":true}]}"#,
                "Success",
            ),
            (
                "color",
                "GET",
                "chat/color",
                "user_id=123".into(),
                None,
                200,
                r##"{"data":[{"color":"#123456"}]}"##,
                "",
            ),
            (
                "pins",
                "GET",
                "chat/pins",
                "broadcaster_id=123&moderator_id=456".into(),
                None,
                200,
                r#"{"data":[]}"#,
                "Pinned chat message retrieved",
            ),
            (
                "pin",
                "PUT",
                "chat/pins",
                "broadcaster_id=123&moderator_id=456&message_id=msg&duration_seconds=30".into(),
                None,
                204,
                "",
                "Chat message pinned",
            ),
            (
                "update_pin",
                "PATCH",
                "chat/pins",
                "broadcaster_id=123&moderator_id=456&message_id=msg&duration_seconds=1800".into(),
                None,
                204,
                "",
                "Pinned chat message updated",
            ),
            (
                "unpin",
                "DELETE",
                "chat/pins",
                "broadcaster_id=123&moderator_id=456&message_id=msg".into(),
                None,
                204,
                "",
                "Chat message unpinned",
            ),
        ] {
            *reply.lock().expect("reply") = (status, answer.into());
            let result = call(&process.twitch, op).await;
            assert_eq!(result["error"], false, "{op}: {result}");
            if !success.is_empty() {
                assert_eq!(result["message"], success, "{op}");
            }
            let request = server.requests().into_iter().last().expect("request");
            assert_eq!(request.method, method);
            assert_eq!(request.target, format!("/helix/{path}?{query}"));
            assert_helix_headers(&request);
            if let Some(body) = body {
                assert_eq!(serde_json::from_slice::<Value>(&request.body)?, body);
            } else {
                assert!(request.body.is_empty());
            }
            for status in [401, 403, 429, 500] {
                *reply.lock().expect("reply") = (
                    status,
                    json!({"error":"Denied","message":"fixture denied","status":status})
                        .to_string(),
                );
                let before = server.requests().len();
                let result = call(&process.twitch, op).await;
                assert!(
                    result["error"] == true || result["error"] == "Denied",
                    "{op}: {result}"
                );
                assert_eq!(
                    result["message"],
                    match op {
                        "delete" => "Denied",
                        "settings" => "Error getting chat settings",
                        "emotes" => "Internal server error",
                        _ => "fixture denied",
                    },
                    "{op}"
                );
                assert_eq!(
                    result["status"],
                    match op {
                        "clear" | "settings" => 400,
                        "emotes" => 500,
                        _ => status,
                    },
                    "{op}"
                );
                assert_eq!(
                    server.requests().len(),
                    before + 1,
                    "reference does not retry 401"
                );
            }
            *reply.lock().expect("reply") = (200, "{".into());
            let result = call(&process.twitch, op).await;
            assert_eq!(result["error"], true);
            assert_eq!(
                result["message"],
                if ["pins", "pin", "update_pin", "unpin"].contains(&op) {
                    "Failed to parse Twitch response"
                } else {
                    "Internal server error"
                }
            );
        }
        for op in [
            "chatters",
            "settings",
            "emotes",
            "set_emotes",
            "color",
            "pins",
        ] {
            *reply.lock().expect("reply") = (200, r#"{"data":[]}"#.into());
            let result = call(&process.twitch, op).await;
            assert_eq!(
                result["error"],
                ["emotes", "color"].contains(&op),
                "{op}: {result}"
            );
            if op == "chatters" {
                assert_eq!(result["chatters"], json!([]));
            }
        }
        for op in ["pins", "pin", "update_pin", "unpin"] {
            *reply.lock().expect("reply") = (200, String::new());
            let result = call(&process.twitch, op).await;
            assert_eq!(result["message"], "Twitch API returned an empty response");
            assert_eq!(result["type"], "empty_response");
        }
        let before = server.requests().len();
        for n in [0.0, 29.0, 1801.0, 30.5, f64::NAN] {
            let result = pin_chat_message(&process.twitch, "123", "msg", Some(n), "456").await;
            assert_eq!(
                result.message.as_deref(),
                Some("durationSeconds must be an integer between 30 and 1800")
            );
        }
        assert_eq!(
            unpin_chat_message(&process.twitch, "123", " \u{feff}", "456")
                .await
                .status,
            Some(400)
        );
        assert_eq!(server.requests().len(), before);
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}
