//! Pure version-1 command blocks. No evaluator, IO, service or worker behavior.
//!
//! Default parsing is explicitly TypeScriptCompatible. Chat-root scanning is
//! distinct from whole-program parsing. Each operation owns its exact-source
//! syntax cache; immutable syntax only is cached, never IDs or rendered output.
//! Reader IDs are repaired deterministically; import IDs have a fresh local
//! namespace unless the caller supplies a namespace or ID factory.
//!
//! JSON readers validate before normalization. Serde on the public data types is
//! a wire convenience, not a replacement for the validating compile boundary.

#[path = "from_ast.rs"]
mod from_ast;
#[path = "import_plan.rs"]
mod import_plan;
#[path = "normalize.rs"]
mod normalize;
#[path = "types.rs"]
mod types;
#[path = "validate.rs"]
mod validate;
#[path = "to_source.rs"]
mod writer;

pub use crate::utils::ast_syntax::SyntaxProfile;
pub use normalize::{normalize_root, normalize_value, structural_eq, structural_eq_root};
pub use types::*;

use crate::utils::ast_syntax::{
    AstNode, CompiledProgram, Diagnostic, DiagnosticCode, Limits, PreparedGrammar, SourceSegment,
    SyntaxEngine, unescape_rendered_text,
};
use from_ast::{Materializer, mismatch, value_field};
use serde_json::Value;
use std::{
    collections::{HashMap, hash_map::RandomState},
    hash::{BuildHasher, Hasher},
    sync::{Arc, OnceLock},
};
use validate::{Reader, base36, rules, units, valid_id};
use writer::Writer;

// Independent block-operation budgets. Parser construction includes its root
// wrapper and discarded nodes; it must not impose ast_syntax's default 4000 on
// a valid 7500-block tree. Cache hits are charged like misses to these logical
// aggregate limits (actual parser work is separately counted by parse_calls).
const SYNTAX_NODES: usize = MAX_BLOCK_NODES * 4 + 2;
const WORK_NODES: usize = MAX_BLOCK_NODES * 32;
const WORK_TOKENS: usize = MAX_BLOCK_NODES * 64;
const WORK_SOURCE: usize = MAX_COMMAND_TEXT * 32;

