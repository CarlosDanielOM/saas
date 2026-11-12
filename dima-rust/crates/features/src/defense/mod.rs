//! Follow defense: detection over follow bursts against the stored baselines, the summary chat
//! text, and raid sessions (their producers and the native raid sessions worker share documents).
//! Package **P4-FEAT-DEFENSE-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/follow_defense.ts` (502 lines)
//! - `utils/follow_defense_summary.ts` (159 lines): `suppressFollowAnnouncement`
//! - `utils/raid_sessions.ts` (225 lines): `applyRaidSessionMarker`, `findRaidSession`,
//!   `getRaidHistoryAccess`, `requestRaidBans`
//!
//! Raid sessions and follow defense call each other in the reference; here they are modules of one
//! crate. The summary posts rendered with the context `{ channelID }` through
//! `dima_twitch::chat::ChatOut::send` (`follow_defense_summary.ts:75`).

pub mod actions;
