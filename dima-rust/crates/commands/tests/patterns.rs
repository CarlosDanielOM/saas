//! RE2 patterns on the `regex` crate.
//!
//! 1. `fixtures/re2_parity_cases.rs`: 109 cases recorded from the `re2` package by
//!    `fixtures/re2_parity.mjs`. Every one must match as recorded (offsets in UTF-16 units).
//! 2. [`RULES`]: cases written from RE2's documented syntax and parser limits, NOT recorded
//!    (the `re2` addon is not installed anywhere on this machine and cannot be built offline).
//!    They cover the constructs this translation adds over the old one; re-record them with the
//!    generator when `re2` is available.
//! 3. Hostile patterns and texts: bounded compile size and time, linear matching.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use dima_commands::patterns::{self, Boundary, CompiledPattern, MAX_SOURCE_BYTES, PatternError};
use serde_json::Value;

enum Expected {
    Match(usize, usize),
    NoMatch,
    Error,
}

/// `(source, ignore_case, text, whole_word, expected UTF-16 range)`.
const CORPUS: &[(&str, bool, &str, bool, Expected)] = include!("fixtures/re2_parity_cases.rs");

fn outcome(source: &str, ignore_case: bool, text: &str, whole_word: bool) -> String {
    let boundary = if whole_word {
        Boundary::WholeWord
    } else {
        Boundary::Anywhere
    };
    match CompiledPattern::new(source, boundary, ignore_case) {
        Err(_) => "error".into(),
        Ok(pattern) => {
            // The corpus records RE2's own match, empty or not: read the regex directly.
            let found = if whole_word {
                pattern
                    .regex()
                    .captures(text)
                    .and_then(|captures| captures.get(2))
            } else {
                pattern.regex().find(text)
            };
            match found {
                None => "no match".into(),
                Some(found) => format!(
                    "{}..{}",
                    dima_text::utf16_offset(text, found.start()),
                    dima_text::utf16_offset(text, found.end())
                ),
            }
        }
    }
}

fn expected(expected: &Expected) -> String {
    match expected {
        Expected::Match(start, end) => format!("{start}..{end}"),
        Expected::NoMatch => "no match".into(),
        Expected::Error => "error".into(),
    }
}

