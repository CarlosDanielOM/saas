//! The OAuth routes of the desktop app's sign-in (`server/oauth/routes.ts`, package
//! **P4-API-APP**) on [`dima_platform::oauth::OAuthService`].
//!
//! # `/oauth` ([`oauth_router`]) and `/v1` ([`oauth_api_router`])
//!
//! Both routers start with the OAuth boundary ([`boundary`]: `Cache-Control: no-store`,
//! `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; a
//! request with an `Origin` other than the website is refused `403 {"error":"access_denied"}`;
//! the website's origin is reflected with its allowed headers and methods; every `OPTIONS` is
//! answered 204), then a rate limit per client address (`/oauth` 600 and `/v1` 1200 requests a
//! minute), then the routes, then `404 {"error":"not_found"}` for anything else, and the error
//! answer (`{"error": code}` with the error's status; anything unexpected
//! `503 temporarily_unavailable`, logged by kind only, never with a body, token or code).
//!
//! | route | guard | rate-limit bucket | inputs |
//! |---|---|---|---|
//! | `GET /oauth/metadata`, `GET /.well-known/oauth-authorization-server` | none | `oauth:<client>` (the first only) | none |
//! | `GET /oauth/authorize` | none | `oauth:<client>` | the query (the service checks each field) |
//! | `GET /oauth/requests/:request` | none | `oauth:<client>` | the request id |
//! | `POST /oauth/requests/:request/decision` | [`browser_user`] after the body check | `oauth:<client>`, then `approval:<twitch id>` (30) | `approve` (boolean) |
//! | `POST /oauth/token`, `POST /oauth/revoke` | none (public client; a `client_secret` or `Authorization` is `invalid_client`) | `oauth:<client>` | form or JSON of strings and booleans |
//! | `GET /oauth/browser-session`, `GET /oauth/connections`, `DELETE /oauth/connections/:session`, `DELETE /oauth/grants/:grant` | [`browser_user`] | `oauth:<client>` | an ObjectId |
//! | `/v1/*` (16 routes) | [`access`]`(scope)`: an OAuth access token with the scope, and no query | `desktop:<client>` | see [`desktop`] |
//!
//! `browser_user` is the reference's `browserUser`: a fresh proof from Twitch's token
//! validation for every request (never the validation cache of `authMiddleware`), of a token
//! issued to this application, not expired, whose account has a site user
//! ([`dima_platform::oauth::OAuthService::browser_user`]). Its refusals are the OAuth
//! answers (`401 login_required`, `403 account_required`), not `authMiddleware`'s envelope.
//!
//! # The client address of the rate limits
//!
//! [`crate::app::ClientAddressPolicy`]: the address the trusted reverse proxy reports, else the
//! peer. The reference keyed both limits by `req.ip` with proxy trust off, one bucket for
//! everyone (an intended difference, and a security fix: one client could lock every user out
//! of the desktop sign-in).
//!
//! # Intended differences
//!
//! - The rate-limit buckets are per client address (above).
//! - An access token or browser token of more than the header limit never reaches a handler
//!   (`dima_web::MAX_HEAD_BYTES`).

pub mod areas;
mod browser;
mod desktop;

pub use areas::{
    AreaError, AreaResult, DesktopCredits, DesktopTurns, PetControl, SERVICES, TurnAudio,
};

use crate::state::RouteState;
use dima_platform::oauth::catalog::{
    ACCESS_TTL_SECONDS, DESKTOP_CLIENT_ID, active_scopes, planned_scopes,
};
use dima_platform::oauth::{AccessIdentity, BrowserUser, OAuthError};
use dima_telemetry::LogOptions;
use dima_web::{BoxFuture, Error, Flow, Handler, Req, Response, Router};
use serde_json::json;

/// The `/oauth` limit per client and minute (`routes.ts:83`).
pub const OAUTH_LIMIT: u64 = 600;
/// The `/v1` limit per client and minute (`routes.ts:178`).
pub const DESKTOP_LIMIT: u64 = 1200;
/// Approvals per Twitch account and minute (`routes.ts:120`).
pub const APPROVAL_LIMIT: u64 = 30;

