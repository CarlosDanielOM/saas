//! The block editor's model (`dimabot/src/utils/ast_blocks`): [`read_block_root`] checks an
//! untrusted tree from the browser, [`compile_blocks`] turns blocks into command text with a
//! guarantee that the text reads back as the same blocks, and [`import_command_text`] turns
//! command text into blocks, keeping what blocks cannot show as advanced (`raw`) pieces.
//!
//! Behaviour is the reference's, including what it gets wrong (listed in the package report):
//! for example an import that reads back cleanly can still fail to save when the canonical text
//! is longer than [`MAX_COMMAND_TEXT`]. Differences, on purpose:
//!
//! - every length limit counts characters, where the reference counts UTF-16 units: the
//!   10,000-character command limit, the "N of 10000 characters" count in its message, and the
//!   field limits (64 for variable names, 80 function names, 60 command names, 32 counter names,
//!   10,000 text); an unknown block type is quoted with its first 24 characters;
//! - the syntax this module parses has resource limits ([`crate::syntax::Limits`]); an
//!   expression over them reads as an advanced piece on import (the reference would show it as
//!   blocks) and as "would run differently" on save.

mod from_ast;
mod names;
mod normalize;
mod types;
mod validate;
mod writer;

pub use from_ast::IdMaker;
pub use normalize::{normalize_root, normalize_value, shape_eq, shape_eq_root};
pub use types::*;
pub use validate::read_block_root;

use crate::syntax::{
    Limits, PreparedGrammar, SegmentKind, SourceSegment, SyntaxEngine, unescape_rendered_text,
};
use serde_json::Value;
use std::sync::LazyLock;
use writer::Writer;

/// How much longer than the command limit a single expression written back from blocks may be
/// before its round trip is no longer checked (the reference has no such bound; writing back
/// grows text by escapes and spacing, well under this factor).
const ROUND_TRIP_EXPANSION: usize = 4;

/// The syntax used here: the default grammar, with room for a full 4,000-block tree (parser
/// nodes include the root and discarded empty nodes) and for a written-back expression.
static SYNTAX: LazyLock<SyntaxEngine> = LazyLock::new(|| {
    SyntaxEngine::new(
        PreparedGrammar::default(),
        Limits {
            source_chars: MAX_COMMAND_TEXT * ROUND_TRIP_EXPANSION,
            input_chars: MAX_COMMAND_TEXT * ROUND_TRIP_EXPANSION,
            tokens: MAX_COMMAND_TEXT * ROUND_TRIP_EXPANSION,
            nodes: MAX_BLOCK_NODES * 4 + 2,
            nesting: crate::syntax::MAX_NESTING,
        },
    )
});

const RUNS_DIFFERENTLY_MOVE: &str =
    "This block would run differently than it looks. Try moving or retyping it.";
const RUNS_DIFFERENTLY_RETYPE: &str =
    "This block would run differently than it looks. Try retyping its text.";

/// Editor blocks to command text (`compileBlocks`), with a guarantee: the text read back gives
/// the same blocks, so what the streamer sees is what the bot runs.
pub fn compile_blocks(input: &Value) -> Result<CompiledBlocks, BlocksError> {
    let root = normalize_root(read_block_root(input)?);
    let Some(last) = root.children.last() else {
        return Err(BlocksError::plain("Add at least one block."));
    };
    let mut writer = Writer::new(MAX_COMMAND_TEXT);
    writer.root(&root)?;
    let length = writer.chars();
    let Some(text) = writer.finish() else {
        // Row B7: the count is in characters.
        return Err(BlocksError::plain(format!(
            "This command is too long ({length} of {MAX_COMMAND_TEXT} characters)."
        )));
    };
    let segments = SYNTAX
        .scan_template(&text)
        .map_err(|error| BlocksError::plain(error.message))?;
    let count = segments.len().max(root.children.len());
    for i in 0..count {
        let (Some(block), Some(segment)) = (root.children.get(i), segments.get(i)) else {
            let id = root.children.get(i).unwrap_or(last).id.clone();
            return Err(BlocksError::new(RUNS_DIFFERENTLY_MOVE, Some(id)));
        };
        check_top_level(block, *segment, &text)?;
    }
    Ok(CompiledBlocks { root, text })
}

