//! Regex patterns and the match list of a blocked-word rule (reference
//! `utils/moderation/advanced.ts`: `ModerationPattern`, `compilePattern`,
//! `findBlacklistMatches`, `paidModeration` and the constants).
//!
//! `advanced.ts` is not in the plan's file inventory, but the moderation handler calls
//! `findBlacklistMatches` on every message of a blocked-word rule and its verdict depends on it,
//! so its matching half is ported here. `parseAdvancedRule` (the save-time validation of
//! patterns and contextual policies) belongs with the settings service; the per-pattern check
//! it needs is [`dima_commands::patterns::validate_user_pattern`].
//!
//! Every user pattern is compiled through `dima_commands::patterns` (bounded size, linear-time
//! matching), once per rule configuration ([`super::engine::CompiledSettings`]).
//!
//! Positions: [`ModerationMatch::start`] and [`ModerationMatch::end`] are stored in
//! `moderation_decisions.matches` and shown in the dashboard, so they are UTF-16 units of the
//! original message, end exclusive (the contract the reference has).

use dima_commands::patterns::{
    Boundary, CompiledAlternation, CompiledPattern, PatternError, PatternMatch,
};
use serde::{Deserialize, Serialize};

use super::blacklist::BlacklistPattern;
use super::normalize::fold_text;

/// `MODERATION_RETENTION_DAYS`.
pub const MODERATION_RETENTION_DAYS: i64 = 180;
/// `MODERATION_VISIBLE_DAYS`.
pub const MODERATION_VISIBLE_DAYS: i64 = 30;
/// `SEMANTIC_MODEL`.
pub const SEMANTIC_MODEL: &str = "respan/span-01-lite";
/// `DECISION_POLICY_VERSION`.
pub const DECISION_POLICY_VERSION: &str = "contextual-v2";
/// `SEMANTIC_DEADLINE_MS`: how long after a message arrives its semantic review may decide.
pub const SEMANTIC_DEADLINE_MS: i64 = 4_000;
/// `ALLOW_THRESHOLD`.
pub const ALLOW_THRESHOLD: f64 = 0.1;

/// `paidModeration`: regex, variations and contextual review need a paid plan.
pub fn paid_moderation(tier: Option<&str>) -> bool {
    matches!(tier, Some("premium" | "pro"))
}

/// A stored regex pattern of a blocked-word rule (`ModerationPattern`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModerationPattern {
    /// `id`.
    pub id: String,
    /// `source`, RE2 syntax as the streamer wrote it.
    pub source: String,
    /// `boundary`: `whole_word` or `anywhere`.
    pub boundary: String,
    /// `ignoreCase`.
    #[serde(rename = "ignoreCase")]
    pub ignore_case: bool,
}

impl ModerationPattern {
    /// `compilePattern`'s boundary test: only the exact text `whole_word` wraps the source.
    pub fn boundary(&self) -> Boundary {
        if self.boundary == "whole_word" {
            Boundary::WholeWord
        } else {
            Boundary::Anywhere
        }
    }

    /// `compilePattern`.
    pub fn compile(&self) -> Result<CompiledPattern, PatternError> {
        CompiledPattern::new(&self.source, self.boundary(), self.ignore_case)
    }
}

/// One entry of `moderation_decisions.matches` (`ModerationMatch`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModerationMatch {
    /// `literal`, a pattern's id, or the combined variation pattern's `auto-all-...` id.
    #[serde(rename = "matcherID")]
    pub matcher_id: String,
    /// The matched text of the original message.
    pub text: String,
    /// UTF-16 offset of the first unit.
    pub start: usize,
    /// UTF-16 offset after the last unit.
    pub end: usize,
}

/// A compiled pattern of a rule, in the order `findBlacklistMatches` runs them.
#[derive(Debug, Clone)]
pub enum Matcher {
    /// A stored pattern.
    Pattern {
        /// Its id.
        id: String,
        /// Compiled once.
        compiled: CompiledPattern,
    },
    /// The combined variation pattern (`rulePatterns`' last entry).
    Variations {
        /// `auto-all-` and the first 24 hex digits of the SHA-256 of its source.
        id: String,
        /// Compiled in bounded chunks.
        compiled: CompiledAlternation,
    },
}

impl Matcher {
    fn id(&self) -> &str {
        match self {
            Self::Pattern { id, .. } | Self::Variations { id, .. } => id,
        }
    }

    fn find<'t>(&self, text: &'t str) -> Option<PatternMatch<'t>> {
        match self {
            Self::Pattern { compiled, .. } => compiled.find(text),
            Self::Variations { compiled, .. } => compiled.find(text),
        }
    }
}

/// One character of the per-character fold: where its folded text starts, and where the
/// character is in the original message (bytes).
struct FoldedChar {
    folded_start: usize,
    start: usize,
    end: usize,
}

/// `findBlacklistMatches`' folding: each character folded on its own, with the map back.
fn fold_by_character(text: &str) -> (String, Vec<FoldedChar>) {
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    let mut buffer = [0_u8; 4];
    for (start, ch) in text.char_indices() {
        let end = start + ch.len_utf8();
        let piece = fold_text(ch.encode_utf8(&mut buffer));
        if piece.is_empty() {
            continue;
        }
        map.push(FoldedChar {
            folded_start: folded.len(),
            start,
            end,
        });
        folded.push_str(&piece);
    }
    (folded, map)
}