#[derive(Clone, Debug)]
pub struct BlocksEngine {
    syntax: SyntaxEngine,
}
impl Default for BlocksEngine {
    fn default() -> Self {
        Self::new(SyntaxProfile::TypeScriptCompatible)
    }
}
impl BlocksEngine {
    pub fn new(profile: SyntaxProfile) -> Self {
        Self {
            syntax: SyntaxEngine::new(
                PreparedGrammar::default(),
                profile,
                Limits {
                    source_utf16: MAX_COMMAND_TEXT,
                    tokens: MAX_COMMAND_TEXT * 4,
                    nodes: SYNTAX_NODES,
                    nesting: 128,
                },
            ),
        }
    }
    pub fn profile(&self) -> SyntaxProfile {
        self.syntax.profile()
    }
    pub fn read_block_root(&self, input: &Value) -> Result<BlockRoot, BlocksError> {
        read_block_root(input)
    }
    pub fn read_block_root_owned(&self, input: Value) -> Result<BlockRoot, BlocksError> {
        read_block_root_owned(input)
    }
    pub fn compile_blocks(&self, input: &Value) -> Result<CompiledBlocks, BlocksError> {
        self.compile_blocks_owned(input.clone())
    }
    pub fn compile_blocks_owned(&self, input: Value) -> Result<CompiledBlocks, BlocksError> {
        let mut reader = Reader::new();
        let root = reader.root(input)?;
        let root = normalize_root(root);
        if root.children.is_empty() {
            return Err(BlocksError::at(
                BlocksErrorCode::EmptyRoot,
                "Add at least one block.",
                None,
                &Origin::default().child("children"),
            ));
        }
        let mut op = Operation::new(&self.syntax);
        op.stats.validated_nodes = reader.nodes;
        let mut writer = Writer::new(rules());
        writer.root(&root)?;
        let text = writer.finish(&mut op.stats)?;
        self.check_root(&root, &text, &mut op, true)?;
        Ok(CompiledBlocks {
            root,
            text,
            stats: op.stats,
        })
    }
    pub fn import_command_text(&self, text: &str) -> Result<ImportedText, BlocksError> {
        // RandomState provides a fresh randomized seed without a process-global
        // mutable ID counter/cache or an additional randomness dependency.
        let salt = RandomState::new().build_hasher().finish();
        self.import_command_text_with_namespace(text, &format!("i{}", base36(salt)))
    }
    pub fn import_command_text_with_namespace(
        &self,
        text: &str,
        namespace: &str,
    ) -> Result<ImportedText, BlocksError> {
        if !valid_id(namespace) || namespace.len() > 48 {
            return Err(BlocksError::at(
                BlocksErrorCode::InvalidNamespace,
                "The import ID namespace is not valid.",
                None,
                &Origin::default(),
            ));
        }
        let mut seq = 0u64;
        let mut factory = || {
            seq += 1;
            format!("{namespace}{}", base36(seq))
        };
        self.import_command_text_with_id_factory(text, &mut factory)
    }
    pub fn import_command_text_with_id_factory(
        &self,
        text: &str,
        factory: &mut dyn FnMut() -> String,
    ) -> Result<ImportedText, BlocksError> {
        import_plan::import(self, text, factory)
    }
    fn round_trip(
        &self,
        block: &BlockNode,
        original: &str,
        source: &str,
        op: &mut Operation<'_>,
    ) -> Result<bool, BlocksError> {
        if original == source {
            // Original was already scanned as one expression and validated once.
            // Charge cached syntax work, but do not allocate a verification tree,
            // generate verification IDs or compare identical-source structures.
            return Ok(op.program(source)?.is_some());
        }
        let segments = self.syntax.scan_template(source).map_err(syntax_error)?;
        if segments.len() != 1
            || !matches!(&segments[0],SourceSegment::Expr {source:s,..} if s==source)
        {
            return Ok(false);
        }
        let Some(other) = op.expression(source, None, Origin::default())? else {
            return Ok(false);
        };
        op.stats.structural_comparisons += 1;
        Ok(structural_eq(block, &other))
    }
    fn check_root(
        &self,
        root: &BlockRoot,
        text: &str,
        op: &mut Operation<'_>,
        verify_expressions: bool,
    ) -> Result<(), BlocksError> {
        let segments = self.syntax.scan_template(text).map_err(syntax_error)?;
        for i in 0..segments.len().max(root.children.len()) {
            let block = root.children.get(i);
            let segment = segments.get(i);
            let (Some(block), Some(segment)) = (block, segment) else {
                return Err(root.children.get(i).or_else(||root.children.last()).expect("nonempty root").error(BlocksErrorCode::RoundTripMismatch,"This block would run differently than it looks. Try moving or retyping it.",None));
            };
            match &block.kind {
                BlockKind::Literal { value } => {
                    if !matches!(segment,SourceSegment::Text {text,..} if unescape_rendered_text(text)==*value)
                    {
                        let offset = value
                            .char_indices()
                            .find(|(i, c)| {
                                *c == '\\'
                                    && value[*i + 1..]
                                        .chars()
                                        .next()
                                        .is_some_and(|c| matches!(c, '$' | '%' | '*' | '#' | '^'))
                            })
                            .map_or(0, |(i, _)| i);
                        return Err(block.text_error(
                            BlocksErrorCode::LiteralEscape,
                            "Text can't have a backslash right before $ % * # or ^.",
                            offset,
                        ));
                    }
                }
                BlockKind::Raw { source } => {
                    if matches!(segment, SourceSegment::Text { .. }) || segment.raw_text() != source
                    {
                        return Err(block.error(BlocksErrorCode::InvalidRaw,"An advanced piece must be one $( … ), %( … ), *( … ), ^( … ), %del( … ) or #( … ).",Some("source")));
                    }
                }
                _ => {
                    if !matches!(segment, SourceSegment::Expr { .. }) {
                        return Err(block.error(BlocksErrorCode::RoundTripMismatch,"This block would run differently than it looks. Try moving or retyping it.",None));
                    }
                    if !verify_expressions {
                        continue;
                    }
                    let other = op.expression(segment.raw_text(), None, Origin::default())?;
                    op.stats.structural_comparisons += 1;
                    if let Some(other) = other {
                        if !structural_eq(block, &other) {
                            let culprit = mismatch(block, &other);
                            let message = "This block would run differently than it looks. Try retyping its text.";
                            return Err(if let BlockKind::Literal { value } = &culprit.kind {
                                culprit.text_error(
                                    BlocksErrorCode::RoundTripMismatch,
                                    message,
                                    value.find("${").unwrap_or(0),
                                )
                            } else {
                                culprit.error(
                                    BlocksErrorCode::RoundTripMismatch,
                                    message,
                                    value_field(culprit),
                                )
                            });
                        }
                    } else {
                        return Err(block.error(BlocksErrorCode::RoundTripMismatch,"This block would run differently than it looks. Try retyping its text.",None));
                    }
                }
            }
        }
        Ok(())
    }
}
fn syntax_error(d: Diagnostic) -> BlocksError {
    BlocksError::at(
        BlocksErrorCode::SyntaxLimit,
        d.message,
        None,
        &Origin::default(),
    )
}

