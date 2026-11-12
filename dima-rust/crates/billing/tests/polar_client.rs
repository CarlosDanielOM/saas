//! Every Polar call against the loopback mock: method, path, query, headers (the authorization
//! by its scheme only) and body as `ledger/outbound.md` and the SDK recording say, and the
//! client's behaviour on failures.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_billing::config::PolarConfig;
use dima_billing::polar::{IngestEvent, PolarClient, PolarError, SDK_USER_AGENT};
use dima_core::SecretString;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use serde_json::{Value, json};
use std::time::Duration;

const TOKEN: &str = "polar_oat_secret_value";

async fn client_with(server: &MockServer, timeout: Option<Duration>) -> PolarClient {
    let mut builder = PolarClient::provider(&PolarConfig::default());
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    let provider = server.provider(builder).unwrap();
    let http = HttpClient::builder().build().unwrap();
    PolarClient::new(http, provider, Some(SecretString::from(TOKEN)))
}

async fn client(server: &MockServer) -> PolarClient {
    client_with(server, None).await
}

fn assert_bearer(request: &RecordedRequest) {
    let auth = request.header("authorization").unwrap();
    assert!(auth.starts_with("Bearer "), "authorization scheme");
    assert_eq!(auth.len(), "Bearer ".len() + TOKEN.len());
}

fn assert_fetch(request: &RecordedRequest, method: &str, target: &str) {
    assert_eq!(request.method, method);
    assert_eq!(request.target, target);
    assert_bearer(request);
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("user-agent"), Some("node"));
}

fn assert_sdk(request: &RecordedRequest, method: &str, target: &str, body: bool) {
    assert_eq!(request.method, method);
    assert_eq!(request.target, target);
    assert_bearer(request);
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.header("cookie"), Some(""));
    assert_eq!(request.header("user-agent"), Some(SDK_USER_AGENT));
    assert_eq!(
        request.header("content-type"),
        body.then_some("application/json")
    );
}

