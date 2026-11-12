//! Channel mutations: request contract and single-send failure behavior.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::functions::channels::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
#[test]
fn normalizes_each_helix_editor_exactly_once() {
    let result = normalize_editors(vec![
        Editor {
            user_id: "1".into(),
            user_login: "first".into(),
            user_name: "FirstEditor".into(),
        },
        Editor {
            user_id: "2".into(),
            user_login: "second".into(),
            user_name: "SecondEditor".into(),
        },
    ]);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].user_login, "firsteditor");
    assert_eq!(result[1].user_login, "secondeditor");
}
#[tokio::test]
async fn actions_send_once_and_keep_reference_messages() -> Result<()> {
    with_stores(|stores|async move {
        insert_user(&stores,user_document("u1","streamer","access","refresh",Some(NOW_MS/1000+3600))).await?;
        for operation in ["add","remove","set","unraid"] {
            for code in [204,401,403,500] {
                let server=twitch_mock(Arc::new(Mutex::new(TwitchState::default())),move |_,_|if code==204 {MockResponse::new(204)} else {MockResponse::json(code,&json!({"error":"Failure","message":"reference message","status":code}).to_string())}).await?;
                let process=process(&stores,&server,fast_timings())?;process.twitch.load_streamers().await?;
                let result=match operation {
                    "add"=>add_channel_vip(&process.twitch,"u1","victim").await,
                    "remove"=>remove_channel_vip(&process.twitch,"u1","victim").await,
                    "set"=>set_channel_information(&process.twitch,"u1",ChannelInformation{title:Some("👋 العربية".into()),..Default::default()}).await,
                    _=>unraid(&process.twitch,"u1").await,
                };
                if code==204 {let result=result?;assert!(!result.error);assert_eq!(result.status,if operation=="unraid"{None}else{Some(200)});} else {let error=result.expect_err("HTTP failure");assert_eq!(error.message,"reference message");assert_eq!(error.status,if operation=="unraid"{None}else{Some(code)});}
                let requests=server.requests();let requests:Vec<_>=requests.iter().filter(|r|r.path().starts_with("/helix/")).collect();assert_eq!(requests.len(),1);
                let r=requests[0];assert_helix_headers(r);
                assert_eq!(r.method,match operation {"add"=>"POST","set"=>"PATCH",_=>"DELETE"});
                assert_eq!(r.target,match operation {"add"|"remove"=>"/helix/channels/vips?user_id=victim&broadcaster_id=u1","set"=>"/helix/channels?broadcaster_id=u1",_=>"/helix/raids?broadcaster_id=u1"});
                if operation=="set" {assert_eq!(serde_json::from_slice::<Value>(&r.body)?,json!({"title":"👋 العربية"}));}else{assert!(r.body.is_empty());}
                process.twitch.shutdown().await;
            }
        }
        Ok(())
    }).await
}

