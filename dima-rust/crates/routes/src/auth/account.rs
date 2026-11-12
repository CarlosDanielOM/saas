//! Account routes: `login`, `mock-login`, `mock-register`, `repair`, `factory-reset`, `DELETE
//! /account`. Package **P4-API-AUTH-B** fills this module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/auth.route.ts` (lines 968–end, 588 of 1416): `authRoute`
//!
//! `POST /auth/login` trusts the body id (`packages.md`); factory reset and deletion are
//! destructive (`dima-services::account`).

use crate::state::RouteState;
use dima_web::Router;

/// The account half of `authRoute`, mounted after the sign-in half by [`super::router`].
pub fn router<S: RouteState>() -> Router<S> {
    Router::new()
}
