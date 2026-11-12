//! The access decision table: every call recorded from `admin.middleware.ts`
//! (`record-access.mts`, `access-reference.json`: roles × target channels × permission checks,
//! the pure helpers, and `adminMiddleware` behind Express) is replayed against the Rust rules
//! with the same seeded `admins` rows. Intended differences are stated in
//! [`admin_middleware_intended`] with their reason and counted. Further tests cover the typed
//! guards routes use.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod guard_support;

use anyhow::{Context, Result};
use dima_core::SystemClock;
use dima_model::admins::{AdminRole, NewAdmin};
use dima_platform::access::{
    ChannelAccess, ChannelGuard, ChannelScope, GlobalAdmin, HasChannelAccess, Need, ScopeRole,
    StaffAdmin, can_modify_creator_admin_assignment, expand_channel_permission_checks,
    parse_permission_list, requested_permissions, require_admin, require_global_admin,
    resolve_granted_permissions,
};
use dima_platform::auth::{
    AuthConfig, AuthDeps, AuthenticatedUser, Authenticator, HasAuthenticator, NoReport,
};
use dima_platform::media_library::GlobalChannelOwnerAccess;
use dima_store::mongo::WriteContext;
use dima_web::{App, Body, Flow, Req, Response, Router};
use guard_support::{Stores, with_stores};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const CREATOR: &str = "533538623";

fn id_of(kind: &str, run: &str) -> String {
    match kind {
        "creator" | "creator_channel" => CREATOR.to_owned(),
        "owner" => id_of("managed", run),
        other => guard_support::id_of(other, run),
    }
}

fn requester_id(kind: &str, run: &str) -> Option<String> {
    match kind {
        "missing" => None,
        "empty" => Some(String::new()),
        other => Some(id_of(other, run)),
    }
}

fn target_id(kind: &str, requester: &str, run: &str) -> Option<String> {
    match kind {
        "own" => requester_id(requester, run),
        "missing" => None,
        "empty" => Some(String::new()),
        other => Some(id_of(other, run)),
    }
}

