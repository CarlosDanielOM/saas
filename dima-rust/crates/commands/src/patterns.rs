//! Streamer-written moderation patterns (reference: `utils/moderation/advanced.ts` and
//! `variations.ts`, which compile them with the `re2` package) on the `regex` crate.
//!
//! Both engines match in linear time and have no lookaround or backreferences. [`translate`]
//! rewrites RE2 syntax (as the `re2` package receives it from JavaScript) into `regex` syntax
//! with the same meaning, and refuses what it cannot carry over faithfully:
//!
//! - `\d`, `\w`, `\s` and `\b` are ASCII in RE2 and Unicode in `regex`: rewritten to ASCII
//!   classes (`\s` is RE2's `[\t\n\f\r ]`) and `(?-u:\b)`.
//! - A `[` inside a class is a literal in RE2 and opens a nested class in `regex`; `&&`, `~~`
//!   and `--` are set operators in `regex` classes only; `\<` and `\>` are word boundaries in
//!   `regex` only; `{` that does not start `{n}`, `{n,}` or `{n,m}` is a literal: all escaped.
//! - JavaScript `\cX` and RE2 octal escapes (`\0`, `\012`, `\123`) become `\x{..}`.
//! - `\Q...\E` (RE2 literal text) is escaped character by character.
//! - Flag groups follow RE2's grammar: flags `i`, `m`, `s`, `U`, at most one `-`, not ending in
//!   `-`; repeated flags are allowed (the last setting wins), so the group is rewritten in a
//!   canonical form `regex` accepts. `(?)` is the no-op RE2 makes of it.
//!
//! - Named groups become numbered ones: RE2 takes the name up to the first `>`, accepts
//!   letters, marks, decimal digits, letter numbers and connector punctuation in any position,
//!   and refuses a name used twice; `regex` has other name rules, and nothing reads a group by
//!   name (`advanced.ts` reads groups 1 and 2 of its whole-word wrapper).
//!
//! Refused (RE2 refuses them too, or `regex` would read them differently): stacked quantifiers
//! (`a**`, `a{2}*`); a repetition count above 1,000 or a nested repetition whose counts
//! multiply past 1,000 (RE2's own limits); lookaround, backreferences, `(?P=name)`, comments
//! `(?#...)`; the flags `x`, `u`, `R` and any other; `\U` (not RE2); `\C` (one byte: no UTF-8
//! meaning); `\Q` inside a class; a property name that is not written as RE2 spells it (a
//! capital letter, then ASCII letters or `_`: `\p{Greek}`, `\pL`), because `regex` matches
//! names loosely (`\p{greek}`, `\p{Letter}`, `\p{sc=Greek}`) where RE2 refuses them. What
//! `regex` itself refuses is refused as invalid.
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
//! exclusive) come from [`PatternMatch::utf16_range`] only. Unicode classes (`\p{L}` and the
//! whole-word guard) use the `regex` crate's tables, which can differ from the `re2` package's
//! for code points assigned in recent Unicode versions.

use std::collections::HashSet;
use std::fmt;
use std::ops::Range;
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

/// The longest source compiled, in bytes. The reference's own limits are 250 characters for a
/// rule pattern and 16,000 for an edited variation; one rule's combined variation alternation
/// stays far below this.
pub const MAX_SOURCE_BYTES: usize = 256 * 1024;
/// The largest compiled program, in bytes.
pub const COMPILED_SIZE_LIMIT: usize = 8 * 1024 * 1024;
/// The largest lazy DFA cache per matching thread, in bytes.
pub const DFA_SIZE_LIMIT: usize = 2 * 1024 * 1024;
/// The deepest nesting of groups, classes and repetitions.
pub const NEST_LIMIT: u32 = 250;
/// RE2's largest repetition count, and the largest product of nested counts.
pub const MAX_REPEAT: u64 = 1_000;

/// ASCII class bodies RE2 uses for the Perl classes.
const DIGIT: &str = "0-9";
const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = r"\t\n\x0C\r ";

/// The characters RE2 accepts in a group name (`IsValidCaptureName`): categories Lu, Ll, Lt,
/// Lm, Lo, Nl, Mn, Mc, Nd and Pc.
static CAPTURE_NAME: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"\A[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+\z").ok()
});

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quantifier {
    None,
    Greedy,
    Lazy,
}

/// One group level, for RE2's nested repetition limit.
#[derive(Debug, Clone, Copy)]
struct Frame {
    /// The largest product of repetition counts on any path inside the group.
    product: u64,
}

