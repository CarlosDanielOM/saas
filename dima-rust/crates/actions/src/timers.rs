//! AST timers (`$(timer …)`): scheduling into the carried `ast:timers:*` family (a fixture of the
//! TypeScript format), the at-most-once claim, and the scheduler the bot runs (2 s reconcile plus
//! one timer per due job). Package **P4-ACT-CORE** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ast_timer_runtime.ts` (165 lines): `scheduleAstTimer`, `startAstTimerScheduler`
//!
//! Timers re-enter the renderer: a fired timer is evaluated with
//! `dima_engine::eval::Engine::evaluate_message` and delivered through `crate::delivery`.
//! `crate::host::DimaHost::schedule_timer` writes through this module.
