//! The Unicode classes the rules test one character at a time (`/\p{L}/u.test(char)` and
//! friends), read once from the `regex` crate's own tables so that the per-character tests and
//! the patterns compiled with `regex` agree on what a letter is.
//!
//! Version: the `regex` crate carries Unicode 16; the reference runs on Node 24.22, whose V8 uses
//! Unicode 17. Only characters added in Unicode 17 are classified differently (they are no letter
//! here); see the package report.

use std::sync::OnceLock;

use regex_syntax::hir::{Class, HirKind};

/// A set of characters as sorted, disjoint inclusive ranges.
#[derive(Debug, Default)]
pub(crate) struct CharClass {
    ranges: Vec<(char, char)>,
}

impl CharClass {
    fn parse(pattern: &str) -> Self {
        let ranges = regex_syntax::ParserBuilder::new()
            .build()
            .parse(pattern)
            .ok()
            .and_then(|hir| match hir.kind() {
                HirKind::Class(Class::Unicode(class)) => Some(
                    class
                        .ranges()
                        .iter()
                        .map(|range| (range.start(), range.end()))
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default();
        Self { ranges }
    }

    pub(crate) fn contains(&self, ch: char) -> bool {
        self.ranges
            .binary_search_by(|&(start, end)| {
                if end < ch {
                    std::cmp::Ordering::Less
                } else if start > ch {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }
}

macro_rules! class {
    ($name:ident, $pattern:literal) => {
        pub(crate) fn $name(ch: char) -> bool {
            static CLASS: OnceLock<CharClass> = OnceLock::new();
            CLASS
                .get_or_init(|| CharClass::parse($pattern))
                .contains(ch)
        }
    };
}

class!(is_letter, r"\p{L}");
class!(is_uppercase_letter, r"\p{Lu}");
class!(is_mark, r"\p{M}");

/// The class JavaScript's `\s` matches, written for the `regex` crate (its own `\s` is Unicode
/// `White_Space`, which adds U+0085 and drops U+FEFF).
pub(crate) const JS_SPACE_CLASS: &str =
    r"[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
/// Its complement (`\S`, `[^\s]`).
pub(crate) const JS_NON_SPACE_CLASS: &str =
    r"[^\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_match_the_regex_tables() {
        for ch in ['a', 'Z', 'é', 'ñ', 'Ω', 'ς', 'ق', '水', 'ǅ', '𐐨'] {
            assert!(is_letter(ch), "{ch}");
        }
        for ch in ['1', ' ', '!', '😀', '\u{301}'] {
            assert!(!is_letter(ch), "{ch}");
        }
        assert!(is_uppercase_letter('É') && is_uppercase_letter('𐐀') && !is_uppercase_letter('ǅ'));
        assert!(is_mark('\u{301}') && is_mark('\u{64b}') && !is_mark('a'));
        let space = regex::Regex::new(&format!("^{JS_SPACE_CLASS}$")).unwrap();
        for ch in (0..=0x10ffff_u32).filter_map(char::from_u32) {
            assert_eq!(
                space.is_match(&ch.to_string()),
                dima_text::is_js_whitespace(ch),
                "{ch:?}"
            );
        }
    }
}
