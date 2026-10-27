use super::{Diagnostic, DiagnosticCode, SourceSpan};
use std::sync::Arc;

/// Syntax handlers are pure parser operations, unrelated to runtime function names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyntaxHandler {
    Function,
    Variable,
    Compute,
    Exists,
    Delete,
    CommandRef,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxDefinition {
    pub start_token: String,
    pub end_token: String,
    pub handler: SyntaxHandler,
}

/// A registry prepared once and safely shared by many compilations.
#[derive(Clone, Debug)]
pub struct PreparedGrammar {
    pub(crate) definitions: Arc<[SyntaxDefinition]>,
    buckets: Arc<[Vec<usize>; 256]>,
    pub(crate) identity: Arc<str>,
}
pub const GRAMMAR_VERSION: &str = "dima-ast-default-v1.1";
impl Default for PreparedGrammar {
    fn default() -> Self {
        GrammarBuilder::default().prepare()
    }
}
impl PreparedGrammar {
    pub fn version(&self) -> &str {
        GRAMMAR_VERSION
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    pub fn definitions(&self) -> &[SyntaxDefinition] {
        &self.definitions
    }
    pub(crate) fn match_start(&self, source: &str, at: usize, longest: bool) -> Option<usize> {
        let first = *source.as_bytes().get(at)?;
        let candidates = &self.buckets[first as usize];
        let mut matched = None;
        for &index in candidates {
            let def = &self.definitions[index];
            if source[at..].starts_with(&def.start_token) {
                if !longest {
                    return Some(index);
                }
                if matched.is_none_or(|old: usize| {
                    def.start_token.len() > self.definitions[old].start_token.len()
                }) {
                    matched = Some(index);
                }
            }
        }
        matched
    }
    pub(crate) fn candidate_byte(&self, byte: u8) -> bool {
        !self.buckets[byte as usize].is_empty()
    }
}
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
    /// Adds/replaces an introducer. Pure handler aliases preserve grammar extensibility.
    /// Introducers must end with `(` and use `)` as their closer.
    /// The `%[` prefix is reserved for array literals and rejected by `build()`.
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
    pub fn build(self) -> Result<PreparedGrammar, Diagnostic> {
        for def in &self.definitions {
            if def.start_token.starts_with("%[") {
                return Err(Diagnostic::new(
                    DiagnosticCode::InvalidGrammar,
                    "Syntax introducers cannot start with reserved array prefix '%['",
                    SourceSpan::default(),
                ));
            }
            if def.start_token.len() < 2
                || !def.start_token.ends_with('(')
                || def.end_token != ")"
                || def
                    .start_token
                    .chars()
                    .any(super::super::js_compat::is_whitespace)
            {
                return Err(Diagnostic::new(
                    DiagnosticCode::InvalidGrammar,
                    "Syntax introducers must end with '(' and close with ')'",
                    SourceSpan::default(),
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
                buckets[first as usize].push(i);
            }
            // Length-prefix fields so identity cannot collide through delimiters.
            identity.push_str(&format!(
                "|{}:{}:{}:{:?}",
                def.start_token.len(),
                def.start_token,
                def.end_token,
                def.handler
            ));
        }
        PreparedGrammar {
            definitions: self.definitions.into(),
            buckets: Arc::new(buckets),
            identity: identity.into(),
        }
    }
}
