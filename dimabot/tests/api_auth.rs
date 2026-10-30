//! Functional checks for the native API authentication middleware.
//!
//! Fixture-backed suites run only against the task-owned loopback Mongo/Redis
//! containers created by the guarded migration driver. The Twitch provider is a
//! real loopback Axum server, the protected endpoint is a real Axum router served
//! over HTTP, and the cache/database calls use the concrete production clients.
//! No Twitch credential or production service is contacted.

#![cfg(feature = "api-auth")]

#[path = "support/api_auth_support.rs"]
mod support;

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, header::AUTHORIZATION},
    response::{IntoResponse, Response},
    routing::get,
};
use dima_rust::{
    api_auth::{
        AuthConfig, AuthRequest, AuthService, AuthenticatedUser, CachedTokenData, ErrorResponse,
        TwitchTokenValidation, TwitchUser, TwitchUsersResponse, activity_touch_key,
        extract_bearer_token, token_cache_key, types::ERROR_TYPE_INTERNAL_ERROR,
    },
    utils::observability::telemetry_context,
};
use mongodb::{
    bson::{Bson, DateTime, Document, doc},
    options::ClientOptions,
};
use redis::AsyncCommands;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{
    AppServer, Fixtures, Provider, ProviderReply, RedisStub, StubFailure, app_url, assert_case,
    capture_logger, fixture, fixture_case, fixture_case_names, fixtures, get_with_token,
};

const FIXTURE_CASES: [&str; 27] = [
    "no-header",
    "bearer-empty",
    "raw-token",
    "bearer-token",
    "lowercase-bearer",
    "capitalized-header",
    "cache-hit",
    "cache-hit-channel",
    "cache-hit-empty-profile",
    "cache-empty-id",
    "cache-miss",
    "cache-miss-channel",
    "validate-401",
    "validate-network",
    "validate-json",
    "users-http-error",
    "users-json-error",
    "users-empty",
    "cache-read-error",
    "cache-write-error",
    "cache-expire-error",
    "activity-warm",
    "activity-nomatch",
    "activity-mongo-error",
    "activity-exists-error",
    "activity-set-error",
    "outer-error",
];

fn validate_json() -> Value {
    json!({
        "client_id": "fixture-client",
        "login": "alpha",
        "scopes": ["user:read:email"],
        "user_id": "1001",
        "expires_in": 14124,
    })
}

fn validate_ok() -> ProviderReply {
    ProviderReply::Json {
        status: 200,
        body: validate_json(),
    }
}

fn users_ok() -> ProviderReply {
    ProviderReply::Json {
        status: 200,
        body: json!({"data": [
            {
                "id": "1001",
                "login": "alpha",
                "display_name": "Alpha",
                "profile_image_url": "https://static.invalid/alpha.png",
                "type": "",
                "broadcaster_type": "",
                "created_at": "2020-01-01T00:00:00Z"
            },
            {
                "id": "1002",
                "login": "beta",
                "display_name": "Beta",
                "profile_image_url": "https://static.invalid/beta.png",
                "type": "staff",
                "broadcaster_type": "partner",
                "created_at": "2021-01-01T00:00:00Z"
            }
        ]}),
    }
}

async fn protected_handler(State(calls): State<Arc<AtomicUsize>>, request: Request) -> Response {
    calls.fetch_add(1, Ordering::SeqCst);
    let auth = AuthRequest::from_extensions(request.extensions());
    let channel = telemetry_context()
        .map(|context| context.channel)
        .unwrap_or_default();
    Json(json!({"user": auth.user, "bind": channel, "next": 1})).into_response()
}

fn protected_router(calls: Arc<AtomicUsize>) -> Router<()> {
    Router::new()
        .route("/api/{channelID}/protected", get(protected_handler))
        .route("/api/protected", get(protected_handler))
        .with_state(calls)
}

async fn start_app(service: &AuthService, calls: Arc<AtomicUsize>) -> AppServer {
    support::serve_app(service.protect(protected_router(calls)), "unbound").await
}

fn build_service(
    config: AuthConfig,
    redis: redis::aio::ConnectionManager,
    database: &mongodb::Database,
    logger: Option<dima_rust::utils::logger::Logger>,
) -> AuthService {
    AuthService::new(
        config,
        reqwest::Client::new(),
        redis,
        database.collection::<Document>("users"),
        logger,
    )
    .expect("valid auth service configuration")
}

