//! The media group of the command language (43 functions): the overlay controls `overlay.skip`,
//! `overlay.pause`, `overlay.resume`, `overlay.clear` and their `.twitch` and `.kick` forms
//! (12); `roulette.add`, `.remove`, `.update`, `.shuffle`, `.switch`, `.show`, `.hide`,
//! `.start`, `.result` (9); `randomuser`; `show.clip`, `create.clip`; `tts.status`,
//! `tts.connected`, `tts.queue.length`, `tts.skip`, `tts.clear`, `tts.refresh`, `tts.kokoro`,
//! `tts`, `tts.speak`, `tts.piper`, `tts.ai`, `tts.clone`, `tts.fish` (13); `pet.talk`,
//! `pet.ask`; `widget.signal`, `widget.signal.to`; `goal.add`; `trigger.send`. Package
//! **P4-ACT-MEDIA** fills this module; until then [`call`] answers
//! [`super::ActionError::NotYetPorted`].
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `utils/ast_parser/functions/overlay.functions.ts` (38 lines): `registerOverlayFunctions`
//! - `utils/ast_parser/functions/roulette.functions.ts` (53 lines): `registerRouletteFunctions`
//! - `utils/ast_parser/functions/user.functions.ts` (171 lines): `registerUserFunctions`
//! - `utils/ast_parser/functions/clip.functions.ts` (38 lines): `registerClipFunctions`
//! - `utils/ast_parser/functions/tts.functions.ts` (243 lines): `registerTtsFunctions`
//! - `utils/ast_parser/functions/pet.functions.ts` (36 lines): `registerPetFunctions`
//! - `utils/ast_parser/functions/widget.functions.ts` (55 lines): `registerWidgetFunctions`
//! - `utils/ast_parser/functions/goals.functions.ts` (61 lines): `registerGoalFunctions`
//! - `utils/ast_parser/functions/trigger.functions.ts` (103 lines): `registerTriggerFunctions`
//! - `functions/clips/show_clip.clip.ts` (258 lines), `functions/clips/index.ts` (11 lines)
//! - `commands/create_clip.command.ts` (141 lines): `createClipCommand`
//!
//! Requests to the API process (speech, TTS control and status, the Overlay Studio queue,
//! trigger sends) go through [`Deps::backend`]; clip requests through [`Deps::clips`]. TTS money
//! is charged later, in the API's queue. `goal.add` of a durable EventSub action throws the
//! required-goal-contribution error (`goals.functions.ts:52`), which
//! `dima_twitch::chat::ChatError::RequiredGoalContribution` carries out of a send.

use super::{ActionError, DimaHost};
use dima_engine::host::{HostCall, HostError};
use dima_engine::value::Value;
use dima_twitch::functions::chats::speech::BackendApi;
use dima_twitch::functions::clips::ClipPublisher;
use std::fmt;
use std::sync::Arc;

/// The media group's handles. P4-ACT-MEDIA adds the features it calls (goals, roulettes,
/// widgets, pets, Overlay Studio from `dima-features`, the TTS providers).
pub struct Deps {
    /// The request surface to the API process: internal HTTP in the bot and the cron
    /// (`crate::backend`), in process in the API (`dima_realtime::backend`).
    pub backend: Arc<dyn BackendApi>,
    /// Clip requests to the overlay consumer: pub/sub in the bot and the cron, in process in
    /// the API.
    pub clips: Arc<dyn ClipPublisher>,
}

impl fmt::Debug for Deps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Deps").finish_non_exhaustive()
    }
}

/// Runs one function of this group (the reference's handler for its name).
pub async fn call(_host: &mut DimaHost, call: HostCall<'_>) -> Result<Value, HostError> {
    Err(ActionError::NotYetPorted(call.function).into())
}
