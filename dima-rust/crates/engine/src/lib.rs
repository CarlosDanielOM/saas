//! The command language streamers write in custom commands (`$(user)`, `%(*deaths)`, `*(… ? … : …)`,
//! loops), without evaluation.
//!
//! - [`syntax`]: the tokenizer and parser (`parse` in `dimabot/src/utils/ast_parser/parser.ts`), the
//!   chat renderer's template scanner (`scanSourceSegments` in `render.ts`) and compiled plans that
//!   the evaluator runs.
//! - [`blocks`]: the block editor's model (`dimabot/src/utils/ast_blocks`): reading an untrusted
//!   block tree, compiling it to command text with a round-trip guarantee, and importing text.
//!
//! Text rules (`MIGRATION.md` section 4): all text is UTF-8; our own limits count characters;
//! positions inside the crate are byte offsets ([`syntax::Span`]). No position or count leaves
//! the server today (the editor receives messages and block ids only); [`syntax::Span::to_utf16`]
//! is the one conversion for a JavaScript client, should one ever need a position.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod blocks;
pub mod syntax;
mod text;
