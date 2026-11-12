//! The overlay namespaces of roulettes, widgets, duels and DimaFX, with their 500 ms and 2 s polls.
//! Package **P4-RT-SOCKETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/services/roulette-overlay.service.ts` (51 lines)
//! - `server/services/widgets-overlay.service.ts` (54 lines)
//! - `server/services/duel-overlay.service.ts` (79 lines)
//! - `server/services/dimafx-overlay.service.ts` (51 lines): `authorizeDimafxOverlay`,
//!   `dimafxOverlayUrl`
