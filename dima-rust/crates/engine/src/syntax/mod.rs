//! Syntax of the command language: [`SyntaxEngine::parse`] for a whole program,
//! [`SyntaxEngine::scan_template`] for the chat renderer's split of command text into text and
//! expressions, and [`SyntaxEngine::compile_template`] for a plan the evaluator runs.
//!
//! Behaviour is the reference's (`dimabot/src/utils/ast_parser/{tokenizer,registry,parser,render}.ts`),
//! including its quirks. Differences, all on purpose:
//!
//! - resource limits ([`Limits`]): the reference has none. A source over the character limit, too
//!   many tokens or nodes, or too deep nesting gives a resource-limit [`Diagnostic`] for the whole
//!   compilation; the persisted JSON shape stays below [`HARD_JSON_NESTING_CEILING`];
//! - where the reference throws a `TypeError` (a variable introducer at the very end of an array
//!   item) this port reports [`DiagnosticCode::MissingVariableName`]; a per-viewer selector left
//!   open at the end of an array item parses as an empty literal instead of throwing;
//! - diagnostics carry a code and a byte [`Span`]; the reference only has the message.
//!
//! Plans are immutable syntax only: no evaluation context and no output are cached here, and
//! substitutions in the source (such as `&pN` expansion) must happen before compiling.

mod grammar;
mod lexer;
mod parser;
mod persistence;
mod scanner;
mod source;
mod types;

pub use grammar::{
    GRAMMAR_VERSION, GrammarBuilder, PreparedGrammar, SyntaxDefinition, SyntaxHandler,
};
pub use lexer::unescape_literal;
pub use scanner::unescape_rendered_text;
pub use types::*;

use source::{Budget, View};
use std::{ops::Range, sync::Arc};

/// A grammar and limits, prepared once and shared by every compilation.
#[derive(Clone, Debug, Default)]
pub struct SyntaxEngine {
    grammar: PreparedGrammar,
    limits: Limits,
}

impl SyntaxEngine {
    /// An engine for `grammar`; the nesting limit is capped at [`HARD_NESTING_CEILING`].
    pub fn new(grammar: PreparedGrammar, mut limits: Limits) -> Self {
        limits.nesting = limits.nesting.min(HARD_NESTING_CEILING);
        Self { grammar, limits }
    }

    /// The same grammar with other limits.
    pub fn with_limits(self, limits: Limits) -> Self {
        Self::new(self.grammar, limits)
    }

    /// The grammar.
    pub fn grammar(&self) -> &PreparedGrammar {
        &self.grammar
    }

    /// The limits.
    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Parses a whole program (`parse` in `parser.ts`). The reference's `{ ast, error }` is
    /// `Ok(program)` or `Err(diagnostic)`; on error its `ast` is always an empty root.
    pub fn parse(&self, input: &str) -> Result<CompiledProgram, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        let mut budget = Budget::new(self.limits);
        self.parse_range(&view, 0..input.len(), &mut budget)
    }

    fn parse_range(
        &self,
        view: &View,
        bytes: Range<usize>,
        budget: &mut Budget,
    ) -> Result<CompiledProgram, Diagnostic> {
        let previous = budget.stats;
        let tokens = lexer::tokenize(view.clone(), bytes.clone(), &self.grammar, budget, 0)?;
        let mut parser = parser::Parser {
            tokens: &tokens,
            grammar: &self.grammar,
            budget,
        };
        let root = parser.root(tokens.range.clone(), 0)?;
        let span = view.span(bytes);
        persistence::validate(&root.node, span)?;
        Ok(CompiledProgram {
            source: view.text.clone(),
            span,
            root: root.node,
            stats: parser.budget.stats.since(previous),
        })
    }

    /// Splits command text the way the chat renderer does (`scanSourceSegments`). Adjacent text
    /// is one segment; the segments cover the input in order.
    pub fn scan_template(&self, input: &str) -> Result<Vec<SourceSegment>, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        scanner::scan(&view, &self.grammar, &Budget::new(self.limits))
    }

    /// Scans command text and parses each expression segment, as `renderAstWithSourceReference`
    /// does before it evaluates. One budget covers every segment; a resource limit anywhere fails
    /// the whole plan, while ordinary parse errors stay with their segment.
    pub fn compile_template(&self, input: &str) -> Result<CompiledTemplate, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        let mut budget = Budget::new(self.limits);
        let ranges = scanner::scan(&view, &self.grammar, &budget)?;
        let mut segments = Vec::with_capacity(ranges.len());
        for segment in ranges {
            let step = match segment.kind {
                SegmentKind::Text => SegmentStep::Text,
                SegmentKind::Unclosed => {
                    SegmentStep::Unclosed(scanner::unclosed_diagnostic(segment.span))
                }
                SegmentKind::Expr => {
                    let range = segment.span.start..segment.span.end;
                    match self.parse_range(&view, range, &mut budget) {
                        Ok(program) => SegmentStep::Program(program),
                        Err(error) if error.is_resource_limit() => return Err(error),
                        Err(error) => SegmentStep::ParseError(error),
                    }
                }
            };
            segments.push(SegmentPlan { segment, step });
        }
        Ok(CompiledTemplate {
            source: view.text,
            grammar_identity: self.grammar.identity.clone(),
            limits: self.limits,
            segments,
            stats: budget.stats,
        })
    }
}

/// A compiled command text: its segments, each with what the renderer does with it.
#[derive(Clone, Debug)]
pub struct CompiledTemplate {
    source: Arc<str>,
    grammar_identity: Arc<str>,
    limits: Limits,
    segments: Vec<SegmentPlan>,
    stats: ParseStats,
}

impl CompiledTemplate {
    /// The command text.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The segments in order.
    pub fn segments(&self) -> &[SegmentPlan] {
        &self.segments
    }

    /// Work counters over all segments.
    pub fn stats(&self) -> ParseStats {
        self.stats
    }

    /// Whether this plan was compiled from exactly `source`.
    pub fn matches_source(&self, source: &str) -> bool {
        &*self.source == source
    }

    /// Whether `engine` would compile `source` to this same plan.
    pub fn is_compatible_with(&self, engine: &SyntaxEngine, source: &str) -> bool {
        self.matches_source(source)
            && self.grammar_identity == engine.grammar.identity
            && self.limits == engine.limits
    }
}
