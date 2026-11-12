//! The streamer directory against the stores: start-up load, hydration of a missing or fenced
//! entry, the cached list, the id set.

use crate::support::*;
use anyhow::Result;
use bson::{Bson, doc};
use std::sync::{Arc, Mutex};

fn quiet_mock_state() -> Shared {
    Arc::new(Mutex::new(TwitchState::default()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_start_up_load_writes_every_streamer_like_the_reference() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(quiet_mock_state(), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        let mut pro = user_document("200", "cañón_👋", "a-200", "r-200", None);
        pro.insert("plan_tier", "pro");
        pro.insert(
            "plan_tier_until",
            bson::DateTime::from_millis(1_794_441_599_000),
        );
        pro.insert(
            "polar_plan_event_at",
            bson::DateTime::from_millis(1_700_000_000_000),
        );
        pro.insert("polar_plan_event_key", "evt_1");
        insert_user(
            &stores,
            user_document("100", "first", "a-100", "r-100", Some(1_800_000_000)),
        )
        .await?;
        insert_user(&stores, pro).await?;
        // A user without a Twitch account is not part of the directory.
        let mut youtube = user_document("yt", "yt", "a", "r", None);
        if let Ok(accounts) = youtube.get_array_mut("accounts")
            && let Some(Bson::Document(account)) = accounts.get_mut(0)
        {
            account.insert("type", "youtube");
        }
        insert_user(&stores, youtube).await?;

        let loaded = process.twitch.load_streamers().await?;
        assert_eq!(loaded, ["100", "200"]);
        let first = stores
            .dragonfly
            .hgetall(&stores.keys.account("100"))
            .await?;
        let names: Vec<&str> = first.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "id",
                "name",
                "email",
                "plan_tier",
                "plan_tier_until",
                "polar_sh_customer_id",
                "refresh_token",
                "access_token",
                "expires_at",
                "actived",
                "chat_enabled",
                "has_permissions",
                "up_to_date_permissions",
                "__polar_plan_version",
                // Rust only: the credential generation (the user's `refreshed_at`).
                "__credential_generation"
            ]
        );
        let pro = cache_fields(&stores, "200").await?;
        assert_eq!(pro["name"], "cañón_👋");
        assert_eq!(pro["plan_tier"], "pro");
        assert_eq!(pro["plan_tier_until"], "Wed Nov 11 2026");
        assert_eq!(pro["refresh_token"], "r-200");
        assert_no_plain_tokens(&stores, &["a-100", "r-100", "a-200", "r-200"]).await?;
        assert_eq!(pro["__polar_plan_version"], "1700000000000:evt_1");
        assert!(
            !pro.contains_key("expires_at"),
            "no expiry anywhere: the field is left out"
        );
        let mut ids = process.twitch.streamer_ids().await;
        ids.sort();
        assert_eq!(ids, ["100", "200"]);
        assert_eq!(
            process.events.seen(),
            [
                ("100".to_owned(), "first".to_owned()),
                ("200".to_owned(), "cañón_👋".to_owned())
            ]
        );
        // A second load announces nobody again (same names).
        process.twitch.load_streamers().await?;
        assert_eq!(process.events.seen().len(), 2);
        assert_no_secrets(
            &process.events,
            &["a-100", "r-100", "a-200", "r-200", "first@example.invalid"],
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_or_fenced_entry_is_hydrated_from_mongodb() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(quiet_mock_state(), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        let mut user = user_document("300", "chan", "a-300", "r-300", Some(1_800_000_000));
        user.insert("polar_plan_event_at", bson::DateTime::from_millis(1_700_000_000_000));
        user.insert("polar_plan_event_key", "evt_2");
        insert_user(&stores, user).await?;

        // Missing: hydrated, added to the id set.
        let account = process.twitch.streamer("300").await.expect("hydrated");
        assert_eq!(account.name(), "chan");
        assert!(account.has_permissions());
        assert_eq!(account.access_token().map(|t| t.expose().to_owned()).as_deref(), Some("a-300"));
        assert_eq!(process.twitch.streamer_ids().await, ["300"]);

        // Billing raised the fence after a plan change, and MongoDB has the new plan: re-hydrated.
        stores
            .mongo
            .documents("users")
            .update_one(doc! {}, doc! { "$set": { "plan_tier": "premium", "polar_plan_event_at": bson::DateTime::from_millis(1_700_000_001_000) } })
            .await?;
        stores.dragonfly.set(&stores.keys.plan_fence("300"), b"1700000001000:evt_2", Default::default()).await?;
        let account = process.twitch.streamer("300").await.expect("re-hydrated");
        assert_eq!(account.plan_tier(), Some("premium"));

        // A fence newer than anything MongoDB holds: refused twice, no entry (as the reference).
        stores.dragonfly.set(&stores.keys.plan_fence("300"), b"9999999999999:x", Default::default()).await?;
        assert!(process.twitch.streamer("300").await.is_none());

        // Unknown streamer.
        assert!(process.twitch.streamer("404").await.is_none());
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_cached_list_is_published_then_read_back() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(quiet_mock_state(), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        for id in ["1", "2", "3"] {
            insert_user(
                &stores,
                user_document(id, &format!("c{id}"), "a", "r", None),
            )
            .await?;
        }
        process.twitch.load_streamers().await?;
        assert!(
            stores
                .dragonfly
                .get(&stores.keys.aggregate())
                .await?
                .is_none(),
            "the load clears the aggregate"
        );
        let mut first: Vec<String> = process
            .twitch
            .cached_streamers()
            .await
            .iter()
            .map(|a| a.id().to_owned())
            .collect();
        first.sort();
        assert_eq!(first, ["1", "2", "3"]);
        let ttl = stores.dragonfly.ttl(&stores.keys.aggregate()).await?;
        assert!(
            matches!(ttl, dima_store::dragonfly::Ttl::Seconds(s) if s > 3500),
            "{ttl:?}"
        );
        // Read back from the aggregate (a corrupt one is an error, logged, empty list).
        let again = process.twitch.cached_streamers().await;
        assert_eq!(again.len(), 3);
        assert!(
            again
                .iter()
                .all(|account| account.field("__polar_plan_version").is_none())
        );
        stores
            .dragonfly
            .set(&stores.keys.aggregate(), b"{broken", Default::default())
            .await?;
        assert!(process.twitch.cached_streamers().await.is_empty());
        Ok(())
    })
    .await
}

/// Review finding 9: a malformed envelope (the reference's `decrypt` throws and stops the whole
/// load) and a document Rust cannot decode skip that streamer only, reported by id; the load
/// goes on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bad_stored_user_is_skipped_and_the_load_goes_on() -> Result<()> {
    with_stores(|stores| async move {
        let server = twitch_mock(quiet_mock_state(), helix_ok).await?;
        let process = process(&stores, &server, fast_timings())?;
        insert_user(&stores, user_document("1", "ok", "a", "r", None)).await?;
        let mut broken = user_document("2", "broken", "a-2", "r-2", None);
        if let Ok(accounts) = broken.get_array_mut("accounts")
            && let Some(Bson::Document(account)) = accounts.get_mut(0)
        {
            account.insert("refresh_token", doc! { "iv": "00", "content": "abcd" });
        }
        insert_user(&stores, broken).await?;
        let mut undecodable = user_document("4", "odd", "a-4", "r-4", None);
        if let Ok(accounts) = undecodable.get_array_mut("accounts")
            && let Some(Bson::Document(account)) = accounts.get_mut(0)
        {
            account.insert("actived", "yes");
        }
        insert_user(&stores, undecodable).await?;
        insert_user(&stores, user_document("3", "after", "a", "r", None)).await?;
        let loaded = process.twitch.load_streamers().await?;
        assert_eq!(loaded, ["1", "3"]);
        let mut ids = process.twitch.streamer_ids().await;
        ids.sort();
        assert_eq!(ids, ["1", "3"], "the users after the bad ones are loaded");
        let skipped: Vec<_> = process
            .events
            .entries()
            .into_iter()
            .filter(|entry| entry.action() == Some("streamer_skipped"))
            .collect();
        assert_eq!(skipped.len(), 2);
        assert_eq!(skipped[0].data["id"], "2");
        assert_eq!(skipped[0].data["reason"], "undecryptable_envelope");
        assert_eq!(skipped[1].data["id"], "4");
        assert_eq!(skipped[1].data["reason"], "undecodable_document");
        assert_no_secrets(
            &process.events,
            &[
                "a-2",
                "r-2",
                "a-4",
                "r-4",
                "broken@example.invalid",
                "odd@example.invalid",
            ],
        );
        Ok(())
    })
    .await
}
