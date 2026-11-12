//! The mock of the outside world over real HTTP: provider routing by host, stateful Twitch,
//! Nth-call answers, streams, failures, recording, proxying, S3, and the Qdrant prefixing proxy
//! (against the local Qdrant when it is reachable; skipped otherwise).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::time::Duration;

use dima_rig::mock::{Mock, MockFile, MockSpec, qdrant};
use serde_json::{Value, json};

fn spec(v: Value) -> MockSpec {
    let f: MockFile = serde_json::from_value(v).unwrap();
    MockSpec::from_file(f, "test").unwrap()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

#[tokio::test]
async fn twitch_tokens_users_and_unexpected_requests() {
    let mock = Mock::start(None).await.unwrap();
    mock.reset(
        &spec(json!({"twitch": {
            "users": [{"id": "1001", "login": "rigstreamer", "display_name": "RigStreamer"}],
            "tokens": [{"token": "user-token-1", "user_id": "1001", "scopes": ["user:read:email"]}]
        }})),
        &BTreeMap::new(),
    );
    let c = client();
    let base = mock.url();
    let v: Value = c
        .get(format!("{base}/id.twitch.tv/oauth2/validate"))
        .header("authorization", "OAuth user-token-1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["user_id"], "1001");
    assert_eq!(v["login"], "rigstreamer");
    let r = c
        .get(format!("{base}/id.twitch.tv/oauth2/validate"))
        .header("authorization", "OAuth nope")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    // Helix needs a client id and a known token.
    let r = c
        .get(format!("{base}/api.twitch.tv/helix/users"))
        .header("authorization", "Bearer user-token-1")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = c
        .get(format!("{base}/api.twitch.tv/helix/users"))
        .header("authorization", "Bearer user-token-1")
        .header("client-id", "rigclient")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["ratelimit-limit"], "800");
    let users: Value = r.json().await.unwrap();
    assert_eq!(users["data"][0]["display_name"], "RigStreamer");
    // An app token from client credentials is accepted by Helix.
    let t: Value = c
        .post(format!(
            "{base}/id.twitch.tv/oauth2/token?client_id=rigclient&client_secret=s&grant_type=client_credentials"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let app = t["access_token"].as_str().unwrap().to_string();
    let r = c
        .get(format!(
            "{base}/api.twitch.tv/helix/users?login=rigstreamer"
        ))
        .header("authorization", format!("Bearer {app}"))
        .header("client-id", "rigclient")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(mock.problems().is_empty(), "{:?}", mock.problems());
    // Unknown host and unmatched route: 501 and a problem each, with the request shown.
    let r = c
        .get(format!("{base}/example.com/x?y=1"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 501);
    let r = c
        .post(format!("{base}/api.twitch.tv/helix/nothing-here"))
        .body("{\"a\":1}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 501);
    let problems = mock.problems();
    assert_eq!(problems.len(), 2, "{problems:?}");
    assert_eq!(problems[0].kind, "unknown-host");
    assert!(
        problems[0].detail.contains("GET example.com/x?y=1"),
        "{problems:?}"
    );
    assert_eq!(problems[1].kind, "unmatched");
    assert!(
        problems[1]
            .detail
            .contains("POST api.twitch.tv/helix/nothing-here body {\"a\":1}")
    );
    // Recorded, with the credentials reduced to their scheme.
    let calls = mock.calls();
    let first = &calls[0];
    assert_eq!(
        (first.provider.as_str(), first.path.as_str()),
        ("twitch-id", "/oauth2/validate")
    );
    let auth = first
        .headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .unwrap();
    assert_eq!(auth.1, b"OAuth <redacted>".to_vec());
    assert!(calls.iter().any(|c| c.answered == "unmatched"));
    mock.stop().await;
}

#[tokio::test]
async fn nth_calls_streams_and_failures() {
    let mock = Mock::start(None).await.unwrap();
    mock.reset(
        &spec(json!({"routes": [
            {"host": "openrouter.ai", "method": "POST", "path": "/api/v1/chat/completions", "body": {"model": "fail/me"},
             "call": 2, "respond": {"status": 429, "json": {"error": {"message": "slow down", "code": 429}}}},
            {"host": "api.resend.com", "path": "/emails", "respond": {"fail": "drop"}},
            {"host": "api.polar.sh", "path": "/v1/orders/{id}", "respond": {"delay_ms": 300, "json": {"id": "${path.id}", "call": "${call}"}}},
            {"host": "search.myhomelab.wtf", "respond": {"fail": "timeout"}}
        ]})),
        &BTreeMap::new(),
    );
    let c = client();
    let base = mock.url();
    let chat = |stream: bool| json!({"model": "fail/me", "stream": stream, "messages": [{"role": "user", "content": "hola 👋"}]});
    let url = format!("{base}/openrouter.ai/api/v1/chat/completions");
    let s1 = c.post(&url).json(&chat(false)).send().await.unwrap();
    assert_eq!(s1.status(), 200);
    let body: Value = s1.json().await.unwrap();
    assert_eq!(body["model"], "fail/me");
    assert_eq!(body["choices"][0]["message"]["content"], "Rig mock answer.");
    let s2 = c.post(&url).json(&chat(false)).send().await.unwrap();
    assert_eq!(s2.status(), 429, "the second matching call");
    let s3 = c.post(&url).json(&chat(true)).send().await.unwrap();
    assert_eq!(s3.status(), 200);
    assert_eq!(s3.headers()["content-type"], "text/event-stream");
    let text = s3.text().await.unwrap();
    assert!(text.starts_with(": OPENROUTER PROCESSING"), "{text}");
    assert!(text.contains("\"content\":\"Rig \""), "{text}");
    assert!(text.trim_end().ends_with("data: [DONE]"), "{text}");
    // A dropped connection is a transport error.
    let e = c
        .post(format!("{base}/api.resend.com/emails"))
        .json(&json!({}))
        .send()
        .await;
    assert!(e.is_err(), "{e:?}");
    // A delay, and path captures in the answer.
    let t0 = std::time::Instant::now();
    let v: Value = c
        .get(format!("{base}/api.polar.sh/v1/orders/ord_1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(280));
    assert_eq!(v, json!({"id": "ord_1", "call": 1}));
    // A stall: the client gives up.
    let quick = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let e = quick
        .get(format!("{base}/search.myhomelab.wtf/search?q=x"))
        .send()
        .await;
    assert!(e.is_err_and(|e| e.is_timeout()));
    assert!(mock.problems().is_empty(), "{:?}", mock.problems());
    // The mock stops even with a stalled request open.
    tokio::time::timeout(Duration::from_secs(5), mock.stop())
        .await
        .unwrap();
}

#[tokio::test]
async fn proxy_s3_embeddings_and_eventsub() {
    let side = Mock::start(None).await.unwrap();
    side.reset(
        &spec(json!({"routes": [{"host": "api.domdimabot.com", "path": "/hello", "respond": {"json": {"from": "the side"}}}]})),
        &BTreeMap::new(),
    );
    let mock = Mock::start(None).await.unwrap();
    mock.reset(
        &spec(json!({
            "routes": [{"host": "dima-server:3000", "proxy": "port.http"}],
            "twitch": {"tokens": [{"token": "bot", "user_id": "698614112"}]},
            "s3": {"objects": {"rig-media/seeded.txt": {"text": "hola", "content_type": "text/plain"}}}
        })),
        &[("http".to_string(), side.port)].into(),
    );
    let c = client();
    let base = mock.url();
    // dima-server:3000/<path> is forwarded to the side's own port, unchanged.
    let v: Value = c
        .get(format!("{base}/dima-server:3000/api.domdimabot.com/hello"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["from"], "the side");
    // S3, path style and virtual-hosted.
    let r = c
        .put(format!(
            "{base}/nyc3.digitaloceanspaces.com/rig-media/a%20b.png"
        ))
        .header("content-type", "image/png")
        .body(vec![1u8, 2, 3])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let got = c
        .get(format!(
            "{base}/rig-media.nyc3.digitaloceanspaces.com/a%20b.png"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(got.headers()["content-type"], "image/png");
    assert_eq!(got.bytes().await.unwrap().to_vec(), vec![1u8, 2, 3]);
    let seeded = c
        .get(format!(
            "{base}/rig-media.nyc3.digitaloceanspaces.com/seeded.txt"
        ))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(seeded, "hola");
    // Embeddings: one deterministic vector per input, of the provider's size.
    let e: Value = c
        .post(format!("{base}/lfm2.5-embeddings:8080/v1/embeddings"))
        .json(&json!({"input": ["a", "b"], "model": "lfm2.5-embedding-350m"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(e["data"].as_array().unwrap().len(), 2);
    assert_eq!(e["data"][1]["embedding"].as_array().unwrap().len(), 1024);
    // EventSub subscriptions are kept for the scenario: create, then list.
    let sub = json!({"type": "channel.chat.message", "version": "1",
        "condition": {"broadcaster_user_id": "1001", "user_id": "698614112"},
        "transport": {"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub", "secret": "x"}});
    let r = c
        .post(format!("{base}/api.twitch.tv/helix/eventsub/subscriptions"))
        .header("authorization", "Bearer bot")
        .header("client-id", "c")
        .json(&sub)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let list: Value = c
        .get(format!(
            "{base}/api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message"
        ))
        .header("authorization", "Bearer bot")
        .header("client-id", "c")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["total"], 1);
    assert_eq!(
        list["data"][0]["status"],
        "webhook_callback_verification_pending"
    );
    assert!(mock.problems().is_empty(), "{:?}", mock.problems());
    // Each call records what answered it.
    let calls = mock.calls();
    let proxied = calls.iter().find(|c| c.host == "dima-server:3000").unwrap();
    assert_eq!(
        (proxied.provider.as_str(), proxied.answered.as_str()),
        ("dimabot-api", "test mock.routes[0]")
    );
    assert!(
        calls
            .iter()
            .any(|c| c.answered.contains("twitch.eventsub.create")),
        "{calls:?}"
    );
    mock.stop().await;
    side.stop().await;
}

#[tokio::test]
async fn qdrant_proxy_isolates_and_cleans_up() {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let store = dima_rig::config::qdrant_store(&env).unwrap();
    let probe = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    if probe.get(&store.url).send().await.is_err() {
        eprintln!("skipping: no local Qdrant at {}", store.url);
        return;
    }
    let prefix = format!("rig_{}_t_qd__", std::process::id());
    let up = qdrant::Upstream {
        url: store.url.clone(),
        api_key: store.api_key.clone(),
        prefix: prefix.clone(),
    };
    let mock = Mock::start(Some(up.clone())).await.unwrap();
    mock.reset(&MockSpec::default(), &BTreeMap::new());
    let qbase = format!("http://127.0.0.1:{}", mock.qdrant_port.unwrap());
    let c = client();
    let r = c
        .put(format!("{qbase}/collections/rig_probe"))
        .header("api-key", "placeholder")
        .json(&json!({"vectors": {"size": 4, "distance": "Cosine"}}))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "{:?}", r.text().await);
    let listed: Value = c
        .get(format!("{qbase}/collections"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = listed["result"]["collections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["rig_probe"],
        "the side sees only its own, unprefixed"
    );
    let missing = c
        .get(format!("{qbase}/collections/nope"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!missing.contains(&prefix), "{missing}");
    let calls = mock.calls();
    assert!(calls.iter().all(|c| c.provider == "qdrant"));
    let key = calls[0]
        .headers
        .iter()
        .find(|(k, _)| k == "api-key")
        .unwrap();
    assert_eq!(key.1, b"<redacted>".to_vec());
    mock.stop().await;
    let dropped = qdrant::drop_prefixed(&up).await.unwrap();
    assert_eq!(dropped, vec![format!("{prefix}rig_probe")]);
    assert!(qdrant::drop_prefixed(&up).await.unwrap().is_empty());
}
