#![allow(clippy::expect_used)]
//! Pure matching corpus recorded from TypeScript, and game/search HTTP contracts.
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::functions::search::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::*;
#[test]
fn category_matching_typescript_corpus() -> Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("functions_category_fixture.json"))?;
    for c in cases {
        let q = c["query"].as_str().expect("query");
        let t = c["title"].as_str().expect("title");
        assert_eq!(json!(category_tokens(q)?), c["tokens"], "{q}");
        assert_eq!(json!(category_queries(q)?), c["queries"], "{q}");
        assert_eq!(json!(category_match_score(q, t)?), c["score"], "{q} {t}");
    }
    Ok(())
}
#[tokio::test]
async fn search_request_and_response_contracts() -> Result<()> {
    with_stores(|stores| async move {
        let reply=Arc::new(Mutex::new((200,json!({"data":[{"id":"1","name":"Mortal Shell II","box_art_url":""}]}).to_string())));
        let source=reply.clone();
        let server=twitch_mock(Arc::default(),move |_,_|{let (s,b)=source.lock().expect("reply").clone();MockResponse::json(s,&b)}).await?;
        let process=process(&stores,&server,fast_timings())?;
        for key in ["id","name","external_id"] {
            for (status,body,message) in [(200,r#"{"data":[{"id":"1","name":"Mortal Shell II","box_art_url":""}]}"#,"Game found"),(200,r#"{"data":[]}"#,"Game not found"),(401,r#"{"error":"Unauthorized","message":"denied","status":401}"#,"denied"),(500,r#"{"error":"Error","message":"later","status":500}"#,"later"),(200,"{","Internal server error")] {
                *reply.lock().expect("reply")=(status,body.into());
                let result=match key {"id"=>search_game_by_id(&process.twitch,"1").await,"name"=>search_game_by_name(&process.twitch,"1").await,_=>search_game_by_igdb_id(&process.twitch,"1").await};
                assert_eq!(result.message.as_deref(),Some(message));
                let request=server.requests().into_iter().last().expect("request");
                assert_eq!(request.method,"GET");assert_eq!(request.target,format!("/helix/games?{key}=1"));assert!(request.body.is_empty());assert_helix_headers(&request);
            }
        }
        *reply.lock().expect("reply")=(200,json!({"data":[{"id":"1","name":"Mortal Shell II","box_art_url":""}]}).to_string());
        let result=search_categories(&process.twitch,"mortal shell 2").await;
        assert_eq!(result.data.expect("data")[0].name,"Mortal Shell II");
        let request=server.requests().into_iter().last().expect("request");assert_eq!(request.target,"/helix/search/categories?query=mortal+shell+2&first=100");assert_helix_headers(&request);
        assert_eq!(search_categories(&process.twitch," ").await.status,Some(400));
        *reply.lock().expect("reply")=(200,json!({"data":[{"id":"1","name":"Dark Souls II: Deluxe","box_art_url":""},{"id":"2","name":"Dark Souls II: Remastered","box_art_url":""}]}).to_string());
        assert_eq!(search_categories(&process.twitch,"dark souls 2").await.kind.as_deref(),Some("ambiguous_game"));
        for (status,body,message) in [(200,r#"{"data":[]}"#,"No matching game found"),(401,r#"{"error":"Unauthorized","message":"denied","status":401}"#,"denied"),(503,r#"{"message":"later"}"#,"later"),(200,"{","Internal server error")] {
            *reply.lock().expect("reply")=(status,body.into());
            assert_eq!(search_categories(&process.twitch,"test").await.message.as_deref(),Some(message));
        }
        process.twitch.shutdown().await;
        Ok(())
    }).await
}

#[tokio::test]
async fn numeral_variants_base_search_deduplication_and_specific_titles() -> Result<()> {
    with_stores(|stores| async move {
        let mode=std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));let source=mode.clone();
        let server=twitch_mock(Default::default(),move |r,_| {
            let q=form(r.target.split_once('?').map_or("",|(_,q)|q)).into_iter().find(|(k,_)|k=="query").map(|(_,v)|v).unwrap_or_default();
            let names=match source.load(std::sync::atomic::Ordering::Relaxed) {
                0=>if q=="mortal shell ii" {vec!["Mortal Shell II"]}else{vec!["Mortal Shell"]},
                1=>if q=="dark souls" {vec!["Dark Souls","Dark Souls II","Dark Souls III: The Fire Fades Edition"]}else{vec![]},
                2=>vec!["Mortal Shell","Mortal Shell III"],
                3=>vec!["Mortal Shell II","Mortal Shell"],
                4=>vec!["Fortnite Festival","Fortnite"],
                5=>vec!["Dark Souls III: Deluxe"],
                _=>vec!["Unrelated Game"],
            };
            MockResponse::json(200,&json!({"data":names.iter().map(|n|json!({"id":n,"name":n,"box_art_url":""})).collect::<Vec<_>>()} ).to_string())
        }).await?;
        let process=process(&stores,&server,fast_timings())?;
        for (m,query,expected,requests) in [(0,"mortal shell 2",Some("Mortal Shell II"),2),(1,"dark souls 3",Some("Dark Souls III: The Fire Fades Edition"),3),(2,"mortal shell 2",None,3),(3,"mortal shell",Some("Mortal Shell"),1),(4,"fort",Some("Fortnite"),1),(5,"dark souls 3",Some("Dark Souls III: Deluxe"),3),(6,"mortal shell",None,1)] {
            mode.store(m,std::sync::atomic::Ordering::Relaxed);
            let before=server.requests().iter().filter(|r|r.path().starts_with("/helix/")).count();
            let result=search_categories(&process.twitch,query).await;
            assert!(!result.error,"{query}: {result:?}");
            assert_eq!(result.data.as_ref().and_then(|d|d.first()).map(|c|c.name.as_str()),expected);
            assert_eq!(server.requests().iter().filter(|r|r.path().starts_with("/helix/")).count()-before,requests);
        }
        process.twitch.shutdown().await;Ok(())
    }).await
}
