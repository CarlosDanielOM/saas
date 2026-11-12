//! An answer Twitch gave is never forgotten while the process lives (review F1, F4): it is in
//! the registry until MongoDB holds it, each retry and the last step of shutdown make sure its
//! recovery record holds it, and only both stores failing at the end loses it (logged once per
//! streamer).

use crate::support::*;
use anyhow::Result;
use dima_twitch::{FaultAction, FaultPoint, Level};
use futures_util::FutureExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

const NOW_SECS: i64 = NOW_MS / 1000;

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

async fn stored_refresh(stores: &Stores, id: &str) -> Result<Option<String>> {
    Ok(decrypt_field(
        &stored_account(stores, id).await?,
        "refresh_token",
    ))
}

/// MongoDB refuses every write of `process` (as an outage would).
fn fail_writes(process: &Process) {
    process.twitch.set_fault_hook(|point, _| {
        async move {
            if point == FaultPoint::BeforePersist {
                FaultAction::Fail
            } else {
                FaultAction::Continue
            }
        }
        .boxed()
    });
}

/// The answer in the record is applied by `next` without asking Twitch again.
async fn next_process_uses_the_answer(
    stores: &Stores,
    server: &dima_http::testing::MockServer,
    next: &Process,
) -> Result<()> {
    let token = next.twitch.streamer_token("u1", None, "next").await?;
    assert_eq!(token.expose(), "u1-access-1");
    assert_eq!(token_requests(server).len(), 1, "nothing exchanged again");
    assert_eq!(
        stored_refresh(stores, "u1").await?.as_deref(),
        Some("u1-refresh-1")
    );
    assert!(!key_exists(stores, &stores.keys.parked_rotation("u1")).await?);
    Ok(())
}

/// Review F1: R0 is exchanged for R1, the record is written, MongoDB refuses the write, and the
/// record is lost (a Dragonfly restart or flush). The answer is still in the registry: the next
/// retry and the last step of shutdown write the record again, and the next process writes R1
/// to MongoDB without asking Twitch. (Before: the background writer trusted "parked once",
/// logged `token_refresh_parked` and forgot R1.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_lost_while_the_write_is_pending_is_written_again() -> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut timings = fast_timings();
        timings.exchange_drain = Duration::from_millis(300);
        let stopping = process(&stores, &server, timings)?;
        let next = process(&stores, &server, fast_timings())?;
        seed(&stores, &stopping).await?;
        fail_writes(&stopping);
        let token = stopping.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        let key = &stores.keys.parked_rotation("u1");
        let stores_ref = &stores;
        eventually("the answer is parked", move || async move {
            key_exists(stores_ref, key).await
        })
        .await?;
        stores.dragonfly.del(&[key]).await?;

        stopping.shutdown.trigger();
        assert!(!stopping.twitch.shutdown().await, "MongoDB never took it");
        let parked = parked_answer(&stores, "u1").await?;
        assert_eq!(
            parked.map(|(_, refresh)| refresh).as_deref(),
            Some("u1-refresh-1"),
            "the record holds the answer again when shutdown returns"
        );
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-0")
        );
        stopping.twitch.kill();

        next_process_uses_the_answer(&stores, &server, &next).await?;
        assert_no_secrets(&stopping.events, &["u1-access-1", "u1-refresh-1"]);
        assert_no_plain_tokens(&stores, &["u1-access-1", "u1-refresh-1"]).await?;
        Ok(())
    })
    .await
}