struct Translator {
    chars: Vec<char>,
    index: usize,
    out: String,
    quantifier: Quantifier,
    frames: Vec<Frame>,
    /// The product of the most recent atom, which a following quantifier applies to.
    last_atom: Option<u64>,
    /// Group names seen so far.
    names: HashSet<String>,
}

/// Rewrites RE2 syntax into equivalent `regex` syntax, or refuses it (see the module notes).
pub fn translate(source: &str) -> Result<String, PatternError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(PatternError::TooLong);
    }
    let mut translator = Translator {
        chars: source.chars().collect(),
        index: 0,
        out: String::with_capacity(source.len() + 16),
        quantifier: Quantifier::None,
        frames: vec![Frame { product: 1 }],
        last_atom: None,
        names: HashSet::new(),
    };
    translator.run()?;
    Ok(translator.out)
}

const fn stacked() -> PatternError {
    PatternError::Unsupported("stacked repetition operators")
}

impl Translator {
    fn peek(&self, offset: usize) -> Option<char> {
        self.chars.get(self.index + offset).copied()
    }

    fn next(&mut self) -> Option<char> {
        let ch = self.peek(0)?;
        self.index += 1;
        Some(ch)
    }

    fn atom(&mut self) {
        self.last_atom = Some(1);
        self.quantifier = Quantifier::None;
    }

    /// Records a path product in the innermost group (the root frame is never popped).
    fn raise(&mut self, product: u64) {
        if let Some(top) = self.frames.last_mut() {
            top.product = top.product.max(product);
        }
    }

    fn run(&mut self) -> Result<(), PatternError> {
        while let Some(ch) = self.next() {
            match ch {
                '*' | '+' | '?' => self.simple_quantifier(ch)?,
                '{' if self.repetition_len().is_some() => self.counted_repetition()?,
                '{' => {
                    self.out.push_str(r"\{");
                    self.atom();
                }
                '\\' => self.escape_outside()?,
                '[' => self.class()?,
                '(' => self.open_group()?,
                ')' => self.close_group(),
                '|' => {
                    self.out.push('|');
                    self.last_atom = None;
                    self.quantifier = Quantifier::None;
                }
                _ => {
                    self.out.push(ch);
                    self.atom();
                }
            }
        }
        Ok(())
    }

    fn simple_quantifier(&mut self, ch: char) -> Result<(), PatternError> {
        self.quantifier = match (ch, self.quantifier) {
            ('?', Quantifier::Greedy) => Quantifier::Lazy,
            (_, Quantifier::None) => Quantifier::Greedy,
            _ => return Err(stacked()),
        };
        self.out.push(ch);
        Ok(())
    }

    /// The length of `n}`, `n,}` or `n,m}` after a `{`, when that is what follows.
    fn repetition_len(&self) -> Option<usize> {
        let digits = |from: usize| {
            (from..)
                .take_while(|offset| self.peek(*offset).is_some_and(|ch| ch.is_ascii_digit()))
                .count()
        };
        let min = digits(0);
        if min == 0 {
            return None;
        }
        match self.peek(min) {
            Some('}') => Some(min + 1),
            Some(',') => {
                let max = digits(min + 1);
                (self.peek(min + 1 + max) == Some('}')).then_some(min + 2 + max)
            }
            _ => None,
        }
    }

    fn counted_repetition(&mut self) -> Result<(), PatternError> {
        if self.quantifier != Quantifier::None {
            return Err(stacked());
        }
        let len = self.repetition_len().unwrap_or(0);
        let body: String = self.chars.iter().skip(self.index).take(len).collect();
        self.index += len;
        let inner = body.trim_end_matches('}');
        let (min, max) = match inner.split_once(',') {
            Some((min, "")) => (min, None),
            Some((min, max)) => (min, Some(max)),
            None => (inner, Some(inner)),
        };
        // Digits only; a count too long for u64 is above the limit anyway.
        let count = |text: &str| text.parse::<u64>().unwrap_or(u64::MAX);
        let min = count(min);
        let max = max.map(count);
        if min > MAX_REPEAT || max.is_some_and(|max| max > MAX_REPEAT) {
            return Err(PatternError::Unsupported("repetition count above 1000"));
        }
        // RE2 divides its budget by each nested count (the maximum, or the minimum when
        // unbounded) and refuses when it reaches zero: the product must stay within 1,000.
        let factor = max.unwrap_or(min).max(1);
        let product = self.last_atom.unwrap_or(1).saturating_mul(factor);
        if (min >= 2 || max.is_some_and(|max| max >= 2)) && product > MAX_REPEAT {
            return Err(PatternError::Unsupported(
                "nested repetition counts above 1000",
            ));
        }
        self.raise(product);
        self.last_atom = Some(product);
        self.quantifier = Quantifier::Greedy;
        self.out.push('{');
        self.out.push_str(&body);
        Ok(())
    }

