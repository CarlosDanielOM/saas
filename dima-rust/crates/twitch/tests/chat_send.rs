#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use dima_http::testing::MockResponse;
use dima_twitch::chat::{ChatError, RenderScope, Sent, send::*};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use support::*;
fn golden() -> Value {
    serde_json::from_str(include_str!("chat_golden.json")).expect("recorded JSON")
}
#[test]
fn node_splitter_and_mentions() {
    let fixture = golden();
    let rows = fixture["split"].as_array().expect("splitters");
    assert_eq!(rows.len(), 5168);
    assert_eq!(fixture["adjustedInputs"], 1960);
    assert_eq!(fixture["adjustedCuts"], 3065);
    for row in rows {
        let text = row["text"].as_str().expect("text");
        assert_eq!(json!(split_ai_response_for_twitch(text)), row["parts"]);
        let parts = split_message(text);
        assert!(parts.iter().all(|p| dima_text::utf16_len(p) <= 450));
        assert_eq!(parts.concat(), dima_text::trim(text));
        assert_eq!(
            json!(
                parts
                    .iter()
                    .map(|s| dima_text::utf16_len(s))
                    .collect::<Vec<_>>()
            ),
            row["budgetCuts"]
        );
    }
    for row in fixture["mentions"].as_array().expect("mentions") {
        assert_eq!(
            remove_ai_reply_recipient_tag(
                row["text"].as_str().expect("text"),
                row["user"].as_str().expect("user")
            ),
            row["result"]
        );
    }
}
#[test]
fn charter_boundary_difference_is_only_nearest_earlier_scalar() {
    // Node slice(0,450) divides this astral scalar into unpaired surrogates.
    // Rust ends at unit 449 and carries the intact scalar to the next part.
    for atom in ["🙂", "𐀀", "👨‍👩‍👧‍👦", "🇪🇸"] {
        let text = format!("{}{}tail", "a".repeat(449), atom);
        let parts = split_message(&text);
        assert_eq!(parts[0], "a".repeat(449));
        assert_eq!(parts[1], format!("{atom}tail"));
    }
}
#[tokio::test]
async fn recorded_plain_sends() -> Result<()> {
    with_stores(|stores| async move {
        let reply=Arc::new(Mutex::new((200,String::new(),false)));
        let source=reply.clone();
        let server=twitch_mock(Arc::default(),move |_,_| {
            let (status,body,delay)=source.lock().expect("reply").clone();
            let response=MockResponse::json(status,&body);
            if delay {response.delay(Duration::from_millis(200))} else {response}
        }).await?;
        let process=process(&stores,&server,fast_timings())?;
        for row in golden()["sends"].as_array().expect("sends") {
            let mode=&row["response"];
            if mode=="no-token" {continue;} // Separate credential failure below.
            let status=mode.as_u64().and_then(|n|u16::try_from(n).ok()).unwrap_or(if mode=="401-then-200" || mode=="401-twice" {401} else {200});
            let body=if status>=300 {json!({"error":"Denied","message":"fixture denied","status":status}).to_string()}
                else if mode=="malformed" {"{".into()}
                else if mode=="missing" {"{}".into()}
                else if mode=="empty-data" {"{\"data\":[]}".into()}
                else {json!({"data":[{"message_id":"msg","is_sent":mode!="drop","drop_reason":{"code":"automod","message":"held"}}]}).to_string()};
            *reply.lock().expect("reply")=(status,body,mode=="timeout");
            let mut scope=RenderScope::plain("123");
            scope.reply_to=row["reply"].as_str().map(str::to_owned);
            let before=server.requests().len();
            let result=send(&process.twitch,&scope,row["text"].as_str().expect("text"),&SendConfig{timeout:Duration::from_millis(50)}).await;
            let reference=&row["result"];
            assert_eq!(result.is_err(),reference["error"].as_bool().expect("error"),"{}: {result:?}",row["name"]);
            match result {
                Ok(Sent::Nothing)=>assert_eq!(reference["message"],"AST message delivered"),
                Ok(Sent::Posted{message_id})=>assert_eq!(json!(message_id),reference["data"].get("message_id").cloned().unwrap_or(Value::Null)),
                Err(ref error)=> {
                    assert_eq!(json!(error.status()),reference["status"]);
                    assert_eq!(json!(error.kind()),reference["type"]);
                    assert_eq!(json!(error.message()),reference["message"]);
                }
            }
            let requests:Vec<_>=server.requests().into_iter().skip(before).filter(|r|r.path()=="/helix/chat/messages").collect();
            let expected=row["requests"].as_array().expect("requests");
            assert_eq!(requests.len(),expected.len(),"never resend even a 401");
            for (request,expected) in requests.iter().zip(expected) {
                assert_eq!(request.method,expected["method"]);
                assert_eq!(request.target,expected["target"]);
                assert_helix_headers(request);
                assert!(request.header("authorization").expect("auth").starts_with("Bearer app-token-"));
                assert_eq!(serde_json::from_slice::<Value>(&request.body)?,expected["body"]);
            }
        }
        process.twitch.shutdown().await;
        Ok(())
    }).await
}
#[tokio::test]
async fn absent_app_token() -> Result<()> {
    with_stores(|stores| async move {
        let server = dima_http::testing::MockServer::start().await?;
        server.fallback(|_| MockResponse::json(400, r#"{"error":"invalid_client"}"#));
        let process = process(&stores, &server, fast_timings())?;
        assert_eq!(
            send(
                &process.twitch,
                &RenderScope::plain("123"),
                "text",
                &SendConfig::default()
            )
            .await,
            Err(ChatError::NoAppToken)
        );
        assert!(
            server
                .requests()
                .iter()
                .all(|r| r.path() != "/helix/chat/messages")
        );
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn split_send_stops_on_middle_failure_without_replaying() -> Result<()> {
    with_stores(|stores| async move {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = attempts.clone();
        let server = twitch_mock(Arc::default(), move |_, _| {
            let n = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 1 {
                MockResponse::json(503, r#"{"error":"Unavailable","message":"failed"}"#)
            } else {
                MockResponse::json(200, r#"{"data":[{"is_sent":true,"message_id":"first"}]}"#)
            }
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        let result = send_split(
            &process.twitch,
            &RenderScope::plain("123").replying_to("parent"),
            &"x".repeat(2000),
            &SendConfig::default(),
        )
        .await;
        assert!(matches!(
            result,
            Err(ChatError::Rejected { status: 503, .. })
        ));
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        let messages: Vec<_> = server
            .requests()
            .into_iter()
            .filter(|r| r.path() == "/helix/chat/messages")
            .collect();
        let first: Value = serde_json::from_slice(&messages[0].body)?;
        let second: Value = serde_json::from_slice(&messages[1].body)?;
        assert_eq!(first["reply_parent_message_id"], "parent");
        assert!(second.get("reply_parent_message_id").is_none());
        assert_eq!(first["message"], "x".repeat(450));
        assert_eq!(second["message"], "x".repeat(450));
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}
