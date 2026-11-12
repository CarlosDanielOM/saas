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

pub(crate) const NOW_SECS: i64 = NOW_MS / 1000;

pub(crate) fn state() -> Shared {
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

pub(crate) async fn stored_refresh(stores: &Stores, id: &str) -> Result<Option<String>> {
    Ok(decrypt_field(
        &stored_account(stores, id).await?,
        "refresh_token",
    ))
}

/// MongoDB refuses every write of `process` (as an outage would).
pub(crate) fn fail_writes(process: &Process) {
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

/// Review F2: a recovery record has no expiry. It waits, however long the streamer is not used,
/// until a refresh or the reconciliation writes it to MongoDB. (Before: 30 days, then the next
/// refresh exchanged the consumed token and wiped the streamer.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recovery_record_never_expires() -> Result<()> {
    with_stores(|stores| async move {
        let state = state();
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut timings = fast_timings();
        timings.exchange_drain = Duration::from_millis(300);
        let stopping = process(&stores, &server, timings)?;
        seed(&stores, &stopping).await?;
        fail_writes(&stopping);
        stopping.twitch.streamer_token("u1", None, "test").await?;
        stopping.shutdown.trigger();
        assert!(!stopping.twitch.shutdown().await);
        let key = stores.keys.parked_rotation("u1");
        assert_eq!(
            stores.dragonfly.ttl(&key).await?,
            dima_store::dragonfly::Ttl::NoExpiry
        );
        Ok(())
    })
    .await
}

/// Twitch's state with a valid refresh token `{id}-refresh-0` for each streamer.
pub(crate) fn state_for(ids: &[&str]) -> Shared {
    let state = state();
    {
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in ids {
            state
                .valid
                .insert(format!("{id}-refresh-0"), (*id).to_owned());
        }
    }
    state
}

/// Seeds `ids`, then leaves a recovery record for each: a process whose MongoDB refuses every
/// write refreshes them all and stops.
pub(crate) async fn park_answers(
    stores: &Stores,
    server: &dima_http::testing::MockServer,
    ids: &[&str],
) -> Result<()> {
    park_answers_at(stores, server, ids, None).await
}

/// [`park_answers`], each user stored with the generation (`refreshed_at`, milliseconds)
/// `generation` when it is given.
pub(crate) async fn park_answers_at(
    stores: &Stores,
    server: &dima_http::testing::MockServer,
    ids: &[&str],
    generation: Option<i64>,
) -> Result<()> {
    for id in ids {
        let access = format!("{id}-access-0");
        let refresh = format!("{id}-refresh-0");
        let mut user = user_document(id, id, &access, &refresh, Some(NOW_SECS - 10));
        if let Some(generation) = generation {
            user.insert("refreshed_at", bson::DateTime::from_millis(generation));
        }
        insert_user(stores, user).await?;
    }
    let mut timings = fast_timings();
    timings.exchange_drain = Duration::from_millis(300);
    let stopping = process(stores, server, timings)?;
    stopping.twitch.load_streamers().await?;
    fail_writes(&stopping);
    for id in ids {
        let token = stopping.twitch.streamer_token(id, None, "test").await?;
        assert_eq!(token.expose(), format!("{id}-access-1"));
    }
    stopping.shutdown.trigger();
    assert!(!stopping.twitch.shutdown().await);
    for id in ids {
        assert_eq!(
            parked_answer(stores, id).await?.map(|(_, refresh)| refresh),
            Some(format!("{id}-refresh-1"))
        );
    }
    Ok(())
}

/// Every recovery record under the test prefix.
pub(crate) async fn records(stores: &Stores) -> Result<Vec<String>> {
    let mut found = Vec::new();
    let mut scan = stores
        .dragonfly
        .scan(&stores.keys.parked_pattern(), Some(500));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            found.push(String::from_utf8(key)?);
        }
    }
    Ok(found)
}

/// Kills `process` the first time it reaches `point`, while it reconciles.
async fn kill_reconciliation_at(process: &Process, point: FaultPoint) -> Result<()> {
    let reached = Arc::new(Notify::new());
    let armed = Arc::new(AtomicBool::new(true));
    {
        let reached = Arc::clone(&reached);
        process.twitch.set_fault_hook(move |at, _| {
            let stop = at == point && armed.swap(false, Ordering::SeqCst);
            let reached = Arc::clone(&reached);
            async move {
                if stop {
                    reached.notify_one();
                    std::future::pending::<()>().await;
                }
            }
            .boxed()
        });
    }
    let run = {
        let twitch = process.twitch.clone();
        tokio::spawn(async move { twitch.reconcile_recovery().await })
    };
    reached.notified().await;
    process.twitch.kill();
    assert!(run.await?.is_err(), "the run was interrupted");
    Ok(())
}

