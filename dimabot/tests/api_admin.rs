//! Functional checks for the native admin-permission middleware batch.
//!
//! Fixture-backed suites replay the external source oracle against the concrete
//! native implementation: real Axum routers over loopback HTTP, and the real
//! MongoDB `admins` collection in a task-owned disposable database. They run
//! only in the guarded migration driver (`--include-ignored`). The
//! fixture-free suites cover the unauthenticated, empty-identity, workspace
//! owner and unreachable-MongoDB paths, which need no database.
//!
//! No host networking, production service, credential or shared volume is used.

#![cfg(feature = "api-admin")]

#[path = "support/api_admin.rs"]
mod support;

use axum::{
    Json, Router,
    extract::{Request, State},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use dima_rust::{
    api_admin::{
        AdminService, CREATOR_TWITCH_USER_ID, MAX_ACCESS_PERMISSIONS, admin_middleware,
        can_modify_creator_admin_assignment, expand_channel_permission_checks,
        get_channel_access_context, get_channel_access_decisions, get_global_admin_role,
        global_admin_context, has_global_channel_owner_access, is_creator_target, is_creator_user,
        parse_permission_list, parse_permission_list_values, resolve_granted_permissions,
    },
    channel_permissions::{
        CHANNEL_ADMIN_PERMISSIONS, CHANNEL_WEBSITE_ACCESS_PERMISSIONS, grants_chat_admin_role_json,
        parse_channel_admin_permissions_json,
    },
    utils::logger::Logger,
    workspace_owner::protect_workspace_owner,
};
use mongodb::{bson::doc, options::ClientOptions};
use serde_json::{Map, Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{
    app_url, capture_logger, cases, closed_endpoint, fixture, fixture_identity, fixtures, get_as,
    serve_app,
};

async fn lazy_service(logger: Option<Logger>) -> AdminService {
    // Client construction is lazy; nothing connects to this address.
    let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/api_admin_lazy")
        .await
        .expect("lazy Mongo client");
    AdminService::new(
        client.database("api_admin_lazy").collection("admins"),
        logger,
    )
}

/// An `admins` collection whose server selection always fails, for the
/// source's outer `500 internal_error` branch.
async fn unreachable_collection() -> mongodb::Collection<mongodb::bson::Document> {
    let closed = closed_endpoint().await;
    let uri = format!(
        "{}/api_admin_unreachable?directConnection=true",
        closed.replacen("http://", "mongodb://", 1)
    );
    let mut options = ClientOptions::parse(&uri).await.expect("mongo options");
    options.server_selection_timeout = Some(Duration::from_millis(400));
    options.connect_timeout = Some(Duration::from_millis(400));
    mongodb::Client::with_options(options)
        .expect("unreachable client")
        .database("api_admin_unreachable")
        .collection("admins")
}

async fn admin_probe(State(calls): State<Arc<AtomicUsize>>, request: Request) -> Response {
    calls.fetch_add(1, Ordering::SeqCst);
    let context = global_admin_context(request.extensions());
    Json(json!({
        "globalAdminRole": context.map(|context| context.role.as_str()),
        "isSuperAdmin": context.map(|context| context.is_super_admin),
        "next": 1,
    }))
    .into_response()
}

fn admin_app(service: AdminService, calls: Arc<AtomicUsize>) -> Router {
    Router::new()
        .route("/api/admin", get(admin_probe))
        .with_state(calls)
        .layer(middleware::from_fn_with_state(service, admin_middleware))
        .layer(middleware::from_fn(fixture_identity))
}

async fn workspace_probe(State(calls): State<Arc<AtomicUsize>>) -> Response {
    calls.fetch_add(1, Ordering::SeqCst);
    Json(json!({"next": 1})).into_response()
}

fn workspace_app(calls: Arc<AtomicUsize>) -> Router {
    let router: Router = Router::new()
        .route("/api/workspace", get(workspace_probe))
        .with_state(calls);
    protect_workspace_owner(router).layer(middleware::from_fn(fixture_identity))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected a string array, got {value}"))
        .iter()
        .map(|item| {
            item.as_str()
                .unwrap_or_else(|| panic!("expected a string entry, got {item}"))
                .to_owned()
        })
        .collect()
}

fn string_array(value: &[&str]) -> Value {
    Value::Array(
        value
            .iter()
            .map(|entry| Value::String((*entry).to_owned()))
            .collect(),
    )
}

#[tokio::test]
async fn missing_and_empty_identities_require_authentication() {
    let service = lazy_service(None).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(admin_app(service, calls.clone())).await;
    let client = reqwest::Client::new();
    let expected = json!({
        "error": true,
        "message": "Authentication required",
        "status": 401,
        "type": "authentication_required"
    });

    let (status, body) = get_as(&client, &app_url(app.addr, "/api/admin"), None).await;
    assert_eq!(status, 401);
    assert_eq!(body, expected);

    // An authenticated identity with an empty id is the source's `!req.user.id`.
    let (status, body) = get_as(&client, &app_url(app.addr, "/api/admin"), Some("")).await;
    assert_eq!(status, 401);
    assert_eq!(body, expected);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn workspace_owner_allows_only_the_creator() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(workspace_app(calls.clone())).await;
    let client = reqwest::Client::new();
    let url = app_url(app.addr, "/api/workspace");

    let (status, body) = get_as(&client, &url, Some(CREATOR_TWITCH_USER_ID)).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({"next": 1}));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let denied = json!({
        "error": true,
        "message": "Admin workspace access required",
        "status": 403
    });
    for user in [Some("1234"), Some(""), None] {
        let (status, body) = get_as(&client, &url, user).await;
        assert_eq!(status, 403, "{user:?}");
        assert_eq!(body, denied, "{user:?}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        dima_rust::workspace_owner::WORKSPACE_OWNER_TWITCH_USER_ID,
        CREATOR_TWITCH_USER_ID
    );
}

#[tokio::test]
async fn unreachable_mongo_maps_to_internal_error_and_is_logged() {
    let (logger, console) = capture_logger();
    let service = AdminService::new(unreachable_collection().await, Some(logger));
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(admin_app(service, calls.clone())).await;
    let (status, body) = get_as(
        &reqwest::Client::new(),
        &app_url(app.addr, "/api/admin"),
        Some("user-1"),
    )
    .await;
    assert_eq!(status, 500);
    assert_eq!(
        body,
        json!({
            "error": true,
            "message": "Internal server error",
            "status": 500,
            "type": "internal_error"
        })
    );
    assert_eq!(
        console.error_functions(),
        vec!["adminMiddleware".to_owned()]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture and task-owned MongoDB"]
async fn middleware_cases_match_the_source_oracle() {
    let fixture = fixture();
    let fx = fixtures("middleware").await;
    let client = reqwest::Client::new();
    for case in cases(&fixture, "middlewareCases") {
        let name = case["name"].as_str().expect("case name");
        fx.admins()
            .delete_many(doc! {})
            .await
            .expect("reset admins");
        fx.seed_admins(case["rows"].as_array().expect("rows")).await;
        let (logger, console) = capture_logger();
        // The oracle's `mongo-error` case injects a driver throw; replay it
        // against an unreachable collection so the same expectation is checked.
        let service = if case["mongoError"].as_bool() == Some(true) {
            AdminService::new(unreachable_collection().await, Some(logger))
        } else {
            AdminService::new(fx.admins(), Some(logger))
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let app = serve_app(admin_app(service, calls.clone())).await;
        let user = case["userId"].as_str();
        let (status, body) = get_as(&client, &app_url(app.addr, "/api/admin"), user).await;
        let expected = &case["expected"];
        assert_eq!(Value::from(status), expected["status"], "{name}: status");
        assert_eq!(&body, &expected["body"], "{name}: body");
        assert_eq!(
            calls.load(Ordering::SeqCst) as u64,
            expected["next"].as_u64().expect("next"),
            "{name}: next"
        );
        let expected_log: Vec<String> = expected["errorLog"]
            .as_array()
            .expect("errorLog")
            .iter()
            .map(|entry| entry.as_str().expect("function").to_owned())
            .collect();
        assert_eq!(console.error_functions(), expected_log, "{name}: log");
    }
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn workspace_cases_match_the_source_oracle() {
    let fixture = fixture();
    let client = reqwest::Client::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(workspace_app(calls.clone())).await;
    let url = app_url(app.addr, "/api/workspace");
    let mut served = 0;
    for case in cases(&fixture, "workspaceCases") {
        let name = case["name"].as_str().expect("case name");
        let user = case["userId"].as_str();
        let (status, body) = get_as(&client, &url, user).await;
        let expected = &case["expected"];
        assert_eq!(Value::from(status), expected["status"], "{name}: status");
        assert_eq!(&body, &expected["body"], "{name}: body");
        served += expected["next"].as_u64().expect("next") as usize;
    }
    // The authorised case is the only one that reaches the handler.
    assert_eq!(calls.load(Ordering::SeqCst), served);
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture and task-owned MongoDB"]
async fn helper_cases_match_the_source_oracle() {
    let fixture = fixture();
    let fx = fixtures("helpers").await;
    let admins = fx.admins();
    for case in cases(&fixture, "helperCases") {
        let name = case["name"].as_str().expect("case name");
        let function = case["function"].as_str().expect("function");
        admins.delete_many(doc! {}).await.expect("reset admins");
        fx.seed_admins(case["rows"].as_array().expect("rows")).await;
        let args = case["args"].as_array().expect("args");
        let value = match function {
            "getGlobalAdminRole" => {
                let role = get_global_admin_role(&admins, args[0].as_str())
                    .await
                    .expect("role lookup");
                json!(role)
            }
            "hasGlobalChannelOwnerAccess" => json!(
                has_global_channel_owner_access(&admins, args[0].as_str(), args[1].as_str())
                    .await
                    .expect("owner lookup")
            ),
            "getChannelAccessContext" => serde_json::to_value(
                get_channel_access_context(
                    &admins,
                    args[0].as_str(),
                    args[1].as_str(),
                    &strings(&args[2]),
                )
                .await
                .expect("context lookup"),
            )
            .expect("context json"),
            "getChannelAccessDecisions" => get_channel_access_decisions(
                &admins,
                args[0].as_str(),
                args[1].as_str(),
                &strings(&args[2]),
            )
            .await
            .expect("decisions lookup")
            .to_json(),
            other => panic!("{name}: unknown helper {other}"),
        };
        assert_eq!(value, case["expected"]["value"], "{name}: value");
        assert!(
            case["expected"]["queries"].as_u64().is_some(),
            "{name}: recorded query count"
        );
    }
    fx.cleanup().await;
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn pure_helpers_match_the_source_oracle() {
    let fixture = fixture();
    for case in cases(&fixture, "pureCases") {
        let name = case["name"].as_str().expect("case name");
        let function = case["function"].as_str().expect("function");
        let args = case["args"].as_array().expect("args");
        let value = match function {
            "expandChannelPermissionChecks" => {
                serde_json::to_value(expand_channel_permission_checks(&strings(&args[0])))
                    .expect("expanded json")
            }
            "parsePermissionList" => match args.first() {
                None => json!(parse_permission_list(None)),
                Some(value) if value.is_array() => {
                    let values = strings(value);
                    json!(parse_permission_list_values(Some(&values[..])))
                }
                Some(value) if value.is_null() => {
                    let values: Vec<String> = Vec::new();
                    json!(parse_permission_list_values(Some(&values[..])))
                }
                Some(value) => json!(parse_permission_list(value.as_str())),
            },
            "resolveGrantedPermissions" => {
                let mut map = Map::new();
                for (permission, allowed) in
                    resolve_granted_permissions(&strings(&args[0]), &strings(&args[1]))
                {
                    map.insert(permission, Value::Bool(allowed));
                }
                Value::Object(map)
            }
            "canModifyCreatorAdminAssignment" => json!(can_modify_creator_admin_assignment(
                args[0].as_str(),
                args[1].as_str(),
                args[2].as_str()
            )),
            "isCreatorUser" => json!(is_creator_user(args[0].as_str())),
            "isCreatorTarget" => json!(is_creator_target(args[0].as_str())),
            other => panic!("{name}: unknown helper {other}"),
        };
        assert_eq!(value, case["expected"], "{name}: value");
    }
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn channel_permission_cases_match_the_source_oracle() {
    let fixture = fixture();
    for case in cases(&fixture, "channelPermissionCases") {
        let name = case["name"].as_str().expect("case name");
        let function = case["function"].as_str().expect("function");
        let args = case["args"].as_array().expect("args");
        let value = match function {
            "parseChannelAdminPermissions" => json!(parse_channel_admin_permissions_json(&args[0])),
            "grantsChatAdminRole" => json!(grants_chat_admin_role_json(&args[0])),
            other => panic!("{name}: unknown helper {other}"),
        };
        assert_eq!(value, case["expected"], "{name}: value");
    }
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture"]
async fn metadata_matches_the_source_oracle() {
    let fixture = fixture();
    let metadata = &fixture["metadata"];
    assert_eq!(metadata["creatorTwitchUserId"], CREATOR_TWITCH_USER_ID);
    assert_eq!(
        metadata["maxAccessPermissions"].as_u64(),
        Some(MAX_ACCESS_PERMISSIONS as u64)
    );
    assert_eq!(
        metadata["channelAdminPermissions"],
        string_array(CHANNEL_ADMIN_PERMISSIONS)
    );
    assert_eq!(
        metadata["channelWebsiteAccessPermissions"],
        string_array(CHANNEL_WEBSITE_ACCESS_PERMISSIONS)
    );
    // Both admin add/remove routes still call the shared creator-assignment
    // policy; route migration is outside this batch.
    assert_eq!(metadata["routePolicyCallSites"].as_u64(), Some(2));
    assert_eq!(metadata["typescript"], "5.9.3");
    assert_eq!(
        metadata["exports"]["adminMiddleware"]["returns"],
        "Promise<void>"
    );
    assert_eq!(
        metadata["exports"]["adminMiddleware"]["parameters"],
        json!(["AuthRequest", "Response", "NextFunction"])
    );
    assert_eq!(
        metadata["exports"]["workspaceOwnerMiddleware"]["returns"],
        "void"
    );
    assert_eq!(
        metadata["exports"]["workspaceOwnerMiddleware"]["parameters"],
        json!(["Request", "Response", "NextFunction"])
    );
    assert_eq!(
        metadata["differences"]
            .as_array()
            .expect("differences")
            .len(),
        4
    );
    assert_eq!(
        fixture["middlewareCases"].as_array().expect("cases").len(),
        14
    );
    assert_eq!(
        fixture["helperCases"].as_array().expect("helpers").len(),
        31
    );
}

async fn composed_admin_probe(State(calls): State<Arc<AtomicUsize>>, request: Request) -> Response {
    calls.fetch_add(1, Ordering::SeqCst);
    let user = dima_rust::api_auth::AuthRequest::from_extensions(request.extensions()).user;
    let global = global_admin_context(request.extensions());
    Json(
        json!({"user": user, "role": global.map(|value| value.role.as_str()),
        "isSuperAdmin": global.map(|value| value.is_super_admin)}),
    )
    .into_response()
}

#[tokio::test]
#[ignore = "requires task-owned MongoDB and Redis fixtures"]
async fn concrete_auth_admin_composition() {
    use dima_rust::api_auth::{AuthConfig, AuthService, activity_touch_key, token_cache_key};
    use redis::AsyncCommands;

    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    let id = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("driver-owned namespace");
    assert!(id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    let redis_client = redis::Client::open("redis://keyword-redis:6379/").expect("Redis client");
    let mut redis = redis_client
        .get_connection_manager()
        .await
        .expect("Redis manager");
    let fx = fixtures("authadmincomposition").await;
    let inactive_id = format!("{}-inactive", fx.stem);
    let super_id = format!("{}-super", fx.stem);
    let inactive_token = format!("{}-inactive-token", fx.stem);
    let super_token = format!("{}-super-token", fx.stem);
    let creator_token = format!("{}-creator-token", fx.stem);
    let creator_key = activity_touch_key(CREATOR_TWITCH_USER_ID);
    let marker = format!("{}-creator-activity-owner", fx.stem);
    let keys = vec![
        token_cache_key(&inactive_token),
        token_cache_key(&super_token),
        token_cache_key(&creator_token),
        activity_touch_key(&inactive_id),
        activity_touch_key(&super_id),
    ];
    let database = fx.database.clone();
    let body_fx = support::Fixtures {
        database: fx.database.clone(),
        mongo_client: fx.mongo_client.clone(),
        stem: fx.stem.clone(),
    };
    let redis_for_body = redis.clone();
    let creator_key_body = creator_key.clone();
    let marker_body = marker.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = redis_for_body.clone();
        let exists: bool = connection
            .exists(&creator_key_body)
            .await
            .expect("creator activity check");
        assert!(
            !exists,
            "creator activity key must be absent in private fixture"
        );
        let _: () = connection
            .set(&creator_key_body, &marker_body)
            .await
            .expect("seed creator activity");
        for (token, user_id) in [
            (&inactive_token, inactive_id.as_str()),
            (&super_token, super_id.as_str()),
            (&creator_token, CREATOR_TWITCH_USER_ID),
        ] {
            let _: () = connection
                .hset_multiple(
                    token_cache_key(token),
                    &[
                        ("id", user_id),
                        ("login", "fixture"),
                        ("display_name", "Fixture"),
                    ],
                )
                .await
                .expect("seed identity");
            if user_id != CREATOR_TWITCH_USER_ID {
                let _: () = connection
                    .set(activity_touch_key(user_id), "1")
                    .await
                    .expect("seed activity");
            }
        }
        let admin = AdminService::new(database.collection("admins"), None);
        let endpoint = closed_endpoint().await;
        let auth = AuthService::new(
            AuthConfig::new(&endpoint, &endpoint),
            reqwest::Client::new(),
            redis_for_body,
            database.collection("users"),
            None,
        )
        .expect("auth service");
        let calls = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route("/admin", get(composed_admin_probe))
            .with_state(calls.clone());
        let app = serve_app(auth.protect(admin.protect(router))).await;
        let client = reqwest::Client::new();
        let url = app_url(app.addr, "/admin");
        let response = client
            .get(&url)
            .send()
            .await
            .expect("missing token response");
        assert_eq!(response.status().as_u16(), 401);
        let response = client
            .get(&url)
            .bearer_auth(&creator_token)
            .send()
            .await
            .expect("creator admin response");
        assert_eq!(response.status().as_u16(), 403);
        for token in [&inactive_token, &super_token] {
            let response = client
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .expect("denied response");
            assert_eq!(response.status().as_u16(), 403);
        }
        body_fx
            .seed_admins(&[
                json!({"adminID": inactive_id, "actived": false, "role": "super"}),
                json!({"adminID": super_id, "actived": true, "role": "super"}),
            ])
            .await;
        let response = client
            .get(&url)
            .bearer_auth(&inactive_token)
            .send()
            .await
            .expect("inactive response");
        assert_eq!(response.status().as_u16(), 403);
        let response = client
            .get(&url)
            .bearer_auth(&super_token)
            .send()
            .await
            .expect("super response");
        assert_eq!(response.status().as_u16(), 200);
        let body: Value = response.json().await.expect("response JSON");
        assert_eq!(body["user"]["id"], super_id);
        assert_eq!(body["user"]["login"], "fixture");
        assert_eq!(body["role"], "super");
        assert_eq!(body["isSuperAdmin"], true);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let workspace_calls = Arc::new(AtomicUsize::new(0));
        let workspace = Router::new()
            .route("/workspace", get(workspace_probe))
            .with_state(workspace_calls.clone());
        let workspace_app = serve_app(auth.protect(protect_workspace_owner(workspace))).await;
        let workspace_url = app_url(workspace_app.addr, "/workspace");
        let response = client
            .get(&workspace_url)
            .bearer_auth(&super_token)
            .send()
            .await
            .expect("super workspace response");
        assert_eq!(response.status().as_u16(), 403);
        let response = client
            .get(&workspace_url)
            .bearer_auth(&creator_token)
            .send()
            .await
            .expect("creator workspace response");
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(workspace_calls.load(Ordering::SeqCst), 1);
    })
    .await;
    let cleanup: Result<usize, _> = redis.del(keys).await;
    let creator_value: Result<Option<String>, _> = redis.get(&creator_key).await;
    let creator_cleanup: Result<(), redis::RedisError> = match creator_value {
        Ok(Some(value)) if value == marker => redis.del(&creator_key).await,
        Ok(_) => Ok(()),
        Err(error) => Err(error),
    };
    fx.cleanup().await;
    cleanup.expect("delete task-owned Redis keys");
    creator_cleanup.expect("delete owned creator activity key");
    if let Err(error) = outcome {
        if error.is_panic() {
            std::panic::resume_unwind(error.into_panic());
        }
        panic!("test task failed: {error}");
    }
}
