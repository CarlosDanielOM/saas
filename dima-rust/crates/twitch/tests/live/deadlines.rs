//! The chat path cannot be held by the cache (review finding 11): a directory read answers
//! within the caller's deadline and tells "no such streamer" from "directory unavailable", and
//! the wait for another process's refresh never exceeds its bound.

use crate::support::*;
use anyhow::Result;
use dima_twitch::{FaultPoint, TokenError, TwitchError};
use futures_util::FutureExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

const NOW_SECS: i64 = NOW_MS / 1000;

/// Dragonfly answers u1's directory read only after two seconds (a stalled store).
fn stall_reads_of_u1(process: &Process) {
    process.twitch.set_fault_hook(|point, id| {
        let stall = point == FaultPoint::DirectoryRead && id == "u1";
        async move {
            if stall {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        .boxed()
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_directory_read_answers_within_the_callers_deadline() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(Arc::new(Mutex::new(TwitchState::default())), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        for id in ["u1", "u2"] {
            insert_user(
                &stores,
                user_document(id, id, "a", "r", Some(NOW_SECS + 3600)),
            )
            .await?;
        }
        process.twitch.load_streamers().await?;
        stall_reads_of_u1(&process);

        let started = Instant::now();
        let stalled = process
            .twitch
            .streamer_within("u1", Duration::from_millis(100))
            .await;
        assert!(
            started.elapsed() < Duration::from_millis(600),
            "{:?}",
            started.elapsed()
        );
        assert!(
            matches!(stalled, Err(TwitchError::Deadline { .. })),
            "{stalled:?}"
        );

        // Unavailable is not "not found"; an unknown streamer is.
        let unknown = process
            .twitch
            .streamer_within("nobody", Duration::from_secs(1))
            .await?;
        assert!(unknown.is_none());
        let found = process
            .twitch
            .streamer_within("u2", Duration::from_secs(1))
            .await?;
        assert_eq!(
            found.map(|account| account.name().to_owned()).as_deref(),
            Some("u2")
        );

        // The reference's entry point keeps its shape (an error is `None`) under the default
        // deadline (500 ms).
        let started = Instant::now();
        assert!(process.twitch.streamer("u1").await.is_none());
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "{:?}",
            started.elapsed()
        );
        Ok(())
    })
    .await
}

/// Process A holds the lease (its exchange is parked); process B waits for A's token, and
/// every look at the cache takes two seconds. B gives up within its 720 ms wait (plus one
/// attempt at the lease), not after the slow command.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn the_wait_for_another_refresh_never_exceeds_its_bound() -> Result<()> {
    with_stores(|stores| async move {
        let mut state = TwitchState {
            consume: true,
            expires_in: 14_400,
            ..TwitchState::default()
        };
        state
            .valid
            .insert("u1-refresh-0".to_owned(), "u1".to_owned());
        let state = Arc::new(Mutex::new(state));
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let a = process(&stores, &server, fast_timings())?;
        let b = process(&stores, &server, fast_timings())?;
        insert_user(
            &stores,
            user_document(
                "u1",
                "u1",
                "u1-access-0",
                "u1-refresh-0",
                Some(NOW_SECS - 10),
            ),
        )
        .await?;
        a.twitch.load_streamers().await?;
        let parked = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (on_park, on_release) = (Arc::clone(&parked), Arc::clone(&release));
        a.twitch.set_fault_hook(move |point, _| {
            let hold = point == FaultPoint::AfterTwitchAnswer;
            let (on_park, on_release) = (Arc::clone(&on_park), Arc::clone(&on_release));
            async move {
                if hold {
                    on_park.notify_one();
                    on_release.notified().await;
                }
            }
            .boxed()
        });
        b.twitch.set_fault_hook(|point, _| {
            let slow = point == FaultPoint::RefreshWaitPoll;
            async move {
                if slow {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
            .boxed()
        });
        let holder = {
            let twitch = a.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "a").await })
        };
        parked.notified().await;
        let started = Instant::now();
        let waited = b.twitch.streamer_token("u1", None, "b").await;
        let elapsed = started.elapsed();
        assert_eq!(waited, Err(TokenError::LockUnavailable));
        assert!(elapsed < Duration::from_millis(1500), "waited {elapsed:?}");
        release.notify_one();
        assert_eq!(holder.await??.expose(), "u1-access-1");
        Ok(())
    })
    .await
}
