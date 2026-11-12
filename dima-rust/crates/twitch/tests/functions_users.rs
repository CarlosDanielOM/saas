#![allow(clippy::expect_used)]
//! Request and result parity for the app-authenticated user functions.
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::functions::users::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use support::*;

#[tokio::test]
async fn users_requests_success_empty_errors_and_malformed() -> Result<()> {
    with_stores(|stores| async move {
        let user = json!({"id":"123", "login":"test", "display_name":"Á🙂אב", "type":"", "broadcaster_type":"", "description":"", "profile_image_url":"", "offline_image_url":"", "view_count":0, "created_at":"2020-01-01T00:00:00Z"});
        let body = Arc::new(Mutex::new((200, json!({"data":[user.clone()]}).to_string())));
        let reply = body.clone();
        let server = twitch_mock(Arc::default(), move |_, _| {
            let (status, body) = reply.lock().expect("reply").clone();
            MockResponse::json(status, &body)
        }).await?;
        let process = process(&stores, &server, fast_timings())?;
        let twitch = &process.twitch;
        for login in [false, true] {
            let answer = if login { get_twitch_user_by_login(twitch, "test", true).await } else { get_twitch_user_by_id(twitch, "123").await };
            assert_eq!(serde_json::to_value(answer)?, json!({"error":false,"message":"Success","data":user}));
            let request = server.requests().into_iter().last().expect("request");
            assert_eq!(request.method, "GET");
            assert_eq!(request.target, if login { "/helix/users?login=test" } else { "/helix/users?id=123" });
            assert!(request.body.is_empty());
            assert_helix_headers(&request);
            for (status, input, expected) in [
                (200, r#"{"data":[]}"#, json!({"error":true,"message":"User not found"})),
                (401, r#"{"error":"Unauthorized","message":"denied","status":401}"#, json!({"error":true,"message":"denied","status":401})),
                (503, r#"{"error":"Service Unavailable","message":"later","status":503}"#, json!({"error":true,"message":"later","status":503})),
                (200, "{", json!({"error":true,"message":"Internal server error"})),
            ] {
                *body.lock().expect("reply") = (status, input.into());
                let answer = if login { get_twitch_user_by_login(twitch,"test",false).await } else { get_twitch_user_by_id(twitch,"123").await };
                assert_eq!(serde_json::to_value(answer)?, expected);
            }
            *body.lock().expect("reply") = (200, json!({"data":[user.clone()]}).to_string());
        }
        *body.lock().expect("reply") = (200, r#"{"data":[{"user_id":"123","scopes":["chat:read"]}]}"#.into());
        let answer = get_scopes(twitch,"123").await;
        assert_eq!(answer.message.as_deref(), Some("Scopes fetched successfully"));
        assert_eq!(answer.status, Some(200));
        let request = server.requests().into_iter().last().expect("request");
        assert_eq!(request.target,"/helix/authorization/users?user_id=123");
        assert_eq!(request.method,"GET");
        assert!(request.body.is_empty());
        assert_helix_headers(&request);
        for status in [401,500] {
            let input = json!({"error":"denied","message":"no","status":status});
            *body.lock().expect("reply") = (status,input.to_string());
            let answer = get_scopes(twitch,"123").await;
            assert_eq!(answer.data,Some(input));
            assert_eq!(answer.message.as_deref(),Some("no"));
        }
        *body.lock().expect("reply") = (200,"malformed".into());
        assert_eq!(get_scopes(twitch,"123").await.message.as_deref(),Some("Internal server error"));
        assert_no_secrets(&process.events,&[]);
        twitch.shutdown().await;
        Ok(())
    }).await
}
