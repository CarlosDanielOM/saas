//! RE2-compatible user patterns on the `regex` crate, for ports of the
//! moderation helpers that compile streamer-authored patterns with node `re2`
//! (`dimabot/src/utils/moderation/advanced.ts` and `variations.ts`).
//!
//! Both engines guarantee linear-time matching and reject lookaround and
//! backreferences. The differences this module bridges:
//!
//! - RE2's `\d`, `\w`, `\s`, and `\b` are ASCII-only; the `regex` crate's are
//!   Unicode. [`translate`] rewrites them to ASCII forms, inside and outside
//!   character classes.
//! - A `[` inside a JavaScript class is a literal; in `regex` it opens a nested
//!   class. [`translate`] escapes it (POSIX `[:name:]` items are kept).
//! - `regex` reports UTF-8 byte offsets; JavaScript and node `re2` report
//!   UTF-16 offsets. Use [`utf16_offset`] when an offset leaves Rust.
//!
//! Parity with node `re2` was checked against a shared corpus during
//! development; keep [`translate`] the single place for further syntax fixes.

use regex::{Regex, RegexBuilder};

/// ASCII class bodies RE2 uses for the Perl classes.
const DIGIT: &str = "0-9";
const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = r"\t\n\x0C\r ";

/// Error for a pattern that cannot be compiled or matches the empty string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternError {
    Invalid(String),
    MatchesEmpty,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(reason) => write!(formatter, "invalid or unsupported regex: {reason}"),
            Self::MatchesEmpty => formatter.write_str("regex must not match an empty message"),
        }
    }
}

impl std::error::Error for PatternError {}

