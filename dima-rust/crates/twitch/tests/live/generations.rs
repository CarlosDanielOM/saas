//! The generation decides how a recovery record compares with MongoDB (review 2026-11-12,
//! second re-check: G1, G2, G3).

use crate::recovery::{NOW_SECS, park_answers_at, records, state_for, stored_refresh};
use crate::support::*;
use anyhow::{Context, Result};
use bson::doc;
use dima_twitch::{AccessToken, RecoveryReport, RefreshToken, SignIn};
use std::sync::Arc;

/// The generation every test user starts from (one minute before the test clock).
const G0: i64 = NOW_MS - 60_000;

/// MongoDB's generation (`refreshed_at`, milliseconds) of `id`.
pub(crate) async fn stored_generation(stores: &Stores, id: &str) -> Result<i64> {
    let user = stores
        .mongo
        .documents("users")
        .find_one(doc! { "accounts.id": id })
        .await?
        .context("user present")?;
    Ok(user.get_datetime("refreshed_at")?.timestamp_millis())
}

/// Puts `refresh` (with an expired access token) in MongoDB at `generation`, the way a restore
/// from a backup or a writer that does not advance the generation leaves it.
pub(crate) async fn put_stored(
    stores: &Stores,
    id: &str,
    refresh: &str,
    generation: i64,
) -> Result<()> {
    stores
        .mongo
        .documents("users")
        .update_one(
            doc! { "accounts.id": id },
            doc! { "$set": {
                "refreshed_at": bson::DateTime::from_millis(generation),
                "accounts.$.refresh_token": envelope(refresh),
                "accounts.$.access_token": envelope(&format!("{id}-access-x")),
                "accounts.$.access_token_expires_at": NOW_SECS - 10,
            } },
        )
        .await?;
    Ok(())
}

/// Review G1, the reproduced sequence: R0 is exchanged for R1, R1 is parked while MongoDB is
/// down, then MongoDB is restored to an older state holding X at a lower generation. The record
/// is the newer state: the reconciliation writes R1 over X and the generation moves past the
/// record's. (Before: X was taken for a newer token, the record was deleted, R1 was lost.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mongodb_restored_to_an_older_state_gets_the_parked_answer() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1", "u2"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers_at(&stores, &server, &["u1", "u2"], Some(G0)).await?;
        for id in ["u1", "u2"] {
            put_stored(&stores, id, &format!("{id}-refresh-x"), G0 - 30_000).await?;
        }
        let next = process(&stores, &server, fast_timings())?;

        // The reconciliation path.
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            (report.applied, report.already_newer, report.failed),
            (2, 0, 0),
            "{report:?}"
        );
        for id in ["u1", "u2"] {
            assert_eq!(
                stored_refresh(&stores, id).await?,
                Some(format!("{id}-refresh-1"))
            );
            assert!(stored_generation(&stores, id).await? > G0);
        }
        assert!(records(&stores).await?.is_empty());
        assert_eq!(token_requests(&server).len(), 2, "nothing exchanged again");
        Ok(())
    })
    .await
}

/// Review G1, the refresh path: the same restore, then a refresh of the streamer. The record's
/// answer is written over the restored state and its access token, still valid, is returned
/// without asking Twitch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refresh_after_a_restore_to_an_older_state_uses_the_parked_answer() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers_at(&stores, &server, &["u1"], Some(G0)).await?;
        put_stored(&stores, "u1", "u1-refresh-x", G0 - 30_000).await?;
        let next = process(&stores, &server, fast_timings())?;
        marker_gone(&stores, "u1").await?;
        let token = next.twitch.streamer_token("u1", None, "next").await?;
        assert_eq!(token.expose(), "u1-access-1");
        assert_eq!(token_requests(&server).len(), 1, "nothing exchanged again");
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-1")
        );
        assert!(records(&stores).await?.is_empty());
        Ok(())
    })
    .await
}

/// Review G1, equal generation: MongoDB holds X at the record's own generation (a writer that
/// did not advance it). Nothing proves which is newer: the record stays, MongoDB stays, and the
/// report counts it as unmatched. A refresh uses X; Twitch refuses X, so the record's answer is
/// tried before anything is wiped, and it works. (Before: the record was deleted and the
/// refusal of X wiped the streamer.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_token_at_the_same_generation_is_unmatched_and_rescues_a_refusal() -> Result<()>
{
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers_at(&stores, &server, &["u1"], Some(G0)).await?;
        put_stored(&stores, "u1", "u1-refresh-x", G0).await?;
        let next = process(&stores, &server, fast_timings())?;

        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            report,
            RecoveryReport {
                unmatched: 1,
                ..Default::default()
            }
        );
        assert_eq!(records(&stores).await?.len(), 1, "the record stays");
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-x"),
            "MongoDB is not overwritten"
        );
        assert_eq!(stored_generation(&stores, "u1").await?, G0);
        // Reconciling again changes nothing (it does not loop on the record).
        let again = next.twitch.reconcile_recovery().await?;
        assert_eq!(
            (again.applied, again.left, again.unmatched),
            (0, 0, 1),
            "{again:?}"
        );
        assert_eq!(records(&stores).await?.len(), 1);

        marker_gone(&stores, "u1").await?;
        let token = next.twitch.streamer_token("u1", None, "next").await?;
        assert_eq!(token.expose(), "u1-access-2");
        let requests = token_requests(&server);
        let sent: Vec<_> = requests
            .iter()
            .map(|request| form_value(request, "refresh_token"))
            .collect();
        assert_eq!(
            sent[1..],
            [
                Some("u1-refresh-x".to_owned()),
                Some("u1-refresh-1".to_owned())
            ],
            "MongoDB's token first, then the record's answer, once"
        );
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-2")
        );
        assert!(
            !next
                .events
                .actions()
                .contains(&"tokens_invalidated".to_owned())
        );
        // The generation moved past the record's: the next run removes it.
        let after = next.twitch.reconcile_recovery().await?;
        assert_eq!(after.already_newer, 1, "{after:?}");
        assert!(records(&stores).await?.is_empty());
        assert_no_secrets(&next.events, &["u1-refresh-1", "u1-refresh-x"]);
        Ok(())
    })
    .await
}

