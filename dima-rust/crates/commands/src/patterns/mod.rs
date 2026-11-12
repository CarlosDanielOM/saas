//! Streamer-written moderation patterns (reference: `utils/moderation/advanced.ts` and
//! `variations.ts`, which compile them with the `re2` package, version 1.27.0) on the `regex`
//! crate.
//!
//! Both engines match in linear time and have no lookaround or backreferences. A pattern goes
//! through the same two steps as in the reference, ported exactly:
//!
//! 1. `js`: the `re2` package's own rewrite of JavaScript syntax (`\cX`, `\u...`, `\p{...}`
//!    names and expansions, `(?<name>`), which works on the raw text (inside `\Q...\E` too);
//! 2. `re2`: RE2's parser, writing `regex` syntax with the same meaning: Perl classes and
//!    `\b` are ASCII, literals are escaped (so `regex`'s class operators never apply), named
//!    groups become numbered ones (RE2's name rules, a name used twice refused), Unicode groups
//!    are RE2's exact names, `{` that is not a valid count (`{,2}`, `{01}`) is a literal.
//!
//! The whole-word wrapper is applied to the source before both steps, as `compilePattern` does,
//! so a construct that swallows the wrapper (an unterminated `\Q`) fails as it does there.
//!
//! The recorded corpus (`tests/fixtures/re2_parity_cases.json`, from the `re2` package in the
//! reference image) is the specification. Intended differences, all refusals of patterns RE2
//! accepts or matches it cannot honour in UTF-8 text:
//!
//! - `\C` (one byte): a match could end inside a character.
//! - A `\p{...}` set that the package expands where RE2 then reads it in another context (as
//!   bare ranges outside a class, with brackets inside one, inside `\Q...\E`, or as a range
//!   endpoint): RE2 gives it a meaning the author cannot have intended.
//! - `\B` is tested by RE2 between the bytes of a multi-byte character, which a `&str` search
//!   never stops inside; the difference is only ever an empty match, which the reference
//!   discards.
//! - Unicode tables are the `regex` crate's (Unicode 16), where the package's expansions use
//!   Unicode 17 and RE2's groups its own version; properties that exist only in Unicode 17
//!   are refused.
//!
//! These patterns are user input and run on every chat message, so compilation is bounded:
//! at most [`MAX_SOURCE_BYTES`] of source, a compiled program of at most
//! [`COMPILED_SIZE_LIMIT`] bytes (RE2's default memory budget is 8 MiB as well, though the two
//! engines measure differently), a lazy DFA cache of at most [`DFA_SIZE_LIMIT`] bytes per
//! matching thread, and a nesting depth of [`NEST_LIMIT`]. Compile a [`CompiledPattern`] once
//! per stored pattern and keep it (the reference keeps up to 1,000 compiled patterns per
//! process, keyed by the pattern's JSON); matching then allocates only the capture slots of a
//! whole-word match.
//!
//! Text: match offsets are byte offsets inside the server; the moderation match positions that
//! the reference stores and sends (`ModerationMatch.start` and `end`, UTF-16 units, end
//! exclusive) come from [`PatternMatch::utf16_range`] only.

mod js;
mod re2;
mod re2_names;

use std::fmt;
use std::ops::Range;

use regex::{Regex, RegexBuilder};

/// The longest source compiled, in bytes. The reference's own limits are 250 characters for a
/// rule pattern and 16,000 for an edited variation.
pub const MAX_SOURCE_BYTES: usize = 256 * 1024;
/// The largest compiled program, in bytes.
pub const COMPILED_SIZE_LIMIT: usize = 8 * 1024 * 1024;
/// The largest lazy DFA cache per matching thread, in bytes.
pub const DFA_SIZE_LIMIT: usize = 2 * 1024 * 1024;
/// The deepest nesting of groups, classes and repetitions.
pub const NEST_LIMIT: u32 = 250;
/// RE2's largest repetition count, and the largest product of nested counts.
pub const MAX_REPEAT: u64 = 1_000;

/// The reference's whole-word wrapper, as `compilePattern` writes it.
const WHOLE_WORD_START: &str = r"(^|[^\p{L}\p{N}])(";
const WHOLE_WORD_END: &str = r")($|[^\p{L}\p{N}])";

/// Why a pattern was refused. The text never includes the pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternError {
    /// Longer than [`MAX_SOURCE_BYTES`].
    TooLong,
    /// A construct RE2 refuses or this translation cannot carry over (named in the text).
    Unsupported(&'static str),
    /// Not a valid pattern.
    Invalid,
    /// The compiled program would exceed [`COMPILED_SIZE_LIMIT`] or [`NEST_LIMIT`].
    TooLarge,
    /// The pattern matches an empty message (refused when a rule is saved).
    MatchesEmpty,
}

impl fmt::Display for PatternError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong => write!(formatter, "regex is longer than {MAX_SOURCE_BYTES} bytes"),
            Self::Unsupported(what) => write!(formatter, "unsupported regex construct: {what}"),
            Self::Invalid => formatter.write_str("invalid regex"),
            Self::TooLarge => formatter.write_str("regex is too large to compile"),
            Self::MatchesEmpty => formatter.write_str("regex must not match an empty message"),
        }
    }
}

