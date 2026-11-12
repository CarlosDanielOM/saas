//! The turn store in Dragonfly streams: sessions, turns, events, leases, the input queue. Package
//! **P4-SA-CORE-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/store.ts` (356 lines): `LEASE_MS`, `LeaseLostError`, `acquireLease`,
//!   `activeTurnIds`, `appendEvent`, `beginRequest`, `bus`, `clearQueue`, `compareIds`,
//!   `createSession`, `createTurn`, `deleteSession`, `eventsAfter`, `finishActive`,
//!   `finishRequest`, `getContext`, `getItem`, `getOwnSession`, `getSession`, `getTurn`,
//!   `leaseHolder`, `listSessions`, `popQueuedInput`, `putItem`, `queueInput`, `queuedCount`,
//!   `releaseLease`, `renewLease`, `setContext`, `snapshot`, `updateSession`, `updateTurn`
