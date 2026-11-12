//! The internal admin site's routes (global admins only). Package **P4-API-ADMIN-SITE** fills this
//! module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/admin_site.route.ts` (1006 lines): `adminSiteRoute`

use crate::state::RouteState;
use dima_web::Router;

/// `adminSiteRoute`, mounted at `/admin-site`.
pub fn router<S: RouteState>() -> Router<S> {
    Router::new()
}