    fn open_group(&mut self) -> Result<(), PatternError> {
        self.quantifier = Quantifier::None;
        if self.peek(0) != Some('?') {
            self.out.push('(');
            self.push_frame();
            return Ok(());
        }
        self.index += 1;
        match (self.peek(0), self.peek(1)) {
            (Some(':'), _) => {
                self.index += 1;
                self.out.push_str("(?:");
                self.push_frame();
            }
            (Some('P'), Some('<')) | (Some('<'), _)
                if !matches!((self.peek(0), self.peek(1)), (Some('<'), Some('=' | '!'))) =>
            {
                self.index += if self.peek(0) == Some('P') { 2 } else { 1 };
                self.named_group()?;
            }
            (Some('=' | '!'), _) | (Some('<'), Some('=' | '!')) => {
                return Err(PatternError::Unsupported("lookaround"));
            }
            (Some('P'), _) => return Err(PatternError::Unsupported("named backreference")),
            (Some('#'), _) => return Err(PatternError::Unsupported("comment group")),
            _ => self.flags()?,
        }
        Ok(())
    }

    /// A named group after `(?P<` or `(?<`: checked as RE2 checks it, then numbered.
    fn named_group(&mut self) -> Result<(), PatternError> {
        let mut name = String::new();
        loop {
            match self.next() {
                Some('>') => break,
                Some(ch) => name.push(ch),
                None => return Err(PatternError::Invalid),
            }
        }
        if !CAPTURE_NAME
            .as_ref()
            .is_some_and(|valid| valid.is_match(&name))
        {
            return Err(PatternError::Invalid);
        }
        if !self.names.insert(name) {
            return Err(PatternError::Unsupported("duplicate capture group name"));
        }
        self.out.push('(');
        self.push_frame();
        Ok(())
    }

    /// `(?flags)` or `(?flags:`, after `(?`.
    fn flags(&mut self) -> Result<(), PatternError> {
        const FLAGS: [char; 4] = ['i', 'm', 's', 'U'];
        // The final state of each flag set in the group: Some(true) on, Some(false) off.
        let mut state: [Option<bool>; 4] = [None; 4];
        let mut negated = false;
        let mut saw_flag = false;
        let opens_group = loop {
            match self.next() {
                Some(')') => break false,
                Some(':') => break true,
                Some('-') if !negated => {
                    negated = true;
                    saw_flag = false;
                }
                Some(flag) => {
                    let Some(position) = FLAGS.iter().position(|known| *known == flag) else {
                        return Err(PatternError::Unsupported("flag other than i, m, s, U"));
                    };
                    state[position] = Some(!negated);
                    saw_flag = true;
                }
                None => return Err(PatternError::Invalid),
            }
        };
        if negated && !saw_flag {
            return Err(PatternError::Unsupported("empty negated flags"));
        }
        let on: String = FLAGS
            .iter()
            .zip(state)
            .filter(|(_, state)| *state == Some(true))
            .map(|(flag, _)| *flag)
            .collect();
        let off: String = FLAGS
            .iter()
            .zip(state)
            .filter(|(_, state)| *state == Some(false))
            .map(|(flag, _)| *flag)
            .collect();
        let flags = if off.is_empty() {
            on
        } else {
            format!("{on}-{off}")
        };
        if opens_group {
            self.out.push_str("(?");
            self.out.push_str(&flags);
            self.out.push(':');
            self.push_frame();
        } else {
            if !flags.is_empty() {
                self.out.push_str("(?");
                self.out.push_str(&flags);
                self.out.push(')');
            }
            // A flag group is not an atom: a quantifier after it has nothing to repeat.
            self.last_atom = None;
        }
        Ok(())
    }

    fn push_frame(&mut self) {
        self.frames.push(Frame { product: 1 });
        self.last_atom = None;
    }

