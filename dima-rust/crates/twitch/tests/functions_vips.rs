//! Timed VIP validation and expiration effects against disposable Mongo databases.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use bson::{Bson, doc};
use dima_core::{ManualClock, SecretString, Shutdown, SystemRandom};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use dima_model::{redemption_rewards, vips};
use dima_store::mongo::WriteContext;
use dima_twitch::{AccessToken, functions::redemptions::*};
use dima_twitch::{Twitch, TwitchConfig, TwitchDeps};
use futures_util::future::BoxFuture;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::{sync::Arc, time::Duration};
use support::*;

struct Api {
    calls: AtomicUsize,
}
impl RewardApi for Api {
    fn update<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a AccessToken,
        body: RewardUpdate,
    ) -> BoxFuture<'a, Result<bool, RewardApiError>> {
        Box::pin(async move {
            assert_eq!(body.cost, 25.0);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(false)
        })
    }
}
async fn reward(stores: &Stores, duration: f64) -> Result<()> {
    let prepared = redemption_rewards::INFO.prepare_create(
        &doc! {
            "eventsubID":"e","channelID":"u1","channel":"streamer","rewardID":"r",
            "type":"vip","title":"VIP 👋 é العربية","prompt":"prompt","originalCost":10,
            "cost":20,"costChange":5,"duration":duration,"message":"Welcome 👋 é العربية"
        },
        &mut WriteContext::new(NOW_MS),
    )?;
    stores
        .mongo
        .writes(redemption_rewards::COLLECTION)
        .insert_one(&prepared)
        .await?;
    Ok(())
}
async fn account(stores: &Stores) -> Result<()> {
    insert_user(
        stores,
        user_document(
            "u1",
            "streamer",
            "access",
            "refresh",
            Some(NOW_MS / 1000 + 3600),
        ),
    )
    .await
}
fn event() -> VipRedemptionEvent<'static> {
    VipRedemptionEvent {
        channel_id: "u1",
        channel: "streamer",
        user_id: "viewer",
        username: "viewer",
    }
}
#[tokio::test]
async fn timed_redemption_updates_cost_then_fails_validation_without_grant_or_record() -> Result<()>
{
    with_stores(|stores| async move {
        account(&stores).await?;
        reward(&stores, 1.0).await?;
        let server = twitch_mock(Default::default(), |_, _| MockResponse::new(204)).await?;
        let p = process(&stores, &server, fast_timings())?;
        p.twitch.load_streamers().await?;
        let api = Api {
            calls: AtomicUsize::new(0),
        };
        let error = vip_redemption(&p.twitch, &api, &event(), "r")
            .await
            .expect_err("required expireTimestamp");
        assert_eq!(error.message, "Internal server error");
        assert_eq!(error.status, None);
        assert_eq!(error.kind.as_deref(), Some("error"));
        assert_eq!(api.calls.load(Ordering::SeqCst), 1);
        assert!(server.requests().is_empty());
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .count_documents(doc! {})
                .await?,
            0
        );
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn permanent_redemption_grants_once_with_streamer_token_and_no_record() -> Result<()> {
    with_stores(|stores| async move {
        account(&stores).await?;
        reward(&stores, 0.0).await?;
        for code in [204, 400, 401, 403, 422, 500, 200] {
            let server = twitch_mock(Default::default(), move |_, _| {
                if code == 204 {
                    MockResponse::new(204)
                } else if code == 200 {
                    MockResponse::json(200, "{")
                } else {
                    MockResponse::json(code, r#"{"error":"Failure","message":"refused"}"#)
                }
            })
            .await?;
            let p = process(&stores, &server, fast_timings())?;
            p.twitch.load_streamers().await?;
            let api = Api {
                calls: AtomicUsize::new(0),
            };
            let result = vip_redemption(&p.twitch, &api, &event(), "r").await;
            if code == 204 {
                let value = result?;
                assert_eq!(value.message, "VIP added");
                assert_eq!(
                    value.reward_message.as_deref(),
                    Some("Welcome 👋 é العربية")
                );
            } else {
                let e = result.expect_err("grant failed");
                assert_eq!(e.message, "Error adding VIP");
                assert_eq!(e.status, Some(500));
                assert_eq!(e.kind.as_deref(), Some("error_adding_vip"));
            }
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].method, "POST");
            assert_eq!(
                requests[0].target,
                "/helix/channels/vips?user_id=viewer&broadcaster_id=u1"
            );
            assert_eq!(requests[0].header("authorization"), Some("Bearer access"));
            assert_eq!(
                stores
                    .mongo
                    .documents(vips::COLLECTION)
                    .count_documents(doc! {})
                    .await?,
                0
            );
            p.twitch.shutdown().await;
        }
        Ok(())
    })
    .await
}
async fn seed_vip(stores: &Stores, user: &str, day: i32) -> Result<bson::Document> {
    let prepared=vips::INFO.prepare_create(&doc!{"username":user,"userID":user,"channel":"streamer","channelID":"u1","duration":1,"vip":true,"expireDate":{"day":day,"month":10,"year":2026},"expireTimestamp":Bson::DateTime(bson::DateTime::from_millis(NOW_MS-1))},&mut WriteContext::new(NOW_MS))?;
    stores
        .mongo
        .writes(vips::COLLECTION)
        .insert_one(&prepared)
        .await?;
    Ok(prepared.document)
}
#[tokio::test]
async fn expiration_uses_calendar_strict_midnight_and_preserves_rows_on_all_api_failures()
-> Result<()> {
    with_stores(|stores| async move {
        account(&stores).await?;
        let response = std::sync::Arc::new(Mutex::new(MockResponse::new(204)));
        let r = response.clone();
        let server = twitch_mock(Default::default(), move |_, _| {
            r.lock().expect("response").clone()
        })
        .await?;
        let p = process(&stores, &server, fast_timings())?;
        p.twitch.load_streamers().await?;
        let e = unvip_expired_user(&p.twitch, "u1")
            .await
            .expect_err("empty");
        assert_eq!(e.message, "No VIPs found");
        assert_eq!(e.kind.as_deref(), Some("no_vips_found"));
        assert_eq!(e.status, None);
        let midnight = seed_vip(&stores, "midnight", 11).await?;
        let future = seed_vip(&stores, "future", 12).await?;
        assert_eq!(unvip_expired_user(&p.twitch, "u1").await?, None);
        assert!(server.requests().is_empty());
        let expired = seed_vip(&stores, "expired", 10).await?;
        // Stored BSON types/defaults: compare entire document, including missing vs null.
        let stored = stores
            .mongo
            .documents(vips::COLLECTION)
            .find_one(doc! {"userID":"expired"})
            .await?
            .expect("stored");
        assert_eq!(stored, expired);
        assert!(matches!(stored.get("duration"), Some(Bson::Int32(1))));
        assert!(matches!(stored.get("createdAt"), Some(Bson::DateTime(_))));
        assert!(!stored.contains_key("unknown"));
        for body in [
            MockResponse::json(
                400,
                r#"{"message":"not a VIP","status":400,"error":"Bad Request"}"#,
            ),
            MockResponse::json(401, r#"{"error":"Unauthorized"}"#),
            MockResponse::json(403, "{}"),
            MockResponse::json(500, "{}"),
            MockResponse::json(200, "{"),
        ] {
            *response.lock().expect("response") = body;
            let before = server.requests().len();
            let e = unvip_expired_user(&p.twitch, "u1")
                .await
                .expect_err("retained");
            assert_eq!(e.message, "Error removing VIP");
            assert_eq!(e.status, Some(500));
            assert_eq!(server.requests().len(), before + 1);
            assert_eq!(
                stores
                    .mongo
                    .documents(vips::COLLECTION)
                    .find_one(doc! {"userID":"expired"})
                    .await?,
                Some(expired.clone())
            );
        }
        *response.lock().expect("response") = MockResponse::new(204);
        assert_eq!(unvip_expired_user(&p.twitch, "u1").await?, None);
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .find_one(doc! {"userID":"expired"})
                .await?,
            None
        );
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .find_one(doc! {"userID":"midnight"})
                .await?,
            Some(midnight)
        );
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .find_one(doc! {"userID":"future"})
                .await?,
            Some(future)
        );
        let requests = server.requests();
        for r in requests {
            assert_eq!(r.method, "DELETE");
            assert_eq!(
                r.target,
                "/helix/channels/vips?user_id=expired&broadcaster_id=u1"
            );
            assert_eq!(r.header("authorization"), Some("Bearer access"));
        }
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}

fn short(stores: &Stores, server: &MockServer) -> Result<Twitch> {
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = stores.keys.clone();
    config.timings = fast_timings();
    Ok(Twitch::new(
        config,
        TwitchDeps {
            http: HttpClient::builder().build()?,
            exchange_http: dima_twitch::exchange_client(HttpClient::builder())?,
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

#[tokio::test]
async fn vip_grant_and_expiry_timeouts_never_repeat_or_delete_record() -> Result<()> {
    with_stores(|stores| async move {
        account(&stores).await?;
        reward(&stores, 0.0).await?;
        let server = twitch_mock(Default::default(), |_, _| {
            MockResponse::new(204).delay(Duration::from_secs(1))
        })
        .await?;
        let t = short(&stores, &server)?;
        t.load_streamers().await?;
        let api = Api {
            calls: AtomicUsize::new(0),
        };
        let e = vip_redemption(&t, &api, &event(), "r")
            .await
            .expect_err("timeout");
        assert_eq!(e.message, "Error adding VIP");
        assert_eq!(server.requests().len(), 1);
        let before = seed_vip(&stores, "expired", 10).await?;
        let e = unvip_expired_user(&t, "u1").await.expect_err("timeout");
        assert_eq!(e.message, "Error removing VIP");
        assert_eq!(server.requests().len(), 2);
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .find_one(doc! {"userID":"expired"})
                .await?,
            Some(before)
        );
        t.shutdown().await;
        Ok(())
    })
    .await
}

struct HttpApi {
    http: HttpClient,
    provider: dima_http::Provider,
}
impl RewardApi for HttpApi {
    fn update<'a>(
        &'a self,
        channel: &'a str,
        reward: &'a str,
        token: &'a AccessToken,
        body: RewardUpdate,
    ) -> BoxFuture<'a, Result<bool, RewardApiError>> {
        Box::pin(async move {
            let path = dima_http::Path::template("/rewards/{}/{}", &[channel, reward])
                .map_err(|_| RewardApiError)?;
            let response: serde_json::Value = self
                .http
                .request(&self.provider, dima_http::Method::PATCH, path)
                .bearer(&SecretString::from(token.expose()))
                .json(&body)
                .send()
                .await
                .map_err(|_| RewardApiError)?
                .json()
                .await
                .map_err(|_| RewardApiError)?;
            Ok(response.get("error").is_some_and(dima_text::js_truthy))
        })
    }
}
#[tokio::test]
async fn reward_api_failures_and_empty_results_cover_all_three_orchestrators() -> Result<()> {
    with_stores(|stores| async move {
        account(&stores).await?;
        reward(&stores, 0.0).await?;
        // Reset must opt in and remain non-free.
        stores
            .mongo
            .documents(redemption_rewards::COLLECTION)
            .update_one(doc! {}, doc! {"$set":{"returnToOriginalCost":true}})
            .await?;
        for case in ["500", "401", "malformed", "timeout"] {
            let server = twitch_mock(Default::default(), move |_, _| match case {
                "500" => MockResponse::json(500, r#"{"error":true}"#),
                "401" => MockResponse::json(401, r#"{"error":true}"#),
                "malformed" => MockResponse::json(200, "{"),
                _ => MockResponse::json(200, r#"{"error":false}"#).delay(Duration::from_secs(1)),
            })
            .await?;
            let t = short(&stores, &server)?;
            t.load_streamers().await?;
            set_cache(&stores, "u1", &[("plan_tier", "premium")]).await?;
            let api = HttpApi {
                http: HttpClient::builder().build()?,
                provider: server.provider(
                    dima_http::Provider::builder("internal", "http://127.0.0.1")
                        .timeout(Duration::from_millis(25)),
                )?,
            };
            for op in 0..3 {
                let before = server.requests().len();
                let e = match op {
                    0 => vip_redemption(&t, &api, &event(), "r").await,
                    1 => custom_redemption_reward(&t, &api, "u1", "r").await,
                    _ => reset_redemption_cost(&t, &api, "u1").await,
                }
                .expect_err("API failure");
                assert_eq!(
                    e.message,
                    if matches!(case, "500" | "401") {
                        "Error updating reward"
                    } else {
                        "Internal server error"
                    }
                );
                assert_eq!(
                    server.requests().len(),
                    before + 1,
                    "{case}: op {op} single PATCH"
                );
                let requests = server.requests();
                let request = requests.last().expect("PATCH");
                assert_eq!(request.method, "PATCH");
                assert_eq!(request.target, "/rewards/u1/r");
                assert_eq!(request.header("authorization"), Some("Bearer access"));
            }
            t.shutdown().await;
        }
        let server = twitch_mock(Default::default(), |_, _| MockResponse::new(204)).await?;
        let p = process(&stores, &server, fast_timings())?;
        p.twitch.load_streamers().await?;
        set_cache(&stores, "u1", &[("plan_tier", "premium")]).await?;
        let api = Api {
            calls: AtomicUsize::new(0),
        };
        let e = vip_redemption(&p.twitch, &api, &event(), "missing")
            .await
            .expect_err("missing");
        assert_eq!(e.message, "Reward not found");
        assert_eq!(e.status, Some(404));
        stores
            .mongo
            .documents(redemption_rewards::COLLECTION)
            .delete_many(doc! {})
            .await?;
        let e = reset_redemption_cost(&p.twitch, &api, "u1")
            .await
            .expect_err("empty");
        assert_eq!(e.message, "No rewards found");
        assert_eq!(e.status, Some(404));
        set_cache(&stores, "u1", &[("plan_tier", "free")]).await?;
        let e = reset_redemption_cost(&p.twitch, &api, "u1")
            .await
            .expect_err("free");
        assert_eq!(e.message, "Channel not premium");
        assert_eq!(e.status, Some(400));
        assert!(server.requests().is_empty());
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn expiration_streams_past_one_batch_accepts_legacy_and_stops_after_first_failure()
-> Result<()> {
    with_stores(|stores| async move {
        account(&stores).await?;
        for n in 0..101 {
            seed_vip(&stores, &format!("viewer{n}"), 10).await?;
        }
        // Legacy records without required expireTimestamp remain readable by this projection.
        stores
            .mongo
            .documents(vips::COLLECTION)
            .update_many(doc! {}, doc! {"$unset":{"expireTimestamp":""}})
            .await?;
        let count = std::sync::Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let server = twitch_mock(Default::default(), move |_, _| {
            if c.fetch_add(1, Ordering::SeqCst) == 1 {
                MockResponse::json(500, r#"{"error":"Failure"}"#)
            } else {
                MockResponse::new(204)
            }
        })
        .await?;
        let p = process(&stores, &server, fast_timings())?;
        p.twitch.load_streamers().await?;
        let e = unvip_expired_user(&p.twitch, "u1")
            .await
            .expect_err("second removal fails");
        assert_eq!(e.message, "Error removing VIP");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .count_documents(doc! {})
                .await?,
            100
        );
        assert_eq!(unvip_expired_user(&p.twitch, "u1").await?, None);
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .count_documents(doc! {})
                .await?,
            0
        );
        assert_eq!(count.load(Ordering::SeqCst), 102);
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn redemption_authentication_failure_precedes_write_and_twitch_grant() -> Result<()> {
    with_stores(|stores| async move {
        reward(&stores, 1.0).await?;
        let server = twitch_mock(Default::default(), |_, _| MockResponse::new(204)).await?;
        let p = process(&stores, &server, fast_timings())?;
        let api = Api {
            calls: AtomicUsize::new(0),
        };
        for vip in [true, false] {
            let e = if vip {
                vip_redemption(&p.twitch, &api, &event(), "r").await
            } else {
                custom_redemption_reward(&p.twitch, &api, "u1", "r").await
            }
            .expect_err("no token");
            assert_eq!(e.message, "Failed to authenticate");
            assert_eq!(e.status, Some(403));
            assert_eq!(e.kind.as_deref(), Some("authentication_error"));
        }
        assert_eq!(api.calls.load(Ordering::SeqCst), 0);
        assert!(server.requests().is_empty());
        assert_eq!(
            stores
                .mongo
                .documents(vips::COLLECTION)
                .count_documents(doc! {})
                .await?,
            0
        );
        p.twitch.shutdown().await;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn invalid_legacy_calendar_is_retained_without_helix_call() -> Result<()> {
    with_stores(|stores|async move {
        let doc=doc!{"channelID":"u1","userID":"legacy","vip":true,"expireDate":{"year":2026,"month":10}};
        stores.mongo.documents(vips::COLLECTION).insert_one(doc).await?;
        let before=stores.mongo.documents(vips::COLLECTION).find_one(doc!{}).await?;
        let server=twitch_mock(Default::default(),|_,_|MockResponse::new(204)).await?;
        let p=process(&stores,&server,fast_timings())?;
        assert_eq!(unvip_expired_user(&p.twitch,"u1").await?,None);assert_eq!(stores.mongo.documents(vips::COLLECTION).find_one(doc!{}).await?,before);assert!(server.requests().is_empty());p.twitch.shutdown().await;Ok(())
    }).await
}
