//! The chat renderer's split of command text (`scanSourceSegments` in `render.ts`).
//!
//! This is a different grammar from the tokenizer: plain text stays byte for byte, a start token
//! after an odd number of backslashes is text, and an expression ends at its matching `)`
//! counting quotes and backslash escapes only.

use super::source::{Budget, View};
use super::{Diagnostic, DiagnosticCode, PreparedGrammar, SegmentKind, SourceSegment, Span};
use crate::text::{byte, next_char};

/// The segments of `view`'s whole text.
pub(crate) fn scan(
    view: &View,
    grammar: &PreparedGrammar,
    budget: &Budget,
) -> Result<Vec<SourceSegment>, Diagnostic> {
    let text = &*view.text;
    let bytes = text.as_bytes();
    let mut segments = Vec::new();
    let mut i = 0;
    let mut plain = 0;
    while i < text.len() {
        // Skip to the next byte that can start an introducer. UTF-8 continuation bytes never
        // start one, so this stops on character boundaries only.
        while bytes.get(i).is_some_and(|&b| !grammar.candidate_byte(b)) {
            i += 1;
        }
        if i >= text.len() {
            break;
        }
        // The renderer sorts its start tokens longest first.
        let Some(def) = grammar.match_start(text, i, true) else {
            i = next_char(text, i);
            continue;
        };
        let slashes = bytes
            .get(..i)
            .unwrap_or_default()
            .iter()
            .rev()
            .take_while(|&&b| b == b'\\')
            .count();
        if slashes % 2 == 1 {
            i = next_char(text, i);
            continue;
        }
        let end = expression_end(view, i + grammar.start_len(def), budget)?;
        if i > plain {
            segments.push(segment(SegmentKind::Text, plain, i));
        }
        let Some(end) = end else {
            segments.push(segment(SegmentKind::Unclosed, i, text.len()));
            return Ok(segments);
        };
        segments.push(segment(SegmentKind::Expr, i, end));
        i = end;
        plain = end;
    }
    if plain < text.len() {
        segments.push(segment(SegmentKind::Text, plain, text.len()));
    }
    Ok(segments)
}

fn segment(kind: SegmentKind, start: usize, end: usize) -> SourceSegment {
    SourceSegment {
        kind,
        span: Span::new(start, end),
    }
}

/// `findExpressionEnd`: the offset after the `)` that closes an expression whose content
/// starts at `i`.
fn expression_end(view: &View, mut i: usize, budget: &Budget) -> Result<Option<usize>, Diagnostic> {
    let text = &*view.text;
    let mut depth = 1usize;
    let mut quote = 0u8;
    budget.depth(depth, view.span(i..i))?;
    while i < text.len() {
        let ch = byte(text, i);
        if quote != 0 {
            if ch == b'\\' {
                i = next_char(text, next_char(text, i));
                continue;
            }
            if ch == quote {
                quote = 0;
            }
            i = next_char(text, i);
            continue;
        }
        match ch {
            b'\\' => {
                i = next_char(text, next_char(text, i));
                continue;
            }
            b'"' | b'\'' => {
                quote = ch;
                i += 1;
                continue;
            }
            b'(' => {
                depth += 1;
                budget.depth(depth, view.span(i..i + 1))?;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(Some(i + 1));
                }
            }
            _ => {}
        }
        i = next_char(text, i);
    }
    Ok(None)
}

/// The bot's last pass over a rendered reply (`unescapeRenderedText`): `\$`, `\%`, `\*`, `\#`
/// and `\^` lose their backslash, one replacement after the other as the reference chains them.
pub fn unescape_rendered_text(input: &str) -> String {
    if !input.contains('\\') {
        return input.to_owned();
    }
    let mut output = input.to_owned();
    for (escaped, plain) in [
        ("\\$", "$"),
        ("\\%", "%"),
        ("\\*", "*"),
        ("\\#", "#"),
        ("\\^", "^"),
    ] {
        if output.contains(escaped) {
            output = output.replace(escaped, plain);
        }
    }
    output
}

pub(crate) fn unclosed_diagnostic(span: Span) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::UnclosedExpression,
        "Unclosed expression",
        span,
    )
}
