//! The agent's tools: reads, knowledge, effects, UI, the tool registry, settings reads and stream
//! reads. Packages **P4-SA-TOOLS-A**, **P4-SA-TOOLS-B** fill this module (each its own files); it
//! is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/effects.ts` (236 lines): `describeCommandEffects`
//! - `site_agent/tools/knowledge.ts` (215 lines): `knowledgeTools`, `warmKnowledge`
//! - `site_agent/tools/read.ts` (508 lines): `ACCESS_LEVELS`, `BUILT_IN_FUNCS`, `accessLabel`,
//!   `accessLevelFromNumber`, `escapeRegExp`, `findChannelCommand`, `readTools`, `runsBuiltInCode`,
//!   `triggerLabel`
//! - `site_agent/tools/ui.ts` (102 lines): `uiTools`
//! - `site_agent/tools/util.ts` (64 lines): `asObject`, `bool`, `int`, `oneOf`, `stableJson`,
//!   `str`, `untrusted`
//! - `site_agent/tools/registry.ts` (63 lines): `getTool`, `getUndoTool`, `toLlmTools`,
//!   `toolResultText`, `toolsFor`
//! - `site_agent/tools/settings_read.ts` (217 lines)
//! - `site_agent/tools/stream.ts` (417 lines)
//!
//! P4-SA-TOOLS-A owns this file and its five tool files; P4-SA-TOOLS-B adds the registry, settings
//! reads and stream reads beside them. The write tools are `tools::write`.

pub mod write;
