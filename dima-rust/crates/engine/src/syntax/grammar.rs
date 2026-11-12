use super::{Diagnostic, DiagnosticCode, Span};
use crate::text::rest;
use std::{fmt::Write as _, sync::Arc};

/// The parser operation an introducer starts. Unrelated to runtime function names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SyntaxHandler {
    /// `$(`: a function call.
    Function,
    /// `%(`: read or write a variable.
    Variable,
    /// `*(`: an expression or a loop.
    Compute,
    /// `^(`: does a variable exist.
    Exists,
    /// `%del(`: delete a variable.
    Delete,
    /// `#(`: run another command.
    CommandRef,
}

/// One introducer: its start token, its closer and what it parses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxDefinition {
    /// The start token (`$(`).
    pub start_token: String,
    /// The closer (always `)`).
    pub end_token: String,
    /// What it parses.
    pub handler: SyntaxHandler,
}

/// The introducer registry (`SyntaxRegistry` in `registry.ts`), prepared once and shared.
#[derive(Clone, Debug)]
pub struct PreparedGrammar {
    pub(crate) definitions: Arc<[SyntaxDefinition]>,
    /// Definition indexes by the start token's first byte, in registration order.
    buckets: Arc<[Vec<usize>; 256]>,
    pub(crate) identity: Arc<str>,
}

/// Version tag folded into [`PreparedGrammar::identity`].
pub const GRAMMAR_VERSION: &str = "dima-ast-default-v2";

impl Default for PreparedGrammar {
    fn default() -> Self {
        GrammarBuilder::default().prepare()
    }
}

impl PreparedGrammar {
    /// A string that differs whenever two grammars could parse differently.
    pub fn identity(&self) -> &str {
        &self.identity
    }

    /// The introducers, in registration order.
    pub fn definitions(&self) -> &[SyntaxDefinition] {
        &self.definitions
    }

    /// The introducer that starts at byte `at` of `source`.
    ///
    /// `longest: false` takes the first in registration order, as the tokenizer iterates the
    /// registry; `longest: true` takes the longest, as the renderer sorts its start tokens.
    pub(crate) fn match_start(&self, source: &str, at: usize, longest: bool) -> Option<usize> {
        let first = *source.as_bytes().get(at)?;
        let candidates = &self.buckets[usize::from(first)];
        if candidates.is_empty() {
            return None;
        }
        let tail = rest(source, at);
        let mut matched: Option<usize> = None;
        for &index in candidates {
            let token = &self.definitions[index].start_token;
            if tail.starts_with(token.as_str()) {
                if !longest {
                    return Some(index);
                }
                if matched
                    .is_none_or(|old| token.len() > self.definitions[old].start_token.len())
                {
                    matched = Some(index);
                }
            }
        }
        matched
    }

    /// Whether some introducer starts with `byte`.
    pub(crate) fn candidate_byte(&self, byte: u8) -> bool {
        !self.buckets[usize::from(byte)].is_empty()
    }

    pub(crate) fn start_len(&self, definition: usize) -> usize {
        self.definitions
            .get(definition)
            .map_or(0, |d| d.start_token.len())
    }

    pub(crate) fn handler(&self, definition: usize) -> SyntaxHandler {
        self.definitions
            .get(definition)
            .map_or(SyntaxHandler::Function, |d| d.handler)
    }
}

/// Builds a [`PreparedGrammar`]; the default holds the six introducers of `registry.ts`.
#[derive(Clone, Debug)]
pub struct GrammarBuilder {
    definitions: Vec<SyntaxDefinition>,
}

impl Default for GrammarBuilder {
    fn default() -> Self {
        let definitions = [
            ("$(", SyntaxHandler::Function),
            ("%(", SyntaxHandler::Variable),
            ("*(", SyntaxHandler::Compute),
            ("^(", SyntaxHandler::Exists),
            ("%del(", SyntaxHandler::Delete),
            ("#(", SyntaxHandler::CommandRef),
        ]
        .into_iter()
        .map(|(start, handler)| SyntaxDefinition {
            start_token: start.into(),
            end_token: ")".into(),
            handler,
        })
        .collect();
        Self { definitions }
    }
}

impl GrammarBuilder {
    /// Adds an introducer, or replaces the one with the same start token (`registerSyntax`).
    pub fn register(
        mut self,
        start: impl Into<String>,
        end: impl Into<String>,
        handler: SyntaxHandler,
    ) -> Self {
        let definition = SyntaxDefinition {
            start_token: start.into(),
            end_token: end.into(),
            handler,
        };
        if let Some(existing) = self
            .definitions
            .iter_mut()
            .find(|d| d.start_token == definition.start_token)
        {
            *existing = definition;
        } else {
            self.definitions.push(definition);
        }
        self
    }

    /// Checks the introducers: each ends with `(`, closes with `)`, has no whitespace and does not
    /// start with the array prefix `%[`.
    pub fn build(self) -> Result<PreparedGrammar, Diagnostic> {
        for def in &self.definitions {
            if def.start_token.starts_with("%[") {
                return Err(Diagnostic::new(
                    DiagnosticCode::InvalidGrammar,
                    "Syntax introducers cannot start with reserved array prefix '%['",
                    Span::default(),
                ));
            }
            if def.start_token.len() < 2
                || !def.start_token.ends_with('(')
                || def.end_token != ")"
                || def.start_token.chars().any(dima_text::is_js_whitespace)
            {
                return Err(Diagnostic::new(
                    DiagnosticCode::InvalidGrammar,
                    "Syntax introducers must end with '(' and close with ')'",
                    Span::default(),
                ));
            }
        }
        Ok(self.prepare())
    }

    fn prepare(self) -> PreparedGrammar {
        let mut buckets: [Vec<usize>; 256] = std::array::from_fn(|_| Vec::new());
        let mut identity = GRAMMAR_VERSION.to_owned();
        for (i, def) in self.definitions.iter().enumerate() {
            if let Some(&first) = def.start_token.as_bytes().first() {
                buckets[usize::from(first)].push(i);
            }
            // Length-prefixed fields: two grammars cannot share an identity through delimiters.
            let _ = write!(
                identity,
                "|{}:{}:{}:{:?}",
                def.start_token.len(),
                def.start_token,
                def.end_token,
                def.handler
            );
        }
        PreparedGrammar {
            definitions: self.definitions.into(),
            buckets: Arc::new(buckets),
            identity: identity.into(),
        }
    }
}
