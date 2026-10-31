//! Working native port of `dimabot/src/server/routes/validation.route.ts`.
//!
//! The source is an Express router with one handler, `POST /:channelID`, that
//! is guarded by `authMiddleware` at mount time. The handler then repeats its
//! own cache lookup with the **raw** `Authorization` header value:
//!
//! 1. read `token:<raw header>` with two separate `HGET` calls (`id`, `login`);
//! 2. a missing, empty or absent `id`/`login` answers
//!    `400 {"error":true,"message":"Invalid token","access":false,"status":400}`;
//! 3. `channelID === id` answers the exact `200` success body without any admin
//!    command;
//! 4. otherwise `SISMEMBER twitch:<channelID>:admins <login>`; `0` answers
//!    `403 {"error":true,"message":"User is not an admin","access":false,"status":403}`;
//! 5. then `EXISTS twitch:<channelID>:admins:<id>`; `0` answers the same `403`;
//! 6. anything else answers the exact `200` success body.
//!
//! Command order, command names, keys and members are preserved exactly. The
//! source never strips `Bearer `; a `Bearer <token>` request is looked up as
//! `token:Bearer <token>` even though the middleware authenticated
//! `token:<token>`. That mismatch is source behavior and is reproduced.
//!
//! The service holds concrete handles only: a Redis [`ConnectionManager`]
//! (cheaply cloned per request, sharing the multiplexed socket) and an optional
//! shared native [`Logger`]. Construction performs no I/O; [`Self::from_runtime`]
//! is the explicit convenience constructor that uses the existing native
//! `get_redis_client` helper.
//!
//! Deliberate boundaries (documented in
//! `migration-notes/validation-route-handoff.md`):
//! - The source handler has no `try`/`catch`. A Redis acquisition or command
//!   failure rejects the async handler, which Express 4 does not observe, so the
//!   source never completes the response (and logs an unhandled rejection).
//!   This port converts every such failure into a completed
//!   `500 {"error":true,"message":"Internal server error","access":false,"status":500}`
//!   body. That 500 body is native-only; the source has no rendered 500.
//! - The source acquires the shared cache client on every request; this port
//!   receives the concrete manager once. A failed acquisition is therefore a
//!   construction error for the composition root, not a per-request response.
//! - `console.error(payload, true, channelID, tag)` writes one stderr line with
//!   positional helper arguments. The native logger keeps the structured payload
//!   and `channelId` but has no positional tail, and it stamps its own
//!   timestamp; the payload also keeps the source `timestamp` field.
//! - Express framework headers (`ETag`, `X-Powered-By`) are not emulated. The
//!   JSON content type includes `charset=utf-8` like Express.
//! - `server.ts` never mounts this router, so no mount path is asserted here;
//!   [`ROUTE_PATH`] is the router-relative path only.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

/// Route parameter name used by the source (`req.params.channelID`).
pub const ROUTE_PARAM: &str = "channelID";
/// Router-relative path (`router.post('/:channelID', ...)`), in Axum 0.8 syntax.
pub const ROUTE_PATH: &str = "/{channelID}";
/// Success message, byte-for-byte from the source.
pub const VALIDATION_SUCCESS_MESSAGE: &str = "Validation successful";
/// Missing-header message, byte-for-byte from the source.
pub const MISSING_TOKEN_MESSAGE: &str = "Missing token";
/// Unknown-token message, byte-for-byte from the source.
pub const INVALID_TOKEN_MESSAGE: &str = "Invalid token";
/// Both admin-gate messages, byte-for-byte from the source.
pub const NOT_ADMIN_MESSAGE: &str = "User is not an admin";
/// Native-only message for the completed 500 documented above.
pub const INTERNAL_ERROR_MESSAGE: &str = "Internal server error";
/// Prefix of `token:<token>` cache hashes.
pub const TOKEN_KEY_PREFIX: &str = "token:";
/// Suffix of `twitch:<channelID>:admins` member sets.
pub const ADMINS_KEY_SUFFIX: &str = ":admins";

/// `token:<token>`, with the raw header value the source received.
pub fn token_key(token: &str) -> String {
    format!("{TOKEN_KEY_PREFIX}{token}")
}