fn special(value: &Value) -> Option<Value> {
    let many = |n: usize| {
        (0..n)
            .map(|i| format!("p{i}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    match value.as_str() {
        Some("$missing") => None,
        Some("$21") => Some(json!(many(21))),
        Some("$20") => Some(json!(many(20))),
        Some("$64") => Some(json!("a".repeat(64))),
        Some("$65") => Some(json!("a".repeat(65))),
        _ => Some(value.clone()),
    }
}

async fn seed(stores: &Stores, cases: &Value) -> Result<()> {
    for row in cases["admins"].as_array().context("admins")? {
        let admin = row["admin"].as_str().context("admin")?;
        let channel = row["channel"].as_str().context("channel")?;
        let role = match row["role"].as_str() {
            Some("creator") => Some(AdminRole::Creator),
            Some("super") => Some(AdminRole::Super),
            Some("support") => Some(AdminRole::Support),
            Some("billing") => Some(AdminRole::Billing),
            Some("channel") => Some(AdminRole::Channel),
            _ => None,
        };
        let new = NewAdmin {
            channel_id: Some(id_of(channel, &stores.run)),
            channel_name: Some(format!("login_{channel}")),
            admin_id: Some(id_of(admin, &stores.run)),
            admin_name: Some(format!("login_{admin}")),
            role,
            permissions: Some(serde_json::from_value(row["permissions"].clone())?),
            actived: row["actived"].as_bool(),
        };
        let prepared = new.prepare(&mut WriteContext::new(dima_core::Clock::now_ms(
            &SystemClock,
        )))?;
        stores
            .mongo
            .writes(dima_model::admins::COLLECTION)
            .insert_one(&prepared)
            .await?;
    }
    Ok(())
}

#[tokio::test]
async fn decision_table_matches_the_reference() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("access-cases.json"))?;
    let reference: Value = serde_json::from_str(include_str!("access-reference.json"))?;
    guard_support::check_drift(&reference)?;
    with_stores(14, |stores| async move {
        seed(&stores, &cases).await?;
        let access = ChannelAccess::new(stores.mongo.clone(), Duration::from_secs(10));
        let run = stores.run.clone();
        let mut rows = 0;

        let mut global = reference["global"].as_array().context("global")?.iter();
        let mut owner = reference["owner"].as_array().context("owner")?.iter();
        let mut context = reference["context"].as_array().context("context")?.iter();
        let mut decisions = reference["decisions"]
            .as_array()
            .context("decisions")?
            .iter();
        for requester in cases["requesters"].as_array().context("requesters")? {
            let requester = requester.as_str().context("requester")?;
            let r = requester_id(requester, &run);
            let expected = global.next().context("global row")?;
            let role = access
                .global_admin_role(r.as_deref())
                .await?
                .map(|role| role.as_str());
            assert_eq!(json!(role), expected["result"], "global {requester}");
            rows += 1;
            for target in cases["targets"].as_array().context("targets")? {
                let target = target.as_str().context("target")?;
                let t = target_id(target, requester, &run);
                let expected = owner.next().context("owner row")?;
                let result = access
                    .has_global_channel_owner_access(r.as_deref(), t.as_deref())
                    .await?;
                assert_eq!(
                    json!(result),
                    expected["result"],
                    "owner {requester} {target}"
                );
                rows += 1;
                for permission in cases["permissions"].as_array().context("permissions")? {
                    let expected = context.next().context("context row")?;
                    let asked = requested_permissions(special(permission).as_ref());
                    let result = access
                        .channel_access_context(r.as_deref(), t.as_deref(), &asked)
                        .await?;
                    assert_eq!(
                        json!({"allowed": result.allowed, "role": result.role.as_str()}),
                        expected["result"],
                        "context {requester} {target} {permission}"
                    );
                    rows += 1;
                }
                for list in cases["decision_lists"].as_array().context("lists")? {
                    let expected = decisions.next().context("decision row")?;
                    let list: Vec<String> = serde_json::from_value(list.clone())?;
                    let result = access
                        .channel_access_decisions(r.as_deref(), t.as_deref(), &list)
                        .await?;
                    let text = serde_json::to_string(&json!({
                        "role": result.role.as_str(), "permissions": result.permissions.to_json()
                    }))?;
                    assert_eq!(
                        text,
                        expected["result"].as_str().unwrap(),
                        "decisions {requester} {target} {list:?}"
                    );
                    rows += 1;
                }
            }
        }
        for expected in reference["parse"].as_array().context("parse")? {
            let result = parse_permission_list(special(&expected["input"]).as_ref());
            let result = result.map_or(json!("$null"), |list| json!(list));
            assert_eq!(result, expected["result"], "parse {}", expected["input"]);
            rows += 1;
        }
        for expected in reference["expand"].as_array().context("expand")? {
            let asked = requested_permissions(special(&expected["input"]).as_ref());
            assert_eq!(
                json!(expand_channel_permission_checks(&asked)),
                expected["result"],
                "expand {}",
                expected["input"]
            );
            rows += 1;
        }
        for expected in reference["resolve"].as_array().context("resolve")? {
            let granted: Vec<String> = serde_json::from_value(expected["granted"].clone())?;
            let requested: Vec<String> = serde_json::from_value(expected["requested"].clone())?;
            let text = serde_json::to_string(
                &resolve_granted_permissions(&granted, &requested).to_json(),
            )?;
            assert_eq!(text, expected["result"].as_str().unwrap());
            rows += 1;
        }
        for expected in reference["creatorAssignment"]
            .as_array()
            .context("creatorAssignment")?
        {
            let literal = |v: &Value| match v.as_str() {
                Some("$missing") => None,
                Some("creator") => Some(CREATOR.to_owned()),
                other => other.map(str::to_owned),
            };
            let args: Vec<Option<String>> = expected["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(literal)
                .collect();
            let result = can_modify_creator_admin_assignment(
                args[0].as_deref(),
                args[1].as_deref(),
                args[2].as_deref(),
            );
            assert_eq!(
                json!(result),
                expected["result"],
                "creator assignment {:?}",
                args
            );
            rows += 1;
        }
        assert!(
            global.next().is_none()
                && owner.next().is_none()
                && context.next().is_none()
                && decisions.next().is_none()
        );

        // adminMiddleware behind the router.
        let app = app(&stores, access.clone())?;
        let mut changed = Vec::new();
        for expected in reference["adminMiddleware"]
            .as_array()
            .context("adminMiddleware")?
        {
            let user = expected["user"].as_str().context("user")?;
            let (status, body) = send(&app, "/admin", requester_id(user, &run).as_deref()).await?;
            rows += 1;
            if let Some(reason) = admin_middleware_intended(user, expected, status, &body) {
                changed.push((user.to_owned(), reason));
                continue;
            }
            assert_eq!(
                status,
                expected["status"].as_u64().unwrap() as u16,
                "adminMiddleware {user}"
            );
            assert_eq!(
                body,
                expected["body"].as_str().unwrap(),
                "adminMiddleware {user}"
            );
        }
        assert_eq!(changed.len(), 3, "rows changed on purpose: {changed:?}");
        assert_eq!(rows, 2474, "rows replayed");
        Ok(())
    })
    .await
}

/// `adminMiddleware` let any active `admins` row through (a channel editor's included) and did
/// not know the creator without a row. `require_admin` needs a staff role and knows the creator.
fn admin_middleware_intended(
    user: &str,
    expected: &Value,
    status: u16,
    body: &str,
) -> Option<&'static str> {
    match user {
        "full" | "manager" => {
            assert_eq!(expected["status"], 200);
            assert_eq!(status, 403);
            assert_eq!(
                body,
                r#"{"error":true,"message":"Admin privileges required","status":403,"type":"admin_required"}"#
            );
            Some("a channel editor is not site staff")
        }
        "creator" => {
            assert_eq!(expected["status"], 403);
            assert_eq!(status, 200);
            assert_eq!(
                body,
                r#"{"next":true,"globalAdminRole":"creator","isSuperAdmin":true}"#
            );
            Some("the creator is staff without an admins row, as in getGlobalAdminRole")
        }
        _ => None,
    }
}

