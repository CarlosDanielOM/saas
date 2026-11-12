//! The chat message handler (the hot path): commands, keywords, moderation, the AI reply, the
//! analytics recorders, the embedding enqueue, and promotions. Package **P4-CHAT-MESSAGE** fills
//! this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/message.handler.ts` (780 lines): `messageHandler`
//! - `handlers/keywords.handler.ts` (25 lines)
//! - `functions/promo/chat.promo.ts` (138 lines)
//! - `functions/promo/index.ts` (1 lines)
//!
//! Moderation and the AI reply are called through `dima_moderation::handler` and
//! `dima_actions::ai`; until P4-MOD-RUN and P4-ACT-AI-B fill them they answer "not enabled" (plan
//! section 6, slice 1). AI reply chunks are plain posts that reply to the chat message
//! (`message.handler.ts:335`).
