//! The application shell (`server/server.ts`, package **P4-API-APP**): the middleware in the
//! reference's order with its coverage, the routes `server.ts` declares itself, the typed
//! configuration of the shell, and the service the binary serves.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `server/server.ts` (223 lines): `server` ([`application`], with [`crate::mounts::build`]).
//! - `server/oauth/routes.ts` (244 lines): in [`crate::oauth`].
//! - `server/routes/observability.route.ts` (21 lines): in [`crate::observability`].
//!
//! # The shell, in order (`server.ts:55-266`, [`crate::mounts::MOUNTS`])
//!
//! | line | what | covers | here |
//! |---|---|---|---|
//! | 55 | `httpTelemetry` | every request | [`dima_web::App::observe`] with the telemetry web observer |
//! | 58 | Polar webhook (raw body) | `/polar/webhook` | P4-API-BILLING's router, before every parser |
//! | 60 | JSON, 5 MiB | `/overlay-studio` | [`dima_web::body::json`] |
//! | 62 | JSON, 1 MiB | `/commands` | idem |
//! | 64 | docs assistant (own CORS, 256 KiB) | `/docs-assistant` | P4-API-AGENT's router |
//! | 66 | JSON, 4 MiB | `/roulettes` | idem |
//! | 67 | JSON, 100 KiB | everything not parsed yet | idem |
//! | 68 | urlencoded (`extended`, 100 KiB, 1000 parameters, depth 32) | everything | [`dima_web::body::urlencoded`] |
//! | 70, 71 | OAuth, own origin policy | `/oauth`, `/v1` | [`crate::oauth`] |
//! | 72 | OAuth metadata | `GET /.well-known/oauth-authorization-server` | [`crate::oauth::metadata`] |
//! | 73 | static files | `GET`/`HEAD` of a file under [`AppConfig::public_files`] | [`dima_web::serve_static`] |
//! | 74 | `cors()`: `ACAO: *`, every `OPTIONS` answered 204 | everything after this line | [`dima_web::cors::cors`] |
//! | 75 | analytics proxy | `/observability` | [`crate::observability`] |
//! | 78-172 | the route packages' routers | their prefixes | [`crate::mounts::RouterFile::router`] |
//! | 178, 190, 215 | reserved commands, site analytics, its event stream | `GET /config/...` | this module |
//!
//! Nothing matches: Express's HTML `Cannot <METHOD> <path>` 404 (finalhandler, production),
//! with the CORS header for every path the `cors()` line reached; `/oauth/*` and `/v1/*` answer
//! their JSON `{"error":"not_found"}` instead. A body parser's refusal (400 malformed, 413 too
//! large, 415 charset or encoding) is finalhandler's HTML page with the status text. There is no
//! application-wide error handler in the reference, and none here.
//!
//! # Limits
//!
//! Bodies: the per-prefix limits above, counted after decompression, with the compressed size
//! bounded too (`dima_web::body`). Request heads: [`dima_web::MAX_HEAD_BYTES`] and
//! [`dima_web::MAX_HEADER_LINES`]. Connections, streams, and time to send a request:
//! [`AppConfig::serve`]. Time to answer: [`AppConfig::request_deadline`] ([`Bounded`]); a
//! streamed answer counts until its head is sent. The analytics proxy: see
//! [`crate::observability`].
//!
//! # Intended differences
//!
//! - **A handler that does not answer within [`AppConfig::request_deadline`] gets `503`**
//!   (`{"error":true,"message":"Request timed out","status":503}`); the reference had no bound
//!   and held the connection for ever.
//! - `X-Powered-By: Express` is not sent (`dima-web`).
//! - The site analytics event stream writes its snapshots one after another every
//!   [`SiteStreamConfig::interval`]; the reference started one every 500 ms whether the last
//!   had finished or not. Its keep-alive comment counts from when the stream opens, not from
//!   the first snapshot.

pub mod client;
mod inline;

pub use client::{ClientAddress, ClientAddressPolicy, ForwardedHeader, IpRange};
pub use inline::{
    ReservedCommands, SERVICES, SiteSnapshots, SnapshotError, reserved_commands, site_analytics,
    site_analytics_stream,
};

use crate::observability::AnalyticsConfig;
use crate::state::RouteState;
use dima_web::{App, Body, BoxFuture, ConfigError, Error, Flow, Handler, Req, Response};
use dima_web::{ServeOptions, ServeStatic};
use serde_json::json;
use std::convert::Infallible;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

