//! Refreshes racing (review finding 3): many tasks in one process, two processes (two handles
//! with their own in-memory state on the same MongoDB, Dragonfly and Twitch), an exchange slower
//! than the lease, a rejection that overlaps another process's refresh, the public refresh
//! racing a token request, a revoked token, and a process that dies between Twitch's answer and
//! the write.

use crate::support::*;
use anyhow::Result;
use dima_twitch::{
    FaultPoint, RefreshContext, RefreshFailureKind, RefreshFailureReason, RefreshOutcome,
    RefreshToken, TokenError,
};
use futures_util::FutureExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

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
        state
            .lock()
            .is_ok_and(|state| state.valid.contains_key(&stored)),
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

/// Every `action` logged by the processes, in no particular order.
fn actions(processes: &[&Process]) -> Vec<String> {
    processes
        .iter()
        .flat_map(|process| process.events.actions())
        .collect()
}

fn count(actions: &[String], action: &str) -> usize {
    actions.iter().filter(|a| *a == action).count()
}

/// Twitch answers after the 800 ms lease would have expired. The holder renews it, so the
/// process that asks at 900 ms waits for the holder's token instead of taking the lease over
/// and exchanging the same refresh token again (which, when Twitch consumed it, wiped the
/// streamer). Exactly one exchange, whatever Twitch does with a reused token.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_lease_that_would_have_expired_under_a_slow_exchange() -> Result<()> {
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
            // After the lease's first lifetime, while the exchange still waits for Twitch.
            tokio::time::sleep(Duration::from_millis(900)).await;
            let second = late.twitch.streamer_token("u1", None, "late").await;
            let first = first.await?;
            assert_eq!(first?.expose(), "u1-access-1");
            assert_eq!(
                second?.expose(),
                "u1-access-1",
                "the late one got the holder's token"
            );
            assert_eq!(token_requests(&server).len(), 1, "one exchange");
            assert_eq!(assert_consistent(&stores, &state).await?, "u1-refresh-1");
            let all = actions(&[&slow, &late]);
            assert_eq!(count(&all, "tokens_invalidated"), 0);
            assert_eq!(count(&all, "refresh_lock_takeover"), 0);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Parks the first time `process` reaches `point`; `parked` fires then, and it goes on once
/// `release` fires.
fn park_once(process: &Process, point: FaultPoint) -> (Arc<Notify>, Arc<Notify>) {
    let parked = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let armed = Arc::new(AtomicBool::new(true));
    let (on_park, on_release) = (Arc::clone(&parked), Arc::clone(&release));
    process.twitch.set_fault_hook(move |at, _| {
        let fire = at == point && armed.swap(false, Ordering::SeqCst);
        let (on_park, on_release) = (Arc::clone(&on_park), Arc::clone(&on_release));
        async move {
            if fire {
                on_park.notify_one();
                on_release.notified().await;
            }
        }
        .boxed()
    });
    (parked, release)
}

/// Process A's exchange has consumed the refresh token and A stalls before storing the
/// rotation, long enough to lose its lease. Process B takes the lease; the stored token is still
/// the consumed one, but A's exchange marker says an exchange is in flight: B sends nothing and
/// wipes nothing (the reference would exchange the consumed token, be refused and log the
/// streamer out). A then stores its rotation and everyone uses it.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_rejection_that_overlaps_another_refresh_is_inconclusive() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("u1-refresh-0", true, Duration::ZERO);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let a = process(&stores, &server, fast_timings())?;
        let b = process(&stores, &server, fast_timings())?;
        seed(&stores, &a).await?;
        let (parked, release) = park_once(&a, FaultPoint::AfterTwitchAnswer);
        let first = {
            let twitch = a.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "a").await })
        };
        parked.notified().await;
        // A's lease is gone (expired under the stall); its marker is still alive.
        stores
            .dragonfly
            .del(&[&stores.keys.refresh_lock("u1")])
            .await?;
        let overlapping = b.twitch.streamer_token("u1", None, "b").await;
        assert!(
            matches!(
                overlapping,
                Err(TokenError::Refresh {
                    kind: RefreshFailureKind::Transient,
                    reason: RefreshFailureReason::ExchangeInFlight,
                    ..
                })
            ),
            "{overlapping:?}"
        );
        assert_eq!(token_requests(&server).len(), 1, "B sent nothing");
        release.notify_one();
        assert_eq!(first.await??.expose(), "u1-access-1");
        assert_eq!(
            b.twitch.streamer_token("u1", None, "b").await?.expose(),
            "u1-access-1"
        );
        assert_eq!(token_requests(&server).len(), 1);
        assert_eq!(assert_consistent(&stores, &state).await?, "u1-refresh-1");
        assert_eq!(count(&actions(&[&a, &b]), "tokens_invalidated"), 0);
        Ok(())
    })
    .await
}

