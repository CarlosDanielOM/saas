//! The command language streamers write in custom commands (`$(user)`, `%(*deaths)`,
//! `*(… ? … : …)`, loops), the pure half of the bot's command engine.
//!
//! - [`syntax`]: the tokenizer and parser (`parse` in `dimabot/src/utils/ast_parser/parser.ts`),
//!   the chat renderer's template scanner (`scanSourceSegments` in `render.ts`) and compiled
//!   plans that the evaluator runs.
//! - [`blocks`]: the block editor's model (`dimabot/src/utils/ast_blocks`): reading an untrusted
//!   block tree, compiling it to command text with a round-trip guarantee, and importing text.
//! - [`eval`]: the evaluator (`evaluator.ts`, `render.ts`, `timer.ts`): [`eval::Engine`] renders
//!   compiled text against a [`context::Context`] and a [`host::Host`].
//! - [`value`]: the values expressions compute ([`value::Value`]).
//! - [`context`]: the invocation, the run's state, command references, timer snapshots.
//! - [`host`]: every effect (chat, Twitch, variables in Dragonfly and MongoDB, timers, time,
//!   randomness) leaves the engine through [`host::Host`].
//! - [`registry`]: every function of the reference with its metadata, and which run in the
//!   engine ([`registry::Builtin`]) or in the host ([`host::HostFunction`]).
//! - [`permissions`]: what the evaluator needs from the permission system.
//!
//! Text rules (`MIGRATION.md` section 4): all text is UTF-8; our own limits count characters;
//! positions inside the crate are byte offsets ([`syntax::Span`]). The language's text
//! functions count and index characters (an emoji is one), on purpose; everything else a
//! streamer sees (number text, arithmetic, `Number()`, truthiness, JSON, `trim`, case mapping)
//! is the reference's. No position or count leaves the server today (the editor receives
//! messages and block ids only); [`syntax::Span::to_utf16`] is the one conversion for a
//! JavaScript client, should one ever need a position.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod blocks;
pub mod context;
pub mod eval;
mod functions;
pub mod host;
pub mod map;
pub mod permissions;
pub mod registry;
pub mod syntax;
mod text;
pub mod value;
