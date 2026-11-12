//! The agent's settings write tools, with approvals. Packages **P4-SA-WRITE-B**, **P4-SA-WRITE-C**
//! fill this module (each its own files); it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/write/timers.ts` (299 lines): `retiredTimerTools`, `timerTools`
//! - `site_agent/tools/write/settings/common.ts` (127 lines): `assertUnchanged`, `bodyEffects`,
//!   `changedPaths`, `channelName`, `conflict`, `display`, `hasFullAccess`, `mergeEffects`,
//!   `needsFullAccessResult`, `pickPaths`, `requireChannelOwner`, `requireSomething`,
//!   `routeMessage`, `sameValue`, `stringList`, `tr`
//! - `site_agent/tools/write/settings/ai_personality.ts` (292 lines): `updateAiPersonality`
//! - `site_agent/tools/write/settings/bits_rules.ts` (221 lines): `bitsRuleTools`, `ruleView`
//! - `site_agent/tools/write/settings/chat_events.ts` (297 lines): `chatEventCatalog`,
//!   `chatEventTools`, `eventFields`
//! - `site_agent/tools/write/settings/index.ts` (62 lines): `settingsTools`
//! - `site_agent/tools/write/settings/follow_defense.ts` (138 lines)
//! - `site_agent/tools/write/settings/goals.ts` (257 lines): `goalView`
//! - `site_agent/tools/write/settings/moderation.ts` (412 lines): `ruleSummary`
//! - `site_agent/tools/write/settings/roulettes.ts` (398 lines): `configView`, `findRoulette`,
//!   `itemView`, `readRouletteState`
//! - `site_agent/tools/write/settings/tts.ts` (194 lines)
//!
//! P4-SA-WRITE-B owns this file and its files; P4-SA-WRITE-C adds its files beside them
//! (`index.ts`, the settings registry, is WRITE-C's and lands as its own file).
