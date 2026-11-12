//! Usage and cost per turn (money, through `dima-billing`), reconciliation and Polar retries.
//! Package **P4-SA-CORE-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/usage.ts` (309 lines): `drainPolarRetries`, `drainReconcile`, `queueReconcile`,
//!   `recordFeedback`, `recordStep`, `recordTurn`
//! - `site_agent/llm/cost.ts` (46 lines): `estimateUsageCost`
