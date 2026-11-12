//! The bounds this port adds where the reference had none, and the failures the recordings
//! cannot show: the request deadline, the analytics proxy's deadline and answer bound, the site
//! analytics stream's timing and its end when the client goes away, an OAuth request id the
//! client cannot pick for its rate-limit bucket, and a service the binary forgot to register.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod app_support;

use anyhow::Result;
use app_support::{harness_with, oauth_key, send, with_stores};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::time::Duration;

fn cases() -> Value {
    let mut cases: Value = serde_json::from_str(include_str!("app-cases.json")).unwrap();
    cases["analytics"]["/api/overview"] = json!({ "status": 200, "body": "{}", "delay_ms": 2000 });
    cases["analytics"]["/api/logs"] =
        json!({ "status": 200, "body": format!("{{\"logs\":\"{}\"}}", "x".repeat(4096)) });
    cases
}

fn get(path: &str) -> Value {
    json!({ "method": "GET", "path": path })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bounds_and_failures() -> Result<()> {
    with_stores(|stores| async move {
        let h = harness_with(
            stores.clone(),
            cases(),
            |config| {
                config.request_deadline = Duration::from_millis(500);
                config.analytics.timeout = Duration::from_millis(300);
                config.analytics.max_response_bytes = 1024;
                config.site_stream.interval = Duration::from_millis(40);
                config.site_stream.heartbeat = Duration::from_millis(100);
            },
            true,
        )
        .await?;
        let none = |text: &str| text.to_owned();

        // The proxy: an analytics service that does not answer in time, or answers too much.
        for path in ["/observability/api/overview", "/observability/api/logs"] {
            let answer = send(h.port, &get(path), &none).await?;
            assert_eq!(answer.status, 503, "{path}");
            assert_eq!(
                String::from_utf8(answer.body)?,
                r#"{"message":"Analytics is temporarily unavailable"}"#
            );
        }

        // A handler that does not answer before the deadline (the desktop turn fake sleeps).
        let token = desktop_token(&h).await?;
        let slow = json!({
            "method": "POST", "path": "/v1/me/ai/turns",
            "headers": { "authorization": format!("Bearer {token}"), "content-type": "application/json" },
            "body": "{\"sleep_ms\":2000}",
        });
        let started = std::time::Instant::now();
        let answer = send(h.port, &slow, &none).await?;
        assert_eq!(answer.status, 503);
        assert_eq!(
            String::from_utf8(answer.body)?,
            r#"{"error":true,"message":"Request timed out","status":503}"#
        );
        assert!(started.elapsed() < Duration::from_millis(1900));

        // The event stream: snapshots every interval, keep-alive comments, and the producer
        // stops once the client is gone.
        let stream = json!({ "method": "GET", "path": "/config/site/analytics/stream" });
        let mut socket = raw_stream(h.port, &stream).await?;
        let text = read_for(&mut socket, Duration::from_millis(450)).await;
        assert!(text.matches("data: {").count() >= 4, "{text}");
        assert!(text.contains(": keep-alive\n\n"), "{text}");
        drop(socket);
        let mut settled = h.fakes.snapshot_calls.load(Ordering::SeqCst);
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let now = h.fakes.snapshot_calls.load(Ordering::SeqCst);
            if now == settled {
                break;
            }
            settled = now;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(h.fakes.snapshot_calls.load(Ordering::SeqCst), settled);

        // The rate-limit bucket is the client the trusted proxy reports.
        let forged = json!({
            "method": "GET", "path": "/oauth/metadata",
            "headers": { "x-forwarded-for": "203.0.113.77" },
        });
        let _ = send(h.port, &forged, &none).await?;
        let counted = h
            .stores
            .cache
            .get(&oauth_key("rate", "oauth:203.0.113.77"))
            .await?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        // The test client is the trusted proxy (127.0.0.1), so the header is believed and the
        // reported client has a bucket of its own; an untrusted peer's header is ignored
        // (`app::client`'s unit tests).
        assert_eq!(counted.as_deref(), Some("1"));
        stores.track(oauth_key("rate", "oauth:203.0.113.77"));
        stores.track(oauth_key("rate", "oauth:127.0.0.1"));
        stores.track(oauth_key("rate", "desktop:127.0.0.1"));
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_service_fails_loudly() -> Result<()> {
    with_stores(|stores| async move {
        let h = harness_with(stores.clone(), cases(), |_config| {}, false).await?;
        let none = |text: &str| text.to_owned();
        // The shell: the default error page (500), never a silent success.
        let answer = send(h.port, &get("/config/commands/reserved"), &none).await?;
        assert_eq!(answer.status, 500);
        let answer = send(h.port, &get("/observability/api/logs"), &none).await?;
        assert_eq!(answer.status, 500);
        // The OAuth routers answer every unexpected failure 503 `temporarily_unavailable`.
        let token = desktop_token(&h).await?;
        let credits = json!({
            "method": "GET", "path": "/v1/me/credits",
            "headers": { "authorization": format!("Bearer {token}") },
        });
        let answer = send(h.port, &credits, &none).await?;
        assert_eq!(answer.status, 503);
        assert_eq!(
            String::from_utf8(answer.body)?,
            r#"{"error":"temporarily_unavailable"}"#
        );
        stores.track(oauth_key("rate", "oauth:127.0.0.1"));
        stores.track(oauth_key("rate", "desktop:127.0.0.1"));
        Ok(())
    })
    .await
}

/// An access token for the fixture user, through the real authorisation flow.
async fn desktop_token(h: &app_support::Harness) -> Result<String> {
    let user = h.fakes.cases["users"][0]["twitch_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut input = serde_json::Map::new();
    for (key, value) in [
        ("response_type", "code"),
        ("client_id", "dima-desktop"),
        ("redirect_uri", "http://127.0.0.1:53682/oauth/callback"),
        ("scope", "profile:read credits:read"),
        ("state", "StateForTheRoutesRecorder000000000000000000"),
        (
            "code_challenge",
            "tP5hByMyJsAV05W5MMmHrwTf6kkbre4W-27eaxUkXpM",
        ),
        ("code_challenge_method", "S256"),
    ] {
        input.insert(key.to_owned(), Value::String(value.to_owned()));
    }
    let oauth = &dima_routes::state::RouteState::core(h.state.as_ref()).oauth;
    let request = oauth.start_authorization(&input).await?;
    let redirect = oauth.approve_authorization(&request, &user, true).await?;
    let code = redirect
        .split("code=")
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    let mut exchange = serde_json::Map::new();
    for (key, value) in [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", "dima-desktop"),
        ("redirect_uri", "http://127.0.0.1:53682/oauth/callback"),
        (
            "code_verifier",
            "dimaRoutesRecorderVerifier0123456789abcdefghijk",
        ),
    ] {
        exchange.insert(key.to_owned(), Value::String(value.to_owned()));
    }
    let tokens = oauth.exchange_code(&exchange).await?;
    let token = tokens.access_token().expose().to_owned();
    h.stores.track(oauth_key("access", &token));
    Ok(token)
}

async fn raw_stream(port: u16, case: &Value) -> Result<tokio::net::TcpStream> {
    use tokio::io::AsyncWriteExt;
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let head = format!(
        "{} {} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
        case["method"].as_str().unwrap(),
        case["path"].as_str().unwrap()
    );
    socket.write_all(head.as_bytes()).await?;
    Ok(socket)
}

async fn read_for(socket: &mut tokio::net::TcpStream, period: Duration) -> String {
    use tokio::io::AsyncReadExt;
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    let _ = tokio::time::timeout(period, async {
        while let Ok(n) = socket.read(&mut buffer).await {
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buffer[..n]);
        }
    })
    .await;
    String::from_utf8_lossy(&raw).into_owned()
}