struct State {
    auth: Authenticator,
    access: ChannelAccess,
}

impl HasAuthenticator for State {
    fn authenticator(&self) -> &Authenticator {
        &self.auth
    }
}

impl HasChannelAccess for State {
    fn channel_access(&self) -> &ChannelAccess {
        &self.access
    }
}

/// Stands in for `require_user`: the user comes from a test header, not from Twitch.
async fn test_user(req: &mut Req<State>) -> Flow {
    if let Some(id) = req.header("x-test-user").map(|v| v.into_owned()) {
        req.extensions_mut()
            .insert(AuthenticatedUser::for_tests(id, "login", "Display", None));
    }
    Flow::Next
}

async fn staff(req: &mut Req<State>) -> Result<Response, dima_web::Error> {
    let staff = StaffAdmin::of(req)?;
    Ok(Response::new().json(&json!({
        "next": true,
        "globalAdminRole": staff.global().map(|role| role.as_str()),
        "isSuperAdmin": staff.global().is_some(),
    })))
}

async fn global(req: &mut Req<State>) -> Result<Response, dima_web::Error> {
    let admin = GlobalAdmin::of(req)?;
    Ok(Response::new().json(&json!({ "role": admin.role().as_str() })))
}

async fn scoped(req: &mut Req<State>) -> Result<Response, dima_web::Error> {
    let scope = ChannelScope::of(req)?;
    let body = req.body().as_object().cloned().unwrap_or_default();
    if let Err(violation) = scope.check_body(&body, "channelID") {
        return Ok(Response::status(400).json(&json!({ "refused": violation.key })));
    }
    Ok(Response::new().json(&json!({
        "channel": scope.channel_id(),
        "role": scope.role_name().as_str(),
        "filter": scope.filter("channelID").get_str("channelID").unwrap_or_default(),
    })))
}

