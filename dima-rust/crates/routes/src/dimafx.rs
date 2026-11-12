//! The DimaFX extension: owner routes and the internal routes behind `DIMAFX_SERVICE_TOKEN`
//! (constant-time check). Package **P4-API-DIMAFX** fills this module; its routers are empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/dimafx.route.ts` (1201 lines): `dimafxRoute`, `recoverDimafxPurchases`
//!
//! `recoverDimafxPurchases` moves to `dima_realtime::dimafx`.

use crate::state::RouteState;
use dima_web::Router;

/// `dimafxRoute`, mounted at `/extensions/dimafx`.
pub fn router<S: RouteState>() -> Router<S> {
    Router::new()
}
