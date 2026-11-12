#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
use dima_http::testing::{MockResponse, MockServer};
#[tokio::test]
async fn sdk_wire_recordings() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!("requests.json")).unwrap();
    let server = MockServer::start().await.unwrap();
    let mut cfg = Config::new(server.url());
    cfg.api_key = Some(dima_core::SecretString::from("test-only"));
    let client = Client::new(
        HttpClient::builder().build().unwrap(),
        Some(cfg.provider().unwrap()),
    );
    for expected in fixture {
        server.push(MockResponse::json(200, r#"{"result":true}"#));
        let target = expected["target"].as_str().unwrap();
        let (path, q) = target.split_once('?').unwrap_or((target, ""));
        let path = match path {
            "/collections" => Path::from("/collections"),
            p if p.ends_with("/exists") => {
                Client::path("/collections/{}/exists", "twitch_chat_logs").unwrap()
            }
            p if p.ends_with("/index") => {
                Client::path("/collections/{}/index", "twitch_chat_logs").unwrap()
            }
            p if p.ends_with("/query") => {
                Client::path("/collections/{}/points/query", "twitch_chat_logs").unwrap()
            }
            p if p.ends_with("/scroll") => {
                Client::path("/collections/{}/points/scroll", "twitch_chat_logs").unwrap()
            }
            p if p.ends_with("/delete") => {
                Client::path("/collections/{}/points/delete", "twitch_channel_memories").unwrap()
            }
            p if p.ends_with("/points") => Client::path(
                "/collections/{}/points",
                if p.contains("memories") {
                    "twitch_channel_memories"
                } else {
                    "twitch_chat_logs"
                },
            )
            .unwrap(),
            _ => Client::path("/collections/{}", "twitch_chat_logs").unwrap(),
        };
        client
            .call(
                expected["method"].as_str().unwrap().parse().unwrap(),
                path,
                (!expected["body"].is_null()).then_some(&expected["body"]),
                if q.is_empty() {
                    None
                } else {
                    Some(q == "wait=true")
                },
            )
            .await
            .unwrap();
        let r = server.requests().last().unwrap().clone();
        assert_eq!(r.target, target);
        assert_eq!(r.method, expected["method"]);
        // Host/connection/compression/user-agent/fetch metadata are transport noise.
        // All SDK headers are recorded, but contract headers must match.
        assert_eq!(r.header("accept"), expected["headers"]["accept"].as_str());
        assert_eq!(
            r.header("api-key").is_some(),
            expected["headers"]["api-key"].as_bool().unwrap()
        );
        assert_eq!(
            r.header("content-type"),
            expected["headers"]["content-type"].as_str()
        );
        assert_eq!(
            if r.body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&r.body).unwrap()
            },
            expected["body"]
        );
    }
}
#[tokio::test]
async fn failures_are_typed_empty_results() {
    for status in [404, 409, 500] {
        let s = MockServer::start().await.unwrap();
        s.push(MockResponse::json(200, r#"{"result":{"collections":[]}}"#));
        s.push(MockResponse::json(
            status,
            r#"{"status":{"error":"fixture"}}"#,
        ));
        let c = Client::new(
            HttpClient::builder().build().unwrap(),
            Some(Config::new(s.url()).provider().unwrap()),
        );
        let r = c
            .retrieve_semantic_chat_context(
                &SemanticChatContextParams {
                    channel_id: "c".into(),
                    query: "test".into(),
                    limit: 3,
                    primary_min_score: None,
                    fallback_min_score: None,
                },
                &[1., 0., 0.],
            )
            .await;
        assert!(r.error);
        assert!(r.items.is_empty());
        assert!(r.pass_results.is_empty());
    }
    for response in [
        MockResponse::json(200, "not json"),
        MockResponse::json(200, "{}"),
        MockResponse::json(200, r#"{"result":null}"#),
        MockResponse::json(200, r#"{"result":true}"#).delay(Duration::from_millis(100)),
    ] {
        let s = MockServer::start().await.unwrap();
        s.push(response);
        let mut cfg = Config::new(s.url());
        cfg.timeout = Duration::from_millis(20);
        let c = Client::new(
            HttpClient::builder().build().unwrap(),
            Some(cfg.provider().unwrap()),
        );
        assert!(c.get_collections().await.is_err());
    }
    let c = Client::new(HttpClient::builder().build().unwrap(), None);
    assert!(matches!(
        c.get_collections().await,
        Err(Error::NotConfigured)
    ));
}

#[tokio::test]
async fn operations_build_reference_requests_and_paginate() {
    let s = MockServer::start().await.unwrap();
    let c = Client::new(
        HttpClient::builder().build().unwrap(),
        Some(Config::new(s.url()).provider().unwrap()),
    );
    s.push(MockResponse::json(200, r#"{"result":{"collections":[]}}"#));
    s.push(MockResponse::json(200, r#"{"result":{"exists":false}}"#));
    s.push(MockResponse::json(200, r#"{"result":true}"#));
    for _ in 0..8 {
        s.push(MockResponse::json(200, r#"{"result":true}"#));
    }
    let r = c.create_collection(&twitch_chat_logs_collection()).await;
    assert_eq!(r.status, 200);
    let requests = s.requests();
    assert_eq!(requests.len(), 11);
    let fixture: Vec<Value> = serde_json::from_str(include_str!("requests.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[2].body).unwrap(),
        fixture[2]["body"]
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[4].body).unwrap(),
        fixture[3]["body"]
    );
    s.push(MockResponse::json(200, r#"{"result":true}"#));
    let d = ChatMessageData {
        channel_id: "c".into(),
        channel_name: None,
        username: "u".into(),
        user_id: "u".into(),
        message: "hello".into(),
        timestamp: 12.,
        language: "en".into(),
    };
    assert!(
        !c.store_chat_message_embedding(&d, &[1., 0., 0.])
            .await
            .error
    );
    let requests = s.requests();
    let r = requests.last().unwrap();
    assert_eq!(r.target, "/collections/twitch_chat_logs/points?wait=false");
    let b: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(
        b["points"][0]["payload"],
        serde_json::from_slice::<Value>(&dima_text::to_js_json_from(&d).unwrap()).unwrap()
    );
    assert_eq!(
        b["points"][0]["id"],
        generate_qdrant_point_id("c", "u", 12.)
    );
    s.push(MockResponse::json(
        200,
        r#"{"result":{"points":[],"next_page_offset":42}}"#,
    ));
    s.push(MockResponse::json(200,r#"{"result":{"points":[{"payload":{"channel_id":"c","message":"hello","timestamp":12}}],"next_page_offset":null}}"#));
    let w = c
        .retrieve_channel_chat_window(&ChatWindowParams {
            channel_id: "c".into(),
            from_unix: 1.,
            to_unix: 20.,
            limit: 120.,
        })
        .await;
    assert!(!w.error);
    assert_eq!(w.items.len(), 1);
    let requests = s.requests();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[12].body).unwrap(),
        fixture[13]["body"]
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[13].body).unwrap(),
        fixture[14]["body"]
    );
    s.push(MockResponse::json(200, r#"{"result":{"points":[]}}"#));
    s.push(MockResponse::json(200,r#"{"result":{"points":[{"score":0.7,"payload":{"channel_id":"c","message":"fallback","timestamp":10}}]}}"#));
    let r = c
        .retrieve_semantic_chat_context(
            &SemanticChatContextParams {
                channel_id: "c".into(),
                query: "test".into(),
                limit: 3,
                primary_min_score: None,
                fallback_min_score: None,
            },
            &[1., 0., 0.],
        )
        .await;
    assert_eq!(r.selected_pass, SemanticPass::Fallback);
    assert_eq!(r.pass_results.len(), 2);
    let requests = s.requests();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[14].body).unwrap(),
        fixture[12]["body"]
    );
}

#[tokio::test]
async fn memory_requests_omit_missing_fields_and_preserve_filters() {
    let s = MockServer::start().await.unwrap();
    let c = Client::new(
        HttpClient::builder().build().unwrap(),
        Some(Config::new(s.url()).provider().unwrap()),
    );
    for answer in [r#"{"collections":[]}"#, "[]", r#"{"status":"completed"}"#] {
        s.push(MockResponse::json(200, &format!("{{\"result\":{answer}}}")));
    }
    let p = UpsertChannelMemoryParams {
        qdrant_point_id: 42.,
        memory_id: "m".into(),
        channel_id: "c".into(),
        content: "hello".into(),
        summary: "summary".into(),
        ..Default::default()
    };
    assert!(
        !c.upsert_channel_memory_embedding(&p, &[1., 0., 0.])
            .await
            .error
    );
    let requests = s.requests();
    let fixture: Vec<Value> = serde_json::from_str(include_str!("requests.json")).unwrap();
    assert_eq!(requests[1].target, fixture[9]["target"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[1].body).unwrap(),
        fixture[9]["body"]
    );
    assert_eq!(
        requests[2].target,
        "/collections/twitch_channel_memories/points?wait=true"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[2].body).unwrap(),
        json!({"points":[{"id":42,"vector":[1,0,0],"payload":{"memory_id":"m","channel_id":"c","content":"hello","summary":"summary","subject_username":"","subject_user_id":""}}]})
    );
    s.push(MockResponse::json(200, r#"{"result":{"points":[]}}"#));
    let r = c
        .retrieve_channel_memory_context(
            &RetrieveMemoryContextParams {
                channel_id: "c".into(),
                query: "hello".into(),
                limit: 3,
                min_score: None,
                mode: MemoryRetrievalMode::Passive,
                subject_scope: MemorySubjectScope::Channel,
            },
            &[1., 0., 0.],
        )
        .await;
    assert!(!r.error);
    let requests = s.requests();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[3].body).unwrap(),
        json!({"query":[1,0,0],"limit":24,"with_payload":true,"filter":{"must":[{"key":"channel_id","match":{"value":"c"}},{"key":"status","match":{"value":"confirmed"}},{"key":"subject_scope","match":{"value":"channel"}}]},"score_threshold":0.45})
    );
    s.push(MockResponse::json(200, r#"{"result":true}"#));
    assert!(
        !c.delete_channel_memory_embeddings_by_channel("c")
            .await
            .error
    );
    let requests = s.requests();
    assert_eq!(requests[4].target, fixture[11]["target"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[4].body).unwrap(),
        fixture[11]["body"]
    );
}
#[tokio::test]
async fn collection_conflicts_are_not_silently_accepted() {
    for answer in [
        MockResponse::json(200, r#"{"result":{"exists":true}}"#),
        MockResponse::json(404, "{}"),
        MockResponse::json(409, "{}"),
    ] {
        let s = MockServer::start().await.unwrap();
        s.push(MockResponse::json(200, r#"{"result":{"collections":[]}}"#));
        s.push(answer);
        let c = Client::new(
            HttpClient::builder().build().unwrap(),
            Some(Config::new(s.url()).provider().unwrap()),
        );
        let r = c.create_collection(&twitch_chat_logs_collection()).await;
        assert!(r.error);
        assert!([409, 500].contains(&r.status));
    }
}

#[tokio::test]
async fn create_race_409_is_a_creation_failure() {
    let s = MockServer::start().await.unwrap();
    s.push(MockResponse::json(200, r#"{"result":{"collections":[]}}"#));
    s.push(MockResponse::json(200, r#"{"result":{"exists":false}}"#));
    s.push(MockResponse::json(409, r#"{"status":{"error":"exists"}}"#));
    let c = Client::new(
        HttpClient::builder().build().unwrap(),
        Some(Config::new(s.url()).provider().unwrap()),
    );
    let r = c.create_collection(&twitch_chat_logs_collection()).await;
    assert!(r.error);
    assert_eq!(r.status, 500); // Reference catches the HTTP conflict as a generic creation failure.
    assert_eq!(s.requests().len(), 3);
}