/// The public `refresh_token` (sign-in routes) used to exchange the presented token with no
/// lock: racing a token request, both sent the same refresh token, and the loser's refusal
/// wiped the streamer. It now waits for the lease, finds the token rotated and returns the
/// stored pair without sending anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn the_public_refresh_is_serialised_with_every_other_refresh() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("u1-refresh-0", true, Duration::from_millis(300));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let bot = process(&stores, &server, fast_timings())?;
        let api = process(&stores, &server, fast_timings())?;
        seed(&stores, &bot).await?;
        let token = {
            let twitch = bot.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "bot").await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let outcome = api
            .twitch
            .refresh_token(
                &RefreshToken::new("u1-refresh-0"),
                "u1",
                RefreshContext::new("POST /auth/mock-login", "test"),
            )
            .await;
        assert_eq!(token.await??.expose(), "u1-access-1");
        let RefreshOutcome::Success {
            access_token,
            refresh_token,
            ..
        } = outcome
        else {
            panic!("{outcome:?}");
        };
        assert_eq!(access_token.expose(), "u1-access-1");
        assert_eq!(refresh_token.expose(), "u1-refresh-1");
        assert_eq!(token_requests(&server).len(), 1);
        assert_eq!(assert_consistent(&stores, &state).await?, "u1-refresh-1");
        assert_eq!(count(&actions(&[&bot, &api]), "tokens_invalidated"), 0);
        Ok(())
    })
    .await
}

/// A refresh token that really is revoked: Twitch refuses it, slowly (longer than the lease).
/// Sixteen callers in two processes, one exchange, one wipe; the streamer ends logged out, and a
/// later call sends nothing (MongoDB has no token).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_revoked_token_is_wiped_exactly_once() -> Result<()> {
    with_stores(|stores| async move {
        let state = state("not-this-one", true, Duration::from_millis(1200));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let bot = process(&stores, &server, fast_timings())?;
        let api = process(&stores, &server, fast_timings())?;
        seed(&stores, &bot).await?;
        let mut tasks = Vec::new();
        for (index, process) in [&bot, &api].into_iter().enumerate() {
            for _ in 0..8 {
                let twitch = process.twitch.clone();
                tasks.push(tokio::spawn(async move {
                    // The second process asks while the first exchange is still running.
                    tokio::time::sleep(Duration::from_millis(300 * index as u64)).await;
                    twitch.streamer_token("u1", None, "test").await
                }));
            }
        }
        for task in tasks {
            assert!(task.await?.is_err());
        }
        assert_eq!(token_requests(&server).len(), 1, "one exchange");
        let all = actions(&[&bot, &api]);
        assert_eq!(count(&all, "tokens_invalidated"), 1, "one wipe");
        let after = stored_account(&stores, "u1").await?;
        assert!(!after.get_bool("has_permissions")?);
        assert_eq!(decrypt_field(&after, "refresh_token"), None);
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["has_permissions"], "false");
        assert_eq!(cache["refresh_token"], "");
        let later = api.twitch.streamer_token("u1", None, "later").await;
        assert_eq!(later, Err(TokenError::NoRefreshToken));
        assert_eq!(token_requests(&server).len(), 1);
        assert_eq!(count(&actions(&[&bot, &api]), "tokens_invalidated"), 1);
        Ok(())
    })
    .await
}

/// The process dies after Twitch answered and before anything was written: the one window no
/// fix closes (the new pair existed only in that answer). Its exchange marker blocks any other
/// exchange until it expires (no refusal is blamed on the stored token meanwhile); after that,
/// when Twitch consumed the old refresh token, the next refresh is refused and the streamer must
/// log in again; when Twitch keeps it valid, the next process simply refreshes.
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
                let signal = Arc::clone(&signal);
                async move {
                    if point == FaultPoint::AfterTwitchAnswer {
                        signal.notify_one();
                        std::future::pending::<()>().await;
                    }
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
            // The stores still hold the old pair; the dead process's lease expires on its own.
            let stored = stored_account(&stores, "u1").await?;
            assert_eq!(
                decrypt_field(&stored, "refresh_token").as_deref(),
                Some("u1-refresh-0")
            );
            // Once the dead holder's lease has expired, its marker still blocks an exchange.
            tokio::time::sleep(fast_timings().refresh_lock_ttl).await;
            let blocked = next.twitch.streamer_token("u1", None, "next").await;
            assert!(
                matches!(
                    blocked,
                    Err(TokenError::Refresh {
                        reason: RefreshFailureReason::ExchangeInFlight,
                        ..
                    })
                ),
                "{blocked:?}"
            );
            assert_eq!(
                token_requests(&server).len(),
                1,
                "nothing sent while the marker lives"
            );
            tokio::time::sleep(fast_timings().exchange_marker_ttl).await;
            let result = next.twitch.streamer_token("u1", None, "next").await;
            let after = stored_account(&stores, "u1").await?;
            if consume {
                assert!(
                    matches!(
                        result,
                        Err(TokenError::Refresh {
                            kind: RefreshFailureKind::Permanent,
                            ..
                        })
                    ),
                    "{result:?}"
                );
                assert!(!after.get_bool("has_permissions")?);
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
