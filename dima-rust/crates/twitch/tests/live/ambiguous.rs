//! A refusal after an ambiguous attempt in the same exchange (review F3): an attempt times out
//! (Twitch may have rotated the token and the answer is lost) or gets a 5xx, the retry presents
//! the same refresh token and Twitch answers "invalid refresh token". The refusal may be about a
//! token Twitch had just rotated, so nothing is wiped and permissions are not marked lost; the
//! next refresh, which starts clean, decides.

use crate::support::*;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::{RefreshFailureKind, TokenError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW_SECS: i64 = NOW_MS / 1000;
const INVALID: &str = r#"{"status":400,"message":"Invalid refresh token"}"#;

fn state() -> Shared {
    let mut state = TwitchState {
        consume: true,
        expires_in: 14_400,
        ..TwitchState::default()
    };
    state
        .valid
        .insert("u1-refresh-0".to_owned(), "u1".to_owned());
    Arc::new(Mutex::new(state))
}

/// One attempt of 150 ms, so a 600 ms answer is lost.
fn timings() -> dima_twitch::Timings {
    dima_twitch::Timings {
        oauth_timeout: Duration::from_millis(150),
        ..fast_timings()
    }
}

async fn seed(stores: &Stores, process: &Process) -> Result<()> {
    insert_user(
        stores,
        user_document(
            "u1",
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            Some(NOW_SECS - 10),
        ),
    )
    .await?;
    process.twitch.load_streamers().await?;
    Ok(())
}

/// MongoDB and the cache still hold the streamer's first pair, with permissions.
async fn assert_untouched(stores: &Stores, process: &Process) -> Result<()> {
    let stored = stored_account(stores, "u1").await?;
    assert_eq!(
        decrypt_field(&stored, "refresh_token").as_deref(),
        Some("u1-refresh-0")
    );
    assert!(stored.get_bool("has_permissions")?);
    assert!(stored.get_bool("up_to_date_permissions")?);
    let cache = cache_fields(stores, "u1").await?;
    assert_eq!(cache["refresh_token"], "u1-refresh-0");
    assert_eq!(cache["has_permissions"], "true");
    let actions = process.events.actions();
    assert!(!actions.contains(&"tokens_invalidated".to_owned()));
    Ok(())
}

/// Transient, with Twitch's status and the reason `inconclusive_refusal`
/// (`RefreshFailureReason::Inconclusive`).
fn assert_inconclusive(result: &Result<dima_twitch::AccessToken, TokenError>) {
    assert!(
        matches!(
            result,
            Err(TokenError::Refresh {
                kind: RefreshFailureKind::Transient,
                status: Some(400),
                reason,
            }) if reason.as_str() == "inconclusive_refusal"
        ),
        "{result:?}"
    );
}

/// The first attempt reached Twitch: the refresh token was consumed and the new pair is lost
/// with the answer. The retry is refused; nothing is wiped. The next refresh is refused with no
/// ambiguity and decides: the streamer must log in again (the pair was lost either way).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejection_after_a_lost_answer_wipes_nothing_and_the_next_refresh_decides() -> Result<()>
{
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock_delayed(Arc::clone(&state), |n| {
            if n == 0 {
                Duration::from_millis(600)
            } else {
                Duration::ZERO
            }
        })
        .await?;
        let process = process(&stores, &server, timings())?;
        seed(&stores, &process).await?;
        let first = process.twitch.streamer_token("u1", None, "test").await;
        assert_inconclusive(&first);
        assert_eq!(
            token_requests(&server).len(),
            2,
            "a timeout, then the refusal"
        );
        assert!(
            state.lock().unwrap().valid.contains_key("u1-refresh-1"),
            "Twitch did rotate on the first attempt"
        );
        assert_untouched(&stores, &process).await?;
        assert!(
            process
                .events
                .actions()
                .contains(&"token_refresh_inconclusive".to_owned())
        );

        // The marker of the ambiguous exchange expires; the next refresh starts clean.
        marker_gone(&stores, "u1").await?;
        let next = process.twitch.streamer_token("u1", None, "test").await;
        assert!(
            matches!(
                next,
                Err(TokenError::Refresh {
                    kind: RefreshFailureKind::Permanent,
                    ..
                })
            ),
            "{next:?}"
        );
        let stored = stored_account(&stores, "u1").await?;
        assert!(!stored.get_bool("has_permissions")?);
        assert_eq!(decrypt_field(&stored, "refresh_token"), None);
        assert_no_secrets(&process.events, &["u1-refresh-0", "u1-refresh-1"]);
        Ok(())
    })
    .await
}

