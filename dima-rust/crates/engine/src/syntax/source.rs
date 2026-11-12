use super::{Diagnostic, DiagnosticCode, HARD_NESTING_CEILING, Limits, ParseStats, Span};
use crate::text::sub;
use std::{ops::Range, sync::Arc};

/// Refuses a text to parse that is longer than the input limit, counted in characters (row A2).
pub(crate) fn check_length(input: &str, limits: Limits) -> Result<(), Diagnostic> {
    check_chars(
        input,
        limits.input_chars,
        DiagnosticCode::InputLimit,
        "Input character limit exceeded",
    )
}

/// Refuses a stored command text longer than the source limit, counted in characters (row A2).
pub(crate) fn check_source(input: &str, limits: Limits) -> Result<(), Diagnostic> {
    check_chars(
        input,
        limits.source_chars,
        DiagnosticCode::SourceLimit,
        "Source character limit exceeded",
    )
}

fn check_chars(
    input: &str,
    limit: usize,
    code: DiagnosticCode,
    message: &str,
) -> Result<(), Diagnostic> {
    // A character is at least one byte, so short inputs need no count.
    if input.len() > limit && dima_text::char_len(input) > limit {
        return Err(Diagnostic::new(code, message, Span::new(0, input.len())));
    }
    Ok(())
}

/// The text tokens point into: the original source, or the decoded content of a quoted string
/// that had escapes.
///
/// Positions in the original are reported exactly. A decoded text has no position map: every
/// position in it reports the quoted string's span in the original (only resource-limit errors
/// can come from inside a quoted string; the reference turns the others into text).
#[derive(Clone, Debug)]
pub(crate) struct View {
    pub text: Arc<str>,
    origin: Option<Span>,
}

impl View {
    pub fn original(text: Arc<str>) -> Self {
        Self { text, origin: None }
    }

    pub fn span(&self, range: Range<usize>) -> Span {
        self.origin
            .unwrap_or_else(|| Span::new(range.start, range.end))
    }

    /// The content of a quoted token after the reference's escape replacements
    /// (`\n`, `\t`, `\"`, `\\`, applied one after the other as `registry.ts` chains them),
    /// with the range to read. Content without a backslash is read in place.
    pub fn decoded(&self, quoted: Range<usize>, content: Range<usize>) -> (Self, Range<usize>) {
        let raw = sub(&self.text, content.clone());
        if !raw.contains('\\') {
            return (self.clone(), content);
        }
        let text = raw
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
        let len = text.len();
        let view = Self {
            text: text.into(),
            origin: Some(self.span(quoted)),
        };
        (view, 0..len)
    }
}

/// The compilation budget, shared by every nested array, interpolation and template segment.
pub(crate) struct Budget {
    pub limits: Limits,
    pub stats: ParseStats,
}

impl Budget {
    pub fn new(mut limits: Limits) -> Self {
        limits.nesting = limits.nesting.min(HARD_NESTING_CEILING);
        Self {
            limits,
            stats: ParseStats::default(),
        }
    }

    pub fn depth(&self, depth: usize, span: Span) -> Result<(), Diagnostic> {
        if depth > self.limits.nesting {
            return Err(Diagnostic::new(
                DiagnosticCode::NestingLimit,
                "Nesting limit exceeded",
                span,
            ));
        }
        Ok(())
    }

    pub fn token(&mut self, span: Span) -> Result<(), Diagnostic> {
        if self.stats.tokens >= self.limits.tokens {
            return Err(Diagnostic::new(
                DiagnosticCode::TokenLimit,
                "Token limit exceeded",
                span,
            ));
        }
        self.stats.tokens += 1;
        Ok(())
    }

    pub fn node(&mut self, depth: usize, span: Span) -> Result<(), Diagnostic> {
        self.depth(depth, span)?;
        if self.stats.nodes >= self.limits.nodes {
            return Err(Diagnostic::new(
                DiagnosticCode::NodeLimit,
                "Node limit exceeded",
                span,
            ));
        }
        self.stats.nodes += 1;
        Ok(())
    }
}
