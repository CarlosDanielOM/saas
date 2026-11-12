//! Overlays (public capability routes included), Overlay Studio, pets, roulettes, widgets with the
//! duel widget, goals. Package **P4-API-OVERLAYS** fills this module; its routers are empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/overlay.route.ts` (91 lines): `overlayRoute`
//! - `server/routes/overlay-studio.route.ts` (257 lines): `overlayStudioRoute`
//! - `server/routes/pet.route.ts` (84 lines): `petRoute`
//! - `server/routes/roulette.route.ts` (74 lines): `rouletteRoute`
//! - `server/routes/widgets.route.ts` (46 lines): `widgetsRoute`
//! - `server/routes/duel-widget.route.ts` (21 lines)
//! - `server/routes/goals.route.ts` (50 lines): `goalsRoute`
//!
//! Overlay Studio, the asset library and the pet routes admit the channel itself only:
//! `dima_platform::access::ChannelGuard::self_only`. `POST /overlays/furry/:channelID` stays open
//! unless the owner says otherwise (plan question 1).

use crate::state::RouteState;
use dima_web::Router;

/// `petRoute`, mounted at `/pets`.
pub fn pet_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `overlayRoute`, mounted at `/`.
pub fn overlay_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `rouletteRoute`, mounted at `/roulettes`.
pub fn roulette_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `widgetsRoute`, mounted at `/widgets`; it mounts `duelWidgetRoute` at `/:channelID/duel` itself (`widgets.route.ts:28`).
pub fn widgets_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `goalsRoute`, mounted at `/goals`.
pub fn goals_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `overlayStudioRoute`, mounted at `/overlay-studio`.
pub fn overlay_studio_router<S: RouteState>() -> Router<S> {
    Router::new()
}
