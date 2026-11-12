//! The local production copy (`domdimabot`), read only: every stored token envelope has a shape
//! the reader accepts, and the directory loads every streamer from it without error. The copy's
//! tokens cannot be decrypted here (the production key is not on this machine): the load runs
//! with the test key, so what it writes to Dragonfly (database 15, a unique prefix, deleted
//! afterwards) is not a credential. Only counts are printed.

#[path = "support/mod.rs"]
mod support;

use anyhow::{Context, Result, bail};
use bson::RawDocumentBuf;
use dima_core::ManualClock;
use dima_http::testing::MockServer;
use dima_model::users::{AccountType, EncryptedToken, User};
use futures_util::{FutureExt, TryStreamExt};
use std::panic::AssertUnwindSafe;
use support::*;

const REAL_DATABASE: &str = "domdimabot";

#[derive(Default, Debug)]
struct Shapes {
    encrypted: usize,
    empty: usize,
    malformed: usize,
}

fn is_hex(text: &str) -> bool {
    text.len() % 2 == 0 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What `crypto.ts` accepts: no envelope, an empty one (`''` or `null` parts: `decrypt` gives
/// `null`), or a 16-byte hex IV with hex content.
fn classify(envelope: &EncryptedToken, shapes: &mut Shapes) {
    match (envelope.iv.as_deref(), envelope.content.as_deref()) {
        (None | Some(""), _) | (_, None | Some("")) => shapes.empty += 1,
        (Some(iv), Some(content)) if iv.len() == 32 && is_hex(iv) && is_hex(content) => {
            shapes.encrypted += 1;
        }
        _ => shapes.malformed += 1,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_stored_envelope_is_readable_and_every_streamer_loads() -> Result<()> {
    let Some(mongo) = connect_mongo(REAL_DATABASE).await? else {
        return Ok(());
    };
    let names = mongo.client().list_database_names().await?;
    if !names.iter().any(|name| name == REAL_DATABASE) {
        if stores_required() {
            bail!("the local {REAL_DATABASE} copy is not present");
        }
        eprintln!("skipped: no {REAL_DATABASE} copy");
        return Ok(());
    }
    let Some(dragonfly) = connect_dragonfly(REAL_DATA_DATABASE).await? else {
        return Ok(());
    };

    // 1. Shapes, straight from the documents.
    let mut cursor = mongo
        .collection::<RawDocumentBuf>("users")
        .find(bson::doc! {})
        .await?;
    let (mut users, mut twitch_users, mut accounts) = (0_usize, 0_usize, 0_usize);
    let (mut refresh, mut access) = (Shapes::default(), Shapes::default());
    while let Some(raw) = cursor.try_next().await? {
        users += 1;
        let user: User = dima_model::decode(&raw).context("every user decodes")?;
        if user.twitch().is_some() {
            twitch_users += 1;
        }
        for account in &user.accounts {
            accounts += 1;
            classify(account.refresh_token.expose(), &mut refresh);
            classify(account.access_token.expose(), &mut access);
            if account.kind.is(AccountType::Twitch) {
                assert!(account.id.as_deref().is_some_and(|id| !id.is_empty()));
            }
        }
    }
    eprintln!(
        "users {users}, with a Twitch account {twitch_users}, accounts {accounts}; refresh tokens {refresh:?}; access tokens {access:?}"
    );
    assert!(users > 0, "the copy has users");
    assert_eq!(refresh.malformed, 0, "malformed refresh envelopes");
    assert_eq!(access.malformed, 0, "malformed access envelopes");

    // 2. The start-up load over the whole copy (reads MongoDB only).
    let prefix = format!("dtwreal{}:", std::process::id());
    let stores = Stores {
        mongo: mongo.clone(),
        dragonfly: dragonfly.clone(),
        keys: dima_twitch::KeySpace::prefixed(prefix.clone()),
        database: REAL_DATABASE.to_owned(),
    };
    let outcome = AssertUnwindSafe(async {
        let server = MockServer::start().await?;
        let process = process_at(&stores, &server, fast_timings(), ManualClock::new(NOW_MS))?;
        let loaded = process.twitch.load_streamers().await?;
        eprintln!(
            "directory loaded {} of {twitch_users} streamers",
            loaded.len()
        );
        assert_eq!(loaded.len(), twitch_users, "every streamer loads");
        assert_eq!(process.twitch.streamer_ids().await.len(), twitch_users);
        let listed = process.twitch.cached_streamers().await;
        assert_eq!(listed.len(), twitch_users);
        assert!(server.requests().is_empty(), "no call to Twitch");
        anyhow::Ok(())
    })
    .catch_unwind()
    .await;
    let cleaned = clean_prefix(&dragonfly, &prefix).await;
    match outcome {
        Ok(result) => {
            cleaned?;
            result
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
