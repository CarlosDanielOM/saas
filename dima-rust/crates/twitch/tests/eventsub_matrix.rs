//! The failure matrix of the three Twitch calls, as `functions_matrix.rs` has it for the Helix
//! wrappers: every special status, 401 then success, 401 twice, 5xx, a timeout after the
//! request left, a request that never left, a malformed and a cut answer. None is sent twice
//! (the reference sends each once), a create or delete whose outcome is unknown says so, and
//! nothing is stored for a create that did not certainly succeed. Two processes creating the
//! same subscription at once end with one at Twitch and one stored document.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
#[path = "eventsub/fake.rs"]
mod fake;
#[path = "eventsub/replay.rs"]
mod replay;
mod support;

use anyhow::Result;
use dima_core::SecretString;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_twitch::eventsub::{
    Condition, EventsubManager, EventsubSettings, Failure, ListError, SubscribeRequest,
};
use fake::FakeTwitch;
use replay::*;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use support::{NOW_MS, Stores, with_stores};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Subscribe,
    List,
    Unsubscribe,
}

const OPS: [Op; 3] = [Op::Subscribe, Op::List, Op::Unsubscribe];

/// What came back, reduced: `(status, failure)` or `ok`.
#[derive(Debug, PartialEq)]
enum Outcome {
    Ok,
    Failed(u16, Failure),
    List(ListError),
}

fn settings() -> EventsubSettings {
    let mut settings =
        EventsubSettings::reference(Some(SecretString::from(SECRET))).expect("settings");
    settings.request_timeout = Duration::from_millis(400);
    settings
}

async fn setup(
    stores: &Stores,
    server: &MockServer,
) -> Result<(support::Process, EventsubManager)> {
    create_indexes(stores).await?;
    seed_channels(stores, &json!([{"id": "c1", "name": "chan_one"}]), NOW_MS).await?;
    seed_documents(
        stores,
        "eventsubs",
        &json!([{"_id": {"$oid": "00000000000000000000f001"}, "id": "stored", "type": "stream.online", "version": "1", "channelID": "c1", "channel": "chan_one", "status": "enabled", "condition": {"broadcaster_user_id": "c1"}, "created_at": "x", "transport": {}, "cost": 1}]),
    )
    .await?;
    let process = process(stores, server, CLIENT_ID, NOW_MS)?;
    process.twitch.load_streamers().await?;
    let manager = EventsubManager::new(process.twitch.clone(), settings());
    Ok((process, manager))
}

async fn call(manager: &EventsubManager, op: Op) -> Outcome {
    match op {
        Op::Subscribe => {
            let condition = Condition::of(&[("broadcaster_user_id", "c1")]);
            let request =
                SubscribeRequest::new("c1", "stream.offline", "1", &condition).ignore_existing();
            match manager.subscribe(&request).await {
                Ok(_) => Outcome::Ok,
                Err(error) => Outcome::Failed(error.status, error.failure),
            }
        }
        Op::List => match manager.list(Some("c1")).await {
            Ok(_) => Outcome::Ok,
            Err(error) => Outcome::List(error),
        },
        Op::Unsubscribe => match manager.unsubscribe("stored").await {
            Ok(_) => Outcome::Ok,
            Err(error) => Outcome::Failed(error.status, error.failure),
        },
    }
}

async fn stored(stores: &Stores) -> Result<Vec<Value>> {
    documents(stores, "eventsubs").await
}

fn refresh_requests(server: &MockServer) -> usize {
    server
        .requests()
        .iter()
        .filter(|r| r.path() == "/oauth2/token" && r.body_text().contains("refresh_token"))
        .count()
}

