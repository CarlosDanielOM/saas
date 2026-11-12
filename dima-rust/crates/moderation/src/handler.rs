//! The per-message moderation pass the bot runs on every chat message, and its settings cache.
//! Package **P4-MOD-RUN** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/moderation.handler.ts` (317 lines): `invalidateModerationSettingsCache`,
//!   `primeModerationSettingsCache`, `runChatModeration`
//!
//! The message handler (`dima-chat::message`, P4-CHAT-MESSAGE) calls the entry point; until this
//! module is filled, moderation answers "not enabled", which is what the reference does for a
//! channel whose moderation is off.
