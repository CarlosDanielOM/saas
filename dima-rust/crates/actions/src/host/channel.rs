//! The channel group of the command language (37 functions): the Twitch reads `twitch.live`,
//! `twitch.subs`, `twitch.title`, `twitch.game`, `twitch.viewers`, `twitch.follows`,
//! `twitch.channel`, `twitch.login`; `raid`, `unraid`, `set.title`, `set.game`, `set.voice`;
//! `start.prediction`, `get.prediction`, `lock.prediction`, `end.prediction`,
//! `cancel.prediction`; `start.poll`, `get.poll`, `end.poll`, `cancel.poll`; `followage`;
//! `announce`, `announcement`, `shoutout`, `chat.announcement`, `chat.send`; `pin`,
//! `pin.create`, `pin.update`, `pin.del`, `pin.delete`; `enable.command`, `disable.command`,
//! `enable.redemption`, `disable.redemption`. Package **P4-ACT-CHANNEL** fills this module;
//! until then [`call`] answers [`super::ActionError::NotYetPorted`].
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `utils/ast_parser/functions/channel.functions.ts` (383 lines, less `ai`, which is
//!   [`super::ai`]): `registerChannelFunctions`
//! - `utils/ast_parser/functions/twitch.functions.ts` (148 lines): `registerTwitchFunctions`
//! - `utils/ast_parser/functions/followage.functions.ts` (85 lines):
//!   `registerFollowageFunctions`
//! - `utils/ast_parser/functions/chat.functions.ts` (54 lines): `registerChatFunctions`
//! - `utils/ast_parser/functions/shoutout_target.ts` (29 lines): `normalizeTarget`,
//!   `targetChannel`, `targetUser`
//! - `utils/ast_parser/functions/pin.functions.ts` (238 lines): `registerPinFunctions`
//! - `utils/ast_parser/functions/availability.functions.ts` (28 lines):
//!   `registerAvailabilityFunctions`
//!
//! The functions that post plain chat (`channel.functions.ts:52`, `:65`, `:89`, `:115`,
//! `chat.functions.ts:12`, `pin.functions.ts:73`) use the plain send of `dima_twitch::chat::send`.

use super::{ActionError, DimaHost};
use dima_engine::host::{HostCall, HostError};
use dima_engine::value::Value;

/// The channel group's handles: P4-ACT-CHANNEL adds what its functions need (the TTS voices
/// for `$(set.voice)`, the availability service of `dima-commands`). Empty until then.
#[derive(Debug, Default)]
pub struct Deps {}

/// Runs one function of this group (the reference's handler for its name).
pub async fn call(_host: &mut DimaHost, call: HostCall<'_>) -> Result<Value, HostError> {
    Err(ActionError::NotYetPorted(call.function).into())
}
