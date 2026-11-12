//! The bot's EventSub handlers: the dispatcher, redemptions, cheers, follows, raids, bans, ad
//! breaks, stream online and offline, revocation. Removes the timed VIP code (owner). Package
//! **P4-CHAT-EVENTS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/eventsub.handler.ts` (267 lines): `eventsubHandler`
//! - `handlers/redemption.handler.ts` (260 lines)
//! - `handlers/cheer.handler.ts` (105 lines)
//! - `handlers/follow.handler.ts` (82 lines)
//! - `handlers/raid.handler.ts` (110 lines)
//! - `handlers/ban.handler.ts` (61 lines)
//! - `handlers/ad_break.handler.ts` (63 lines)
//! - `handlers/stream_online.handler.ts` (120 lines)
//! - `handlers/stream_offline.handler.ts` (54 lines)
//! - `handlers/revocation.handler.ts` (109 lines): `revocationHandler`
//! - `utils/bits_message.ts` (8 lines): `getBitsMessageText`
//!
//! The API's EventSub test route runs `eventsubHandler` in its own process, so `dima-routes`
//! depends on this crate (lead's decision on plan question 3).
