//! The site agent's core: access, configuration and limits, change records and undo, context
//! building, navigation, preferences, the prompt and the shared types. Package **P4-SA-CORE-A**
//! fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/access.ts` (83 lines): `permissionChecker`, `resolveAccess`
//! - `site_agent/changes.ts` (228 lines): `ChangeError`, `listChanges`, `recordChange`,
//!   `undoChange`
//! - `site_agent/cleanup.ts` (35 lines): `deleteChannelSiteAgentData`
//! - `site_agent/config.ts` (72 lines): `MODEL_PRICES`, `PLAN_MODELS`, `SITE_AGENT_KEYS`,
//!   `SITE_AGENT_LIMITS`, `isSiteAgentEnabled`
//! - `site_agent/context.ts` (177 lines): `channelFacts`, `compact`, `dropOldest`,
//!   `estimateItemTokens`, `estimateTokens`, `repairContext`, `toMessages`
//! - `site_agent/limits.ts` (38 lines): `readLimits`, `refundMessage`, `takeMessage`, `utcDay`
//! - `site_agent/navigation.ts` (76 lines): `NAV_ANCHORS`, `NAV_ROUTES`
//! - `site_agent/prefs.ts` (52 lines): `loadPersona`, `personaAvailable`, `personaView`,
//!   `readPrefs`, `writePrefs`
//! - `site_agent/prompt.ts` (82 lines): `FINAL_STEP_NOTE`, `STEER_PREFIX`, `buildSystemPrompt`,
//!   `turnNote`
//! - `site_agent/types.ts` (249 lines): `ToolConflictError`, `ToolInputError`