#[tokio::test]
async fn billing_fetch_calls_send_the_reference_requests() {
    let server = MockServer::start().await.unwrap();
    let polar = client(&server).await;
    server.push(MockResponse::json(200, r#"{"items":[{"id":"s1","status":"active","product_id":"p","extra":{"x":1}}],"pagination":{}}"#));
    let subscriptions = polar
        .list_subscriptions("cust-1", Some(true))
        .await
        .unwrap();
    assert_eq!(subscriptions[0].id, "s1");
    server.push(MockResponse::json(200, r#"{"items":null}"#));
    assert!(
        polar
            .list_subscriptions("cust-1", None)
            .await
            .unwrap()
            .is_empty()
    );
    server.push(MockResponse::json(200, r#"{"items":[{"id":"x"}]}"#));
    assert!(polar.list_products().await.unwrap().is_some());
    server.push(MockResponse::json(200, r#"{"prices":[]}"#));
    polar.get_product("prod-1").await.unwrap();
    server.push(MockResponse::json(
        200,
        r#"{"id":"d1","type":"fixed","amount":500,"products":[]}"#,
    ));
    assert_eq!(polar.get_discount("d1").await.unwrap().amount, Some(500.0));
    server.push(MockResponse::json(
        200,
        r#"{"items":[{"id":"d2","code":"WELCOME"}]}"#,
    ));
    assert_eq!(
        polar.search_discounts("welcome tag").await.unwrap()[0].id,
        "d2"
    );
    server.push(MockResponse::json(
        200,
        r#"{"id":"chk","url":"https://polar.sh/c","client_secret":"s"}"#,
    ));
    let body =
        json!({"products": ["p"], "allow_discount_codes": false, "metadata": {"credits": 1000}});
    let checkout = polar
        .create_checkout(&body, "billing:u:premium:new:1")
        .await
        .unwrap();
    assert_eq!(checkout.id, "chk");
    server.push(MockResponse::json(200, r#"{"id":"cs","customer_portal_url":"https://polar.sh/p","expires_at":"2026-11-11T00:00:00Z"}"#));
    polar
        .create_customer_session(&json!({"customer_id": "cust-1"}))
        .await
        .unwrap();
    server.push(MockResponse::json(200, r#"{"active_meters":[]}"#));
    polar.get_customer_state_raw("cust-1").await.unwrap();

    let requests = server.wait_for(9).await;
    assert_fetch(
        &requests[0],
        "GET",
        "/v1/subscriptions/?customer_id=cust-1&limit=100&active=true",
    );
    assert_fetch(
        &requests[1],
        "GET",
        "/v1/subscriptions/?customer_id=cust-1&limit=100",
    );
    assert_fetch(&requests[2], "GET", "/v1/products/?limit=100");
    assert_fetch(&requests[3], "GET", "/v1/products/prod-1/");
    assert_fetch(&requests[4], "GET", "/v1/discounts/d1/");
    assert_fetch(
        &requests[5],
        "GET",
        "/v1/discounts/?query=welcome+tag&limit=100",
    );
    assert_fetch(&requests[6], "POST", "/v1/checkouts/");
    assert_eq!(
        requests[6].header("idempotency-key"),
        Some("billing:u:premium:new:1")
    );
    assert_eq!(
        requests[6].body_text(),
        r#"{"products":["p"],"allow_discount_codes":false,"metadata":{"credits":1000}}"#
    );
    assert_fetch(&requests[7], "POST", "/v1/customer-sessions/");
    assert_eq!(requests[7].body_text(), r#"{"customer_id":"cust-1"}"#);
    assert_eq!(requests[7].header("idempotency-key"), None);
    assert_fetch(&requests[8], "GET", "/v1/customers/cust-1/state");
    for request in &requests[..6] {
        assert!(request.body.is_empty());
    }
}

#[tokio::test]
async fn gift_and_sdk_calls_send_the_reference_requests() {
    let server = MockServer::start().await.unwrap();
    let polar = client(&server).await;
    server.push(MockResponse::json(
        200,
        r#"{"items":[],"pagination":{"max_page":1}}"#,
    ));
    polar.list_benefit_grants_page("cust-1", 3).await.unwrap();
    server.push(MockResponse::json(200, r#"{"id":"ord_1"}"#));
    polar.get_order("ord_1").await.unwrap();
    server.push(MockResponse::json(200, r#"{"id":"cust-1","active_subscriptions":[{"id":"s","product_id":"p","status":"active","current_period_end":"2026-12-01T00:00:00Z","ends_at":null,"trial_end":null,"trial_start":null,"amount":500}],"granted_benefits":[{"id":"g","benefit_id":"b","benefit_type":"meter_credit"}],"active_meters":[]}"#));
    let state = polar.get_entitlement_state("cust-1").await.unwrap();
    assert_eq!(
        state.active_subscriptions[0].current_period_end.as_deref(),
        Some("2026-12-01T00:00:00Z")
    );
    server.push(MockResponse::json(200, r#"{"items":[{"id":"g","benefit_id":"b","customer_id":"cust-1","is_granted":true,"is_revoked":false,"subscription_id":"s"}],"pagination":{"total_count":1,"max_page":1}}"#));
    let page = polar
        .list_granted_benefit_grants("cust-1", 2)
        .await
        .unwrap();
    assert_eq!(page.pagination.max_page, 1);
    server.push(MockResponse::json(200, r#"{"id":"s","customer_id":"cust-1","product_id":"p","status":"past_due","current_period_end":null}"#));
    polar.get_subscription("s").await.unwrap();
    server.push(MockResponse::json(200, r#"{"inserted":1,"duplicates":0}"#));
    let event = IngestEvent {
        name: "ai_usage".into(),
        customer_id: "cust-1".into(),
        external_id: "e1".into(),
        metadata:
            json!({"cost": 0.0015, "currency": "usd", "credits": 2, "reason": "x", "q": -0.0})
                .as_object()
                .cloned()
                .unwrap(),
    };
    assert!(polar.ingest_events(&[event]).await.unwrap().is_complete(1));

    let requests = server.wait_for(6).await;
    assert_fetch(
        &requests[0],
        "GET",
        "/v1/benefit-grants/?customer_id=cust-1&limit=100&page=3&sorting=-created_at",
    );
    assert_fetch(&requests[1], "GET", "/v1/orders/ord_1");
    assert_sdk(&requests[2], "GET", "/v1/customers/cust-1/state", false);
    assert_sdk(
        &requests[3],
        "GET",
        "/v1/benefit-grants/?customer_id=cust-1&is_granted=true&limit=100&page=2",
        false,
    );
    assert_sdk(&requests[4], "GET", "/v1/subscriptions/s", false);
    assert_sdk(&requests[5], "POST", "/v1/events/ingest", true);
    // The SDK 0.42.5 bytes for this event (recorded by the corpus generator).
    assert_eq!(
        requests[5].body_text(),
        r#"{"events":[{"name":"ai_usage","external_id":"e1","metadata":{"cost":0.0015,"currency":"usd","credits":2,"reason":"x","q":0},"customer_id":"cust-1"}]}"#
    );
}

#[tokio::test]
async fn failure_statuses_are_typed_and_never_carry_the_body() {
    let server = MockServer::start().await.unwrap();
    let polar = client(&server).await;
    for status in [401u16, 404, 409, 422, 429, 500, 502, 503] {
        server.push(
            MockResponse::json(
                status,
                r#"{"detail":[{"input":"victim@example.com","msg":"bad"}]}"#,
            )
            .header("retry-after", "1"),
        );
        let error = polar.create_checkout(&json!({}), "k").await.unwrap_err();
        assert_eq!(error.status(), Some(status));
        assert_eq!(error.outcome_unknown(), status >= 500, "status {status}");
        let shown = format!("{error} {error:?}");
        assert!(!shown.contains("victim"), "{shown}");
        assert!(!shown.contains(TOKEN));
    }
    // No retry: one request per call.
    assert_eq!(server.requests().len(), 8);
    server.push(MockResponse::json(404, "{}"));
    assert_eq!(polar.get_order("o").await.unwrap_err().status(), Some(404));
    assert_eq!(server.requests().len(), 9);
}

#[tokio::test]
async fn timeouts_truncated_bodies_and_odd_shapes_fail_safely() {
    let server = MockServer::start().await.unwrap();
    let polar = client_with(&server, Some(Duration::from_millis(300))).await;

    server.push(MockResponse::json(200, r#"{"id":"c","url":"u"}"#).delay(Duration::from_secs(2)));
    let error = polar.create_checkout(&json!({}), "k").await.unwrap_err();
    assert!(
        matches!(&error, PolarError::Transport { source, .. } if source.is_timeout()),
        "{error:?}"
    );
    assert!(
        error.outcome_unknown(),
        "a POST that timed out may have been applied"
    );

    server.push(
        MockResponse::json(
            200,
            r#"{"id":"cs","customer_portal_url":"https://polar.sh/very/long/url"}"#,
        )
        .drop_after(10),
    );
    let error = polar.create_customer_session(&json!({})).await.unwrap_err();
    assert!(
        matches!(
            error,
            PolarError::Transport { .. } | PolarError::Decode { .. }
        ),
        "{error:?}"
    );

    server.push(MockResponse::drop_connection());
    let error = polar.get_customer_state_raw("c").await.unwrap_err();
    assert!(matches!(
        error,
        PolarError::Transport {
            mutation: false,
            ..
        }
    ));
    assert!(!error.outcome_unknown());

    // `[].items || []` is empty in the reference too.
    server.push(MockResponse::json(200, "[]"));
    assert!(
        polar
            .list_subscriptions("c", None)
            .await
            .unwrap()
            .is_empty()
    );
    for body in [
        r#"{"items":{}}"#,
        "not json",
        "",
        r#"{"items":[null]}"#,
        r#"{"items":[{"id":1}]}"#,
    ] {
        server.push(MockResponse::json(200, body));
        let error = polar.list_subscriptions("c", None).await.unwrap_err();
        assert!(
            matches!(error, PolarError::Decode { mutation: false }),
            "{body}: {error:?}"
        );
    }
    server.push(MockResponse::json(200, r#"{"id":"c"}"#));
    assert!(matches!(
        polar.create_checkout(&json!({}), "k").await,
        Err(PolarError::Decode { mutation: true })
    ));
    server.push(MockResponse::json(200, r#"{"inserted":"1"}"#));
    let result = polar.ingest_events(&[]).await.unwrap();
    assert!(
        !result.is_complete(1),
        "a non-number count is 0, as isIngestComplete reads it"
    );
}

#[tokio::test]
async fn nothing_is_sent_without_a_token_or_with_a_refused_input() {
    let server = MockServer::start().await.unwrap();
    let provider = server
        .provider(PolarClient::provider(&PolarConfig::default()))
        .unwrap();
    let polar = PolarClient::new(HttpClient::builder().build().unwrap(), provider, None);
    assert!(matches!(
        polar.get_customer_state_raw("c").await,
        Err(PolarError::NotConfigured)
    ));
    let configured = client(&server).await;
    assert!(matches!(
        configured.get_order("").await,
        Err(PolarError::InvalidInput(_))
    ));
    assert!(matches!(
        configured.get_order("..").await,
        Err(PolarError::InvalidInput(_))
    ));
    let bad = IngestEvent {
        name: "ai_usage".into(),
        customer_id: "c".into(),
        external_id: "e".into(),
        metadata: json!({"characters": Value::Null})
            .as_object()
            .cloned()
            .unwrap(),
    };
    assert!(matches!(
        configured.ingest_events(&[bad]).await,
        Err(PolarError::InvalidInput(_))
    ));
    // An id with a slash stays one segment.
    server.push(MockResponse::json(200, "{}"));
    configured.get_customer_state_raw("a/b?c").await.unwrap();
    let requests = server.wait_for(1).await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].target, "/v1/customers/a%2Fb%3Fc/state");
}

// Item 7 of P2-BILLING-01b (review finding 9): Polar may have committed a checkout, a session
// or an ingest and answered 200 with a body this client cannot read; that is an unknown
// outcome, not a plain decode failure. A read that cannot be decoded changed nothing.
#[tokio::test]
async fn an_undecodable_answer_to_a_write_is_an_unknown_outcome() {
    let server = MockServer::start().await.unwrap();
    let polar = client(&server).await;
    for body in ["not json", r#"{"id":"c"}"#, "", r#"{"url":7}"#] {
        server.push(MockResponse::json(200, body));
        let error = polar.create_checkout(&json!({}), "k").await.unwrap_err();
        assert!(error.outcome_unknown(), "checkout {body:?}: {error:?}");
        server.push(MockResponse::json(200, body));
        let error = polar.create_customer_session(&json!({})).await.unwrap_err();
        assert!(error.outcome_unknown(), "session {body:?}: {error:?}");
    }
    server.push(MockResponse::json(200, r#"{"inserted":"#));
    let error = polar.ingest_events(&[]).await.unwrap_err();
    assert!(error.outcome_unknown(), "{error:?}");
    server.push(MockResponse::json(200, "not json"));
    let error = polar.get_customer_state_raw("c").await.unwrap_err();
    assert!(
        !error.outcome_unknown(),
        "a read changes nothing: {error:?}"
    );
}
