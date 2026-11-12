//! The follow-defense action queue: claims and leases, adaptive pacing (5 to 10 requests a second),
//! bans, announcements and audit reconciliation. Package **P4-FEAT-DEFENSE-B** fills this module;
//! it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/follow_defense_queue.ts` (356 lines): `FOLLOW_DEFENSE_MAX_EVENT_AGE_MS`,
//!   `FOLLOW_DEFENSE_QUEUE_KEY`, `enqueueFollowDefenseFollow`, `followDefenseKeys`,
//!   `followDefenseQueueDataKey`, `getFollowDefenseStatus`, `projectFollowDefenseState`,
//!   `setFollowDefenseRaidMarker`, `shouldSuppressFollowAlerts`, `triggerFollowDefenseAttackMode`
//! - `utils/follow_defense_actions.ts` (250 lines): `cancelFollowDefenseActions`,
//!   `enqueueFollowDefenseAnnouncement`, `enqueueFollowDefenseBan`, `enqueueFollowDefenseBans`,
//!   `enqueueRaidSessionBan`, `followDefenseCancelledThrough`, `getDurableFollowDefenseBanResult`,
//!   `getFollowDefenseActionCounts`, `refreshFollowDefenseLogActions`
//!
//! Announcements post rendered with the context `{ channelID }` through
//! `dima_twitch::chat::ChatOut::send` (`follow_defense_actions.ts:179`). The reference exits its
//! process 40 s into a 60 s lease; here the unit of work runs under a deadline and is aborted and
//! joined (charter section 6).