    fn close_group(&mut self) {
        self.out.push(')');
        if self.frames.len() > 1 {
            let inner = self.frames.pop().map_or(1, |frame| frame.product);
            self.raise(inner);
            self.last_atom = Some(inner);
        } else {
            // An unopened `)`: `regex` refuses the result.
            self.last_atom = None;
        }
        self.quantifier = Quantifier::None;
    }

    fn escape_outside(&mut self) -> Result<(), PatternError> {
        let Some(next) = self.next() else {
            // A trailing `\`: `regex` refuses it too.
            self.out.push('\\');
            return Ok(());
        };
        match next {
            'Q' => {
                // Literal text up to `\E` or the end.
                while let Some(ch) = self.next() {
                    if ch == '\\' && self.peek(0) == Some('E') {
                        self.index += 1;
                        break;
                    }
                    push_literal(&mut self.out, ch);
                    self.atom();
                }
                return Ok(());
            }
            'b' => self.out.push_str(r"(?-u:\b)"),
            'B' => self.out.push_str(r"(?-u:\B)"),
            _ => self.common_escape(next, false)?,
        }
        self.atom();
        Ok(())
    }

    /// Escapes valid both inside and outside a class.
    fn common_escape(&mut self, next: char, in_class: bool) -> Result<(), PatternError> {
        let class = |body: &str, negated: bool| match (in_class, negated) {
            (true, false) => body.to_owned(),
            (_, true) => format!("[^{body}]"),
            (false, false) => format!("[{body}]"),
        };
        match next {
            'd' => self.out.push_str(&class(DIGIT, false)),
            'D' => self.out.push_str(&class(DIGIT, true)),
            'w' => self.out.push_str(&class(WORD, false)),
            'W' => self.out.push_str(&class(WORD, true)),
            's' => self.out.push_str(&class(SPACE, false)),
            'S' => self.out.push_str(&class(SPACE, true)),
            // JavaScript `\cA`..`\cZ` (the `re2` package translates them).
            'c' if self.peek(0).is_some_and(|ch| ch.is_ascii_alphabetic()) => {
                let letter = self.next().map_or(0, u32::from);
                self.out.push_str(&format!("\\x{{{:02x}}}", letter & 0x1f));
            }
            '0'..='7' => self.octal(next)?,
            '8' | '9' => return Err(PatternError::Unsupported("backreference")),
            'p' | 'P' => self.property(next)?,
            'u' | 'x' if self.peek(0) == Some('{') => {
                self.out.push('\\');
                self.out.push(next);
                self.copy_braces();
            }
            'U' => return Err(PatternError::Unsupported(r"\U escape")),
            'C' => return Err(PatternError::Unsupported(r"\C (any byte)")),
            'Q' => return Err(PatternError::Unsupported(r"\Q inside a class")),
            // `\<` and `\>` are word boundaries in `regex`, literals in RE2.
            '<' | '>' => self.out.push(next),
            other => {
                self.out.push('\\');
                self.out.push(other);
            }
        }
        Ok(())
    }

    /// RE2 octal: `\0` plus up to two octal digits, or `\1`..`\7` followed by at least one more
    /// (a lone `\1`..`\7` is a backreference).
    fn octal(&mut self, first: char) -> Result<(), PatternError> {
        let is_octal = |ch: Option<char>| ch.is_some_and(|ch| ('0'..='7').contains(&ch));
        if first != '0' && !is_octal(self.peek(0)) {
            return Err(PatternError::Unsupported("backreference"));
        }
        let mut value = first.to_digit(8).unwrap_or(0);
        for _ in 0..2 {
            if !is_octal(self.peek(0)) {
                break;
            }
            value = value * 8 + self.next().and_then(|ch| ch.to_digit(8)).unwrap_or(0);
        }
        self.out.push_str(&format!("\\x{{{value:x}}}"));
        Ok(())
    }

