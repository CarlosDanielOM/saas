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
//! The combined variation rule (`rulePatterns` joins up to 200 component sources of up to
//! 16,000 characters each into one whole-word alternation, which RE2 compiles within its own
//! memory budget) is a [`CompiledAlternation`]: components are compiled in chunks of at most
//! [`MAX_SOURCE_BYTES`] of source each, all chunks together within
//! [`MAX_ALTERNATION_COMPILED_BYTES`], and the chunks' matches are combined so the first
//! match is the one the single alternation finds. Worst case allowed for one rule:
//! [`MAX_ALTERNATION_COMPONENTS`] components of [`MAX_COMPONENT_BYTES`] (9.6 MB of source),
//! parsed a chunk at a time, at most 32 MiB compiled, and per matching thread a lazy DFA cache
//! of at most [`DFA_SIZE_LIMIT`] per chunk (a chat message only fills a small part of it).
//!
//! Text: match offsets are byte offsets inside the server; the moderation match positions that
//! the reference stores and sends (`ModerationMatch.start` and `end`, UTF-16 units, end
//! exclusive) come from [`PatternMatch::utf16_range`] only.

mod js;
mod re2;
mod re2_names;

use std::collections::HashSet;
use std::fmt;
use std::ops::Range;

use regex::{Regex, RegexBuilder};
use regex_automata::util::syntax;
use regex_automata::{Input, meta};

use js::{Rewriter, Tok};

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

/// The most components of one combined rule: `variationTerms` allows 200 blocked words, and
/// each has one entry.
pub const MAX_ALTERNATION_COMPONENTS: usize = 200;
/// The longest component, in bytes: the reference's 16,000 UTF-16 units
/// (`MAX_VARIATION_SOURCE`, for edited and generated sources alike), at most 3 bytes each.
pub const MAX_COMPONENT_BYTES: usize = 48_000;
/// The heap all chunks of one combined rule may use once compiled.
pub const MAX_ALTERNATION_COMPILED_BYTES: usize = 32 * 1024 * 1024;

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

/// How a [`CompiledAlternation`] is cut and bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlternationLimits {
    /// The most component source bytes compiled together (one component alone may reach
    /// [`MAX_COMPONENT_BYTES`]).
    pub chunk_source_bytes: usize,
    /// The heap all chunks may use once compiled.
    pub compiled_bytes: usize,
}

impl Default for AlternationLimits {
    fn default() -> Self {
        Self {
            chunk_source_bytes: MAX_SOURCE_BYTES,
            compiled_bytes: MAX_ALTERNATION_COMPILED_BYTES,
        }
    }
}

/// The combined variation rule (`rulePatterns`): the components joined as
/// `(?:(?:c1)|(?:c2)|...)`, whole word, case-insensitive. Compiled in chunks of consecutive
/// components; [`find`](Self::find) returns the match the single alternation would find.
/// `Send + Sync`; build it once per rule configuration and keep it.
#[derive(Debug, Clone)]
pub struct CompiledAlternation {
    chunks: Vec<meta::Regex>,
    memory: usize,
}

/// One component after the package's rewrite.
struct Component {
    bytes: usize,
    toks: Vec<Tok>,
    /// Whether its text holds `:]`, which a class-name lookup earlier in the rule would reach.
    colon_bracket: bool,
}

fn push_text(toks: &mut Vec<Tok>, text: &str) {
    toks.extend(text.chars().map(Tok::Char));
}

/// The combined pattern's text for components `start..end`: the wrapper and the alternation
/// as `rulePatterns` and `compilePattern` write them, with each component's edges marked.
fn chunk_toks(parts: &[Component], start: usize, end: usize) -> Vec<Tok> {
    let bytes: usize = parts
        .iter()
        .take(end)
        .skip(start)
        .map(|part| part.toks.len())
        .sum();
    let mut toks = Vec::with_capacity(bytes + 64);
    let _ = Rewriter::default().piece(WHOLE_WORD_START, &mut toks);
    push_text(&mut toks, "(?:");
    for (offset, part) in parts.iter().take(end).skip(start).enumerate() {
        if offset > 0 {
            push_text(&mut toks, "|");
        }
        push_text(&mut toks, "(?:");
        toks.push(Tok::Boundary);
        toks.extend_from_slice(&part.toks);
        toks.push(Tok::Boundary);
        push_text(&mut toks, ")");
    }
    push_text(&mut toks, ")");
    let _ = Rewriter::default().piece(WHOLE_WORD_END, &mut toks);
    toks
}

fn build_chunk(pattern: &str, size_limit: usize) -> Result<meta::Regex, PatternError> {
    meta::Regex::builder()
        .syntax(
            syntax::Config::new()
                .case_insensitive(true)
                .nest_limit(NEST_LIMIT),
        )
        .configure(
            meta::Config::new()
                .nfa_size_limit(Some(size_limit))
                .onepass_size_limit(Some(size_limit))
                .hybrid_cache_capacity(DFA_SIZE_LIMIT),
        )
        .build(pattern)
        .map_err(|error| {
            let nested = error
                .syntax_error()
                .is_some_and(|error| error.to_string().contains("nest"));
            if error.size_limit().is_some() || nested {
                PatternError::TooLarge
            } else {
                PatternError::Invalid
            }
        })
}

