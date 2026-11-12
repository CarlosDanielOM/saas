#![allow(clippy::unwrap_used)]
use dima_core::{
    ManualClock, SecretBytes, SecretString, Shutdown,
    crypto::{digest::hmac_sha256, encoding::encode_base64url},
};
use dima_http::testing::{MockResponse, MockServer};
use dima_web::{App, Body};
use dimafx_server::{Config, State};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
fn token(shared: bool) -> String {
    let mut payload = json!({"channel_id":"555777","opaque_user_id":"op-1","exp":9999999999u64});
    if shared {
        payload["user_id"] = json!("u-1");
    }
    let signed = format!(
        "{}.{}",
        encode_base64url(br#"{"alg":"HS256"}"#),
        encode_base64url(payload.to_string().as_bytes())
    );
    format!(
        "{signed}.{}",
        hmac_sha256(&SecretBytes::from_text("secret"), &signed).base64url()
    )
}
fn app(primary: &str, fallback: &str) -> App<State> {
    dimafx_server::build(
        Config {
            internal_url: primary.to_owned(),
            public_url: fallback.to_owned(),
            service_token: SecretString::from("fixture-service-token"),
            signing_secret: SecretString::from("c2VjcmV0"),
            allow_unverified: false,
        },
        Arc::new(ManualClock::new(1000)),
        Shutdown::new(),
    )
    .unwrap()
}
async fn request(
    app: &App<State>,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> (u16, http::HeaderMap, Value) {
    let mut req = http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("content-length", body.len());
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .handle(req.body(Body::from(body.to_owned())).unwrap())
        .await;
    let code = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        code,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn reference_ops_health_status_purchase_credit_identity_and_refusals() {
    let mock = MockServer::start().await.unwrap();
    mock.fallback(|_| {
        MockResponse::json(
            200,
            r#"{"error":false,"status":200,"data":{"connected":false,"balance":"12"}}"#,
        )
    });
    let app = app(&mock.url(), &mock.url());
    let jwt = token(true);
    assert_eq!(
        request(&app, "GET", "/health", None, "").await.2["data"]["ok"],
        true
    );
    let status = request(
        &app,
        "GET",
        "/v1/channels/555777/overlay-status",
        Some(&jwt),
        "",
    )
    .await;
    assert_eq!(status.0, 200);
    assert_eq!(status.1["cache-control"], "no-store");
    for (method, path, body) in [
        ("GET", "/v1/channels/555777/items", ""),
        ("GET", "/v1/me", ""),
        (
            "PATCH",
            "/v1/channels/555777/me/config",
            r#"{"quickPurchasePriority":null,"quickPurchaseAction":[1]}"#,
        ),
        (
            "POST",
            "/v1/channels/555777/items/item-1/purchase",
            r#"{"sku":"x","transactionID":"tx","ttsText":"hé 👋 ا é","action":null,"userID":"spoof"}"#,
        ),
        (
            "POST",
            "/v1/channels/555777/items/item-1/use-credit",
            r#"{"ttsText":"credit"}"#,
        ),
        ("POST", "/v1/channels/555777/items/item-1/redeem", "{}"),
    ] {
        assert_eq!(request(&app, method, path, Some(&jwt), body).await.0, 200);
    }
    let calls = mock.requests();
    assert_eq!(calls.len(), 7);
    for call in &calls {
        assert_eq!(
            call.header("x-dimafx-service-token"),
            Some("fixture-service-token")
        );
    }
    let purchase: Value = serde_json::from_slice(&calls[4].body).unwrap();
    assert_eq!(purchase["userID"], "u-1");
    assert_eq!(purchase["transactionID"], "tx");
    assert_eq!(purchase["ttsText"], "hé 👋 ا é");
    assert!(purchase.get("displayName").is_none());
    let anon = token(false);
    assert_eq!(
        request(&app, "GET", "/v1/me", Some(&anon), "").await.2["data"]["identityShared"],
        false
    );
    for (method, path) in [
        ("PATCH", "/v1/channels/555777/me/config"),
        ("POST", "/v1/channels/555777/items/i/use-credit"),
        ("POST", "/v1/channels/555777/items/i/redeem"),
    ] {
        assert_eq!(request(&app, method, path, Some(&anon), "{}").await.0, 403);
    }
    let mismatch = request(
        &app,
        "GET",
        "/v1/channels/other/overlay-status",
        Some(&jwt),
        "",
    )
    .await;
    assert_eq!(mismatch.0, 403);
    assert!(!mismatch.1.contains_key("cache-control"));
    assert_eq!(request(&app, "GET", "/v1/me", None, "").await.0, 401);
    assert_eq!(
        request(&app, "GET", "/v1/me", Some("bad.token.sig"), "")
            .await
            .0,
        401
    );
    assert_eq!(mock.requests().len(), 7);
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/channels/555777/items/i/purchase",
            Some(&anon),
            r#"{"userID":"spoof","displayName":"spoof","identityShared":true,"ttsText":false}"#
        )
        .await
        .0,
        200
    );
    let last: Value = serde_json::from_slice(&mock.requests().last().unwrap().body).unwrap();
    assert!(last.get("userID").is_none());
    assert_eq!(last["opaqueUserID"], "op-1");
    assert_eq!(last["ttsText"], false);
}
#[tokio::test]
async fn fallback_replays_purchase_and_preserves_error_status_rules() {
    let primary = MockServer::start().await.unwrap();
    let fallback = MockServer::start().await.unwrap();
    let app = app(&primary.url(), &fallback.url());
    let jwt = token(true);
    let path = "/v1/channels/555777/items/i/purchase";
    for response in [
        MockResponse::drop_connection(),
        MockResponse::new(200).body("not json"),
        MockResponse::json(200, r#"{"error":true}"#),
        MockResponse::json(502, r#"{"data":null}"#),
        MockResponse::json(200, r#"{"error":true,"status":500}"#),
    ] {
        primary.push(response);
        fallback.push(MockResponse::json(200, r#"{"error":false,"data":null}"#));
        assert_eq!(
            request(
                &app,
                "POST",
                path,
                Some(&jwt),
                r#"{"sku":null,"transactionID":[1]}"#
            )
            .await
            .0,
            200
        );
        let a = primary.requests();
        let b = fallback.requests();
        assert_eq!(a.last().unwrap().body, b.last().unwrap().body);
        assert_eq!(
            b.last().unwrap().header("x-dimafx-service-token"),
            Some("fixture-service-token")
        );
    }
    primary.push(MockResponse::json(
        400,
        r#"{"error":true,"message":"bad","status":400}"#,
    ));
    assert_eq!(request(&app, "POST", path, Some(&jwt), "{}").await.0, 400);
    assert_eq!(fallback.requests().len(), 5);
    primary.push(MockResponse::json(200, r#"{"error":true}"#));
    fallback.push(MockResponse::json(200, r#"{"error":true}"#));
    assert_eq!(request(&app, "GET", "/v1/me", Some(&jwt), "").await.0, 200);
}
#[tokio::test]
async fn parser_cors_and_unknown_route_order() {
    let app = app("http://127.0.0.1:1", "http://127.0.0.1:1");
    assert_eq!(request(&app, "POST", "/health", None, "{").await.0, 400);
    assert_eq!(
        request(
            &app,
            "POST",
            "/health",
            None,
            &format!("{{\"x\":\"{}\"}}", "a".repeat(102401))
        )
        .await
        .0,
        413
    );
    assert_eq!(request(&app, "GET", "/v1/unknown", None, "").await.0, 401);
    let req = http::Request::builder()
        .method("OPTIONS")
        .uri("/v1/me")
        .header("origin", "https://example.test")
        .header(
            "access-control-request-headers",
            "authorization,x-extension-jwt",
        )
        .body(Body::empty())
        .unwrap();
    let response = app.handle(req).await;
    assert_eq!(response.status(), 204);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
}
