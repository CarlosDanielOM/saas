use super::{
    BUDGET_BASE, Diagnostic, DiagnosticCode, Limits, MAX_NESTING, NODES_PER_INPUT_BYTE, ParseStats,
    Span, TOKENS_PER_INPUT_BYTE, WORK_BASE, WORK_PER_INPUT_BYTE,
};
use crate::text::sub;
use std::{cell::Cell, ops::Range, sync::Arc};

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

/// The budget of one program (a whole parse, or one template segment), shared by every nested
/// array and interpolation in it. Token, node and work budgets are derived from the program's
/// length ([`TOKENS_PER_INPUT_BYTE`], [`NODES_PER_INPUT_BYTE`], [`WORK_PER_INPUT_BYTE`]); the
/// fixed caps in [`Limits`] apply on top.
pub(crate) struct Budget {
    pub limits: Limits,
    pub stats: ParseStats,
    /// Bytes the lexer and the array index may visit, nested regions counted again, plus the
    /// tokens and bytes the parser's own scans visit (loop bodies, interpolations).
    work: usize,
    /// What the parser's own scans visited.
    scanned: usize,
    /// The nesting this attempt may use on the current thread's stack.
    stack_nesting: usize,
    /// Set when the stack, not the nesting limit, refused a level: the program is parsed again
    /// on a thread with a stack for [`Limits::nesting`].
    needs_stack: Cell<bool>,
}

impl Budget {
    pub fn new(mut limits: Limits, bytes: usize, stack_nesting: usize) -> Self {
        limits.nesting = limits.nesting.min(MAX_NESTING);
        limits.tokens = limits.tokens.min(
            bytes
                .saturating_mul(TOKENS_PER_INPUT_BYTE)
                .saturating_add(BUDGET_BASE),
        );
        limits.nodes = limits.nodes.min(
            bytes
                .saturating_mul(NODES_PER_INPUT_BYTE)
                .saturating_add(BUDGET_BASE),
        );
        Self {
            limits,
            stats: ParseStats::default(),
            work: bytes.saturating_mul(WORK_PER_INPUT_BYTE).max(WORK_BASE),
            scanned: 0,
            stack_nesting: stack_nesting.min(limits.nesting),
            needs_stack: Cell::new(false),
        }
    }

    /// Whether the stack refused a level that the nesting limit allows.
    pub fn needs_stack(&self) -> bool {
        self.needs_stack.get()
    }

    /// Checks a level of recursion. Only recursive calls check: an iterative counter (open
    /// braces in a quoted string, open delimiters in the tokenizer) needs no stack.
    pub fn depth(&self, depth: usize, span: Span) -> Result<(), Diagnostic> {
        if depth > self.stack_nesting {
            if depth <= self.limits.nesting {
                self.needs_stack.set(true);
            }
            return Err(Diagnostic::new(
                DiagnosticCode::NestingLimit,
                "Nesting limit exceeded",
                span,
            ));
        }
        Ok(())
    }

    /// Checks the lexer's and array index's visited bytes against the work budget.
    pub fn work(&self, span: Span) -> Result<(), Diagnostic> {
        let used = self
            .stats
            .lexed_bytes
            .saturating_add(self.stats.array_indexed_bytes)
            .saturating_add(self.scanned);
        if used > self.work {
            return Err(Diagnostic::new(
                DiagnosticCode::WorkLimit,
                "Parse work limit exceeded",
                span,
            ));
        }
        Ok(())
    }

    /// Charges a scan of the parser (tokens or bytes it visited) to the work budget. Loops
    /// nested in loop bodies and interpolations nested in templates are scanned once per
    /// enclosing level, as the reference scans them.
    pub fn scan(&mut self, visited: usize, span: Span) -> Result<(), Diagnostic> {
        self.scanned = self.scanned.saturating_add(visited);
        self.work(span)
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