async fn unguarded(req: &mut Req<State>) -> Result<Response, dima_web::Error> {
    let scope = ChannelScope::of(req)?;
    Ok(Response::new().json(&json!({ "channel": scope.channel_id() })))
}

fn app(stores: &Stores, access: ChannelAccess) -> Result<App<State>> {
    // An authenticator is part of the state; these routes never call Twitch.
    let auth = Authenticator::new(
        AuthConfig::new("fixture-client")?,
        AuthDeps {
            twitch: guard_support::user_api(
                stores,
                unreachable_provider(dima_twitch::oauth_provider())?,
                unreachable_provider(dima_twitch::helix_provider("fixture-client"))?,
                "fixture-client",
            )?,
            cache: stores.cache.clone(),
            mongo: stores.mongo.clone(),
            clock: Arc::new(SystemClock),
            report: Arc::new(NoReport),
        },
    );
    let mut router = Router::new();
    router.middleware(dima_web::body::json());
    router.get("/admin", (test_user, require_admin::<State>, staff));
    router.get(
        "/global",
        (test_user, require_global_admin::<State>, global),
    );
    router.patch(
        "/owner/:channelID",
        (test_user, ChannelGuard::owner(), scoped),
    );
    router.patch(
        "/self/:channelID",
        (test_user, ChannelGuard::self_only(), scoped),
    );
    router.patch(
        "/commands/:channelID",
        (
            test_user,
            ChannelGuard::permission("commands:manage"),
            scoped,
        ),
    );
    router.get(
        "/triggers/:channelID",
        (
            test_user,
            ChannelGuard::new(Need::AnyOf(&["triggers:edit", "triggers:delete"])),
            scoped,
        ),
    );
    router.get("/forgotten/:channelID", (test_user, unguarded));
    Ok(App::new(router, State { auth, access })?)
}

fn unreachable_provider(builder: dima_http::ProviderBuilder) -> Result<dima_http::Provider> {
    let name = builder.name();
    Ok(dima_http::ProviderRegistry::builder()
        .test_mode(dima_http::TestMode::RigMock {
            loopback_only: true,
        })
        .provider(builder)
        .base_url_override(name, "http://127.0.0.1:9")
        .build()?
        .get(name)?
        .clone())
}

async fn send(app: &App<State>, path: &str, user: Option<&str>) -> Result<(u16, String)> {
    send_with(app, "GET", path, user, None).await
}

async fn send_with(
    app: &App<State>,
    method: &str,
    path: &str,
    user: Option<&str>,
    body: Option<Value>,
) -> Result<(u16, String)> {
    let mut request = http::Request::builder().method(method).uri(path);
    if let Some(user) = user {
        request = request.header("x-test-user", user);
    }
    let body = match body {
        Some(value) => {
            let text = value.to_string();
            request = request
                .header("content-type", "application/json")
                .header("content-length", text.len());
            Body::from(text)
        }
        None => Body::empty(),
    };
    let response = app.handle(request.body(body)?).await;
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await?.to_bytes();
    Ok((status, String::from_utf8(bytes.to_vec())?))
}

