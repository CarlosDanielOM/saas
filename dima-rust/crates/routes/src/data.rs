//! Read routes: analytics with the stream timeline, the dashboard, stream summaries, clip
//! recommendations. Package **P4-API-DATA** fills this module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/analytics.route.ts` (179 lines): `analyticsRoute`
//! - `server/routes/stream_timeline.route.ts` (141 lines)
//! - `server/routes/dashboard.route.ts` (337 lines): `dashboardRoute`
//! - `server/routes/stream-summary.route.ts` (128 lines): `streamSummaryRoute`
//! - `server/routes/clip-recommendations.route.ts` (235 lines): `clipRecommendationsRoute`

use crate::state::RouteState;
use dima_web::Router;

/// `analyticsRoute`, mounted at `/analytics`; it mounts `streamTimelineRoute` itself (`analytics.route.ts:56`).
pub fn analytics_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `dashboardRoute`, mounted at `/dashboard`.
pub fn dashboard_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `streamSummaryRoute`, mounted at `/stream-summaries`.
pub fn stream_summary_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `clipRecommendationsRoute`, mounted at `/clip-recommendations`.
pub fn clip_recommendations_router<S: RouteState>() -> Router<S> {
    Router::new()
}
