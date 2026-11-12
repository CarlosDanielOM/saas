//! Streamer, bot and app tokens against the stores and the mock: a valid token, an expired one,
//! every refusal Twitch documents for a refresh, 5xx, a timeout, an answer after the caller gave
//! up, and the cutover case where MongoDB holds a newer token than the cache.

use crate::support::*;
use anyhow::Result;
use bson::{Bson, doc};
use dima_http::testing::MockResponse;
use dima_twitch::{AccessToken, RefreshFailureKind, RefreshFailureReason, TokenError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW_SECS: i64 = NOW_MS / 1000;

fn state_with(user: &str, refresh: &str) -> Shared {
    let mut state = TwitchState {
        consume: true,
        expires_in: 14_400,
        ..TwitchState::default()
    };
    state.valid.insert(refresh.to_owned(), user.to_owned());
    Arc::new(Mutex::new(state))
}

/// Seeds a streamer in MongoDB and loads the directory.
async fn seed(
    stores: &Stores,
    process: &Process,
    id: &str,
    access: &str,
    refresh: &str,
    expires_at: i64,
) -> Result<()> {
    insert_user(
        stores,
        user_document(id, id, access, refresh, Some(expires_at)),
    )
    .await?;
    let loaded = process.twitch.load_streamers().await?;
    assert!(loaded.iter().any(|loaded| loaded == id));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_valid_token_is_used_without_refreshing() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS + 3600,
        )
        .await?;
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-0");
        assert!(token_requests(&server).is_empty());
        // 300 s or less left counts as expired; 301 s does not.
        set_cache(
            &stores,
            "u1",
            &[("expires_at", &(NOW_SECS + 301).to_string())],
        )
        .await?;
        process.twitch.streamer_token("u1", None, "test").await?;
        assert!(token_requests(&server).is_empty());
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_token_is_refreshed_and_stored_like_the_reference() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS + 300,
        )
        .await?;
        let before = stored_account(&stores, "u1").await?;

        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        let requests = token_requests(&server);
        assert_eq!(requests.len(), 1);
        assert_token_request(&requests[0], "refresh_token", Some("u1-refresh-0"));

        // MongoDB: the reference's $set, the envelope readable, the expiry an int32.
        let after = stored_account(&stores, "u1").await?;
        assert_eq!(
            decrypt_field(&after, "access_token").as_deref(),
            Some("u1-access-1")
        );
        assert_eq!(
            decrypt_field(&after, "refresh_token").as_deref(),
            Some("u1-refresh-1")
        );
        let iv = after.get_document("access_token")?.get_str("iv")?;
        assert_eq!(iv.len(), 32);
        assert_eq!(
            after.get("access_token_expires_at"),
            Some(&Bson::Int32(i32::try_from(NOW_SECS + 14_400)?))
        );
        assert!(after.get_bool("has_permissions")?);
        assert!(after.get_bool("up_to_date_permissions")?);
        // Nothing else of the account changed, and the keys kept their order.
        let keys = |d: &bson::Document| d.keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&after), keys(&before));
        for field in [
            "_id",
            "type",
            "id",
            "name",
            "email",
            "actived",
            "chat_enabled",
        ] {
            assert_eq!(after.get(field), before.get(field), "{field}");
        }
        let user = stores
            .mongo
            .documents("users")
            .find_one(doc! {})
            .await?
            .unwrap();
        assert_eq!(
            user.get("updated_at"),
            Some(&Bson::DateTime(bson::DateTime::from_millis(NOW_MS)))
        );
        assert_eq!(user.get("__v"), Some(&Bson::Int32(0)));

        // The cache.
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["access_token"], "u1-access-1");
        assert_eq!(cache["refresh_token"], "u1-refresh-1");
        assert_eq!(cache["expires_at"], (NOW_SECS + 14_400).to_string());
        assert_eq!(cache["has_permissions"], "true");

        // No token is in Dragonfly in plain text (the cache holds MongoDB's envelopes).
        assert_no_plain_tokens(
            &stores,
            &["u1-access-0", "u1-refresh-0", "u1-access-1", "u1-refresh-1"],
        )
        .await?;
        let raw = raw_cache_fields(&stores, "u1").await?;
        assert_eq!(
            raw["refresh_token"],
            serde_json::to_string(&after.get_document("refresh_token")?)?.replace(' ', ""),
            "the cache holds MongoDB's own envelope"
        );

        // The new token is now used from the cache.
        let again = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(again.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1);
        assert_no_secrets(
            &process.events,
            &["u1-access-0", "u1-refresh-0", "u1-access-1", "u1-refresh-1"],
        );
        assert!(
            process
                .events
                .actions()
                .contains(&"token_refresh_succeeded".to_owned())
        );
        Ok(())
    })
    .await
}

