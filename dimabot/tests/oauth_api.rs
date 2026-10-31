#![cfg(feature = "oauth-api")]
//! Native parity tests for the OAuth desktop-beta HTTP API.
//!
//! Pure tests need no MongoDB, Redis, network, or container. The ignored Mongo
//! flow is the only test in this file that opens those sockets, and only to
//! addresses the caller names. The ignored source-oracle comparison reads a
//! fixture file and does not open MongoDB, Redis, or Twitch.
//!
//! Ignored fixture contract (run this file with `--test-threads=1`):
//!   OAUTH_API_FIXTURE_ACK=disposable
//!   OAUTH_API_FIXTURE_MONGO_URI=mongodb://127.0.0.1:27017
//!   OAUTH_API_FIXTURE_REDIS_URL=redis://127.0.0.1:6379
//!   OAUTH_API_FIXTURE_DATABASE=oauth_api_fixture_<8-40 of [a-z0-9]>
//!   CLIENT_ID=<already set; this test does not write process environment>
//!
//! Accepted hosts are loopback (`127.0.0.1`, `localhost`, `[::1]`, `::1`) or
//! `oauth-api-mongo`, `oauth-api-redis`, `mongo-fixture`, and `redis-fixture`.
//! URIs must not carry a username or password. The named database must be empty.
//! Redis must contain no `oauth:*` keys. Cleanup drops that database and deletes
//! only `oauth:*` keys. It never calls `FLUSHDB` or the process Mongo/Redis pools.
//!
//! `PUBLIC_API_URL` and `DASHBOARD_URL` must be unset or usable absolute http(s)
//! URLs. The Twitch validate call goes to the loopback recorder in
//! `api_auth_support`. The test never contacts Twitch, a production cache, a
//! production database, or any other host.

#[path = "support/api_auth_support.rs"]
mod api_auth_support;
#[path = "support/oauth_support.rs"]
mod oauth_support;
#[path = "support/sha256.rs"]
mod sha256;

use api_auth_support::{Provider, ProviderReply};
use dima_rust::oauth_api::{
    catalog::{self, DESKTOP_REDIRECT_URIS, ErrorBody, ErrorHeaders},
    error_headers, hash, is_valid_secret, metadata_document, parse_scopes, secret,
    validate_redirect, validate_redirect_str, ACCESS_TTL_SECONDS, CODE_TTL_SECONDS,
    DESKTOP_CLIENT_ID, OAUTH_SCOPES, OAuthApiService, OAuthError, RATE_LIMIT_LUA, REFRESH_IDLE_MS,
    REQUEST_TTL_SECONDS, SESSION_ABSOLUTE_MS, UnwiredCreditsReader, UnwiredPetAccess, access_key,
    code_key, constant_time_eq, rate_key, request_key,
};
use futures_util::FutureExt;
use mongodb::bson::{Document, doc, oid::ObjectId};
use oauth_support::OauthFixture;
use serde_json::{Value, json};
use std::{net::SocketAddr, panic::AssertUnwindSafe, path::Path, time::Duration};

const METADATA_JSON: &str = concat!(
    r#"{"issuer":"https://api.domdimabot.com","authorization_endpoint":"https://api.domdimabot.com/oauth/authorize","#,
    r#""token_endpoint":"https://api.domdimabot.com/oauth/token","revocation_endpoint":"https://api.domdimabot.com/oauth/revoke","#,
    r#""scopes_supported":["profile:read","credits:read","desktop:connect","pet:read","pet:receive","pet:control","pet:playback:select"],"#,
    r#""response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"#,
    r#""code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"#,
    r#""authorization_response_iss_parameter_supported":true,"beta":{"client_id":"dima-desktop","protocol_version":1,"#,
    r#""access_token_lifetime":600,"websocket_endpoint":"wss://api.domdimabot.com/v1/desktop/ws","#,
    r#""socket_io":{"path":"/socket.io/","namespace":"/desktop","protocol_version":1},"#,
    r#""planned_scopes":["usage:read","pet:write","pet:interact"]}}"#,
);
const HASH_A: &str = "ypeBEsobvcr6wjGzmiPcTaeG7_gUfE5yuYB3ha_uSLs";
const BROWSER_TOKEN: &str = "browser-token-1";
const TWITCH_ID: &str = "12345";
const SCOPE: &str = "profile:read credits:read desktop:connect";
const REDIRECT: &str = "http://127.0.0.1:4567/oauth/callback";

