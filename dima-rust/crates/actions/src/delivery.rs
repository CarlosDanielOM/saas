//! Rendering chat, posting it, and running the command references it produced:
//! [`ChatDelivery`], the implementer of [`dima_twitch::chat::ChatOut`]. Package **P4-ACT-CORE**
//! implements the trait for it (and adds what that needs); until then it is the type and its
//! dependencies, so that the binaries and the features' wiring can already name it.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `handlers/special_parser.handler.ts` (474 lines): `parseSpecialCommands` (the render with a
//!   context: argument placeholders, the execution context from the event data, the rendered
//!   text and its command references)
//! - `utils/ast_command_delivery.ts` (49 lines): `deliverAstMessage` (the outer text first, then
//!   each reference in authored order; an empty text still runs its references)
//! - `functions/chats/send_message.chat.ts`, the render branch (`:37-55`, `:149`): the plain
//!   post is `dima_twitch::chat::send` (P4-TW-CHAT)
//! - `functions/chats/index.ts` (24 lines): the module's re-exports
//!
//! Callers above this crate that hand over already-evaluated command references (the message,
//! keyword, raid and redemption handlers; the AST timers; the `ast_parser` AI tool) use
//! `ChatDelivery`'s own entry points, which P4-ACT-CORE adds; every other caller holds it as an
//! `Arc<dyn ChatOut>` (the list is on [`dima_twitch::chat::ChatOut`]).

use crate::host::HostDeps;
use dima_engine::eval::Engine;
use std::sync::Arc;

/// Renders command language with the engine and [`crate::host::DimaHost`], posts the result
/// with the plain send of `dima_twitch::chat::send`, and runs the command references through
/// [`crate::runner`]. One per process, shared; built by the binaries (P4-BIN-BOT, P4-BIN-API,
/// P2-CRON-01) and handed to every feature as `Arc<dyn ChatOut>`.
pub struct ChatDelivery {
    host: Arc<HostDeps>,
    engine: Arc<Engine>,
}

impl ChatDelivery {
    /// A delivery over the process's host handles and engine.
    pub fn new(host: Arc<HostDeps>, engine: Arc<Engine>) -> Self {
        Self { host, engine }
    }

    /// The host handles each rendering's [`crate::host::DimaHost`] is made from.
    pub fn host(&self) -> &Arc<HostDeps> {
        &self.host
    }

    /// The engine that renders.
    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }
}
