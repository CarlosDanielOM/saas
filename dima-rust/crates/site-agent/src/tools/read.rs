//! The read tools over a channel's commands, triggers and settings (reads across the channel only).
//! Package **P4-SA-TOOLS-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/read.ts` (508 lines): `ACCESS_LEVELS`, `BUILT_IN_FUNCS`, `accessLabel`,
//!   `accessLevelFromNumber`, `escapeRegExp`, `findChannelCommand`, `readTools`, `runsBuiltInCode`,
//!   `triggerLabel`
