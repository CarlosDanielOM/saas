//! Channel admins with the creator rules, and the admin tools. Package **P4-API-ADMINS** fills this
//! module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/admin.route.ts` (570 lines): `adminRoute`
//! - `server/routes/admin-tools.route.ts` (53 lines): `adminToolsRoute`
//!
//! `GET /admin/read-file` waits for the owner (plan question 10).

use crate::state::RouteState;
use dima_web::Router;

/// `adminRoute`, mounted at `/admins`.
pub fn admin_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `adminToolsRoute`, mounted at `/admin`.
pub fn admin_tools_router<S: RouteState>() -> Router<S> {
    Router::new()
}