#[tokio::test]
async fn every_status_is_reported_once_without_retry() -> Result<()> {
    for op in OPS {
        for status in [400_u16, 401, 403, 404, 409, 429, 500, 502, 503] {
            with_stores(|stores| async move {
                let body = json!({"error": "Failure", "status": status, "message": "reference message"});
                let server = twitch_with(true, move |_| {
                    MockResponse::json(status, &body.to_string())
                        .header("ratelimit-reset", "1794355260")
                })
                .await?;
                let (_process, manager) = setup(&stores, &server).await?;
                let before = stored(&stores).await?;
                let outcome = call(&manager, op).await;
                match (op, status) {
                    (Op::Unsubscribe, 404) => {
                        assert_eq!(outcome, Outcome::Ok, "404 is success");
                        assert!(stored(&stores).await?.is_empty(), "the stored one is removed");
                    }
                    (Op::List, _) => {
                        assert!(
                            matches!(&outcome, Outcome::List(ListError::Twitch { status: s, page }) if *s == status && page["message"] == "reference message"),
                            "{op:?} {status}: {outcome:?}"
                        );
                        assert_eq!(stored(&stores).await?, before);
                    }
                    _ => {
                        assert_eq!(outcome, Outcome::Failed(status, Failure::Twitch), "{op:?}");
                        assert_eq!(stored(&stores).await?, before, "{op:?} {status}: nothing stored or removed");
                    }
                }
                assert_eq!(helix_requests(&server).len(), 1, "{op:?} {status}: sent once");
                assert_eq!(refresh_requests(&server), 0, "{op:?} {status}: no token refresh");
                Ok(())
            })
            .await?;
        }
    }
    // The 429's reset time reaches the caller.
    with_stores(|stores| async move {
        let server = twitch_with(true, |_| {
            MockResponse::json(
                429,
                r#"{"error":"Too Many Requests","status":429,"message":"limit"}"#,
            )
            .header("ratelimit-reset", "1794355260")
        })
        .await?;
        let (_process, manager) = setup(&stores, &server).await?;
        let condition = Condition::of(&[("broadcaster_user_id", "c1")]);
        let error = manager
            .subscribe(&SubscribeRequest::new(
                "c1",
                "stream.offline",
                "1",
                &condition,
            ))
            .await
            .expect_err("429");
        assert_eq!(error.rate_limit_reset, Some(1_794_355_260));
        assert!(!error.is_conflict());
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_401_is_neither_refreshed_nor_repeated() -> Result<()> {
    for op in OPS {
        for twice in [false, true] {
            with_stores(|stores| async move {
                let seen = Arc::new(AtomicUsize::new(0));
                let counter = Arc::clone(&seen);
                let server = twitch_with(true, move |_| {
                    if counter.fetch_add(1, Ordering::SeqCst) == 0 || twice {
                        MockResponse::json(401, r#"{"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}"#)
                    } else {
                        MockResponse::json(200, r#"{"data":[],"pagination":{}}"#)
                    }
                })
                .await?;
                let (_process, manager) = setup(&stores, &server).await?;
                let outcome = call(&manager, op).await;
                match op {
                    Op::List => assert!(
                        matches!(outcome, Outcome::List(ListError::Twitch { status: 401, .. })),
                        "{outcome:?}"
                    ),
                    _ => assert_eq!(outcome, Outcome::Failed(401, Failure::Twitch), "{op:?}"),
                }
                assert_eq!(seen.load(Ordering::SeqCst), 1, "{op:?}: one request");
                assert_eq!(refresh_requests(&server), 0);
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn a_lost_answer_is_unknown_and_never_repeated() -> Result<()> {
    for op in OPS {
        for cut in [false, true] {
            with_stores(|stores| async move {
                let twitch = FakeTwitch::new(NOW_MS);
                twitch.create(
                    &json!({"type": "stream.online", "version": "1", "condition": {"broadcaster_user_id": "c1"}, "transport": {"method": "webhook", "callback": REFERENCE}}),
                    "enabled",
                );
                let fake = twitch.clone();
                // Twitch processes the request, then the answer is lost: held past the
                // deadline, or cut after the head.
                let server = twitch_with(true, move |request: &RecordedRequest| {
                    let answer = fake.handle(request);
                    if cut {
                        answer.drop_after(3)
                    } else {
                        answer.delay(Duration::from_secs(3))
                    }
                })
                .await?;
                let (_process, manager) = setup(&stores, &server).await?;
                let before = stored(&stores).await?;
                let outcome = call(&manager, op).await;
                match op {
                    Op::List => assert!(
                        matches!(&outcome, Outcome::List(ListError::Request(_)) | Outcome::List(ListError::Malformed { .. })),
                        "{outcome:?}"
                    ),
                    Op::Unsubscribe if cut => {
                        // A 204 has no body to cut: the delete is known to have succeeded.
                        assert!(matches!(outcome, Outcome::Ok | Outcome::Failed(_, Failure::Unknown)), "{outcome:?}");
                    }
                    _ => assert!(
                        matches!(outcome, Outcome::Failed(_, Failure::Unknown)),
                        "{op:?} cut={cut}: {outcome:?}"
                    ),
                }
                assert_eq!(helix_requests(&server).len(), 1, "{op:?}: never sent twice");
                if op == Op::Subscribe {
                    assert_eq!(stored(&stores).await?, before, "nothing stored for an unknown outcome");
                    assert_eq!(twitch.subs().len(), 2, "Twitch did create it");
                    // The caller's retry: Twitch refuses the duplicate.
                    let condition = Condition::of(&[("broadcaster_user_id", "c1")]);
                    let fake = twitch.clone();
                    let retry = twitch_with(true, move |request| fake.handle(request)).await?;
                    let process = process(&stores, &retry, CLIENT_ID, NOW_MS)?;
                    let manager = EventsubManager::new(process.twitch.clone(), settings());
                    let error = manager
                        .subscribe(&SubscribeRequest::new("c1", "stream.offline", "1", &condition).ignore_existing())
                        .await
                        .expect_err("409");
                    assert!(error.is_conflict(), "{error:?}");
                    assert_eq!(twitch.subs().len(), 2, "no second subscription");
                }
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

const REFERENCE: &str = "https://subscriptions.domdimabot.com/eventsub";

#[tokio::test]
async fn a_request_that_never_left_is_not_sent() -> Result<()> {
    for op in OPS {
        with_stores(|stores| async move {
            let oauth = twitch_with(true, |_| MockResponse::json(500, "{}")).await?;
            let closed = MockServer::start().await?;
            create_indexes(&stores).await?;
            seed_channels(&stores, &json!([{"id": "c1", "name": "chan_one"}]), NOW_MS).await?;
            let process = process_split(&stores, &closed, &oauth, CLIENT_ID, NOW_MS)?;
            drop(closed);
            process.twitch.load_streamers().await?;
            let manager = EventsubManager::new(process.twitch.clone(), settings());
            let outcome = call(&manager, op).await;
            match op {
                Op::List => assert!(
                    matches!(outcome, Outcome::List(ListError::Request(_))),
                    "{outcome:?}"
                ),
                _ => assert!(
                    matches!(outcome, Outcome::Failed(_, Failure::NotSent)),
                    "{op:?}: {outcome:?}"
                ),
            }
            assert!(helix_requests(&oauth).is_empty());
            assert!(stored(&stores).await?.is_empty());
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn malformed_answers() -> Result<()> {
    for op in OPS {
        for status in [200_u16, 202, 500] {
            with_stores(|stores| async move {
                let server = twitch_with(true, move |_| MockResponse::json(status, "{")).await?;
                let (_process, manager) = setup(&stores, &server).await?;
                let before = stored(&stores).await?;
                let outcome = call(&manager, op).await;
                let ok = status < 300;
                match op {
                    Op::List => assert!(
                        matches!(outcome, Outcome::List(ListError::Malformed { status: s }) if s == status),
                        "{outcome:?}"
                    ),
                    Op::Subscribe if ok => assert_eq!(outcome, Outcome::Failed(status, Failure::Unknown)),
                    _ => assert_eq!(outcome, Outcome::Failed(status, Failure::Twitch), "{op:?} {status}"),
                }
                assert_eq!(stored(&stores).await?, before);
                assert_eq!(helix_requests(&server).len(), 1);
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn two_processes_creating_the_same_subscription_make_one() -> Result<()> {
    with_stores(|stores| async move {
        let twitch = FakeTwitch::new(NOW_MS);
        twitch.lock().status = "enabled".into();
        let fake = twitch.clone();
        // Both requests arrive before either is answered.
        let server = twitch_with(true, move |request| {
            fake.handle(request).delay(Duration::from_millis(100))
        })
        .await?;
        create_indexes(&stores).await?;
        seed_channels(&stores, &json!([{"id": "c1", "name": "chan_one"}]), NOW_MS).await?;
        let first = process(&stores, &server, CLIENT_ID, NOW_MS)?;
        let second = process(&stores, &server, CLIENT_ID, NOW_MS)?;
        first.twitch.load_streamers().await?;
        let a = EventsubManager::new(first.twitch.clone(), settings());
        let b = EventsubManager::new(second.twitch.clone(), settings());
        let condition = Condition::of(&[("broadcaster_user_id", "c1")]);
        let request = SubscribeRequest::new("c1", "stream.online", "1", &condition);
        let (left, right) = tokio::join!(a.subscribe(&request), b.subscribe(&request));
        let outcomes = [left.is_ok(), right.is_ok()];
        assert_eq!(
            outcomes.iter().filter(|ok| **ok).count(),
            1,
            "{left:?} {right:?}"
        );
        let refused = left.err().or(right.err()).expect("one refused");
        assert!(refused.is_conflict(), "{refused:?}");
        assert_eq!(twitch.subs().len(), 1);
        assert_eq!(stored(&stores).await?.len(), 1);
        Ok(())
    })
    .await
}
