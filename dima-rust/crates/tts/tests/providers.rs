#![allow(clippy::unwrap_used)]
use dima_core::{SecretString, Shutdown};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use dima_tts::providers::*;
use serde_json::{Value, json};
use std::time::Duration;
async fn setup() -> (MockServer, Clients, Request) {
    let server = MockServer::start().await.unwrap();
    let config = Config {
        openrouter_key: Some(SecretString::from("test-only")),
        fish_key: Some(SecretString::from("test-only")),
        piper_url: "http://127.0.0.1:9999".into(),
    };
    let clients = Clients {
        http: HttpClient::builder().build().unwrap(),
        openrouter: server.provider(config.openrouter()).unwrap(),
        fish: server.provider(config.fish()).unwrap(),
        piper: server.provider(config.piper()).unwrap(),
        config,
    };
    let request = Request {
        channel_id: "channel".into(),
        text: "[happy] hello 😀".into(),
        voice: "af_heart".into(),
        max_audio_bytes: 100,
        single_attempt: false,
        private_output: false,
        cancel: Shutdown::new(),
    };
    (server, clients, request)
}
fn audio() -> MockResponse {
    MockResponse::new(200)
        .header("content-type", "audio/mpeg")
        .body("ID3audio")
}
#[tokio::test]
async fn requests_match_ledger() {
    let (s, c, mut r) = setup().await;
    s.push(audio());
    assert_eq!(
        c.kokoro(&r).await.unwrap().bytes().await.unwrap(),
        "ID3audio"
    );
    let req = s.requests().pop().unwrap();
    assert_eq!(req.method, "POST");
    assert_eq!(req.target, "/api/v1/audio/speech");
    assert!(req.header("authorization").is_some());
    assert_eq!(req.header("http-referer"), Some("https://domdimabot.com"));
    assert_eq!(req.header("x-openrouter-title"), Some("DomDimaBot"));
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(
        body,
        json!({"model":KOKORO_MODEL,"input":r.text,"voice":"af_heart","response_format":"mp3","user":"channel","provider":{"only":["deepinfra"],"order":["deepinfra"],"allow_fallbacks":false}})
    );
    r.voice = "b".repeat(32);
    s.push(audio());
    c.fish_primary(&r).await.unwrap().bytes().await.unwrap();
    let req = s.requests().pop().unwrap();
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(
        body,
        json!({"model":FISH_MODEL,"input":r.text,"voice":r.voice,"response_format":"mp3","user":"channel"})
    );
    s.push(audio());
    c.fish_direct(&r).await.unwrap().bytes().await.unwrap();
    let req = s.requests().pop().unwrap();
    assert_eq!(req.target, "/v1/tts");
    assert_eq!(req.header("model"), Some("s2.1-pro"));
    assert_eq!(req.header("content-type"), Some("application/msgpack"));
    assert!(req.header("authorization").is_some());
    assert_eq!(req.body[0], 0x83);
    assert!(
        req.body
            .windows("[happy] [happy]".len())
            .any(|w| w == b"[happy] [happy]")
    );
    s.push(MockResponse::new(200).body("wav"));
    assert_eq!(c.piper(&r).await.unwrap().bytes().await.unwrap(), "wav");
    let req = s.requests().pop().unwrap();
    assert_eq!(req.target, "/synthesize");
    assert_eq!(req.header("authorization"), None);
    assert_eq!(
        serde_json::from_slice::<Value>(&req.body).unwrap(),
        json!({"text":r.text,"voice":r.voice})
    );
}
#[tokio::test]
async fn provider_failures_and_fish_fallback() {
    for failure in [
        MockResponse::new(503),
        MockResponse::json(200, "{}"),
        MockResponse::new(200).header("content-type", "audio/mpeg"),
        audio().drop_after(2),
        audio().body("x".repeat(101)),
    ] {
        let (s, c, r) = setup().await;
        s.push(failure);
        assert!(match c.kokoro(&r).await {
            Ok(a) => a.bytes().await.is_err(),
            Err(_) => true,
        });
    }
    let (s, c, r) = setup().await;
    s.push(MockResponse::new(503));
    s.push(audio());
    assert!(c.synthesize_buffered(&r, "fish").await.is_ok());
    assert_eq!(s.requests().len(), 2);
    let (s, c, mut r) = setup().await;
    r.single_attempt = true;
    s.push(MockResponse::new(503));
    assert!(c.synthesize_buffered(&r, "fish").await.is_err());
    assert_eq!(s.requests().len(), 1);
    let (s, c, r) = setup().await;
    s.push(MockResponse::new(400).body("piper failure"));
    let result = c.piper(&r).await;
    assert!(matches!(result,Err(Error::Message(ref text)) if text=="piper failure"));
    let (s, c, mut r) = setup().await;
    r.voice = "gojo".into();
    assert!(c.kokoro(&r).await.is_err());
    assert!(s.requests().is_empty());
}
#[tokio::test]
async fn body_timeout_and_cancellation() {
    let (s, c, r) = setup().await;
    s.push(audio().stall_after_headers());
    let mut a = c.kokoro(&r).await.unwrap();
    r.cancel.trigger();
    assert!(a.chunk().await.is_err());
    let (s, mut c, r) = setup().await;
    c.openrouter = s
        .provider(c.config.openrouter().timeout(Duration::from_millis(15)))
        .unwrap();
    // Total timeout is the fixed reference's 20s; a caller deadline can shorten it.
    s.push(audio().delay(Duration::from_secs(1)));
    assert!(
        dima_tts::deadline::with_timeout(c.kokoro(&r), Duration::from_millis(20), "deadline")
            .await
            .is_err()
    );
}
#[tokio::test]
async fn catalog_cache_and_errors() {
    let (s, c, _) = setup().await;
    let clock = std::sync::Arc::new(dima_core::ManualClock::new(0));
    let catalog = dima_tts::catalog::Catalog::new(c, clock.clone());
    let id = "a".repeat(32);
    let raw = json!({"_id":id,"title":"Voice","type":"tts","visibility":"public"});
    s.push(MockResponse::json(200, &raw.to_string()));
    assert!(catalog.voice(&id).await.is_ok());
    assert!(catalog.voice(&id).await.is_ok());
    assert_eq!(s.requests().len(), 1);
    assert_eq!(s.requests()[0].target, format!("/model/{id}"));
    assert!(s.requests()[0].header("authorization").is_some());
    clock.advance(60000);
    s.push(MockResponse::new(404));
    assert_eq!(
        catalog.voice(&id).await.unwrap_err().code,
        "voice_unavailable"
    );
    s.push(MockResponse::json(200, "{\"items\":[],\"has_more\":false}"));
    let search = dima_tts::catalog::parse_search(
        &json!({"name":" hi ","gender":"female","language":"en","license":"licensed","page":"2"}),
    )
    .unwrap();
    catalog.search(&search).await.unwrap();
    assert_eq!(
        s.requests().last().unwrap().target,
        "/model?page_size=20&page_number=2&sort_by=score&title=hi&tag=female&language=en&licensed=true"
    );
}