/// The original character whose folded text holds folded byte `at`.
fn source_of(map: &[FoldedChar], at: usize) -> Option<&FoldedChar> {
    let index = map.partition_point(|entry| entry.folded_start <= at);
    index.checked_sub(1).and_then(|index| map.get(index))
}

/// `findBlacklistMatches`: the literal terms' first match (on the per-character fold, reported
/// in the original text), then each pattern's first match, in order.
pub fn find_blacklist_matches(
    text: &str,
    literal: Option<&BlacklistPattern>,
    matchers: &[Matcher],
) -> Vec<ModerationMatch> {
    let mut matches = Vec::new();
    if let Some(literal) = literal {
        let (folded, map) = fold_by_character(text);
        if let Some(range) = literal.find(&folded) {
            let start = source_of(&map, range.start).map_or(0, |entry| entry.start);
            let end = range
                .end
                .checked_sub(1)
                .and_then(|last| source_of(&map, last))
                .map_or(start, |entry| entry.end);
            matches.push(ModerationMatch {
                matcher_id: "literal".to_owned(),
                text: text.get(start..end).unwrap_or_default().to_owned(),
                start: dima_text::utf16_offset(text, start),
                end: dima_text::utf16_offset(text, end),
            });
        }
    }
    for matcher in matchers {
        let Some(found) = matcher.find(text) else {
            continue;
        };
        let range = found.utf16_range(text);
        matches.push(ModerationMatch {
            matcher_id: matcher.id().to_owned(),
            text: found.text.to_owned(),
            start: range.start,
            end: range.end,
        });
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(source: &str, boundary: &str, ignore_case: bool) -> Matcher {
        let stored = ModerationPattern {
            id: "p".into(),
            source: source.into(),
            boundary: boundary.into(),
            ignore_case,
        };
        Matcher::Pattern {
            id: stored.id.clone(),
            compiled: stored.compile().unwrap(),
        }
    }

    fn literal(terms: &[&str]) -> Option<BlacklistPattern> {
        BlacklistPattern::compile(terms.iter().map(|t| Some(*t))).unwrap()
    }

    // Reference: advanced.test.ts.
    #[test]
    fn nickname_variants() {
        let regex = [pattern("r+i+(?:n+i+)*n+", "whole_word", true)];
        for text in [
            "Rin",
            "Rinn",
            "Riiin",
            "Rinnnnn",
            "riiiniiinnnnn",
            "Don't call her Rinn",
            "Yeah, Rinn is losing the game",
        ] {
            assert!(
                !find_blacklist_matches(text, None, &regex).is_empty(),
                "{text}"
            );
        }
        for text in ["bring", "string", "árinn", "Rinn7", "水Rinn"] {
            assert!(
                find_blacklist_matches(text, None, &regex).is_empty(),
                "{text}"
            );
        }
        let found = &find_blacklist_matches("🎉 Rinn!", None, &regex)[0];
        assert_eq!(
            (found.text.as_str(), found.start, found.end),
            ("Rinn", 3, 7)
        );
    }

    #[test]
    fn literal_accent_folding_preserves_original_spans() {
        let regex = [pattern("f(?:u|a)?ck(?:ing|y)?", "whole_word", true)];
        for text in ["fuck", "fucky", "fcky", "facky", "fucking"] {
            assert!(
                !find_blacklist_matches(text, None, &regex).is_empty(),
                "{text}"
            );
        }
        assert!(find_blacklist_matches("the classic", literal(&["ass"]).as_ref(), &[]).is_empty());
        assert_eq!(
            find_blacklist_matches("🎉 CAFÉ scam", literal(&["cafe"]).as_ref(), &[]),
            [ModerationMatch {
                matcher_id: "literal".into(),
                text: "CAFÉ".into(),
                start: 3,
                end: 7
            }]
        );
        // A decomposed accent: the mark folds to nothing and the span still ends after it.
        let found = find_blacklist_matches("CAFE\u{301}!", literal(&["cafe"]).as_ref(), &[]);
        assert_eq!((found[0].text.as_str(), found[0].end), ("CAFE", 4));
        assert!(
            find_blacklist_matches("freexmoney", literal(&["free.money"]).as_ref(), &[]).is_empty()
        );
    }

    #[test]
    fn anywhere_and_case() {
        let exact = [pattern("Rinn", "anywhere", false)];
        assert!(find_blacklist_matches("rinn", None, &exact).is_empty());
        assert_eq!(find_blacklist_matches("aRinnb", None, &exact).len(), 1);
        assert!(!paid_moderation(Some("free")) && !paid_moderation(None));
        assert!(paid_moderation(Some("premium")) && paid_moderation(Some("pro")));
    }

    #[test]
    fn adversarial_nested_repetition_is_linear() {
        let started = std::time::Instant::now();
        let text = format!("{}!", "a".repeat(500));
        assert!(
            find_blacklist_matches(&text, None, &[pattern("(a+)+$", "whole_word", true)])
                .is_empty()
        );
        assert!(started.elapsed().as_millis() < 500);
    }
}
