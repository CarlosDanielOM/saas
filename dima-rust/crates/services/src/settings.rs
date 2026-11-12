//! Settings services: EventSub configuration, AI personality, follow defense and moderation
//! settings. Package **P4-SVC-SETTINGS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/services/eventsub_config.service.ts` (419 lines): `NON_DISABLEABLE_EVENT_TYPES`,
//!   `RAID_EVENT_FIELDS`, `createChannelEventsub`, `dedupeNormalizedEventsubs`,
//!   `deleteChannelEventsub`, `normalizeEventsubResponseType`, `updateChannelEventsub`
//! - `server/services/ai_personality.service.ts` (482 lines): `getChannelTierInfo`,
//!   `getOrCreatePersonality`, `getTierLimits`, `invalidatePersonalityCache`,
//!   `personalityRevision`, `readChannelPersonality`, `updateChannelPersonality`,
//!   `updateChannelPersonalityIfUnchanged`
//! - `server/services/follow_defense_settings.service.ts` (216 lines): `getOrCreateSettings`,
//!   `readFollowDefenseSettings`, `updateFollowDefenseSettings`,
//!   `updateFollowDefenseSettingsIfUnchanged`
//! - `server/services/moderation_settings.service.ts` (292 lines): `ModerationSettingsError`,
//!   `moderationSettingsRevision`, `prepareModerationSettings`, `readModerationSettings`,
//!   `saveModerationSettings`, `saveModerationSettingsIfUnchanged`
//!
//! The reference's pass-through PATCH is closed: typed fields only (owner decision).
