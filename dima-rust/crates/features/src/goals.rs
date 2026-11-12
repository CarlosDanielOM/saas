//! Channel goals: the goal model and its currencies, monthly windows, contributions from journaled
//! Twitch and custom events, Twitch goal mirroring, completion and the 5 s settle loop body.
//! Package **P4-FEAT-GOALS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `goals/currency.ts` (49 lines)
//! - `goals/model.ts` (122 lines): `GoalError`, `goalLimit`, `newGoal`
//! - `goals/monthly.ts` (57 lines)
//! - `goals/twitch.ts` (221 lines): `TWITCH_GOAL_EVENT_TYPES`, `parseTwitchGoalEvent`,
//!   `publicTwitchGoals`, `seTwitchGoals`
//! - `goals/service.ts` (244 lines): `GoalSet`, `applyCustomGoalEvent`, `applyGoalEvent`,
//!   `assertCustomGoalReceiptCompatible`, `changeGoal`, `changeTwitchGoalRule`, `goalSnapshot`
//! - `goals/completion.ts` (126 lines): `settleGoals`
//! - `goals/twitch-store.ts` (105 lines): `applyTwitchGoalEvent`, `resyncTwitchGoals`,
//!   `resyncTwitchGoalsWithin`, `twitchGoalsResyncedAt`
//!
//! A goal action posts through `dima_twitch::chat::ChatOut::deliver` (`goals/completion.ts:11-14`).
