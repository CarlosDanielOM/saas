//! Syntax of the command language: [`SyntaxEngine::parse`] for a whole program,
//! [`SyntaxEngine::scan_template`] for the chat renderer's split of command text into text and
//! expressions, and [`SyntaxEngine::compile_template`] for a plan the evaluator runs.
//!
//! Behaviour is the reference's (`dimabot/src/utils/ast_parser/{tokenizer,registry,parser,render}.ts`),
//! including its quirks. Differences, all on purpose:
//!
//! - resource limits ([`Limits`]): the reference has none. A stored command text over
//!   [`MAX_SOURCE_CHARS`] is refused where it is saved ([`SyntaxEngine::check_source`]); the
//!   text parsing gets has viewer arguments substituted already and may be longer, up to
//!   [`MAX_INPUT_CHARS`]. Token, node and work budgets are derived from each program's length
//!   ([`TOKENS_PER_INPUT_BYTE`], [`NODES_PER_INPUT_BYTE`], [`WORK_BASE`]) so that no text within
//!   the source limit reaches them; nesting stops at [`MAX_NESTING`], above what the reference
//!   can parse. A budget hit fails that program only: in a template, its segment shows
//!   `[Parse error: …]`; inside an interpolation, a nesting limit shows the interpolation's text,
//!   as the reference does for its stack overflow;
//! - where the reference throws a `TypeError` that nothing catches (a variable introducer, or a
//!   per-viewer selector, left open at the very end of an array item) this port reports
//!   [`DiagnosticCode::MissingVariableName`] or [`DiagnosticCode::MissingUserSelector`]. Inside an
//!   interpolation the reference catches the throw and shows `[Parse error: {its text}]`; so does
//!   this port;
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
mod stack;
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
    /// An engine for `grammar`; the nesting limit is capped at [`MAX_NESTING`].
    pub fn new(grammar: PreparedGrammar, mut limits: Limits) -> Self {
        limits.nesting = limits.nesting.min(MAX_NESTING);
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

    /// Refuses a stored command text over [`Limits::source_chars`] characters, for the places
    /// that save one. Parsing does not apply this limit: the text it gets has viewer arguments
    /// substituted and is bounded by [`Limits::input_chars`] instead.
    pub fn check_source(&self, text: &str) -> Result<(), Diagnostic> {
        source::check_source(text, self.limits)
    }

    /// Parses a whole program (`parse` in `parser.ts`). The reference's `{ ast, error }` is
    /// `Ok(program)` or `Err(diagnostic)`; on error its `ast` is always an empty root.
    pub fn parse(&self, input: &str) -> Result<CompiledProgram, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        self.program(&view, 0..input.len())
    }

    /// One program with its own budget, derived from its length. It is parsed on the caller's
    /// stack up to [`HARD_NESTING_CEILING`]; a deeper one is parsed again on a thread whose
    /// stack fits [`Limits::nesting`].
    fn program(&self, view: &View, bytes: Range<usize>) -> Result<CompiledProgram, Diagnostic> {
        let inline = {
            let mut budget = Budget::new(self.limits, bytes.len(), HARD_NESTING_CEILING);
            let result = self.parse_range(view, bytes.clone(), &mut budget);
            if !budget.needs_stack() {
                return result;
            }
            result
        };
        drop(inline);
        let nesting = self.limits.nesting;
        let deep = stack::run(nesting, || {
            let mut budget = Budget::new(self.limits, bytes.len(), nesting);
            self.parse_range(view, bytes.clone(), &mut budget)
        });
        deep.unwrap_or_else(|| {
            Err(Diagnostic::new(
                DiagnosticCode::NestingLimit,
                "Nesting limit exceeded",
                view.span(bytes.clone()),
            ))
        })
    }

    fn parse_range(
        &self,
        view: &View,
        bytes: Range<usize>,
        budget: &mut Budget,
    ) -> Result<CompiledProgram, Diagnostic> {
        let mut tokens = lexer::tokenize(view.clone(), bytes.clone(), &self.grammar, budget, 0)?;
        let range = tokens.range.clone();
        let mut parser = parser::Parser {
            tokens: &mut tokens,
            grammar: &self.grammar,
            budget,
        };
        let root = parser.root(range, 0)?;
        Ok(CompiledProgram {
            source: view.text.clone(),
            span: view.span(bytes),
            root: Arc::new(root.node),
            stats: parser.budget.stats,
        })
    }

    /// Splits command text the way the chat renderer does (`scanSourceSegments`). Adjacent text
    /// is one segment; the segments cover the input in order.
    pub fn scan_template(&self, input: &str) -> Result<Vec<SourceSegment>, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        Ok(scanner::scan(&view, &self.grammar))
    }

    /// Scans command text and parses each expression segment, as `renderAstWithSourceReference`
    /// does before it evaluates. Each segment is its own program with its own budget: like the
    /// reference, which parses and renders segments one by one, a failure (a resource limit
    /// included) stays with its segment and is shown as `[Parse error: …]`. Only an input over
    /// [`Limits::input_chars`] fails the whole plan.
    pub fn compile_template(&self, input: &str) -> Result<CompiledTemplate, Diagnostic> {
        source::check_length(input, self.limits)?;
        let view = View::original(Arc::from(input));
        let ranges = scanner::scan(&view, &self.grammar);
        let mut segments = Vec::with_capacity(ranges.len());
        let mut stats = ParseStats::default();
        for segment in ranges {
            let step = match segment.kind {
                SegmentKind::Text => SegmentStep::Text,
                SegmentKind::Unclosed => {
                    SegmentStep::Unclosed(scanner::unclosed_diagnostic(segment.span))
                }
                SegmentKind::Expr => {
                    match self.program(&view, segment.span.start..segment.span.end) {
                        Ok(program) => {
                            stats = stats.plus(program.stats);
                            SegmentStep::Program(program)
                        }
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
            stats,
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

    /// Work counters over all segments that parsed.
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