/// `twitch:<channelID>:admins`.
pub fn admins_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}{ADMINS_KEY_SUFFIX}")
}

/// `twitch:<channelID>:admins:<id>`.
pub fn admin_details_key(channel_id: &str, user_id: &str) -> String {
    format!("twitch:{channel_id}{ADMINS_KEY_SUFFIX}:{user_id}")
}

/// The four source response shapes, in the source's field order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ValidationBody {
    pub error: bool,
    pub message: &'static str,
    pub access: bool,
    pub status: u16,
}

impl ValidationBody {
    /// `res.status(200).json({ error:false, message:'Validation successful', access:true, status:200 })`.
    pub const fn success() -> Self {
        Self {
            error: false,
            message: VALIDATION_SUCCESS_MESSAGE,
            access: true,
            status: 200,
        }
    }

    /// `400 Missing token`.
    pub const fn missing_token() -> Self {
        Self {
            error: true,
            message: MISSING_TOKEN_MESSAGE,
            access: false,
            status: 400,
        }
    }

    /// `400 Invalid token`.
    pub const fn invalid_token() -> Self {
        Self {
            error: true,
            message: INVALID_TOKEN_MESSAGE,
            access: false,
            status: 400,
        }
    }

    /// `403 User is not an admin`.
    pub const fn not_admin() -> Self {
        Self {
            error: true,
            message: NOT_ADMIN_MESSAGE,
            access: false,
            status: 403,
        }
    }

    /// Native-only completed 500; the source never renders a response here.
    pub const fn internal_error() -> Self {
        Self {
            error: true,
            message: INTERNAL_ERROR_MESSAGE,
            access: false,
            status: 500,
        }
    }
}

/// Concrete route service.
///
/// Cloning is cheap and clones share the multiplexed Redis connection and the
/// logger.
#[derive(Clone)]
pub struct ValidationRouteService {
    redis: ConnectionManager,
    logger: Option<crate::utils::logger::Logger>,
}

impl ValidationRouteService {
    /// Builds the service from already-created concrete handles. No I/O.
    pub fn new(redis: ConnectionManager, logger: Option<crate::utils::logger::Logger>) -> Self {
        Self { redis, logger }
    }

    /// Connects through the existing native `get_redis_client` helper.
    ///
    /// Intended for an explicit, lazy runtime factory in the composition root.
    pub async fn from_runtime(
        logger: Option<crate::utils::logger::Logger>,
    ) -> Result<Self, redis::RedisError> {
        let redis = crate::utils::redis::get_redis_client().await?;
        Ok(Self::new(redis, logger))
    }

    /// Router with the source's router-relative `POST /:channelID` route.
    pub fn router(&self) -> Router {
        Router::new()
            .route(ROUTE_PATH, post(validate_channel))
            .with_state(self.clone())
    }

