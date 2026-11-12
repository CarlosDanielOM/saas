//! `dima-cron recovery ...` against the local stores, as the rollback procedure runs it with the
//! services stopped. Two real recovery records are left the way production leaves them: a
//! process (here, a Twitch handle in the test) refreshes two streamers' tokens while MongoDB
//! refuses its writes, and parks the answers at shutdown. Twitch is the loopback mock; the
//! binary itself never calls it. Its own database and key prefix (Dragonfly database 11) are
//! removed afterwards, and so are the debug-log entries the commands write.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::crypto::{CredentialCipher, StoredCredential};
use dima_core::runtime::Shutdown;
use dima_core::{Clock, SecretString, SystemClock, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use dima_twitch::{
    FaultAction, FaultPoint, KeySpace, NoopEvents, Timings, Twitch, TwitchConfig, TwitchDeps,
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use support::{Cron, Stores, TEST_SECRET_KEY, clean_log_entries, now_ms};

const CLIENT_ID: &str = "test-client-id";
const CLIENT_SECRET: &str = "test-client-secret";
/// Streamers in the range this test owns.
const FIRST: &str = "910000001";
const SECOND: &str = "910000002";

fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_SECRET_KEY).unwrap()
}

fn envelope(text: &str) -> Bson {
    let stored = cipher().encrypt(text, &SystemRandom).unwrap();
    Bson::Document(doc! { "iv": stored.iv, "content": stored.content })
}

/// A user as sign-up stores it, with one Twitch account whose access token has expired.
fn user(id: &str) -> Document {
    let expired = SystemClock.now_secs() - 10;
    doc! {
        "_id": ObjectId::new(),
        "name": id,
        "email": format!("{id}@example.invalid"),
        "accounts": [{
            "_id": ObjectId::new(),
            "type": "twitch",
            "id": id,
            "name": id,
            "email": format!("{id}@example.invalid"),
            "refresh_token": envelope(&format!("{id}-refresh-0")),
            "access_token": envelope(&format!("{id}-access-0")),
            "access_token_expires_at": expired,
            "actived": true,
            "chat_enabled": true,
            "has_permissions": true,
            "up_to_date_permissions": true,
        }],
        "plan_tier": "free",
        "plan_tier_until": Bson::Null,
        "polar_sh_customer_id": Bson::Null,
        "token_balance": 0,
        "created_at": bson::DateTime::now(),
        "updated_at": bson::DateTime::now(),
        "__v": 0,
    }
}

