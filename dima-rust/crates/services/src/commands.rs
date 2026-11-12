//! Command and reward writes: command mutations with their field allow-list, block commands,
//! reserved defaults for a new channel, TTS settings, and reward creation with its EventSub
//! subscription. Package **P4-SVC-COMMANDS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/services/command_mutations.service.ts` (340 lines): `CommandMutationError`,
//!   `activationFilter`, `createChannelCommand`, `deleteChannelCommand`, `permissionModeFor`,
//!   `restoreDeletedCommand`, `updateChannelCommand`
//! - `server/services/command_blocks.service.ts` (86 lines): `CommandBlocksRequestError`,
//!   `channelPlanTier`, `presentCommand`
//! - `server/services/command_defaults.service.ts` (180 lines): `ensureBasicReservedCommands`,
//!   `ensureReservedCommands`, `getLocalizedReservedCommandDescription`,
//!   `getReservedCommandDefinition`, `getReservedCommandsPayload`
//! - `server/services/tts_settings.service.ts` (103 lines): `saveChannelTtsSettings`,
//!   `updateChannelTtsSettingsIfUnchanged`
//! - `server/services/reward_creation.service.ts` (259 lines): `cleanupRewardArtifacts`,
//!   `createRewardWithEventsub`, `patchTwitchReward`
//! - `utils/twitch_reward_body.util.ts` (105 lines): `MAX_GLOBAL_COOLDOWN_SECONDS`,
//!   `isTwitchOnlyRewardUpdate`, `validateRewardSettings`
//!
//! Owns the zero-cooldown lease write (fenced), the 10,000-character source limit and an upper
//! bound on cooldowns (`packages.md`).