/// `oauthRoute`, mounted at `/oauth`.
pub fn oauth_router<S: RouteState>() -> Router<S> {
    let mut router = Router::new();
    router.middleware(boundary::<S>);
    router.middleware(limit_oauth::<S>);
    router.get("/metadata", metadata::<S>);
    router.get("/authorize", browser::authorize::<S>);
    router.get("/requests/:request", browser::request::<S>);
    router.post(
        "/requests/:request/decision",
        (
            browser::decision_input::<S>,
            browser_user::<S>,
            browser::decide::<S>,
        ),
    );
    router.post("/token", browser::token::<S>);
    router.post("/revoke", browser::revoke::<S>);
    router.get(
        "/browser-session",
        (browser_user::<S>, browser::session::<S>),
    );
    router.get(
        "/connections",
        (browser_user::<S>, browser::connections::<S>),
    );
    router.delete(
        "/connections/:session",
        (browser_user::<S>, browser::drop_connection::<S>),
    );
    router.delete(
        "/grants/:grant",
        (browser_user::<S>, browser::drop_grant::<S>),
    );
    router.middleware(not_found::<S>);
    router.on_error(answer_error::<S>);
    router
}

/// `oauthApiRoute`, mounted at `/v1`.
pub fn oauth_api_router<S: RouteState>() -> Router<S> {
    let mut router = Router::new();
    router.middleware(boundary::<S>);
    router.middleware(limit_desktop::<S>);
    desktop::routes(&mut router);
    router.middleware(not_found::<S>);
    router.on_error(answer_error::<S>);
    router
}

/// `oauthBoundary` (`routes.ts:22`).
pub async fn boundary<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    for (name, value) in [
        ("Cache-Control", "no-store"),
        ("Pragma", "no-cache"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
    ] {
        req.set_header(name, value)?;
    }
    let origin = req
        .header("origin")
        .map(|origin| origin.into_owned())
        .filter(|origin| !origin.is_empty());
    if let Some(origin) = origin {
        if origin != req.state().core().oauth.config().website() {
            return Ok(Flow::Respond(OAuthError::ACCESS_DENIED.response()));
        }
        req.set_header("Access-Control-Allow-Origin", &origin)?;
        req.vary("Origin")?;
        req.set_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, X-Dima-Audio-Ticket",
        )?;
        req.set_header(
            "Access-Control-Allow-Methods",
            "GET, PUT, POST, DELETE, OPTIONS",
        )?;
    }
    if req.method() == http::Method::OPTIONS {
        return Ok(Flow::Respond(Response::send_status(204)));
    }
    Ok(Flow::Next)
}

async fn limit<S: RouteState>(req: &Req<S>, prefix: &str, max: u64) -> Result<Flow, Error> {
    let state = req.state_arc();
    let core = state.core();
    let client = core
        .config
        .client_address
        .client_address(req.peer_addr().map(|peer| peer.ip()), req.headers());
    let bucket = match client {
        Some(client) => format!("{prefix}:{}", client.bucket()),
        None => format!("{prefix}:unknown"),
    };
    core.oauth.rate_limit(&bucket, max).await?;
    Ok(Flow::Next)
}

async fn limit_oauth<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    limit(req, "oauth", OAUTH_LIMIT).await
}

async fn limit_desktop<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    limit(req, "desktop", DESKTOP_LIMIT).await
}

async fn not_found<S: RouteState>(_req: &mut Req<S>) -> Response {
    OAuthError::NOT_FOUND.response()
}

/// `{"error": code}` with `status`, and the headers [`OAuthError::response`] adds.
fn code_answer(code: &str, status: u16) -> Response {
    let mut response = Response::status(status).json(&json!({ "error": code }));
    if status == 401 {
        response = response.header("WWW-Authenticate", "Bearer error=\"invalid_token\"");
    }
    if status == 429 {
        response = response.header("Retry-After", "60");
    }
    response
}

/// `errorHandler` (`routes.ts:71`).
async fn answer_error<S: RouteState>(error: Error, req: &mut Req<S>) -> Result<Response, Error> {
    if let Some(known) = error.downcast_ref::<OAuthError>() {
        return Ok(known.response());
    }
    if let Some(known) = error.downcast_ref::<AreaError>() {
        return Ok(code_answer(&known.code, known.status));
    }
    // The kind and status only (and which service is missing): never a body, token or code.
    let missing = (error.kind() == Some("service.missing")).then(|| error.message().to_owned());
    req.state().core().telemetry.error(
        &json!({
            "function": "[OAuth] Request failed",
            "error": error.kind().unwrap_or("UnknownError"),
            "status": error.status(),
            "service": missing,
        }),
        LogOptions::console(),
    );
    Ok(OAuthError::UNAVAILABLE.response())
}

