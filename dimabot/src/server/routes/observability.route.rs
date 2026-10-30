//! Working native port of `dimabot/src/server/routes/observability.route.ts`.
//!
//! The source is an Express router mounted at `/observability` that proxies a
//! narrow analytics allowlist to the fixed private destination
//! `http://dima-analytics:3210`. The analytics process owns authentication,
//! grants, SQL, aggregation and redaction; this ingress only forwards.
//!
//! Preserved behavior:
//! - exact source path allowlist
//!   `/^\/api\/(session|overview|resources|traces(?:\/[a-f0-9]{32})?|logs|grants(?:\/\d{1,30})?)$/`;
//! - only `GET`, `PUT` and `DELETE`; every other method, trailing slash or
//!   invalid id answers `404 {"message":"Analytics endpoint not found"}`;
//! - the raw nested path and query string are forwarded unchanged;
//! - upstream requests carry only `Authorization` (empty when absent) and
//!   `Content-Type: application/json`;
//! - a `PUT` body is the parsed JSON or form body re-serialized, `GET`/`DELETE` bodies
//!   are ignored;
//! - a 12-second deadline covers connection, headers *and* body; a redirect
//!   status (301/302/303/307/308) is an error, including without a Location;
//!   while 304 and other non-redirect statuses pass through;
//! - completed responses preserve status and UTF-8 text with
//!   `application/json; charset=utf-8` and `Cache-Control: no-store`, including
//!   upstream errors; Express strips the body and content type for 204/304;
//! - failures answer `503 {"message":"Analytics is temporarily unavailable"}`;
//!   body failures after headers retain `Cache-Control: no-store`.
//!
//! Deliberate boundaries (framework internals are not emulated):
//! - Express/body-parser error formatting is replaced by concise JSON errors:
//!   `400` for invalid JSON or unsupported form shapes, `413` for more than
//!   100 KiB or 1000 form parameters. Normal bracket objects, repeated fields,
//!   and indexed arrays are supported; ambiguous collisions and
//!   prototype-related names are rejected. Other content types forward `{}`.
//! - The source checks the allowlist inside the route handler, after the
//!   application-level `express.json()` middleware. This port validates the
//!   method and path first, so a malformed body on a rejected method/path is a
//!   `404` rather than a body-parser `400`.
//! - JSON object key order may be normalized when a `PUT` body is re-encoded;
//!   JSON objects are unordered, so the protocol is unchanged.
//! - Mount the returned router with [`Router::nest`] at [`MOUNT_PATH`] (or use
//!   [`ObservabilityProxy::mounted_router`]) so the inner path matches the
//!   source's mount-relative `req.url`.

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;

/// Fixed private analytics destination, byte-for-byte from the source route.
pub const PRODUCTION_BASE_URL: &str = "http://dima-analytics:3210";
/// Source `AbortSignal.timeout(12000)`.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(12);
/// Express mount point from `server.ts`.
pub const MOUNT_PATH: &str = "/observability";
/// `express.json()` default body limit (`100kb` = 102400 bytes).
pub const JSON_BODY_LIMIT: usize = 100 * 1024;
/// Allowlist rejection body from the source.
pub const NOT_FOUND_MESSAGE: &str = "Analytics endpoint not found";
/// Transport/redirect/deadline failure body from the source.
pub const UNAVAILABLE_MESSAGE: &str = "Analytics is temporarily unavailable";
/// Native-only body boundary wording; the source relies on body-parser errors.
pub const INVALID_JSON_MESSAGE: &str = "Invalid JSON body";
/// Native-only body limit wording; the source relies on body-parser errors.
pub const BODY_LIMIT_MESSAGE: &str = "JSON body exceeds 100 KiB limit";

/// Statuses the source `fetch(..., { redirect: 'error' })` rejects.
const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];

/// Analytics destination and deadline for [`ObservabilityProxy`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservabilityConfig {
    base_url: String,
    deadline: Duration,
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self::production()
    }
}

impl ObservabilityConfig {
    /// The fixed production destination with the source's 12-second deadline.
    pub fn production() -> Self {
        Self {
            base_url: PRODUCTION_BASE_URL.to_owned(),
            deadline: DEFAULT_DEADLINE,
        }
    }

    /// An explicit absolute base URL (a loopback endpoint in tests).
    pub fn new(base_url: impl Into<String>) -> Self {
        let base_url = base_url.into();
        let base_url = if base_url.ends_with("://") {
            base_url
        } else {
            base_url.trim_end_matches('/').to_owned()
        };
        Self {
            base_url,
            deadline: DEFAULT_DEADLINE,
        }
    }

    /// Overrides the deadline that covers headers and body.
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn deadline(&self) -> Duration {
        self.deadline
    }
}

