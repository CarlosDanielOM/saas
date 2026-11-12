//! Running turns: leases (15 s heartbeat), recovery (10 s), drain and Polar retries (30 s),
//! approvals, stop and retry. Package **P4-SA-RUNNER** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/runner.ts` (910 lines): `AgentRequestError`, `decideApproval`, `feedback`,
//!   `isTurnActive`, `retryTurn`, `startSiteAgentRuntime`, `stopTurn`, `submitMessage`, `submitUi`