/// Review F4: the process is told to stop while Twitch is answering; the first write of the
/// record is slow (it times out) and MongoDB is slow too (its write outlives the drain). The
/// last step of shutdown parks what the registry holds: when shutdown returns, the answer is in
/// Dragonfly, and the next process uses it. (Before: shutdown returned while the answer existed
/// only in the foreground's write, and the process exit lost it.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_with_slow_writes_at_shutdown_is_in_dragonfly_when_shutdown_returns() -> Result<()>
{
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut timings = fast_timings();
        timings.exchange_drain = Duration::from_millis(300);
        timings.park_grace = Duration::from_millis(400);
        let stopping = process(&stores, &server, timings)?;
        let next = process(&stores, &server, fast_timings())?;
        seed(&stores, &stopping).await?;
        let registered = Arc::new(Notify::new());
        let first_park = Arc::new(AtomicBool::new(true));
        {
            let registered = Arc::clone(&registered);
            stopping.twitch.set_fault_hook(move |point, _| {
                let slow_park =
                    point == FaultPoint::BeforePark && first_park.swap(false, Ordering::SeqCst);
                let registered = Arc::clone(&registered);
                async move {
                    if slow_park {
                        registered.notify_one();
                        // Longer than `park_grace`: this write of the record times out.
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    } else if point == FaultPoint::BeforePersist {
                        // MongoDB hangs past the end of the drain.
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
                .boxed()
            });
        }
        let call = {
            let twitch = stopping.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "test").await })
        };
        registered.notified().await;
        stopping.shutdown.trigger();
        assert!(!stopping.twitch.shutdown().await);
        let parked = parked_answer(&stores, "u1").await?;
        assert_eq!(
            parked.map(|(_, refresh)| refresh).as_deref(),
            Some("u1-refresh-1"),
            "the answer is in Dragonfly when shutdown returns"
        );
        assert!(
            stopping
                .events
                .actions()
                .contains(&"token_refresh_parked".to_owned())
        );
        // The process exits; its lease expires on its own.
        stopping.twitch.kill();
        let _ = call.await?;
        let lease = &stores.keys.refresh_lock("u1");
        let stores_ref = &stores;
        eventually("the dead process's lease expired", move || async move {
            Ok(!key_exists(stores_ref, lease).await?)
        })
        .await?;

        next_process_uses_the_answer(&stores, &server, &next).await?;
        Ok(())
    })
    .await
}

/// Both stores refuse until the process stops: the answer is lost, and that is logged once for
/// the streamer, at error level, with the streamer id and no secret.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_both_stores_refuse_at_shutdown_is_logged_lost_once() -> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut timings = fast_timings();
        timings.exchange_drain = Duration::from_millis(300);
        timings.park_grace = Duration::from_millis(300);
        let stopping = process(&stores, &server, timings)?;
        seed(&stores, &stopping).await?;
        let parks = Arc::new(AtomicUsize::new(0));
        {
            let parks = Arc::clone(&parks);
            stopping.twitch.set_fault_hook(move |point, _| {
                if point == FaultPoint::BeforePark {
                    parks.fetch_add(1, Ordering::SeqCst);
                }
                async move {
                    if matches!(point, FaultPoint::BeforePark | FaultPoint::BeforePersist) {
                        FaultAction::Fail
                    } else {
                        FaultAction::Continue
                    }
                }
                .boxed()
            });
        }
        let token = stopping.twitch.streamer_token("u1", None, "test").await?;
        assert_eq!(token.expose(), "u1-access-1");
        stopping.shutdown.trigger();
        assert!(!stopping.twitch.shutdown().await);
        assert!(!key_exists(&stores, &stores.keys.parked_rotation("u1")).await?);
        assert!(
            parks.load(Ordering::SeqCst) >= 3,
            "the foreground, the retries and the last step each tried"
        );
        let lost: Vec<_> = stopping
            .events
            .entries()
            .into_iter()
            .filter(|entry| entry.action() == Some("token_refresh_lost"))
            .collect();
        assert_eq!(lost.len(), 1, "once per streamer");
        assert_eq!(lost[0].level, Level::Error);
        assert_eq!(lost[0].channel_id.as_deref(), Some("u1"));
        assert_eq!(lost[0].data["userId"], "u1");
        assert_no_secrets(&stopping.events, &["u1-access-1", "u1-refresh-1"]);
        Ok(())
    })
    .await
}
