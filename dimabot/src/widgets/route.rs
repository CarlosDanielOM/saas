//! Axum port of `dimabot/src/server/routes/widgets.route.ts`.
//!
//! `GET /{channelID}/overlay` is public and checks the overlay token. Every
//! other `/{channelID}` route requires `authMiddleware`, then owner or
//! full-access admin (`*`), then Premium. `Cache-Control: no-store` is set
//! on the way out for the whole router, including auth rejections.
//!
//! `POST /{channelID}/actions/{action}` mirrors the source: `execute` may
//! launch `start.poll` immediately for `start`/`retry-poll`, then the response
//! is the `snapshot` of the same channel. A launch failure is persisted as
//! `poll-error`; it is not an HTTP error. The snapshot's `advance` observes an
//! already-started poll on the next request.
//!
//! Success bodies are `{ error, status, message, data }`. Known
//! [`RouletteError`] values keep their status, code, and message. Any other
//! failure is logged and answered as `500` `internal` / `Widget operation
//! failed`. An empty body is `{}`. JSON `null` is `{}`, matching `req.body ??
//! {}`. A non-empty body that `parse_json` rejects is the generic 500.
//!
//! The duel router is nested behind the same gates. This module does not
//! implement duel handlers. An empty nested router answers 404 for
//! `/{channelID}/duel` until integration mounts the real one. The nested
//! router must use [`WidgetHttpState`].

#![cfg(feature = "widgets-runtime")]

use super::catalog::catalog;
use super::service::{
    WidgetService, WidgetServiceError, idempotency_key, if_match_revision, parse_widget_action,
    route_channel,
};
use crate::api_admin::AdminService;
use crate::api_auth::{AuthService, ROUTE_CHANNEL_PARAM, authenticated_user};
use crate::roulette_runtime::model::{RouletteError, fail};
use crate::utils::logger::{Destination, Level, LogOptions};
use crate::utils::lossless_json::{JsonValue, parse_json};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{FromRequestParts, Path, RawPathParams, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::Value;

/// Express `json` default, used when the body is read explicitly.
const JSON_BODY_LIMIT: usize = 100 * 1024;

/// Shared handles for the widget router. Cloning is cheap.
#[derive(Clone)]
pub struct WidgetHttpState {
    pub auth: AuthService,
    pub admin: AdminService,
    pub widgets: WidgetService,
}

#[derive(Serialize)]
struct OkBody<T> {
    error: bool,
    status: u16,
    message: &'static str,
    data: T,
}

#[derive(Serialize)]
struct ErrBody {
    error: bool,
    status: u16,
    code: String,
    message: String,
}

#[derive(Serialize)]
struct OverlayBody<'a> {
    state: super::service::WidgetSnapshot,
    catalog: &'a super::catalog::Catalog,
}

/// Router with no duel handlers mounted.
pub fn router(state: WidgetHttpState) -> Router {
    router_with_duel(state, Router::new())
}