/// Equal generation, and X works: the refresh uses X and leaves the record alone; once X's
/// rotation is stored (a higher generation) the reconciliation removes the record.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unmatched_record_is_left_alone_while_mongodb_s_token_works() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers_at(&stores, &server, &["u1"], Some(G0)).await?;
        put_stored(&stores, "u1", "u1-refresh-x", G0).await?;
        state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .valid
            .insert("u1-refresh-x".to_owned(), "u1".to_owned());
        let next = process(&stores, &server, fast_timings())?;
        marker_gone(&stores, "u1").await?;
        let token = next.twitch.streamer_token("u1", None, "next").await?;
        assert_eq!(token.expose(), "u1-access-2");
        let requests = token_requests(&server);
        assert_eq!(requests.len(), 2);
        assert_eq!(
            form_value(&requests[1], "refresh_token").as_deref(),
            Some("u1-refresh-x")
        );
        assert_eq!(
            records(&stores).await?.len(),
            1,
            "left alone by the refresh"
        );
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(report.already_newer, 1, "{report:?}");
        assert!(records(&stores).await?.is_empty());
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-2")
        );
        Ok(())
    })
    .await
}

/// A sign-in as the login route stores it.
pub(crate) fn sign_in(access: &str, refresh: &str, expires_in: f64) -> SignIn {
    SignIn {
        access_token: AccessToken::new(access),
        refresh_token: RefreshToken::new(refresh),
        expires_in: Some(expires_in),
        grant_permissions: true,
    }
}

/// Every credential write of the crate advances the generation: a persisted rotation,
/// `credentials_changed`, a sign-in, a wipe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_credential_writer_advances_the_generation() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        let mut user = user_document(
            "u1",
            "u1",
            "u1-access-0",
            "u1-refresh-0",
            Some(NOW_SECS - 10),
        );
        user.insert("refreshed_at", bson::DateTime::from_millis(G0));
        insert_user(&stores, user).await?;
        let p = process(&stores, &server, fast_timings())?;
        p.twitch.load_streamers().await?;
        let mut seen = vec![stored_generation(&stores, "u1").await?];

        p.twitch.streamer_token("u1", None, "rotation").await?;
        seen.push(stored_generation(&stores, "u1").await?);
        p.twitch.credentials_changed("u1").await?;
        seen.push(stored_generation(&stores, "u1").await?);
        // The sign-in's access token is close to its expiry, and Twitch does not know its
        // refresh token: the next refresh is refused and wipes.
        let stored = p
            .twitch
            .store_sign_in("u1", &sign_in("u1-access-s", "u1-refresh-s", 10.0))
            .await?
            .context("the account exists")?;
        seen.push(stored_generation(&stores, "u1").await?);
        assert_eq!(stored.generation, seen[3]);
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-s")
        );
        let cached = cache_fields(&stores, "u1").await?;
        assert_eq!(cached["refresh_token"], "u1-refresh-s");
        assert_eq!(cached["access_token"], "u1-access-s");
        assert_eq!(cached["expires_at"], (NOW_SECS + 10).to_string());
        assert_eq!(cached["__credential_generation"], seen[3].to_string());
        assert!(p.twitch.streamer_token("u1", None, "wipe").await.is_err());
        assert!(
            p.events
                .actions()
                .contains(&"tokens_invalidated".to_owned())
        );
        seen.push(stored_generation(&stores, "u1").await?);
        assert!(
            seen.windows(2).all(|pair| pair[0] < pair[1]),
            "the generation only grows: {seen:?}"
        );
        assert_eq!(
            p.twitch
                .store_sign_in("nobody", &sign_in("a", "b", 10.0))
                .await?,
            None
        );
        assert_no_plain_tokens(&stores, &["u1-access-s", "u1-refresh-s"]).await?;
        assert_no_secrets(&p.events, &["u1-access-s", "u1-refresh-s"]);
        Ok(())
    })
    .await
}

/// A sign-in after an answer was parked: its write advances the generation past the record's,
/// so the record is older and the reconciliation removes it, keeping the sign-in's tokens.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_is_newer_than_a_parked_answer() -> Result<()> {
    with_stores(|stores| async move {
        let state = state_for(&["u1"]);
        let server = twitch_mock(Arc::clone(&state), helix_ok).await?;
        park_answers_at(&stores, &server, &["u1"], Some(G0)).await?;
        let next = process(&stores, &server, fast_timings())?;
        next.twitch
            .store_sign_in("u1", &sign_in("u1-access-s", "u1-refresh-s", 14_400.0))
            .await?;
        let report = next.twitch.reconcile_recovery().await?;
        assert_eq!(report.already_newer, 1, "{report:?}");
        assert!(records(&stores).await?.is_empty());
        assert_eq!(
            stored_refresh(&stores, "u1").await?.as_deref(),
            Some("u1-refresh-s")
        );
        Ok(())
    })
    .await
}
