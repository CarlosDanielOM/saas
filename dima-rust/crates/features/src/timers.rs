//! Custom timers (repeating messages): create, edit, toggle and delete from chat, routes and the
//! site agent through one service, the timer cache, and rendering a timer's message. Package
//! **P4-FEAT-TIMERS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `commands/timer_manager.command.ts` (497 lines): `createTimer`, `deleteTimer`,
//!   `deleteTimerIfUnchanged`, `editTimer`, `getTimer`, `listTimers`, `syncTimerCache`,
//!   `toggleTimer`, `updateTimerIfUnchanged`
//! - `utils/timer_cache.ts` (115 lines)
//! - `utils/timer_runtime.ts` (39 lines): `renderTimerMessage`
//!
//! The cron's timer loop (P4-CRON-FEATURES) posts the rendered message through
//! `dima_twitch::chat::ChatOut::deliver` (`workers/timer.worker.ts:141-152`).