/// Each refusal Twitch documents for a refresh: only a dead refresh token wipes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refused_refreshes_wipe_only_for_a_dead_refresh_token() -> Result<()> {
    let refusals: [(u16, &str, RefreshFailureKind); 6] = [
        (
            400,
            r#"{"status":400,"message":"Invalid refresh token"}"#,
            RefreshFailureKind::Permanent,
        ),
        (
            401,
            r#"{"status":401,"message":"authorization has been revoked"}"#,
            RefreshFailureKind::Permanent,
        ),
        (
            400,
            r#"{"error":"Bad Request","status":400,"message":"invalid client secret"}"#,
            RefreshFailureKind::Transient,
        ),
        (
            400,
            r#"{"error":"Bad Request","status":400,"message":"missing refresh token"}"#,
            RefreshFailureKind::Transient,
        ),
        (
            403,
            r#"{"status":403,"message":"invalid client"}"#,
            RefreshFailureKind::Transient,
        ),
        (
            429,
            r#"{"status":429,"message":"Too Many Requests"}"#,
            RefreshFailureKind::Transient,
        ),
    ];
    for (status, body, expected) in refusals {
        with_stores(|stores| async move {
            let state = state_with("u1", "unused");
            let server = twitch_mock(state, helix_ok).await?;
            server.push(MockResponse::json(status, body).header("ratelimit-reset", "1"));
            let process = process(&stores, &server, fast_timings())?;
            seed(
                &stores,
                &process,
                "u1",
                "u1-access-0",
                "u1-refresh-0",
                NOW_SECS - 10,
            )
            .await?;
            let before = stored_account(&stores, "u1").await?;
            let error = process
                .twitch
                .streamer_token("u1", None, "test")
                .await
                .unwrap_err();
            let TokenError::Refresh {
                kind, status: got, ..
            } = error
            else {
                panic!("{status} {body}: {error:?}");
            };
            assert_eq!((kind, got), (expected, Some(status)), "{body}");
            // A 4xx is not retried.
            assert_eq!(token_requests(&server).len(), 1, "{body}");
            let after = stored_account(&stores, "u1").await?;
            let cache = cache_fields(&stores, "u1").await?;
            if expected == RefreshFailureKind::Permanent {
                for field in ["refresh_token", "access_token"] {
                    assert_eq!(
                        after.get_document(field)?,
                        &doc! { "iv": Bson::Null, "content": Bson::Null }
                    );
                }
                assert_eq!(after.get("access_token_expires_at"), Some(&Bson::Null));
                assert!(!after.get_bool("has_permissions")?);
                assert!(!after.get_bool("up_to_date_permissions")?);
                assert_eq!(cache["access_token"], "");
                assert_eq!(cache["refresh_token"], "");
                assert_eq!(cache["expires_at"], "");
                assert_eq!(cache["has_permissions"], "false");
                assert!(
                    process
                        .events
                        .actions()
                        .contains(&"tokens_invalidated".to_owned())
                );
                // The streamer header now asks the streamer to log in again.
                let header = process
                    .twitch
                    .streamer_credential("u1", None)
                    .await
                    .unwrap_err();
                assert!(
                    header
                        .message()
                        .contains("does not have valid permissions to access")
                );
            } else {
                assert_eq!(after, before, "{body}");
                assert_eq!(cache["refresh_token"], "u1-refresh-0");
                assert!(
                    !process
                        .events
                        .actions()
                        .contains(&"tokens_invalidated".to_owned())
                );
            }
            assert_no_secrets(&process.events, &["u1-access-0", "u1-refresh-0"]);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_5xx_is_retried_three_times_and_changes_nothing() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        for _ in 0..3 {
            server.push(MockResponse::json(
                503,
                r#"{"message":"Service Unavailable"}"#,
            ));
        }
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS,
        )
        .await?;
        let started = tokio::time::Instant::now();
        let error = process
            .twitch
            .streamer_token("u1", None, "test")
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                TokenError::Refresh {
                    kind: RefreshFailureKind::Transient,
                    status: Some(503),
                    ..
                }
            ),
            "{error:?}"
        );
        assert_eq!(token_requests(&server).len(), 3);
        // The pauses between attempts (40 ms then 90 ms in the test timings).
        assert!(started.elapsed() >= Duration::from_millis(130));
        assert_eq!(
            decrypt_field(&stored_account(&stores, "u1").await?, "refresh_token").as_deref(),
            Some("u1-refresh-0")
        );
        // The next call refreshes for real (the fourth request is answered by the state).
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refresh_that_times_out_is_transient() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        state.lock().unwrap().delay = Duration::from_millis(600);
        let server = twitch_mock(state, helix_ok).await?;
        let mut timings = fast_timings();
        timings.oauth_timeout = Duration::from_millis(150);
        let process = process(&stores, &server, timings)?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS,
        )
        .await?;
        let error = process
            .twitch
            .streamer_token("u1", None, "test")
            .await
            .unwrap_err();
        assert_eq!(
            error,
            TokenError::Refresh {
                kind: RefreshFailureKind::Transient,
                status: None,
                reason: RefreshFailureReason::Network,
            }
        );
        assert_eq!(server.wait_for(3).await.len(), 3);
        let actions = process.events.actions();
        assert_eq!(
            actions
                .iter()
                .filter(|a| *a == "token_refresh_attempt_failed")
                .count(),
            3
        );
        // Nothing was invalidated.
        assert_eq!(
            cache_fields(&stores, "u1").await?["has_permissions"],
            "true"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_after_the_caller_gave_up_is_still_stored() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        state.lock().unwrap().delay = Duration::from_millis(400);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS,
        )
        .await?;
        let gave_up = tokio::time::timeout(
            Duration::from_millis(50),
            process.twitch.streamer_token("u1", None, "test"),
        )
        .await;
        assert!(gave_up.is_err(), "the caller's own deadline passed first");
        // Twitch rotated the token (the old refresh token is now dead); the refresh carries on.
        let mut stored = String::new();
        for _ in 0..100 {
            stored = cache_fields(&stores, "u1")
                .await?
                .get("access_token")
                .cloned()
                .unwrap_or_default();
            if stored == "u1-access-1" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(stored, "u1-access-1");
        assert_eq!(
            decrypt_field(&stored_account(&stores, "u1").await?, "refresh_token").as_deref(),
            Some("u1-refresh-1")
        );
        state.lock().unwrap().delay = Duration::ZERO;
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejected_token_is_never_handed_back() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS + 3600,
        )
        .await?;
        let rejected = AccessToken::new("u1-access-0");
        let token = process
            .twitch
            .streamer_token("u1", Some(&rejected), "test")
            .await?;
        assert_eq!(token.expose(), "u1-access-1");
        // A newer cached token is reused without refreshing.
        let token = process
            .twitch
            .streamer_token("u1", Some(&rejected), "test")
            .await?;
        assert_eq!(token.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1);
        Ok(())
    })
    .await
}

