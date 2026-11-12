//! The literal blacklist (reference `utils/moderation/rules/blacklist.rule.ts`).
//!
//! The reference compiles the folded terms into one JavaScript expression,
//! `(?<![\p{L}\p{N}])(?:t1|t2|...)(?![\p{L}\p{N}])` with flags `iu`, the terms sorted longest
//! first. The `regex` crate has no lookaround, so the same search is written as
//! `(?:^|[^\p{L}\p{N}])(t1|t2|...)(?:$|[^\p{L}\p{N}])`, case-insensitive, and group 1 is the
//! term. Its leftmost-first match is the reference's first match: a guard character before the
//! term only moves the start of the whole match back by that one character, so matches keep
//! their order; at the start of the text `^` comes before a guard, as the reference tries the
//! earlier position first; and alternatives and the greedy `\s+` are tried in the same order a
//! backtracking engine tries them. Only the first match is ever used.
//!
//! Case-insensitivity: JavaScript's `iu` and the `regex` crate both match by Unicode simple case
//! folding (`σ`/`ς`/`Σ`, `k`/`K`/Kelvin sign). Text and terms are already folded.

use std::ops::Range;

use regex::{Regex, RegexBuilder};

use super::normalize::fold_text;
use super::unicode::JS_SPACE_CLASS;

/// The largest compiled literal blacklist, in bytes. The settings service allows 200 terms of
/// 100 characters (`MAX_BLACKLIST_TERMS`); that worst case compiles to well under this (see
/// `tests/cost.rs`).
pub const BLACKLIST_SIZE_LIMIT: usize = 32 * 1024 * 1024;

/// A rule's terms compiled once (`compileBlacklistPattern`). `Send + Sync`.
#[derive(Debug, Clone)]
pub struct BlacklistPattern {
    regex: Regex,
}

/// Why a term list could not be compiled. The reference never fails here; only a list far
/// beyond what the settings service accepts reaches the size limit.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("blocked-word list is too large to compile")]
pub struct BlacklistTooLarge;

/// `evaluateBlacklistRule`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlacklistResult {
    /// A term was found.
    pub triggered: bool,
    /// The matched folded text.
    pub matched_text: Option<String>,
}

/// The folded, trimmed, non-empty terms in the reference's order: longest first by UTF-16 length
/// (`b.length - a.length`), ties in list order (a stable sort). The order decides which term a
/// match reports, so it is the reference's (identity row of the text rules: harmless to keep).
pub fn folded_terms<'a>(terms: impl IntoIterator<Item = Option<&'a str>>) -> Vec<String> {
    let mut folded: Vec<String> = terms
        .into_iter()
        .map(|term| dima_text::trim(&fold_text(term.unwrap_or_default())).to_owned())
        .filter(|term| !term.is_empty())
        .collect();
    folded.sort_by_key(|term| std::cmp::Reverse(dima_text::utf16_len(term)));
    folded
}

/// One term as `regex` source: literal text, each run of JavaScript whitespace as `\s+`.
fn push_term(out: &mut String, term: &str) {
    let mut literal = String::new();
    let mut in_space = false;
    for ch in term.chars() {
        if dima_text::is_js_whitespace(ch) {
            if !in_space {
                out.push_str(&regex::escape(&literal));
                literal.clear();
                out.push_str(JS_SPACE_CLASS);
                out.push('+');
                in_space = true;
            }
        } else {
            literal.push(ch);
            in_space = false;
        }
    }
    out.push_str(&regex::escape(&literal));
}

impl BlacklistPattern {
    /// `compileBlacklistPattern`: `None` when no term is left after folding and trimming.
    pub fn compile<'a>(
        terms: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Result<Option<Self>, BlacklistTooLarge> {
        let folded = folded_terms(terms);
        if folded.is_empty() {
            return Ok(None);
        }
        let mut source = String::from(r"(?:^|[^\p{L}\p{N}])(");
        for (index, term) in folded.iter().enumerate() {
            if index > 0 {
                source.push('|');
            }
            push_term(&mut source, term);
        }
        source.push_str(r")(?:$|[^\p{L}\p{N}])");
        RegexBuilder::new(&source)
            .case_insensitive(true)
            .size_limit(BLACKLIST_SIZE_LIMIT)
            .dfa_size_limit(dima_commands::patterns::DFA_SIZE_LIMIT)
            .build()
            .map(|regex| Some(Self { regex }))
            .map_err(|_| BlacklistTooLarge)
    }

