//! Namespace families: the anchored JavaScript regular expressions the reference passes to
//! `io.of(regex)`, for the subset those patterns use, matched with exactly the JavaScript
//! meaning.
//!
//! A pattern is written as the JavaScript source between the slashes, for example
//! `^\/overlays\/duel\/[0-9]{1,30}$`. Accepted syntax: `^` first and `$` last (both required);
//! literal ASCII characters and escaped punctuation (`\/`, `\-`, `\.`…); the classes `\w`
//! (`[A-Za-z0-9_]`), `\d` (`[0-9]`) and bracket classes of literals, ranges and those two escapes
//! (`[\w-]`, `[a-f0-9]`); quantifiers `+`, `*`, `?`, `{n}`, `{n,}` and `{n,m}`. Anything else
//! (alternation, groups, `.`, negated classes, flags, non-ASCII) is refused when the namespace is
//! declared, so a pattern can never mean something else here than in JavaScript.
//!
//! JavaScript without the `u` flag reads `\w` and `\d` as ASCII only and `$` as the end of the
//! input (no line terminator before it), which is what the compiled form says explicitly: it is
//! matched by the `regex` crate in linear time, with Unicode classes off and `\A…\z` anchors.

use regex::{Regex, RegexBuilder};
use std::fmt;

/// Why a pattern was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("namespace pattern {pattern:?} refused: {reason}")]
pub struct PatternError {
    /// The pattern as given.
    pub pattern: String,
    /// What is not supported.
    pub reason: &'static str,
}

/// A namespace family: the names an anchored JavaScript pattern accepts.
#[derive(Clone)]
pub struct Pattern {
    source: String,
    regex: Regex,
}

impl fmt::Debug for Pattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "/{}/", self.source)
    }
}

/// One element of a bracket class.
const WORD: &str = "0-9A-Za-z_";
const DIGIT: &str = "0-9";

impl Pattern {
    /// Parses the JavaScript source of an anchored pattern (without the slashes).
    pub fn new(source: &str) -> Result<Self, PatternError> {
        let refuse = |reason| PatternError {
            pattern: source.to_owned(),
            reason,
        };
        if !source.is_ascii() {
            return Err(refuse("only ASCII patterns are supported"));
        }
        let body = source
            .strip_prefix('^')
            .and_then(|rest| rest.strip_suffix('$'))
            .ok_or_else(|| refuse("the pattern must start with ^ and end with $"))?;
        if body.ends_with('\\') {
            return Err(refuse("a trailing backslash escapes the closing $"));
        }
        let mut out = String::from(r"\A(?:");
        let bytes = body.as_bytes();
        let mut at = 0;
        let mut last_was_atom = false;
        while let Some(&byte) = bytes.get(at) {
            match byte {
                b'\\' => {
                    let escaped = *bytes.get(at + 1).ok_or_else(|| refuse("dangling escape"))?;
                    match escaped {
                        b'w' => out.push_str(&format!("[{WORD}]")),
                        b'd' => out.push_str(&format!("[{DIGIT}]")),
                        b if b.is_ascii_punctuation() => push_literal(&mut out, b),
                        _ => return Err(refuse("unsupported escape")),
                    }
                    at += 2;
                    last_was_atom = true;
                }
                b'[' => {
                    let close = (at + 1..bytes.len())
                        .find(|&i| bytes.get(i) == Some(&b']') && bytes.get(i - 1) != Some(&b'\\'))
                        .ok_or_else(|| refuse("unclosed class"))?;
                    out.push_str(
                        &class(bytes.get(at + 1..close).unwrap_or_default()).ok_or_else(|| {
                            refuse("unsupported class (literals, ranges, \\w and \\d only)")
                        })?,
                    );
                    at = close + 1;
                    last_was_atom = true;
                }
                b'+' | b'*' | b'?' => {
                    if !last_was_atom {
                        return Err(refuse("a quantifier must follow an atom"));
                    }
                    out.push(char::from(byte));
                    at += 1;
                    last_was_atom = false;
                }
                b'{' => {
                    if !last_was_atom {
                        return Err(refuse("a quantifier must follow an atom"));
                    }
                    let close = (at + 1..bytes.len())
                        .find(|&i| bytes.get(i) == Some(&b'}'))
                        .ok_or_else(|| refuse("unclosed quantifier"))?;
                    let inner = body.get(at + 1..close).unwrap_or_default();
                    out.push_str(&counted(inner).ok_or_else(|| refuse("bad {m,n} quantifier"))?);
                    at = close + 1;
                    last_was_atom = false;
                }
                b'.' | b'(' | b')' | b'|' | b'^' | b'$' | b']' | b'}' => {
                    return Err(refuse("unsupported regular expression syntax"));
                }
                b if b.is_ascii_graphic() => {
                    push_literal(&mut out, b);
                    at += 1;
                    last_was_atom = true;
                }
                _ => return Err(refuse("control characters and spaces are not supported")),
            }
        }
        out.push_str(r")\z");
        let regex = RegexBuilder::new(&out)
            .unicode(false)
            .build()
            .map_err(|_| refuse("the compiled pattern was refused"))?;
        Ok(Self {
            source: source.to_owned(),
            regex,
        })
    }

    /// Whether `name` is in the family (`regex.test(name)` in the reference).
    pub fn matches(&self, name: &str) -> bool {
        self.regex.is_match(name)
    }

    /// The JavaScript source.
    pub fn source(&self) -> &str {
        &self.source
    }
}

fn push_literal(out: &mut String, byte: u8) {
    out.push_str(&regex::escape(&char::from(byte).to_string()));
}

