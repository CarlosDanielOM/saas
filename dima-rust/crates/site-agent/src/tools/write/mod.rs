//! The agent's write tools for commands and repeating messages, with approvals. Package
//! **P4-SA-WRITE-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/write/commands.ts` (834 lines): `commandTools`
//! - `site_agent/tools/write/repeat.ts` (278 lines): `MAX_TIMER_MESSAGE`, `MAX_TIMER_NAME`,
//!   `REPEAT_RULES`, `RepeatRefused`, `checkGuarded`, `moveRepeat`, `readTimer`,
//!   `timerChangedFields`, `timerCommand`, `timerConflict`, `timerGuard`, `timerLabel`,
//!   `timerSnapshot`

pub mod settings;