/// The guards routes use: owner, manager with a permission, any-of, global admin; the scope pins
/// the channel and refuses a body that names it.
#[tokio::test]
async fn typed_guards_give_a_checked_scope() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("access-cases.json"))?;
    with_stores(14, |stores| async move {
        seed(&stores, &cases).await?;
        let run = stores.run.clone();
        let app = app(&stores, ChannelAccess::new(stores.mongo.clone(), Duration::from_secs(10)))?;
        let managed = id_of("managed", &run);
        let id = |kind: &str| id_of(kind, &run);
        let refusal = r#"{"error":true,"message":"You do not have permission to access this route","status":403}"#;

        // Owner: the channel itself, the creator, a super admin; not a full channel admin.
        for (who, status, role) in [("owner", 200, "owner"), ("creator", 200, "owner"), ("super", 200, "owner")] {
            let (got, body) = send_with(&app, "PATCH", &format!("/owner/{managed}"), Some(&id(who)), Some(json!({"name": "x"}))).await?;
            assert_eq!((got, serde_json::from_str::<Value>(&body)?), (status, json!({"channel": managed, "role": role, "filter": managed})), "{who}");
        }
        let (got, body) = send_with(&app, "PATCH", &format!("/owner/{managed}"), Some(&id("full")), Some(json!({}))).await?;
        assert_eq!((got, body.as_str()), (403, refusal));
        // A super admin is not an owner of the creator's channel; the creator is.
        assert_eq!(send_with(&app, "PATCH", &format!("/owner/{CREATOR}"), Some(&id("super")), Some(json!({}))).await?.0, 403);
        assert_eq!(send_with(&app, "PATCH", &format!("/owner/{CREATOR}"), Some(CREATOR), Some(json!({}))).await?.0, 200);

        // Self only: the channel's own account; global owners and managers are refused.
        let (got, body) = send_with(&app, "PATCH", &format!("/self/{managed}"), Some(&id("owner")), Some(json!({"name": "x"}))).await?;
        assert_eq!((got, serde_json::from_str::<Value>(&body)?), (200, json!({"channel": managed, "role": "owner", "filter": managed})));
        for who in ["creator", "super", "db_creator", "full", "manager", "viewer"] {
            let (got, body) = send_with(&app, "PATCH", &format!("/self/{managed}"), Some(&id(who)), Some(json!({}))).await?;
            assert_eq!((got, body.as_str()), (403, refusal), "{who}");
        }
        assert_eq!(send_with(&app, "PATCH", &format!("/self/{CREATOR}"), Some(CREATOR), Some(json!({}))).await?.0, 200);
        assert_eq!(send_with(&app, "PATCH", &format!("/self/{managed}"), None, Some(json!({}))).await?.0, 403);
        // The scope still pins the channel.
        assert_eq!(send_with(&app, "PATCH", &format!("/self/{managed}"), Some(&id("owner")), Some(json!({"channelID": id("unrelated")}))).await?.0, 400);

        // Manager with a permission.
        let (got, body) = send_with(&app, "PATCH", &format!("/commands/{managed}"), Some(&id("manager")), Some(json!({"name": "x"}))).await?;
        assert_eq!((got, serde_json::from_str::<Value>(&body)?["role"].clone()), (200, json!("admin")));
        for who in ["viewer", "inactive", "elsewhere", "none", "support", "billing"] {
            assert_eq!(send_with(&app, "PATCH", &format!("/commands/{managed}"), Some(&id(who)), Some(json!({}))).await?.0, 403, "{who}");
        }
        // The body cannot move the document to another channel, nor smuggle operators.
        for body in [json!({"channelID": id("unrelated")}), json!({"$set": {"channelID": "x"}}), json!({"_id": "x"}), json!({"config.channelID": "x"})] {
            let (got, answer) = send_with(&app, "PATCH", &format!("/commands/{managed}"), Some(&id("manager")), Some(body.clone())).await?;
            assert_eq!(got, 400, "{body} {answer}");
        }
        // Any of a list; legacy module-wide grants.
        assert_eq!(send(&app, &format!("/triggers/{managed}"), Some(&id("triggers_all"))).await?.0, 200);
        assert_eq!(send(&app, &format!("/triggers/{managed}"), Some(&id("viewer"))).await?.0, 403);
        // No user, or an empty channel: refused.
        assert_eq!(send(&app, &format!("/triggers/{managed}"), None).await?.0, 403);
        // A handler mounted without its guard fails closed.
        assert_eq!(send(&app, &format!("/forgotten/{managed}"), Some(&id("owner"))).await?.0, 500);

        // Global admin: creator and super only (by id and rows, never by login).
        for (who, status) in [("creator", 200), ("super", 200), ("db_creator", 200), ("super_inactive", 403), ("support", 403), ("full", 403)] {
            assert_eq!(send(&app, "/global", Some(&id(who))).await?.0, status, "{who}");
        }
        let (_, body) = send(&app, "/global", Some(&id("support"))).await?;
        assert_eq!(body, r#"{"error":true,"message":"You do not have permission to access this endpoint","status":403}"#);
        Ok(())
    })
    .await
}