/// One validated ingress request handed to [`ObservabilityProxy::forward`].
#[derive(Clone, Debug)]
pub struct ForwardRequest {
    /// `GET`, `PUT` or `DELETE`; the handler rejects everything else first.
    pub method: Method,
    /// Mount-relative path plus the raw query string, e.g. `/api/session?a=1`.
    pub path_and_query: String,
    /// Raw `Authorization` header bytes; empty when the client sent none.
    pub authorization: Vec<u8>,
    /// Re-serialized JSON for `PUT`, `None` for `GET`/`DELETE`.
    pub body: Option<String>,
}

impl ForwardRequest {
    pub fn new(
        method: Method,
        path_and_query: impl Into<String>,
        authorization: impl Into<Vec<u8>>,
        body: Option<String>,
    ) -> Self {
        Self {
            method,
            path_and_query: path_and_query.into(),
            authorization: authorization.into(),
            body,
        }
    }
}

/// A completed upstream response whose status and raw bytes are preserved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForwardResponse {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

/// Why no completed upstream response exists; all cases map to the source 503.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForwardError {
    Transport,
    Redirect,
    Deadline,
    AfterHeaders,
}

/// Concrete pooled proxy with an injectable destination and deadline.
#[derive(Clone)]
pub struct ObservabilityProxy {
    config: ObservabilityConfig,
    client: reqwest::Client,
}

impl ObservabilityProxy {
    /// Builds one pooled client; redirects are never followed.
    pub fn new(config: ObservabilityConfig) -> Self {
        #[cfg(any(
            feature = "email",
            feature = "posthog",
            feature = "s3",
            feature = "otel"
        ))]
        crate::utils::install_default_tls_provider();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .expect("observability proxy HTTP client configuration is valid");
        Self { config, client }
    }

    /// The production proxy for `http://dima-analytics:3210`.
    pub fn production() -> Self {
        Self::new(ObservabilityConfig::production())
    }

    pub fn config(&self) -> &ObservabilityConfig {
        &self.config
    }

    /// Router with mount-relative paths, for `nest(MOUNT_PATH, ...)`.
    pub fn router(self) -> Router {
        Router::new().fallback(proxy_request).with_state(self)
    }

    /// Complete router that already mounts itself at `/observability`.
    pub fn mounted_router(self) -> Router {
        Router::new().nest(MOUNT_PATH, self.router())
    }

    /// Performs one upstream exchange under a single deadline.
    ///
    /// The deadline wraps the whole exchange, so it covers connection, headers
    /// and body. Dropping this future (including a cancelled Axum handler)
    /// drops the `reqwest` future and closes the upstream request.
    pub async fn forward(&self, request: ForwardRequest) -> Result<ForwardResponse, ForwardError> {
        let url = format!("{}{}", self.config.base_url, request.path_and_query);
        let mut builder = self
            .client
            .request(request.method, url)
            .header(
                header::AUTHORIZATION,
                HeaderValue::from_bytes(&request.authorization)
                    .unwrap_or_else(|_| HeaderValue::from_static("")),
            )
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let deadline = tokio::time::Instant::now() + self.config.deadline;
        let response = tokio::time::timeout_at(deadline, builder.send())
            .await
            .map_err(|_| ForwardError::Deadline)?
            .map_err(|_| ForwardError::Transport)?;
        let status = response.status();
        if REDIRECT_STATUSES.contains(&status.as_u16()) {
            return Err(ForwardError::Redirect);
        }
        let body = tokio::time::timeout_at(deadline, response.bytes())
            .await
            .map_err(|_| ForwardError::AfterHeaders)?
            .map_err(|_| ForwardError::AfterHeaders)?;
        Ok(ForwardResponse {
            status,
            body: String::from_utf8_lossy(&body).into_owned().into_bytes(),
        })
    }
}

/// Axum fallback: validate method/path, build the source-shaped request, proxy.
async fn proxy_request(State(proxy): State<ObservabilityProxy>, request: Request) -> Response {
    let (parts, body) = request.into_parts();

    if !is_allowed_method(&parts.method) || !is_allowed_path(parts.uri.path()) {
        return message_response(StatusCode::NOT_FOUND, NOT_FOUND_MESSAGE);
    }

    let authorization = parts
        .headers
        .get(header::AUTHORIZATION)
        .map(|value| value.as_bytes().to_vec())
        .unwrap_or_default();

    let body = if parts.method == Method::PUT {
        let content_type = parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        match put_body(content_type, body).await {
            Ok(body) => Some(body),
            Err(PutBodyError::TooLarge) => {
                return message_response(StatusCode::PAYLOAD_TOO_LARGE, BODY_LIMIT_MESSAGE);
            }
            Err(PutBodyError::Invalid) => {
                return message_response(StatusCode::BAD_REQUEST, INVALID_JSON_MESSAGE);
            }
        }
    } else {
        None
    };

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| parts.uri.path().to_owned());

    match proxy
        .forward(ForwardRequest {
            method: parts.method,
            path_and_query,
            authorization,
            body,
        })
        .await
    {
        Ok(upstream) => upstream_response(upstream),
        Err(error) => {
            let mut response =
                message_response(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE_MESSAGE);
            if error == ForwardError::AfterHeaders {
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            }
            response
        }
    }
}

