//! Native counterpart of the term-compiled blacklist rule.
//!
//! The TypeScript evaluator accepts any `RegExp`; this API deliberately accepts
//! only patterns produced here. The application callers compile their terms.
use std::collections::HashMap;

use regex::bytes::{Regex, RegexBuilder};

use crate::utils::{
    js_compat::is_whitespace,
    js_regexp_unicode::{canonicalize, is_letter_or_number},
    js_string::JsString,
    moderation::normalize::{escape_reg_exp, fold_text},
};

/// Native representation of `Pick<IModerationRule, 'terms'>`. The evaluator
/// does not read this field; callers need no MongoDB types for this operation.
#[derive(Clone, Debug, Default)]
pub struct BlacklistRule {
    pub terms: Vec<JsString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlacklistEvaluationResult {
    pub triggered: bool,
    pub matched_text: Option<JsString>,
}

/// Offsets are UTF-16 indices into the exact string supplied to `exec`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlacklistMatch {
    pub start: usize,
    pub end: usize,
    pub matched_text: JsString,
}

#[derive(Clone, Debug, Default)]
struct Node {
    literal: HashMap<u32, usize>,
    whitespace: Option<usize>,
    terminal_rank: Option<usize>,
}

/// A compiled, stateless `/iu` pattern; this is not a general JS RegExp.
#[derive(Clone, Debug)]
pub struct BlacklistPattern {
    source: JsString,
    nodes: Vec<Node>,
    ascii_regex: Option<AsciiPattern>,
}

#[derive(Clone, Debug)]
struct AsciiPattern {
    bounded: Regex,
    prefilter: Option<Regex>,
}

// The input and all terms are ASCII on this path. A consuming non-word byte
// represents each lookaround; the capture excludes those boundary bytes.
// Placing the right boundary after the alternation lets the engine retry a
// later term when an earlier term fails its right boundary.
fn compile_ascii_regex(terms: &[JsString]) -> Option<AsciiPattern> {
    let mut body = String::new();
    for (rank, term) in terms.iter().enumerate() {
        let term = term.as_str().filter(|term| term.is_ascii())?;
        if rank != 0 {
            body.push('|');
        }
        let mut literal_start = 0;
        let bytes = term.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                body.push_str(&regex::escape(&term[literal_start..i]));
                body.push_str(r"[ \t\n\r\x0B\x0C]+");
                i += 1;
                while i < bytes.len()
                    && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
                {
                    i += 1;
                }
                literal_start = i;
            } else {
                i += 1;
            }
        }
        body.push_str(&regex::escape(&term[literal_start..]));
    }
    let build = |pattern: &str| {
        RegexBuilder::new(pattern)
            .unicode(false)
            .case_insensitive(true)
            .build()
            .ok()
    };
    let bounded = build(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<matched>{body})(?:$|[^A-Za-z0-9])"
    ))?;
    // Omitting boundaries can only add candidate matches. If compiling this
    // optional filter fails, the bounded expression remains authoritative.
    let prefilter = build(&format!(r"(?:{body})"));
    Some(AsciiPattern { bounded, prefilter })
}

fn whitespace(cp: u32) -> bool {
    char::from_u32(cp).is_some_and(is_whitespace)
}

// Lone surrogates remain distinct code points; valid pairs are decoded once.
fn decode(units: &[u16], i: usize) -> (u32, usize) {
    let first = units[i];
    if (0xd800..=0xdbff).contains(&first) && i + 1 < units.len() {
        let second = units[i + 1];
        if (0xdc00..=0xdfff).contains(&second) {
            return (
                0x10000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00),
                2,
            );
        }
    }
    (u32::from(first), 1)
}

fn word(cp: u32) -> bool {
    // Unicode-property escapes under /iu are tested after simple folding.
    is_letter_or_number(canonicalize(cp))
}

impl BlacklistPattern {
    /// `RegExp.prototype.source`, preserving even unpaired UTF-16 units.
    pub fn source(&self) -> &JsString {
        &self.source
    }