#[tokio::test]
async fn reads_use_correct_tokens_queries_defaults_and_cache() -> Result<()> {
    with_stores(|stores| async move {
        insert_user(
            &stores,
            user_document(
                "u1",
                "streamer",
                "access",
                "refresh",
                Some(NOW_MS / 1000 + 3600),
            ),
        )
        .await?;
        let server = twitch_mock(
            Arc::new(Mutex::new(TwitchState::default())),
            |r, _| match r.path() {
                "/helix/channels" => MockResponse::json(200, "{\"data\":[{\"title\":\"Title\"}]}"),
                "/helix/channels/editors" => MockResponse::json(
                    200,
                    "{\"data\":[{\"user_id\":\"e\",\"user_name\":\"Editor\"}]}",
                ),
                "/helix/channels/followers" => MockResponse::json(200, "{}"),
                "/helix/subscriptions" => {
                    MockResponse::json(200, "{\"data\":[],\"total\":0,\"points\":0}")
                }
                "/helix/streams" => MockResponse::json(200, "{\"data\":[]}"),
                "/helix/raids" => {
                    MockResponse::json(400, "{\"error\":\"Bad Request\",\"message\":\"raw\"}")
                }
                _ => MockResponse::new(500),
            },
        )
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        assert_eq!(
            get_channel_information(&process.twitch, "u1", true)
                .await?
                .data,
            Some(json!({"title":"Title"}))
        );
        assert_eq!(
            get_channel_information(&process.twitch, "u1", false)
                .await?
                .data,
            Some(json!({"title":"Title"}))
        );
        let editors = get_channel_editors(&process.twitch, "u1", true).await?;
        assert_eq!(editors.editors[0].user_login, "editor");
        let members: Vec<String> = stores
            .dragonfly
            .query(redis::cmd("SMEMBERS").arg(format!("{}twitch:u1:editors", stores.keys.prefix())))
            .await?;
        assert_eq!(members, ["editor"]);
        assert_eq!(
            get_twitch_followers(&process.twitch, "u1", Some("ignored"))
                .await?
                .total,
            0.0
        );
        assert_eq!(
            get_channel_subscriptions(&process.twitch, "u1")
                .await?
                .points,
            Some(0.0)
        );
        assert!(is_live(&process.twitch, "u1").await?.is_empty());
        assert!(live_channels(&process.twitch).await?.is_empty());
        assert_eq!(
            raid(&process.twitch, "u1", "target").await?,
            json!({"error":"Bad Request","message":"raw"})
        );
        let requests = server.requests();
        let requests: Vec<_> = requests
            .iter()
            .filter(|r| r.path().starts_with("/helix/"))
            .collect();
        assert_eq!(requests.len(), 7);
        for r in &requests {
            assert_helix_headers(r);
            assert!(r.body.is_empty());
        }
        let targets: Vec<_> = requests.iter().map(|r| r.target.as_str()).collect();
        assert_eq!(
            targets,
            [
                "/helix/channels?broadcaster_id=u1",
                "/helix/channels/editors?broadcaster_id=u1",
                "/helix/channels/followers?broadcaster_id=u1",
                "/helix/subscriptions?broadcaster_id=u1",
                "/helix/streams?user_id=u1",
                "/helix/streams?type=live&user_id=u1",
                "/helix/raids?from_broadcaster_id=u1&to_broadcaster_id=target"
            ]
        );
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}

struct Lookup;
impl ModeratorUserLookup for Lookup {
    fn lookup<'a>(
        &'a self,
        _twitch: &'a dima_twitch::Twitch,
        user: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Option<dima_twitch::functions::moderation::moderators::Moderator>,
    > {
        Box::pin(async move {
            Some(dima_twitch::functions::moderation::moderators::Moderator {
                user_id: user.into(),
                user_login: "newmod".into(),
                user_name: "NewMod".into(),
            })
        })
    }
}
#[tokio::test]
async fn moderator_changes_update_existing_cache_and_use_broadcaster_identity() -> Result<()> {
    with_stores(|stores| async move {
        insert_user(
            &stores,
            user_document(
                "u1",
                "streamer",
                "access",
                "refresh",
                Some(NOW_MS / 1000 + 3600),
            ),
        )
        .await?;
        let server = twitch_mock(Arc::new(Mutex::new(TwitchState::default())), |r, _| {
            if r.method == "GET" {
                MockResponse::json(200, "{\"data\":[]}")
            } else {
                MockResponse::new(204)
            }
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        dima_twitch::functions::moderation::get_channel_moderators(
            &process.twitch,
            "u1",
            &[],
            true,
        )
        .await?;
        assert_eq!(
            add_moderator(&process.twitch, "u1", Some("victim"), &Lookup)
                .await?
                .message,
            "Success"
        );
        let key = format!("{}twitch:u1:moderators", stores.keys.prefix());
        let cached: Value =
            serde_json::from_slice(&stores.dragonfly.get(&key).await?.expect("cache"))?;
        assert_eq!(cached["ids"], json!(["victim"]));
        assert_eq!(cached["logins"], json!(["newmod"]));
        assert_eq!(cached["displayNames"], json!(["NewMod"]));
        let cancel = tokio_util::sync::CancellationToken::new();
        assert_eq!(
            remove_channel_moderator(&process.twitch, "u1", "victim", &cancel)
                .await?
                .kind,
            "success"
        );
        let cached: Value =
            serde_json::from_slice(&stores.dragonfly.get(&key).await?.expect("cache"))?;
        assert_eq!(cached["data"], json!([]));
        assert_eq!(cached["ids"], json!([]));
        assert_eq!(cached["logins"], json!([]));
        assert_eq!(cached["displayNames"], json!([]));
        for family in ["ids", "logins", "mapping"] {
            assert_eq!(
                stores
                    .dragonfly
                    .exists(&[&format!("{key}:{family}")])
                    .await?,
                0
            );
        }
        let requests = server.requests();
        let requests: Vec<_> = requests
            .iter()
            .filter(|r| r.path().starts_with("/helix/"))
            .collect();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[1].method, "POST");
        assert_eq!(requests[2].method, "DELETE");
        for r in requests.iter().skip(1) {
            assert_eq!(
                r.target,
                "/helix/moderation/moderators?broadcaster_id=u1&user_id=victim"
            );
            assert_helix_headers(r);
            assert!(r.body.is_empty());
        }
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}
