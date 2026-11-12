//! RE2 patterns on the `regex` crate.
//!
//! 1. `fixtures/re2_parity_cases.json`: every case recorded from the reference's `re2` package
//!    (1.27.0 on Node 24, in the reference image) by `fixtures/re2_parity.mjs`: the cases of the
//!    earlier recording, the ones first written from RE2's documentation, and a wide grid. Every
//!    one must come out as recorded (offsets in UTF-16 units), except the intended differences
//!    listed in [`INTENDED`], each with its reason.
//! 2. Hostile patterns and texts: bounded compile size and time, linear matching.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use dima_commands::patterns::{self, Boundary, CompiledPattern, MAX_SOURCE_BYTES, PatternError};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Recording {
    re2: String,
    cases: Vec<Case>,
    validation: Vec<Validation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    source: String,
    ignore_case: bool,
    text: String,
    whole_word: bool,
    /// `[start, end]` in UTF-16 units, `null` for no match, `"error"` when RE2 refused it.
    expected: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Validation {
    source: String,
    ignore_case: bool,
    /// `new RE2(source, flags).test('')`: `"ok"`, `"empty"` or `"error"`.
    result: String,
}

static RECORDING: LazyLock<Recording> =
    LazyLock::new(|| serde_json::from_str(include_str!("fixtures/re2_parity_cases.json")).unwrap());

const MISPLACED: &str = "the re2 package expands this property into ranges where RE2 then reads them in \
     another context (with brackets inside a class, bare inside \\Q...\\E, joined to a range), \
     giving it a meaning the author cannot have intended";

/// Sources RE2 accepts and this crate refuses on purpose, with the reason.
const INTENDED: &[(&str, &str)] = &[
    (
        r"\C",
        "one byte: a match can end inside a character, which no UTF-8 text can hold",
    ),
    (r"[[:alpha:]\p{Emoji}]+", MISPLACED),
    (r"[]\p{Emoji}]+", MISPLACED),
    (r"\Q[\E\p{Emoji}", MISPLACED),
    (r"\Q\p{Emoji}\E", MISPLACED),
    (r"[\p{Emoji}-z]", MISPLACED),
    (
        r"\p{scx=Sidt}",
        "Sidetic is new in Unicode 17; the regex crate's tables are Unicode 16",
    ),
];

/// Cases where both engines find an empty match at a different place, with the reason.
const INTENDED_EMPTY: &[(&str, &str, &str)] = &[(
    r"\B",
    "a٣b _a_",
    "RE2 tests \\B between the two bytes of ٣; a &str search never stops inside a \
     character. Only ever an empty match, which the reference discards",
)];

fn intended(source: &str) -> bool {
    INTENDED.iter().any(|(intended, _)| source == *intended)
}

fn intended_empty(source: &str, text: &str) -> bool {
    INTENDED_EMPTY
        .iter()
        .any(|(intended, intended_text, _)| source == *intended && text == *intended_text)
}

fn recorded(expected: &Value) -> String {
    match expected {
        Value::Null => "no match".into(),
        Value::String(text) if text == "error" => "error".into(),
        Value::Array(range) => format!("{}..{}", range[0], range[1]),
        other => panic!("unexpected recorded value {other}"),
    }
}

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

#[test]
fn matches_every_recorded_re2_case() {
    let recording = &*RECORDING;
    assert_eq!(recording.re2, "1.27.0");
    let mut mismatches = Vec::new();
    let mut differences = 0;
    for case in &recording.cases {
        let actual = outcome(&case.source, case.ignore_case, &case.text, case.whole_word);
        let wanted = recorded(&case.expected);
        if intended(&case.source) {
            // RE2 accepts it; this crate refuses it on purpose.
            assert_ne!(
                wanted, "error",
                "{:?} is no longer accepted by RE2",
                case.source
            );
            assert_eq!(actual, "error", "{:?} must stay refused", case.source);
            differences += 1;
            continue;
        }
        if intended_empty(&case.source, &case.text) {
            let empty = |range: &str| range.split_once("..").is_some_and(|(a, b)| a == b);
            assert!(
                empty(&wanted) && empty(&actual) && wanted != actual,
                "{:?}",
                case.source
            );
            differences += 1;
            continue;
        }
        if actual != wanted {
            mismatches.push(format!(
                "{:?} (i={}, whole word={}) on {:?}: re2 {wanted}, rust {actual} ({:?})",
                case.source,
                case.ignore_case,
                case.whole_word,
                case.text,
                patterns::translate(&case.source)
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} cases differ:\n{}",
        mismatches.len(),
        recording.cases.len(),
        mismatches.join("\n")
    );
    assert!(recording.cases.len() > 4_000, "{}", recording.cases.len());
    assert!(differences > 0);
}

/// What saving checks first: the pattern compiles and does not match an empty message.
#[test]
fn validates_every_recorded_pattern_as_re2_does() {
    let mut mismatches = Vec::new();
    for case in &RECORDING.validation {
        if intended(&case.source) {
            continue;
        }
        let actual = match patterns::validate_user_pattern(&case.source, case.ignore_case) {
            Ok(()) => "ok",
            Err(PatternError::MatchesEmpty) => "empty",
            Err(_) => "error",
        };
        if actual != case.result {
            mismatches.push(format!(
                "{:?} (i={}): re2 {}, rust {actual}",
                case.source, case.ignore_case, case.result
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} differ:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn every_intended_difference_is_recorded() {
    let sources: HashSet<&str> = RECORDING
        .cases
        .iter()
        .map(|case| case.source.as_str())
        .collect();
    for (source, reason) in INTENDED {
        assert!(sources.contains(source), "{source}: {reason}");
    }
    for (source, text, reason) in INTENDED_EMPTY {
        assert!(
            RECORDING
                .cases
                .iter()
                .any(|case| case.source == *source && case.text == *text),
            "{source}: {reason}"
        );
    }
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