/// The shell's typed configuration, built by the binary (the crate never reads the
/// environment).
#[derive(Clone, Debug)]
pub struct AppConfig {
    /// `express.static(path.join(__dirname, 'routes', 'public'))`: the directory of the overlay
    /// pages and the runtime speech files.
    pub public_files: ServeStatic,
    /// Where the OAuth rate limits read the client's address.
    pub client_address: ClientAddressPolicy,
    /// The analytics service behind `/observability`.
    pub analytics: AnalyticsConfig,
    /// `GET /config/site/analytics/stream`.
    pub site_stream: SiteStreamConfig,
    /// Longest time from a request's head to its answer's head ([`Bounded`]).
    pub request_deadline: Duration,
    /// Connection settings for `dima_web::serve`.
    pub serve: ServeOptions,
}

/// Default [`AppConfig::request_deadline`]: Node's request timeout (300 s, the time a client
/// has to send its body) plus 30 s of work after the body.
pub const DEFAULT_REQUEST_DEADLINE: Duration = Duration::from_secs(330);

impl AppConfig {
    /// The reference's values, with static files served from `public_dir`.
    pub fn new(public_dir: &str) -> Self {
        Self {
            public_files: dima_web::serve_static(public_dir),
            client_address: ClientAddressPolicy::peer_only(),
            analytics: AnalyticsConfig::reference(),
            site_stream: SiteStreamConfig::reference(),
            request_deadline: DEFAULT_REQUEST_DEADLINE,
            serve: ServeOptions::default(),
        }
    }
}

/// The site analytics event stream's timing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiteStreamConfig {
    /// Between snapshots (500 ms).
    pub interval: Duration,
    /// Between `: keep-alive` comments (30 s).
    pub heartbeat: Duration,
}

impl SiteStreamConfig {
    /// `server.ts:236` and `:241`.
    pub fn reference() -> Self {
        Self {
            interval: Duration::from_millis(500),
            heartbeat: Duration::from_secs(30),
        }
    }
}

/// `express.static(...)` (`server.ts:73`) with the directory of [`AppConfig::public_files`].
pub(crate) struct PublicFiles;

impl<S: RouteState> Handler<S> for PublicFiles {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            let files = req.state().core().config.public_files.clone();
            files.call(req).await
        })
    }
}

/// The API as the binary serves it: [`crate::mounts::build`] with the state, observed by
/// telemetry, under the request deadline. The binary wraps it with
/// `Telemetry::traced_service` and serves it with [`AppConfig::serve`].
pub fn application<S: RouteState>(state: Arc<S>) -> Result<Bounded<S>, ConfigError> {
    let deadline = state.core().config.request_deadline;
    let observer = state.core().telemetry.web_observer();
    let app = App::with_shared_state(crate::mounts::build::<S>(), state)?.observe(observer);
    Ok(Bounded { app, deadline })
}

/// The application with the request deadline: a handler that has not answered when it passes
/// is dropped and the client gets 503.
pub struct Bounded<S> {
    app: App<S>,
    deadline: Duration,
}

impl<S> Clone for Bounded<S> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            deadline: self.deadline,
        }
    }
}

impl<S> std::fmt::Debug for Bounded<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bounded")
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

impl<S: Send + Sync + 'static> Bounded<S> {
    /// The application inside.
    pub fn app(&self) -> &App<S> {
        &self.app
    }

    /// One request, as the server runs it.
    pub async fn handle(&self, request: http::Request<Body>) -> http::Response<Body> {
        match tokio::time::timeout(self.deadline, self.app.handle(request)).await {
            Ok(response) => response,
            Err(_) => timed_out(),
        }
    }
}

fn timed_out() -> http::Response<Body> {
    let body = json!({ "error": true, "message": "Request timed out", "status": 503 });
    let mut response = http::Response::new(Body::from(body.to_string()));
    *response.status_mut() = http::StatusCode::SERVICE_UNAVAILABLE;
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

impl<S: Send + Sync + 'static> tower::Service<http::Request<Body>> for Bounded<S> {
    type Response = http::Response<Body>;
    type Error = Infallible;
    type Future = BoxFuture<'static, Result<Self::Response, Infallible>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        let bounded = self.clone();
        Box::pin(async move { Ok(bounded.handle(request).await) })
    }
}

/// Answers a JSON envelope (`{"error":true,"message":…,"status":…}`).
pub(crate) fn failure(status: u16, message: &str) -> Response {
    Response::status(status).json(&json!({ "error": true, "message": message, "status": status }))
}
