//! Reference ban header cases and bot-owned moderation request assertions.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_http::{HeaderMap, HeaderValue};
use dima_twitch::{TWITCH_BOT_ACCOUNT_ID, functions::moderation::*};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
use tokio_util::sync::CancellationToken;
#[test]
fn reads_twitch_reset_remaining_and_both_retry_after_formats() {
    let mut headers = HeaderMap::new();
    headers.insert("ratelimit-reset", HeaderValue::from_static("123"));
    headers.insert("ratelimit-remaining", HeaderValue::from_static("0"));
    headers.insert("retry-after", HeaderValue::from_static("5"));
    assert_eq!(
        ban_rate_limit_headers(&headers, 1000),
        BanRateLimits {
            remaining: Some(0.0),
            reset_at: Some(123000.0),
            retry_after: Some(5000.0)
        }
    );
    headers.insert(
        "retry-after",
        HeaderValue::from_static("Thu, 01 Jan 1970 00:01:00 GMT"),
    );
    assert_eq!(
        ban_rate_limit_headers(&headers, 1000).retry_after,
        Some(59000.0)
    );
    assert_eq!(
        ban_rate_limit_headers(&HeaderMap::new(), 0),
        BanRateLimits::default()
    );
}
#[tokio::test]
async fn ban_and_warn_use_bot_identity_and_never_repeat_5xx() -> Result<()> {
    with_stores(|stores|async move{
        insert_user(&stores,user_document(TWITCH_BOT_ACCOUNT_ID,"bot","access","refresh",Some(NOW_MS/1000+3600))).await?;
        for warning in [false,true]{for code in [200,401,403,429,500]{
            let server=twitch_mock(Arc::new(Mutex::new(TwitchState::default())),move |_,_|MockResponse::json(code,if code==200 {"{\"data\":[]}"}else{"{\"error\":\"Failure\",\"message\":\"reference message\"}"})).await?;
            let process=process(&stores,&server,fast_timings())?;process.twitch.load_streamers().await?;
            let cancel=CancellationToken::new();
            let result=if warning {warn_user(&process.twitch,"broadcaster","victim","reason👋").await}else{ban(&process.twitch,"broadcaster","victim",TWITCH_BOT_ACCOUNT_ID,Some(30.0),Some("reason👋"),&cancel).await};
            if code==200 {assert_eq!(result?.message,if warning {"Warning issued"}else{"Success"});}else{let e=result.expect_err("failure");assert_eq!(e.failure.status,Some(code));assert_eq!(e.failure.message,"reference message");}
            let requests=server.requests();let requests:Vec<_>=requests.iter().filter(|r|r.path().starts_with("/helix/")).collect();assert_eq!(requests.len(),1);let r=requests[0];assert_helix_headers(r);assert_eq!(r.method,"POST");
            assert_eq!(r.target,format!("/helix/moderation/{}?broadcaster_id=broadcaster&moderator_id={TWITCH_BOT_ACCOUNT_ID}",if warning {"warnings"}else{"bans"}));
            assert_eq!(serde_json::from_slice::<Value>(&r.body)?,if warning {json!({"data":{"user_id":"victim","reason":"reason👋"}})}else{json!({"data":{"user_id":"victim","duration":30,"reason":"reason👋"}})});
            cancel.cancel();let error=ban(&process.twitch,"broadcaster","victim",TWITCH_BOT_ACCOUNT_ID,None,None,&cancel).await.expect_err("cancelled");assert_eq!(error.failure.message,"Internal server error");assert_eq!(server.requests().iter().filter(|r|r.path().starts_with("/helix/")).count(),1);
            process.twitch.shutdown().await;
        }}
        Ok(())
    }).await
}

#[tokio::test]
async fn moderator_cache_sets_mapping_and_membership_match_reference() -> Result<()> {
    with_stores(|stores|async move {
        insert_user(&stores,user_document("u1","streamer","access","refresh",Some(NOW_MS/1000+3600))).await?;
        let server=twitch_mock(Arc::new(Mutex::new(TwitchState::default())),|_,_|MockResponse::json(200,"{\"data\":[{\"user_id\":\"mod\",\"user_login\":\"moderator\",\"user_name\":\"Moderator\"}]}")).await?;
        let process=process(&stores,&server,fast_timings())?;process.twitch.load_streamers().await?;
        let result=get_channel_moderators(&process.twitch,"u1",&["mod".into()],true).await?;
        assert_eq!(result.ids,["mod"]);assert_eq!(result.logins,["moderator"]);assert_eq!(result.display_names,["Moderator"]);
        let key=format!("{}twitch:u1:moderators",stores.keys.prefix());
        let stored:Value=serde_json::from_slice(&stores.dragonfly.get(&key).await?.expect("json cache"))?;
        assert_eq!(stored,json!({"error":false,"message":"Success","data":[{"user_id":"mod","user_login":"moderator","user_name":"Moderator"}],"ids":["mod"],"logins":["moderator"],"displayNames":["Moderator"]}));
        for suffix in ["","ids","logins","mapping"] {
            let key=if suffix.is_empty(){key.clone()}else{format!("{key}:{suffix}")};let ttl:i64=stores.dragonfly.query(redis::cmd("TTL").arg(&key)).await?;assert!((7190..=7200).contains(&ttl));
        }
        let mapping:std::collections::HashMap<String,String>=stores.dragonfly.query(redis::cmd("HGETALL").arg(format!("{key}:mapping"))).await?;
        assert_eq!(mapping.get("moderator").map(String::as_str),Some("mod"));
        assert!(is_twitch_moderator_by_id(&process.twitch,"u1","mod",false).await?.is_moderator);
        assert!(!is_twitch_moderator_by_id(&process.twitch,"u1","other",false).await?.is_moderator);
        assert!(is_twitch_moderator_by_login(&process.twitch,"u1","moderator",false).await?.is_moderator);
        assert!(!is_twitch_moderator_by_login(&process.twitch,"u1","Moderator",false).await?.is_moderator);
        assert_eq!(get_twitch_moderators_ids(&process.twitch,"u1",false).await?.message,"Success (from cache)");
        assert_eq!(get_channel_moderators(&process.twitch,"u1",&[],true).await?.message,"Success (from cache)");
        let requests=server.requests();let requests:Vec<_>=requests.iter().filter(|r|r.path().starts_with("/helix/")).collect();assert_eq!(requests.len(),1);assert_helix_headers(requests[0]);assert_eq!(requests[0].method,"GET");assert_eq!(requests[0].target,"/helix/moderation/moderators?broadcaster_id=u1&user_id=mod");assert!(requests[0].body.is_empty());
        process.twitch.shutdown().await;Ok(())
    }).await
}
