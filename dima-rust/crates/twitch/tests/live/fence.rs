//! The credential generation (review finding 4): a cache write that started before a newer
//! credential was stored can never cover it, and a cached "no permissions" is checked against
//! MongoDB before a caller is refused.

use crate::support::*;
use anyhow::Result;
use bson::{Bson, doc};
use dima_twitch::{FaultPoint, RefreshFailureKind, TokenError};
use futures_util::FutureExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

const NOW_SECS: i64 = NOW_MS / 1000;

fn state(valid: &[&str], consume: bool) -> Shared {
    let mut state = TwitchState {
        consume,
        expires_in: 14_400,
        ..TwitchState::default()
    };
    for token in valid {
        state.valid.insert((*token).to_owned(), "u1".to_owned());
    }
    Arc::new(Mutex::new(state))
}

/// Parks the first time `process` reaches `point` for u1; `parked` fires then, and it goes on
/// once `release` fires.
fn park_once(process: &Process, point: FaultPoint) -> (Arc<Notify>, Arc<Notify>) {
    let parked = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let armed = Arc::new(AtomicBool::new(true));
    let (on_park, on_release) = (Arc::clone(&parked), Arc::clone(&release));
    process.twitch.set_fault_hook(move |at, id| {
        let fire = at == point && id == "u1" && armed.swap(false, Ordering::SeqCst);
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

/// A sign-in in another process: new tokens in MongoDB, then the crate is told.
async fn sign_in(stores: &Stores, process: &Process, access: &str, refresh: &str) -> Result<()> {
    stores
        .mongo
        .documents("users")
        .update_one(
            doc! { "accounts.id": "u1" },
            doc! { "$set": {
                "accounts.$.refresh_token": envelope(refresh),
                "accounts.$.access_token": envelope(access),
                "accounts.$.access_token_expires_at": Bson::Int32(i32::try_from(NOW_SECS + 14_400)?),
                "accounts.$.has_permissions": true,
                "accounts.$.up_to_date_permissions": true,
            } },
        )
        .await?;
    process.twitch.credentials_changed("u1").await?;
    Ok(())
}

/// Process B's refresh is refused for good and wipes MongoDB, then stalls before its cache
/// write; meanwhile the streamer signs in again through process A. B's late cache wipe is
/// refused by the generation: the streamer keeps the new tokens everywhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_delayed_cache_wipe_never_covers_a_newer_sign_in() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state(&[], true), helix_ok).await?;
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
        let (parked, release) = park_once(&b, FaultPoint::BeforeCacheWrite);
        let refused = {
            let twitch = b.twitch.clone();
            tokio::spawn(async move { twitch.streamer_token("u1", None, "b").await })
        };
        parked.notified().await;
        let wiped = stored_account(&stores, "u1").await?;
        assert!(!wiped.get_bool("has_permissions")?, "B wiped MongoDB first");
        sign_in(&stores, &a, "u1-access-9", "u1-refresh-9").await?;
        release.notify_one();
        let refused = refused.await?;
        assert!(
            matches!(
                refused,
                Err(TokenError::Refresh {
                    kind: RefreshFailureKind::Permanent,
                    ..
                })
            ),
            "{refused:?}"
        );
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["refresh_token"], "u1-refresh-9");
        assert_eq!(cache["access_token"], "u1-access-9");
        assert_eq!(cache["has_permissions"], "true");
        let token = a.twitch.streamer_credential("u1", None).await;
        assert_eq!(
            token.map(|t| t.expose().to_owned()),
            Ok("u1-access-9".to_owned())
        );
        let token = b.twitch.streamer_credential("u1", None).await;
        assert_eq!(
            token.map(|t| t.expose().to_owned()),
            Ok("u1-access-9".to_owned())
        );
        assert_eq!(
            decrypt_field(&stored_account(&stores, "u1").await?, "refresh_token").as_deref(),
            Some("u1-refresh-9")
        );
        Ok(())
    })
    .await
}

/// A hydration that read MongoDB before a rotation and writes after it keeps the rotation's
/// credentials (the reference's full-hash write would put the consumed token back).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_late_hydration_keeps_newer_credentials() -> Result<()> {
    with_stores(|stores| async move {
        let state = state(&["u1-refresh-0"], true);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let hydrator = process(&stores, &server, fast_timings())?;
        let refresher = process(&stores, &server, fast_timings())?;
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
        refresher.twitch.load_streamers().await?;
        // Billing's plan invalidation deletes the hash; the next read hydrates it.
        stores.dragonfly.del(&[&stores.keys.account("u1")]).await?;
        let (parked, release) = park_once(&hydrator, FaultPoint::BeforeDirectoryWrite);
        let late = {
            let twitch = hydrator.twitch.clone();
            tokio::spawn(async move { twitch.streamer("u1").await })
        };
        parked.notified().await;
        let token = refresher
            .twitch
            .streamer_token("u1", None, "refresher")
            .await?;
        assert_eq!(token.expose(), "u1-access-1");
        release.notify_one();
        let account = late.await?.expect("hydrated");
        assert_eq!(account.name(), "u1");
        assert_eq!(
            account
                .refresh_token()
                .map(|t| t.expose().to_owned())
                .as_deref(),
            Some("u1-refresh-1"),
            "the late hydration answers with what the hash holds"
        );
        let cache = cache_fields(&stores, "u1").await?;
        assert_eq!(cache["refresh_token"], "u1-refresh-1");
        assert_eq!(cache["access_token"], "u1-access-1");
        assert_eq!(cache["has_permissions"], "true");
        assert_eq!(cache["name"], "u1", "the other fields were written");
        Ok(())
    })
    .await
}

/// A cached `has_permissions=false` that MongoDB does not confirm is repaired, not obeyed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cached_no_permissions_is_checked_against_mongodb() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(state(&["u1-refresh-0"], true), helix_ok).await?;
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
        set_cache(&stores, "u1", &[("has_permissions", "false")]).await?;
        let token = process.twitch.streamer_credential("u1", None).await;
        assert_eq!(
            token.map(|t| t.expose().to_owned()),
            Ok("u1-access-0".to_owned())
        );
        assert_eq!(
            cache_fields(&stores, "u1").await?["has_permissions"],
            "true"
        );
        // MongoDB agrees there are none: refused.
        stores
            .mongo
            .documents("users")
            .update_one(
                doc! { "accounts.id": "u1" },
                doc! { "$set": { "accounts.$.has_permissions": false } },
            )
            .await?;
        set_cache(&stores, "u1", &[("has_permissions", "false")]).await?;
        let refused = process.twitch.streamer_credential("u1", None).await;
        assert_eq!(
            refused,
            Err(dima_twitch::CredentialError::StreamerNoPermissions)
        );
        assert!(token_requests(&server).is_empty());
        Ok(())
    })
    .await
}