/// The direct API returns the same scope types, and `media_library`'s seam is this service.
#[tokio::test]
async fn direct_scope_and_media_library_seam() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("access-cases.json"))?;
    with_stores(14, |stores| async move {
        seed(&stores, &cases).await?;
        let run = stores.run.clone();
        let access = ChannelAccess::new(stores.mongo.clone(), Duration::from_secs(10));
        let user = |kind: &str| AuthenticatedUser::for_tests(id_of(kind, &run), kind, kind, None);
        let managed = id_of("managed", &run);
        let scope = access
            .scope(&user("super"), &managed, Need::Owner)
            .await?
            .expect("super owns");
        assert!(matches!(scope.role(), ScopeRole::GlobalOwner(_)));
        assert!(
            access
                .scope(&user("full"), &managed, Need::Owner)
                .await?
                .is_err()
        );
        assert!(
            access
                .scope(&user("full"), "", Need::Permission("*"))
                .await?
                .is_err()
        );
        // Self only makes no lookup and admits the channel's own account alone.
        let own = access
            .scope(&user("owner"), &managed, Need::SelfOnly)
            .await?
            .expect("own channel");
        assert_eq!(own.role(), ScopeRole::OwnChannel);
        for who in ["super", "creator", "full"] {
            assert!(
                access
                    .scope(&user(who), &managed, Need::SelfOnly)
                    .await?
                    .is_err(),
                "{who}"
            );
        }
        let seam: &dyn GlobalChannelOwnerAccess = &access;
        assert!(
            seam.has_access(&id_of("super", &run), &managed)
                .await
                .unwrap()
        );
        assert!(
            !seam
                .has_access(&id_of("super", &run), CREATOR)
                .await
                .unwrap()
        );
        assert!(
            !seam
                .has_access(&id_of("full", &run), &managed)
                .await
                .unwrap()
        );
        Ok(())
    })
    .await
}

/// Resumes tokio's clock when dropped, so the store cleanup runs on real time even after a
/// failed assertion.
struct PausedClock;

impl PausedClock {
    fn start() -> Self {
        tokio::time::pause();
        Self
    }
}

impl Drop for PausedClock {
    fn drop(&mut self) {
        tokio::time::resume();
    }
}

/// A lookup that misses its deadline is a refusal (500), never access. The clock is paused while
/// the lookups wait on MongoDB, so the 50 ms deadline passes before any answer can arrive.
#[tokio::test]
async fn a_store_past_its_deadline_refuses() -> Result<()> {
    with_stores(14, |stores| async move {
        let access = ChannelAccess::new(stores.mongo.clone(), Duration::from_millis(50));
        let app = app(&stores, access.clone())?;
        let _paused = PausedClock::start();
        assert!(access.global_admin_role(Some("1")).await.is_err());
        assert!(access.channel_access_context(Some("1"), Some("2"), &["*"]).await.is_err());
        let (status, body) = send_with(&app, "PATCH", "/commands/2", Some("1"), Some(json!({}))).await?;
        assert_eq!(status, 500);
        assert_eq!(body, r#"{"error":true,"message":"Internal server error","status":500,"type":"internal_error"}"#);
        assert_eq!(send(&app, "/admin", Some("1")).await?.0, 500);
        // The own channel needs no lookup.
        assert_eq!(send_with(&app, "PATCH", "/owner/1", Some("1"), Some(json!({}))).await?.0, 200);
        Ok(())
    })
    .await
}
