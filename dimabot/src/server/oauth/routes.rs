//! Axum routers for `oauthRoute` and `oauthApiRoute`.
//!
//! Paths are router-relative. [`OAuthApiService::application_router`] nests them
//! at `/oauth` and `/v1`, which is where `server.ts` mounts the source routers.
//! [`OAuthApiService::protected_router`] is opt-in. The source server does not
//! put `authMiddleware` in front of these routes, and doing so would reject
//! desktop and browser bearers.
//!
//! The boundary middleware sets the no-store headers, answers `OPTIONS` with
//! 204, and rate-limits. Peer IP comes from `ConnectInfo<SocketAddr>`. Without
//! `into_make_service_with_connect_info`, every caller shares the `unknown` bucket.
//!
//! `GET /desktop/ws` is merged after that layer. The source upgrade listener
//! does not run `oauthBoundary`, and `AuthService::protect` is applied only to
//! the HTTP desktop router. Socket.IO remains `socket_io_layer` on `/socket.io`.

use super::{
    catalog::{
        APPROVAL_RATE_LIMIT, BODY_LIMIT_BYTES, CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS,
        DESKTOP_MOUNT, DESKTOP_RATE_LIMIT, ErrorBody, JSON_CONTENT_TYPE, PUBLIC_MOUNT,
        PUBLIC_RATE_LIMIT, SECURITY_CACHE_CONTROL, SECURITY_CONTENT_TYPE_OPTIONS,
        SECURITY_PRAGMA, SECURITY_REFERRER_POLICY, WWW_AUTHENTICATE_INVALID_TOKEN,
        authorization_page, metadata_document, oauth_issuer, oauth_website,
    },
    service::{
        AccessIdentity, ConnectionSession, ExternalFailure, OAuthApiService, OAuthCreditsReader,
        OAuthError, OAuthFailure, OAuthPetAccess, RuntimeError, TokenResponse,
    },
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Path, RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{MethodRouter, delete, get, post, put},
};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value};
use std::net::SocketAddr;

#[derive(Clone)]
struct Gate<C, P> {
    service: OAuthApiService<C, P>,
    bucket_prefix: &'static str,
    limit: i64,
}

#[derive(Serialize)]
struct RedirectBody {
    redirect_uri: String,
}

#[derive(Serialize)]
struct RevokedBody {
    revoked: bool,
}

#[derive(Serialize)]
struct ConnectionsBody {
    sessions: Vec<ConnectionSession>,
}

#[derive(Serialize)]
struct EmptyBody {}

impl<C, P> OAuthApiService<C, P>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    /// Public OAuth router (`oauthRoute`).
    pub fn router(&self) -> Router {
        self.public_router()
    }

    pub fn public_router(&self) -> Router {
        self.gated(public_routes(), "oauth", PUBLIC_RATE_LIMIT)
    }

    /// Desktop HTTP routes (`oauthApiRoute`) with the boundary layer.
    ///
    /// [`Self::protected_desktop_router`] layers legacy auth on this router.
    /// The WebSocket route is omitted here: `AuthService::protect` would
    /// reject a desktop bearer before the upgrade checks run.
    fn http_desktop_router(&self) -> Router {
        self.gated(desktop_routes(), "desktop", DESKTOP_RATE_LIMIT)
    }

    /// Desktop API router plus `GET /desktop/ws`.
    ///
    /// [`Router::layer`] wraps only routes that already exist, so merging
    /// [`super::desktop_websocket::desktop_websocket_router`] after
    /// [`Self::gated`] leaves the socket route outside `oauthBoundary`.
    /// Nesting at `/v1` yields `/v1/desktop/ws`. There is no second absolute
    /// `/v1/desktop/ws` route.
    pub fn desktop_router(&self) -> Router {
        self.http_desktop_router()
            .merge(super::desktop_websocket::desktop_websocket_router(self.clone()))
    }

    /// Opt-in `AuthService` gate in front of the public router.
    pub fn protected_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        auth.protect(self.router())
    }

    /// Opt-in `AuthService` gate in front of the desktop HTTP router only.
    pub fn protected_desktop_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        auth.protect(self.http_desktop_router())
    }

    pub fn mounted_router(&self, mount: &str) -> Router {
        Router::new().nest(mount, self.router())
    }

    pub fn mounted_desktop_router(&self, mount: &str) -> Router {
        Router::new().nest(mount, self.desktop_router())
    }

    /// Both source mounts: `/oauth` and `/v1`.
    pub fn application_router(&self) -> Router {
        Router::new()
            .nest(PUBLIC_MOUNT, self.router())
            .nest(DESKTOP_MOUNT, self.desktop_router())
    }

    fn gated(&self, routes: Router<OAuthApiService<C, P>>, prefix: &'static str, limit: i64) -> Router {
        let gate = Gate { service: self.clone(), bucket_prefix: prefix, limit };
        routes
            .fallback(not_found)
            .layer(middleware::from_fn_with_state(gate, boundary::<C, P>))
            .with_state(self.clone())
    }
}