/// `oauthMetadata` (`routes.ts:85`), at `/.well-known/oauth-authorization-server` and
/// `/oauth/metadata`.
pub async fn metadata<S: RouteState>(req: &mut Req<S>) -> Response {
    let issuer = req.state().core().oauth.config().issuer().to_owned();
    let websocket = match issuer.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => issuer.clone(),
    };
    Response::new().header("Cache-Control", "no-store").json(&json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "revocation_endpoint": format!("{issuer}/oauth/revoke"),
        "scopes_supported": active_scopes(),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "authorization_response_iss_parameter_supported": true,
        "beta": {
            "client_id": DESKTOP_CLIENT_ID,
            "protocol_version": 1,
            "access_token_lifetime": ACCESS_TTL_SECONDS,
            "websocket_endpoint": format!("{websocket}/v1/desktop/ws"),
            "socket_io": { "path": "/socket.io/", "namespace": "/desktop", "protocol_version": 1 },
            "ai_capabilities_endpoint": format!("{issuer}/v1/me/ai/capabilities"),
            "permission_profile_version": 2,
            "planned_scopes": planned_scopes(),
        },
    }))
}

/// The identity an OAuth access token proved, attached by [`access`]. Only that guard makes
/// one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthAccess(AccessIdentity);

impl OAuthAccess {
    /// What [`access`] attached: a 500 when the route was mounted without it.
    pub fn of<S>(req: &Req<S>) -> Result<&OAuthAccess, Error> {
        req.extensions()
            .get::<OAuthAccess>()
            .ok_or_else(|| Error::new(500, "OAuth access guard missing"))
    }

    /// The identity (session, user, client, channel, scopes).
    pub fn identity(&self) -> &AccessIdentity {
        &self.0
    }

    /// For tests of the seams in other crates.
    pub fn for_tests(identity: AccessIdentity) -> Self {
        Self(identity)
    }
}

/// The guard of the `/v1` routes: the reference's `access(req, scope)` (`routes.ts:62`).
#[derive(Clone, Copy, Debug)]
pub struct AccessGuard {
    scope: Option<&'static str>,
}

/// An OAuth access token (`Authorization: Bearer dima_at_…`) with `scope` when given, checked
/// against its session; then a request with any query parameter is `invalid_request` (the
/// routes never accept a client-selected account or channel). Attaches [`OAuthAccess`].
pub fn access(scope: Option<&'static str>) -> AccessGuard {
    AccessGuard { scope }
}

/// `^Bearer (\S+)$`.
fn bearer(header: &str) -> Option<&str> {
    header
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty() && !token.chars().any(js_space))
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

impl<S: RouteState> Handler<S> for AccessGuard {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            let state = req.state_arc();
            let header = req.header("authorization").map(|value| value.into_owned());
            let identity = state
                .core()
                .oauth
                .authenticate_access(header.as_deref().and_then(bearer))
                .await?;
            if let Some(scope) = self.scope
                && !identity.scopes.iter().any(|granted| granted == scope)
            {
                return Err(OAuthError::INSUFFICIENT_SCOPE.into());
            }
            if req
                .query()
                .as_object()
                .is_some_and(|query| !query.is_empty())
            {
                return Err(OAuthError::INVALID_REQUEST.into());
            }
            req.extensions_mut().insert(OAuthAccess(identity));
            Ok(Flow::Next)
        })
    }
}

/// The site account behind a fresh Twitch proof, attached by [`browser_user`].
#[derive(Clone, Debug)]
pub struct BrowserIdentity(BrowserUser);

impl BrowserIdentity {
    /// What [`browser_user`] attached: a 500 when the route was mounted without it.
    pub fn of<S>(req: &Req<S>) -> Result<&BrowserIdentity, Error> {
        req.extensions()
            .get::<BrowserIdentity>()
            .ok_or_else(|| Error::new(500, "browser identity guard missing"))
    }

    /// The account and the Twitch id the proof named.
    pub fn user(&self) -> &BrowserUser {
        &self.0
    }
}

/// `browserUser` (`routes.ts:46`) as a guard: attaches [`BrowserIdentity`] or answers
/// `401 login_required`, `403 account_required`, `503 temporarily_unavailable`.
pub async fn browser_user<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    let state = req.state_arc();
    let header = req.header("authorization").map(|value| value.into_owned());
    let user = state.core().oauth.browser_user(header.as_deref()).await?;
    req.extensions_mut().insert(BrowserIdentity(user));
    Ok(Flow::Next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_shape() {
        assert_eq!(bearer("Bearer dima_at_x"), Some("dima_at_x"));
        assert_eq!(bearer("Bearer "), None);
        assert_eq!(bearer("Bearer a b"), None);
        assert_eq!(bearer("bearer a"), None);
        assert_eq!(bearer("Bearer a\u{a0}"), None);
    }
}
