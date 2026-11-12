//! What every settings tool shares: change detection, effects, access checks, messages. Package
//! **P4-SA-WRITE-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/write/settings/common.ts` (127 lines): `assertUnchanged`, `bodyEffects`,
//!   `changedPaths`, `channelName`, `conflict`, `display`, `hasFullAccess`, `mergeEffects`,
//!   `needsFullAccessResult`, `pickPaths`, `requireChannelOwner`, `requireSomething`,
//!   `routeMessage`, `sameValue`, `stringList`, `tr`