fn public_routes<C, P>() -> Router<OAuthApiService<C, P>>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    Router::new()
        .route("/metadata", matched(get(metadata::<C, P>)))
        .route("/authorize", matched(get(authorize::<C, P>)))
        .route("/requests/{request}", matched(get(show_request::<C, P>)))
        .route("/requests/{request}/decision", matched(post(decide::<C, P>)))
        .route("/token", matched(post(token::<C, P>)))
        .route("/revoke", matched(post(revoke::<C, P>)))
        .route("/browser-session", matched(get(browser_session::<C, P>)))
        .route("/connections", matched(get(connections::<C, P>)))
        .route("/connections/{session}", matched(delete(delete_connection::<C, P>)))
        .route("/grants/{grant}", matched(delete(delete_grant::<C, P>)))
}

fn desktop_routes<C, P>() -> Router<OAuthApiService<C, P>>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    Router::new()
        .route("/me", matched(get(me::<C, P>)))
        .route("/me/credits", matched(get(credits::<C, P>)))
        .route("/me/pet", matched(get(pet::<C, P>)))
        .route("/me/pet/runtime", matched(get(pet_runtime::<C, P>)))
        .route("/me/pet/playback", matched(put(pet_playback::<C, P>)))
        .route("/me/pet/requests/{requestId}/cancel", matched(post(pet_cancel::<C, P>)))
        .route("/desktop/session", matched(get(desktop_session::<C, P>).delete(desktop_sign_out::<C, P>)))
}

fn matched<S>(router: MethodRouter<S>) -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.fallback(not_found)
}

async fn boundary<C, P>(State(gate): State<Gate<C, P>>, request: Request, next: Next) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let origin = request.headers().get(header::ORIGIN).cloned();
    let website = match oauth_website() {
        Ok(value) => value,
        Err(error) => return finish(fail(&gate.service, error.into()).await, None),
    };
    let origin_ok = match &origin {
        None => true,
        Some(value) => value.as_bytes() == website.as_bytes(),
    };
    if !origin_ok {
        let response = json_response(StatusCode::FORBIDDEN, &ErrorBody { error: "access_denied" });
        return finish(response, None);
    }
    if request.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        return finish(response, origin.as_ref());
    }
    let bucket = format!("{}:{}", gate.bucket_prefix, peer_ip(&request));
    if let Err(error) = gate.service.rate_limit(&bucket, gate.limit).await {
        return finish(fail(&gate.service, error).await, origin.as_ref());
    }
    finish(next.run(request).await, origin.as_ref())
}

fn peer_ip(request: &Request) -> String {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn finish(mut response: Response, origin: Option<&HeaderValue>) -> Response {
    let headers = response.headers_mut();
    insert_static(headers, header::CACHE_CONTROL, SECURITY_CACHE_CONTROL);
    insert_static(headers, header::PRAGMA, SECURITY_PRAGMA);
    insert_static(headers, header::REFERRER_POLICY, SECURITY_REFERRER_POLICY);
    insert_static(headers, header::X_CONTENT_TYPE_OPTIONS, SECURITY_CONTENT_TYPE_OPTIONS);
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        insert_static(headers, header::VARY, "Origin");
        insert_static(headers, header::ACCESS_CONTROL_ALLOW_HEADERS, CORS_ALLOW_HEADERS);
        insert_static(headers, header::ACCESS_CONTROL_ALLOW_METHODS, CORS_ALLOW_METHODS);
    }
    response
}

fn insert_static(headers: &mut HeaderMap, name: header::HeaderName, value: &'static str) {
    headers.insert(name, HeaderValue::from_static(value));
}