#[test]
fn matches_the_recorded_re2_corpus() {
    let mismatches: Vec<String> = CORPUS
        .iter()
        .filter_map(|(source, ignore_case, text, whole_word, wanted)| {
            let actual = outcome(source, *ignore_case, text, *whole_word);
            let wanted = expected(wanted);
            (actual != wanted).then(|| {
                format!(
                    "{source:?} on {text:?}: re2 {wanted}, rust {actual} ({:?})",
                    patterns::translate(source)
                )
            })
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    assert_eq!(CORPUS.len(), 109);
}

/// Named groups as the `re2` package (1.27.0) treats them, from the recording made by
/// `fixtures/re2_parity.mjs` in the reference image: names become numbered groups; RE2's name
/// rules apply and a name used twice is refused.
#[test]
fn named_groups_follow_the_recording() {
    let recording: Value =
        serde_json::from_str(include_str!("fixtures/re2_parity_cases.json")).unwrap();
    let mut checked = 0;
    let mut mismatches = Vec::new();
    for case in recording["cases"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        if !source.contains("(?P<") && !source.contains("(?<") {
            continue;
        }
        let text = case["text"].as_str().unwrap();
        let ignore_case = case["ignoreCase"].as_bool().unwrap();
        let whole_word = case["wholeWord"].as_bool().unwrap();
        let wanted = match &case["expected"] {
            Value::Null => "no match".to_owned(),
            Value::Array(range) => format!("{}..{}", range[0], range[1]),
            _ => "error".to_owned(),
        };
        let actual = outcome(source, ignore_case, text, whole_word);
        checked += 1;
        if actual != wanted {
            mismatches.push(format!(
                "{source:?} on {text:?}: re2 {wanted}, rust {actual}"
            ));
        }
    }
    assert!(checked > 300, "{checked}");
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// From RE2's syntax (`re2/syntax.txt`) and parser (`re2/parse.cc`); not recorded.
const RULES: &[(&str, bool, &str, Expected)] = &[
    // Repetition counts: at most 1000, and nested counts multiply to at most 1000.
    ("a{1000}", false, "a", Expected::NoMatch),
    ("a{1001}", false, "a", Expected::Error),
    ("a{2,1001}", false, "a", Expected::Error),
    ("a{1001,}", false, "a", Expected::Error),
    ("(?:a{2}){500}", false, "a", Expected::NoMatch),
    ("(?:a{2}){501}", false, "a", Expected::Error),
    ("((a{10}){10}){10}", false, "a", Expected::NoMatch),
    ("((a{10}){10}){11}", false, "a", Expected::Error),
    ("(a{10}|b{200}){5}", false, "b", Expected::NoMatch),
    ("(a{10}|b{200}){6}", false, "b", Expected::Error),
    ("(a{1000}){0,1}", false, "b", Expected::Match(0, 0)),
    ("(?:a{1000})*", false, "b", Expected::Match(0, 0)),
    ("x{0}y", false, "y", Expected::Match(0, 1)),
    // Flags: i m s U only; repeated flags allowed; RE2's no-op `(?)`.
    ("(?x)a b", false, "ab", Expected::Error),
    ("(?u)a", false, "a", Expected::Error),
    ("(?R)a", false, "a", Expected::Error),
    ("(?ii)a", false, "A", Expected::Match(0, 1)),
    ("(?i-i)a", false, "A", Expected::NoMatch),
    ("(?-i)a", true, "A", Expected::NoMatch),
    ("(?)a", false, "a", Expected::Match(0, 1)),
    ("(?-)a", false, "a", Expected::Error),
    ("(?i-)a", false, "a", Expected::Error),
    ("(?i-:a)", false, "a", Expected::Error),
    ("(?--i)a", false, "a", Expected::Error),
    ("(?sm:^.$)", false, "x\n\ny", Expected::Match(0, 1)),
    ("(?s:a.b)", false, "a\nb", Expected::Match(0, 3)),
    ("(?m)^b", false, "a\nb", Expected::Match(2, 3)),
    ("(?U)a+", false, "aaa", Expected::Match(0, 1)),
    ("(?#comment)a", false, "a", Expected::Error),
    ("(?P=n)", false, "a", Expected::Error),
    // \Q...\E literal text.
    (r"\Qa.b\E", false, "axb a.b", Expected::Match(4, 7)),
    (r"\Q(*)", false, "(*)", Expected::Match(0, 3)),
    (r"\Qa\E+", false, "aaa", Expected::Match(0, 3)),
    (r"[\Q]", false, "Q", Expected::Error),
    (r"a\E", false, "a", Expected::Error),
    // Octal escapes.
    (r"\012", false, "a\nb", Expected::Match(1, 2)),
    (r"\101", false, "A", Expected::Match(0, 1)),
    (r"\0", false, "\0", Expected::Match(0, 1)),
    (r"[\060-\071]+", false, "x42", Expected::Match(1, 3)),
    (r"\1", false, "a", Expected::Error),
    (r"(a)\18", false, "a", Expected::Error),
    (r"\8", false, "8", Expected::Error),
    // Property names as RE2 spells them.
    (r"\p{Greek}+", false, "aαβ", Expected::Match(1, 3)),
    (r"\p{^Greek}", false, "αa", Expected::Match(1, 2)),
    (r"\PL", false, "a1", Expected::Match(1, 2)),
    (r"\p{greek}", false, "α", Expected::Error),
    (r"\p{sc=Greek}", false, "α", Expected::Error),
    (r"\pl", false, "a", Expected::Error),
    (r"\p{L u}", false, "A", Expected::Error),
    // Escapes RE2 does not have.
    (r"\U0001F600", false, "😀", Expected::Error),
    (r"\C", false, "a", Expected::Error),
    (r"\Z", false, "a", Expected::Error),
    // `{` that is not a count is a literal: `\b{start}` is a boundary and text in RE2.
    (r"\b{start}", false, "a{start}", Expected::Match(1, 8)),
    (r"\B{start}", false, "a{start}", Expected::NoMatch),
    (r"\P{^Greek}+", false, "aαβ", Expected::Match(1, 3)),
    (r"[\p{^L}]+", false, "ab12", Expected::Match(2, 4)),
    // Classes: POSIX items copied whole, set operators literal after them.
    ("[[:digit:]a&&b]+", false, "x&&9", Expected::Match(1, 4)),
    ("[[:^alpha:]]+", false, "ab12", Expected::Match(2, 4)),
    ("[^]a]+", false, "]ab", Expected::Match(2, 3)),
    ("[a-]+", false, "x-a", Expected::Match(1, 3)),
    // Emoji, combining marks, right-to-left text and astral characters.
    ("😀+", true, "a😀😀b", Expected::Match(1, 5)),
    ("e\u{301}", false, "cafe\u{301}", Expected::Match(3, 5)),
    ("é", false, "cafe\u{301}", Expected::NoMatch),
    ("مرحبا", false, "قال مرحبا!", Expected::Match(4, 9)),
    ("\u{200f}", false, "a\u{200f}b", Expected::Match(1, 2)),
    ("𐐀", true, "𐐨", Expected::Match(0, 2)),
    (".", false, "𐐀", Expected::Match(0, 2)),
    (r"\w", false, "𐐀a", Expected::Match(2, 3)),
    (r"\p{L}", false, "😀𐐀", Expected::Match(2, 4)),
];

#[test]
fn follows_re2_rules_the_old_translation_lacked() {
    let mismatches: Vec<String> = RULES
        .iter()
        .filter_map(|(source, ignore_case, text, wanted)| {
            let actual = outcome(source, *ignore_case, text, false);
            let wanted = expected(wanted);
            (actual != wanted).then(|| {
                format!(
                    "{source:?} on {text:?}: rule {wanted}, rust {actual} ({:?})",
                    patterns::translate(source)
                )
            })
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

/// `advanced.test.ts`/`variations.test.ts` behaviour that lives in this module.
#[test]
fn saving_refuses_empty_matches_and_unsupported_constructs() {
    assert_eq!(
        patterns::validate_user_pattern("a*", true),
        Err(PatternError::MatchesEmpty)
    );
    assert_eq!(
        patterns::validate_user_pattern("(?:)", true),
        Err(PatternError::MatchesEmpty)
    );
    assert_eq!(patterns::validate_user_pattern(r"\b", true), Ok(()));
    assert!(matches!(
        patterns::validate_user_pattern(r"(a)\1", true),
        Err(PatternError::Unsupported(_))
    ));
    assert!(matches!(
        patterns::validate_user_pattern("a(?=b)", true),
        Err(PatternError::Unsupported(_))
    ));
    assert!(matches!(
        patterns::validate_user_pattern("(?<=a)b", true),
        Err(PatternError::Unsupported(_))
    ));
    assert_eq!(
        patterns::validate_user_pattern("(", true),
        Err(PatternError::Invalid)
    );
    assert_eq!(patterns::validate_user_pattern("spam+", true), Ok(()));
}

#[test]
fn whole_word_matches_report_the_word_in_utf16_and_skip_empty_matches() {
    let text = "😀 no spam here";
    let pattern = CompiledPattern::new("spam", Boundary::WholeWord, true).unwrap();
    let found = pattern.find(text).unwrap();
    assert_eq!(found.text, "spam");
    assert_eq!(found.utf16_range(text), 6..10);
    assert_eq!(found.range, 8..12);
    assert!(pattern.find("spammer").is_none());
    // A leading guard character is not part of the match.
    assert_eq!(
        pattern.find("é SPAM é").unwrap().utf16_range("é SPAM é"),
        2..6
    );
    // `\b` passes saving, then matches empty at 0: the reference skips the pattern.
    let boundary = CompiledPattern::new(r"\b", Boundary::Anywhere, true).unwrap();
    assert!(boundary.find("hi there").is_none());
    let anywhere = CompiledPattern::new("s+p", Boundary::Anywhere, false).unwrap();
    assert_eq!(anywhere.find("𐐀sssp").unwrap().utf16_range("𐐀sssp"), 2..6);
}

fn elapsed_under(started: Instant, limit: Duration) {
    assert!(started.elapsed() < limit, "took {:?}", started.elapsed());
}

#[test]
fn hostile_patterns_are_bounded() {
    let started = Instant::now();
    // Longer than the source limit: refused before any parsing.
    assert_eq!(
        patterns::translate(&"a".repeat(MAX_SOURCE_BYTES + 1)),
        Err(PatternError::TooLong)
    );
    // Nested repetition that would compile to millions of states.
    assert!(patterns::compile("((a{100}){100}){100}", false).is_err());
    assert!(patterns::compile("(((((a{9}){9}){9}){9}){9})", false).is_err());
    // Large but legal per RE2: refused by the size limit, not compiled without bound.
    assert_eq!(
        patterns::compile(r"\p{L}{1000}", true).unwrap_err(),
        PatternError::TooLarge
    );
    assert_eq!(
        patterns::compile(
            &"(".repeat(300)
                .chars()
                .chain(")".repeat(300).chars())
                .collect::<String>(),
            false
        )
        .unwrap_err(),
        PatternError::TooLarge
    );
    // Catastrophic for a backtracking engine, linear here.
    let evil = CompiledPattern::new("(x+x+)+y", Boundary::WholeWord, true).unwrap();
    assert!(evil.find(&"x".repeat(100_000)).is_none());
    let nested = CompiledPattern::new("(((a*)*)*)*b", Boundary::Anywhere, false).unwrap();
    assert!(nested.find(&"a".repeat(100_000)).is_none());
    let alternation = CompiledPattern::new("(a|a)*c", Boundary::Anywhere, false).unwrap();
    assert!(alternation.find(&"a".repeat(100_000)).is_none());
    elapsed_under(started, Duration::from_secs(60));
}

/// One rule's combined variation pattern (`rulePatterns`): 200 terms, each a stretched
/// spelling alternation with symbol classes, in one whole-word alternation.
#[test]
fn a_full_rule_of_generated_variations_compiles_and_matches_quickly() {
    let terms: Vec<String> = (0..200)
        .map(|index| {
            let word: String = format!("term{index:03}x")
                .chars()
                .map(|ch| match ch {
                    'e' => "[e3]+".to_owned(),
                    't' => "[t7+]+".to_owned(),
                    other => format!("{other}+"),
                })
                .collect();
            format!("(?:(?:{word})|(?:{word}(?:\\s*s)?))")
        })
        .collect();
    let source = format!("(?:{})", terms.join("|"));
    assert!(source.len() < MAX_SOURCE_BYTES);
    let started = Instant::now();
    let pattern = CompiledPattern::new(&source, Boundary::WholeWord, true).unwrap();
    elapsed_under(started, Duration::from_secs(20));
    let started = Instant::now();
    let message = "hello there T3RM042X and friends ".repeat(15);
    for _ in 0..100 {
        assert_eq!(pattern.find(&message).unwrap().text, "T3RM042X");
    }
    elapsed_under(started, Duration::from_secs(20));
}