/// Same router, with `/{channelID}/duel` delegated to `duel`.
///
/// Auth is the outer layer of the gated router. The channel gate is inside
/// it, and the nested duel router is inside the gate. The last Axum layer
/// runs first on the way in.
pub fn router_with_duel(state: WidgetHttpState, duel: Router<WidgetHttpState>) -> Router {
    let overlay = Router::new().route("/{channelID}/overlay", get(overlay));
    let gated = Router::new()
        .route("/{channelID}/catalog", get(catalog_route))
        .nest("/{channelID}/duel", duel)
        .route("/{channelID}/events", get(events_route))
        .route("/{channelID}", get(snapshot_route))
        .route("/{channelID}/overlay-token", get(token_state).post(token_update))
        .route("/{channelID}/actions/{action}", post(action_route))
        .layer(middleware::from_fn_with_state(state.clone(), channel_gate));
    let protected = state.auth.protect(gated);
    overlay.merge(protected).layer(middleware::from_fn(no_store)).with_state(state)
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn channel_gate(
    State(http): State<WidgetHttpState>,
    request: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let raw = raw_channel(&mut parts).await;
    let user_id = authenticated_user(&parts.extensions).map(|user| user.id.clone());
    let permission = ["*".to_owned()];
    let access = http
        .admin
        .get_channel_access_context(user_id.as_deref(), raw.as_deref(), &permission)
        .await;
    let allowed = match access {
        Ok(access) => access.allowed,
        Err(error) => {
            log_failure(&http, &error.to_string()).await;
            return error_response(500, "internal", "Widget operation failed");
        }
    };
    if !allowed {
        return error_response(
            403,
            "permission_required",
            "Channel owner or full-access admin required",
        );
    }
    let Some(raw) = raw else {
        return domain_response(&fail("invalid", "channelID must contain 1–30 characters", 400));
    };
    let channel = match route_channel(&raw) {
        Ok(channel) => channel,
        Err(error) => return domain_response(&error),
    };
    if let Err(error) = http.widgets.require_premium(&channel).await {
        return service_response(&http, error).await;
    }
    next.run(Request::from_parts(parts, body)).await
}

async fn raw_channel(parts: &mut Parts) -> Option<String> {
    let params = RawPathParams::from_request_parts(parts, &()).await.ok()?;
    params.iter().find(|(key, _)| *key == ROUTE_CHANNEL_PARAM).map(|(_, value)| value.to_owned())
}

async fn overlay(
    State(http): State<WidgetHttpState>,
    Path(channel): Path<String>,
    headers: HeaderMap,
) -> Response {
    let channel = match route_channel(&channel) {
        Ok(channel) => channel,
        Err(error) => return domain_response(&error),
    };
    let token = overlay_authorization(&headers);
    match http.widgets.authorize_overlay(&channel, token.as_deref()).await {
        Ok(true) => {}
        Ok(false) => {
            return domain_response(&fail("unauthorized", "Invalid widget overlay token", 401));
        }
        Err(error) => return service_response(&http, error).await,
    }
    let state = match http.widgets.snapshot(&channel).await {
        Ok(state) => state,
        Err(error) => return service_response(&http, error).await,
    };
    match catalog() {
        Ok(catalog) => ok(OverlayBody { state, catalog }),
        Err(error) => {
            log_failure(&http, &error.to_string()).await;
            error_response(500, "internal", "Widget operation failed")
        }
    }
}

async fn catalog_route(State(http): State<WidgetHttpState>) -> Response {
    match catalog() {
        Ok(catalog) => ok(catalog),
        Err(error) => {
            log_failure(&http, &error.to_string()).await;
            error_response(500, "internal", "Widget operation failed")
        }
    }
}

async fn events_route(
    State(http): State<WidgetHttpState>,
    Path(channel): Path<String>,
) -> Response {
    let channel = match require_channel(&channel) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    match http.widgets.widget_event_settings(&channel).await {
        Ok(view) => ok(view),
        Err(error) => service_response(&http, error).await,
    }
}

async fn snapshot_route(
    State(http): State<WidgetHttpState>,
    Path(channel): Path<String>,
) -> Response {
    let channel = match require_channel(&channel) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    match http.widgets.snapshot(&channel).await {
        Ok(snapshot) => ok(snapshot),
        Err(error) => service_response(&http, error).await,
    }
}

async fn token_state(State(http): State<WidgetHttpState>, Path(channel): Path<String>) -> Response {
    let channel = match require_channel(&channel) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    match http.widgets.overlay_token_state(&channel).await {
        Ok(view) => ok(view),
        Err(error) => service_response(&http, error).await,
    }
}

async fn token_update(
    State(http): State<WidgetHttpState>,
    Path(channel): Path<String>,
    body: Body,
) -> Response {
    let channel = match require_channel(&channel) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    let body = match json_body(&http, body).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match http.widgets.update_overlay_token(&channel, &body).await {
        Ok(view) => ok(view),
        Err(error) => service_response(&http, error).await,
    }
}

async fn action_route(
    State(http): State<WidgetHttpState>,
    Path((channel, action)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let channel = match require_channel(&channel) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    let action = match parse_widget_action(&action) {
        Ok(action) => action,
        Err(error) => return domain_response(&error),
    };
    let idempotency = header_text(&headers, "idempotency-key");
    let key = match idempotency_key(idempotency.as_deref()) {
        Ok(key) => key,
        Err(error) => return domain_response(&error),
    };
    let if_match = header_text(&headers, "if-match");
    let revision = match if_match_revision(if_match.as_deref()) {
        Ok(revision) => revision,
        Err(error) => return domain_response(&error),
    };
    let body = match json_body(&http, body).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(error) = http.widgets.execute(&channel, action, &body, &key, revision).await {
        return service_response(&http, error).await;
    }
    match http.widgets.snapshot(&channel).await {
        Ok(snapshot) => ok(snapshot),
        Err(error) => service_response(&http, error).await,
    }
}

fn require_channel(channel: &str) -> Result<String, Response> {
    route_channel(channel).map_err(|error| domain_response(&error))
}

/// `authorization` with only an exact `Bearer ` prefix removed. Missing stays missing.
fn overlay_authorization(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION).map(|value| {
        let text = latin1(value);
        text.strip_prefix("Bearer ").unwrap_or(&text).to_owned()
    })
}

fn header_text(headers: &HeaderMap, name: &'static str) -> Option<String> {
    headers.get(name).map(latin1)
}

fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|byte| char::from(*byte)).collect()
}