async fn metadata<C, P>(State(service): State<OAuthApiService<C, P>>) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match oauth_issuer() {
        Ok(issuer) => {
            let mut response = json_response(StatusCode::OK, &metadata_document(&issuer));
            insert_static(response.headers_mut(), header::CACHE_CONTROL, SECURITY_CACHE_CONTROL);
            response
        }
        Err(error) => fail(&service, error.into()).await,
    }
}

async fn authorize<C, P>(State(service): State<OAuthApiService<C, P>>, RawQuery(query): RawQuery) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match authorize_location(&service, query.as_deref()).await {
        Ok(location) => match HeaderValue::from_str(&location) {
            Ok(value) => {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::FOUND;
                response.headers_mut().insert(header::LOCATION, value);
                response
            }
            Err(_) => fail(&service, RuntimeError::Schema.into()).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

async fn authorize_location<C, P>(service: &OAuthApiService<C, P>, query: Option<&str>) -> Result<String, OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let input = parse_query(query)?;
    let id = service.start_authorization(&input).await?;
    let website = oauth_website()?;
    Ok(authorization_page(&website, &id)?)
}

async fn show_request<C, P>(State(service): State<OAuthApiService<C, P>>, Path(request): Path<String>) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match service.authorization_view(&request).await {
        Ok(view) => json_response(StatusCode::OK, &view),
        Err(error) => fail(&service, error).await,
    }
}

async fn decide<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    Path(request): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = decide_inner(&service, &request, &headers, body).await;
    match result {
        Ok(redirect_uri) => json_response(StatusCode::OK, &RedirectBody { redirect_uri }),
        Err(error) => fail(&service, error).await,
    }
}

async fn decide_inner<C, P>(
    service: &OAuthApiService<C, P>,
    request: &str,
    headers: &HeaderMap,
    body: Body,
) -> Result<String, OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let input = strict_body(headers, body).await?;
    let Some(approve) = input.get("approve").and_then(Value::as_bool) else {
        return Err(OAuthError::InvalidRequest.into());
    };
    let browser = service.browser_user(authorization(headers).as_deref()).await?;
    service.rate_limit(&format!("approval:{}", browser.twitch_id), APPROVAL_RATE_LIMIT).await?;
    service.approve_authorization(request, &browser.twitch_id, approve).await
}

async fn token<C, P>(State(service): State<OAuthApiService<C, P>>, headers: HeaderMap, body: Body) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match token_inner(&service, &headers, body).await {
        Ok(response) => json_response(StatusCode::OK, &response),
        Err(error) => fail(&service, error).await,
    }
}

async fn token_inner<C, P>(
    service: &OAuthApiService<C, P>,
    headers: &HeaderMap,
    body: Body,
) -> Result<TokenResponse, OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let input = strict_body(headers, body).await?;
    let authorization = authorization(headers);
    if input.contains_key("client_secret") || authorization.as_ref().is_some_and(|value| !value.is_empty()) {
        return Err(OAuthError::InvalidClient.into());
    }
    match input.get("grant_type").and_then(Value::as_str) {
        Some("authorization_code") => service.exchange_code(&input).await,
        Some("refresh_token") => service.refresh_access(&input).await,
        _ => Err(OAuthError::UnsupportedGrantType.into()),
    }
}

async fn revoke<C, P>(State(service): State<OAuthApiService<C, P>>, headers: HeaderMap, body: Body) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match revoke_inner(&service, &headers, body).await {
        Ok(()) => json_response(StatusCode::OK, &EmptyBody {}),
        Err(error) => fail(&service, error).await,
    }
}

async fn revoke_inner<C, P>(service: &OAuthApiService<C, P>, headers: &HeaderMap, body: Body) -> Result<(), OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let input = strict_body(headers, body).await?;
    service.revoke_token(&input).await
}

async fn browser_session<C, P>(State(service): State<OAuthApiService<C, P>>, headers: HeaderMap) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match service.browser_user(authorization(&headers).as_deref()).await {
        Ok(user) => {
            let mut body = JsonMap::new();
            body.insert("user_id".to_owned(), Value::String(user.user_id));
            body.insert("channel_id".to_owned(), Value::String(user.twitch_id));
            user.name.insert(&mut body, "name");
            json_response(StatusCode::OK, &Value::Object(body))
        }
        Err(error) => fail(&service, error).await,
    }
}

async fn connections<C, P>(State(service): State<OAuthApiService<C, P>>, headers: HeaderMap) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match connections_inner(&service, &headers).await {
        Ok(sessions) => json_response(StatusCode::OK, &ConnectionsBody { sessions }),
        Err(error) => fail(&service, error).await,
    }
}

