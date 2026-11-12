//! The tokenizer (`tokenize` in `tokenizer.ts`), over byte ranges of a shared text.
//!
//! The reference re-tokenizes every array item as a new string. Here a whole nested array region
//! is indexed once ([`index_arrays`]) and every token, nested or not, lives in one arena.

use super::source::{Budget, View};
use super::{Diagnostic, DiagnosticCode, PreparedGrammar};
use crate::text::{byte, char_at, next_char, starts_with_at, sub};
use dima_text::is_js_whitespace;
use std::{collections::HashMap, ops::Range};

#[derive(Clone, Debug)]
pub(crate) enum TokenKind {
    /// Punctuation, an operator or a literal, as written.
    Raw,
    /// An introducer (index into the grammar).
    Start(usize),
    /// A double-quoted string; the range is its content.
    Quoted(Range<usize>),
    /// `%[…]`; each item is a range of token indexes.
    Array(Vec<Range<usize>>),
}

#[derive(Clone, Debug)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub bytes: Range<usize>,
    /// The index after this token and everything nested in it.
    pub next: usize,
}

#[derive(Debug)]
pub(crate) struct Tokens {
    pub view: View,
    pub tokens: Vec<Token>,
    /// The top-level token indexes.
    pub range: Range<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct ArrayLayout {
    pub end: usize,
    pub items: Vec<Range<usize>>,
}

struct Frame {
    start: usize,
    item: usize,
    items: Vec<Range<usize>>,
    array: bool,
}

/// Characters a backslash keeps literal (`ESCAPABLE_CHARS`).
pub(crate) fn escapable(byte: u8) -> bool {
    b"()[]{};?:\\".contains(&byte)
}

fn whitespace_at(text: &str, at: usize) -> bool {
    char_at(text, at).is_some_and(is_js_whitespace)
}

/// The double-quote rules of the tokenizer: a backslash skips the next character, and quotes
/// inside `${…}` stay inside until its braces balance. Returns the closing quote's offset. The
/// brace count is a counter, not recursion, so it needs no nesting check.
pub(crate) fn double_quote_end(view: &View, bytes: Range<usize>) -> Option<usize> {
    let text = &view.text;
    let (start, end) = (bytes.start, bytes.end);
    let mut i = start + 1;
    let mut braces = 0usize;
    while i < end {
        let ch = byte(text, i);
        if ch == b'\\' && i + 1 < end {
            i = next_char(text, i + 1);
            continue;
        }
        if starts_with_at(text, i, end, "${") {
            braces += 1;
            i += 2;
            continue;
        }
        if braces > 0 {
            if ch == b'{' {
                braces += 1;
            } else if ch == b'}' {
                braces -= 1;
            }
            i = next_char(text, i);
            continue;
        }
        if ch == b'"' {
            return Some(i);
        }
        i = next_char(text, i);
    }
    None
}

/// An item's range without the JavaScript whitespace around it, or `None` when it is blank.
fn item_range(text: &str, range: Range<usize>) -> Option<Range<usize>> {
    let raw = sub(text, range.clone());
    let leading = raw.len() - dima_text::trim_start(raw).len();
    let trimmed = dima_text::trim(raw);
    if trimmed.is_empty() {
        return None;
    }
    let start = range.start + leading;
    Some(start..start + trimmed.len())
}

/// Indexes a whole nested array region (starting at `%[`) in one pass: where each array ends
/// and where its items are, with the reference's rules (quotes, `[` `]` depth for the end;
/// brackets, parentheses and braces for the commas). Returns the end offset. Nested arrays are
/// frames of a loop, not recursion; the parser checks the nesting when it builds them.
pub(crate) fn index_arrays(
    view: &View,
    bytes: Range<usize>,
    budget: &mut Budget,
    depth: usize,
    index: &mut HashMap<usize, ArrayLayout>,
) -> Result<usize, Diagnostic> {
    let text = &view.text;
    let (at, end) = (bytes.start, bytes.end);
    let mut frames = vec![Frame {
        start: at,
        item: at + 2,
        items: Vec::new(),
        array: true,
    }];
    budget.depth(depth + 1, view.span(at..at + 2))?;
    let mut i = at + 2;
    let mut quote = 0u8;
    // Unmatched openers: each nested array asks whether one opened inside it, without
    // re-scanning text.
    let mut parens: Vec<usize> = Vec::new();
    let mut braces: Vec<usize> = Vec::new();
    while i < end {
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
        if ch == b'"' || ch == b'\'' {
            quote = ch;
            i += 1;
            continue;
        }
        if ch == b'[' || starts_with_at(text, i, end, "%[") {
            let array = ch == b'%';
            let width = if array { 2 } else { 1 };
            frames.push(Frame {
                start: i,
                item: i + width,
                items: Vec::new(),
                array,
            });
            i += width;
            continue;
        }
        match ch {
            b']' => {
                if let Some(mut frame) = frames.pop()
                    && frame.array
                {
                    if let Some(item) = item_range(text, frame.item..i) {
                        frame.items.push(item);
                    }
                    index.insert(
                        frame.start,
                        ArrayLayout {
                            end: i + 1,
                            items: frame.items,
                        },
                    );
                    budget.stats.arrays += 1;
                }
                if frames.is_empty() {
                    budget.stats.array_indexed_bytes += i + 1 - at;
                    budget.work(view.span(at..i + 1))?;
                    return Ok(i + 1);
                }
            }
            b',' => {
                if let Some(frame) = frames.last_mut()
                    && frame.array
                    && parens.last().is_none_or(|&p| p < frame.start + 2)
                    && braces.last().is_none_or(|&p| p < frame.start + 2)
                {
                    if let Some(item) = item_range(text, frame.item..i) {
                        frame.items.push(item);
                    }
                    frame.item = i + 1;
                }
            }
            b'(' => parens.push(i),
            b')' => {
                parens.pop();
            }
            b'{' => braces.push(i),
            b'}' => {
                braces.pop();
            }
            _ => {}
        }
        i = next_char(text, i);
    }
    budget.stats.array_indexed_bytes += end - at;
    budget.work(view.span(at..end))?;
    Err(Diagnostic::new(
        DiagnosticCode::UnclosedArray,
        "Unclosed array literal",
        view.span(at..end),
    ))
}

/// Tokenizes `bytes` of `view`.
pub(crate) fn tokenize(
    view: View,
    bytes: Range<usize>,
    grammar: &PreparedGrammar,
    budget: &mut Budget,
    depth: usize,
) -> Result<Tokens, Diagnostic> {
    let mut lexer = Lexer {
        view,
        grammar,
        tokens: Vec::new(),
        arrays: HashMap::new(),
    };
    let range = lexer.lex(bytes, budget, depth)?;
    Ok(Tokens {
        view: lexer.view,
        tokens: lexer.tokens,
        range,
    })
}

struct Lexer<'g> {
    view: View,
    grammar: &'g PreparedGrammar,
    tokens: Vec<Token>,
    arrays: HashMap<usize, ArrayLayout>,
}