async fn json_body(http: &WidgetHttpState, body: Body) -> Result<JsonValue, Response> {
    let bytes = match to_bytes(body, JSON_BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(error) => {
            log_failure(http, &error.to_string()).await;
            return Err(error_response(500, "internal", "Widget operation failed"));
        }
    };
    if bytes.is_empty() {
        return Ok(JsonValue::Object(Vec::new()));
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) => {
            log_failure(http, &error.to_string()).await;
            return Err(error_response(500, "internal", "Widget operation failed"));
        }
    };
    match parse_json(text) {
        Ok(JsonValue::Null) => Ok(JsonValue::Object(Vec::new())),
        Ok(value) => Ok(value),
        Err(error) => {
            log_failure(http, &error).await;
            Err(error_response(500, "internal", "Widget operation failed"))
        }
    }
}

fn ok(data: impl Serialize) -> Response {
    json_response(StatusCode::OK, OkBody { error: false, status: 200, message: "OK", data })
}

fn domain_response(error: &RouletteError) -> Response {
    error_response(error.status, &error.code, &error.message)
}

async fn service_response(http: &WidgetHttpState, error: WidgetServiceError) -> Response {
    match error {
        WidgetServiceError::Domain(error) => domain_response(&error),
        other => {
            log_failure(http, &other.to_string()).await;
            error_response(500, "internal", "Widget operation failed")
        }
    }
}

fn error_response(status: u16, code: &str, message: &str) -> Response {
    let http = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    json_response(
        http,
        ErrBody { error: true, status, code: code.to_owned(), message: message.to_owned() },
    )
}

fn json_response(status: StatusCode, body: impl Serialize) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

async fn log_failure(http: &WidgetHttpState, detail: &str) {
    let Some(logger) = http.widgets.logger() else {
        eprintln!("Widget request failed {detail}");
        return;
    };
    logger
        .log(
            Level::Error,
            Value::String(format!("Widget request failed {detail}")),
            LogOptions { destination: Destination::Console, ..Default::default() },
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_poll_is_known_and_other_names_are_rejected() {
        assert_eq!(parse_widget_action("retry-poll").expect("retry").as_str(), "retry-poll");
        let error = parse_widget_action("nope").expect_err("unknown");
        assert_eq!(error.code, "invalid");
        assert_eq!(error.status, 400);
        assert_eq!(error.message, "Unknown widget action");
    }

    /// The URL carries the source action name. The AST function name
    /// (`start.poll`) is not an action; `start` is, with the poll mode in the
    /// body, and `retry-poll` is the only hyphenated name.
    #[test]
    fn only_source_action_names_are_accepted() {
        for name in [
            "select",
            "configure",
            "start",
            "show",
            "hide",
            "reset",
            "retry-poll",
            "role",
            "layout",
            "progress",
            "events",
        ] {
            assert_eq!(parse_widget_action(name).expect(name).as_str(), name);
        }
        for name in ["start.poll", "poll", "retry_poll", "Retry-Poll", "Start"] {
            assert_eq!(
                parse_widget_action(name).expect_err(name).message,
                "Unknown widget action",
                "{name}"
            );
        }
    }
}