async fn connections_inner<C, P>(
    service: &OAuthApiService<C, P>,
    headers: &HeaderMap,
) -> Result<Vec<ConnectionSession>, OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let user = service.browser_user(authorization(headers).as_deref()).await?;
    service.connections(&user.user_id).await
}

async fn delete_connection<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = async {
        let user = service.browser_user(authorization(&headers).as_deref()).await?;
        service.revoke_connection(&user.user_id, &session).await
    }
    .await;
    revoked(&service, result).await
}

async fn delete_grant<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    Path(grant): Path<String>,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = async {
        let user = service.browser_user(authorization(&headers).as_deref()).await?;
        service.revoke_grant(&user.user_id, &grant).await
    }
    .await;
    revoked(&service, result).await
}

async fn me<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match access(&service, &headers, query.as_deref(), Some("profile:read")).await {
        Ok(identity) => match service.profile(&identity).await {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err(error) => fail(&service, error).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

/// `GET /me/credits` and the four pet routes. A 503 from
/// [`super::service::UnwiredCreditsReader`] or [`super::service::UnwiredPetAccess`]
/// is an adapter-boundary convention, not source parity. The TypeScript
/// source always calls `getAiCredits`, `getPetConfiguration`, `getPetRuntime`,
/// `selectOwnPetPlayback`, or `cancelPetRequest`. Once the owning adapter is
/// passed to [`OAuthApiService::new`], the route returns that value and this
/// 503 disappears. A missing scope is 403 `insufficient_scope` and does not
/// call the adapter. Redis, Mongo, and other unknown failures are a separate
/// source-parity 503 from the error handler.
async fn credits<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match access(&service, &headers, query.as_deref(), Some("credits:read")).await {
        Ok(identity) => match service.credits(&identity).await {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err(error) => fail(&service, error).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

async fn pet<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match access(&service, &headers, query.as_deref(), Some("pet:read")).await {
        Ok(identity) => match service.pet_configuration(&identity).await {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err(error) => fail(&service, error).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

async fn pet_runtime<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match access(&service, &headers, query.as_deref(), Some("pet:read")).await {
        Ok(identity) => match service.pet_runtime(&identity).await {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err(error) => fail(&service, error).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

async fn pet_playback<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = async {
        let identity = access(&service, &headers, query.as_deref(), Some("pet:playback:select")).await?;
        let body = express_body(&headers, body).await?;
        service.pet_playback(&identity, &body).await
    }
    .await;
    match result {
        Ok(body) => json_response(StatusCode::OK, &body),
        Err(error) => fail(&service, error).await,
    }
}

async fn pet_cancel<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    Path(request_id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = async {
        let identity = access(&service, &headers, query.as_deref(), Some("pet:control")).await?;
        let body = express_body(&headers, body).await?;
        service.ensure_pet(&identity).await?;
        let command_id = cancel_command(&body)?;
        service.pet_cancel(&identity, &request_id, command_id).await
    }
    .await;
    match result {
        Ok(body) => json_response(StatusCode::OK, &body),
        Err(error) => fail(&service, error).await,
    }
}

async fn desktop_session<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match access(&service, &headers, query.as_deref(), Some("desktop:connect")).await {
        Ok(identity) => match service.desktop_session(&identity).await {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err(error) => fail(&service, error).await,
        },
        Err(error) => fail(&service, error).await,
    }
}

async fn desktop_sign_out<C, P>(
    State(service): State<OAuthApiService<C, P>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let result = async {
        let identity = access(&service, &headers, query.as_deref(), None).await?;
        service.sign_out(&identity).await
    }
    .await;
    revoked(&service, result).await
}

async fn access<C, P>(
    service: &OAuthApiService<C, P>,
    headers: &HeaderMap,
    query: Option<&str>,
    scope: Option<&str>,
) -> Result<AccessIdentity, OAuthFailure>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let identity = service.authenticate_header(authorization(headers).as_deref()).await?;
    if let Some(scope) = scope {
        if !identity.scopes.iter().any(|item| item == scope) {
            return Err(OAuthError::InsufficientScope.into());
        }
    }
    if matches!(query, Some(text) if !text.is_empty()) {
        return Err(OAuthError::InvalidRequest.into());
    }
    Ok(identity)
}

async fn revoked<C, P>(service: &OAuthApiService<C, P>, result: Result<(), OAuthFailure>) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    match result {
        Ok(()) => json_response(StatusCode::OK, &RevokedBody { revoked: true }),
        Err(error) => fail(service, error).await,
    }
}

async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, &ErrorBody { error: "not_found" })
}

async fn fail<C, P>(service: &OAuthApiService<C, P>, failure: OAuthFailure) -> Response
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    let described = service.describe_failure(failure).await;
    let mut response = json_response(status_code(described.status), &ErrorBody { error: &described.code });
    if described.www_authenticate {
        insert_static(response.headers_mut(), header::WWW_AUTHENTICATE, WWW_AUTHENTICATE_INVALID_TOKEN);
    }
    if let Some(retry) = described.retry_after {
        insert_static(response.headers_mut(), header::RETRY_AFTER, retry);
    }
    response
}

fn status_code(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn json_response(status: StatusCode, body: &impl Serialize) -> Response {
    let (status, bytes) = match serde_json::to_vec(body) {
        Ok(bytes) => (status, bytes),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, br#"{"error":"temporarily_unavailable"}"#.to_vec()),
    };
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    insert_static(response.headers_mut(), header::CONTENT_TYPE, JSON_CONTENT_TYPE);
    response
}

fn authorization(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION).map(latin1)
}

fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|byte| char::from(*byte)).collect()
}

