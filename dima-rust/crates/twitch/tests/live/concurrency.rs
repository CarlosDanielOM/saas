//! Refreshes racing: many tasks in one process, two processes (two handles with their own
//! in-memory state on the same MongoDB, Dragonfly and Twitch), a refresh slower than the lock's
//! lease, and a process that dies between Twitch's answer and the write.

use crate::support::*;
use anyhow::Result;
use dima_twitch::{FaultPoint, TokenError};
use futures_util::FutureExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW_SECS: i64 = NOW_MS / 1000;

fn state(refresh: &str, consume: bool, delay: Duration) -> Shared {
    let mut state = TwitchState {
        consume,
        expires_in: 14_400,
        delay,
        ..TwitchState::default()
    };
    state.valid.insert(refresh.to_owned(), "u1".to_owned());
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
            Some(NOW_SECS - 1),
        ),
    )
    .await?;
    process.twitch.load_streamers().await?;
    Ok(())
}

/// The refresh token Twitch accepts now, and MongoDB's view.
async fn assert_consistent(stores: &Stores, state: &Shared) -> Result<String> {
    let stored =
        decrypt_field(&stored_account(stores, "u1").await?, "refresh_token").unwrap_or_default();
    assert!(
        state.lock().unwrap().valid.contains_key(&stored),
        "MongoDB holds a refresh token Twitch still accepts"
    );
    let cache = cache_fields(stores, "u1").await?;
    assert_eq!(
        cache.get("refresh_token"),
        Some(&stored),
        "cache and MongoDB agree"
    );
    assert_eq!(
        cache.get("has_permissions").map(String::as_str),
        Some("true")
    );
    Ok(stored)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn many_tasks_in_one_process_make_one_refresh() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("u1-refresh-0", true, Duration::from_millis(100));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        seed(&stores, &process).await?;
        let tasks: Vec<_> = (0..64)
            .map(|_| {
                let twitch = process.twitch.clone();
                tokio::spawn(async move { twitch.streamer_token("u1", None, "test").await })
            })
            .collect();
        for task in tasks {
            assert_eq!(task.await??.expose(), "u1-access-1");
        }
        assert_eq!(token_requests(&server).len(), 1, "one refresh on the wire");
        assert_consistent(&stores, &state).await?;
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn two_processes_refresh_once_and_both_get_the_winners_token() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("u1-refresh-0", true, Duration::from_millis(150));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let bot = process(&stores, &server, fast_timings())?;
        let api = process(&stores, &server, fast_timings())?;
        seed(&stores, &bot).await?;
        let mut tasks = Vec::new();
        for process in [&bot, &api] {
            for _ in 0..16 {
                let twitch = process.twitch.clone();
                tasks.push(tokio::spawn(async move {
                    twitch.streamer_token("u1", None, "test").await
                }));
            }
        }
        for task in tasks {
            assert_eq!(task.await??.expose(), "u1-access-1");
        }
        assert_eq!(
            token_requests(&server).len(),
            1,
            "the lock let one process refresh"
        );
        assert_eq!(assert_consistent(&stores, &state).await?, "u1-refresh-1");
        let waited = bot
            .events
            .actions()
            .iter()
            .chain(api.events.actions().iter())
            .any(|a| a == "returned_token_from_concurrent_refresh");
        assert!(waited, "the loser waited for the winner's token");
        Ok(())
    })
    .await
}

/// Twitch answers after the 800 ms lease expired, so a second process takes the lock and
/// refreshes with the same refresh token. Whatever Twitch does with the reused token, the
/// stores end with a pair Twitch accepts, never an older one over a newer one, and nobody
/// has to log in again.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_refresh_slower_than_the_lease_never_stores_an_older_token() -> Result<()> {
    for consume in [true, false] {
        with_stores(|stores| async move {
            let state = state("u1-refresh-0", consume, Duration::from_millis(1200));
            let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
            let slow = process(&stores, &server, fast_timings())?;
            let late = process(&stores, &server, fast_timings())?;
            seed(&stores, &slow).await?;
            let first = {
                let twitch = slow.twitch.clone();
                tokio::spawn(async move { twitch.streamer_token("u1", None, "slow").await })
            };
            // After the lease expired, while the first refresh still waits for Twitch.
            tokio::time::sleep(Duration::from_millis(900)).await;
            state.lock().unwrap().delay = Duration::from_millis(50);
            let second = late.twitch.streamer_token("u1", None, "late").await;
            let first = first.await?;
            match (&first, &second) {
                (Ok(a), Ok(b)) => {
                    // Twitch kept the old refresh token valid: both got tokens; the later write won
                    // and the earlier one did not overwrite it.
                    assert!(!consume);
                    assert_eq!(b.expose(), "u1-access-2");
                    assert_eq!(
                        a.expose(),
                        "u1-access-2",
                        "the slow one returns the stored, newer token"
                    );
                }
                (Ok(a), Err(TokenError::Refresh { .. })) => {
                    // Twitch had consumed it: the late refresh was refused, its wipe raced with the
                    // slow write and the slow write still landed.
                    assert!(consume);
                    assert_eq!(a.expose(), "u1-access-1");
                }
                other => panic!("unexpected outcome {other:?}"),
            }
            let stored = assert_consistent(&stores, &state).await?;
            let expected = if consume {
                "u1-refresh-1"
            } else {
                "u1-refresh-2"
            };
            assert_eq!(stored, expected);
            let after = stored_account(&stores, "u1").await?;
            assert_eq!(after.get_bool("has_permissions")?, true);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// The process dies after Twitch answered and before anything was written. The rotated pair is
/// lost: when Twitch consumed the old refresh token the next refresh is refused and the stored
/// tokens are wiped (the reference's consequence: the streamer logs in again); when Twitch keeps
/// it valid, the next process simply refreshes.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_process_that_dies_between_the_answer_and_the_write() -> Result<()> {
    for consume in [true, false] {
        with_stores(|stores| async move {
            let state = state("u1-refresh-0", consume, Duration::ZERO);
            let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
            let dying = process(&stores, &server, fast_timings())?;
            let next = process(&stores, &server, fast_timings())?;
            seed(&stores, &dying).await?;
            let parked = Arc::new(tokio::sync::Notify::new());
            let signal = Arc::clone(&parked);
            dying.twitch.set_fault_hook(move |point, _| {
                assert_eq!(point, FaultPoint::AfterTwitchAnswer);
                let signal = Arc::clone(&signal);
                async move {
                    signal.notify_one();
                    std::future::pending::<()>().await;
                }
                .boxed()
            });
            let call = {
                let twitch = dying.twitch.clone();
                tokio::spawn(async move { twitch.streamer_token("u1", None, "dying").await })
            };
            parked.notified().await;
            dying.twitch.kill();
            assert!(call.await?.is_err());
            assert!(
                dying.twitch.shutdown().await,
                "the dead process's tasks stopped"
            );
            // The stores still hold the old pair; the dead process's lock expires on its own.
            let stored = stored_account(&stores, "u1").await?;
            assert_eq!(
                decrypt_field(&stored, "refresh_token").as_deref(),
                Some("u1-refresh-0")
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
            let result = next.twitch.streamer_token("u1", None, "next").await;
            let after = stored_account(&stores, "u1").await?;
            if consume {
                assert!(
                    matches!(result, Err(TokenError::Refresh { .. })),
                    "{result:?}"
                );
                assert_eq!(after.get_bool("has_permissions")?, false);
            } else {
                assert_eq!(result?.expose(), "u1-access-2");
                assert_eq!(
                    decrypt_field(&after, "refresh_token").as_deref(),
                    Some("u1-refresh-2")
                );
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}