#[tokio::test]
async fn each_provider_bounds_and_rejects_truncated_audio() {
    for provider in ["piper", "kokoro", "fish"] {
        for failure in [
            audio().drop_after(2),
            audio().body("x".repeat(101)),
            MockResponse::new(422),
        ] {
            let (s, c, mut r) = setup().await;
            r.single_attempt = true;
            s.push(failure);
            assert!(
                c.synthesize_buffered(&r, provider).await.is_err(),
                "{provider}"
            );
        }
    }
    let (s, c, r) = setup().await;
    for _ in 0..3 {
        s.push(MockResponse::new(429).header("retry-after", "0"));
    }
    assert!(c.fish_direct(&r).await.is_err());
    assert_eq!(s.requests().len(), 3);
    let (s, c, r) = setup().await;
    s.push(MockResponse::new(200));
    assert!(c.piper(&r).await.unwrap().bytes().await.unwrap().is_empty());
}
#[tokio::test]
async fn full_body_deadlines_cover_each_service() {
    async fn check(provider: &str) {
        let (s, c, mut r) = setup().await;
        r.single_attempt = true;
        s.push(audio().stall_after_headers());
        let result = c.synthesize_buffered(&r, provider).await;
        assert!(result.is_err(), "{provider} body must time out");
    }
    tokio::join!(check("piper"), check("kokoro"), check("fish"));
}

#[tokio::test]
async fn credentials_never_leak_and_missing_keys_do_not_call_paid_services() {
    let (s, mut c, r) = setup().await;
    c.config.openrouter_key = None;
    c.config.fish_key = None;
    let message = c
        .synthesize_buffered(&r, "fish")
        .await
        .unwrap_err()
        .to_string();
    assert!(message.contains("not configured"));
    assert!(!message.contains("test-only"));
    assert!(s.requests().is_empty());
    let (s, c, r) = setup().await;
    s.push(MockResponse::new(422).body("secret reflection test-only"));
    let message = match c.fish_direct(&r).await {
        Err(e) => e.to_string(),
        Ok(_) => String::new(),
    };
    assert!(!message.contains("test-only"));
    assert!(message.contains("422"));
}
