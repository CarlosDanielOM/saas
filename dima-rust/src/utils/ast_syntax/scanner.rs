use super::lexer::{double_quote_end, index_arrays, next_char, single_quote_opens};
use super::source::{Budget, View};
use super::{Diagnostic, DiagnosticCode, PreparedGrammar, SourceSegment, SyntaxProfile};
use std::{collections::HashMap, ops::Range};

#[derive(Clone, Copy, Debug)]
pub(crate) enum SegmentKind {
    Text,
    Expr,
    Unclosed,
}
#[derive(Debug)]
pub(crate) struct SegmentRange {
    pub kind: SegmentKind,
    pub bytes: Range<usize>,
}
impl SegmentRange {
    pub fn export(&self, view: &View) -> SourceSegment {
        let text = view.text[self.bytes.clone()].to_owned();
        let span = view.span(self.bytes.clone());
        match self.kind {
            SegmentKind::Text => SourceSegment::Text { text, span },
            SegmentKind::Expr => SourceSegment::Expr { source: text, span },
            SegmentKind::Unclosed => SourceSegment::Unclosed { source: text, span },
        }
    }
}

/// Chat scanning deliberately differs from whole-program tokenization: ordinary
/// text stays byte-for-byte intact and an unclosed expression stops traversal.
pub(crate) fn scan(
    view: &View,
    grammar: &PreparedGrammar,
    profile: SyntaxProfile,
    budget: &mut Budget,
) -> Result<Vec<SegmentRange>, Diagnostic> {
    let text = &view.text;
    let mut segments = Vec::new();
    let mut i = 0;
    let mut plain = 0;
    while i < text.len() {
        // Skip plain chunks using the prepared first-byte lookup. Backslashes
        // are not syntax by themselves; escaping is checked only at a start.
        // UTF8 continuation bytes cannot introduce a registered UTF8 token, so
        // byte skipping still stops only at a character boundary.
        while i < text.len() && !grammar.candidate_byte(text.as_bytes()[i]) {
            i += 1;
        }
        if i >= text.len() {
            break;
        }
        let Some(def) = grammar.match_start(text, i, true) else {
            i = next_char(text, i);
            continue;
        };
        let slashes = text.as_bytes()[..i]
            .iter()
            .rev()
            .take_while(|&&b| b == b'\\')
            .count();
        if slashes % 2 == 1 {
            i = next_char(text, i);
            continue;
        }
        let content = i + grammar.definitions[def].start_token.len();
        let end = expression_end(view, content, grammar, profile, budget)?;
        if i > plain {
            segments.push(SegmentRange {
                kind: SegmentKind::Text,
                bytes: plain..i,
            });
        }
        if let Some(end) = end {
            segments.push(SegmentRange {
                kind: SegmentKind::Expr,
                bytes: i..end,
            });
            i = end;
            plain = end;
        } else {
            segments.push(SegmentRange {
                kind: SegmentKind::Unclosed,
                bytes: i..text.len(),
            });
            return Ok(segments);
        }
    }
    if plain < text.len() {
        segments.push(SegmentRange {
            kind: SegmentKind::Text,
            bytes: plain..text.len(),
        });
    }
    Ok(segments)
}
fn expression_end(
    view: &View,
    mut i: usize,
    grammar: &PreparedGrammar,
    profile: SyntaxProfile,
    budget: &mut Budget,
) -> Result<Option<usize>, Diagnostic> {
    let text = &view.text;
    let mut depth = 1usize;
    let mut quote = 0u8;
    let mut arrays = HashMap::new();
    budget.depth(depth, view.span(i..i))?;
    while i < text.len() {
        let ch = text.as_bytes()[i];
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
        if ch == b'\\' {
            i = next_char(text, next_char(text, i));
            continue;
        }
        if profile == SyntaxProfile::Improved && text[i..].starts_with("%[") {
            match index_arrays(
                view,
                i..text.len(),
                grammar,
                profile,
                budget,
                depth,
                &mut arrays,
            ) {
                Ok(end) => {
                    i = end;
                    continue;
                }
                Err(error) if error.is_resource_limit() => return Err(error),
                // Keep syntax errors local to an expression plan. If an array
                // cannot close, the parser reports it for this source segment.
                Err(_) => {}
            }
        }
        if profile == SyntaxProfile::Improved
            && let Some(def) = grammar.match_start(text, i, true)
        {
            let end = i + grammar.definitions[def].start_token.len();
            depth += 1;
            budget.depth(depth, view.span(i..end))?;
            i = end;
            continue;
        }
        if profile == SyntaxProfile::Improved && ch == b'"' {
            let Some(closing) = double_quote_end(view, i..text.len(), budget, depth)? else {
                return Ok(None);
            };
            i = closing + 1;
            continue;
        }
        if ch == b'"' || (ch == b'\'' && single_quote_opens(text, i, profile)) {
            quote = ch;
            i += 1;
            continue;
        }
        if ch == b'(' {
            depth += 1;
            budget.depth(depth, view.span(i..i + 1))?;
        } else if ch == b')' {
            depth -= 1;
            if depth == 0 {
                return Ok(Some(i + 1));
            }
        }
        i = next_char(text, i);
    }
    Ok(None)
}

/// Final rendered-text escapes are ordered like render.ts. This is independent
/// of literal escaping and intentionally does not unescape punctuation.
pub fn unescape_rendered_text(input: &str) -> String {
    let mut output = input.to_owned();
    for (escaped, plain) in [
        ("\\$", "$"),
        ("\\%", "%"),
        ("\\*", "*"),
        ("\\#", "#"),
        ("\\^", "^"),
    ] {
        output = output.replace(escaped, plain);
    }
    output
}

pub(crate) fn unclosed_diagnostic(view: &View, bytes: Range<usize>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::UnclosedExpression,
        "Unclosed expression",
        view.span(bytes),
    )
}
