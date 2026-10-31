#![cfg(feature = "stream-timeline-routes")]
//! Pure checks for the authored route policies; external fixture replay remains open.
use axum::{http::{header, StatusCode}, response::IntoResponse};
use dima_rust::stream_timeline_route::{can_see_credits, initial_gate, parse_page, permission_gate, tier, valid_channel, valid_object_id, Envelope, RouteError};

#[test]
fn gate_checks_identity_before_channel_shape() {
    let missing = initial_gate(None, "invalid").unwrap_err();
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED); assert_eq!(missing.message, "Authentication required");
    let invalid = initial_gate(Some("12"), "invalid").unwrap_err();
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST); assert_eq!(invalid.message, "Invalid channel");
    assert!(initial_gate(Some("12"), "123").is_ok());
    let forbidden = permission_gate(false).unwrap_err();
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN); assert_eq!(forbidden.message, "Analytics access required");
    assert!(permission_gate(true).is_ok());
    assert!(valid_channel("123")); assert!(!valid_channel("١")); assert!(!valid_channel(&"1".repeat(31)));
}
#[test]
fn page_id_tier_and_billing_policy() {
    for (value, expected) in [(None, Some(1)), (Some("1"), Some(1)), (Some("0x10"), Some(16)), (Some("1000"), Some(1000)), (Some(""), None), (Some("0"), None), (Some("1001"), None), (Some("1.5"), None), (Some("nan"), None)] { assert_eq!(parse_page(value), expected); }
    assert!(valid_object_id("507F1F77BCF86CD799439011")); assert!(!valid_object_id("507f1f77bcf86cd79943901z"));
    assert_eq!(tier(Some("pro")), "pro"); assert_eq!(tier(Some("premium")), "premium"); assert_eq!(tier(Some("unknown")), "free");
    assert!(can_see_credits("pro", true)); assert!(!can_see_credits("premium", true)); assert!(!can_see_credits("pro", false));
}
#[test]
fn query_coercion_and_redacted_diagnostics() {
    use dima_rust::{analytics_route::normalize_search, stream_summary_route::summary_pagination, stream_timeline_route::{parse_query, redact_identifiers, safe_error}};
    let query = parse_query(Some("page=1&page=2&limit=abc"));
    assert_eq!(query.get("page").map(String::as_str), Some("1,2"));
    assert_eq!(parse_page(query.get("page").map(String::as_str)), None);
    assert_eq!(parse_page(parse_query(Some("page%5Ba%5D=1")).get("page").map(String::as_str)), None);
    assert_eq!(parse_page(parse_query(Some("page%5B%5D=16")).get("page").map(String::as_str)), Some(16));
    assert_eq!(summary_pagination(&query).unwrap_err().status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(normalize_search(&"😀".repeat(64)), "😀".repeat(32));
    let error = std::io::Error::other("database unavailable");
    assert_eq!(safe_error(&error), "database unavailable");
    assert_eq!(safe_error(&std::io::Error::other("database error 42")), "database error 42");
    assert_eq!(redact_identifiers("owner 123 customer xyz", &["123".into(), "xyz".into()]), "owner [redacted] customer [redacted]");
    let secret = std::io::Error::other("mongodb://user:password@example.invalid");
    assert_eq!(safe_error(&secret), "sensitive diagnostic redacted");
}
#[test]
fn error_envelopes_and_no_store_header() {
    use dima_rust::stream_timeline_route::{StandardErrorBody, TimelineErrorBody};
    assert_eq!(serde_json::to_string(&TimelineErrorBody { error: true, status: 400, message: "Invalid channel" }).unwrap(), r#"{"error":true,"status":400,"message":"Invalid channel"}"#);
    assert_eq!(serde_json::to_string(&StandardErrorBody { error: true, message: "Invalid summary ID", status: 400 }).unwrap(), r#"{"error":true,"message":"Invalid summary ID","status":400}"#);
    let response = RouteError { status: StatusCode::BAD_REQUEST, message: "Invalid stream", envelope: Envelope::Timeline, no_store: true, diagnostic: None }.into_response();
    assert_eq!(response.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
}

#[path = "support/stream_timeline_routes_support.rs"]
mod stream_timeline_routes_support;
#[path = "support/api_auth_support.rs"]
mod api_auth_support;

#[tokio::test]
#[ignore = "requires the external source oracle fixture and loopback test servers"]
async fn replay_timeline_source_cases() {
    use dima_rust::{api_admin::AdminService, api_auth::{AuthConfig, AuthService}, stream_timeline_route::StreamTimelineRouteService, stream_summary_route::StreamSummaryRouteService, analytics_route::AnalyticsRouteService};
    use std::sync::Arc;
    let fixture = stream_timeline_routes_support::fixture();
    let cases = fixture["cases"].as_array().expect("oracle cases");
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("HTTP client");
    let mongo = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100").await.expect("unused loopback Mongo handle");
    let database = mongo.database("stream_timeline_auth_fixture");
    let mut replayed = 0;
    for case in cases {
        let request = &case["request"];
        let path = request["url"].as_str().expect("path");
        let name = case["name"].as_str().expect("name");
        let user = request["user"].as_str();
        let stub = api_auth_support::RedisStub::start(api_auth_support::StubFailure::None, true).await;
        let mut cache = stub.connection().await;
        let _: i64 = redis::cmd("HSET").arg("token:fixture-token").arg("id").arg(user.unwrap_or("123")).arg("login").arg("fixture").arg("display_name").arg("Fixture").arg("profile_image_url").arg("").query_async(&mut cache).await.expect("cache seed");
        let provider = api_auth_support::Provider::start(vec![]).await;
        let (logger, _, _) = api_auth_support::capture_logger();
        let auth = AuthService::new(AuthConfig::new(provider.validate_url(), provider.users_url()).with_client_id("fixture"), http.clone(), cache, dima_rust::schemas::users::schema().native_collection(&database), Some(logger.clone())).expect("auth");
        let admin = AdminService::new(database.collection("admins"), Some(logger.clone()));
        let data = Arc::new(stream_timeline_routes_support::TimelineCase { name: name.to_owned() });
        let app = if path.starts_with("/stream-summaries/") {
            let route = StreamSummaryRouteService::new(database.clone(), admin, logger).with_data(data);
            axum::Router::new().nest("/stream-summaries", route.protected_router(&auth))
        } else if path.starts_with("/analytics/follows/") {
            let timeline = StreamTimelineRouteService::new(database.clone(), admin, logger.clone()).with_data(data.clone());
            let analytics = AnalyticsRouteService::from_data(data, timeline, logger);
            axum::Router::new().nest("/analytics", analytics.protected_router(&auth))
        } else {
            let route = StreamTimelineRouteService::new(database.clone(), admin, logger).with_data(data);
            axum::Router::new().nest("/analytics", route.protected_router(&auth))
        };
        let app = api_auth_support::serve_app(app, "fixture").await;
        if name == "summary-list-ok" || name == "follow-ok" {
            let denied = http.get(api_auth_support::app_url(app.addr, path)).send().await.expect("protected missing-token response");
            assert_eq!(denied.status(), StatusCode::UNAUTHORIZED, "{name}");
            assert!(denied.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("application/json")));
            assert_eq!(denied.text().await.expect("missing-token body"), r#"{"error":true,"message":"No token provided","status":401,"type":"no_token"}"#);
        }
        let method = reqwest::Method::from_bytes(request["method"].as_str().expect("method").as_bytes()).expect("HTTP method");
        let mut call = http.request(method, api_auth_support::app_url(app.addr, path));
        if user.is_some() { call = call.bearer_auth("fixture-token"); }
        if let Some(body) = request["body"].as_str() { call = call.header("content-type", "application/json").body(body.to_owned()); }
        let response = call.send().await.expect("loopback response");
        let status = response.status().as_u16();
        let cache_control = response.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let content_type = response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let body_text = response.text().await.expect("native body");
        let body: serde_json::Value = serde_json::from_str(&body_text).expect("native JSON");
        let expected = &case["expected"];
        if name == "marker-put-malformed" {
            assert_eq!(status, expected["status"].as_u64().expect("status") as u16, "{name}");
            assert_eq!(body, serde_json::json!({"error":true,"status":400,"message":"Invalid JSON body"}));
            assert!(expected["contentType"].as_str().is_some_and(|v| v.starts_with("text/html")));
            assert!(content_type.as_deref().is_some_and(|v| v.starts_with("application/json")));
        } else {
            stream_timeline_routes_support::assert_case(&fixture, name, status, &body);
            if name == "missing-token" {
                let exact = r#"{"error":true,"message":"No token provided","status":401,"type":"no_token"}"#;
                assert_eq!(body_text, exact);
                assert_eq!(expected["bodyText"].as_str(), Some(exact));
                assert!(content_type.as_deref().is_some_and(|v| v.starts_with("application/json")));
                assert!(expected["contentType"].as_str().is_some_and(|v| v.starts_with("application/json")));
            } else {
                assert_eq!(content_type.as_deref(), expected["contentType"].as_str(), "{name}: content type");
            }
        }
        assert_eq!(cache_control.as_deref(), expected["cacheControl"].as_str(), "{name}: cache control");
        replayed += 1;
    }
    assert_eq!(replayed, 31, "all source cases");
}

/// This exercises the protected timeline gate using loopback-only test stubs.
/// The malformed channel is rejected before any MongoDB operation is needed.
#[tokio::test]
#[ignore = "requires the external source oracle fixture and loopback test servers"]
async fn protected_timeline_gate_replays_bad_channel() {
    use dima_rust::{api_admin::AdminService, api_auth::{AuthConfig, AuthService}, stream_timeline_route::StreamTimelineRouteService};
    let fixture = stream_timeline_routes_support::fixture();
    let cache_server = api_auth_support::RedisStub::start(api_auth_support::StubFailure::None, true).await;
    let mut cache = cache_server.connection().await;
    let _: i64 = redis::cmd("HSET").arg("token:fixture-token").arg("id").arg("123").arg("login").arg("fixture").arg("display_name").arg("Fixture").arg("profile_image_url").arg("").query_async(&mut cache).await.expect("cache seed");
    let provider = api_auth_support::Provider::start(vec![]).await;
    let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100").await.expect("loopback Mongo handle");
    let database = client.database("stream_timeline_auth_fixture");
    let (logger, _, _) = api_auth_support::capture_logger();
    let http = reqwest::Client::new();
    let config = AuthConfig::new(provider.validate_url(), provider.users_url()).with_client_id("fixture");
    let auth = AuthService::new(config, http.clone(), cache, dima_rust::schemas::users::schema().native_collection(&database), Some(logger.clone())).expect("auth configuration");
    let admin = AdminService::new(database.collection("admins"), Some(logger.clone()));
    let route = StreamTimelineRouteService::new(database, admin, logger);
    let app = api_auth_support::serve_app(route.protected_router(&auth), "fixture").await;
    let url = api_auth_support::app_url(app.addr, "/streams/abc");
    let response = http.get(&url).send().await.expect("unauthenticated response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.json::<serde_json::Value>().await.expect("auth rejection JSON"), serde_json::json!({"error":true,"message":"No token provided","status":401,"type":"no_token"}));
    let response = http.get(&url).bearer_auth("fixture-token").send().await.expect("authenticated response");
    let status = response.status().as_u16();
    let cache_control = response.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body: serde_json::Value = response.json().await.expect("response JSON");
    stream_timeline_routes_support::assert_case(&fixture, "bad-channel", status, &body);
    assert_eq!(cache_control.as_deref(), stream_timeline_routes_support::fixture_case(&fixture, "bad-channel")["cacheControl"].as_str());
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn source_fixture_has_authored_boundary_cases() {
    let fixture = stream_timeline_routes_support::fixture();
    assert_eq!(stream_timeline_routes_support::fixture_case_names(&fixture), vec![
        "missing-token", "bad-channel", "access-denied", "bad-page", "list", "invalid-stream", "details-ok", "missing-stream",
        "compare-free", "compare-ok", "people-ok", "people-free", "moments-ok", "moments-invalid", "credits-ok", "credits-free",
        "marker-put-ok", "marker-fraction-inside", "marker-fraction-end", "marker-invalid-date", "marker-put-invalid", "marker-put-malformed", "marker-delete-ok", "marker-delete-invalid",
        "summary-list-ok", "summary-forbidden", "summary-detail-ok", "summary-invalid-id", "follow-missing", "follow-ok", "follow-forbidden",
    ]);
    stream_timeline_routes_support::assert_case(&fixture, "missing-token", 401, &serde_json::json!({"error": true, "message": "No token provided", "status": 401, "type": "no_token"}));
}