/// Review F2: R1 was parked during a MongoDB outage, the process exited, and the streamer was
/// not used for 60 days. The record is still there, and the next process writes it to MongoDB
/// when it starts, without asking Twitch; the next refresh exchanges R1, not the consumed R0.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_older_than_any_former_lifetime_is_reconciled_at_start() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &["u1"]).await?;
        let later = dima_core::ManualClock::new(NOW_MS + 60 * 86_400_000);
        let next = process_at(&stores, &server, fast_timings(), later)?;
        let report = next.twitch.start_recovery().await;
        assert_eq!(
            report,
            Some(dima_twitch::RecoveryReport {
                applied: 1,
                ..Default::default()
            })
        );
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-1")
        );
        assert!(records(&stores).await?.is_empty());
        assert_eq!(
            token_requests(&server).len(),
            1,
            "nothing exchanged at start"
        );
        // Its access token expired long ago: the next refresh exchanges R1 (once the stopped
        // process's marker, left to expire, is gone).
        marker_gone(&stores, "u1").await?;
        let token = next.twitch.streamer_token("u1", None, "later").await?;
        assert_eq!(token.expose(), "u1-access-2");
        let requests = token_requests(&server);
        assert_eq!(requests.len(), 2);
        assert_eq!(
            form_value(&requests[1], "refresh_token").as_deref(),
            Some("u1-refresh-1")
        );
        assert!(
            next.events
                .actions()
                .contains(&"token_recovery_reconciled".to_owned())
        );
        assert_no_secrets(&next.events, &["u1-refresh-1", "u1-access-1"]);
        Ok(())
    })
    .await
}

/// Two processes reconcile the same records at once: each answer is written exactly once (the
/// compare-and-set lets one writer through; the other finds MongoDB holding it), and no record
/// is left.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn two_processes_reconcile_at_once_and_each_record_is_applied_once() -> Result<()> {
    with_stores(|stores| async move {
        let ids = ["u1", "u2", "u3", "u4", "u5"];
        let state = state_for(&ids);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &ids).await?;
        let a = process(&stores, &server, fast_timings())?;
        let b = process(&stores, &server, fast_timings())?;
        let (first, second) =
            tokio::join!(a.twitch.reconcile_recovery(), b.twitch.reconcile_recovery());
        let (first, second) = (first?, second?);
        assert_eq!(
            first.applied + second.applied,
            ids.len(),
            "{first:?} {second:?}"
        );
        for report in [first, second] {
            assert_eq!((report.failed, report.left, report.account_gone), (0, 0, 0));
            assert!(report.applied + report.already_newer <= ids.len());
        }
        for id in ids {
            assert_eq!(
                stored_refresh(&stores, id).await?,
                Some(format!("{id}-refresh-1"))
            );
        }
        assert!(records(&stores).await?.is_empty());
        assert_eq!(token_requests(&server).len(), ids.len());
        Ok(())
    })
    .await
}

/// A reconciliation stopped between its steps leaves a state the next run finishes: stopped
/// before the write, MongoDB is untouched and the record stays; stopped after the write and
/// before the removal, MongoDB holds the answer and the record stays; the next run finds MongoDB
/// holding it and removes the record.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interrupted_reconciliation_is_finished_by_the_next_run() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &["u1"]).await?;

        let before_write = process(&stores, &server, fast_timings())?;
        kill_reconciliation_at(&before_write, FaultPoint::BeforePersist).await?;
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-0")
        );
        assert_eq!(records(&stores).await?.len(), 1);

        // The cache write comes after MongoDB's and before the record's removal.
        let after_write = process(&stores, &server, fast_timings())?;
        kill_reconciliation_at(&after_write, FaultPoint::BeforeCacheWrite).await?;
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-1")
        );
        assert_eq!(records(&stores).await?.len(), 1);

        let next = process(&stores, &server, fast_timings())?;
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            report,
            dima_twitch::RecoveryReport {
                already_newer: 1,
                ..Default::default()
            }
        );
        assert!(records(&stores).await?.is_empty());
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-1")
        );
        Ok(())
    })
    .await
}