struct Operation<'a> {
    syntax: &'a SyntaxEngine,
    cache: HashMap<String, Result<Arc<CompiledProgram>, Diagnostic>>,
    stats: BlocksStats,
}
impl<'a> Operation<'a> {
    fn new(syntax: &'a SyntaxEngine) -> Self {
        Self {
            syntax,
            cache: HashMap::new(),
            stats: BlocksStats::default(),
        }
    }
    fn program(&mut self, source: &str) -> Result<Option<Arc<CompiledProgram>>, BlocksError> {
        self.stats.syntax_source_units_charged = self
            .stats
            .syntax_source_units_charged
            .saturating_add(units(source));
        if self.stats.syntax_source_units_charged > WORK_SOURCE {
            return Err(BlocksError::at(
                BlocksErrorCode::SyntaxLimit,
                "Block syntax work limit exceeded.",
                None,
                &Origin::default(),
            ));
        }
        let program = if let Some(cached) = self.cache.get(source) {
            self.stats.cache_hits += 1;
            cached.clone()
        } else {
            self.stats.parse_calls += 1;
            let result = self.syntax.parse(source).map(Arc::new);
            self.cache.insert(source.to_owned(), result.clone());
            result
        };
        match program {
            Ok(program) => {
                let stats = program.stats();
                self.stats.syntax_nodes_charged =
                    self.stats.syntax_nodes_charged.saturating_add(stats.nodes);
                self.stats.syntax_tokens_charged = self
                    .stats
                    .syntax_tokens_charged
                    .saturating_add(stats.tokens);
                if self.stats.syntax_nodes_charged > WORK_NODES
                    || self.stats.syntax_tokens_charged > WORK_TOKENS
                {
                    return Err(BlocksError::at(
                        BlocksErrorCode::SyntaxLimit,
                        "Block syntax work limit exceeded.",
                        None,
                        &Origin::default(),
                    ));
                }
                Ok(Some(program))
            }
            Err(diagnostic) => {
                // Per-expression AST construction/depth limits make that piece
                // advanced. Source/token exhaustion aborts the whole operation;
                // aggregate logical budgets are never converted to raw nodes.
                match diagnostic.code {
                    DiagnosticCode::NodeLimit | DiagnosticCode::NestingLimit => {
                        self.stats.syntax_nodes_charged =
                            self.stats.syntax_nodes_charged.saturating_add(SYNTAX_NODES);
                        if self.stats.syntax_nodes_charged > WORK_NODES {
                            return Err(BlocksError::at(
                                BlocksErrorCode::SyntaxLimit,
                                "Block syntax work limit exceeded.",
                                None,
                                &Origin::default(),
                            ));
                        }
                        Ok(None)
                    }
                    DiagnosticCode::SourceLimit | DiagnosticCode::TokenLimit => {
                        Err(syntax_error(diagnostic))
                    }
                    _ => Ok(None),
                }
            }
        }
    }
    fn expression(
        &mut self,
        source: &str,
        factory: Option<&mut dyn FnMut() -> String>,
        p: Origin,
    ) -> Result<Option<BlockNode>, BlocksError> {
        let Some(program) = self.program(source)? else {
            return Ok(None);
        };
        let AstNode::Root { children } = program.root() else {
            return Ok(None);
        };
        if children.len() != 1 {
            return Ok(None);
        }
        let materializing = factory.is_some();
        let mut converter = Materializer {
            rules: rules(),
            next_id: factory,
            nodes: 0,
        };
        let result = converter.node(&children[0], 1, p);
        if materializing {
            self.stats.validated_nodes += converter.nodes;
        }
        Ok(result.ok().map(normalize_value))
    }
}

pub fn read_block_root(input: &Value) -> Result<BlockRoot, BlocksError> {
    read_block_root_owned(input.clone())
}
pub fn read_block_root_owned(input: Value) -> Result<BlockRoot, BlocksError> {
    Reader::new().root(input)
}
fn default_engine() -> &'static BlocksEngine {
    static ENGINE: OnceLock<BlocksEngine> = OnceLock::new();
    ENGINE.get_or_init(BlocksEngine::default)
}
pub fn compile_blocks(input: &Value) -> Result<CompiledBlocks, BlocksError> {
    default_engine().compile_blocks(input)
}
pub fn compile_blocks_owned(input: Value) -> Result<CompiledBlocks, BlocksError> {
    default_engine().compile_blocks_owned(input)
}
pub fn import_command_text(text: &str) -> Result<ImportedText, BlocksError> {
    default_engine().import_command_text(text)
}
pub fn stored_blocks(root: BlockRoot) -> StoredBlocks {
    StoredBlocks {
        v: BLOCKS_VERSION,
        root,
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
