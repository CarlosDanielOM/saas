//! Triggers: CRUD, send (the `trigger` broadcast) and the legacy file routes. Package
//! **P4-API-TRIGGERS-B** fills this module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/trigger.route.ts` (lines 1013–end, 619 of 1712): `triggerRoute`
//!
//! Query values are typed as strings (plan section 4).

pub mod library;

use crate::state::RouteState;
use dima_web::Router;

/// `triggerRoute`, mounted at `/triggers`: [`library::router`]'s routes (P4-API-TRIGGERS-A)
/// first, then this module's (P4-API-TRIGGERS-B), as the reference's file lists them.
pub fn router<S: RouteState>() -> Router<S> {
    let mut router = Router::new();
    router.mount("/", library::router());
    router
}