fn is_allowed_method(method: &Method) -> bool {
    method == Method::GET || method == Method::PUT || method == Method::DELETE
}

/// Regex-equivalent allowlist:
/// `^/api/(session|overview|resources|traces(?:/[a-f0-9]{32})?|logs|grants(?:/\d{1,30})?)$`.
pub fn is_allowed_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/") else {
        return false;
    };
    match rest {
        "session" | "overview" | "resources" | "logs" | "traces" | "grants" => true,
        _ => {
            if let Some(id) = rest.strip_prefix("traces/") {
                return is_trace_id(id);
            }
            if let Some(id) = rest.strip_prefix("grants/") {
                return is_grant_id(id);
            }
            false
        }
    }
}

/// Exactly 32 lowercase hexadecimal characters, like `[a-f0-9]{32}`.
fn is_trace_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One to thirty ASCII digits, like `\d{1,30}`.
fn is_grant_id(id: &str) -> bool {
    (1..=30).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug)]
enum PutBodyError {
    Invalid,
    TooLarge,
}

/// Mirrors body-parser behind `express.json()`: only request bodies (ignored for
/// `GET`/`DELETE` by the caller), only `application/json`, empty is `{}`, and a
/// strict top-level object or array is re-serialized compactly.
async fn put_body(content_type: Option<&str>, body: Body) -> Result<String, PutBodyError> {
    let form = content_type
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| {
            v.trim()
                .eq_ignore_ascii_case("application/x-www-form-urlencoded")
        });
    if !is_json_content_type(content_type) && !form {
        return Ok("{}".to_owned());
    }
    let bytes = to_bytes(body, JSON_BODY_LIMIT)
        .await
        .map_err(|_| PutBodyError::TooLarge)?;
    if bytes.is_empty() {
        return Ok("{}".to_owned());
    }
    let value: Value = if form {
        parse_form(&bytes)?
    } else {
        serde_json::from_slice(&bytes).map_err(|_| PutBodyError::Invalid)?
    };
    if !value.is_object() && !value.is_array() {
        return Err(PutBodyError::Invalid);
    }
    serde_json::to_string(&value).map_err(|_| PutBodyError::Invalid)
}

// Ordinary qs-style field paths. Ambiguous object/array collisions are rejected.
fn parse_form(bytes: &[u8]) -> Result<Value, PutBodyError> {
    let text = std::str::from_utf8(bytes).map_err(|_| PutBodyError::Invalid)?;
    if !text.is_empty() && text.bytes().filter(|b| *b == b'&').count() >= 1000 {
        return Err(PutBodyError::TooLarge);
    }
    let mut url = reqwest::Url::parse("http://localhost/").map_err(|_| PutBodyError::Invalid)?;
    url.set_query(Some(text));
    let mut root = json!({});
    let array_limit = 100.max(text.split('&').count());
    for (index, (key, value)) in url.query_pairs().enumerate() {
        if index >= 1000 {
            return Err(PutBodyError::TooLarge);
        }
        let mut parts = Vec::new();
        let first_end = key.find('[').unwrap_or(key.len());
        if first_end == 0 {
            return Err(PutBodyError::Invalid);
        }
        parts.push(key[..first_end].to_owned());
        let mut remaining = &key[first_end..];
        while !remaining.is_empty() {
            let tail = remaining.strip_prefix('[').ok_or(PutBodyError::Invalid)?;
            let end = tail.find(']').ok_or(PutBodyError::Invalid)?;
            parts.push(tail[..end].to_owned());
            remaining = &tail[end + 1..];
            if parts.len() > 33 {
                return Err(PutBodyError::Invalid);
            }
        }
        if parts
            .iter()
            .any(|part| part == "__proto__" || part == "constructor" || part == "prototype")
        {
            return Err(PutBodyError::Invalid);
        }
        insert_form(&mut root, &parts, value.into_owned(), array_limit)?;
    }
    compact_form_arrays(&mut root);
    Ok(root)
}

fn compact_form_arrays(node: &mut Value) {
    match node {
        Value::Array(values) => {
            values.retain(|value| !value.is_null());
            values.iter_mut().for_each(compact_form_arrays);
        }
        Value::Object(values) => values.values_mut().for_each(compact_form_arrays),
        _ => {}
    }
}

