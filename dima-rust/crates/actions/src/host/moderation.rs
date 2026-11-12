//! The moderation group of the command language: `warn`, `vip`, `add.vip`, `channel.add.vip`,
//! `twitch.add.vip`, `unvip`, `ban`, `ban.self`, `ban.mod`, `mod`, `add.mod`, `channel.add.mod`,
//! `twitch.add.mod`, `unmod`, `permit`, `clear.chat`, `emoteonly`, `bot.mode` (18). Package
//! **P4-ACT-MOD** fills this module; until then [`call`] answers
//! [`super::ActionError::NotYetPorted`].
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `utils/ast_parser/functions/moderation.functions.ts` (660 lines):
//!   `registerModerationFunctions`, `startRestoreModeratorWorker`
//! - `utils/ast_parser/functions/defense.functions.ts` (44 lines): `registerDefenseFunctions`
//! - `utils/ast_parser/functions/moderation.helpers.ts` (3 lines)
//!
//! Temporary moderators are restored from the carried family
//! `twitch:moderation:banmod:restore:*` (a fixture of the TypeScript format). The restore loop
//! (`moderation.functions.ts:196`, every 2 s) runs in the cron only (lead's decision on plan
//! question 4): this module exposes it as a library loop the cron supervises
//! (P4-CRON-FEATURES registers it).

use super::{ActionError, DimaHost};
use dima_engine::host::{HostCall, HostError};
use dima_engine::value::Value;

/// The moderation group's handles: P4-ACT-MOD adds what its functions need (the
/// `dima-moderation` services, temporary moderator storage). Empty until then.
#[derive(Debug, Default)]
pub struct Deps {}

/// Runs one function of this group (the reference's handler for its name).
pub async fn call(_host: &mut DimaHost, call: HostCall<'_>) -> Result<Value, HostError> {
    Err(ActionError::NotYetPorted(call.function).into())
}