/// Cutover: a TypeScript process still running in database 0 refreshed the token; MongoDB has
/// the new pair, Rust's cache the old one. The reference would wipe here (it compares with its
/// cache); Rust compares with MongoDB, keeps the tokens and repairs its cache.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_token_in_mongodb_is_never_wiped() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "ts-refresh");
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(&stores, &process, "u1", "u1-access-0", "u1-refresh-0", NOW_SECS).await?;
        // The other runtime's write.
        stores
            .mongo
            .documents("users")
            .update_one(
                doc! { "accounts.id": "u1" },
                doc! { "$set": {
                    "accounts.$.refresh_token": envelope("ts-refresh"),
                    "accounts.$.access_token": envelope("ts-access"),
                    "accounts.$.access_token_expires_at": Bson::Int32(i32::try_from(NOW_SECS + 7000)?),
                } },
            )
            .await?;
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "ts-access");
        assert_eq!(token_requests(&server).len(), 1, "one refused attempt with the stale token");
        let after = stored_account(&stores, "u1").await?;
        assert_eq!(decrypt_field(&after, "refresh_token").as_deref(), Some("ts-refresh"));
        assert!(after.get_bool("has_permissions")?);
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["refresh_token"], "ts-refresh");
        assert_eq!(cache["access_token"], "ts-access");
        assert_eq!(cache["expires_at"], (NOW_SECS + 7000).to_string());
        assert!(!process.events.actions().contains(&"tokens_invalidated".to_owned()));
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_bot_token_is_a_streamer_token_without_the_permission_gate() -> Result<()> {
    with_stores(|stores| async move {
        let bot = dima_twitch::TWITCH_BOT_ACCOUNT_ID;
        let state = state_with(bot, "bot-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        let mut user = user_document(
            bot,
            "domdimabot",
            "bot-access-0",
            "bot-refresh-0",
            Some(NOW_SECS),
        );
        if let Ok(accounts) = user.get_array_mut("accounts")
            && let Some(Bson::Document(account)) = accounts.get_mut(0)
        {
            account.insert("has_permissions", false);
        }
        insert_user(&stores, user).await?;
        process.twitch.load_streamers().await?;
        let token = process.twitch.bot_token().await?;
        assert_eq!(token.expose(), format!("{bot}-access-1"));
        // `app:twitch:bot` is not written (write-only in the reference).
        assert!(
            stores
                .dragonfly
                .get(&format!("{}app:twitch:bot", stores.keys.prefix()))
                .await?
                .is_none()
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_app_token_is_requested_once_and_cached_with_its_expiry() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "unused");
        state.lock().unwrap().delay = Duration::from_millis(100);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        let tasks: Vec<_> = (0..20)
            .map(|_| {
                let twitch = process.twitch.clone();
                tokio::spawn(async move { twitch.app_token().await })
            })
            .collect();
        for task in tasks {
            assert_eq!(
                task.await?.map(|t| t.expose().to_owned()).as_deref(),
                Some("app-token-1")
            );
        }
        let requests = token_requests(&server);
        assert_eq!(requests.len(), 1);
        assert_token_request(&requests[0], "client_credentials", None);
        let key = stores.keys.app_token();
        assert_eq!(
            cached_app_token(&stores).await?.as_deref(),
            Some("app-token-1")
        );
        assert_no_plain_tokens(&stores, &["app-token-1"]).await?;
        let ttl = stores.dragonfly.ttl(&key).await?;
        assert!(
            matches!(ttl, dima_store::dragonfly::Ttl::Seconds(s) if s > 5_000_000),
            "{ttl:?}"
        );
        assert_eq!(
            process
                .twitch
                .app_token()
                .await
                .map(|t| t.expose().to_owned())
                .as_deref(),
            Some("app-token-1")
        );
        assert_eq!(token_requests(&server).len(), 1);
        assert_no_secrets(&process.events, &["app-token-1"]);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_app_token_answer_without_a_usable_expiry_gives_no_token() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "unused");
        let server = twitch_mock(state, helix_ok).await?;
        server.push(MockResponse::json(
            200,
            r#"{"access_token":"app-x","expires_in":0}"#,
        ));
        server.push(MockResponse::json(
            400,
            r#"{"status":400,"message":"invalid client secret"}"#,
        ));
        let process = process(&stores, &server, fast_timings())?;
        // `SET … EX 0` throws in the reference, so no token is returned.
        assert!(process.twitch.app_token().await.is_none());
        assert!(process.twitch.app_token().await.is_none());
        assert!(
            stores
                .dragonfly
                .get(&stores.keys.app_token())
                .await?
                .is_none()
        );
        Ok(())
    })
    .await
}