    /// The source's composed stack: [`AuthService::protect`] in front of the
    /// router. Authentication answers `401` before this handler runs.
    ///
    /// [`AuthService::protect`]: crate::api_auth::AuthService::protect
    pub fn protected_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        auth.protect(self.router())
    }

    /// Router nested under an explicit mount path chosen by the caller.
    ///
    /// The source never mounts this router, so no mount path is fixed here.
    pub fn mounted_router(&self, mount_path: &str) -> Router {
        Router::new().nest(mount_path, self.router())
    }

    /// Cache handle used by one request (a cheap clone of the shared manager).
    pub fn redis_connection(&self) -> &ConnectionManager {
        &self.redis
    }

    pub fn logger(&self) -> Option<&crate::utils::logger::Logger> {
        self.logger.as_ref()
    }

    async fn log_entry(&self, payload: Value, channel_id: &str) {
        let Some(logger) = self.logger.as_ref() else {
            return;
        };
        let _ = logger
            .log(
                crate::utils::logger::Level::Error,
                payload,
                crate::utils::logger::LogOptions {
                    destination: crate::utils::logger::Destination::Console,
                    channel_id: Some(channel_id.to_owned()),
                    ..Default::default()
                },
            )
            .await;
    }

    /// Source `console.error(...)` for one of the four validation branches.
    async fn log_validation_failure(
        &self,
        message: &'static str,
        channel_id: &str,
        extra_field: Option<(&'static str, &str)>,
    ) {
        let mut payload = serde_json::Map::new();
        let _ = payload.insert("error".into(), Value::Bool(true));
        let _ = payload.insert("message".into(), Value::String(message.into()));
        let _ = payload.insert("channelID".into(), Value::String(channel_id.into()));
        if let Some((field, value)) = extra_field {
            let _ = payload.insert(field.into(), Value::String(value.into()));
        }
        let _ = payload.insert("timestamp".into(), Value::String(iso_timestamp_now()));
        self.log_entry(Value::Object(payload), channel_id).await;
    }

    /// Native-only diagnostics for a Redis failure the source never handles.
    async fn cache_failure(
        &self,
        channel_id: &str,
        command: &'static str,
        error: &redis::RedisError,
    ) -> Response {
        self.log_entry(
            json!({
                "function": "validationRoute",
                "command": command,
                "channelID": channel_id,
                "error": error.to_string(),
            }),
            channel_id,
        )
        .await;
        json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            ValidationBody::internal_error(),
        )
    }

    async fn handle(&self, channel_id: String, headers: HeaderMap) -> Response {
        // The source reads `req.headers.authorization` (Node lowercases header
        // names) and never strips `Bearer `.
        let token = raw_authorization(&headers);
        let Some(token) = token.filter(|value| !value.is_empty()) else {
            self.log_validation_failure(MISSING_TOKEN_MESSAGE, &channel_id, None)
                .await;
            return json_response(StatusCode::BAD_REQUEST, ValidationBody::missing_token());
        };

        let mut connection = self.redis.clone();
        let token_key = token_key(&token);
        // Two separate HGET commands, in source order and always both issued
        // before the validity check.
        let user_id: Option<String> = match connection.hget(token_key.as_str(), "id").await {
            Ok(value) => value,
            Err(error) => return self.cache_failure(&channel_id, "hGet", &error).await,
        };
        let user_login: Option<String> = match connection.hget(token_key.as_str(), "login").await {
            Ok(value) => value,
            Err(error) => return self.cache_failure(&channel_id, "hGet", &error).await,
        };

        // Source: `if (!userCacheID || !userCacheLogin)`; absent and empty are
        // both falsy.
        let user_id = user_id.unwrap_or_default();
        let user_login = user_login.unwrap_or_default();
        if user_id.is_empty() || user_login.is_empty() {
            self.log_validation_failure(INVALID_TOKEN_MESSAGE, &channel_id, None)
                .await;
            return json_response(StatusCode::BAD_REQUEST, ValidationBody::invalid_token());
        }

        if channel_id == user_id {
            return json_response(StatusCode::OK, ValidationBody::success());
        }

        let member_key = admins_key(&channel_id);
        let is_member: bool = match connection
            .sismember(member_key.as_str(), user_login.as_str())
            .await
        {
            Ok(value) => value,
            Err(error) => return self.cache_failure(&channel_id, "sIsMember", &error).await,
        };
        if !is_member {
            self.log_validation_failure(
                NOT_ADMIN_MESSAGE,
                &channel_id,
                Some(("userCacheLogin", user_login.as_str())),
            )
            .await;
            return json_response(StatusCode::FORBIDDEN, ValidationBody::not_admin());
        }

        let details_key = admin_details_key(&channel_id, &user_id);
        let details_exist: bool = match connection.exists(details_key.as_str()).await {
            Ok(value) => value,
            Err(error) => return self.cache_failure(&channel_id, "exists", &error).await,
        };
        if !details_exist {
            self.log_validation_failure(
                NOT_ADMIN_MESSAGE,
                &channel_id,
                Some(("userCacheID", user_id.as_str())),
            )
            .await;
            return json_response(StatusCode::FORBIDDEN, ValidationBody::not_admin());
        }

        json_response(StatusCode::OK, ValidationBody::success())
    }
}

