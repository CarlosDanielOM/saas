//! The site agent (sessions, turns over SSE, approvals, changes), the docs assistant (its own CORS
//! list and per-address limit), memories and the AI personality. Package **P4-API-AGENT** fills
//! this module; its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/site-agent.route.ts` (306 lines): `siteAgentRoute`
//! - `server/routes/docs-assistant.route.ts` (136 lines): `docsAssistantRoute`
//! - `server/routes/memories.route.ts` (311 lines): `memoriesRoute`
//! - `server/routes/aiPersonality.route.ts` (185 lines): `aiPersonalityRoute`

use crate::state::RouteState;
use dima_web::Router;

/// `docsAssistantRoute`, mounted at `/docs-assistant` before the global body parsers and CORS.
pub fn docs_assistant_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `siteAgentRoute`, mounted at `/agent`.
pub fn site_agent_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `aiPersonalityRoute`, mounted at `/ai-personality`.
pub fn ai_personality_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `memoriesRoute`, mounted at `/memories`.
pub fn memories_router<S: RouteState>() -> Router<S> {
    Router::new()
}