/// An opener waiting for its closer: the opening token's text, the closer, where it is.
struct Open {
    opening: Range<usize>,
    closer: &'static str,
}

impl Lexer<'_> {
    fn push(
        &mut self,
        kind: TokenKind,
        bytes: Range<usize>,
        budget: &mut Budget,
    ) -> Result<usize, Diagnostic> {
        budget.token(self.view.span(bytes.clone()))?;
        let id = self.tokens.len();
        self.tokens.push(Token {
            kind,
            bytes,
            next: id + 1,
        });
        Ok(id)
    }

    fn lex(
        &mut self,
        range: Range<usize>,
        budget: &mut Budget,
        depth: usize,
    ) -> Result<Range<usize>, Diagnostic> {
        budget.depth(depth, self.view.span(range.clone()))?;
        let begin = self.tokens.len();
        let text = self.view.text.clone();
        let end = range.end;
        let mut i = range.start;
        // `validateDelimiters` runs after tokenizing: the first wrong closer wins, then the
        // innermost unclosed opener.
        let mut stack: Vec<Open> = Vec::new();
        let mut closing_error = None;
        while i < end {
            let start = i;
            let ch = byte(&text, i);
            // The tokenizer tries the registry in insertion order and takes the first match.
            let definition = self.grammar.match_start(sub(&text, 0..end), i, false);
            if starts_with_at(&text, i, end, "%[") {
                if !self.arrays.contains_key(&i) {
                    index_arrays(&self.view, i..end, budget, depth, &mut self.arrays)?;
                }
                let Some(layout) = self.arrays.get(&i).cloned() else {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnclosedArray,
                        "Unclosed array literal",
                        self.view.span(i..end),
                    ));
                };
                let id = self.push(TokenKind::Array(Vec::new()), i..layout.end, budget)?;
                let mut items = Vec::with_capacity(layout.items.len());
                for item in layout.items {
                    let before = self.tokens.len();
                    match self.lex(item, budget, depth + 1) {
                        Ok(tokens) => items.push(tokens),
                        // `parseArrayLiteral` ignores an item's tokenize error and parses the
                        // tokens it got.
                        Err(error) if !error.is_resource_limit() => {
                            items.push(before..self.tokens.len());
                        }
                        Err(error) => return Err(error),
                    }
                }
                if let Some(token) = self.tokens.get_mut(id) {
                    token.kind = TokenKind::Array(items);
                }
                let next = self.tokens.len();
                if let Some(token) = self.tokens.get_mut(id) {
                    token.next = next;
                }
                i = layout.end;
            } else if definition.is_none()
                && (starts_with_at(&text, i, end, "http://")
                    || starts_with_at(&text, i, end, "https://"))
            {
                while i < end
                    && byte(&text, i) != b')'
                    && !whitespace_at(&text, i)
                    && self
                        .grammar
                        .match_start(sub(&text, 0..end), i, false)
                        .is_none()
                {
                    i = next_char(&text, i);
                }
                self.push(TokenKind::Raw, start..i, budget)?;
            } else if let Some(def) = definition {
                i = (i + self.grammar.start_len(def)).min(end);
                self.push(TokenKind::Start(def), start..i, budget)?;
                stack.push(Open {
                    opening: start..i,
                    closer: ")",
                });
            } else if ch == b'"' {
                let Some(closing) = double_quote_end(&self.view, start..end) else {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnclosedQuote,
                        "Unclosed quoted string",
                        self.view.span(start..end),
                    ));
                };
                i = closing + 1;
                self.push(TokenKind::Quoted(start + 1..closing), start..i, budget)?;
            } else if b")[]{};.?:(".contains(&ch) {
                i += 1;
                self.push(TokenKind::Raw, start..i, budget)?;
                let closer = match ch {
                    b'(' => Some(")"),
                    b'[' => Some("]"),
                    b'{' => Some("}"),
                    _ => None,
                };
                if let Some(closer) = closer {
                    stack.push(Open {
                        opening: start..i,
                        closer,
                    });
                } else if matches!(ch, b')' | b']' | b'}') {
                    let token = sub(&text, start..i);
                    if stack.last().is_none_or(|open| open.closer != token) {
                        if closing_error.is_none() {
                            closing_error = Some(Diagnostic::new(
                                DiagnosticCode::UnexpectedClosing,
                                format!("Unexpected closing \"{token}\""),
                                self.view.span(start..i),
                            ));
                        }
                    } else {
                        stack.pop();
                    }
                }
            } else if let Some(len) = operator_len(&text, i, end) {
                i += len;
                self.push(TokenKind::Raw, start..i, budget)?;
            } else if whitespace_at(&text, i) {
                i = next_char(&text, i);
            } else {
                i = self.literal_end(&text, start, end);
                if i > start {
                    self.push(TokenKind::Raw, start..i, budget)?;
                } else {
                    i = next_char(&text, i);
                }
            }
            budget.stats.lexed_bytes += if starts_with_at(&text, start, end, "%[") {
                3
            } else {
                i - start
            };
            budget.work(self.view.span(start..i))?;
        }
        if let Some(error) = closing_error {
            return Err(error);
        }
        if let Some(open) = stack.last() {
            return Err(Diagnostic::new(
                DiagnosticCode::UnclosedDelimiter,
                format!("Unclosed \"{}\"", sub(&text, open.opening.clone())),
                self.view.span(open.opening.clone()),
            ));
        }
        Ok(begin..self.tokens.len())
    }

    /// Where a literal token that starts at `start` ends.
    fn literal_end(&self, text: &str, start: usize, end: usize) -> usize {
        let mut i = start;
        let mut non_prefix = false;
        while i < end {
            let c = byte(text, i);
            if c == b'\\' && i + 1 < end && escapable(byte(text, i + 1)) {
                non_prefix = true;
                i += 2;
                continue;
            }
            if whitespace_at(text, i) || b"){;}?:[](+/".contains(&c) {
                break;
            }
            // `5.5` stays one token; any other `.` splits (`.length`).
            if c == b'.'
                && !(i > start
                    && i + 1 < end
                    && byte(text, i - 1).is_ascii_digit()
                    && byte(text, i + 1).is_ascii_digit())
            {
                break;
            }
            if c == b'-' && i > start {
                break;
            }
            // `*`, `**`, `#`, `##` are name prefixes until another character appears.
            if c == b'*' || c == b'#' {
                if non_prefix {
                    break;
                }
            } else if c == b'%' && !starts_with_at(text, i, end, "%(") {
                if i > start {
                    break;
                }
            } else {
                non_prefix = true;
            }
            if self
                .grammar
                .match_start(sub(text, 0..end), i, false)
                .is_some()
                || comparison_len(text, i, end).is_some()
            {
                break;
            }
            i = next_char(text, i);
        }
        i
    }
}

