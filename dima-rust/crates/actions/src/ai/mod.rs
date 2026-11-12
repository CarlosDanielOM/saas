//! AI for the command language and the bot: channel personality, the OpenRouter call, DSML
//! recovery, usage tracking (money, through `dima-billing`), standalone text, `$(ai)`, and the
//! shared tool types. Package **P4-ACT-AI-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/openrouter/ai.ts` (lines 1–763, 684 of 1245): `extractOpenRouterError`,
//!   `getChannelPersonality`, `generateStandaloneText`
//! - `utils/ai/openrouter/command.ai.ts` (156 lines): `executeAiCommand`
//! - `utils/ai/openrouter/miyuloot.ai.ts` (23 lines): `generateMiyulootInsult`
//!
//! The types `code_execution.tool.ts` exported for the other tools (`IStreamerData` and others)
//! move here (plan section 1, "Not to port"). The AI tools run commands through
//! `crate::runner::CommandRunner` and post through `dima_twitch::chat::ChatOut`, never through
//! `crate::host`.

pub mod catalog;
pub mod chat;