#[test]
fn scope_parsing_matches_catalog() {
    assert_eq!(
        parse_scopes(&json!("profile:read credits:read")).unwrap(),
        vec!["profile:read", "credits:read"]
    );
    assert_eq!(
        parse_scopes(&json!("desktop:connect profile:read desktop:connect")).unwrap(),
        vec!["desktop:connect", "profile:read"]
    );
    assert_eq!(parse_scopes(&json!(catalog::active_scopes().join(" "))).unwrap(), catalog::active_scopes());
    for rejected in [
        json!("not-a-scope"),
        json!("usage:read"),
        json!("pet:write"),
        json!("pet:interact"),
        json!("profile:read usage:read"),
        json!(""),
        json!("profile:read  credits:read"),
        json!("a".repeat(501)),
        json!(true),
        json!(1),
        json!(null),
        json!(["profile:read"]),
    ] {
        assert_eq!(parse_scopes(&rejected), Err(OAuthError::InvalidScope));
    }
    assert!(OAUTH_SCOPES.iter().filter(|scope| scope.active).map(|scope| scope.name).eq(catalog::active_scopes()));
    assert!(OAUTH_SCOPES.iter().filter(|scope| !scope.active).map(|scope| scope.name).eq(catalog::inactive_scopes()));
}

#[test]
fn redirect_validation_matches_loopback_rules() {
    for accepted in [
        "http://127.0.0.1:4567/oauth/callback",
        "http://[::1]:4567/oauth/callback",
        "http://127.0.0.1:1/oauth/callback",
        "http://127.0.0.1:65535/oauth/callback",
    ] {
        assert_eq!(validate_redirect_str(accepted, &DESKTOP_REDIRECT_URIS).unwrap(), accepted);
        assert_eq!(validate_redirect(&json!(accepted), &DESKTOP_REDIRECT_URIS).unwrap(), accepted);
    }
    let mut long = String::from("http://127.0.0.1:4567/");
    long.push_str(&"a".repeat(280));
    assert!(long.len() > 300);
    for rejected in [
        "http://127.0.0.1:80/oauth/callback",
        "http://127.0.0.1:0/oauth/callback",
        "http://127.0.0.1/oauth/callback",
        "http://[::1]/oauth/callback",
        "http://localhost:4567/oauth/callback",
        "https://127.0.0.1:4567/oauth/callback",
        "http://user:secret@127.0.0.1:4567/oauth/callback",
        "http://user@127.0.0.1:4567/oauth/callback",
        "http://:secret@127.0.0.1:4567/oauth/callback",
        "http://127.0.0.1:4567/oauth/callback?x=1",
        "http://127.0.0.1:4567/oauth/callback?",
        "http://127.0.0.1:4567/oauth/callback#frag",
        "HTTP://127.0.0.1:4567/oauth/callback",
        "http://127.0.0.1:4567/oauth/../oauth/callback",
        "http://127.0.0.1:4567/oauth/callback/",
        "http://127.0.0.1:4567/other",
        "http://127.0.0.1:65536/oauth/callback",
        "not a url",
        "",
        long.as_str(),
    ] {
        assert_eq!(validate_redirect_str(rejected, &DESKTOP_REDIRECT_URIS), Err(OAuthError::InvalidRequest));
    }
    for rejected in [json!(1), json!(true), json!(null), json!(["http://127.0.0.1:4567/oauth/callback"])] {
        assert_eq!(validate_redirect(&rejected, &DESKTOP_REDIRECT_URIS), Err(OAuthError::InvalidRequest));
    }
}

#[test]
fn secret_format_and_hash_are_deterministic() {
    let value = secret("").unwrap();
    assert_eq!(value.len(), 43);
    assert!(is_valid_secret(&value));
    assert!(value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'));
    assert!(!is_valid_secret(&value[..42]));
    assert!(!is_valid_secret(&format!("{value}A")));
    assert!(!is_valid_secret(&format!("{}/", &value[..42])));
    let access = secret("dima_at_").unwrap();
    assert!(access.starts_with("dima_at_"));
    assert_eq!(access.len(), "dima_at_".len() + 43);
    assert!(catalog::is_access_token(&access));
    let refresh = secret("dima_rt_").unwrap();
    assert!(catalog::is_refresh_token(&refresh));
    assert_eq!(hash("a"), HASH_A);
    assert_eq!(hash("a").len(), 43);
    assert_eq!(hash("a"), hash("a"));
    assert_ne!(hash("a"), hash("b"));
    assert!(catalog::is_code_verifier(&value));
    assert!(!catalog::is_code_verifier(&value[..42]));
}

#[test]
fn pkce_comparison_is_constant_time() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(constant_time_eq(b"", b""));
    assert!(!constant_time_eq(b"abc", b"abcd"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"", b"a"));
    let left = hash("verifier");
    let right = hash("other-verifier");
    assert_eq!(left.len(), right.len());
    assert!(!constant_time_eq(left.as_bytes(), right.as_bytes()));
    assert!(constant_time_eq(left.as_bytes(), hash("verifier").as_bytes()));
}