fn comparison_len(text: &str, i: usize, end: usize) -> Option<usize> {
    let remaining = sub(text, i..end);
    if ["==", "!=", ">=", "<=", "~=", "<>"]
        .iter()
        .any(|op| remaining.starts_with(op))
    {
        Some(2)
    } else if matches!(remaining.as_bytes().first(), Some(b'=' | b'<' | b'>')) {
        Some(1)
    } else {
        None
    }
}

/// The operator branches of the tokenizer, in its order.
fn operator_len(text: &str, i: usize, end: usize) -> Option<usize> {
    let remaining = sub(text, i..end);
    if ["++", "--", "+=", "-=", "*=", "/=", "%="]
        .iter()
        .any(|op| remaining.starts_with(op))
    {
        return Some(2);
    }
    let c = byte(text, i);
    let has_next = i + 1 < end;
    let next = if has_next { byte(text, i + 1) } else { 0 };
    let letter = next.is_ascii_alphabetic() || next == b'_';
    if c == b'/'
        || (c == b'+' && !letter)
        || (c == b'-' && has_next && next != b'>' && !letter)
        || ((c == b'%' || c == b'*')
            && has_next
            && next != b'('
            && !letter
            && next != b'#'
            && next != b'*')
        || (c == b'#' && has_next && next != b'(' && !letter && next != b'#')
    {
        return Some(1);
    }
    comparison_len(text, i, end)
}

/// Resolves the backslash escapes of a literal (`unescapeLiteral`): `\X` becomes `X` for the
/// characters in `( ) [ ] { } ; ? : \`.
pub fn unescape_literal(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\'
            && let Some(&next) = chars.peek()
            && next.is_ascii()
            && escapable(next as u8)
        {
            result.push(next);
            chars.next();
            continue;
        }
        result.push(ch);
    }
    result
}
