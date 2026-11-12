//! The `re2` package's rewrite of JavaScript syntax (`translateRegExp` in its `lib/pattern.cc`),
//! which runs on every pattern before RE2 parses it.
//!
//! It works on the raw text, without parsing it, so it rewrites inside `\Q...\E` too and keeps
//! its own naive idea of being inside a class (`[` opens one, `]` closes it, escapes skipped):
//!
//! - `\cA`..`\cZ` become `\x01`..`\x1A` (lower-case letters are left to RE2, which refuses them);
//! - `\u` with one to four hex digits becomes `\x{...}` (a lone surrogate never matches UTF-8
//!   text); `\u{` becomes `\x{`;
//! - `\p{...}`: `Script_Extensions=` / `scx=` names and binary properties (`Emoji`, `Alphabetic`,
//!   `ASCII`, ...) are expanded by the package into code-point ranges; `General_Category=` /
//!   `gc=`, `Script=` / `sc=` prefixes are removed and long category names shortened, and the rest
//!   is left to RE2;
//! - `/` becomes `\/`; `(?<name>` becomes `(?P<name>`.
//!
//! An expansion is kept as one [`Tok::Expansion`] (with the package's view of whether it was
//! inside a class), so the second phase can emit the same set in `regex` syntax.

use super::re2_names::{JS_BINARY_PROPERTIES, JS_LONG_CATEGORIES, JS_SCRIPT_EXTENSIONS};

/// A set the package expands into ranges itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PropertySet {
    /// A binary property (`Emoji`).
    Binary(&'static str),
    /// A script-extension set (`scx=Greek`).
    ScriptExtension(&'static str),
}

/// `\p{...}` or `\P{...}` expanded by the package.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Expansion {
    pub(super) set: PropertySet,
    /// `\P`: the package writes the complement ranges.
    pub(super) negated: bool,
    /// Written with its own brackets (`[...]`), because the package believed it was outside a
    /// class; bare ranges otherwise.
    pub(super) bracketed: bool,
}

/// One unit of the RE2 pattern the package hands over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tok {
    Char(char),
    Expansion(Expansion),
    /// Not text: the edge between two components of a combined rule.
    Boundary,
}

/// The rewrite, with the state that carries from one piece of a combined pattern to the next.
#[derive(Debug, Default)]
pub(super) struct Rewriter {
    in_class: bool,
}

/// A `\p{` whose `}` lies beyond the piece: the package would read the name across pieces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OpenPropertyName;

fn strip<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    // `stripPrefix` requires something after the prefix.
    name.strip_prefix(prefix).filter(|rest| !rest.is_empty())
}

fn lookup(table: &'static [&'static str], name: &str) -> Option<&'static str> {
    table.iter().copied().find(|entry| *entry == name)
}

fn push_str(out: &mut Vec<Tok>, text: &str) {
    out.extend(text.chars().map(Tok::Char));
}

fn hex_digit(value: u32) -> char {
    char::from_digit(value & 15, 16).map_or('0', |digit| digit.to_ascii_uppercase())
}

impl Rewriter {
    /// Rewrites a whole pattern as `new RE2(source)` receives it.
    pub(super) fn whole(source: &str) -> Vec<Tok> {
        let mut out = Vec::with_capacity(source.len() + 8);
        if source.is_empty() {
            push_str(&mut out, "(?:)");
            return out;
        }
        // A whole pattern has nothing after it, so an open name is just text.
        let _ = Self::default().piece(source, &mut out);
        out
    }