#[test]
fn ttl_constants_match_source() {
    assert_eq!(ACCESS_TTL_SECONDS, 600);
    assert_eq!(REQUEST_TTL_SECONDS, 600);
    assert_eq!(CODE_TTL_SECONDS, 60);
    assert_eq!(REFRESH_IDLE_MS, 30_i64 * 24 * 60 * 60 * 1000);
    assert_eq!(SESSION_ABSOLUTE_MS, 90_i64 * 24 * 60 * 60 * 1000);
    assert_eq!(DESKTOP_CLIENT_ID, "dima-desktop");
    assert_eq!(catalog::DEFAULT_DEVICE_NAME, "Desktop computer");
}

#[test]
fn redis_key_builders_hash_the_raw_value() {
    assert_eq!(request_key("id"), format!("oauth:request:{}", hash("id")));
    assert_eq!(code_key("code"), format!("oauth:code:{}", hash("code")));
    assert_eq!(access_key("access"), format!("oauth:access:{}", hash("access")));
    assert_eq!(rate_key("oauth:127.0.0.1"), format!("oauth:rate:{}", hash("oauth:127.0.0.1")));
    assert!(!request_key("id").contains("id"));
}

#[test]
fn rate_limit_script_is_verbatim() {
    assert_eq!(
        RATE_LIMIT_LUA,
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n"
    );
}

