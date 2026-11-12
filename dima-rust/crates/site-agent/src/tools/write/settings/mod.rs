//! The settings write tools. P4-SA-WRITE-C owns this file, where the settings registry lands; each
//! settings area is a submodule of its own, filled by P4-SA-WRITE-B (`common`, `ai_personality`,
//! `bits_rules`, `chat_events`) or P4-SA-WRITE-C (the others), at the same time (wave 3). Packages
//! **P4-SA-WRITE-C**, **P4-SA-WRITE-B** fill this module (each its own files); it is empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/write/settings/index.ts` (62 lines): `settingsTools`

pub mod ai_personality;
pub mod bits_rules;
pub mod chat_events;
pub mod common;
pub mod follow_defense;
pub mod goals;
pub mod moderation;
pub mod roulettes;
pub mod tts;