/// The account of a record was deleted meanwhile: the record is removed and counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_whose_account_is_gone_is_removed() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &["u1"]).await?;
        stores
            .mongo
            .documents("users")
            .delete_one(bson::doc! { "accounts.id": "u1" })
            .await?;
        let next = process(&stores, &server, fast_timings())?;
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            report,
            dima_twitch::RecoveryReport {
                account_gone: 1,
                ..Default::default()
            }
        );
        assert!(records(&stores).await?.is_empty());
        Ok(())
    })
    .await
}

/// The streamer signed in again after the record was written (MongoDB holds R9, written at a
/// higher generation). The record's answer is older: a refresh that finds it, and the
/// reconciliation, remove it and leave MongoDB alone; the refresh then exchanges R9.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_older_than_mongodb_is_removed_and_mongodb_kept() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1", "u2"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &["u1", "u2"]).await?;
        let next = process(&stores, &server, fast_timings())?;
        for id in ["u1", "u2"] {
            // A sign-in: new tokens (the access token already near its expiry), then the
            // crate is told, which advances the generation.
            let refresh = format!("{id}-refresh-9");
            state
                .lock()
                .unwrap()
                .valid
                .insert(refresh.clone(), id.to_owned());
            stores
                .mongo
                .documents("users")
                .update_one(
                    bson::doc! { "accounts.id": id },
                    bson::doc! { "$set": {
                        "accounts.$.refresh_token": envelope(&refresh),
                        "accounts.$.access_token": envelope(&format!("{id}-access-9")),
                        "accounts.$.access_token_expires_at": NOW_SECS + 10,
                    } },
                )
                .await?;
            next.twitch.credentials_changed(id).await?;
        }
        let generation = |stores: &Stores, id: &'static str| {
            let stores = stores.mongo.clone();
            async move {
                let user = stores
                    .documents("users")
                    .find_one(bson::doc! { "accounts.id": id })
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("user"))?;
                anyhow::Ok(user.get_datetime("refreshed_at")?.timestamp_millis())
            }
        };
        let (parked_generation, _) = parked_answer(&stores, "u1").await?.unwrap();
        assert!(generation(&stores, "u1").await? > parked_generation);

        // The refresh path: the record is older, so it goes; R9 is the token exchanged (once
        // the stopped process's marker, left to expire, is gone).
        marker_gone(&stores, "u1").await?;
        let token = next.twitch.streamer_token("u1", None, "next").await?;
        assert_eq!(token.expose(), "u1-access-2");
        let requests = token_requests(&server);
        assert_eq!(
            form_value(requests.last().unwrap(), "refresh_token").as_deref(),
            Some("u1-refresh-9")
        );
        assert_eq!(parked_answer(&stores, "u1").await?, None);
        assert!(
            next.events
                .actions()
                .contains(&"token_refresh_recovery_discarded".to_owned())
        );

        // The reconciliation path.
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            report,
            dima_twitch::RecoveryReport {
                already_newer: 1,
                ..Default::default()
            }
        );
        assert_eq!(
            stored_refresh(&stores, "u2").await?.as_deref(),
            Some("u2-refresh-9")
        );
        assert!(records(&stores).await?.is_empty());
        Ok(())
    })
    .await
}

/// The start-up run never holds the process longer than `recovery_start_wait`, even when
/// MongoDB hangs; a later process finishes the work.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_start_up_reconciliation_holds_the_start_at_most_its_wait() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers(&stores, &server, &["u1"]).await?;
        let mut timings = fast_timings();
        timings.recovery_start_wait = Duration::from_millis(200);
        let slow = process(&stores, &server, timings)?;
        slow.twitch.set_fault_hook(|point, _| {
            async move {
                if point == FaultPoint::BeforePersist {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
            .boxed()
        });
        let started = tokio::time::Instant::now();
        assert_eq!(slow.twitch.start_recovery().await, None);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the start was held {:?}",
            started.elapsed()
        );
        slow.twitch.kill();

        let next = process(&stores, &server, fast_timings())?;
        assert_eq!(
            next.twitch
                .start_recovery()
                .await
                .map(|report| report.applied),
            Some(1)
        );
        Ok(())
    })
    .await
}
