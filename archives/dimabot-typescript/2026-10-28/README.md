# Archived dimabot TypeScript source snapshots — 2026-10-28

These sixteen files are exact source snapshots preserved with SHA-256 hashes in [`manifest.json`](manifest.json). They cover a bounded set of pure helpers, AST exports, credential/activation exports, and TTS session/playback and credit fallback helpers accepted for native implementation. The archive supports source and behavior review; it does not mean the surrounding TypeScript callers, service adapters, or the full `dimabot/` migration are complete.

| Archived source | Native implementation area |
|---|---|
| `src/utils/shared_chat_origin.ts` | [`dimabot/src/utils/chat_message.rs`](../../../dimabot/src/utils/chat_message.rs) |
| `src/utils/raid_direction.ts` | [`dimabot/src/utils/eventsub.rs`](../../../dimabot/src/utils/eventsub.rs) |
| `src/utils/twitch_reward_body.util.ts` | [`dimabot/src/utils/twitch_reward_body.util.rs`](../../../dimabot/src/utils/twitch_reward_body.util.rs) |
| `src/utils/eventsub_condition.ts` | [`dimabot/src/utils/eventsub.rs`](../../../dimabot/src/utils/eventsub.rs) |
| `src/utils/eventsub_bits_config.ts` | [`dimabot/src/utils/eventsub_bits_config.rs`](../../../dimabot/src/utils/eventsub_bits_config.rs) |
| `src/utils/eventsub_reconciliation_policy.ts` | [`dimabot/src/utils/eventsub.rs`](../../../dimabot/src/utils/eventsub.rs) |
| `src/utils/links.ts` | [`dimabot/src/utils/links.rs`](../../../dimabot/src/utils/links.rs) |
| `src/utils/ast_blocks/from_ast.ts` | [`dimabot/src/utils/ast_blocks/from_ast.rs`](../../../dimabot/src/utils/ast_blocks/from_ast.rs) |
| `src/utils/ast_blocks/normalize.ts` | [`dimabot/src/utils/ast_blocks/normalize.rs`](../../../dimabot/src/utils/ast_blocks/normalize.rs) |
| `src/utils/ast_blocks/to_source.ts` | [`dimabot/src/utils/ast_blocks/to_source.rs`](../../../dimabot/src/utils/ast_blocks/to_source.rs) |
| `src/utils/crypto.ts` | [`dimabot/src/utils/crypto.rs`](../../../dimabot/src/utils/crypto.rs) |
| `src/utils/email/email-activation-token.ts` | [`dimabot/src/utils/email/email-activation-token.rs`](../../../dimabot/src/utils/email/email-activation-token.rs) |
| `src/utils/tts/tts_session.util.ts` | [`dimabot/src/utils/tts/session.rs`](../../../dimabot/src/utils/tts/session.rs) |
| `src/utils/tts/tts_playback_timeout.util.ts` | [`dimabot/src/utils/tts/playback_timeout.rs`](../../../dimabot/src/utils/tts/playback_timeout.rs) |
| `src/utils/tts/tts_credit_fallback.util.ts` | [`dimabot/src/utils/tts/credit_fallback.rs`](../../../dimabot/src/utils/tts/credit_fallback.rs) |
| `src/handlers/tts_credit_fallback.test.ts` | [`dimabot/tests/tts_credit_fallback.rs`](../../../dimabot/tests/tts_credit_fallback.rs) |

Several helper implementations are consolidated into shared Rust modules. The TTS session/playback helper source and dependency audit is recorded in [`migration-notes/tts-session-playback-2026-10-28.md`](../../../migration-notes/tts-session-playback-2026-10-28.md). A native helper is only local feature evidence: it does not by itself complete any remaining TypeScript caller or transitive dependency. React Email templates are outside this archive and remain an explicit migration exclusion.