    /// `\pL` or `\p{Name}` / `\p{^Name}`, with RE2's spelling of names. RE2's `\p{^Name}`
    /// is `regex`'s `\P{Name}`.
    fn property(&mut self, letter: char) -> Result<(), PatternError> {
        let spelled = |name: &str| {
            let mut chars = name.chars();
            chars.next().is_some_and(|ch| ch.is_ascii_uppercase())
                && chars.all(|ch| ch.is_ascii_alphabetic() || ch == '_')
        };
        if self.peek(0) != Some('{') {
            return match self.next() {
                Some(name) if name.is_ascii_uppercase() => {
                    self.out.push('\\');
                    self.out.push(letter);
                    self.out.push(name);
                    Ok(())
                }
                _ => Err(PatternError::Unsupported("Unicode property name")),
            };
        }
        self.index += 1;
        let mut name = String::new();
        loop {
            match self.next() {
                Some('}') => break,
                Some(ch) if name.len() < 64 => name.push(ch),
                _ => return Err(PatternError::Unsupported("Unicode property name")),
            }
        }
        let (negated, name) = match name.strip_prefix('^') {
            Some(rest) => (true, rest),
            None => (false, name.as_str()),
        };
        if !spelled(name) {
            return Err(PatternError::Unsupported("Unicode property name"));
        }
        let letter = match (letter, negated) {
            ('p', false) | ('P', true) => 'p',
            _ => 'P',
        };
        self.out.push('\\');
        self.out.push(letter);
        self.out.push('{');
        self.out.push_str(name);
        self.out.push('}');
        Ok(())
    }

    /// Copies `{...}` up to and including the closing brace (or the end).
    fn copy_braces(&mut self) {
        while let Some(ch) = self.next() {
            self.out.push(ch);
            if ch == '}' {
                break;
            }
        }
    }

    /// A class, after its `[`.
    fn class(&mut self) -> Result<(), PatternError> {
        self.quantifier = Quantifier::None;
        self.out.push('[');
        if self.peek(0) == Some('^') {
            self.index += 1;
            self.out.push('^');
        }
        // `]` right after `[` or `[^` is a literal in RE2.
        if self.peek(0) == Some(']') {
            self.index += 1;
            self.out.push_str(r"\]");
        }
        while let Some(ch) = self.next() {
            match ch {
                ']' => {
                    self.out.push(']');
                    self.atom();
                    return Ok(());
                }
                '\\' => {
                    let Some(next) = self.next() else {
                        self.out.push('\\');
                        return Ok(());
                    };
                    if next == 'b' {
                        return Err(PatternError::Unsupported(r"\b inside a class"));
                    }
                    self.common_escape(next, true)?;
                }
                // A POSIX class (`[:alpha:]`, `[:^digit:]`) is copied whole.
                '[' if self.peek(0) == Some(':') => {
                    self.out.push('[');
                    while let Some(inner) = self.next() {
                        self.out.push(inner);
                        if inner == ']' && self.out.ends_with(":]") {
                            break;
                        }
                    }
                }
                '[' => self.out.push_str(r"\["),
                '&' | '~' => {
                    self.out.push('\\');
                    self.out.push(ch);
                }
                '-' if self.peek(0) == Some('-') => {
                    self.index += 1;
                    self.out.push_str(r"-\-");
                }
                _ => self.out.push(ch),
            }
        }
        // Unclosed: `regex` refuses it.
        Ok(())
    }
}

/// One literal character in `regex` syntax.
fn push_literal(out: &mut String, ch: char) {
    if regex_syntax_is_meta(ch) {
        out.push('\\');
    }
    out.push(ch);
}

fn regex_syntax_is_meta(ch: char) -> bool {
    matches!(
        ch,
        '\\' | '.'
            | '+'
            | '*'
            | '?'
            | '('
            | ')'
            | '|'
            | '['
            | ']'
            | '{'
            | '}'
            | '^'
            | '$'
            | '#'
            | '&'
            | '-'
            | '~'
    )
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
    /// `compilePattern`: the translated source, wrapped for a whole-word boundary, with the `i`
    /// flag when `ignore_case`. It does not check for empty matches (see
    /// [`validate_user_pattern`]).
    pub fn new(source: &str, boundary: Boundary, ignore_case: bool) -> Result<Self, PatternError> {
        let translated = translate(source)?;
        let wrapped = match boundary {
            Boundary::WholeWord => {
                format!(r"(^|[^\p{{L}}\p{{N}}])({translated})($|[^\p{{L}}\p{{N}}])")
            }
            Boundary::Anywhere => translated,
        };
        Ok(Self {
            regex: build(&wrapped, ignore_case)?,
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
    fn the_capture_name_class_compiles() {
        assert!(CAPTURE_NAME.is_some());
    }

    #[test]
    fn literal_escaping_covers_every_regex_meta_character() {
        for ch in "\\.+*?()|[]{}^$#&-~".chars() {
            let mut out = String::new();
            push_literal(&mut out, ch);
            let regex = Regex::new(&format!("^{out}$")).unwrap();
            assert!(regex.is_match(&ch.to_string()), "{ch}");
        }
    }
}
