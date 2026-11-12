//! Rewards, bits rules, EventSub configuration (with the test route that runs the bot's handler)
//! and the site catalog. Package **P4-API-CHANNEL** fills this module; its routers are empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/reward.route.ts` (353 lines): `rewardRoute`
//! - `server/routes/bits-rules.route.ts` (80 lines): `bitsRulesRoute`
//! - `server/routes/eventsub.route.ts` (340 lines): `eventsubRoute`
//! - `server/routes/site.route.ts` (247 lines): `siteRoute`
//!
//! `POST /site/events` and `PATCH /site/events/:id` need a global admin; PATCH bodies are typed
//! fields only (owner decisions). The EventSub test route runs `dima_chat::events` in the API
//! (lead's decision on plan question 3).

use crate::state::RouteState;
use dima_web::Router;

/// `rewardRoute`, mounted at `/rewards`.
pub fn reward_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `bitsRulesRoute`, mounted at `/bits-rules`.
pub fn bits_rules_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `eventsubRoute`, mounted at `/eventsubs`.
pub fn eventsub_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `siteRoute`, mounted at `/site`.
pub fn site_router<S: RouteState>() -> Router<S> {
    Router::new()
}
