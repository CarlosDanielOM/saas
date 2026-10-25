//! Pure DEFAULT AST syntax, independent of workers, evaluation and IO.
//!
//! `parse` is the whole-program grammar. `scan_template` is the chat renderer's
//! distinct text/expression grammar. Compiled plans retain per-expression errors
//! in source order, allowing a future evaluator to use a fresh context every time.
//! No runtime values or output are cached here.
//!
//! Defaults bound source to 10,000 UTF16 units, tokens to 20,000, nodes to 4,000,
//! and nesting to 128. Every nested array, quoted interpolation and chat segment
//! shares the compilation budget. Nesting also bounds produced AST depth; the
//! hard ceiling remains 128 even with a larger configured value.
//! Persisted JSON container depth has a separate exclusive ceiling of 128 so
//! every produced program fits the standard bounded serde_json reader.
//!
//! Improved mode fixes apostrophes, array escaping and quoted interpolation
//! boundaries in chat scanning and rejects malformed or partly consumed nested
//! expressions. `typescript_compatible()`
//! keeps the source's permissive policies and error-literal channels, subject to
//! resource safety. Precedence, sequence slots and empty ternaries are unchanged.

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

use source::{Budget, Source, View};
use std::{ops::Range, sync::Arc};

#[derive(Clone, Debug)]
pub struct SyntaxEngine {
    grammar: PreparedGrammar,
    profile: SyntaxProfile,
    limits: Limits,
}
impl Default for SyntaxEngine {
    fn default() -> Self {
        Self::new(
            PreparedGrammar::default(),
            SyntaxProfile::Improved,
            Limits::default(),
        )
    }
}
impl SyntaxEngine {
    pub fn typescript_compatible() -> Self {
        Self::new(
            PreparedGrammar::default(),
            SyntaxProfile::TypeScriptCompatible,
            Limits::default(),
        )
    }
    pub fn new(grammar: PreparedGrammar, profile: SyntaxProfile, mut limits: Limits) -> Self {
        limits.nesting = limits.nesting.min(HARD_NESTING_CEILING);
        Self {
            grammar,
            profile,
            limits,
        }
    }
    pub fn with_limits(self, limits: Limits) -> Self {
        Self::new(self.grammar, self.profile, limits)
    }
    pub fn grammar(&self) -> &PreparedGrammar {
        &self.grammar
    }
    pub fn profile(&self) -> SyntaxProfile {
        self.profile
    }
    pub fn limits(&self) -> Limits {
        self.limits
    }
    pub fn parse(&self, input: &str) -> Result<CompiledProgram, Diagnostic> {
        let source = Source::new(input, self.limits)?;
        let view = View::original(source);
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
        let tokens = lexer::tokenize(
            view.clone(),
            bytes.clone(),
            &self.grammar,
            self.profile,
            budget,
            0,
        )?;
        let mut parser = parser::Parser {
            tokens: &tokens,
            grammar: &self.grammar,
            profile: self.profile,
            budget,
        };
        let root = parser.root(tokens.range.clone(), 0)?;
        persistence::validate(&root.node, view.span(bytes.clone()))?;
        Ok(CompiledProgram {
            source: view.source.text.clone(),
            bytes,
            root: root.node,
            stats: parser.budget.stats.since(previous),
        })
    }
    pub fn scan_template(&self, input: &str) -> Result<Vec<SourceSegment>, Diagnostic> {
        let view = View::original(Source::new(input, self.limits)?);
        let mut budget = Budget::new(self.limits);
        Ok(
            scanner::scan(&view, &self.grammar, self.profile, &mut budget)?
                .into_iter()
                .map(|segment| segment.export(&view))
                .collect(),
        )
    }
    pub fn compile_template(&self, input: &str) -> Result<CompiledTemplate, Diagnostic> {
        let view = View::original(Source::new(input, self.limits)?);
        let mut budget = Budget::new(self.limits);
        let ranges = scanner::scan(&view, &self.grammar, self.profile, &mut budget)?;
        let mut segments = Vec::with_capacity(ranges.len());
        for range in ranges {
            let segment = range.export(&view);
            let (program, diagnostic) = match range.kind {
                scanner::SegmentKind::Text => (None, None),
                scanner::SegmentKind::Unclosed => {
                    (None, Some(scanner::unclosed_diagnostic(&view, range.bytes)))
                }
                scanner::SegmentKind::Expr => {
                    let result = self.parse_range(&view, range.bytes, &mut budget);
                    if let Err(error) = &result
                        && error.is_resource_limit()
                    {
                        return Err(error.clone());
                    }
                    let diagnostic = result.as_ref().err().cloned();
                    (Some(result), diagnostic)
                }
            };
            segments.push(SegmentPlan {
                segment,
                program,
                diagnostic,
            });
        }
        Ok(CompiledTemplate {
            source: view.source.text.clone(),
            grammar_identity: self.grammar.identity.clone(),
            profile: self.profile,
            limits: self.limits,
            segments,
            stats: budget.stats,
        })
    }
}

/// Immutable syntax plans only. Source substitutions (such as runtime `&pN`
/// expansion) must happen before matching/compiling: exact-source matching is
/// deliberate and there is no output cache or evaluation context in this type.
#[derive(Clone, Debug)]
pub struct CompiledTemplate {
    source: Arc<str>,
    grammar_identity: Arc<str>,
    profile: SyntaxProfile,
    limits: Limits,
    segments: Vec<SegmentPlan>,
    stats: ParseStats,
}
impl CompiledTemplate {
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn segments(&self) -> &[SegmentPlan] {
        &self.segments
    }
    pub fn stats(&self) -> ParseStats {
        self.stats
    }
    pub fn matches_source(&self, source: &str) -> bool {
        &*self.source == source
    }
    pub fn is_compatible_with(&self, engine: &SyntaxEngine, source: &str) -> bool {
        self.matches_source(source)
            && self.grammar_identity == engine.grammar.identity
            && self.profile == engine.profile
            && self.limits == engine.limits
    }
}

#[cfg(test)]
mod tests;
