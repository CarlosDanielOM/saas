//! Exhaustive fault rows for the 25 Helix-backed wrappers in the five owned folders.
//! Only editors opts into 401 refresh; every other wrapper must return the first 401.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use dima_core::{ManualClock, SecretString, Shutdown, SystemRandom};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use dima_twitch::{
    TWITCH_BOT_ACCOUNT_ID, Twitch, TwitchConfig, TwitchDeps,
    functions::{channels::*, moderation::*, polls::*, predictions::*},
};
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;
const NAMES: [&str; 25] = [
    "add_channel_vip",
    "remove_channel_vip",
    "set_channel_information",
    "unraid",
    "raid",
    "get_twitch_followers",
    "is_live",
    "live_channels",
    "get_channel_information",
    "get_channel_subscriptions",
    "get_channel_editors",
    "remove_channel_moderator",
    "add_moderator",
    "ban",
    "warn_user",
    "get_channel_moderators",
    "get_twitch_moderators_ids",
    "is_twitch_moderator_by_id",
    "is_twitch_moderator_by_login",
    "create_poll",
    "get_poll",
    "end_poll",
    "create_prediction",
    "get_prediction",
    "end_prediction",
];
struct Lookup;
impl ModeratorUserLookup for Lookup {
    fn lookup<'a>(
        &'a self,
        _: &'a Twitch,
        _: &'a str,
    ) -> BoxFuture<'a, Option<moderators::Moderator>> {
        Box::pin(async { None })
    }
}
fn value<T: Serialize, E: Serialize>(r: std::result::Result<T, E>) -> Value {
    match r {
        Ok(v) => serde_json::to_value(v).expect("result"),
        Err(e) => serde_json::to_value(e).expect("error"),
    }
}
async fn call(t: &Twitch, op: usize) -> Value {
    let cancel = tokio_util::sync::CancellationToken::new();
    match op {
        0 => value(add_channel_vip(t, "u1", "viewer").await),
        1 => value(remove_channel_vip(t, "u1", "viewer").await),
        2 => value(set_channel_information(t, "u1", ChannelInformation::default()).await),
        3 => value(unraid(t, "u1").await),
        4 => value(raid(t, "u1", "target").await),
        5 => value(get_twitch_followers(t, "u1", None).await),
        6 => value(is_live(t, "u1").await),
        7 => value(live_channels(t).await),
        8 => value(get_channel_information(t, "u1", false).await),
        9 => value(get_channel_subscriptions(t, "u1").await),
        10 => value(get_channel_editors(t, "u1", false).await),
        11 => value(remove_channel_moderator(t, "u1", "viewer", &cancel).await),
        12 => value(add_moderator(t, "u1", Some("viewer"), &Lookup).await),
        13 => value(ban(t, "u1", "viewer", "moderator", None, None, &cancel).await),
        14 => value(warn_user(t, "u1", "viewer", "reason").await),
        15 => value(get_channel_moderators(t, "u1", &[], false).await),
        16 => value(get_twitch_moderators_ids(t, "u1", true).await),
        17 => value(is_twitch_moderator_by_id(t, "u1", "viewer", true).await),
        18 => value(is_twitch_moderator_by_login(t, "u1", "viewer", true).await),
        19 => value(create_poll(t, "u1", "title", &[], 30.0, false, 0.0).await),
        20 => value(get_poll(t, "u1", None, false).await),
        21 => value(end_poll(t, "u1", "id", "ARCHIVED").await),
        22 => value(create_prediction(t, "u1", "title", &[], 30.0, false).await),
        23 => value(get_prediction(t, "u1", None, false).await),
        _ => value(end_prediction(t, "u1", "id", "LOCKED", None).await),
    }
}
fn short(stores: &Stores, server: &MockServer) -> Result<Twitch> {
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = stores.keys.clone();
    config.timings = fast_timings();
    Ok(Twitch::new(
        config,
        TwitchDeps {
            http: HttpClient::builder().build()?,
            helix: server.provider(
                dima_twitch::helix_provider(CLIENT_ID)
                    .timeout(Duration::from_millis(25))
                    .headers_timeout(Duration::from_millis(25)),
            )?,
            oauth: server.provider(dima_twitch::oauth_provider())?,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock: Arc::new(ManualClock::new(NOW_MS)),
            random: Arc::new(SystemRandom),
            events: Arc::new(dima_twitch::NoopEvents),
            shutdown: Shutdown::new(),
        },
    ))
}
async fn seed(stores: &Stores) -> Result<()> {
    for (id, name) in [("u1", "streamer"), (TWITCH_BOT_ACCOUNT_ID, "bot")] {
        insert_user(
            stores,
            user_document(id, name, "access", "refresh", Some(NOW_MS / 1000 + 3600)),
        )
        .await?;
    }
    Ok(())
}
async fn clear(stores: &Stores) -> Result<()> {
    stores
        .dragonfly
        .del(&[&format!("{}twitch:u1:moderators", stores.keys.prefix())])
        .await?;
    Ok(())
}
#[tokio::test]
async fn all_wrappers_5xx_and_malformed_keep_reference_messages_and_send_once() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        for malformed in [false, true] {
            let server = twitch_mock(Default::default(), move |_, _| {
                if malformed {
                    MockResponse::json(200, "{")
                } else {
                    MockResponse::json(
                        503,
                        r#"{"error":"Failure","message":"reference message","status":503}"#,
                    )
                }
            })
            .await?;
            let t = short(&stores, &server)?;
            t.load_streamers().await?;
            assert!(t.app_token().await.is_some());
            for (op, name) in NAMES.iter().enumerate() {
                clear(&stores).await?;
                let before = server.requests().len();
                let r = call(&t, op).await;
                let expected = if !malformed {
                    "reference message"
                } else if op == 6 {
                    "Failed to check live status"
                } else if op == 13 {
                    "Success"
                } else if op == 14 {
                    "Warning issued"
                } else {
                    "Internal server error"
                };
                assert_eq!(r["message"], expected, "{name}: {r}");
                if op != 12 && !(op == 4 && !malformed) {
                    assert_eq!(
                        r["error"],
                        !(malformed && [13, 14].contains(&op)),
                        "{name}: {r}"
                    );
                }
                if !malformed {
                    assert_eq!(
                        r["status"],
                        if [3, 6, 16, 17, 18].contains(&op) {
                            Value::Null
                        } else {
                            json!(503)
                        },
                        "{name}: status"
                    );
                    let kind = if [3, 4, 6, 8, 15, 16, 17, 18].contains(&op) {
                        Value::Null
                    } else if op == 10 {
                        json!("transient")
                    } else if op == 12 {
                        json!("error")
                    } else {
                        json!("Failure")
                    };
                    assert_eq!(r["type"], kind, "{name}: type");
                }
                assert_eq!(server.requests().len(), before + 1, "{name} must send once");
            }
            t.shutdown().await;
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn all_wrappers_timeout_sends_once_including_mutations() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        let server = twitch_mock(Default::default(), |_, _| {
            MockResponse::json(200, r#"{"data":[]}"#).delay(Duration::from_secs(11))
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        assert!(t.app_token().await.is_some());
        for (op, name) in NAMES.iter().enumerate() {
            clear(&stores).await?;
            let before = server.requests().len();
            let r = call(&t, op).await;
            assert_eq!(
                r["message"],
                if op == 6 {
                    "Failed to check live status"
                } else {
                    "Internal server error"
                },
                "{name}: {r}"
            );
            if op != 12 {
                assert_eq!(r["error"], true, "{name}: {r}");
            }
            assert_eq!(
                server.requests().len(),
                before + 1,
                "{name} timed-out mutation must not be repeated"
            );
        }
        t.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn empty_results_match_reference_for_every_read_and_poll_prediction_mutation() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        let server = twitch_mock(Default::default(), |_, _| {
            MockResponse::json(200, r#"{"data":[],"total":0,"points":0}"#)
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        for op in [
            4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        ] {
            clear(&stores).await?;
            let r = call(&t, op).await;
            match op {
                4 => assert_eq!(r, json!({"data":[],"total":0,"points":0})),
                6 | 7 => assert_eq!(r, json!([])),
                8 => assert_eq!(r, json!({"error":false})),
                10 => assert_eq!(r, json!({"error":false,"editors":[]})),
                19 | 21 | 22 | 24 => assert_eq!(r["message"], "Internal server error"),
                20 => assert_eq!(r["message"], "Poll not found"),
                23 => assert_eq!(r["message"], "Prediction not found"),
                _ => assert_eq!(r["error"], false, "{}: {r}", NAMES[op]),
            }
        }
        t.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn only_editors_refresh_on_401_all_other_wrappers_return_first_answer() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        let state = Arc::new(std::sync::Mutex::new(TwitchState::default()));
        state
            .lock()
            .expect("state")
            .valid
            .insert("refresh".into(), "u1".into());
        state.lock().expect("state").expires_in = 14_400;
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let server = twitch_mock(state, move |_, _| {
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                MockResponse::json(
                    401,
                    r#"{"error":"Unauthorized","message":"reference 401","status":401}"#,
                )
            } else {
                MockResponse::json(200, r#"{"data":[]}"#)
            }
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        assert!(t.app_token().await.is_some());
        for (op, name) in NAMES.iter().enumerate() {
            clear(&stores).await?;
            count.store(0, Ordering::SeqCst);
            let r = call(&t, op).await;
            if op == 10 {
                assert_eq!(r, json!({"error":false,"editors":[]}));
                assert_eq!(count.load(Ordering::SeqCst), 2);
            } else {
                assert_eq!(r["message"], "reference 401", "{name}: {r}");
                assert_eq!(
                    count.load(Ordering::SeqCst),
                    1,
                    "{name}: reference has no refresh retry"
                );
            }
        }
        t.shutdown().await;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn editor_auth_statuses_and_failed_refresh_are_distinguished() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        for code in [403, 429, 500] {
            let server = twitch_mock(Default::default(), move |_, _| {
                MockResponse::json(
                    code,
                    &json!({"message":"reference message","error":"Failure","status":code})
                        .to_string(),
                )
            })
            .await?;
            let t = short(&stores, &server)?;
            t.load_streamers().await?;
            let e = get_channel_editors(&t, "u1", false)
                .await
                .expect_err("HTTP");
            assert_eq!(e.message, "reference message");
            assert_eq!(e.status, Some(code));
            assert_eq!(
                e.kind.as_deref(),
                Some(if code == 403 {
                    "auth_required"
                } else {
                    "transient"
                })
            );
            assert_eq!(server.requests().len(), 1);
            t.shutdown().await;
        }
        let server = twitch_mock(Default::default(), |_, _| {
            MockResponse::json(401, r#"{"error":"Unauthorized"}"#)
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        let e = get_channel_editors(&t, "u1", false)
            .await
            .expect_err("refresh unavailable");
        assert_eq!(e.message, "Unable to refresh Twitch streamer token");
        assert_eq!(e.status, Some(503));
        assert_eq!(e.kind.as_deref(), Some("transient"));
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|r| r.path() == "/helix/channels/editors")
                .count(),
            1
        );
        t.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn lookup_404_without_error_flag_and_prediction_invalid_status_match_reference() -> Result<()>
{
    with_stores(|stores| async move {
        seed(&stores).await?;
        let server = twitch_mock(Default::default(), |_, _| {
            MockResponse::json(
                404,
                r#"{"data":[{"id":"id","title":"title","choices":[],"outcomes":[]}]}"#,
            )
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        let e = get_poll(&t, "u1", None, false).await.expect_err("404");
        assert_eq!(e.message, "Poll not found");
        assert_eq!(e.status, Some(404));
        let e = get_prediction(&t, "u1", None, false)
            .await
            .expect_err("404");
        assert_eq!(e.message, "Prediction not found");
        assert_eq!(e.status, Some(404));
        let e = end_prediction(&t, "u1", "id", "ACTIVE", None)
            .await
            .expect_err("status");
        assert_eq!(e.message, "Invalid status");
        assert_eq!(e.status, Some(400));
        assert_eq!(server.requests().len(), 2);
        t.shutdown().await;
        Ok(())
    })
    .await
}