fn config_for(provider: &Provider) -> AuthConfig {
    AuthConfig::new(provider.validate_url(), provider.users_url()).with_client_id("fixture-client")
}

async fn seed_identity(fx: &Fixtures, token: &str, id: &str, profile: &str) {
    let mut connection = fx.redis.clone();
    let _: () = connection
        .hset_multiple(
            token_cache_key(token),
            &[
                ("id", id),
                ("login", "alpha"),
                ("display_name", "Alpha"),
                ("profile_image_url", profile),
            ],
        )
        .await
        .expect("seed identity hash");
    let _: bool = connection
        .expire(token_cache_key(token), 9000)
        .await
        .expect("seed identity ttl");
}

fn alpha_user(id: &str) -> AuthenticatedUser {
    AuthenticatedUser {
        id: id.into(),
        login: "alpha".into(),
        display_name: "Alpha".into(),
        profile_image_url: Some("https://static.invalid/alpha.png".into()),
    }
}

#[tokio::test]
async fn invalid_urls_are_rejected_before_any_io() {
    let stub = RedisStub::start(StubFailure::None, false).await;
    let redis = stub.connection().await;
    let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/none")
        .await
        .expect("client construction is lazy");
    let database = client.database("api_auth_config");
    for (validate, users) in [
        ("not-a-url", "https://api.twitch.tv/helix/users"),
        ("https://id.twitch.tv/oauth2/validate", "not-a-url"),
        (
            "ftp://id.twitch.tv/oauth2/validate",
            "https://api.twitch.tv/helix/users",
        ),
    ] {
        let error = AuthService::new(
            AuthConfig::new(validate, users),
            reqwest::Client::new(),
            redis.clone(),
            database.collection::<Document>("users"),
            None,
        )
        .err()
        .expect("invalid configuration must be rejected");
        assert!(error.message().contains("absolute http(s) URL"));
    }
    assert_eq!(
        AuthConfig::production().validate_url(),
        "https://id.twitch.tv/oauth2/validate"
    );
    assert_eq!(
        AuthConfig::production().users_url(),
        "https://api.twitch.tv/helix/users"
    );
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn declared_types_map_to_the_source_interfaces() {
    let fixture = fixture();
    let interface = |name: &str| -> Vec<String> {
        let mut members: Vec<String> = fixture["metadata"]["types"]["interfaces"][name]["members"]
            .as_array()
            .expect("interface members")
            .iter()
            .map(|member| member["name"].as_str().expect("member name").to_owned())
            .collect();
        members.sort();
        members
    };
    let keys = |value: Value| -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort();
        keys
    };
    let user = alpha_user("1001");
    assert_eq!(
        keys(serde_json::to_value(&user).unwrap()),
        interface("AuthenticatedUser")
    );
    assert_eq!(
        keys(serde_json::to_value(AuthRequest::from(user.clone())).unwrap()),
        interface("AuthRequest")
    );

    assert_eq!(
        keys(
            serde_json::to_value(TwitchTokenValidation {
                client_id: "fixture-client".into(),
                login: "alpha".into(),
                scopes: vec!["user:read:email".into()],
                user_id: "1001".into(),
                expires_in: 14124.0,
            })
            .unwrap()
        ),
        interface("TwitchTokenValidation")
    );

    assert_eq!(
        keys(
            serde_json::to_value(TwitchUser {
                id: "1001".into(),
                login: "alpha".into(),
                display_name: "Alpha".into(),
                profile_image_url: "https://static.invalid/alpha.png".into(),
                r#type: String::new(),
                broadcaster_type: String::new(),
                created_at: "2020-01-01T00:00:00Z".into(),
            })
            .unwrap()
        ),
        interface("TwitchUser")
    );

    assert_eq!(
        keys(serde_json::to_value(TwitchUsersResponse::default()).unwrap()),
        interface("TwitchUsersResponse")
    );

    let mut cached_interface = interface("CachedTokenData");
    cached_interface.extend(interface("AuthenticatedUser"));
    cached_interface.sort();
    assert_eq!(
        keys(serde_json::to_value(CachedTokenData::new(user, 1_700_000_000_000.0)).unwrap()),
        cached_interface
    );

    assert_eq!(
        keys(serde_json::to_value(ErrorResponse::no_token()).unwrap()),
        interface("ErrorResponse")
    );
    assert_eq!(
        fixture["metadata"]["types"]["interfaces"]
            .as_object()
            .unwrap()
            .len(),
        7
    );
    assert_eq!(
        fixture["metadata"]["types"]["interfaces"]["CachedTokenData"]["extends"],
        json!(["AuthenticatedUser"])
    );
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn fixture_metadata_matches_the_source_snapshot() {
    let fixture = fixture();
    let metadata = &fixture["metadata"];
    assert_eq!(
        metadata["middleware"]["exports"]["authMiddleware"]["parameters"],
        json!(["AuthRequest", "Response", "NextFunction"])
    );
    assert_eq!(
        metadata["middleware"]["exports"]["authMiddleware"]["returns"],
        "Promise<void>"
    );
    assert_eq!(metadata["middleware"]["isTokenCachedReferences"], 1);
    let declarations: Vec<&str> = metadata["middleware"]["declarations"]
        .as_array()
        .expect("declarations")
        .iter()
        .map(|entry| entry["name"].as_str().expect("declaration name"))
        .collect();
    for expected in [
        "authMiddleware",
        "touchLastAppActivity",
        "validateTwitchToken",
        "getUserFromToken",
        "getCachedToken",
        "cacheToken",
    ] {
        assert!(declarations.contains(&expected), "{expected}");
    }

    let hashes = &metadata["nativeHashes"];
    for file in [
        "src/middleware/auth.middleware.rs",
        "src/middleware/types.rs",
        "tests/fixtures/api_auth_reference.cjs",
    ] {
        let expected = hashes[file].as_str().expect("native hash");
        let actual = support::sha256_hex(
            &std::fs::read(format!("{}/{file}", env!("CARGO_MANIFEST_DIR"))).expect("native file"),
        );
        assert_eq!(actual, expected, "{file}");
    }
    let pins = metadata["pins"].as_object().expect("source pins");
    for (file, expected) in pins {
        // The compiler pin is checked through TYPESCRIPT_SHA256 below; the
        // mounted node_modules is not part of the read-only source snapshot.
        if file.starts_with("node_modules/") {
            continue;
        }
        let actual = support::sha256_hex(
            &std::fs::read(format!("{}/{file}", env!("CARGO_MANIFEST_DIR"))).expect("pinned file"),
        );
        assert_eq!(&actual, expected.as_str().expect("pin"), "{file}");
    }
    assert_eq!(support::NODE_SHA256, metadata["nodeSha"].as_str().unwrap());
    assert_eq!(metadata["versions"]["typescript"], "5.9.3");
    assert_eq!(
        support::TYPESCRIPT_SHA256,
        pins["node_modules/typescript/lib/typescript.js"]
            .as_str()
            .unwrap()
    );
    assert_eq!(metadata["constants"]["cacheKeyPrefix"], "token:");
    assert_eq!(metadata["constants"]["cacheTtl"], 14000);
    assert_eq!(metadata["constants"]["activityTouchTtl"], 86400);
    assert_eq!(token_cache_key("x"), "token:x");
    assert_eq!(activity_touch_key("x"), "twitch:x:last_app_activity_touch");
    assert_eq!(fixture_case_names(&fixture), FIXTURE_CASES);
    assert_eq!(
        metadata["differences"]
            .as_array()
            .expect("differences")
            .len(),
        4
    );
}

type HeaderCase = (&'static str, Option<(&'static str, String)>, Option<String>);

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn header_forms_match_the_source() {
    let fixture = fixture();
    let fx = fixtures("headers").await;
    let raw = format!("{}-raw", fx.stem);
    let bearer = format!("{}-bearer", fx.stem);
    let lower = format!("bearer {}-lower", fx.stem);
    let capitalized = format!("{}-cap", fx.stem);
    // HTTP parsers trim trailing whitespace, so the "Bearer " empty-token branch
    // is checked directly against the shared extractor while the remaining forms
    // are exercised through the real server.
    let mut empty_headers = HeaderMap::new();
    empty_headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer "));
    let empty = extract_bearer_token(&empty_headers).expect_err("empty token body");
    assert_eq!(
        serde_json::to_value(&empty).unwrap(),
        fixture_case(&fixture, "bearer-empty")["body"]
    );
    let cases: [HeaderCase; 5] = [
        ("no-header", None, None),
        (
            "raw-token",
            Some(("authorization", raw.clone())),
            Some(raw.clone()),
        ),
        (
            "bearer-token",
            Some(("authorization", format!("Bearer {bearer}"))),
            Some(bearer.clone()),
        ),
        (
            "lowercase-bearer",
            Some(("authorization", lower.clone())),
            Some(lower.clone()),
        ),
        (
            "capitalized-header",
            Some(("Authorization", format!("Bearer {capitalized}"))),
            Some(capitalized.clone()),
        ),
    ];
    let tokens: Vec<String> = cases
        .iter()
        .filter_map(|(_, _, token)| token.clone())
        .collect();
    fx.purge(&tokens, &["1001".to_owned()]).await;
    for (case, header, token) in cases {
        let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
        let (logger, console, _) = capture_logger();
        let service = build_service(
            config_for(&provider),
            fx.redis.clone(),
            &fx.database,
            Some(logger),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let app = start_app(&service, calls.clone()).await;
        let headers: Vec<(&str, String)> = header.into_iter().collect();
        let (status, body) = get_with_token(
            &reqwest::Client::new(),
            &app_url(app.addr, "/api/protected"),
            &headers
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect::<Vec<_>>(),
        )
        .await;
        assert_case(&fixture, case, status, &body);
        match token {
            None => {
                assert_eq!(provider.requests().len(), 0, "{case}");
                assert_eq!(calls.load(Ordering::SeqCst), 0, "{case}");
                assert!(console.error_functions().is_empty(), "{case}");
            }
            Some(token) => {
                let requests = provider.requests();
                assert_eq!(requests.len(), 2, "{case}");
                assert_eq!(
                    requests[0].authorization.as_deref(),
                    Some(format!("Bearer {token}").as_str()),
                    "{case}"
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1, "{case}");
                let ttl = support::ttl(&fx.raw_redis, &token_cache_key(&token)).await;
                assert!((1..=14000).contains(&ttl), "{case} cache ttl {ttl}");
                let mut connection = fx.redis.clone();
                let cached: std::collections::HashMap<String, String> = connection
                    .hgetall(token_cache_key(&token))
                    .await
                    .expect("cached identity");
                assert_eq!(cached.get("id").map(String::as_str), Some("1001"), "{case}");
                assert!(
                    !cached.contains_key("cached_at"),
                    "cached_at is a type-only field"
                );
            }
        }
    }
    fx.cleanup(&tokens, &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn cache_hits_bypass_the_provider() {
    let fixture = fixture();
    let fx = fixtures("cache-hit").await;
    let provider = Provider::start(vec![]).await;
    let (logger, console, _) = capture_logger();
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let client = reqwest::Client::new();
    let token = fx.token("cached");
    let empty_token = fx.token("empty-profile");
    fx.purge(&[token.clone(), empty_token.clone()], &["1001".to_owned()])
        .await;
    seed_identity(&fx, &token, "1001", "https://static.invalid/alpha.png").await;

    let (status, body) = get_with_token(
        &client,
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-hit", status, &body);
    assert_eq!(body["user"]["id"], "1001");
    assert_eq!(body["bind"], "1001");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.requests().len(), 0);
    assert!(console.error_functions().is_empty());

    let (status, body) = get_with_token(
        &client,
        &app_url(app.addr, "/api/chan-77/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-hit-channel", status, &body);
    assert_eq!(body["bind"], "chan-77");

    seed_identity(&fx, &empty_token, "1001", "").await;
    let (status, body) = get_with_token(
        &client,
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {empty_token}"))],
    )
    .await;
    assert_case(&fixture, "cache-hit-empty-profile", status, &body);
    assert_eq!(body["user"]["profile_image_url"], "");

    assert_eq!(provider.requests().len(), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    fx.cleanup(&[token, empty_token], &["1001".to_owned()])
        .await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn cache_miss_validates_caches_and_touches_activity() {
    let fixture = fixture();
    let fx = fixtures("cache-miss").await;
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let (logger, console, _) = capture_logger();
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let client = reqwest::Client::new();
    let token = fx.token("miss");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;

    fx.database
        .collection::<Document>("users")
        .insert_one(doc! {
            "_id": mongodb::bson::oid::ObjectId::new(),
            "name": "Alpha",
            "accounts": [{"type": "twitch", "id": "1001", "name": "alpha"}],
            "last_app_activity_at": Bson::DateTime(DateTime::from_millis(0)),
            "created_at": Bson::DateTime(DateTime::from_millis(0)),
            "updated_at": Bson::DateTime(DateTime::from_millis(0)),
        })
        .await
        .expect("insert users document");

    let (status, body) = get_with_token(
        &client,
        &app_url(app.addr, "/api/chan-9/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-miss-channel", status, &body);
    assert_eq!(body["user"]["id"], "1001");
    assert_eq!(body["user"]["login"], "alpha");
    assert_eq!(body["user"]["display_name"], "Alpha");
    assert_eq!(
        body["user"]["profile_image_url"],
        "https://static.invalid/alpha.png"
    );
    assert_eq!(body["bind"], "chan-9");
    assert_eq!(body["next"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/oauth2/validate");
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some(format!("Bearer {token}").as_str())
    );
    assert_eq!(requests[1].path, "/helix/users");
    assert_eq!(requests[1].client_id.as_deref(), Some("fixture-client"));

    let mut connection = fx.redis.clone();
    let cached: std::collections::HashMap<String, String> = connection
        .hgetall(token_cache_key(&token))
        .await
        .expect("cached hash");
    assert_eq!(cached.get("id").map(String::as_str), Some("1001"));
    assert_eq!(cached.get("login").map(String::as_str), Some("alpha"));
    assert_eq!(
        cached.get("display_name").map(String::as_str),
        Some("Alpha")
    );
    assert_eq!(
        cached.get("profile_image_url").map(String::as_str),
        Some("https://static.invalid/alpha.png")
    );
    assert!(!cached.contains_key("cached_at"));
    let cache_ttl = support::ttl(&fx.raw_redis, &token_cache_key(&token)).await;
    assert!((1..=14000).contains(&cache_ttl), "cache ttl {cache_ttl}");

    let stored = fx
        .database
        .collection::<Document>("users")
        .find_one(doc! {"accounts.id": "1001"})
        .await
        .expect("query users")
        .expect("users document");
    let activity = stored
        .get("last_app_activity_at")
        .and_then(Bson::as_datetime)
        .expect("activity timestamp");
    support::assert_relative_to_now(activity.timestamp_millis(), 120_000);
    assert!(
        stored
            .get("updated_at")
            .and_then(Bson::as_datetime)
            .is_some()
    );
    let touch_ttl = support::ttl(&fx.raw_redis, &activity_touch_key("1001")).await;
    assert!((1..=86400).contains(&touch_ttl), "touch ttl {touch_ttl}");
    assert!(console.error_functions().is_empty());

    // A second request is served from the cache and never reaches Twitch.
    let (status, body) = get_with_token(
        &client,
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-miss", status, &body);
    assert_eq!(body["bind"], "1001");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(provider.pending_replies(), 0);

    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn provider_failures_keep_the_source_messages() {
    let fixture = fixture();
    let fx = fixtures("failures").await;
    let cases: [(&str, Vec<ProviderReply>, &str, Option<&str>); 5] = [
        (
            "validate-401",
            vec![ProviderReply::Json {
                status: 401,
                body: json!({}),
            }],
            "validate-401",
            None,
        ),
        (
            "validate-json",
            vec![ProviderReply::InvalidJson { status: 200 }],
            "validate-json",
            Some("validateTwitchToken"),
        ),
        (
            "users-http-error",
            vec![
                validate_ok(),
                ProviderReply::Json {
                    status: 403,
                    body: json!({"error": "Forbidden"}),
                },
            ],
            "users-http-error",
            None,
        ),
        (
            "users-json-error",
            vec![validate_ok(), ProviderReply::InvalidJson { status: 200 }],
            "users-json-error",
            Some("getUserFromToken"),
        ),
        (
            "users-empty",
            vec![
                validate_ok(),
                ProviderReply::Json {
                    status: 200,
                    body: json!({"data": []}),
                },
            ],
            "users-empty",
            None,
        ),
    ];
    for (name, replies, case, expected_log) in cases {
        let provider = Provider::start(replies).await;
        let (logger, console, _) = capture_logger();
        let service = build_service(
            config_for(&provider),
            fx.redis.clone(),
            &fx.database,
            Some(logger),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let app = start_app(&service, calls.clone()).await;
        let token = fx.token(&name.replace('-', "_"));
        fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
            .await;
        let (status, body) = get_with_token(
            &reqwest::Client::new(),
            &app_url(app.addr, "/api/protected"),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_case(&fixture, case, status, &body);
        let functions = console.error_functions();
        match expected_log {
            Some(function) => assert_eq!(functions, vec![function.to_owned()], "{name}"),
            None => assert!(functions.is_empty(), "{name}: {functions:?}"),
        }
        if matches!(case, "users-empty" | "validate-401" | "users-http-error") {
            assert_eq!(calls.load(Ordering::SeqCst), 0, "{name}");
            let mut connection = fx.redis.clone();
            let existed: bool = connection
                .exists(token_cache_key(&token))
                .await
                .expect("cache exists");
            assert!(!existed, "{name} must not cache a failed identity");
        }
    }

    // A hash with an empty id is a miss, not a cached identity.
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let (logger, console, _) = capture_logger();
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("empty_id");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    let mut connection = fx.redis.clone();
    let _: () = connection
        .hset_multiple(token_cache_key(&token), &[("id", ""), ("login", "alpha")])
        .await
        .expect("seed empty-id hash");
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-empty-id", status, &body);
    assert_eq!(body["user"]["id"], "1001");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(console.error_functions().is_empty());

    // Transport failure with no listener at all.
    let (logger, console, _) = capture_logger();
    let closed = support::closed_endpoint().await;
    let service = build_service(
        AuthConfig::new(
            format!("{closed}/oauth2/validate"),
            format!("{closed}/helix/users"),
        )
        .with_client_id("fixture-client"),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", "Bearer transport-token")],
    )
    .await;
    assert_case(&fixture, "validate-network", status, &body);
    assert_eq!(
        console.error_functions(),
        vec!["validateTwitchToken".to_owned()]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn cache_failures_do_not_block_authentication() {
    let fixture = fixture();
    let fx = fixtures("cache-errors").await;
    let cases: [(&str, StubFailure, Vec<&str>, &str); 6] = [
        (
            "cache-read-error",
            StubFailure::Hgetall,
            vec!["getCachedToken"],
            "cache-read-error",
        ),
        (
            "cache-write-error",
            StubFailure::Hset,
            vec!["cacheToken"],
            "cache-write-error",
        ),
        (
            "cache-expire-error",
            StubFailure::Expire,
            vec!["cacheToken", "touchLastAppActivity"],
            "cache-expire-error",
        ),
        (
            "activity-exists-error",
            StubFailure::Exists,
            vec!["touchLastAppActivity"],
            "activity-exists-error",
        ),
        (
            "activity-set-error",
            StubFailure::Set,
            vec!["touchLastAppActivity"],
            "activity-set-error",
        ),
        (
            "cache-outage",
            StubFailure::CloseAll,
            vec!["getCachedToken", "cacheToken", "touchLastAppActivity"],
            "",
        ),
    ];
    for (name, failure, expected_log, case) in cases {
        let stub = RedisStub::start(failure, false).await;
        let redis = stub.connection().await;
        let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
        let (logger, console, _) = capture_logger();
        let service = build_service(config_for(&provider), redis, &fx.database, Some(logger));
        let calls = Arc::new(AtomicUsize::new(0));
        let app = start_app(&service, calls.clone()).await;
        let token = fx.token(&name.replace('-', "_"));
        fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
            .await;
        let (status, body) = get_with_token(
            &reqwest::Client::new(),
            &app_url(app.addr, "/api/protected"),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        assert_eq!(status, 200, "{name}");
        if case.is_empty() {
            assert_eq!(body["user"]["id"], "1001", "{name}");
            assert_eq!(body["next"], 1, "{name}");
        } else {
            assert_case(&fixture, case, status, &body);
        }
        assert_eq!(
            console.error_functions(),
            expected_log
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>(),
            "{name}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{name}");
        assert_eq!(provider.requests().len(), 2, "{name}");
        match name {
            "cache-read-error" => assert_eq!(
                stub.command_names(),
                vec!["HGETALL", "HSET", "EXPIRE", "EXISTS", "SET", "EXPIRE"]
            ),
            "cache-write-error" => assert_eq!(
                stub.command_names(),
                vec!["HGETALL", "HSET", "EXISTS", "SET", "EXPIRE"]
            ),
            "activity-exists-error" => {
                assert_eq!(
                    stub.command_names(),
                    vec!["HGETALL", "HSET", "EXPIRE", "EXISTS"]
                );
            }
            "activity-set-error" => {
                assert_eq!(
                    stub.command_names(),
                    vec!["HGETALL", "HSET", "EXPIRE", "EXISTS", "SET"]
                );
            }
            _ => {}
        }
    }

    // A wrong-type cache key is a real Redis failure on read and write.
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let (logger, console, _) = capture_logger();
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("wrongtype");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    let mut connection = fx.redis.clone();
    let _: () = connection
        .set(token_cache_key(&token), "not-a-hash")
        .await
        .expect("seed string key");
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-read-error", status, &body);
    assert_eq!(
        console.error_functions(),
        vec!["getCachedToken".to_owned(), "cacheToken".to_owned()]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn cache_protocol_matches_the_source_order_and_ttls() {
    let fixture = fixture();
    let fx = fixtures("protocol").await;
    let stub = RedisStub::start(StubFailure::None, false).await;
    let redis = stub.connection().await;
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let service = build_service(config_for(&provider), redis, &fx.database, None);
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("protocol");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "cache-miss", status, &body);
    assert_eq!(body["user"]["id"], "1001");
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let expected = fixture_case(&fixture, "cache-miss");
    let expected_ops: Vec<(String, String, Option<i64>)> = expected["redis"]
        .as_array()
        .expect("redis ops")
        .iter()
        .map(|entry| {
            (
                entry["op"].as_str().expect("op").to_owned(),
                entry["key"].as_str().expect("key").to_owned(),
                entry["ttl"].as_i64(),
            )
        })
        .collect();
    let actual_ops: Vec<(String, String, Option<i64>)> = stub
        .commands()
        .iter()
        .map(|command| {
            let name = command[0].to_ascii_uppercase();
            let ttl = if name == "EXPIRE" {
                command.get(2).and_then(|value| value.parse::<i64>().ok())
            } else {
                None
            };
            (name, command[1].clone(), ttl)
        })
        .collect();
    let normalized_expected: Vec<(String, String, Option<i64>)> = expected_ops
        .into_iter()
        .map(|(op, _key, ttl)| {
            let key = if op == "EXISTS" || op == "SET" || (op == "EXPIRE" && ttl != Some(14000)) {
                activity_touch_key("1001")
            } else {
                token_cache_key(&token)
            };
            (op, key, ttl)
        })
        .collect();
    assert_eq!(actual_ops, normalized_expected);
    let hash = stub.hash();
    let field = |name: &str| {
        hash.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(field("id"), Some("1001"));
    assert_eq!(field("login"), Some("alpha"));
    assert_eq!(field("display_name"), Some("Alpha"));
    assert_eq!(
        field("profile_image_url"),
        Some("https://static.invalid/alpha.png")
    );

    fx.cleanup(&[], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn activity_warm_skips_mongo() {
    let fixture = fixture();
    let fx = fixtures("activity-warm").await;
    let provider = Provider::start(vec![]).await;
    let (logger, console, _) = capture_logger();
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &fx.database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("warm");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    seed_identity(&fx, &token, "1001", "https://static.invalid/alpha.png").await;
    let users = fx.database.collection::<Document>("users");
    users
        .insert_one(doc! {
            "_id": mongodb::bson::oid::ObjectId::new(),
            "accounts": [{"type": "twitch", "id": "1001"}],
            "last_app_activity_at": Bson::DateTime(DateTime::from_millis(0)),
            "created_at": Bson::DateTime(DateTime::from_millis(0)),
            "updated_at": Bson::DateTime(DateTime::from_millis(0)),
        })
        .await
        .expect("insert users document");
    let mut connection = fx.redis.clone();
    let _: () = connection
        .set(activity_touch_key("1001"), "1")
        .await
        .expect("seed warm throttle");
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "activity-warm", status, &body);
    let stored = users
        .find_one(doc! {"accounts.id": "1001"})
        .await
        .expect("query users")
        .expect("users document");
    assert_eq!(
        stored
            .get("last_app_activity_at")
            .and_then(Bson::as_datetime)
            .expect("activity timestamp")
            .timestamp_millis(),
        0
    );
    assert_eq!(provider.requests().len(), 0);
    assert!(console.error_functions().is_empty());
    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn activity_missing_match_still_throttles() {
    let fixture = fixture();
    let fx = fixtures("activity-nomatch").await;
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let service = build_service(config_for(&provider), fx.redis.clone(), &fx.database, None);
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("nomatch");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "activity-nomatch", status, &body);
    let mut connection = fx.redis.clone();
    let exists: bool = connection
        .exists(activity_touch_key("1001"))
        .await
        .expect("throttle exists");
    assert!(exists, "missing user match must still throttle");
    let ttl = support::ttl(&fx.raw_redis, &activity_touch_key("1001")).await;
    assert!((1..=86400).contains(&ttl), "touch ttl {ttl}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        fx.database
            .collection::<Document>("users")
            .find_one(doc! {})
            .await
            .expect("query users")
            .is_none()
    );
    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn mongo_failure_is_logged_and_does_not_block() {
    let fixture = fixture();
    let fx = fixtures("mongo-error").await;
    let provider = Provider::start(vec![validate_ok(), users_ok()]).await;
    let (logger, console, _) = capture_logger();
    let closed = unreachable_mongo_uri().await;
    let mut options = ClientOptions::parse(&closed).await.expect("mongo options");
    options.server_selection_timeout = Some(Duration::from_millis(400));
    options.connect_timeout = Some(Duration::from_millis(400));
    let client = mongodb::Client::with_options(options).expect("unreachable client");
    let database = client.database("api_auth_unreachable");
    let service = build_service(
        config_for(&provider),
        fx.redis.clone(),
        &database,
        Some(logger),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let token = fx.token("mongo_error");
    fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
        .await;
    let (status, body) = get_with_token(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/protected"),
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_case(&fixture, "activity-mongo-error", status, &body);
    assert_eq!(body["user"]["id"], "1001");
    assert_eq!(
        console.error_functions(),
        vec!["touchLastAppActivity".to_owned()]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let mut connection = fx.redis.clone();
    let throttle: bool = connection
        .exists(activity_touch_key("1001"))
        .await
        .expect("throttle exists");
    assert!(
        !throttle,
        "a MongoDB failure aborts before the throttle write, matching the source"
    );
    fx.cleanup(&[token], &["1001".to_owned()]).await;
}

async fn unreachable_mongo_uri() -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("ephemeral listener");
    let addr: SocketAddr = listener.local_addr().expect("ephemeral address");
    drop(listener);
    format!("mongodb://{addr}/api_auth_unreachable?directConnection=true")
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn client_id_is_read_per_request_from_the_environment() {
    let fixture = fixture();
    let fx = fixtures("client-id").await;
    let provider = Provider::start(vec![
        validate_ok(),
        users_ok(),
        validate_ok(),
        users_ok(),
        validate_ok(),
        users_ok(),
    ])
    .await;
    let service = build_service(
        AuthConfig::new(provider.validate_url(), provider.users_url()),
        fx.redis.clone(),
        &fx.database,
        None,
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let app = start_app(&service, calls.clone()).await;
    let client = reqwest::Client::new();
    let expected = fixture["clientIdRefresh"].clone();
    let mut tokens = Vec::new();
    for (suffix, env_value, expected_headers) in [
        (
            "a",
            Some("client-a"),
            expected["first"]["headers"][1]["Client-Id"].clone(),
        ),
        (
            "b",
            Some("client-b"),
            expected["second"]["headers"][1]["Client-Id"].clone(),
        ),
        (
            "missing",
            None,
            expected["missing"]["headers"][1]["Client-Id"].clone(),
        ),
    ] {
        let token = fx.token(&format!("clientid_{suffix}"));
        fx.purge(std::slice::from_ref(&token), &["1001".to_owned()])
            .await;
        let guard = EnvGuard::set("CLIENT_ID", env_value);
        let result = get_with_token(
            &client,
            &app_url(app.addr, "/api/protected"),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
        drop(guard);
        assert_eq!(result.0, 200, "{suffix}");
        assert_eq!(result.1["user"]["id"], "1001", "{suffix}");
        tokens.push(token);
        let requests = provider.requests();
        let users_request = requests.last().expect("users request");
        if suffix == "missing" {
            // Documented difference: fetch(Headers) would send the string
            // "undefined"; the native client omits the header instead.
            assert_eq!(expected_headers, Value::Null);
            assert_eq!(users_request.client_id, None);
        } else {
            assert_eq!(
                users_request.client_id.as_deref(),
                expected_headers.as_str()
            );
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    fx.cleanup(&tokens, &["1001".to_owned()]).await;
}

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: Option<&str>) -> Self {
        let previous = std::env::var_os(key);
        unsafe {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match self.previous.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn error_type_constants_match_the_fixture() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    let types: Vec<&str> = cases
        .iter()
        .filter_map(|case| case["expected"]["body"]["type"].as_str())
        .collect();
    assert!(types.contains(&"no_token"));
    assert!(types.contains(&"invalid_token"));
    assert!(types.contains(&"user_fetch_failed"));
    assert!(types.contains(&"internal_error"));
    assert_eq!(ERROR_TYPE_INTERNAL_ERROR, "internal_error");
    assert_eq!(ErrorResponse::no_token().r#type, "no_token");
    assert_eq!(alpha_user("1001").id, "1001");
}
