//! Users, email activation and the email test. Package **P4-API-USERS** fills this module; its
//! routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/user.route.ts` (406 lines): `userRoute`
//! - `server/routes/email-auth.route.ts` (61 lines): `emailAuthRoute`
//! - `server/routes/email-test.route.ts` (140 lines): `emailTestRoute`
//!
//! `POST /users/premium` takes strings only (plan section 4); the `accounts` updates match type and
//! id on one account.

use crate::state::RouteState;
use dima_web::Router;

/// `userRoute`, mounted at `/users`.
pub fn user_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `emailTestRoute`, mounted at `/email` (first).
pub fn email_test_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `emailAuthRoute`, mounted at `/email` (second).
pub fn email_auth_router<S: RouteState>() -> Router<S> {
    Router::new()
}