/// A bracket class body: literals, `a-z` ranges, `\w`, `\d` and escaped punctuation.
fn class(body: &[u8]) -> Option<String> {
    if body.is_empty() || body.first() == Some(&b'^') {
        return None;
    }
    let mut out = String::from("[");
    let mut at = 0;
    while let Some(&byte) = body.get(at) {
        let (low, width) = match byte {
            b'\\' => match body.get(at + 1)? {
                b'w' => {
                    out.push_str(WORD);
                    at += 2;
                    continue;
                }
                b'd' => {
                    out.push_str(DIGIT);
                    at += 2;
                    continue;
                }
                b if b.is_ascii_punctuation() => (*b, 2),
                _ => return None,
            },
            b if b.is_ascii_graphic() => (b, 1),
            _ => return None,
        };
        // A range `a-z` (a `-` first, last, or next to a class escape is a literal, as in JS).
        if body.get(at + width) == Some(&b'-')
            && let Some(&high) = body.get(at + width + 1)
            && high != b'\\'
            && high != b']'
        {
            if high < low {
                return None;
            }
            out.push_str(&format!("\\x{low:02X}-\\x{high:02X}"));
            at += width + 2;
        } else {
            out.push_str(&format!("\\x{low:02X}"));
            at += width;
        }
    }
    out.push(']');
    Some(out)
}

/// `{n}`, `{n,}` or `{n,m}` with n ≤ m ≤ 1000.
fn counted(inner: &str) -> Option<String> {
    let number = |text: &str| -> Option<u32> {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
            .filter(|n| *n <= 1000)
    };
    match inner.split_once(',') {
        None => number(inner).map(|n| format!("{{{n}}}")),
        Some((low, "")) => number(low).map(|n| format!("{{{n},}}")),
        Some((low, high)) => {
            let (low, high) = (number(low)?, number(high)?);
            (low <= high).then(|| format!("{{{low},{high}}}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(source: &str) -> Pattern {
        match Pattern::new(source) {
            Ok(pattern) => pattern,
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn the_reference_families() {
        let clip = pattern(r"^\/clip\/\w+$");
        for name in ["/clip/123", "/clip/abc_DEF_9", "/clip/_"] {
            assert!(clip.matches(name), "{name}");
        }
        for name in [
            "/clip/",
            "/clip/12-3",
            "/clip/123/",
            "/clip/123\n",
            "/clip/é",
            "/clip/１２３",
            "/clip/12 3",
            "clip/123",
            "/Clip/123",
            "/clip/123/x",
            "x/clip/123",
            "/clip/\u{212A}",
        ] {
            assert!(!clip.matches(name), "{name:?}");
        }
        let analytics = pattern(r"^\/site\/analytics\/[\w-]+$");
        assert!(analytics.matches("/site/analytics/live-channels"));
        assert!(analytics.matches("/site/analytics/-"));
        assert!(!analytics.matches("/site/analytics/live.channels"));
        let preview = pattern(r"^\/speech-preview\/\d+$");
        assert!(preview.matches("/speech-preview/0042"));
        assert!(!preview.matches("/speech-preview/42a"));
        assert!(!preview.matches("/speech-preview/٤٢"));
        let duel = pattern(r"^\/overlays\/duel\/[0-9]{1,30}$");
        assert!(duel.matches(&format!("/overlays/duel/{}", "9".repeat(30))));
        assert!(!duel.matches(&format!("/overlays/duel/{}", "9".repeat(31))));
        assert!(!duel.matches("/overlays/duel/"));
        let studio = pattern(r"^\/overlay-studio\/[a-f0-9]{48}$");
        assert!(studio.matches(&format!("/overlay-studio/{}", "a1".repeat(24))));
        assert!(!studio.matches(&format!("/overlay-studio/{}", "A1".repeat(24))));
        assert!(!studio.matches(&format!("/overlay-studio/{}", "a1".repeat(25))));
        let roulette = pattern(r"^\/overlays\/roulette\/[\w-]+$");
        assert!(roulette.matches("/overlays/roulette/abc-123_x"));
        for source in [
            r"^\/dashboard\/\w+$",
            r"^\/overlays\/triggers\/\w+$",
            r"^\/speech\/\w+$",
            r"^\/overlays\/widgets\/[\w-]+$",
            r"^\/overlays\/dimafx\/\w+$",
        ] {
            assert!(Pattern::new(source).is_ok(), "{source}");
        }
    }

    #[test]
    fn other_quantifiers_and_classes() {
        let p = pattern(r"^\/a\/[a-c]?x*y{2}z{1,}$");
        assert!(p.matches("/a/yyz"));
        assert!(p.matches("/a/bxxxyyzzz"));
        assert!(!p.matches("/a/dyyz"));
        assert!(!p.matches("/a/yz"));
        let dash = pattern(r"^\/[-a]+$");
        assert!(dash.matches("/-a-"));
        let trailing = pattern(r"^\/[a-]+$");
        assert!(trailing.matches("/a-"));
        let escaped = pattern(r"^\/[\-\]]+$");
        assert!(escaped.matches("/-]"));
    }

    #[test]
    fn unsupported_syntax_is_refused() {
        for source in [
            r"\/clip\/\w+$",
            r"^\/clip\/\w+",
            r"^\/clip\/.+$",
            r"^\/(a|b)$",
            r"^\/[^a]$",
            r"^\/\s+$",
            r"^\/é$",
            r"^+$",
            r"^\/a{2,1}$",
            r"^\/a{x}$",
            r"^\/[z-a]$",
            r"^\/a b$",
            r"^\/a\$",
        ] {
            assert!(Pattern::new(source).is_err(), "{source}");
        }
    }
}