impl CompiledAlternation {
    /// The rule of `components` (each an edited or generated variation source, in the rule's
    /// order), with the default limits.
    pub fn new<'a>(components: impl IntoIterator<Item = &'a str>) -> Result<Self, PatternError> {
        Self::with_limits(components, AlternationLimits::default())
    }

    /// The rule of `components` with chosen limits.
    ///
    /// Refused as the reference refuses the combined pattern: a component that is invalid, a
    /// group name used in two components, an unterminated `\Q` (it swallows what follows).
    /// Refused here only: more than [`MAX_ALTERNATION_COMPONENTS`] components or one longer
    /// than [`MAX_COMPONENT_BYTES`] ([`PatternError::TooLong`]); more compiled heap than the
    /// limit ([`PatternError::TooLarge`]); a component whose text runs into the next one,
    /// which only a component that is invalid alone can do ([`PatternError::Invalid`]).
    pub fn with_limits<'a>(
        components: impl IntoIterator<Item = &'a str>,
        limits: AlternationLimits,
    ) -> Result<Self, PatternError> {
        let mut rewriter = Rewriter::default();
        let mut parts = Vec::new();
        for source in components {
            if parts.len() >= MAX_ALTERNATION_COMPONENTS || source.len() > MAX_COMPONENT_BYTES {
                return Err(PatternError::TooLong);
            }
            // The package's rewrite runs over the whole combined text: its class state carries
            // from one component to the next.
            let mut toks = Vec::new();
            rewriter
                .piece(source, &mut toks)
                .map_err(|_| PatternError::Invalid)?;
            let colon_bracket = toks
                .windows(2)
                .any(|pair| pair == [Tok::Char(':'), Tok::Char(']')]);
            parts.push(Component {
                bytes: source.len(),
                toks,
                colon_bracket,
            });
        }
        let mut chunks = Vec::new();
        let mut names = HashSet::new();
        let mut memory = 0_usize;
        let mut start = 0;
        // The most components a chunk has needed to be cut to, so later chunks start there.
        let mut fit = usize::MAX;
        while start < parts.len() {
            // Consecutive components up to the source limit (at least one).
            let mut end = start + 1;
            let mut bytes = parts.get(start).map_or(0, |part| part.bytes);
            while let Some(part) = parts.get(end) {
                if bytes + part.bytes > limits.chunk_source_bytes || end - start >= fit {
                    break;
                }
                bytes += part.bytes;
                end += 1;
            }
            // A chunk whose program is over the per-chunk limit is halved until it fits; a
            // single component over it is too large.
            let (chunk, translation) = loop {
                let colon_after = parts.iter().skip(end).any(|part| part.colon_bracket);
                let translation = re2::translate(&chunk_toks(&parts, start, end), colon_after)?;
                let remaining = limits.compiled_bytes.saturating_sub(memory);
                match build_chunk(&translation.regex, remaining.min(COMPILED_SIZE_LIMIT)) {
                    Err(PatternError::TooLarge)
                        if end - start > 1 && remaining > COMPILED_SIZE_LIMIT =>
                    {
                        end = start + (end - start) / 2;
                        fit = end - start;
                    }
                    built => break (built?, translation),
                }
            };
            for name in translation.names {
                if !names.insert(name) {
                    return Err(PatternError::Unsupported("duplicate capture group name"));
                }
            }
            memory = memory.saturating_add(chunk.memory_usage());
            if memory > limits.compiled_bytes {
                return Err(PatternError::TooLarge);
            }
            chunks.push(chunk);
            start = end;
        }
        Ok(Self { chunks, memory })
    }

    /// The first match, as `findBlacklistMatches` takes it from the combined pattern: the
    /// leftmost match; at the same start, the one whose guard group is empty (the wrapper's
    /// `^` comes before its guard character), then the earliest component; none when its text
    /// is empty.
    pub fn find<'t>(&self, text: &'t str) -> Option<PatternMatch<'t>> {
        let input = Input::new(text);
        // (start, guard character taken, group 2)
        let mut best: Option<(usize, bool, Range<usize>)> = None;
        let mut slots = [None; 6];
        for chunk in &self.chunks {
            if chunk.search_slots(&input, &mut slots).is_none() {
                continue;
            }
            let slot = |index: usize| slots.get(index).copied().flatten().map(|value| value.get());
            let (Some(start), Some(guard_start), Some(guard_end), Some(word_start), Some(word_end)) =
                (slot(0), slot(2), slot(3), slot(4), slot(5))
            else {
                continue;
            };
            let guard = guard_end > guard_start;
            let better = best.as_ref().is_none_or(|(best_start, best_guard, _)| {
                start < *best_start || (start == *best_start && *best_guard && !guard)
            });
            if better {
                best = Some((start, guard, word_start..word_end));
                if start == 0 && !guard {
                    // Nothing can come before it.
                    break;
                }
            }
        }
        let (_, _, range) = best?;
        let found = text.get(range.clone())?;
        (!found.is_empty()).then_some(PatternMatch { range, text: found })
    }

    /// How many chunks the rule was compiled in.
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// The heap the compiled chunks use, in bytes (matching caches not included).
    pub fn memory_usage(&self) -> usize {
        self.memory
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
