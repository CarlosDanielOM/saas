//! The plain chat send: Helix `POST /chat/messages`, evaluating nothing. Package **P4-TW-CHAT**
//! fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `functions/chats/send_message.chat.ts` (159 lines), the send only: the app token, the body
//!   `{ broadcaster_id, sender_id: '698614112', message, for_source_only: true }` with
//!   `reply_parent_message_id` for a reply, the answers for a refusal (non-2xx), for a message
//!   Twitch held (`is_sent: false`) and for a failure, each with its log line. The render branch
//!   (`parseSpecialCommands`, `deliverAstMessage`) is `dima_actions::delivery` (P4-ACT-CORE).
//! - `utils/twitch/chat_message_chunks.ts` (52): `splitAiResponseForTwitch` (the 450 budget, an
//!   astral character counting 2, by charter decision) and `removeAiReplyRecipientTag`.
//! - `utils/links.ts` (6): `getTwitchHelixUrl`, `getTwitchOAuthUrl`.
//! - `utils/dev.ts` (14): `getEnvironment`, `getUrl`, `getApiUrl` (configuration read once by
//!   the binaries, as [`crate::functions::chats::speech::BackendConfig`] already does).
//! - P2-TWITCH-04b's leftover: the trailing `?` of four poll and prediction calls.
//!
//! Public entry points the plan promises: the plain send, taking a [`super::RenderScope`] without
//! a rendering (its channel and reply target) and the text, answering with
//! `Result<`[`super::Sent`]`, `[`super::ChatError`]`>` (never [`super::ChatError::Render`] or
//! [`super::ChatError::RequiredGoalContribution`], which only rendering produces); and the
//! splitter, for the message handler's AI replies. The plan placed the send at
//! `functions::chats::send`; it lives here, next to the trait whose types it answers with.
