//! Sign-in: `authorize`, `register`, `reauthenticate`, `exchange-code`, `session`,
//! `access/:channelID`. Package **P4-API-AUTH-A** fills this module; its routers are empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/auth.route.ts` (lines 1–967, 828 of 1416): `authRoute`
//!
//! Tokens; sign-in writes credentials (`dima_twitch::Twitch::store_sign_in`). The mock routes are
//! gated by `MOCK_LOGIN_TOKEN`.

pub mod account;

use crate::state::RouteState;
use dima_web::Router;

/// `authRoute`, mounted at `/auth`: this module's routes (P4-API-AUTH-A) first, then
/// [`account::router`]'s (P4-API-AUTH-B), as the reference's file lists them.
pub fn router<S: RouteState>() -> Router<S> {
    let mut router = Router::new();
    router.mount("/", account::router());
    router
}