    /// Rewrites one piece of a longer pattern, continuing the state of the previous piece.
    pub(super) fn piece(
        &mut self,
        source: &str,
        out: &mut Vec<Tok>,
    ) -> Result<(), OpenPropertyName> {
        let chars: Vec<char> = source.chars().collect();
        let at = |index: usize| chars.get(index).copied();
        let mut open = Ok(());
        let mut i = 0;
        while let Some(ch) = at(i) {
            if ch == '\\'
                && let Some(next) = at(i + 1)
            {
                match next {
                    '\\' => {
                        push_str(out, r"\\");
                        i += 2;
                    }
                    'c' => match at(i + 2) {
                        Some(letter) if letter.is_ascii_uppercase() => {
                            let code = u32::from(letter) - u32::from('@');
                            push_str(out, r"\x");
                            out.push(Tok::Char(hex_digit(code / 16)));
                            out.push(Tok::Char(hex_digit(code)));
                            i += 3;
                        }
                        _ => {
                            push_str(out, r"\c");
                            i += 2;
                        }
                    },
                    'u' => match at(i + 2) {
                        Some(first) if first.is_ascii_hexdigit() => {
                            push_str(out, r"\x{");
                            out.push(Tok::Char(first));
                            i += 3;
                            for _ in 0..3 {
                                match at(i) {
                                    Some(digit) if digit.is_ascii_hexdigit() => {
                                        out.push(Tok::Char(digit));
                                        i += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push(Tok::Char('}'));
                        }
                        Some('{') => {
                            push_str(out, r"\x");
                            i += 2;
                        }
                        _ => {
                            push_str(out, r"\u");
                            i += 2;
                        }
                    },
                    'p' | 'P' => {
                        let close = (at(i + 2) == Some('{'))
                            .then(|| (i + 3..chars.len()).find(|index| at(*index) == Some('}')))
                            .flatten();
                        match close {
                            Some(close) => {
                                let name: String = chars.iter().take(close).skip(i + 3).collect();
                                self.property(&name, next == 'P', out);
                                i = close + 1;
                            }
                            None => {
                                if at(i + 2) == Some('{') {
                                    open = Err(OpenPropertyName);
                                }
                                out.push(Tok::Char('\\'));
                                out.push(Tok::Char(next));
                                i += 2;
                            }
                        }
                    }
                    other => {
                        out.push(Tok::Char('\\'));
                        out.push(Tok::Char(other));
                        i += 2;
                    }
                }
                continue;
            }
            if ch == '/' {
                push_str(out, r"\/");
                i += 1;
                continue;
            }
            if ch == '('
                && at(i + 1) == Some('?')
                && at(i + 2) == Some('<')
                && !matches!(at(i + 3), Some('=' | '!'))
            {
                push_str(out, "(?P<");
                i += 3;
                continue;
            }
            if ch == '[' && !self.in_class {
                self.in_class = true;
            } else if ch == ']' && self.in_class {
                self.in_class = false;
            }
            out.push(Tok::Char(ch));
            i += 1;
        }
        open
    }

    /// `\p{name}` / `\P{name}` with its `}` found.
    fn property(&self, name: &str, negated: bool, out: &mut Vec<Tok>) {
        let expansion = |set| {
            Tok::Expansion(Expansion {
                set,
                negated,
                bracketed: !self.in_class,
            })
        };
        if let Some(found) = strip(name, "Script_Extensions=")
            .or_else(|| strip(name, "scx="))
            .and_then(|rest| lookup(JS_SCRIPT_EXTENSIONS, rest))
        {
            out.push(expansion(PropertySet::ScriptExtension(found)));
            return;
        }
        let name = strip(name, "General_Category=")
            .or_else(|| strip(name, "gc="))
            .unwrap_or(name);
        if let Some(found) = lookup(JS_BINARY_PROPERTIES, name) {
            out.push(expansion(PropertySet::Binary(found)));
            return;
        }
        let name = JS_LONG_CATEGORIES
            .iter()
            .find(|(long, _)| *long == name)
            .map(|(_, short)| *short)
            .or_else(|| strip(name, "Script=").or_else(|| strip(name, "sc=")))
            .unwrap_or(name);
        out.push(Tok::Char('\\'));
        out.push(Tok::Char(if negated { 'P' } else { 'p' }));
        // The package compares the length in bytes.
        if name.len() == 1 {
            push_str(out, name);
        } else {
            out.push(Tok::Char('{'));
            push_str(out, name);
            out.push(Tok::Char('}'));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(source: &str) -> String {
        Rewriter::whole(source)
            .into_iter()
            .map(|tok| match tok {
                Tok::Char(ch) => ch.to_string(),
                Tok::Expansion(expansion) => format!("<{expansion:?}>"),
                Tok::Boundary => "|".into(),
            })
            .collect()
    }

    #[test]
    fn rewrites_as_the_package_does() {
        assert_eq!(text(""), "(?:)");
        assert_eq!(text(r"\cJ\ca\c"), r"\x0A\ca\c");
        assert_eq!(
            text("\\u00e9\\u004\\u{1F600}\\uZ\\u"),
            r"\x{00e9}\x{004}\x{1F600}\uZ\u"
        );
        assert_eq!(text("\\u00411"), r"\x{0041}1");
        assert_eq!(text("a/b"), r"a\/b");
        assert_eq!(text("(?<n>a)(?<=b)(?<!c)"), "(?P<n>a)(?<=b)(?<!c)");
        assert_eq!(
            text(r"\p{Script=Greek}\P{sc=Latin}\p{gc=Lu}"),
            r"\p{Greek}\P{Latin}\p{Lu}"
        );
        assert_eq!(
            text(r"\p{Letter}\p{Uppercase_Letter}\p{L}\p{^L}"),
            r"\pL\p{Lu}\pL\p{^L}"
        );
        assert_eq!(text(r"\p{L"), r"\p{L");
        assert!(text(r"\p{Emoji}[\P{scx=Greek}]").starts_with("<Expansion { set: Binary(\"Emoji\"), negated: false, bracketed: true }>[<Expansion { set: ScriptExtension(\"Greek\"), negated: true, bracketed: false }>"));
        // The naive class state: `]` right after `[` closes it for the package.
        assert!(text(r"[]\p{Emoji}]").contains("bracketed: true"));
    }

    #[test]
    fn a_piece_reports_a_property_name_left_open() {
        let mut out = Vec::new();
        assert_eq!(
            Rewriter::default().piece(r"\Q\p{L", &mut out),
            Err(OpenPropertyName)
        );
        assert_eq!(Rewriter::default().piece(r"\p{L}", &mut out), Ok(()));
    }
}