impl std::error::Error for PatternError {}

/// Rewrites a pattern as `new RE2(source)` receives it into `regex` syntax with the same
/// meaning, or refuses it (see the module notes).
pub fn translate(source: &str) -> Result<String, PatternError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(PatternError::TooLong);
    }
    re2::translate(&js::Rewriter::whole(source), false).map(|translation| translation.regex)
}

fn build(translated: &str, ignore_case: bool) -> Result<Regex, PatternError> {
    RegexBuilder::new(translated)
        .case_insensitive(ignore_case)
        .size_limit(COMPILED_SIZE_LIMIT)
        .dfa_size_limit(DFA_SIZE_LIMIT)
        .nest_limit(NEST_LIMIT)
        .build()
        .map_err(|error| match error {
            regex::Error::CompiledTooBig(_) => PatternError::TooLarge,
            // The nest limit is reported as a syntax error.
            regex::Error::Syntax(text) if text.contains("nest") => PatternError::TooLarge,
            _ => PatternError::Invalid,
        })
}

/// Compiles an RE2 pattern; `ignore_case` is the `i` flag (`new RE2(source, 'iu')`).
pub fn compile(source: &str, ignore_case: bool) -> Result<Regex, PatternError> {
    build(&translate(source)?, ignore_case)
}

/// What the reference checks when a rule or an edited variation is saved: the pattern compiles
/// and does not match the empty string (`new RE2(source, flags).test('')`).
pub fn validate_user_pattern(source: &str, ignore_case: bool) -> Result<(), PatternError> {
    if compile(source, ignore_case)?.is_match("") {
        return Err(PatternError::MatchesEmpty);
    }
    Ok(())
}

/// Where a pattern must match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Boundary {
    /// Not inside a word: the reference wraps the source as
    /// `(^|[^\p{L}\p{N}])(source)($|[^\p{L}\p{N}])` and reports group 2.
    WholeWord,
    /// Anywhere.
    Anywhere,
}

/// A moderation pattern compiled once (`compilePattern`). `Send + Sync`; keep it with the rule.
#[derive(Debug, Clone)]
pub struct CompiledPattern {
    regex: Regex,
    boundary: Boundary,
}

/// A pattern's match in a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternMatch<'t> {
    /// Byte range in the message.
    pub range: Range<usize>,
    /// The matched text (group 2 for a whole-word pattern).
    pub text: &'t str,
}

impl PatternMatch<'_> {
    /// The range as the reference stores and sends it (`ModerationMatch.start`/`end`): UTF-16
    /// units of `haystack`, end exclusive. The one place match offsets are converted.
    pub fn utf16_range(&self, haystack: &str) -> Range<usize> {
        dima_text::utf16_offset(haystack, self.range.start)
            ..dima_text::utf16_offset(haystack, self.range.end)
    }
}

impl CompiledPattern {
    /// `compilePattern`: the source, wrapped for a whole-word boundary, with the `i` flag when
    /// `ignore_case`. It does not check for empty matches (see [`validate_user_pattern`]).
    pub fn new(source: &str, boundary: Boundary, ignore_case: bool) -> Result<Self, PatternError> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PatternError::TooLong);
        }
        let translated = match boundary {
            // The wrapper is text around the source before RE2 parses it, as in the reference.
            Boundary::WholeWord => {
                let wrapped = format!("{WHOLE_WORD_START}{source}{WHOLE_WORD_END}");
                re2::translate(&js::Rewriter::whole(&wrapped), false)?.regex
            }
            Boundary::Anywhere => translate(source)?,
        };
        Ok(Self {
            regex: build(&translated, ignore_case)?,
            boundary,
        })
    }

    /// The first match, as `findBlacklistMatches` takes it: the leftmost match only, and none
    /// when its text is empty (even if a later match would not be).
    pub fn find<'t>(&self, text: &'t str) -> Option<PatternMatch<'t>> {
        let found = match self.boundary {
            Boundary::Anywhere => self.regex.find(text)?,
            Boundary::WholeWord => self.regex.captures(text)?.get(2)?,
        };
        (!found.is_empty()).then(|| PatternMatch {
            range: found.range(),
            text: found.as_str(),
        })
    }

    /// The compiled regex.
    pub fn regex(&self) -> &Regex {
        &self.regex
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_escaping_covers_every_regex_meta_character() {
        for ch in "\\.+*?()|[]{}^$#&-~".chars() {
            let mut out = String::new();
            re2::push_literal(&mut out, ch);
            let regex = Regex::new(&format!("^{out}$")).unwrap();
            assert!(regex.is_match(&ch.to_string()), "{ch}");
        }
    }

    #[test]
    fn the_wrapper_is_parsed_with_the_source() {
        // An unterminated `\Q` swallows the wrapper's closing text, as in the reference.
        assert!(CompiledPattern::new(r"\Qspam", Boundary::WholeWord, true).is_err());
        assert!(CompiledPattern::new(r"\Qspam", Boundary::Anywhere, true).is_ok());
    }
}
