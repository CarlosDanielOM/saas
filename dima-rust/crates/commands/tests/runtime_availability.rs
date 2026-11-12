//! The reward toggle when Twitch does not answer cleanly: an unknown outcome is reported as
//! unknown, the state stays pending, nothing is sent twice for one change, and the recovery
//! brings Twitch and the stored state together; two processes changing one reward at once end
//! with Twitch holding what is stored.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use bson::{Document, doc};
use dima_commands::runtime::availability::{
    Availability, AvailabilityConfig, AvailabilityError, Target, TwitchRewardToggle,
};
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use runtime_support::*;
use serde_json::{Value, json};

const CHANNEL_A: &str = "990000001";
const HYDRATE: &str = "64a000000000000000001001";

fn now() -> i64 {
    reference()["now"].as_i64().unwrap()
}

fn service(
    env: &Env,
    server: &MockServer,
    timeout: Duration,
) -> Result<Availability<TwitchRewardToggle>> {
    let (twitch, _shutdown) = twitch(env, server)?;
    Ok(Availability::new(
        env.stores.clone(),
        env.cache(),
        Arc::new(TwitchRewardToggle::new(twitch).with_timeout(timeout)),
        env.clock(),
        Arc::new(dima_core::SystemRandom),
        AvailabilityConfig::default(),
    ))
}

async fn reward(env: &Env) -> Result<Document> {
    Ok(env
        .stores
        .mongo
        .documents("redemptionrewards")
        .find_one(doc! { "_id": oid(HYDRATE) })
        .await?
        .unwrap())
}

fn toggles(server: &MockServer) -> Vec<RecordedRequest> {
    server
        .requests()
        .into_iter()
        .filter(|request| request.path().ends_with("/channel_points/custom_rewards"))
        .collect()
}

#[tokio::test]
async fn an_unanswered_toggle_is_unknown_pending_and_sent_again_only_by_the_recovery() -> Result<()>
{
    with_env(now(), |env| async move {
        seed(&env).await?;
        env.stores
            .mongo
            .documents("users")
            .insert_one(user_document(CHANNEL_A, now()))
            .await?;
        let script = Script::default();
        let server = twitch_mock(script.clone()).await?;
        let availability = service(&env, &server, Duration::from_millis(300))?;

        for slow in [
            MockResponse::json(200, r#"{"data":[{"is_enabled":false}]}"#)
                .delay(Duration::from_secs(3)),
            MockResponse::drop_connection(),
        ] {
            seed(&env).await?;
            let before = toggles(&server).len();
            script.push(slow);
            let outcome = availability
                .set(Target::Redemption, CHANNEL_A, "Hydrate", false, None)
                .await;
            let Err(AvailabilityError::Pending(message)) = outcome else {
                panic!("expected a pending change, got {outcome:?}");
            };
            assert!(message.contains("may have been applied"), "{message}");
            assert_eq!(toggles(&server).len(), before + 1, "sent once");
            let stored = reward(&env).await?;
            assert!(!stored.get_bool("isEnabled")?);
            let state = stored.get_document("availability")?;
            assert!(state.get_bool("pending")?);
            assert_eq!(
                state.get_datetime("nextAt")?.timestamp_millis(),
                dima_core::Clock::now_ms(&env.clock) + 30_000
            );
            assert!(
                stored.get("availabilityLease").is_none(),
                "the lease is released"
            );

            // Not due yet: nothing is sent.
            availability.recover().await?;
            assert_eq!(toggles(&server).len(), before + 1);
            env.clock.advance(30_000);
            script.push(MockResponse::json(
                200,
                r#"{"data":[{"is_enabled":false}]}"#,
            ));
            let report = availability.recover().await?;
            assert_eq!(report.synchronized, 1, "{report:?}");
            assert_eq!(toggles(&server).len(), before + 2);
            assert!(
                reward(&env).await?.get("availability").is_none(),
                "confirmed"
            );
            assert_eq!(script.remaining(), 0);
        }
        Ok(())
    })
    .await
}

/// Two processes flip the same reward at once: whatever order the leases and the requests take,
/// Twitch ends with the stored value and nothing is left pending.
#[tokio::test]
async fn concurrent_changes_leave_twitch_and_the_store_agreeing() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        env.stores
            .mongo
            .documents("users")
            .insert_one(user_document(CHANNEL_A, now()))
            .await?;
        let server = MockServer::start().await?;
        let twitch_state = Arc::new(std::sync::Mutex::new(None::<bool>));
        let state = Arc::clone(&twitch_state);
        server.fallback(move |request: &RecordedRequest| {
            let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
            let enabled = body["is_enabled"].as_bool();
            *state.lock().unwrap() = enabled;
            MockResponse::json(
                200,
                &json!({ "data": [{ "is_enabled": enabled }] }).to_string(),
            )
            .delay(Duration::from_millis(20))
        });
        let first = service(&env, &server, Duration::from_secs(15))?;
        let second = service(&env, &server, Duration::from_secs(15))?;
        for round in 0..8 {
            let (a, b) = tokio::join!(
                first.set(
                    Target::Redemption,
                    CHANNEL_A,
                    "Hydrate",
                    round % 2 == 0,
                    None
                ),
                second.set(
                    Target::Redemption,
                    CHANNEL_A,
                    "reward-1",
                    round % 2 == 1,
                    None
                ),
            );
            for outcome in [a, b] {
                match outcome {
                    Ok(()) => {}
                    // The other process won every fenced write: a refusal, nothing pending.
                    Err(AvailabilityError::Refused(message)) => {
                        assert_eq!(message, "Target changed concurrently; please try again");
                    }
                    Err(error) => panic!("round {round}: {error}"),
                }
            }
            // A change written while the other process held the lease is pending: the
            // recovery (after the lease) sends it.
            env.clock.advance(60_001);
            first.recover().await?;
            let stored = reward(&env).await?;
            assert!(
                stored.get("availability").is_none(),
                "round {round}: {stored:?}"
            );
            assert_eq!(
                *twitch_state.lock().unwrap(),
                Some(stored.get_bool("isEnabled")?),
                "round {round}"
            );
        }
        Ok(())
    })
    .await
}