    pub fn flags(&self) -> &'static str {
        "iu"
    }

    /// Execute on the supplied text without folding it. This matches `RegExp.exec`;
    /// the evaluator separately applies `fold_text`, as does the TypeScript.
    pub fn exec(&self, text: &JsString) -> Option<BlacklistMatch> {
        if let (Some(regex), Some(input)) = (&self.ascii_regex, text.as_str())
            && input.is_ascii()
        {
            // A missing term cannot satisfy the boundary expression. Reject
            // it without asking the engine to compute capture positions.
            if let Some(prefilter) = &regex.prefilter
                && !prefilter.is_match(input.as_bytes())
            {
                return None;
            }
            let captures = regex.bounded.captures(input.as_bytes())?;
            let matched = captures.name("matched")?;
            return Some(BlacklistMatch {
                start: matched.start(),
                end: matched.end(),
                matched_text: JsString::from(&input[matched.start()..matched.end()]),
            });
        }
        let units = text.units();
        let mut start = 0;
        let mut previous_word = false;
        while start < units.len() {
            let (first, width) = decode(&units, start);
            if !previous_word {
                let mut node = 0;
                let mut pos = start;
                let mut best: Option<(usize, usize)> = None;
                while pos < units.len() {
                    let (cp, len) = decode(&units, pos);
                    let next = if whitespace(cp) {
                        self.nodes[node].whitespace.inspect(|_| {
                            pos += len;
                            while pos < units.len() {
                                let (following, width) = decode(&units, pos);
                                if !whitespace(following) {
                                    break;
                                }
                                pos += width;
                            }
                        })
                    } else {
                        self.nodes[node]
                            .literal
                            .get(&canonicalize(cp))
                            .copied()
                            .inspect(|_| {
                                pos += len;
                            })
                    };
                    let Some(next) = next else { break };
                    node = next;
                    if let Some(rank) = self.nodes[node].terminal_rank {
                        let boundary = pos == units.len() || !word(decode(&units, pos).0);
                        if boundary && best.is_none_or(|(best_rank, _)| rank < best_rank) {
                            best = Some((rank, pos));
                        }
                    }
                }
                if let Some((_, end)) = best {
                    return Some(BlacklistMatch {
                        start,
                        end,
                        matched_text: JsString::from_units(units[start..end].to_vec()),
                    });
                }
            }
            previous_word = word(first);
            start += width;
        }
        None
    }
}

/// Fold, trim, stably sort by descending UTF-16 length, and compile terms.
pub fn compile_blacklist_pattern(terms: Option<&[JsString]>) -> Option<BlacklistPattern> {
    let mut folded: Vec<JsString> = terms
        .unwrap_or_default()
        .iter()
        .map(|term| fold_text(Some(term)).trim())
        .filter(|term| !term.is_empty())
        .collect();
    folded.sort_by_key(|term| std::cmp::Reverse(term.len()));
    if folded.is_empty() {
        return None;
    }

    // A regex build can fail on resource limits; the trie remains authoritative.
    let ascii_regex = compile_ascii_regex(&folded);
    let mut source: Vec<u16> = r"(?<![\p{L}\p{N}])(?:".encode_utf16().collect();
    let mut nodes = vec![Node::default()];
    for (rank, term) in folded.iter().enumerate() {
        if rank != 0 {
            source.push(b'|' as u16);
        }
        // Build the exact escaped source, then replace each whitespace run.
        let escaped = escape_reg_exp(term);
        let escaped_units = escaped.units();
        let mut i = 0;
        while i < escaped_units.len() {
            let (cp, width) = decode(&escaped_units, i);
            if whitespace(cp) {
                source.extend(r"\s+".encode_utf16());
                i += width;
                while i < escaped_units.len() {
                    let (cp, width) = decode(&escaped_units, i);
                    if !whitespace(cp) {
                        break;
                    }
                    i += width;
                }
            } else {
                // RegExp.source serializes literal slashes with a backslash.
                if cp == u32::from(b'/') {
                    source.push(b'\\' as u16);
                }
                source.extend_from_slice(&escaped_units[i..i + width]);
                i += width;
            }
        }

        let units = term.units();
        let mut i = 0;
        let mut node = 0;
        while i < units.len() {
            let (cp, width) = decode(&units, i);
            if whitespace(cp) {
                i += width;
                while i < units.len() {
                    let (cp, width) = decode(&units, i);
                    if !whitespace(cp) {
                        break;
                    }
                    i += width;
                }
                let next = match nodes[node].whitespace {
                    Some(next) => next,
                    None => {
                        let next = nodes.len();
                        nodes.push(Node::default());
                        nodes[node].whitespace = Some(next);
                        next
                    }
                };
                node = next;
            } else {
                i += width;
                let key = canonicalize(cp);
                let next = match nodes[node].literal.get(&key).copied() {
                    Some(next) => next,
                    None => {
                        let next = nodes.len();
                        nodes.push(Node::default());
                        nodes[node].literal.insert(key, next);
                        next
                    }
                };
                node = next;
            }
        }
        if nodes[node].terminal_rank.is_none() {
            nodes[node].terminal_rank = Some(rank);
        }
    }
    source.extend(r")(?![\p{L}\p{N}])".encode_utf16());
    Some(BlacklistPattern {
        source: JsString::from_units(source),
        nodes,
        ascii_regex,
    })
}

/// `None` text represents null or undefined at the typed string boundary.
pub fn evaluate_blacklist_rule(
    _rule: &BlacklistRule,
    text: Option<&JsString>,
    pattern: Option<&BlacklistPattern>,
) -> BlacklistEvaluationResult {
    let matched = pattern.and_then(|pattern| pattern.exec(&fold_text(text)));
    BlacklistEvaluationResult {
        triggered: matched.is_some(),
        matched_text: matched.map(|matched| matched.matched_text),
    }
}