/// Twitch's token endpoint: `{id}-refresh-0` rotates to `{id}-access-1` / `{id}-refresh-1`.
async fn twitch_mock() -> Result<MockServer> {
    let server = MockServer::start().await?;
    server.fallback(|request| {
        let body = request.body_text();
        let refresh = body
            .split('&')
            .find_map(|pair| pair.strip_prefix("refresh_token="))
            .unwrap_or_default()
            .to_owned();
        match refresh.strip_suffix("-refresh-0") {
            Some(id) if request.path() == "/oauth2/token" => MockResponse::json(
                200,
                &json!({
                    "access_token": format!("{id}-access-1"),
                    "refresh_token": format!("{id}-refresh-1"),
                    "expires_in": 14_400,
                    "scope": ["chat:read"],
                    "token_type": "bearer",
                })
                .to_string(),
            ),
            _ => MockResponse::json(400, r#"{"status":400,"message":"Invalid refresh token"}"#),
        }
    });
    Ok(server)
}

/// Refreshes both streamers in a "process" whose MongoDB refuses every write, then stops it:
/// both answers are left as recovery records.
async fn park_answers(stores: &Stores) -> Result<()> {
    let server = twitch_mock().await?;
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = KeySpace::prefixed(stores.prefix.clone());
    config.timings = Timings {
        oauth_timeout: Duration::from_millis(1500),
        exchange_drain: Duration::from_millis(500),
        persist_retry: Duration::from_millis(20),
        persist_retry_max: Duration::from_millis(100),
        ..Timings::reference()
    };
    let shutdown = Shutdown::new();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let twitch = Twitch::new(
        config,
        TwitchDeps {
            http: HttpClient::builder()
                .shutdown(shutdown.clone())
                .clock(Arc::clone(&clock))
                .build()?,
            exchange_http: dima_twitch::exchange_client(
                HttpClient::builder().clock(Arc::clone(&clock)),
            )?,
            helix: server.provider(dima_twitch::helix_provider(CLIENT_ID))?,
            oauth: server.provider(dima_twitch::oauth_provider())?,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock,
            random: Arc::new(SystemRandom),
            events: Arc::new(NoopEvents),
            shutdown: shutdown.clone(),
        },
    );
    twitch.load_streamers().await?;
    twitch.set_fault_hook(|point, _| {
        async move {
            if point == FaultPoint::BeforePersist {
                FaultAction::Fail
            } else {
                FaultAction::Continue
            }
        }
        .boxed()
    });
    for id in [FIRST, SECOND] {
        let token = twitch.streamer_token(id, None, "test").await?;
        assert_eq!(token.expose(), format!("{id}-access-1"));
    }
    shutdown.trigger();
    assert!(!twitch.shutdown().await, "the answers could not be written");
    for id in [FIRST, SECOND] {
        let key = format!("{}twitch:{id}:refresh:parked", stores.prefix);
        assert!(
            stores.dragonfly.exists(&[&key]).await? == 1,
            "no record for {id}"
        );
    }
    Ok(())
}

/// Runs `dima-cron recovery <args>`; returns its status and its standard output, parsed.
fn recovery(stores: &Stores, args: &[&str]) -> Result<(i32, Vec<Value>)> {
    let mut command = vec!["recovery"];
    command.extend_from_slice(args);
    let mut cron = Cron::start(&stores.cron_env(""), &command)?;
    let status = cron.wait_exit(Duration::from_secs(60))?;
    let lines: Vec<String> = cron.lines.lock().unwrap().clone();
    for line in &lines {
        for secret in ["-access-", "-refresh-", "iv", "content", TEST_SECRET_KEY] {
            assert!(!line.contains(secret), "printed {secret:?}: {line}");
        }
    }
    let parsed = lines
        .iter()
        .map(|line| serde_json::from_str(line).context("a JSON line"))
        .collect::<Result<_>>()?;
    Ok((status, parsed))
}

fn records(lines: &[Value]) -> Vec<&Value> {
    lines.iter().filter_map(|line| line.get("record")).collect()
}

async fn stored_refresh(stores: &Stores, id: &str) -> Result<String> {
    let user = stores
        .mongo
        .documents("users")
        .find_one(doc! { "accounts.id": id })
        .await?
        .context("user")?;
    let account = user
        .get_array("accounts")?
        .iter()
        .filter_map(Bson::as_document)
        .find(|account| account.get_str("id").is_ok_and(|found| found == id))
        .context("account")?;
    let refresh = account.get_document("refresh_token")?;
    let stored = StoredCredential {
        iv: refresh.get_str("iv")?.to_owned(),
        content: refresh.get_str("content")?.to_owned(),
    };
    Ok(cipher().decrypt(&stored)?.unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_settle_and_reconcile_the_records_left_by_a_stopped_process() -> Result<()> {
    let Some(stores) = Stores::new().await? else {
        return Ok(());
    };
    let since = now_ms();
    let operation = support::unique();
    let result = async {
        for id in [FIRST, SECOND] {
            stores.mongo.documents("users").insert_one(user(id)).await?;
        }
        park_answers(&stores).await?;

        // Both records are listed, waiting for the reconciliation, with their generations.
        let (status, lines) = recovery(&stores, &["list"])?;
        assert_eq!(status, 0);
        let listed = records(&lines);
        assert_eq!(listed.len(), 2, "{lines:#?}");
        for (record, id) in listed.iter().zip([FIRST, SECOND]) {
            assert_eq!(record["streamerId"], id);
            assert_eq!(record["key"], "parked");
            assert_eq!(record["state"], "pending");
            assert!(record["generation"].is_i64());
            assert!(record["storedGeneration"].is_i64());
        }
        assert_eq!(lines.last().unwrap()["records"], 2);

        // The operator discards the second one.
        let (status, lines) = recovery(
            &stores,
            &[
                "settle",
                SECOND,
                "parked",
                "discard",
                &operation,
                "cron-test",
            ],
        )?;
        assert_eq!(status, 0);
        assert_eq!(lines[0]["settled"]["outcome"], "discarded");
        assert_eq!(lines[0]["settled"]["operationId"], operation.as_str());

        // The reconciliation writes the first one to MongoDB; nothing is left.
        let (status, lines) = recovery(&stores, &["reconcile"])?;
        assert_eq!(status, 0, "{lines:#?}");
        let reconciled = &lines[0]["reconciled"];
        assert_eq!(reconciled["applied"], 1);
        assert_eq!(reconciled["failed"], 0);
        assert_eq!(reconciled["left"], 0);
        assert_eq!(reconciled["unmatched"], 0);
        assert!(records(&lines).is_empty());
        assert_eq!(
            stored_refresh(&stores, FIRST).await?,
            format!("{FIRST}-refresh-1")
        );
        assert_eq!(
            stored_refresh(&stores, SECOND).await?,
            format!("{SECOND}-refresh-0")
        );

        // Settling a record that is gone answers status 2.
        let (status, lines) = recovery(
            &stores,
            &["settle", FIRST, "parked", "apply", &operation, "cron-test"],
        )?;
        assert_eq!(status, 2);
        assert_eq!(lines[0]["settled"]["outcome"], "not_found");
        Ok(())
    }
    .await;
    clean_log_entries(
        &stores.dragonfly,
        since,
        &["reconcileRecovery", "settleRecoveryRecord"],
    )
    .await?;
    stores.clean().await?;
    result
}
