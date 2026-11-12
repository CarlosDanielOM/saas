//! Prediction reference cases: full requests, active selection, cache, and single-send mutations.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::functions::predictions::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;

fn prediction(id: &str, status: &str) -> Value {
    json!({"id":id,"title":"👋 é العربية","broadcaster_id":"u1","broadcaster_login":"streamer","status":status,"outcomes":[{"id":"one","title":"Yes","users":3}]})
}
async fn seed(stores: &Stores) -> Result<()> {
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
#[tokio::test]
async fn lookup_selects_active_and_preserves_cache_shape() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        let server = twitch_mock(Arc::new(Mutex::new(TwitchState::default())), |_, _| {
            MockResponse::json(
                200,
                &data(json!([
                    prediction("old", "RESOLVED"),
                    prediction("current", "ACTIVE")
                ])),
            )
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        let result = get_prediction(&process.twitch, "u1", None, true).await?;
        assert_eq!(result.data.id, "current");
        assert_eq!(result.data.outcomes[0].users, Some(3.0));
        assert_eq!(
            get_prediction(&process.twitch, "u1", Some("old"), true)
                .await?
                .message,
            "Success (from cache)"
        );
        let requests = server.requests();
        let requests: Vec<_> = requests
            .iter()
            .filter(|r| r.path() == "/helix/predictions")
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].target, "/helix/predictions?broadcaster_id=u1");
        assert!(requests[0].body.is_empty());
        assert_helix_headers(requests[0]);
        let key = format!("{}twitch:u1:predictions", stores.keys.prefix());
        let stored: Value =
            serde_json::from_slice(&stores.dragonfly.get(&key).await?.expect("cache"))?;
        assert_eq!(stored, serde_json::to_value(&result.data)?);
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn create_and_end_requests_and_distinguished_answers() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        for method in ["POST","PATCH","GET"] {
            for case in ["success","empty","401","403","404","500","malformed"] {
                let response=match case {
                    "success"=>MockResponse::json(200,&data(json!([prediction("p","ACTIVE")]))),
                    "empty"=>MockResponse::json(200,&data(json!([]))),
                    "malformed"=>MockResponse::json(200,"{"),
                    code=>MockResponse::json(code.parse()?,&json!({"error":"Failure","message":"reference message","status":code.parse::<u16>()?}).to_string()),
                };
                let server=twitch_mock(Arc::new(Mutex::new(TwitchState::default())),move |_,_| response.clone()).await?;
                let process=process(&stores,&server,fast_timings())?;
                process.twitch.load_streamers().await?;
                let result=match method {
                    "POST"=>create_prediction(&process.twitch,"u1","👋",&["Yes".into()],30.0,false).await.map(|p|p.prediction.id),
                    "PATCH"=>end_prediction(&process.twitch,"u1","p","RESOLVED", None).await.map(|p|p.data.id),
                    _=>get_prediction(&process.twitch,"u1",Some("p"),false).await.map(|p|p.data.id),
                };
                if case=="success" {assert_eq!(result?,"p");} else {
                    let error=result.expect_err(case);
                    if matches!(case,"401"|"403"|"404"|"500") {assert_eq!(error.message,"reference message");assert_eq!(error.status,Some(case.parse()?));}
                    else if case=="empty" && method=="GET" {assert_eq!(error.message,"Prediction not found");}
                    else {assert_eq!(error.message,"Internal server error");}
                }
                let requests=server.requests();
                let requests:Vec<_>=requests.iter().filter(|r|r.path()=="/helix/predictions").collect();
                assert_eq!(requests.len(),1,"{method} {case} must never retry");
                let r=requests[0];assert_helix_headers(r);assert_eq!(r.method,method);
                if method=="GET" {assert_eq!(r.target,"/helix/predictions?broadcaster_id=u1&id=p");assert!(r.body.is_empty());}
                else {
                    assert_eq!(r.target,"/helix/predictions");
                    let expected=if method=="POST"{json!({"broadcaster_id":"u1","title":"👋","outcomes":[{"title":"Yes"}],"prediction_window":30})}else{json!({"broadcaster_id":"u1","id":"p","status":"RESOLVED"})};
                    assert_eq!(serde_json::from_slice::<Value>(&r.body)?,expected);
                }
                process.twitch.shutdown().await;
            }
        }
        Ok(())
    }).await
}

fn short_process(
    stores: &Stores,
    server: &dima_http::testing::MockServer,
) -> Result<dima_twitch::Twitch> {
    use dima_core::{ManualClock, SecretString, Shutdown, SystemRandom};
    use dima_twitch::{Twitch, TwitchConfig, TwitchDeps};
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    config.keys = stores.keys.clone();
    config.timings = fast_timings();
    Ok(Twitch::new(
        config,
        TwitchDeps {
            http: dima_http::HttpClient::builder().build()?,
            exchange_http: dima_twitch::exchange_client(dima_http::HttpClient::builder())?,
            helix: server.provider(
                dima_twitch::helix_provider(CLIENT_ID)
                    .timeout(std::time::Duration::from_millis(40)),
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
async fn timeout_never_repeats_create_or_end() -> Result<()> {
    with_stores(|stores| async move {
        seed(&stores).await?;
        for create in [true, false] {
            let server = twitch_mock(Arc::new(Mutex::new(TwitchState::default())), |_, _| {
                MockResponse::json(200, &data(json!([prediction("p", "ACTIVE")])))
                    .delay(std::time::Duration::from_millis(150))
            })
            .await?;
            let twitch = short_process(&stores, &server)?;
            twitch.load_streamers().await?;
            let error = if create {
                create_prediction(&twitch, "u1", "title", &[], 30.0, false)
                    .await
                    .expect_err("timeout")
            } else {
                end_prediction(&twitch, "u1", "p", "RESOLVED", None)
                    .await
                    .expect_err("timeout")
            };
            assert_eq!(error.message, "Internal server error");
            assert_eq!(
                server
                    .requests()
                    .iter()
                    .filter(|r| r.path() == "/helix/predictions")
                    .count(),
                1
            );
            twitch.shutdown().await;
        }
        Ok(())
    })
    .await
}

#[test]
fn top_predictors_null_and_missing_stay_distinct() -> Result<()> {
    let missing: Outcome = serde_json::from_value(json!({"id":"o","title":"Yes"}))?;
    let null: Outcome =
        serde_json::from_value(json!({"id":"o","title":"Yes","top_predictors":null}))?;
    assert!(
        serde_json::to_value(missing)?
            .get("top_predictors")
            .is_none()
    );
    assert_eq!(serde_json::to_value(null)?["top_predictors"], Value::Null);
    Ok(())
}
