//! Helix calls through [`dima_twitch::Twitch::helix`]: the reference's headers, a 401 with a
//! valid-looking token, a 401 the token cannot be refreshed for, rate limiting with its headers,
//! a 5xx, the credential errors and their texts, and the channel emote catalog.

use crate::support::*;
use anyhow::Result;
use dima_http::Path;
use dima_http::testing::MockResponse;
use dima_twitch::emotes::CatalogStatus;
use dima_twitch::{Auth, CredentialError, HelixError, HelixRequest};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW_SECS: i64 = NOW_MS / 1000;

fn state(refresh: &str) -> Shared {
    let mut state = TwitchState {
        consume: true,
        expires_in: 14_400,
        ..TwitchState::default()
    };
    state.valid.insert(refresh.to_owned(), "u1".to_owned());
    Arc::new(Mutex::new(state))
}

fn helix_requests(
    server: &dima_http::testing::MockServer,
) -> Vec<dima_http::testing::RecordedRequest> {
    server
        .requests()
        .into_iter()
        .filter(|r| r.path().starts_with("/helix/"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_401_refreshes_once_and_the_retry_carries_the_new_token() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state("u1-refresh-0"), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        // A token that looks valid (an hour left) but Twitch no longer accepts.
        insert_user(
            &stores,
            user_document(
                "u1",
                "u1",
                "u1-access-0",
                "u1-refresh-0",
                Some(NOW_SECS + 3600),
            ),
        )
        .await?;
        process.twitch.load_streamers().await?;
        let answer = process
            .twitch
            .helix(
                HelixRequest::get(
                    Path::fixed("/channels/followers"),
                    Auth::Streamer("u1".into()),
                )
                .query("broadcaster_id", "u1")
                .query("first", "100")
                .retry_on_401_with(&[Duration::from_millis(10)])
                .operation("fetch_followers_page")
                .worker("follow_ledger"),
            )
            .await?;
        assert_eq!(answer.status(), 200);
        assert!(!answer.refresh_unavailable());
        let helix = helix_requests(&server);
        assert_eq!(helix.len(), 2);
        for request in &helix {
            assert_eq!(request.method, "GET");
            assert_eq!(
                request.target,
                "/helix/channels/followers?broadcaster_id=u1&first=100"
            );
            assert_helix_headers(request);
            assert!(request.body.is_empty());
        }
        assert_ne!(
            helix[0].header("authorization"),
            helix[1].header("authorization"),
            "the retry used another token"
        );
        assert_eq!(token_requests(&server).len(), 1);
        let actions: Vec<String> = process
            .events
            .entries()
            .iter()
            .filter_map(|e| e.data["message"].as_str().map(str::to_owned))
            .collect();
        assert!(
            actions
                .iter()
                .any(|m| m == "Received Twitch 401. Refreshing token and retrying request.")
        );
        assert_no_secrets(
            &process.events,
            &["u1-access-0", "u1-access-1", "u1-refresh-0", "u1-refresh-1"],
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_401_without_a_new_token_reports_refresh_unavailable() -> Result<()> {
    with_stores(|stores| async move {
        // Twitch refuses the refresh token too: the stored tokens are wiped.
        let server = twitch_mock(state("not-the-stored-one"), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        insert_user(
            &stores,
            user_document(
                "u1",
                "u1",
                "u1-access-0",
                "u1-refresh-0",
                Some(NOW_SECS + 3600),
            ),
        )
        .await?;
        process.twitch.load_streamers().await?;
        let answer = process
            .twitch
            .helix(
                HelixRequest::get(
                    Path::fixed("/channels/editors"),
                    Auth::Streamer("u1".into()),
                )
                .query("broadcaster_id", "u1")
                .retry_on_401_with(&[Duration::from_millis(10), Duration::from_millis(10)]),
            )
            .await?;
        assert_eq!(answer.status(), 401);
        assert!(
            answer.refresh_unavailable(),
            "the reference answers 503 here"
        );
        assert_eq!(
            helix_requests(&server).len(),
            1,
            "the refused token is not sent again"
        );
        let body: serde_json::Value = answer.into_response().json().await?;
        assert_eq!(body["message"], "Invalid OAuth token");
        assert_eq!(
            cache_fields(&stores, "u1").await?["has_permissions"],
            "false"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn persistent_401s_stop_after_the_configured_retries() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state("u1-refresh-0"), |_, _| {
            MockResponse::json(401, r#"{"status":401,"message":"Invalid OAuth token"}"#)
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        insert_user(
            &stores,
            user_document(
                "u1",
                "u1",
                "u1-access-0",
                "u1-refresh-0",
                Some(NOW_SECS + 3600),
            ),
        )
        .await?;
        process.twitch.load_streamers().await?;
        let answer = process
            .twitch
            .helix(
                HelixRequest::post(Path::fixed("/chat/messages"), Auth::Streamer("u1".into()))
                    .json(json!({ "broadcaster_id": "u1", "message": "hola 👋 مرحبا e\u{301}" }))
                    .retry_on_401_with(&[Duration::from_millis(5), Duration::from_millis(5)]),
            )
            .await?;
        assert_eq!(answer.status(), 401);
        assert!(!answer.refresh_unavailable());
        let helix = helix_requests(&server);
        assert_eq!(helix.len(), 3, "the first try and two retries");
        for request in &helix {
            assert_eq!(request.method, "POST");
            assert_eq!(
                request.body_text(),
                "{\"broadcaster_id\":\"u1\",\"message\":\"hola 👋 مرحبا e\u{301}\"}"
            );
        }
        assert_eq!(token_requests(&server).len(), 2, "one refresh per retry");
        let persisted = process.events.entries().iter().any(|e| {
            e.data["message"] == "Twitch 401 persisted after retries. Continuing workflow."
                && e.data["retriesAttempted"] == 2
        });
        assert!(persisted);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limits_and_5xx_are_returned_as_they_are() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state("unused"), helix_ok).await?;
        server.push(MockResponse::json(
            200,
            r#"{"access_token":"app-1","expires_in":5000000}"#,
        ));
        server.push(
            MockResponse::json(
                429,
                r#"{"error":"Too Many Requests","status":429,"message":""}"#,
            )
            .header("ratelimit-limit", "800")
            .header("ratelimit-remaining", "0")
            .header("ratelimit-reset", "1794355260"),
        );
        server.push(MockResponse::json(
            503,
            r#"{"error":"Service Unavailable","status":503}"#,
        ));
        let process = process(&stores, &server, fast_timings())?;
        let call = || {
            HelixRequest::get(Path::fixed("/streams"), Auth::App)
                .query("user_id", "1")
                .query("user_id", "2")
                .retry_on_401()
        };
        let limited = process.twitch.helix(call()).await?;
        assert_eq!(limited.status(), 429);
        assert_eq!(
            limited
                .headers()
                .get("ratelimit-remaining")
                .and_then(|v| v.to_str().ok()),
            Some("0")
        );
        assert_eq!(
            limited
                .headers()
                .get("ratelimit-reset")
                .and_then(|v| v.to_str().ok()),
            Some("1794355260")
        );
        let unavailable = process.twitch.helix(call()).await?;
        assert_eq!(unavailable.status(), 503);
        let helix = helix_requests(&server);
        assert_eq!(helix.len(), 2, "neither is retried");
        assert_eq!(helix[0].target, "/helix/streams?user_id=1&user_id=2");
        assert_helix_headers(&helix[0]);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn credential_errors_keep_the_reference_texts() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state("unused"), helix_ok).await?;
        server.push(MockResponse::json(403, r#"{"status":403,"message":"invalid client"}"#));
        let process = process(&stores, &server, fast_timings())?;
        let mut no_permissions = user_document("u2", "u2", "a", "r", Some(NOW_SECS + 3600));
        if let Ok(accounts) = no_permissions.get_array_mut("accounts")
            && let Some(bson::Bson::Document(account)) = accounts.get_mut(0)
        {
            account.insert("has_permissions", false);
        }
        insert_user(&stores, no_permissions).await?;
        let cases = [
            (Auth::Streamer("404".into()), "[⚠️] Streamer not found for ID: 404 [/⚠️]", 403),
            (Auth::Streamer("u2".into()), "[⚠️] Streamer does not have valid permissions to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]", 403),
            (Auth::Moderator, "Bot's account does not have the permissions required", 403),
            (Auth::App, "Failed to get Twitch app token", 500),
        ];
        for (auth, message, status) in cases {
            let error = process.twitch.helix(HelixRequest::get(Path::fixed("/users"), auth.clone()).retry_on_401()).await.unwrap_err();
            let HelixError::Credential { error, status: got } = error else {
                panic!("{auth:?}: {error:?}");
            };
            assert_eq!((error.message().as_str(), got), (message, status), "{auth:?}");
        }
        assert_eq!(
            CredentialError::StreamerNoToken.message(),
            "[⚠️] Streamer does not have valid permissions token to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]"
        );
        assert!(helix_requests(&server).is_empty());
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_channel_emote_catalog_is_fetched_cached_and_kept_on_failure() -> Result<()> {
    with_stores(|stores| async move {
        let fail = Arc::new(Mutex::new(false));
        let failing = Arc::clone(&fail);
        let server = twitch_mock(state("unused"), move |request, _| {
            assert_eq!(request.target, "/helix/chat/emotes?broadcaster_id=123");
            if *failing.lock().unwrap() {
                return MockResponse::json(500, "{}");
            }
            MockResponse::json(200, &json!({"data": [{"id": "emotesv2_1", "name": "chanHi"}, {"id": "e-2", "name": "chan👋"}]}).to_string())
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        let catalog = process.twitch.channel_emote_catalog("123").await;
        assert_eq!(catalog.status, CatalogStatus::Ready);
        assert_eq!(catalog.emotes.len(), 2);
        assert_eq!(catalog.checked_at.as_deref(), Some("2026-11-11T00:00:00.000Z"));
        let key = stores.keys.emote_catalog("123");
        assert!(matches!(stores.dragonfly.ttl(&key).await?, dima_store::dragonfly::Ttl::Seconds(s) if s > 86_000));
        // Within the hour: from the cache.
        process.twitch.channel_emote_catalog("123").await;
        assert_eq!(helix_requests(&server).len(), 1);
        // Two hours later Twitch fails: the known emotes are kept (stale), retried after 60 s.
        process.clock.advance(2 * 3_600_000);
        *fail.lock().unwrap() = true;
        let stale = process.twitch.channel_emote_catalog("123").await;
        assert_eq!(stale.status, CatalogStatus::Stale);
        assert_eq!(stale.emotes.len(), 2);
        process.twitch.channel_emote_catalog("123").await;
        assert_eq!(helix_requests(&server).len(), 2, "the failure is cached for 60 s");
        // A day later nothing is shown.
        process.clock.advance(86_400_000);
        let old = process.twitch.channel_emote_catalog("123").await;
        assert_eq!(old.status, CatalogStatus::Unavailable);
        assert!(old.emotes.is_empty());
        // Not a channel id: nothing is asked.
        assert_eq!(process.twitch.channel_emote_catalog("12a").await.status, CatalogStatus::Unavailable);
        Ok(())
    })
    .await
}

/// Helix for the 401 tests: `/helix/scoped` always answers 401 (a missing scope: no token
/// cures it); anything else accepts the app tokens after the first and the user tokens Twitch
/// issued, and refuses the rest (the first app token and the bot's seeded token were revoked).
fn helix_strict(request: &dima_http::testing::RecordedRequest, state: &Shared) -> MockResponse {
    let unauthorized = || {
        MockResponse::json(
            401,
            r#"{"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}"#,
        )
    };
    if request.path() == "/helix/scoped" {
        return unauthorized();
    }
    let token = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    let known = state.lock().is_ok_and(|state| {
        state.access.contains_key(&token)
            || (token.starts_with("app-token-") && token != "app-token-1")
    });
    if known {
        MockResponse::json(200, r#"{"data":[]}"#)
    } else {
        unauthorized()
    }
}

fn grants(server: &dima_http::testing::MockServer, grant: &str) -> usize {
    token_requests(server)
        .iter()
        .filter(|request| form_value(request, "grant_type").as_deref() == Some(grant))
        .count()
}

/// Review finding 10, app token: a 401 replaces the refused token once (the reference sent the
/// same token again, so the call failed until the key expired); a 401 that a new token does not
/// cure (a missing scope) does not refresh again for every request; a token another caller
/// stored meanwhile is used as it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_app_token_401_refreshes_once_for_the_refused_token() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("unused");
        let server = twitch_mock(Arc::clone(&state), helix_strict).await?;
        let process = process(&stores, &server, fast_timings())?;
        let first = process
            .twitch
            .app_token()
            .await
            .map(|t| t.expose().to_owned());
        assert_eq!(first.as_deref(), Some("app-token-1"));
        let ok = || {
            HelixRequest::get(Path::fixed("/users"), Auth::App)
                .retry_on_401_with(&[Duration::from_millis(5)])
        };
        let answer = process.twitch.helix(ok()).await?;
        assert_eq!(answer.status(), 200, "the retry carried a new app token");
        assert_eq!(grants(&server, "client_credentials"), 2);
        assert_eq!(
            cached_app_token(&stores).await?.as_deref(),
            Some("app-token-2")
        );

        let scoped = || {
            HelixRequest::get(Path::fixed("/scoped"), Auth::App)
                .retry_on_401_with(&[Duration::from_millis(5), Duration::from_millis(5)])
        };
        for _ in 0..3 {
            assert_eq!(process.twitch.helix(scoped()).await?.status(), 401);
        }
        assert_eq!(
            grants(&server, "client_credentials"),
            2,
            "a 401 the new token does not cure costs no refresh per request"
        );

        // Another process stored a newer token while this call waited for its 401.
        set_cache_app_token(&stores, "app-token-1").await?;
        server.push(
            MockResponse::json(401, r#"{"status":401,"message":"Invalid OAuth token"}"#)
                .delay(Duration::from_millis(200)),
        );
        let call = {
            let twitch = process.twitch.clone();
            tokio::spawn(async move { twitch.helix(ok()).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        set_cache_app_token(&stores, "app-token-7").await?;
        assert_eq!(call.await??.status(), 200);
        assert_eq!(
            grants(&server, "client_credentials"),
            2,
            "the winner was used"
        );
        assert_eq!(
            cached_app_token(&stores).await?.as_deref(),
            Some("app-token-7")
        );
        let last = helix_requests(&server).last().cloned().expect("a request");
        assert_eq!(last.header("authorization"), Some("Bearer app-token-7"));
        assert_no_secrets(
            &process.events,
            &["app-token-1", "app-token-2", "app-token-7"],
        );
        Ok(())
    })
    .await
}

async fn set_cache_app_token(stores: &Stores, token: &str) -> Result<()> {
    let sealed = serde_json::to_string(&encrypt(token))?;
    stores
        .dragonfly
        .set(
            &stores.keys.app_token(),
            sealed.as_bytes(),
            Default::default(),
        )
        .await?;
    Ok(())
}

/// Review finding 10, bot and moderator calls: the refused bot token is passed to the refresh
/// (the reference read the same, still unexpired, token again); a missing scope does not cost
/// a refresh per request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bot_token_401_refreshes_once_for_the_refused_token() -> Result<()> {
    with_stores(|stores| async move {
        let bot = dima_twitch::TWITCH_BOT_ACCOUNT_ID;
        let mut seeded = TwitchState {
            consume: true,
            expires_in: 14_400,
            ..TwitchState::default()
        };
        seeded
            .valid
            .insert("bot-refresh-0".to_owned(), bot.to_owned());
        let state = Arc::new(Mutex::new(seeded));
        let server = twitch_mock(Arc::clone(&state), helix_strict).await?;
        let process = process(&stores, &server, fast_timings())?;
        insert_user(
            &stores,
            user_document(
                bot,
                "domdimabot",
                "bot-access-0",
                "bot-refresh-0",
                Some(NOW_SECS + 3600),
            ),
        )
        .await?;
        process.twitch.load_streamers().await?;
        let announce = HelixRequest::post(Path::fixed("/chat/announcements"), Auth::Moderator)
            .query("broadcaster_id", "123")
            .query("moderator_id", bot)
            .json(json!({ "message": "hola 👋" }))
            .retry_on_401_with(&[Duration::from_millis(5)]);
        assert_eq!(process.twitch.helix(announce).await?.status(), 200);
        assert_eq!(grants(&server, "refresh_token"), 1);
        let last = helix_requests(&server).last().cloned().expect("a request");
        assert_eq!(
            last.header("authorization").map(str::to_owned),
            Some(format!("Bearer {bot}-access-1"))
        );
        for auth in [Auth::Bot, Auth::Moderator, Auth::Bot] {
            let scoped = HelixRequest::get(Path::fixed("/scoped"), auth)
                .retry_on_401_with(&[Duration::from_millis(5), Duration::from_millis(5)]);
            assert_eq!(process.twitch.helix(scoped).await?.status(), 401);
        }
        assert_eq!(
            grants(&server, "refresh_token"),
            1,
            "no refresh per request"
        );
        assert_no_secrets(&process.events, &["bot-access-0", "bot-refresh-0"]);
        Ok(())
    })
    .await
}