/// A stored envelope that cannot be decrypted (malformed IV) is replaced by a successful
/// refresh instead of losing the rotated token.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_malformed_stored_envelope_is_replaced_by_a_refresh() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_with("u1", "u1-refresh-0");
        let server = twitch_mock(state, helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(
            &stores,
            &process,
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            NOW_SECS,
        )
        .await?;
        stores
            .mongo
            .documents("users")
            .update_one(
                doc! { "accounts.id": "u1" },
                doc! { "$set": { "accounts.$.refresh_token": { "iv": "00", "content": "abcd" } } },
            )
            .await?;
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        let after = stored_account(&stores, "u1").await?;
        assert_eq!(
            decrypt_field(&after, "refresh_token").as_deref(),
            Some("u1-refresh-1")
        );
        Ok(())
    })
    .await
}

/// Twitch's answers that echo the refresh token, the client secret and an e-mail (review finding
/// 6): the refusal is classified, and neither the logs nor the error (`Display` and `Debug`)
/// carry any of them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn twitch_answers_that_echo_secrets_never_reach_logs_or_errors() -> Result<()> {
    const EMAIL: &str = "streamer@example.invalid";
    let answers: [(u16, String, RefreshFailureReason); 4] = [
        (
            400,
            format!(
                r#"{{"status":400,"message":"Invalid refresh token u1-refresh-0 for {EMAIL}"}}"#
            ),
            RefreshFailureReason::InvalidGrant,
        ),
        (
            403,
            format!(
                r#"{{"status":403,"message":"invalid client {CLIENT_SECRET}","error_description":"u1-access-0 {EMAIL}"}}"#
            ),
            RefreshFailureReason::InvalidClient,
        ),
        (
            200,
            format!(r#"{{"error":"u1-refresh-0 {EMAIL}","access_token":"u1-access-0"}}"#),
            RefreshFailureReason::Refused,
        ),
        (
            502,
            format!("<html>u1-refresh-0 {EMAIL} {CLIENT_SECRET}</html>"),
            RefreshFailureReason::Unparseable,
        ),
    ];
    for (status, body, expected) in answers {
        with_stores(|stores| async move {
            let state = state_with("u1", "unused");
            let server = twitch_mock(state, helix_ok).await?;
            for _ in 0..3 {
                server.push(MockResponse::new(status).body(body.clone()));
            }
            let process = process(&stores, &server, fast_timings())?;
            seed(&stores, &process, "u1", "u1-access-0", "u1-refresh-0", NOW_SECS - 10).await?;
            let error = process
                .twitch
                .streamer_token("u1", None, "test")
                .await
                .unwrap_err();
            assert!(
                matches!(error, TokenError::Refresh { reason, status: Some(got), .. } if reason == expected && got == status),
                "{status}: {error:?}"
            );
            for text in [format!("{error:?}"), error.to_string()] {
                for secret in ["u1-refresh-0", "u1-access-0", EMAIL, CLIENT_SECRET] {
                    assert!(!text.contains(secret), "{status}: the error carries a secret");
                }
            }
            assert_no_secrets(&process.events, &["u1-refresh-0", "u1-access-0", EMAIL]);
            Ok(())
        })
        .await?;
    }
    // The app token: the reference logs Twitch's `message`.
    with_stores(|stores| async move {
        let state = state_with("u1", "unused");
        let server = twitch_mock(state, helix_ok).await?;
        server.push(MockResponse::json(
            400,
            &format!(
                r#"{{"status":400,"message":"invalid client secret {CLIENT_SECRET} {EMAIL}"}}"#
            ),
        ));
        let process = process(&stores, &server, fast_timings())?;
        assert!(process.twitch.app_token().await.is_none());
        assert_no_secrets(&process.events, &[EMAIL]);
        assert!(
            process
                .events
                .mentions("Error getting new Twitch app token: invalid_client")
        );
        Ok(())
    })
    .await
}