fn media_type(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    let kind = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    (!kind.is_empty()).then_some(kind)
}

async fn strict_body(headers: &HeaderMap, body: Body) -> Result<JsonMap<String, Value>, OAuthError> {
    let Value::Object(map) = express_body(headers, body).await? else {
        return Err(OAuthError::InvalidRequest);
    };
    if map.values().any(|item| !matches!(item, Value::String(_) | Value::Bool(_))) {
        return Err(OAuthError::InvalidRequest);
    }
    Ok(map)
}

async fn express_body(headers: &HeaderMap, body: Body) -> Result<Value, OAuthError> {
    let Some(kind) = media_type(headers) else {
        return Ok(Value::Object(JsonMap::new()));
    };
    if kind != "application/json" && kind != "application/x-www-form-urlencoded" {
        return Ok(Value::Object(JsonMap::new()));
    }
    let bytes = to_bytes(body, BODY_LIMIT_BYTES).await.map_err(|_| OAuthError::InvalidRequest)?;
    if bytes.is_empty() {
        return Ok(Value::Object(JsonMap::new()));
    }
    if kind == "application/json" {
        parse_json_body(&bytes)
    } else {
        Ok(Value::Object(parse_form(&bytes)?))
    }
}

fn parse_json_body(bytes: &[u8]) -> Result<Value, OAuthError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| OAuthError::InvalidRequest)?;
    if !matches!(value, Value::Object(_) | Value::Array(_)) {
        return Err(OAuthError::InvalidRequest);
    }
    Ok(value)
}

fn parse_query(query: Option<&str>) -> Result<JsonMap<String, Value>, OAuthError> {
    match query {
        None | Some("") => Ok(JsonMap::new()),
        Some(text) => parse_form(text.as_bytes()),
    }
}

fn parse_form(bytes: &[u8]) -> Result<JsonMap<String, Value>, OAuthError> {
    let text = std::str::from_utf8(bytes).map_err(|_| OAuthError::InvalidRequest)?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1/?{text}")).map_err(|_| OAuthError::InvalidRequest)?;
    let mut map = JsonMap::new();
    for (key, value) in url.query_pairs() {
        if key.contains('[') || key.contains(']') {
            return Err(OAuthError::InvalidRequest);
        }
        let key = key.into_owned();
        let value = Value::String(value.into_owned());
        if let Some(existing) = map.get_mut(&key) {
            match existing {
                Value::Array(items) => items.push(value),
                other => {
                    let first = std::mem::replace(other, Value::Null);
                    *other = Value::Array(vec![first, value]);
                }
            }
        } else {
            map.insert(key, value);
        }
    }
    Ok(map)
}

fn cancel_command(body: &Value) -> Result<Option<&Value>, OAuthFailure> {
    match body {
        Value::Object(map) => {
            if map.keys().any(|key| key != "commandId") {
                return Err(ExternalFailure::pet("invalid_command", 400).into());
            }
            Ok(map.get("commandId"))
        }
        Value::Array(items) if items.is_empty() => Ok(None),
        _ => Err(ExternalFailure::pet("invalid_command", 400).into()),
    }
}
