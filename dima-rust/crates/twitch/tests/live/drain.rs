//! A rotation Twitch has answered is always written (review findings 1 and 2): shutdown does
//! not cancel the exchange or its write, a MongoDB failure after the answer retries the write
//! (never the exchange), and a rotation MongoDB has not taken when the process must stop is
//! parked in Dragonfly and applied by the next refresh, in another process.

use crate::support::*;
use anyhow::Result;
use dima_twitch::{FaultAction, FaultPoint};
use futures_util::FutureExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW_SECS: i64 = NOW_MS / 1000;

fn state(delay: Duration) -> Shared {
    let mut state = TwitchState {
        consume: true,
        expires_in: 14_400,
        delay,
        ..TwitchState::default()
    };
    state
        .valid
        .insert("u1-refresh-0".to_owned(), "u1".to_owned());
    Arc::new(Mutex::new(state))
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

/// MongoDB refuses the write `failures` times (forever with `usize::MAX`).
fn fail_writes(process: &Process, failures: usize) {
    let left = Arc::new(AtomicUsize::new(failures));
    process.twitch.set_fault_hook(move |point, _| {
        let fail = point == FaultPoint::BeforePersist
            && left
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok();
        async move {
            if fail {
                FaultAction::Fail
            } else {
                FaultAction::Continue
            }
        }
        .boxed()
    });
}

async fn stored_refresh(stores: &Stores) -> Result<Option<String>> {
    Ok(decrypt_field(
        &stored_account(stores, "u1").await?,
        "refresh_token",
    ))
}

async fn parked(stores: &Stores) -> Result<bool> {
    key_exists(stores, &stores.keys.parked_rotation("u1")).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mongodb_failure_after_twitch_answered_is_written_again_never_exchanged_again()
-> Result<()> {
    with_stores(|stores| async move {
        let state = state(Duration::ZERO);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(&stores, &process).await?;
        fail_writes(&process, 3);
        let token = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(
            token.expose(),
            "u1-access-1",
            "the caller has the new token at once"
        );
        // MongoDB takes it on a later write.
        let mut stored = None;
        for _ in 0..200 {
            stored = stored_refresh(&stores).await?;
            if stored.as_deref() == Some("u1-refresh-1") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(stored.as_deref(), Some("u1-refresh-1"));
        // Settled: unparked, cache written, the next call uses it, nothing sent again.
        for _ in 0..100 {
            if !parked(&stores).await?
                && !stores
                    .dragonfly
                    .exists(&[&stores.keys.exchange_marker("u1")])
                    .await
                    .map(|n| n == 1)?
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!parked(&stores).await?);
        assert_eq!(
            cache_fields(&stores, "u1").await?["refresh_token"],
            "u1-refresh-1"
        );
        let again = process.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(again.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1, "one exchange");
        let actions = process.events.actions();
        assert!(actions.contains(&"token_refresh_store_retrying".to_owned()));
        assert!(!actions.contains(&"tokens_invalidated".to_owned()));
        assert_no_secrets(&process.events, &["u1-access-1", "u1-refresh-1"]);
        assert_no_plain_tokens(&stores, &["u1-access-1", "u1-refresh-1"]).await?;
        Ok(())
    })
    .await
}

/// The process is told to stop while MongoDB refuses the write: when the drain ends the
/// rotation is parked in Dragonfly (encrypted), and the next refresh, in another process,
/// writes it to MongoDB and uses it without asking Twitch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rotation_not_written_before_exit_is_parked_and_applied_by_the_next_process() -> Result<()>
{
    with_stores(|stores| async move {
        let state = state(Duration::ZERO);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut timings = fast_timings();
        timings.exchange_drain = Duration::from_millis(300);
        let stopping = process(&stores, &server, timings)?;
        let next = process(&stores, &server, fast_timings())?;
        seed(&stores, &stopping).await?;
        fail_writes(&stopping, usize::MAX);
        let token = stopping.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        stopping.shutdown.trigger();
        assert!(
            !stopping.twitch.shutdown().await,
            "the write did not finish within the drain"
        );
        assert!(parked(&stores).await?, "parked");
        assert_eq!(
            stored_refresh(&stores).await?.as_deref(),
            Some("u1-refresh-0")
        );
        assert_no_plain_tokens(&stores, &["u1-access-1", "u1-refresh-1"]).await?;
        assert!(
            stopping
                .events
                .actions()
                .contains(&"token_refresh_parked".to_owned())
        );

        let token = next.twitch.streamer_token("u1", None, "next").await?;
        assert_eq!(token.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1, "nothing exchanged again");
        assert_eq!(
            stored_refresh(&stores).await?.as_deref(),
            Some("u1-refresh-1")
        );
        assert!(!parked(&stores).await?);
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["refresh_token"], "u1-refresh-1");
        assert_eq!(cache["has_permissions"], "true");
        assert!(
            next.events
                .actions()
                .contains(&"token_refresh_recovered".to_owned())
        );
        Ok(())
    })
    .await
}

/// The process is told to stop while Twitch is answering the exchange: the answer is still read
/// and written (the process's shutdown token does not cancel an exchange), and the drain waits
/// for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_during_an_exchange_still_stores_its_answer() -> Result<()> {
    with_stores(|stores| async move {
        let state = state(Duration::from_millis(400));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(&stores, &process).await?;
        let call = {
            let twitch = process.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "test").await })
        };
        assert_eq!(server.wait_for(1).await.len(), 1, "the exchange was sent");
        process.shutdown.trigger();
        assert!(process.twitch.shutdown().await, "the drain finished");
        assert_eq!(call.await??.expose(), "u1-access-1");
        assert_eq!(
            stored_refresh(&stores).await?.as_deref(),
            Some("u1-refresh-1")
        );
        assert_eq!(
            cache_fields(&stores, "u1").await?["refresh_token"],
            "u1-refresh-1"
        );
        assert_eq!(token_requests(&server).len(), 1);
        Ok(())
    })
    .await
}
