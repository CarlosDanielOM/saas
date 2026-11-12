//! Commands (the 1 MB body limit), timers, moderation settings and follow defense. Package
//! **P4-API-COMMANDS** fills this module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/command.route.ts` (311 lines): `commandRoute`
//! - `server/routes/timer.route.ts` (253 lines): `timerRoute`
//! - `server/routes/moderation.route.ts` (159 lines): `moderationRoute`
//! - `server/routes/follow_defense.route.ts` (406 lines): `followDefenseRoute`

use crate::state::RouteState;
use dima_web::Router;

/// `commandRoute`, mounted at `/commands`.
pub fn command_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `timerRoute`, mounted at `/timers`.
pub fn timer_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `moderationRoute`, mounted at `/moderation`.
pub fn moderation_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `followDefenseRoute`, mounted at `/follow-defense`.
pub fn follow_defense_router<S: RouteState>() -> Router<S> {
    Router::new()
}
