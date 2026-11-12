//! `/observability`: the public ingress of the analytics service
//! (`server/routes/observability.route.ts`, package **P4-API-APP**).
//!
//! The analytics service owns authentication, grants, queries and redaction; this router only
//! passes a fixed set of requests on. For `GET`, `PUT` and `DELETE` of `/api/session`,
//! `/api/overview`, `/api/resources`, `/api/logs`, `/api/traces`, `/api/traces/<32 lowercase
//! hex>`, `/api/grants` and `/api/grants/<1 to 30 digits>` (exactly; anything else is
//! `404 {"message":"Analytics endpoint not found"}`), it sends to the configured analytics
//! service ([`AnalyticsConfig::base_url`], typed configuration; the path is rebuilt from the
//! match, never copied from the request, so no request can name another host or path):
//!
//! - the same method, path and query string;
//! - `Authorization`: the caller's (empty when it sent none), and `Content-Type:
//!   application/json`; nothing else of the caller's (no cookies, no forwarding headers);
//! - for `PUT`, the parsed body re-serialised (`JSON.stringify(req.body)`: `{}` when the body
//!   was not JSON), at most the global parser's 100 KiB.
//!
//! The answer is the service's status and body (as text, `application/json; charset=utf-8`)
//! with `Cache-Control: no-store`. No redirect is followed, nothing is retried, the whole
//! exchange has [`AnalyticsConfig::timeout`] (the reference's 12 s) and the answer at most
//! [`AnalyticsConfig::max_response_bytes`]; a failure of any of these is
//! `503 {"message":"Analytics is temporarily unavailable"}`. The reference read the whole
//! answer before sending it, and so does this (it does not stream).
//!
//! # Intended differences
//!
//! - The answer is bounded ([`AnalyticsConfig::max_response_bytes`], 8 MiB); the reference
//!   read any size.

use crate::state::{RouteState, ServiceKey, service};
use bytes::Bytes;
use dima_core::SecretString;
use dima_http::{HttpClient, Method, Path, Provider, Redirects, RetryPolicy};
use dima_web::{Error, Req, Response, Router};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Where the analytics service is and how far the proxy waits for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnalyticsConfig {
    /// The service's origin (`http://dima-analytics:3210`).
    pub base_url: String,
    /// The whole exchange (12 s).
    pub timeout: Duration,
    /// The largest answer passed on.
    pub max_response_bytes: u64,
}

impl AnalyticsConfig {
    /// `observability.route.ts:15` and `:19`, with the answer bound of this port.
    pub fn reference() -> Self {
        Self {
            base_url: "http://dima-analytics:3210".to_owned(),
            timeout: Duration::from_secs(12),
            max_response_bytes: 8 * 1024 * 1024,
        }
    }

    /// The outbound provider for [`AnalyticsUpstream::new`].
    pub fn provider(&self) -> dima_http::ProviderBuilder {
        Provider::builder("dima-analytics", &self.base_url)
            .timeout(self.timeout)
            .max_bytes(self.max_response_bytes)
            .retry(RetryPolicy::none())
            .redirects(Redirects::Error)
    }
}

/// The analytics service as the proxy reaches it: registered in [`crate::state::Services`].
#[derive(Clone, Debug)]
pub struct AnalyticsUpstream {
    http: HttpClient,
    provider: Provider,
}

impl AnalyticsUpstream {
    /// The upstream over `http` with `provider` (built from [`AnalyticsConfig::provider`]).
    pub fn new(http: HttpClient, provider: Provider) -> Self {
        Self { http, provider }
    }
}

/// What the binary registers for this module's routes.
pub const SERVICES: &[ServiceKey] = &[ServiceKey::of::<AnalyticsUpstream>()];

/// `observabilityRoute`, mounted at `/observability`.
pub fn router<S: RouteState>() -> Router<S> {
    let mut router = Router::new();
    router.middleware(proxy::<S>);
    router
}

/// The analytics path for a request path, rebuilt from the match.
fn endpoint(path: &str) -> Option<Path> {
    let rest = path.strip_prefix("/api/")?;
    let fixed = match rest {
        "session" => Some("/api/session"),
        "overview" => Some("/api/overview"),
        "resources" => Some("/api/resources"),
        "traces" => Some("/api/traces"),
        "logs" => Some("/api/logs"),
        "grants" => Some("/api/grants"),
        _ => None,
    };
    if let Some(fixed) = fixed {
        return Some(Path::fixed(fixed));
    }
    if let Some(trace) = rest.strip_prefix("traces/")
        && trace.len() == 32
        && trace
            .bytes()
            .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9'))
    {
        return Path::template("/api/traces/{}", &[trace]).ok();
    }
    if let Some(grant) = rest.strip_prefix("grants/")
        && (1..=30).contains(&grant.len())
        && grant.bytes().all(|b| b.is_ascii_digit())
    {
        return Path::template("/api/grants/{}", &[grant]).ok();
    }
    None
}

fn unavailable() -> Response {
    Response::status(503).json(&json!({ "message": "Analytics is temporarily unavailable" }))
}

/// The proxy (`observability.route.ts:6`).
async fn proxy<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let method = match *req.method() {
        Method::GET => Method::GET,
        Method::PUT => Method::PUT,
        Method::DELETE => Method::DELETE,
        _ => return Ok(not_found()),
    };
    let Some(path) = endpoint(req.path()) else {
        return Ok(not_found());
    };
    let upstream: Arc<AnalyticsUpstream> = service(req)?;
    let authorization = SecretString::new(
        req.header("authorization")
            .map(|value| value.into_owned())
            .unwrap_or_default(),
    );
    let mut request = upstream
        .http
        .request(&upstream.provider, method.clone(), path)
        .secret_header("authorization", &authorization)
        .header("content-type", "application/json");
    let query = req.query_string();
    if !query.is_empty() {
        request = request.raw_query(query);
    }
    if method == Method::PUT {
        // raw body: re-serialised and sent to the analytics service, which validates it.
        request = request.body(dima_text::to_js_json(req.body()));
    }
    let Ok(response) = request.send().await else {
        return Ok(unavailable());
    };
    let status = response.status().as_u16();
    let Ok(bytes) = response.bytes().await else {
        // The reference had set `Cache-Control` before reading the answer.
        return Ok(unavailable().header("Cache-Control", "no-store"));
    };
    let text = String::from_utf8_lossy(strip_bom(&bytes)).into_owned();
    Ok(Response::status(status)
        .header("Cache-Control", "no-store")
        .content_type("application/json")
        .text(text))
}

fn not_found() -> Response {
    Response::status(404).json(&json!({ "message": "Analytics endpoint not found" }))
}

/// `Response.text()` drops a leading byte order mark.
fn strip_bom(bytes: &Bytes) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        let ok = |path: &str| endpoint(path).map(|p| p.as_str().to_owned());
        assert_eq!(ok("/api/logs").as_deref(), Some("/api/logs"));
        assert_eq!(
            ok("/api/traces/0123456789abcdef0123456789abcdef").as_deref(),
            Some("/api/traces/0123456789abcdef0123456789abcdef")
        );
        assert_eq!(ok("/api/grants/123").as_deref(), Some("/api/grants/123"));
        for refused in [
            "/api/logs/",
            "/API/logs",
            "/api/traces/0123456789ABCDEF0123456789abcdef",
            "/api/traces/abc",
            "/api/grants/",
            "/api/grants/1234567890123456789012345678901",
            "/api/grants/12a",
            "/api/other",
            "/api/../admin",
            "/api/logs%2F..",
        ] {
            assert!(endpoint(refused).is_none(), "{refused}");
        }
    }
}