fn insert_form(
    node: &mut Value,
    path: &[String],
    value: String,
    array_limit: usize,
) -> Result<(), PutBodyError> {
    let part = &path[0];
    let final_part = path.len() == 1;
    if node.is_null() {
        *node = if part.is_empty()
            || part
                .parse::<usize>()
                .is_ok_and(|index| index <= array_limit && index.to_string() == *part)
        {
            json!([])
        } else {
            json!({})
        };
    }
    let slot = if let Some(map) = node.as_object_mut() {
        if part.is_empty() {
            return Err(PutBodyError::Invalid);
        }
        map.entry(part.clone()).or_insert(Value::Null)
    } else if let Some(array) = node.as_array_mut() {
        let index = if part.is_empty() {
            array.len()
        } else {
            let index = part.parse::<usize>().map_err(|_| PutBodyError::Invalid)?;
            if index > array_limit || index.to_string() != *part {
                return Err(PutBodyError::Invalid);
            }
            index
        };
        if index >= array.len() {
            array.resize(index + 1, Value::Null);
        }
        &mut array[index]
    } else {
        return Err(PutBodyError::Invalid);
    };
    if !final_part {
        return insert_form(slot, &path[1..], value, array_limit);
    }
    match slot {
        Value::Null => *slot = Value::String(value),
        Value::String(_) => {
            let previous = std::mem::replace(slot, Value::Null);
            *slot = Value::Array(vec![previous, Value::String(value)]);
        }
        Value::Array(values) if values.iter().all(Value::is_string) => {
            values.push(Value::String(value))
        }
        _ => return Err(PutBodyError::Invalid),
    }
    Ok(())
}

fn is_json_content_type(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

/// Source `res.status(status).type('application/json').send(await response.text())`
/// with `Cache-Control: no-store`; Express appends `charset=utf-8` to strings.
fn upstream_response(upstream: ForwardResponse) -> Response {
    let no_body =
        upstream.status == StatusCode::NO_CONTENT || upstream.status == StatusCode::NOT_MODIFIED;
    let mut response = Response::new(Body::from(if no_body { Vec::new() } else { upstream.body }));
    *response.status_mut() = upstream.status;
    let headers = response.headers_mut();
    if !no_body {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Source `res.status(...).json({ message })` without a cache header.
fn message_response(status: StatusCode, message: &'static str) -> Response {
    let mut response = (status, Json(json!({ "message": message }))).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_form_fields_and_limits() {
        assert_eq!(parse_form(b"role=viewer&channels[]=alpha&channels[]=beta&services[0]=chat&services[1]=events&options[scope]=read&tag=one&tag=two").unwrap(),
            json!({"role":"viewer", "channels":["alpha","beta"], "services":["chat","events"], "options":{"scope":"read"}, "tag":["one","two"]}));
        assert_eq!(
            parse_form(b"channels[2]=sparse").unwrap(),
            json!({"channels": ["sparse"]})
        );
        assert!(parse_form(b"a[b]=1&a[]=2").is_err());
        assert!(parse_form("x=1&".repeat(1001).as_bytes()).is_err());
        let deep = format!("a{}=x", "[x]".repeat(33));
        assert!(parse_form(deep.as_bytes()).is_err());
    }

    #[test]
    fn matches_the_source_allowlist() {
        for allowed in [
            "/api/session",
            "/api/overview",
            "/api/resources",
            "/api/traces",
            "/api/traces/0123456789abcdef0123456789abcdef",
            "/api/logs",
            "/api/grants",
            "/api/grants/0",
            "/api/grants/123456789012345678901234567890",
        ] {
            assert!(is_allowed_path(allowed), "{allowed}");
        }
        for rejected in [
            "/api",
            "/api/session/",
            "/api/session//",
            "/api/Session",
            "/api/traces/",
            "/api/traces/0123456789abcdef0123456789abcde",
            "/api/traces/0123456789abcdef0123456789abcdef0",
            "/api/traces/0123456789ABCDEF0123456789abcdef",
            "/api/traces/0123456789abcdef0123456789abcdeg",
            "/api/grants/",
            "/api/grants/1234567890123456789012345678901",
            "/api/grants/-1",
            "/api/grants/1.5",
            "/observability/api/session",
            "/api/unknown",
            "",
        ] {
            assert!(!is_allowed_path(rejected), "{rejected}");
        }
    }

    #[test]
    fn accepts_only_application_json_content_types() {
        assert!(is_json_content_type(Some("application/json")));
        assert!(is_json_content_type(Some(
            "Application/JSON; charset=utf-8"
        )));
        assert!(!is_json_content_type(Some("application/vnd.api+json")));
        assert!(!is_json_content_type(Some("text/plain")));
        assert!(!is_json_content_type(None));
    }
}
