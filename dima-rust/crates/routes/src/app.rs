//! The application's own routes and middleware: the middleware order, body limits per prefix,
//! static files, CORS, the OAuth routes, the analytics proxy, and the `/config` routes (reserved
//! commands, site analytics and its SSE). Package **P4-API-APP** fills this module; its routers are
//! empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/server.ts` (223 lines): `server`
//! - `server/oauth/routes.ts` (244 lines)
//! - `server/routes/observability.route.ts` (21 lines)
//!
//! P4-API-APP also owns `crate::mounts` after P4-SKEL: it fills the middleware and the four `GET`
//! entries of the table in `crate::mounts::build`.

use crate::state::RouteState;
use dima_web::Router;

/// `oauthRoute` (`server/oauth/routes.ts:81`), mounted at `/oauth`: the OAuth protocol and the browser-session pages.
pub fn oauth_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `oauthApiRoute` (`server/oauth/routes.ts:175`), mounted at `/v1`: the desktop app's API behind OAuth access tokens.
pub fn oauth_api_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `observabilityRoute`, mounted at `/observability`: the proxy to `dima-analytics` (12 s timeout, the caller's `Authorization` passed on).
pub fn observability_router<S: RouteState>() -> Router<S> {
    Router::new()
}
