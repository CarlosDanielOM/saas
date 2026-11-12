//! Executing a moderation decision: delete, timeout, ban or warn on Twitch, the action log, and the
//! throttled public notice. Package **P4-MOD-RUN** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `functions/moderation/execute_action.moderation.ts` (126 lines)
//! - `functions/moderation/index.ts` (5 lines)
//!
//! The `@user reason` notice is a plain post through `dima_twitch::chat::ChatOut`
//! (`execute_action.moderation.ts:48`).
