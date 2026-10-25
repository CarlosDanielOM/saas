use super::source::{Budget, View};
use super::{Diagnostic, DiagnosticCode, PreparedGrammar, SyntaxProfile};
use crate::utils::js_compat::{is_whitespace, trim};
use std::{collections::HashMap, ops::Range};

#[derive(Debug)]
pub(crate) enum TokenKind {
    Raw,
    Start(usize),
    Quoted(Range<usize>),
    Array(Vec<Range<usize>>),
}
#[derive(Debug)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub bytes: Range<usize>,
    pub next: usize,
}
#[derive(Debug)]
pub(crate) struct Tokens {
    pub view: View,
    pub tokens: Vec<Token>,
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

pub(crate) fn next_char(text: &str, at: usize) -> usize {
    text.get(at..)
        .and_then(|s| s.chars().next())
        .map_or(text.len(), |c| at + c.len_utf8())
}
fn byte(text: &str, at: usize) -> u8 {
    text.as_bytes().get(at).copied().unwrap_or(0)
}

/// The approved contraction policy is deliberately narrow: ASCII word bytes
/// must appear on both sides. Every other single quote keeps source behavior.
pub(crate) fn single_quote_opens(text: &str, at: usize, profile: SyntaxProfile) -> bool {
    if profile == SyntaxProfile::TypeScriptCompatible {
        return true;
    }
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    !(at > 0 && word(byte(text, at - 1)) && word(byte(text, at + 1)))
}
pub(crate) fn escapable(byte: u8) -> bool {
    b"()[]{};?:\\".contains(&byte)
}

/// The tokenizer's double-quote boundary rules, shared by Improved scanners.
/// Quotes inside `${...}` stay inside the outer quote until its braces balance;
/// escapes skip the following character before either boundary is considered.
pub(crate) fn double_quote_end(
    view: &View,
    bytes: Range<usize>,
    budget: &Budget,
    depth: usize,
) -> Result<Option<usize>, Diagnostic> {
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
        if text[i..end].starts_with("${") {
            braces += 1;
            budget.depth(depth + braces + 1, view.span(start..i + 2))?;
            i += 2;
            continue;
        }
        if braces > 0 {
            if ch == b'{' {
                braces += 1;
                budget.depth(depth + braces + 1, view.span(start..i + 1))?;
            } else if ch == b'}' {
                braces -= 1;
            }
            i = next_char(text, i);
            continue;
        }
        if ch == b'"' {
            return Ok(Some(i));
        }
        i = next_char(text, i);
    }
    Ok(None)
}

fn item_range(text: &str, range: Range<usize>) -> Option<Range<usize>> {
    let raw = &text[range.clone()];
    let trimmed = trim(raw);
    if trimmed.is_empty() {
        return None;
    }
    let leading = raw.len() - raw.trim_start_matches(is_whitespace).len();
    Some(range.start + leading..range.start + leading + trimmed.len())
}

/// Index an entire nested array region in one pass. Descendant arrays reuse
/// this index and the same token arena; ancestors never re-tokenize their text.
pub(crate) fn index_arrays(
    view: &View,
    bytes: Range<usize>,
    grammar: &PreparedGrammar,
    profile: SyntaxProfile,
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
    let mut quote = 0;
    // Positions of unmatched openers let every nested array query its own
    // saturating delimiter depth without re-scanning ancestor/descendant text.
    let mut parens = Vec::new();
    let mut braces = Vec::new();
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
        if profile == SyntaxProfile::Improved && ch == b'\\' && escapable(byte(text, i + 1)) {
            i += 2;
            continue;
        }
        if profile == SyntaxProfile::Improved
            && !text[i..end].starts_with("%[")
            && let Some(def) = grammar.match_start(&text[..end], i, true)
        {
            let next = i + grammar.definitions[def].start_token.len();
            parens.push(i);
            budget.depth(
                depth + frames.len() + parens.len() + braces.len(),
                view.span(i..next),
            )?;
            i = next;
            continue;
        }
        if profile == SyntaxProfile::Improved && ch == b'"' {
            let Some(closing) = double_quote_end(
                view,
                i..end,
                budget,
                depth + frames.len() + parens.len() + braces.len(),
            )?
            else {
                break;
            };
            i = closing + 1;
            continue;
        }
        if ch == b'"' || (ch == b'\'' && single_quote_opens(text, i, profile)) {
            quote = ch;
            i += 1;
            continue;
        }
        if ch == b'[' || text[i..].starts_with("%[") {
            let array = ch == b'%';
            frames.push(Frame {
                start: i,
                item: i + if array { 2 } else { 1 },
                items: Vec::new(),
                array,
            });
            budget.depth(depth + frames.len(), view.span(i..next_char(text, i)))?;
            i += if array { 2 } else { 1 };
            continue;
        }
        if ch == b']' {
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
                return Ok(i + 1);
            }
        } else if ch == b',' {
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
        } else if ch == b'(' {
            parens.push(i);
            budget.depth(
                depth + frames.len() + parens.len() + braces.len(),
                view.span(i..i + 1),
            )?;
        } else if ch == b')' {
            parens.pop();
        } else if ch == b'{' {
            braces.push(i);
            budget.depth(
                depth + frames.len() + parens.len() + braces.len(),
                view.span(i..i + 1),
            )?;
        } else if ch == b'}' {
            braces.pop();
        }
        i = next_char(text, i);
    }
    budget.stats.array_indexed_bytes += end - at;
    Err(Diagnostic::new(
        DiagnosticCode::UnclosedArray,
        "Unclosed array literal",
        view.span(at..end),
    ))
}

