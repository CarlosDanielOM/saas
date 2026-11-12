//! A user's own token: `Twitch::validate_user_token` (`GET /oauth2/validate`) and
//! `Twitch::user_by_token` (`GET /helix/users`), with the failure matrix of the other wrappers.

use crate::support::*;
use anyhow::Result;
use dima_core::SecretString;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_twitch::{UserTokenError, ValidatedToken};
use std::time::Duration;

/// Twitch, answering by the token presented.
fn answer(request: &RecordedRequest) -> MockResponse {
    let token = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    let validate = request.path() == "/oauth2/validate";
    let valid = serde_json::json!({
        "client_id": CLIENT_ID,
        "login": "streamer",
        "scopes": ["chat:read", "moderator:read:followers"],
        "user_id": "1234",
        "expires_in": 5_520_838,
    });
    match token.as_str() {
        "user-token" if validate => MockResponse::json(200, &valid.to_string()),
        "user-token" => MockResponse::json(
            200,
            &data(serde_json::json!([{
                "id": "1234",
                "login": "streamer",
                "display_name": "Streamer",
                "type": "",
                "broadcaster_type": "affiliate",
                "description": "→ שלום 👋",
                "profile_image_url": "https://example.invalid/p.png",
                "offline_image_url": "",
                "view_count": 0,
                "email": "streamer@example.invalid",
                "created_at": "2016-12-14T20:32:28Z",
            }])),
        ),
        "no-user" => MockResponse::json(200, r#"{"data":[]}"#),
        "other-client" => {
            let mut other = valid.clone();
            other["client_id"] = "another-client".into();
            MockResponse::json(200, &other.to_string())
        }
        "app-token" => MockResponse::json(
            200,
            &serde_json::json!({ "client_id": CLIENT_ID, "scopes": [], "expires_in": 100 })
                .to_string(),
        ),
        "partial" => MockResponse::json(200, r#"{"client_id":"test-client-id","user_id":"1"}"#),
        "garbled" => MockResponse::json(200, "{"),
        "boom" => MockResponse::json(503, r#"{"status":503}"#),
        "slow" => MockResponse::json(200, &valid.to_string()).delay(Duration::from_secs(5)),
        "dropped" => MockResponse::drop_connection(),
        _ => MockResponse::json(401, r#"{"status":401,"message":"invalid access token"}"#),
    }
}

async fn twitch(stores: &Stores) -> Result<(Process, MockServer)> {
    twitch_with(stores, Duration::from_millis(400)).await
}

async fn twitch_with(stores: &Stores, deadline: Duration) -> Result<(Process, MockServer)> {
    let server = MockServer::start().await?;
    server.fallback(answer);
    let mut timings = fast_timings();
    timings.user_token_timeout = deadline;
    Ok((process(stores, &server, timings)?, server))
}

fn token(text: &str) -> SecretString {
    SecretString::new(text.to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_user_token_is_validated_with_its_client_and_lifetime() -> Result<()> {
    with_stores(|stores| async move {
        let (p, server) = twitch(&stores).await?;
        let validated = p.twitch.validate_user_token(&token("user-token")).await?;
        assert_eq!(
            validated,
            ValidatedToken {
                client_id: CLIENT_ID.to_owned(),
                user_id: "1234".to_owned(),
                login: "streamer".to_owned(),
                scopes: vec![
                    "chat:read".to_owned(),
                    "moderator:read:followers".to_owned()
                ],
                expires_in: 5_520_838,
            }
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].target, "/oauth2/validate");
        assert_eq!(
            requests[0].header("authorization"),
            Some("Bearer user-token")
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_failure_of_the_validation_is_distinct_and_sent_once() -> Result<()> {
    with_stores(|stores| async move {
        let (p, server) = twitch(&stores).await?;
        let cases: [(&str, UserTokenError); 9] = [
            ("expired", UserTokenError::Invalid),
            ("other-client", UserTokenError::OtherClient),
            ("app-token", UserTokenError::NotAUserToken),
            ("partial", UserTokenError::Unexpected { status: 200 }),
            ("garbled", UserTokenError::Unexpected { status: 200 }),
            ("boom", UserTokenError::Unexpected { status: 503 }),
            ("slow", UserTokenError::Unreachable { timed_out: true }),
            ("dropped", UserTokenError::Unreachable { timed_out: false }),
            ("bad\ntoken", UserTokenError::Invalid),
        ];
        for (presented, expected) in cases {
            let before = server.requests().len();
            let error = p.twitch.validate_user_token(&token(presented)).await.err();
            assert_eq!(error, Some(expected), "{presented:?}");
            let sent = server.requests().len() - before;
            let expected_sent = usize::from(presented != "bad\ntoken");
            assert_eq!(sent, expected_sent, "{presented:?}: no retry");
            let shown = format!(
                "{error:?} {}",
                error.as_ref().map(ToString::to_string).unwrap_or_default()
            );
            assert!(!shown.contains(presented), "{shown}");
        }
        assert!(
            UserTokenError::Invalid != UserTokenError::Unreachable { timed_out: false },
            "a refusal is not an outage"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_user_is_looked_up_with_the_users_own_token() -> Result<()> {
    with_stores(|stores| async move {
        let (p, server) = twitch(&stores).await?;
        let user = p.twitch.user_by_token(&token("user-token")).await?;
        assert_eq!(user.id, "1234");
        assert_eq!(user.login, "streamer");
        assert_eq!(user.description, "→ שלום 👋");
        assert_eq!(user.extra["email"], "streamer@example.invalid");
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].target, "/helix/users");
        assert_eq!(
            requests[0].header("authorization"),
            Some("Bearer user-token")
        );
        assert_eq!(requests[0].header("client-id"), Some(CLIENT_ID));

        let cases: [(&str, UserTokenError); 7] = [
            ("expired", UserTokenError::Invalid),
            ("no-user", UserTokenError::NotFound),
            ("garbled", UserTokenError::Unexpected { status: 200 }),
            ("boom", UserTokenError::Unexpected { status: 503 }),
            ("slow", UserTokenError::Unreachable { timed_out: true }),
            ("dropped", UserTokenError::Unreachable { timed_out: false }),
            ("bad\ntoken", UserTokenError::Invalid),
        ];
        for (presented, expected) in cases {
            let before = server.requests().len();
            let error = p.twitch.user_by_token(&token(presented)).await.err();
            assert_eq!(error, Some(expected), "{presented:?}");
            assert!(
                server.requests().len() - before <= 1,
                "{presented:?}: no retry"
            );
        }
        Ok(())
    })
    .await
}

/// A call made while the process stops ends at once as unreachable.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_call_during_shutdown_is_unreachable() -> Result<()> {
    with_stores(|stores| async move {
        let (p, _server) = twitch_with(&stores, Duration::from_secs(30)).await?;
        let call = {
            let twitch = p.twitch.clone();
            tokio::spawn(async move { twitch.validate_user_token(&token("slow")).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        p.shutdown.trigger();
        let started = tokio::time::Instant::now();
        let result = call.await?;
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "ended with the process"
        );
        assert!(
            matches!(result, Err(UserTokenError::Unreachable { .. })),
            "{result:?}"
        );
        Ok(())
    })
    .await
}
