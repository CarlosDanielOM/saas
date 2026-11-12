//! The trigger media library: helpers, public assets, the library routes and the upload (multipart,
//! plan size limits, `public-read`). Package **P4-API-TRIGGERS-A** fills this module; its routers
//! are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/trigger.route.ts` (lines 1–1012, 898 of 1712): `triggerRoute`

use crate::state::RouteState;
use dima_web::Router;

/// The library half of `triggerRoute`, mounted before the trigger routes by [`super::router`].
pub fn router<S: RouteState>() -> Router<S> {
    Router::new()
}
