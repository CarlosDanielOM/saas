//! The EventSub webhook ingress on port 3333: signature check (constant time), challenge,
//! revocation, replay protection, journaling, and the pub/sub manager. Package **P4-BOT-INGRESS**
//! fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `bot/eventsub.twitch.ts` (278 lines): `twitchEventsub`
//! - `classes/pubsub_manager.class.ts` (107 lines): `pubSubManager`
//!
//! An event that can never be valid is answered 2xx and kept in a dead-letter record (lead's
//! decision on plan question 5). `pubsub_manager.class.ts` is loaded by every process in the
//! reference; the cron does not link this crate (plan section 2.3), so what the cron needs of it
//! lands lower (open question in the P4-SKEL report).