async fn validate_channel(
    State(service): State<ValidationRouteService>,
    Path(channel_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    service.handle(channel_id, headers).await
}

/// The raw `Authorization` header the route looks up.
///
/// Header names are case-insensitive at the HTTP layer, like Node's lowercased
/// `req.headers`. Node treats `authorization` as a singleton header: repeated
/// header lines are discarded and only the first value survives (verified
/// against Node 24.22.1 by sending raw duplicate lines; a non-singleton header
/// such as `x-custom` is instead joined with `", "`). Bytes are decoded as
/// ISO-8859-1, Node's header string representation. An absent header is `None`;
/// an empty value is `Some("")` and is treated as missing by the handler.
pub fn raw_authorization(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION).map(latin1)
}

fn latin1(value: &HeaderValue) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| char::from(*byte))
        .collect()
}

fn json_response(status: StatusCode, body: ValidationBody) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// Current time as `Date#toISOString()`.
pub fn iso_timestamp_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    iso_timestamp(millis)
}

/// UTC ISO-8601 with exactly three fractional digits and a `Z` suffix, matching
/// `Date#toISOString()` for the supported epoch-millisecond range.
pub fn iso_timestamp(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    let within_day = millis.rem_euclid(86_400_000);
    let hour = within_day / 3_600_000;
    let minute = within_day / 60_000 % 60;
    let second = within_day / 1_000 % 60;
    let fraction = within_day % 1_000;
    format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    #[test]
    fn keys_match_the_source_format() {
        assert_eq!(token_key("abc"), "token:abc");
        assert_eq!(token_key("Bearer abc"), "token:Bearer abc");
        assert_eq!(admins_key("1001"), "twitch:1001:admins");
        assert_eq!(admin_details_key("1001", "2002"), "twitch:1001:admins:2002");
        assert_eq!(ROUTE_PATH, "/{channelID}");
        assert_eq!(ROUTE_PARAM, "channelID");
    }

    #[test]
    fn response_bodies_match_the_source_bytes_and_field_order() {
        assert_eq!(
            serde_json::to_string(&ValidationBody::success()).unwrap(),
            r#"{"error":false,"message":"Validation successful","access":true,"status":200}"#
        );
        assert_eq!(
            serde_json::to_string(&ValidationBody::missing_token()).unwrap(),
            r#"{"error":true,"message":"Missing token","access":false,"status":400}"#
        );
        assert_eq!(
            serde_json::to_string(&ValidationBody::invalid_token()).unwrap(),
            r#"{"error":true,"message":"Invalid token","access":false,"status":400}"#
        );
        assert_eq!(
            serde_json::to_string(&ValidationBody::not_admin()).unwrap(),
            r#"{"error":true,"message":"User is not an admin","access":false,"status":403}"#
        );
        assert_eq!(
            serde_json::to_string(&ValidationBody::internal_error()).unwrap(),
            r#"{"error":true,"message":"Internal server error","access":false,"status":500}"#
        );
        assert_eq!(
            serde_json::to_value(ValidationBody::not_admin()).unwrap(),
            json!({"error": true, "message": "User is not an admin", "access": false, "status": 403})
        );
    }

    #[test]
    fn raw_authorization_matches_node_header_semantics() {
        let mut headers = HeaderMap::new();
        assert_eq!(raw_authorization(&headers), None);

        headers.insert(header::AUTHORIZATION, HeaderValue::from_static(""));
        assert_eq!(raw_authorization(&headers).as_deref(), Some(""));

        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("raw-token"));
        assert_eq!(raw_authorization(&headers).as_deref(), Some("raw-token"));

        // No `Bearer ` stripping at this layer.
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer raw-token"),
        );
        assert_eq!(
            raw_authorization(&headers).as_deref(),
            Some("Bearer raw-token")
        );

        // ISO-8859-1 bytes, like Node's header string.
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_bytes(b"tok\xe9").unwrap(),
        );
        assert_eq!(raw_authorization(&headers).as_deref(), Some("tok\u{e9}"));

        // Node treats `authorization` as a singleton: repeated lines are
        // discarded and the first value wins (verified against Node 24.22.1).
        let mut headers = HeaderMap::new();
        headers.append(header::AUTHORIZATION, HeaderValue::from_static("one"));
        headers.append(header::AUTHORIZATION, HeaderValue::from_static("two"));
        assert_eq!(raw_authorization(&headers).as_deref(), Some("one"));
    }

    #[test]
    fn iso_timestamps_match_date_to_iso_string() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
        let now = iso_timestamp_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[19..20], ".");
    }
}