fn check_top_level(
    block: &BlockNode,
    segment: SourceSegment,
    text: &str,
) -> Result<(), BlocksError> {
    let source = segment.text(text);
    match &block.kind {
        BlockKind::Literal { value } => {
            if segment.kind != SegmentKind::Text || unescape_rendered_text(source) != *value {
                return Err(block.error("Text can't have a backslash right before $ % * # or ^."));
            }
        }
        BlockKind::Raw { source: raw } => {
            if segment.kind == SegmentKind::Text || source != raw {
                return Err(block.error(
                    "An advanced piece must be one $( … ), %( … ), *( … ), ^( … ), %del( … ) or #( … ).",
                ));
            }
        }
        _ => {
            if segment.kind != SegmentKind::Expr {
                return Err(block.error(RUNS_DIFFERENTLY_MOVE));
            }
            let reread = read_expression(source, &mut IdMaker::new("v", ""));
            if !reread.is_some_and(|reread| shape_eq(&reread, block)) {
                return Err(block.error(RUNS_DIFFERENTLY_RETYPE));
            }
        }
    }
    Ok(())
}

/// One top-level expression to a block, or `None` when it does not parse cleanly into one.
fn read_expression(source: &str, ids: &mut IdMaker) -> Option<BlockNode> {
    let program = SYNTAX.parse(source).ok()?;
    let [node] = program.children() else {
        return None;
    };
    from_ast::ast_to_block(node, ids).ok().map(normalize_value)
}

/// Command text to blocks (`importCommandText`) with fresh random ids. Never fails on content:
/// expressions blocks cannot show exactly (or that would not come back out the same) stay as
/// advanced pieces with their original text.
pub fn import_command_text(text: &str) -> Result<ImportedText, BlocksError> {
    import_command_text_with(text, &mut IdMaker::random("i"))
}

/// [`import_command_text`] with the caller's ids (deterministic in tests).
pub fn import_command_text_with(
    text: &str,
    ids: &mut IdMaker,
) -> Result<ImportedText, BlocksError> {
    let length = dima_text::char_len(text);
    if length > MAX_COMMAND_TEXT {
        // Row B4: the limit and the count are in characters.
        return Err(BlocksError::plain(format!(
            "This text is too long ({length} of {MAX_COMMAND_TEXT} characters)."
        )));
    }
    let segments = SYNTAX
        .scan_template(text)
        .map_err(|error| BlocksError::plain(error.message))?;
    let mut advanced_count = 0;
    let mut children = Vec::with_capacity(segments.len());
    for segment in segments {
        let source = segment.text(text);
        if segment.kind == SegmentKind::Text {
            children.push(BlockNode::literal(
                ids.next_id(),
                unescape_rendered_text(source),
            ));
            continue;
        }
        let block = match segment.kind {
            SegmentKind::Expr => read_expression(source, ids),
            _ => None,
        };
        match block {
            Some(block) if round_trips(&block, source) => children.push(block),
            _ => {
                advanced_count += 1;
                children.push(BlockNode::new(
                    ids.next_id(),
                    BlockKind::Raw {
                        source: source.to_owned(),
                    },
                ));
            }
        }
    }
    // Text with a backslash right before $ % * # ^ cannot be written back the same way; saving
    // then points at that block instead of changing the reply.
    let root = normalize_root(BlockRoot::new(ids.next_id(), children));
    Ok(ImportedText {
        root,
        advanced_count,
    })
}

/// The block, written back out, scans as one expression and reads back the same (`roundTrips`).
fn round_trips(block: &BlockNode, original: &str) -> bool {
    let mut writer = Writer::new(MAX_COMMAND_TEXT * ROUND_TRIP_EXPANSION);
    if writer.top_level(block).is_err() {
        return false;
    }
    let Some(source) = writer.finish() else {
        return false;
    };
    // Same text as the expression it was read from: it scans as that one expression and reads
    // back as this very block, so the reference's checks hold without a second parse.
    if source == original {
        return true;
    }
    let Ok(segments) = SYNTAX.scan_template(&source) else {
        return false;
    };
    let [segment] = segments.as_slice() else {
        return false;
    };
    if segment.kind != SegmentKind::Expr || segment.text(&source) != source {
        return false;
    }
    read_expression(&source, &mut IdMaker::new("r", ""))
        .is_some_and(|reread| shape_eq(&reread, block))
}

/// `storedBlocks`: what is saved on the command document.
pub fn stored_blocks(root: BlockRoot) -> StoredBlocks {
    StoredBlocks {
        v: BLOCKS_VERSION,
        root,
    }
}