pub(crate) fn tokenize(
    view: View,
    bytes: Range<usize>,
    grammar: &PreparedGrammar,
    profile: SyntaxProfile,
    budget: &mut Budget,
    depth: usize,
) -> Result<Tokens, Diagnostic> {
    let mut lexer = Lexer {
        view,
        grammar,
        profile,
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
    profile: SyntaxProfile,
    tokens: Vec<Token>,
    arrays: HashMap<usize, ArrayLayout>,
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
        let mut i = range.start;
        let longest = self.profile == SyntaxProfile::Improved;
        let mut stack: Vec<(String, String, Range<usize>)> = Vec::new();
        let mut closing_error = None;
        while i < range.end {
            let start = i;
            let text = self.view.text.clone();
            let ch = byte(&text, i);
            let definition = self.grammar.match_start(&text[..range.end], i, longest);
            if text[i..range.end].starts_with("%[") {
                if !self.arrays.contains_key(&i) {
                    index_arrays(
                        &self.view,
                        i..range.end,
                        self.grammar,
                        self.profile,
                        budget,
                        depth + stack.len(),
                        &mut self.arrays,
                    )?;
                }
                let Some(layout) = self.arrays.get(&i).cloned() else {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnclosedArray,
                        "Unclosed array literal",
                        self.view.span(i..range.end),
                    ));
                };
                let id = self.push(TokenKind::Array(Vec::new()), i..layout.end, budget)?;
                let mut items = Vec::new();
                for item in layout.items {
                    let before = self.tokens.len();
                    match self.lex(item, budget, depth + 1) {
                        Ok(tokens) => items.push(tokens),
                        Err(error)
                            if self.profile == SyntaxProfile::TypeScriptCompatible
                                && !error.is_resource_limit() =>
                        {
                            items.push(before..self.tokens.len())
                        }
                        Err(error) => return Err(error),
                    }
                }
                self.tokens[id].kind = TokenKind::Array(items);
                self.tokens[id].next = self.tokens.len();
                i = layout.end;
            } else if definition.is_none()
                && (text[i..range.end].starts_with("http://")
                    || text[i..range.end].starts_with("https://"))
            {
                while i < range.end
                    && byte(&text, i) != b')'
                    && !text[i..].chars().next().is_some_and(is_whitespace)
                    && self
                        .grammar
                        .match_start(&text[..range.end], i, longest)
                        .is_none()
                {
                    i = next_char(&text, i);
                }
                self.push(TokenKind::Raw, start..i, budget)?;
            } else if let Some(def) = definition {
                i += self.grammar.definitions[def].start_token.len();
                if i > range.end {
                    i = range.end;
                }
                self.push(TokenKind::Start(def), start..i, budget)?;
                stack.push((
                    self.grammar.definitions[def].start_token.clone(),
                    self.grammar.definitions[def].end_token.clone(),
                    start..i,
                ));
                budget.depth(depth + stack.len(), self.view.span(start..i))?;
            } else if ch == b'"' {
                let Some(closing) = double_quote_end(&self.view, start..range.end, budget, depth)?
                else {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnclosedQuote,
                        "Unclosed quoted string",
                        self.view.span(start..range.end),
                    ));
                };
                i = closing + 1;
                self.push(TokenKind::Quoted(start + 1..closing), start..i, budget)?;
            } else if b")[]{};.?: (".contains(&ch) && ch != b' ' {
                i += 1;
                self.push(TokenKind::Raw, start..i, budget)?;
                if b"([{".contains(&ch) {
                    let closer = match ch {
                        b'(' => ")",
                        b'[' => "]",
                        _ => "}",
                    };
                    stack.push((text[start..i].into(), closer.into(), start..i));
                    budget.depth(depth + stack.len(), self.view.span(start..i))?;
                } else if b")]}".contains(&ch) && ch != b' ' {
                    let token = &text[start..i];
                    if stack.last().is_none_or(|(_, closer, _)| closer != token) {
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
            } else if let Some(len) = operator_len(&text, i, range.end) {
                i += len;
                self.push(TokenKind::Raw, start..i, budget)?;
            } else if text[i..].chars().next().is_some_and(is_whitespace) {
                i = next_char(&text, i);
            } else {
                let mut non_prefix = false;
                while i < range.end {
                    let c = byte(&text, i);
                    if c == b'\\' && i + 1 < range.end && escapable(byte(&text, i + 1)) {
                        non_prefix = true;
                        i += 2;
                        continue;
                    }
                    if text[i..].chars().next().is_some_and(is_whitespace)
                        || b"){;}?:[](+/".contains(&c)
                    {
                        break;
                    }
                    if c == b'.'
                        && !(i > 0
                            && byte(&text, i - 1).is_ascii_digit()
                            && byte(&text, i + 1).is_ascii_digit())
                    {
                        break;
                    }
                    if c == b'-' && i > start {
                        break;
                    }
                    if c == b'*' || c == b'#' {
                        if non_prefix {
                            break;
                        }
                    } else if c == b'%' && !text[i..range.end].starts_with("%(") {
                        if i > start {
                            break;
                        }
                    } else {
                        non_prefix = true;
                    }
                    if self
                        .grammar
                        .match_start(&text[..range.end], i, longest)
                        .is_some()
                        || comparison_len(&text, i).is_some()
                    {
                        break;
                    }
                    i = next_char(&text, i);
                }
                if i > start {
                    self.push(TokenKind::Raw, start..i, budget)?;
                } else {
                    i = next_char(&text, i);
                }
            }
            budget.stats.lexed_bytes += if text[start..].starts_with("%[") {
                3
            } else {
                i - start
            };
        }
        if let Some(error) = closing_error {
            return Err(error);
        }
        if let Some((opening, _, bytes)) = stack.last() {
            return Err(Diagnostic::new(
                DiagnosticCode::UnclosedDelimiter,
                format!("Unclosed \"{opening}\""),
                self.view.span(bytes.clone()),
            ));
        }
        Ok(begin..self.tokens.len())
    }
}
fn comparison_len(text: &str, i: usize) -> Option<usize> {
    if ["==", "!=", ">=", "<=", "~=", "<>"]
        .iter()
        .any(|op| text[i..].starts_with(op))
    {
        Some(2)
    } else if b"=<>".contains(&byte(text, i)) {
        Some(1)
    } else {
        None
    }
}
fn operator_len(text: &str, i: usize, end: usize) -> Option<usize> {
    let remaining = &text[i..end];
    if ["++", "--", "+=", "-=", "*=", "/=", "%="]
        .iter()
        .any(|op| remaining.starts_with(op))
    {
        return Some(2);
    }
    let c = byte(text, i);
    let next = byte(text, i + 1);
    let alpha = next.is_ascii_alphabetic() || next == b'_';
    if c == b'/'
        || (c == b'+' && !alpha)
        || (c == b'-' && i + 1 < end && next != b'>' && !alpha)
        || ((c == b'%' || c == b'*')
            && i + 1 < end
            && next != b'('
            && !alpha
            && next != b'#'
            && next != b'*')
        || (c == b'#' && i + 1 < end && next != b'(' && !alpha && next != b'#')
    {
        return Some(1);
    }
    comparison_len(text, i)
}

/// Unescapes the structural punctuation accepted by the DEFAULT lexer.
pub fn unescape_literal(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if byte(text, i) == b'\\' && i + 1 < text.len() && escapable(byte(text, i + 1)) {
            i += 1;
        }
        let end = next_char(text, i);
        result.push_str(&text[i..end]);
        i = end;
    }
    result
}