    /// The byte range of the first term found in `folded` (text already folded).
    pub fn find(&self, folded: &str) -> Option<Range<usize>> {
        self.regex
            .captures(folded)
            .and_then(|captures| captures.get(1))
            .map(|found| found.range())
    }
}

/// `evaluateBlacklistRule`: folds the message and searches it.
pub fn evaluate_blacklist(pattern: Option<&BlacklistPattern>, text: &str) -> BlacklistResult {
    let Some(pattern) = pattern else {
        return BlacklistResult {
            triggered: false,
            matched_text: None,
        };
    };
    let folded = fold_text(text);
    let matched_text = pattern
        .find(&folded)
        .and_then(|range| folded.get(range).map(str::to_owned));
    BlacklistResult {
        triggered: matched_text.is_some(),
        matched_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(terms: &[&str]) -> Option<BlacklistPattern> {
        BlacklistPattern::compile(terms.iter().map(|t| Some(*t))).unwrap()
    }

    fn hit(terms: &[&str], text: &str) -> bool {
        evaluate_blacklist(compile(terms).as_ref(), text).triggered
    }

    // Reference: rules/emote_spam_blacklist.rule.test.ts.
    #[test]
    fn whole_word_match_is_case_insensitive() {
        assert!(hit(&["badword"], "you said a BADWORD there"));
    }

    #[test]
    fn does_not_match_inside_longer_words() {
        assert!(!hit(&["ass"], "that is a classic move"));
        assert!(hit(&["ass"], "you are an ass"));
    }

    #[test]
    fn accent_folding_works_both_ways() {
        assert!(hit(&["café"], "meet at the cafe"));
        assert!(hit(&["cafe"], "meet at the CAFÉ"));
    }

    #[test]
    fn multi_word_phrases_match_with_flexible_whitespace() {
        assert!(hit(&["buy followers now"], "BUY  FOLLOWERS   NOW cheap"));
        assert!(!hit(&["buy followers now"], "buy followers tomorrow"));
    }

    #[test]
    fn empty_term_list_never_triggers_and_compiles_to_none() {
        assert!(compile(&[]).is_none());
        assert!(compile(&["  ", ""]).is_none());
        assert!(BlacklistPattern::compile([None]).unwrap().is_none());
        assert!(!evaluate_blacklist(None, "anything").triggered);
    }

    #[test]
    fn regex_special_characters_in_terms_are_escaped() {
        assert!(hit(&["free.money"], "get free.money here"));
        assert!(!hit(&["free.money"], "get freexmoney here"));
        assert!(hit(&["c++"], "i like c++ a lot"));
    }

    #[test]
    fn unicode_whole_word_boundaries() {
        assert!(hit(&["ñoño"], "di Nono"));
        assert!(!hit(&["ñoño"], "añonimo"));
        assert!(hit(&["кошка"], "это КОШКА!"));
        assert!(!hit(&["кошка"], "кошкам"));
        assert!(hit(&["pizza"], "🍕pizza🍕"));
        assert!(!hit(&["pizza"], "pizza٣"));
    }

    #[test]
    fn longer_terms_win_at_the_same_position() {
        let pattern = compile(&["bad", "bad word"]).unwrap();
        assert_eq!(
            evaluate_blacklist(Some(&pattern), "a bad word")
                .matched_text
                .as_deref(),
            Some("bad word")
        );
        let folded = folded_terms(["ab", "😀a", "abc"].map(Some));
        // UTF-16 lengths 2, 3, 3: the stable sort keeps "😀a" before "abc".
        assert_eq!(folded, ["😀a", "abc", "ab"]);
    }

    #[test]
    fn final_sigma_matches_either_form() {
        assert!(hit(&["οδος"], "ΟΔΟΣ"));
        assert!(hit(
            &["\u{3bf}\u{3b4}\u{3bf}\u{3c3}"],
            "\u{3bf}\u{3b4}\u{3bf}\u{3c2}"
        ));
    }
}