/// The first attempt never reached Twitch's token service (its answer is lost, the token is
/// still valid) and the retry gets a stray refusal: nothing is wiped, and the next refresh
/// rotates the token. The streamer did not have to log in again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stray_rejection_after_a_lost_request_wipes_nothing_and_the_next_refresh_rotates()
-> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        // Not processed by the state: Twitch never saw these two.
        server.push(MockResponse::json(200, "{}").delay(Duration::from_millis(600)));
        server.push(MockResponse::json(400, INVALID));
        let process = process(&stores, &server, timings())?;
        seed(&stores, &process).await?;
        let first = process.twitch.streamer_token("u1", None, "test").await;
        assert_inconclusive(&first);
        assert_eq!(token_requests(&server).len(), 2);
        assert_untouched(&stores, &process).await?;

        marker_gone(&stores, "u1").await?;
        let next = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(next.expose(), "u1-access-1");
        assert_eq!(
            decrypt_field(&stored_account(&stores, "u1").await?, "refresh_token").as_deref(),
            Some("u1-refresh-1")
        );
        assert_eq!(token_requests(&server).len(), 3);
        Ok(())
    })
    .await
}

/// A 5xx can come from Twitch's gateway after its token service rotated the token: a refusal
/// on the retry is inconclusive too.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejection_after_a_5xx_wipes_nothing() -> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        server.push(MockResponse::json(504, r#"{"message":"Gateway Timeout"}"#));
        server.push(MockResponse::json(400, INVALID));
        let process = process(&stores, &server, timings())?;
        seed(&stores, &process).await?;
        let first = process.twitch.streamer_token("u1", None, "test").await;
        assert_inconclusive(&first);
        assert_untouched(&stores, &process).await?;
        Ok(())
    })
    .await
}

/// The ambiguity survives the end of the drain: the first attempt's answer is lost, the retry
/// is still waiting for Twitch when the process stops and its drain ends. The retry is
/// cancelled, the exchange ends ambiguous, nothing is wiped and the marker is left to expire.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_drain_ending_during_the_retry_keeps_the_exchange_ambiguous() -> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock_delayed(Arc::clone(&state), |n| {
            if n == 0 {
                Duration::from_millis(1500)
            } else {
                Duration::from_secs(20)
            }
        })
        .await?;
        let mut timings = timings();
        // Each attempt may take 1 s, so the retry is still waiting when the 200 ms drain ends;
        // the marker outlives the test's checks.
        timings.oauth_timeout = Duration::from_secs(1);
        timings.exchange_drain = Duration::from_millis(200);
        timings.exchange_marker_ttl = Duration::from_secs(30);
        let process = process(&stores, &server, timings)?;
        seed(&stores, &process).await?;
        let call = {
            let twitch = process.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "test").await })
        };
        assert_eq!(server.wait_for(2).await.len(), 2, "the retry was sent");
        process.shutdown.trigger();
        process.twitch.shutdown().await;
        let result = call.await?;
        assert!(
            matches!(
                result,
                Err(TokenError::Refresh {
                    kind: RefreshFailureKind::Transient,
                    ..
                })
            ),
            "{result:?}"
        );
        assert_untouched(&stores, &process).await?;
        assert!(
            key_exists(&stores, &stores.keys.exchange_marker("u1")).await?,
            "the marker of an exchange whose outcome is unknown is left to expire"
        );
        Ok(())
    })
    .await
}