#[test]
fn error_envelopes_match_source_statuses() {
    let cases = [
        (OAuthError::InvalidRequest, "invalid_request", 400_u16),
        (OAuthError::InvalidClient, "invalid_client", 400),
        (OAuthError::InvalidGrant, "invalid_grant", 400),
        (OAuthError::InvalidScope, "invalid_scope", 400),
        (OAuthError::UnsupportedGrantType, "unsupported_grant_type", 400),
        (OAuthError::InvalidToken, "invalid_token", 401),
        (OAuthError::LoginRequired, "login_required", 401),
        (OAuthError::AccessDenied, "access_denied", 403),
        (OAuthError::AccountRequired, "account_required", 403),
        (OAuthError::InsufficientScope, "insufficient_scope", 403),
        (OAuthError::SlowDown, "slow_down", 429),
        (OAuthError::NotFound, "not_found", 404),
    ];
    for (error, code, status) in cases {
        assert_eq!(error.code(), code);
        assert_eq!(error.status(), status);
        assert_eq!(error.to_string(), code);
        let body = serde_json::to_string(&ErrorBody { error: code }).unwrap();
        assert_eq!(body, format!(r#"{{"error":"{code}"}}"#));
    }
    let custom = OAuthError::custom("invalid_command", 400);
    assert_eq!((custom.code(), custom.status()), ("invalid_command", 400));
    assert_eq!(error_headers(401), ErrorHeaders { www_authenticate: true, retry_after: None });
    assert_eq!(error_headers(429), ErrorHeaders { www_authenticate: false, retry_after: Some("60") });
    for status in [400_u16, 403, 404, 503] {
        assert_eq!(error_headers(status), ErrorHeaders { www_authenticate: false, retry_after: None });
    }
}

#[test]
fn metadata_document_matches_source_shape() {
    let document = metadata_document("https://api.domdimabot.com");
    assert_eq!(serde_json::to_string(&document).unwrap(), METADATA_JSON);
    assert_eq!(document.issuer, "https://api.domdimabot.com");
    assert_eq!(document.scopes_supported, catalog::active_scopes());
    assert_eq!(document.beta.planned_scopes, catalog::inactive_scopes());
    assert_eq!(document.beta.client_id, DESKTOP_CLIENT_ID);
    assert_eq!(document.beta.access_token_lifetime, ACCESS_TTL_SECONDS);
    assert_eq!(document.beta.websocket_endpoint, "wss://api.domdimabot.com/v1/desktop/ws");
    assert_eq!(document.response_types_supported, ["code"]);
    assert_eq!(document.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert_eq!(document.code_challenge_methods_supported, ["S256"]);
    assert_eq!(document.token_endpoint_auth_methods_supported, ["none"]);
    assert!(document.authorization_response_iss_parameter_supported);
}

#[tokio::test]
#[ignore = "requires OAUTH_API_FIXTURE_ACK=disposable, disposable Mongo and Redis URIs, an empty oauth_api_fixture database, and a pre-set CLIENT_ID"]
async fn authorize_approve_token_refresh_reuse_revoke() {
    let client_id = std::env::var("CLIENT_ID").expect("CLIENT_ID must already be set");
    let fixture = OauthFixture::connect().await;
    let outcome = AssertUnwindSafe(exercise(&fixture, &client_id)).catch_unwind().await;
    fixture.cleanup().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn exercise(fixture: &OauthFixture, twitch_client_id: &str) {
    let issuer = catalog::oauth_issuer().expect("PUBLIC_API_URL unset or usable");
    let website = catalog::oauth_website().expect("DASHBOARD_URL unset or usable");
    let proof = json!({ "client_id": twitch_client_id, "user_id": TWITCH_ID, "expires_in": 3600 });
    let provider = Provider::start(vec![
        ProviderReply::Json { status: 200, body: proof.clone() },
        ProviderReply::Json { status: 200, body: proof.clone() },
        ProviderReply::Json { status: 200, body: proof },
    ])
    .await;
    let http = OAuthApiService::<UnwiredCreditsReader, UnwiredPetAccess>::validate_http_client()
        .expect("validate client");
    let service = OAuthApiService::new(
        fixture.database(),
        fixture.redis(),
        http,
        None,
        provider.validate_url(),
        UnwiredCreditsReader,
        UnwiredPetAccess,
    )
    .expect("service");
    service.initialize().await.expect("initialize");
    fixture
        .database()
        .collection::<Document>("users")
        .insert_one(doc! {
            "name": "Streamer",
            "accounts": [{ "type": "twitch", "id": TWITCH_ID, "name": "twitch-name" }]
        })
        .await
        .expect("insert user");

    let app = service.application_router().into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("app listener");
    let address = listener.local_addr().expect("app address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test client");
    let base = format!("http://{address}");

    let metadata = send_ready(&client, &format!("{base}/oauth/metadata")).await;
    assert_eq!(metadata.status().as_u16(), 200);
    assert_eq!(header(&metadata, "cache-control"), "no-store");
    assert_eq!(header(&metadata, "pragma"), "no-cache");
    assert_eq!(header(&metadata, "content-type"), "application/json; charset=utf-8");
    let metadata_body: Value = metadata.json().await.expect("metadata json");
    assert_eq!(metadata_body, serde_json::to_value(metadata_document(&issuer)).unwrap());

    let verifier = secret("").expect("verifier");
    let state = secret("").expect("state");
    let challenge = hash(&verifier);
    let authorize = client
        .get(format!("{base}/oauth/authorize?{}", authorize_query(&state, &challenge)))
        .send()
        .await
        .expect("authorize");
    assert_eq!(authorize.status().as_u16(), 302);
    let location = header(&authorize, "location");
    assert!(authorize.bytes().await.expect("authorize body").is_empty());
    let request_id = query_value(&location, "request");
    assert!(is_valid_secret(&request_id));
    assert_eq!(location, catalog::authorization_page(&website, &request_id).unwrap());

    let view: Value = client
        .get(format!("{base}/oauth/requests/{request_id}"))
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("request json");
    assert_eq!(view["client_id"], "dima-desktop");
    assert_eq!(view["client_name"], "Dima Desktop Beta");
    assert_eq!(view["device_name"], "Desktop computer");
    assert_eq!(view["redirect_uri"], REDIRECT);
    assert_eq!(view["scopes"], json!(["profile:read", "credits:read", "desktop:connect"]));

    let decision = client
        .post(format!("{base}/oauth/requests/{request_id}/decision"))
        .header("authorization", format!("Bearer {BROWSER_TOKEN}"))
        .json(&json!({ "approve": true }))
        .send()
        .await
        .expect("decision");
    assert_eq!(decision.status().as_u16(), 200);
    let decision_body: Value = decision.json().await.expect("decision json");
    let redirect_uri = decision_body["redirect_uri"].as_str().expect("redirect").to_owned();
    assert_eq!(query_value(&redirect_uri, "state"), state);
    assert_eq!(query_value(&redirect_uri, "iss"), issuer);
    let code = query_value(&redirect_uri, "code");
    assert!(is_valid_secret(&code));

    let token = post_json(
        &client,
        &format!("{base}/oauth/token"),
        json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": "dima-desktop",
            "code_verifier": verifier,
        }),
    )
    .await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(token["expires_in"], 600);
    assert_eq!(token["scope"], SCOPE);
    let access = token["access_token"].as_str().expect("access").to_owned();
    let refresh = token["refresh_token"].as_str().expect("refresh").to_owned();
    let session_id = token["session_id"].as_str().expect("session").to_owned();
    assert!(catalog::is_access_token(&access));
    assert!(catalog::is_refresh_token(&refresh));
    let refresh_expires_in = token["refresh_expires_in"].as_u64().expect("refresh ttl");
    assert!(refresh_expires_in > 0 && refresh_expires_in <= (REFRESH_IDLE_MS / 1000) as u64);

    let me: Value = bearer_json(&client, &format!("{base}/v1/me"), &access).await;
    assert_eq!(me["name"], "Streamer");
    assert_eq!(me["channel"]["platform"], "twitch");
    assert_eq!(me["channel"]["id"], TWITCH_ID);
    assert_eq!(me["channel"]["name"], "twitch-name");
    assert_eq!(me["user_id"].as_str().unwrap().len(), 24);

    let queried = client
        .get(format!("{base}/v1/me?channel=1"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("queried me");
    assert_eq!(error_of(queried).await, (400, "invalid_request".to_owned()));

    let desktop: Value = bearer_json(&client, &format!("{base}/v1/desktop/session"), &access).await;
    assert_eq!(desktop["client_id"], "dima-desktop");
    assert_eq!(desktop["channel_id"], TWITCH_ID);
    assert_eq!(desktop["device_name"], "Desktop computer");
    assert_eq!(desktop["protocol_version"], 1);
    assert_eq!(desktop["pet_available"], false);
    assert_eq!(desktop["scopes"], json!(["profile:read", "credits:read", "desktop:connect"]));
    assert_eq!(desktop["socket_io"]["path"], "/socket.io/");
    assert_eq!(desktop["socket_io"]["namespace"], "/desktop");
    assert!(desktop["expires_at"].as_str().unwrap().ends_with('Z'));

    let browser: Value = client
        .get(format!("{base}/oauth/browser-session"))
        .header("authorization", format!("Bearer {BROWSER_TOKEN}"))
        .send()
        .await
        .expect("browser session")
        .json()
        .await
        .expect("browser json");
    assert_eq!(browser["channel_id"], TWITCH_ID);
    assert_eq!(browser["name"], "twitch-name");
    assert_eq!(browser["user_id"], me["user_id"]);

    let connections: Value = client
        .get(format!("{base}/oauth/connections"))
        .header("authorization", format!("Bearer {BROWSER_TOKEN}"))
        .send()
        .await
        .expect("connections")
        .json()
        .await
        .expect("connections json");
    assert_eq!(connections["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(connections["sessions"][0]["device_name"], "Desktop computer");
    assert_eq!(connections["sessions"][0]["client_id"], "dima-desktop");
    assert_eq!(connections["sessions"][0]["_id"].as_str(), Some(session_id.as_str()));

    let credits = client
        .get(format!("{base}/v1/me/credits"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("credits");
    assert_eq!(error_of(credits).await, (503, "temporarily_unavailable".to_owned()));
    let pet = client
        .get(format!("{base}/v1/me/pet"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("pet");
    assert_eq!(error_of(pet).await, (403, "insufficient_scope".to_owned()));

    let rotated = post_json(
        &client,
        &format!("{base}/oauth/token"),
        json!({ "grant_type": "refresh_token", "refresh_token": refresh, "client_id": "dima-desktop" }),
    )
    .await;
    let next_refresh = rotated["refresh_token"].as_str().expect("rotated").to_owned();
    assert_ne!(next_refresh, refresh);
    assert_ne!(rotated["access_token"].as_str(), Some(access.as_str()));

    let reused = post_status(
        &client,
        &format!("{base}/oauth/token"),
        json!({ "grant_type": "refresh_token", "refresh_token": refresh, "client_id": "dima-desktop" }),
    )
    .await;
    assert_eq!(reused, (400, "invalid_grant".to_owned()));
    let rotated_again = post_status(
        &client,
        &format!("{base}/oauth/token"),
        json!({ "grant_type": "refresh_token", "refresh_token": next_refresh, "client_id": "dima-desktop" }),
    )
    .await;
    assert_eq!(rotated_again, (400, "invalid_grant".to_owned()));

    let stored = fixture
        .database()
        .collection::<Document>("oauth_sessions")
        .find_one(doc! { "_id": ObjectId::parse_str(&session_id).unwrap() })
        .await
        .expect("session read")
        .expect("session");
    assert_eq!(stored.get_str("revoke_reason").expect("reason"), "refresh_reuse");

    let unknown = post_status(
        &client,
        &format!("{base}/oauth/revoke"),
        json!({ "token": "not-a-token", "client_id": "dima-desktop" }),
    )
    .await;
    assert_eq!(unknown, (200, String::new()));
    let revoked = client
        .post(format!("{base}/oauth/revoke"))
        .json(&json!({ "token": refresh, "client_id": "dima-desktop" }))
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status().as_u16(), 200);
    assert_eq!(revoked.json::<Value>().await.expect("revoke json"), json!({}));

    let seen = provider.requests();
    assert_eq!(seen.len(), 3);
    let expected_authorization = format!("OAuth {BROWSER_TOKEN}");
    for request in &seen {
        assert_eq!(request.path, "/oauth2/validate");
        assert_eq!(request.authorization.as_deref(), Some(expected_authorization.as_str()));
    }
}

fn authorize_query(state: &str, challenge: &str) -> String {
    let mut url = reqwest::Url::parse("http://127.0.0.1/oauth/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", "dima-desktop")
        .append_pair("redirect_uri", REDIRECT)
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    url.query().unwrap().to_owned()
}

fn query_value(url: &str, key: &str) -> String {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| panic!("missing query value"))
}

fn header(response: &reqwest::Response, name: &str) -> String {
    response.headers().get(name).and_then(|value| value.to_str().ok()).unwrap_or("").to_owned()
}

async fn send_ready(client: &reqwest::Client, url: &str) -> reqwest::Response {
    let mut attempts = 0_u8;
    loop {
        match client.get(url).send().await {
            Ok(response) => return response,
            Err(_) if attempts < 20 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => panic!("oauth fixture listener did not accept"),
        }
    }
}

async fn bearer_json(client: &reqwest::Client, url: &str, token: &str) -> Value {
    client
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("bearer request")
        .json()
        .await
        .expect("bearer json")
}

async fn post_json(client: &reqwest::Client, url: &str, body: Value) -> Value {
    let response = client.post(url).json(&body).send().await.expect("post");
    assert_eq!(response.status().as_u16(), 200, "post status");
    response.json().await.expect("post json")
}

async fn post_status(client: &reqwest::Client, url: &str, body: Value) -> (u16, String) {
    error_of(client.post(url).json(&body).send().await.expect("post")).await
}

const OAUTH_SOURCE_PINS: &[(&str, &str)] = &[
    ("src/server/oauth/catalog.ts", "4608d6cc655bb101b2d871923f7b06432edde6e8b1de5ca197b364641061456a"),
    ("src/server/oauth/service.ts", "525e04c8b7b78b849165ffb07233fefe1f3f4421a379d14a049386dbc2405726"),
    ("src/server/oauth/routes.ts", "a387e88a604a263de03324005f001208731de1c6b718f735d818a7bd4ed493a7"),
];

const OAUTH_NOT_COMPARABLE: &[&str] = &[
    "full authorize/approve/token/refresh/reuse/revoke (GETDEL atomicity, refresh reuse CAS, session rotation, index installation, ObjectId persistence)",
    "browser-session and decision (real Twitch validate HTTP plus user lookup)",
    "connections and grants list-and-delete",
    "GET /v1/me success body (needs findById user document)",
    "GET /v1/desktop/session",
    "credits and all four pet routes (real adapters, also cross-team)",
    "desktop websocket (separate server upgrade, not Express; covered by native loopback tests)",
    "websocket 5s timeout and 15s heartbeat (time-based)",
    "application/x-www-form-urlencoded duplicate keys (express.urlencoded is not mounted)",
];

fn oauth_fixture_bytes() -> Vec<u8> {
    let directory = std::env::var("DIMA_OAUTH_API_FIXTURE_DIR").expect(
        "run tests/fixtures/oauth_api_reference.cjs --write <absolute empty dir outside the repo> and set DIMA_OAUTH_API_FIXTURE_DIR",
    );
    let directory = Path::new(&directory);
    assert!(directory.is_absolute(), "fixture directory must be absolute");
    assert!(directory.is_dir(), "fixture directory does not exist");
    std::fs::read(directory.join("oauth-api-reference.json")).expect("oauth api oracle")
}

fn json_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn protocol_status(code: &str) -> u16 {
    match code {
        "invalid_request" => OAuthError::InvalidRequest.status(),
        "invalid_client" => OAuthError::InvalidClient.status(),
        "invalid_grant" => OAuthError::InvalidGrant.status(),
        "invalid_scope" => OAuthError::InvalidScope.status(),
        "unsupported_grant_type" => OAuthError::UnsupportedGrantType.status(),
        "invalid_token" => OAuthError::InvalidToken.status(),
        "access_denied" => OAuthError::AccessDenied.status(),
        "insufficient_scope" => OAuthError::InsufficientScope.status(),
        "slow_down" => OAuthError::SlowDown.status(),
        "not_found" => OAuthError::NotFound.status(),
        "temporarily_unavailable" => 503,
        other => panic!("unexpected oauth error {other}"),
    }
}

fn assert_security(case: &Value) {
    let headers = &case["expected"]["headers"];
    assert_eq!(json_text(headers, "cache-control"), Some(catalog::SECURITY_CACHE_CONTROL));
    assert_eq!(json_text(headers, "pragma"), Some(catalog::SECURITY_PRAGMA));
    assert_eq!(json_text(headers, "referrer-policy"), Some(catalog::SECURITY_REFERRER_POLICY));
    assert_eq!(json_text(headers, "x-content-type-options"), Some(catalog::SECURITY_CONTENT_TYPE_OPTIONS));
}

fn assert_rate_limit(case: &Value) {
    let name = case["name"].as_str().expect("name");
    let calls = &case["calls"];
    let evals = calls["rateLimitEvals"].as_u64().expect("evals");
    let limited = !matches!(name, "metadata-origin-reject" | "metadata-options" | "malformed-json");
    if !limited {
        assert_eq!(evals, 0);
        assert!(calls["rateLimitScript"].is_null());
        assert!(calls["rateLimitKey"].is_null());
        return;
    }
    assert_eq!(evals, 1);
    assert_eq!(calls["rateLimitScript"].as_str(), Some(RATE_LIMIT_LUA));
    let bucket = format!("{}:127.0.0.1", case["mount"].as_str().expect("mount"));
    let key = format!("oauth:rate:{}", hash(&bucket));
    assert_eq!(calls["rateLimitKey"].as_str(), Some(key.as_str()));
    match name {
        "metadata-rate-limit" => assert_eq!(calls["rateLimitCount"].as_u64(), Some(601)),
        "redis-failure-503" => assert!(calls["rateLimitCount"].is_null()),
        _ => assert_eq!(calls["rateLimitCount"].as_u64(), Some(1)),
    }
}

fn assert_dispatch(case: &Value) {
    let Some(name) = case["name"].as_str() else { return };
    let expected = match name {
        "token-unsupported" | "token-missing-grant" => Some(("unsupported_grant_type", "unsupported_grant_type", 0, 0, 0)),
        "token-client-secret" | "token-authorization-header" => Some(("invalid_client", "invalid_client", 0, 0, 0)),
        "token-numeric-field" | "token-array-body" => Some(("invalid_request", "invalid_request", 0, 0, 0)),
        "token-authorization-code" => Some(("authorization_code", "invalid_grant", 1, 1, 0)),
        "token-refresh" => Some(("refresh_token", "invalid_grant", 1, 0, 1)),
        "token-unknown-client" => Some(("invalid_client", "invalid_client", 1, 0, 0)),
        _ => None,
    };
    let Some((dispatch, error, clients, codes, refreshes)) = expected else {
        assert!(case["dispatch"].is_null());
        return;
    };
    assert_eq!(case["dispatch"].as_str(), Some(dispatch));
    assert_eq!(case["expected"]["error"].as_str(), Some(error));
    assert_eq!(case["expected"]["status"].as_u64(), Some(u64::from(protocol_status(error))));
    let calls = &case["calls"];
    assert_eq!(calls["clientFinds"].as_u64(), Some(clients));
    assert_eq!(calls["codeGets"].as_u64(), Some(codes));
    assert_eq!(calls["refreshFinds"].as_u64(), Some(refreshes));
    assert_eq!(calls["accessGets"].as_u64(), Some(0));
}

fn assert_ordering(case: &Value) {
    let (status, error, reads) = match case["name"].as_str() {
        Some("auth-before-query") | Some("auth-invalid-bearer") => (401, "invalid_token", 0),
        Some("scope-before-query") => (403, "insufficient_scope", 1),
        Some("query-after-scope") => (400, "invalid_request", 1),
        _ => return,
    };
    assert_eq!(case["expected"]["status"].as_u64(), Some(status));
    assert_eq!(case["expected"]["error"].as_str(), Some(error));
    assert!(case["request"]["path"].as_str().unwrap_or("").contains("extra=1"));
    assert_eq!(case["calls"]["accessGets"].as_u64(), Some(reads));
    assert_eq!(case["calls"]["usersFindById"].as_u64(), Some(0));
}

/// Digest-checks the Express oracle. This does not replay `application_router`:
/// the HTTP boundary always calls Redis. Outcomes are compared to the native
/// catalogue, error table, and `token_inner` branch order.
#[test]
#[ignore = "requires DIMA_OAUTH_API_FIXTURE_DIR and DIMA_OAUTH_API_FIXTURE_SHA256 from tests/fixtures/oauth_api_reference.cjs --write"]
fn compares_oauth_api_source_oracle() {
    let bytes = oauth_fixture_bytes();
    assert_eq!(
        sha256::sha256_hex(&bytes),
        std::env::var("DIMA_OAUTH_API_FIXTURE_SHA256").expect("independent fixture digest")
    );
    let fixture: Value = serde_json::from_slice(&bytes).expect("oauth api oracle json");
    assert_eq!(fixture["typescript"], "5.9.3");
    assert_eq!(fixture["output"], "oauth-api-reference.json");
    assert_eq!(fixture["rateLimitLua"], RATE_LIMIT_LUA);
    assert_eq!(fixture["formDuplicateCoverage"], false);
    let sources = fixture["sources"].as_array().expect("sources");
    assert_eq!(sources.len(), OAUTH_SOURCE_PINS.len());
    for (file, pin) in OAUTH_SOURCE_PINS {
        let recorded = sources.iter().find(|source| source["file"] == *file).expect(file);
        assert_eq!(recorded["sha256"], *pin);
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
        assert_eq!(sha256::sha256_hex(&std::fs::read(path).expect(file)), *pin);
    }
    let skipped = fixture["notComparable"].as_array().expect("notComparable");
    for item in OAUTH_NOT_COMPARABLE {
        assert!(skipped.iter().any(|value| value.as_str() == Some(*item)), "{item}");
    }
    let cases = fixture["cases"].as_array().expect("cases");
    let required = [
        "metadata",
        "metadata-matching-origin",
        "metadata-origin-reject",
        "metadata-options",
        "metadata-rate-limit",
        "token-unsupported",
        "token-missing-grant",
        "token-client-secret",
        "token-authorization-header",
        "token-numeric-field",
        "token-array-body",
        "token-authorization-code",
        "token-refresh",
        "token-unknown-client",
        "auth-before-query",
        "auth-invalid-bearer",
        "scope-before-query",
        "query-after-scope",
        "not-found-oauth",
        "not-found-post-metadata",
        "not-found-desktop",
        "redis-failure-503",
        "malformed-json",
    ];
    assert!(cases.len() >= required.len());
    for name in required {
        assert!(cases.iter().any(|case| case["name"] == name), "{name}");
    }
    let metadata = serde_json::to_string(&metadata_document("https://api.domdimabot.com")).expect("metadata");
    for case in cases {
        assert_eq!(case["calls"]["usersFindById"].as_u64(), Some(0));
        assert_rate_limit(case);
        assert_dispatch(case);
        let expected = &case["expected"];
        let status = expected["status"].as_u64().expect("status");
        match case["comparison"].as_str() {
            Some("metadata-json") => {
                assert_eq!(status, 200);
                assert_eq!(json_text(expected, "bodyText"), Some(metadata.as_str()));
                assert_eq!(json_text(expected, "contentType"), Some(catalog::JSON_CONTENT_TYPE));
                assert_security(case);
            }
            Some("error-json") | Some("ordering") | Some("not-found") => {
                let code = json_text(expected, "error").expect("error");
                assert_eq!(status, u64::from(protocol_status(code)));
                let body = format!(r#"{{"error":"{code}"}}"#);
                assert_eq!(json_text(expected, "bodyText"), Some(body.as_str()));
                assert_eq!(json_text(expected, "contentType"), Some(catalog::JSON_CONTENT_TYPE));
                assert_security(case);
                if case["comparison"] == "ordering" {
                    assert_ordering(case);
                }
                if case["comparison"] == "not-found" {
                    assert_eq!(code, "not_found");
                }
            }
            Some("options") => {
                assert_eq!(status, 204);
                assert_eq!(json_text(expected, "bodyText"), Some("No Content"));
                assert!(json_text(expected, "contentType").unwrap_or("").starts_with("text/plain"));
                assert_eq!(case["nativeDeviation"]["nativeStatus"].as_u64(), Some(204));
                assert_eq!(case["nativeDeviation"]["nativeBody"].as_str(), Some(""));
                assert_security(case);
            }
            Some("express-parse") => {
                assert_eq!(status, 400);
                assert!(json_text(expected, "contentType").unwrap_or("").starts_with("text/html"));
                assert!(expected["bodyText"].is_null());
                assert_eq!(case["nativeDeviation"]["status"].as_u64(), Some(400));
                assert_eq!(case["nativeDeviation"]["error"].as_str(), Some("invalid_request"));
                assert_eq!(case["nativeDeviation"]["boundaryHeaders"].as_bool(), Some(true));
            }
            other => panic!("unexpected comparison {other:?}"),
        }
        if status == 401 {
            assert_eq!(json_text(expected, "wwwAuthenticate"), Some(catalog::WWW_AUTHENTICATE_INVALID_TOKEN));
            assert!(error_headers(401).www_authenticate);
        } else {
            assert!(expected["wwwAuthenticate"].is_null());
        }
        if status == 429 {
            assert_eq!(json_text(expected, "retryAfter"), Some("60"));
            assert_eq!(error_headers(429).retry_after, Some("60"));
        } else {
            assert!(expected["retryAfter"].is_null());
        }
        let cors = &expected["cors"];
        if matches!(case["name"].as_str(), Some("metadata-matching-origin") | Some("metadata-options")) {
            assert_eq!(json_text(cors, "origin"), Some("https://domdimabot.com"));
            assert_eq!(json_text(cors, "vary"), Some("Origin"));
            assert_eq!(json_text(cors, "headers"), Some(catalog::CORS_ALLOW_HEADERS));
            assert_eq!(json_text(cors, "methods"), Some(catalog::CORS_ALLOW_METHODS));
        } else {
            assert!(cors["origin"].is_null());
        }
        if case["name"] == "redis-failure-503" {
            let log = case["calls"]["log"].as_array().expect("log");
            assert!(log.iter().any(|line| {
                line.get(0).and_then(Value::as_str) == Some("[OAuth] Request failed") && line.get(1).and_then(Value::as_str) == Some("Error")
            }));
        }
    }
}

async fn error_of(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    if status == 200 {
        let body: Value = response.json().await.expect("empty object");
        assert_eq!(body, json!({}));
        return (status, String::new());
    }
    let body: Value = response.json().await.expect("error json");
    assert_eq!(body.as_object().map(serde_json::Map::len), Some(1));
    (status, body["error"].as_str().unwrap_or("").to_owned())
}