/// Rewrites RE2/JavaScript pattern syntax into equivalent `regex` syntax.
///
/// Fails for stacked quantifiers such as `a**` or `a*+`, which RE2 rejects
/// but the `regex` crate would accept as nested repetition.
pub fn translate(source: &str) -> Result<String, PatternError> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() + 16);
    let mut in_class = false;
    // Index right after `[` or `[^`, where `]` is a literal in RE2.
    let mut class_body_start = usize::MAX;
    let mut quantifier = Quantifier::None;
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        index += 1;
        if !in_class {
            quantifier = match (ch, quantifier) {
                ('?', Quantifier::Greedy) => Quantifier::Lazy,
                ('*' | '+' | '?', Quantifier::None) => Quantifier::Greedy,
                ('*' | '+' | '?', _) => return Err(stacked_quantifier()),
                ('{', previous) if is_repetition(&chars[index..]) => {
                    if previous != Quantifier::None {
                        return Err(stacked_quantifier());
                    }
                    // Copy `{n}`, `{n,}`, or `{n,m}` whole so its digits and
                    // `}` do not reset the quantifier state.
                    out.push('{');
                    while let Some(&inner) = chars.get(index) {
                        index += 1;
                        out.push(inner);
                        if inner == '}' {
                            break;
                        }
                    }
                    quantifier = Quantifier::Greedy;
                    continue;
                }
                _ => Quantifier::None,
            };
        }
        match ch {
            '\\' => {
                let Some(&next) = chars.get(index) else {
                    out.push('\\');
                    break;
                };
                index += 1;
                match next {
                    // `\cJ` is a control character in RE2/JavaScript only.
                    'c' if chars.get(index).is_some_and(char::is_ascii_alphabetic) => {
                        let control = (chars[index] as u32) & 0x1f;
                        index += 1;
                        out.push_str(&format!("\\x{{{control:02x}}}"));
                    }
                    '0' if !chars.get(index).is_some_and(char::is_ascii_digit) => {
                        out.push_str(r"\x00");
                    }
                    // `\p{L}`, `\u{1F600}`, `\x{41}`: the braces belong to the escape.
                    'p' | 'P' | 'u' | 'x' if chars.get(index) == Some(&'{') => {
                        out.push('\\');
                        out.push(next);
                        while let Some(&inner) = chars.get(index) {
                            index += 1;
                            out.push(inner);
                            if inner == '}' {
                                break;
                            }
                        }
                    }
                    _ => out.push_str(&translate_escape(next, in_class)),
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                if chars.get(index) == Some(&'^') {
                    index += 1;
                    out.push('^');
                }
                class_body_start = index;
            }
            '[' if chars.get(index) == Some(&':') => {
                // POSIX class like `[:alpha:]`, supported by both engines.
                out.push('[');
            }
            '[' => out.push_str(r"\["),
            ']' if in_class && index - 1 == class_body_start => out.push_str(r"\]"),
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            // `&&`, `~~`, and `--` are set operators in `regex` classes only.
            '&' | '~' if in_class => {
                out.push('\\');
                out.push(ch);
            }
            '-' if in_class && chars.get(index) == Some(&'-') => {
                index += 1;
                out.push_str(r"-\-");
            }
            '{' if !in_class && !is_repetition(&chars[index..]) => out.push_str(r"\{"),
            _ => out.push(ch),
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quantifier {
    None,
    Greedy,
    Lazy,
}

fn stacked_quantifier() -> PatternError {
    PatternError::Invalid("bad repetition operator".to_owned())
}

/// Whether text after `{` is a RE2 repetition: `n}`, `n,}`, or `n,m}`.
fn is_repetition(rest: &[char]) -> bool {
    let digits = |from: usize| {
        rest[from..]
            .iter()
            .take_while(|ch| ch.is_ascii_digit())
            .count()
    };
    let min = digits(0);
    if min == 0 {
        return false;
    }
    match rest.get(min) {
        Some('}') => true,
        Some(',') => {
            let max = digits(min + 1);
            rest.get(min + 1 + max) == Some(&'}')
        }
        _ => false,
    }
}

fn translate_escape(next: char, in_class: bool) -> String {
    let class = |body: &str, negated: bool| match (in_class, negated) {
        (true, false) => body.to_owned(),
        (_, true) => format!("[^{body}]"),
        (false, false) => format!("[{body}]"),
    };
    match next {
        'd' => class(DIGIT, false),
        'D' => class(DIGIT, true),
        'w' => class(WORD, false),
        'W' => class(WORD, true),
        's' => class(SPACE, false),
        'S' => class(SPACE, true),
        'b' if !in_class => r"(?-u:\b)".to_owned(),
        'B' if !in_class => r"(?-u:\B)".to_owned(),
        // `\<` and `\>` are word boundaries in `regex`, literals in RE2.
        '<' | '>' => next.to_string(),
        other => format!("\\{other}"),
    }
}

/// Compiles an RE2-style pattern; `ignore_case` matches the `i` flag.
pub fn compile(source: &str, ignore_case: bool) -> Result<Regex, PatternError> {
    RegexBuilder::new(&translate(source)?)
        .case_insensitive(ignore_case)
        .build()
        .map_err(|error| PatternError::Invalid(error.to_string()))
}

/// Compiles a streamer-authored pattern and rejects ones that match `""`,
/// like `parseAdvancedRule` and `parseVariationOverrides`.
pub fn compile_user_pattern(source: &str, ignore_case: bool) -> Result<Regex, PatternError> {
    let regex = compile(source, ignore_case)?;
    if regex.is_match("") {
        return Err(PatternError::MatchesEmpty);
    }
    Ok(regex)
}

/// Wraps a source with the whole-word guard used by `compilePattern`.
/// Capture group 2 is the matched word.
pub fn whole_word_source(source: &str) -> String {
    format!(r"(^|[^\p{{L}}\p{{N}}])({source})($|[^\p{{L}}\p{{N}}])")
}

/// Converts a UTF-8 byte offset in `text` to a JavaScript UTF-16 offset.
///
/// # Panics
///
/// Panics if `byte_offset` is not on a character boundary of `text`.
pub fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(source: &str, ignore_case: bool, text: &str) -> Option<(usize, usize)> {
        compile(source, ignore_case)
            .unwrap()
            .find(text)
            .map(|found| {
                (
                    utf16_offset(text, found.start()),
                    utf16_offset(text, found.end()),
                )
            })
    }

    enum Expected {
        Match(usize, usize),
        NoMatch,
        Error,
    }

    /// Cases and results generated from node `re2` by
    /// `tests/fixtures/re2_parity.mjs`.
    const CORPUS: &[(&str, bool, &str, bool, Expected)] = include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/re2_parity_cases.rs"
    ));

    #[test]
    fn matches_node_re2_corpus() {
        let mut mismatches = Vec::new();
        for (source, ignore_case, text, whole_word, expected) in CORPUS {
            let pattern = if *whole_word {
                whole_word_source(source)
            } else {
                (*source).to_owned()
            };
            let actual = match compile(&pattern, *ignore_case) {
                Err(_) => "error".to_owned(),
                Ok(regex) => match regex.captures(text) {
                    None => "no match".to_owned(),
                    Some(captures) => {
                        let found = captures.get(if *whole_word { 2 } else { 0 }).unwrap();
                        format!(
                            "{}..{}",
                            utf16_offset(text, found.start()),
                            utf16_offset(text, found.end())
                        )
                    }
                },
            };
            let wanted = match expected {
                Expected::Match(start, end) => format!("{start}..{end}"),
                Expected::NoMatch => "no match".to_owned(),
                Expected::Error => "error".to_owned(),
            };
            if actual != wanted {
                mismatches.push(format!(
                    "{source:?} on {text:?}: re2 {wanted}, rust {actual} (translated {:?})",
                    translate(&pattern).ok()
                ));
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} mismatches:\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn perl_classes_are_ascii_like_re2() {
        assert_eq!(find(r"\d+", false, "٣٤ 12"), Some((3, 5)));
        assert_eq!(find(r"\w+", false, "éa_1"), Some((1, 4)));
        assert_eq!(find(r"\s", false, "a\u{00A0}b c"), Some((3, 4)));
        assert_eq!(find(r"[\d]+", false, "x٣9"), Some((2, 3)));
        assert_eq!(find(r"[^\W]+", false, "é_z"), Some((1, 3)));
        assert_eq!(find(r"\bcat\b", false, "écat"), Some((1, 4)));
    }

    #[test]
    fn javascript_class_brackets_are_literals() {
        assert_eq!(find(r"[[]", false, "a[b"), Some((1, 2)));
        assert_eq!(find(r"[]a]", false, "x]"), Some((1, 2)));
        assert_eq!(find(r"[a&&b]+", false, "&&"), Some((0, 2)));
        assert_eq!(find(r"[[:digit:]]+", false, "ab12"), Some((2, 4)));
    }

    #[test]
    fn ignore_case_and_unicode_properties_work() {
        assert_eq!(find("hola", true, "¡HOLA!"), Some((1, 5)));
        assert_eq!(find(r"\p{L}+", false, "12ñandú"), Some((2, 7)));
    }

    #[test]
    fn rejects_unsupported_and_empty_matching_patterns() {
        assert!(matches!(
            compile_user_pattern(r"(a)\1", true),
            Err(PatternError::Invalid(_))
        ));
        assert!(matches!(
            compile_user_pattern(r"a(?=b)", true),
            Err(PatternError::Invalid(_))
        ));
        assert_eq!(
            compile_user_pattern("a*", true).unwrap_err(),
            PatternError::MatchesEmpty
        );
        assert!(compile_user_pattern("spam+", true).is_ok());
    }

    #[test]
    fn whole_word_guard_reports_the_inner_word_in_utf16() {
        let text = "😀 no spam here";
        let regex = compile(&whole_word_source("spam"), true).unwrap();
        let word = regex.captures(text).unwrap().get(2).unwrap();
        assert_eq!(utf16_offset(text, word.start()), 6);
        assert!(
            compile(&whole_word_source("spam"), true)
                .unwrap()
                .captures("spammer")
                .is_none()
        );
    }
}
